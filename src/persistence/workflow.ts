/**
 * Workflow persistence: durable workflow facts plus their event journal.
 *
 * `WorkflowStore` is an in-memory, synchronous kernel whose `restore()` is
 * static (there is no instance-level or single-entity restore API). This class
 * rebuilds a snapshot from the store and restores it into the constructor's
 * writer via a guarded state-adoption shim; if that shim cannot recognise the
 * kernel's fields it falls back to the fresh instance exposed by
 * {@link WorkflowPersistence.workflow}. Callers should always read the live
 * writer through that getter.
 *
 * Every workflow event is journaled with its audit metadata — `actor`, `reason`
 * and `cancellationEpoch` — so a restore rebuilds the real {@link WorkflowEvent}
 * instead of a placeholder. A database written before those fields existed still
 * restores: the missing values fall back and `restoreAll` reports each event as
 * `event:<sequence>:legacy_actor` / `legacy_epoch` in
 * {@link RestoreReport.skipped}.
 */

import { entityKey } from "../entity/index.ts";
import type { EntityKind, EventRecord } from "../entity/types.ts";
import type { SaveOptions } from "../service/types.ts";
import type { Store } from "../service/store.ts";
import { openSqlite } from "../sql/index.ts";
import type { SqlRow } from "../sql/types.ts";
import { initialWorkflowStates, workflowTransitions } from "../workflow/transitions.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { WorkflowError } from "../workflow/types.ts";
import type {
    ActionAttempt,
    CreateEntity,
    TransitionOptions,
    WorkflowEntities,
    WorkflowEntity,
    WorkflowEvent,
    WorkflowKind,
    WorkflowSnapshot,
} from "../workflow/types.ts";
import { listEntities, loadEntity, persistEntity, plainEntity } from "./mappers.ts";
import {
    PersistenceError,
    WORKFLOW_KINDS,
    WORKFLOW_SNAPSHOT_SCHEMA_VERSION,
    isWorkflowKind,
    workflowEventKind,
} from "./types.ts";
import type { Persisted, PersistenceOptions, RestoreReport, WorkflowEventPhase } from "./types.ts";

/**
 * Default actor when a write does not name one, and the fallback an event
 * written before the actor field existed is restored with. `restoreAll` reports
 * every such event as `event:<sequence>:legacy_actor`, so the fallback is
 * visible in the {@link RestoreReport} instead of being silent.
 */
export const DEFAULT_PERSISTENCE_ACTOR = "persistence";

/** Options accepted by {@link WorkflowPersistence.create}. */
export interface WorkflowCreateOptions {
    readonly actor?: string;
}

/**
 * Audit metadata persisted with a workflow event.
 *
 * The workflow kernel records who acted, why and under which cancellation epoch
 * (`WorkflowEvent.actor` / `reason` / `cancellationEpoch`); the durable journal
 * keeps the same three fields next to the base payload so a restore rebuilds the
 * real audit fact instead of a placeholder. Every field stays optional at the
 * API edge: the writer fills what it knows, omits an unknown epoch, and
 * `restoreAll` reports whatever had to fall back.
 */
export interface WorkflowEventAudit {
    readonly actor?: string;
    readonly reason?: string;
    readonly cancellationEpoch?: number;
}

/** One workflow transition fact to append with its audit metadata. */
export interface WorkflowTransitionFact extends WorkflowEventAudit {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly version: number;
}

/** Options accepted by {@link WorkflowPersistence.persistAttempt}. */
export interface PersistAttemptOptions extends WorkflowEventAudit {
    /** Source action state of a settlement fact. Defaults to `"running"`. */
    readonly from?: ActionAttempt["state"];
}

/** Constructor input for {@link WorkflowPersistence}. */
export interface WorkflowPersistenceInit extends PersistenceOptions {
    readonly store: Store;
    readonly workflow: WorkflowStore;
}

interface WorkflowFact extends WorkflowEventAudit {
    readonly record: EventRecord;
    readonly kind: WorkflowKind;
    readonly phase: WorkflowEventPhase;
    readonly entityId: string;
    /** Target state. */
    readonly state: string;
    readonly from: string;
    readonly version: number;
}

/** One staged fact of an entity's event chain, before its epoch is settled. */
interface ChainEntry {
    readonly order: number;
    readonly event: WorkflowEvent;
    /** Epoch stored on the journal row; `undefined` when the row predates the field. */
    readonly storedEpoch?: number;
    /** True when the row carried no actor and the rebuild has to fall back. */
    readonly legacyActor: boolean;
}

interface PlannedEvent {
    readonly event: WorkflowEvent;
    readonly order: number;
    /** True when the actor had to fall back to {@link DEFAULT_PERSISTENCE_ACTOR}. */
    readonly legacyActor: boolean;
    /** True when the stored row carried no cancellation epoch. */
    readonly legacyEpoch: boolean;
    /** True when the stored epoch disagreed with the chain and was reconciled. */
    readonly epochConflict: boolean;
}

interface RawEventScan {
    readonly events: readonly EventRecord[];
    readonly corrupt: readonly number[];
}

type IdRow = SqlRow & { readonly id: string };
type EventRow = SqlRow & {
    readonly sequence: number | bigint;
    readonly kind: string;
    readonly entity_id: string | null;
    readonly recorded_at: string;
    readonly payload: string;
};

const ENTITY_KEY_SEPARATOR = ":";

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actorOf(value: string | undefined): string {
    return typeof value === "string" && value.trim().length > 0 ? value : DEFAULT_PERSISTENCE_ACTOR;
}

function textOf(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function epochOf(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Builds a workflow event payload: the shared base fields plus the audit fields.
 *
 * `actor` is always written (a caller that cannot name one gets the documented
 * default); `reason` and `cancellationEpoch` are written only when known, so the
 * restore path can tell an absent value from a real one.
 */
function eventPayload(
    base: Readonly<Record<string, unknown>>,
    audit: WorkflowEventAudit,
): Readonly<Record<string, unknown>> {
    return {
        ...base,
        actor: audit.actor ?? DEFAULT_PERSISTENCE_ACTOR,
        ...(audit.reason === undefined ? {} : { reason: audit.reason }),
        ...(audit.cancellationEpoch === undefined ? {} : { cancellationEpoch: audit.cancellationEpoch }),
    };
}

/**
 * Reads the audit fields of one journal row.
 *
 * Rows written by this layer carry them on the base payload; rows written by
 * the kernel adapter carry the exact `WorkflowEvent` under `payload.workflow`.
 * Both are durable sources of the same three fields, so a mixed database
 * (some rows from each writer) restores with its real values. The nested event
 * only counts when it names the row's own identity; anything absent stays
 * `undefined` and is reported by the restore pass.
 */
function auditOf(payload: Readonly<Record<string, unknown>>, kind: WorkflowKind, entityId: string): WorkflowEventAudit {
    const nested = isRecord(payload.workflow) ? payload.workflow : undefined;
    const workflow = nested !== undefined
        && nested.entityKind === kind
        && nested.entityId === entityId
        ? nested
        : undefined;
    const actor = textOf(payload.actor) ?? (workflow === undefined ? undefined : textOf(workflow.actor));
    const reason = typeof payload.reason === "string"
        ? payload.reason
        : workflow !== undefined && typeof workflow.reason === "string"
            ? workflow.reason
            : undefined;
    const cancellationEpoch = epochOf(payload.cancellationEpoch)
        ?? (workflow === undefined ? undefined : epochOf(workflow.cancellationEpoch));
    return {
        ...(actor === undefined ? {} : { actor }),
        ...(reason === undefined ? {} : { reason }),
        ...(cancellationEpoch === undefined ? {} : { cancellationEpoch }),
    };
}

/** Appends one `<kind>.created` fact with its audit metadata. */
function writeCreated(
    store: Store,
    kind: WorkflowKind,
    entityId: string,
    state: string,
    audit: WorkflowEventAudit,
): void {
    store.appendEvent(workflowEventKind(kind, "created"), eventPayload({ id: entityId, state }, audit), entityId);
}

/** Appends one `<kind>.transitioned` fact with its audit metadata. */
function writeTransition(store: Store, kind: WorkflowKind, fact: WorkflowTransitionFact): void {
    store.appendEvent(
        workflowEventKind(kind, "transitioned"),
        eventPayload({ id: fact.id, from: fact.from, to: fact.to, version: fact.version }, fact),
        fact.id,
    );
}

function entityKeyOf(kind: WorkflowKind, value: unknown): string {
    if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
        return entityKey(kind, value.id);
    }
    return `${kind}${ENTITY_KEY_SEPARATOR}<invalid>`;
}

function isWorkflowEntity<K extends WorkflowKind>(kind: K, value: unknown): value is WorkflowEntities[K] {
    if (!isRecord(value)) return false;
    return value.kind === kind
        && typeof value.id === "string" && value.id.length > 0
        && typeof value.sessionId === "string" && value.sessionId.length > 0
        && typeof value.state === "string" && value.state.length > 0
        && Number.isSafeInteger(value.version) && (value.version as number) >= 0
        && Number.isSafeInteger(value.cancellationEpoch) && (value.cancellationEpoch as number) >= 0
        && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
        && typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt));
}

/** Entity kind that stores execution attempts. */
const ATTEMPT_KIND = "action_attempt";

/** Legal `ActionAttempt.state` values. */
const ATTEMPT_STATES: ReadonlySet<string> = new Set([
    "running", "succeeded", "failed", "cancelled", "unknown_outcome",
]);

/** Action states that cannot be restored without one unresolved attempt. */
const UNRESOLVED_ACTION_STATES: ReadonlySet<string> = new Set([
    "running", "executing", "unknown_outcome", "reconciling",
]);

/** Report key for an attempt fact: `attempt:<attemptId>`. */
function attemptKey(attemptId: string): string {
    return `attempt:${attemptId}`;
}

/** Report key for a malformed attempt payload. */
function attemptKeyOf(value: unknown): string {
    if (isRecord(value) && typeof value.attemptId === "string" && value.attemptId.length > 0) {
        return attemptKey(value.attemptId);
    }
    return attemptKey("<invalid>");
}

/** Runtime guard for one persisted `action_attempt` payload. */
function isActionAttempt(value: unknown): value is ActionAttempt {
    if (!isRecord(value)) return false;
    return typeof value.attemptId === "string" && value.attemptId.length > 0
        && typeof value.executionId === "string" && value.executionId.length > 0
        && typeof value.operationId === "string" && value.operationId.length > 0
        && typeof value.actionId === "string" && value.actionId.length > 0
        && typeof value.sessionId === "string" && value.sessionId.length > 0
        && (value.originTurnId === undefined || (typeof value.originTurnId === "string" && value.originTurnId.length > 0))
        && (value.observedInTurnId === undefined || (typeof value.observedInTurnId === "string" && value.observedInTurnId.length > 0))
        && ATTEMPT_STATES.has(value.state as string)
        && Number.isSafeInteger(value.version) && (value.version as number) >= 0
        && Number.isSafeInteger(value.cancellationEpoch) && (value.cancellationEpoch as number) >= 0
        && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt))
        && (value.settledAt === undefined
            || (typeof value.settledAt === "string" && Number.isFinite(Date.parse(value.settledAt))));
}

function timestampOf(record: EventRecord, entity: WorkflowEntity): string {
    return Number.isFinite(Date.parse(record.recordedAt)) ? record.recordedAt : entity.updatedAt;
}

function eventOf(
    kind: WorkflowKind,
    entity: WorkflowEntity,
    record: EventRecord,
    eventType: string,
    from: string,
    to: string,
    expectedVersion: number,
    version: number,
    audit: WorkflowEventAudit,
): WorkflowEvent {
    return {
        sequence: 0,
        entityKind: kind,
        entityId: entity.id,
        eventType,
        from,
        to,
        expectedVersion,
        version,
        actor: audit.actor ?? DEFAULT_PERSISTENCE_ACTOR,
        cancellationEpoch: audit.cancellationEpoch ?? 0,
        timestamp: timestampOf(record, entity),
        ...(audit.reason === undefined ? {} : { reason: audit.reason }),
    };
}

/** Parses one `<kind>.created` / `<kind>.transitioned` journal row. */
function parseWorkflowFact(record: EventRecord): WorkflowFact | undefined {
    const separator = record.kind.indexOf(".");
    if (separator <= 0) return undefined;
    const kind = record.kind.slice(0, separator);
    const phase = record.kind.slice(separator + 1);
    if (!isWorkflowKind(kind)) return undefined;
    if (phase !== "created" && phase !== "transitioned") return undefined;
    if (!isRecord(record.payload)) return undefined;
    const entityId = record.entityId ?? (typeof record.payload.id === "string" ? record.payload.id : undefined);
    if (entityId === undefined || entityId.length === 0) return undefined;
    const audit = auditOf(record.payload, kind, entityId);
    if (phase === "created") {
        if (typeof record.payload.state !== "string" || record.payload.state.length === 0) return undefined;
        return { record, kind, phase, entityId, state: record.payload.state, from: "", version: 0, ...audit };
    }
    const { from, to, version } = record.payload;
    if (typeof from !== "string" || typeof to !== "string" || to.length === 0) return undefined;
    if (!Number.isSafeInteger(version) || (version as number) < 0) return undefined;
    return { record, kind, phase, entityId, state: to, from, version: version as number, ...audit };
}

/**
 * Assigns the restored cancellation epoch of every event in one chain.
 *
 * A stored epoch is authoritative. A row without one (written before the field
 * existed, or by a caller that did not know it) inherits the next epoch already
 * known for the chain, and the entity's own epoch closes the backward walk, so
 * the rebuilt journal never regresses. A row whose epoch disagrees with the
 * chain (newer than the following event, or a head event older than the stored
 * entity) is reported and pinned to the later bound: the workflow kernel
 * rejects a snapshot whose audit head epoch differs from its entity, so a
 * truthful-but-unplaceable epoch cannot be restored as-is.
 */
function settleChain(entity: WorkflowEntity, entries: readonly ChainEntry[]): readonly PlannedEvent[] {
    const epochs = entries.map(() => entity.cancellationEpoch);
    const legacyEpoch = entries.map(() => false);
    const epochConflict = entries.map(() => false);
    let following = entity.cancellationEpoch;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const stored = entry.storedEpoch;
        if (stored === undefined) {
            epochs[index] = following;
            legacyEpoch[index] = true;
            continue;
        }
        if (stored > following) {
            epochs[index] = following;
            epochConflict[index] = true;
            continue;
        }
        epochs[index] = stored;
        following = stored;
    }
    const head = entries.length - 1;
    if (head >= 0 && epochs[head] !== entity.cancellationEpoch) {
        epochs[head] = entity.cancellationEpoch;
        epochConflict[head] = true;
    }
    return entries.map((entry, index) => ({
        order: entry.order,
        legacyActor: entry.legacyActor,
        legacyEpoch: legacyEpoch[index],
        epochConflict: epochConflict[index],
        event: { ...entry.event, cancellationEpoch: epochs[index] },
    }));
}

/**
 * Rebuilds the per-entity event chain. `undefined` means the stored journal
 * cannot faithfully describe the entity, so the entity is skipped instead of
 * being restored with an invented history.
 */
function buildChain(
    kind: WorkflowKind,
    entity: WorkflowEntity,
    facts: readonly WorkflowFact[],
): readonly PlannedEvent[] | undefined {
    // A removed identity may be created again under the same id; the latest
    // creation event starts the current incarnation. Older facts are history
    // for a row that no longer exists and are intentionally not restored.
    const creation = facts.findLastIndex(fact => fact.phase === "created");
    if (creation < 0) return undefined;
    const edges = workflowTransitions[kind];
    const states = [initialWorkflowStates[kind], ...Object.keys(edges), ...Object.values(edges).flat()];
    const entries: ChainEntry[] = [];
    let expectedVersion = -1;
    let from = "";
    for (const fact of facts.slice(creation)) {
        if (fact.phase === "created") {
            if (expectedVersion !== -1 || fact.state !== initialWorkflowStates[kind]) return undefined;
            entries.push({
                order: fact.record.sequence,
                storedEpoch: fact.cancellationEpoch,
                legacyActor: fact.actor === undefined,
                event: eventOf(kind, entity, fact.record, "created", "", fact.state, -1, 0, fact),
            });
            expectedVersion = 0;
            from = fact.state;
            continue;
        }
        if (!states.includes(fact.from) || !states.includes(fact.state)) return undefined;
        if (fact.version !== expectedVersion + 1 || fact.from !== from) return undefined;
        entries.push({
            order: fact.record.sequence,
            storedEpoch: fact.cancellationEpoch,
            legacyActor: fact.actor === undefined,
            event: eventOf(kind, entity, fact.record, `transition.${fact.state}`, fact.from, fact.state, expectedVersion, fact.version, fact),
        });
        expectedVersion = fact.version;
        from = fact.state;
    }
    return expectedVersion === entity.version && from === entity.state ? settleChain(entity, entries) : undefined;
}

/** Reports every rebuilt event whose audit metadata had to be invented or reconciled. */
function reportEventFallbacks(events: readonly PlannedEvent[], skipped: string[]): void {
    for (const item of events) {
        if (item.legacyActor) skipped.push(`event:${item.order}:legacy_actor`);
        if (item.legacyEpoch) skipped.push(`event:${item.order}:legacy_epoch`);
        if (item.epochConflict) skipped.push(`event:${item.order}:epoch_mismatch`);
    }
}

function assembleSnapshot(
    entities: readonly WorkflowEntity[],
    facts: readonly WorkflowFact[],
    attempts: readonly ActionAttempt[],
    skipped: string[],
): WorkflowSnapshot {
    const index = new Map<string, WorkflowEntity>();
    for (const entity of entities) {
        const key = entityKey(entity.kind, entity.id);
        if (index.has(key)) throw new PersistenceError("duplicate_entity", `duplicate workflow entity: ${key}`);
        index.set(key, entity);
    }
    const attemptIndex = new Map<string, ActionAttempt>();
    for (const attempt of attempts) {
        // `attemptId` is the action_attempt primary key, so a duplicate is a
        // corrupt store rather than a normal re-save.
        if (attemptIndex.has(attempt.attemptId)) {
            skipped.push(attemptKey(attempt.attemptId));
            continue;
        }
        attemptIndex.set(attempt.attemptId, attempt);
    }
    const grouped = new Map<string, WorkflowFact[]>();
    for (const fact of facts) {
        const key = `${fact.kind}${ENTITY_KEY_SEPARATOR}${fact.entityId}`;
        if (!index.has(key)) continue;
        const bucket = grouped.get(key);
        if (bucket === undefined) grouped.set(key, [fact]);
        else bucket.push(fact);
    }
    const accepted = new Map<string, { readonly entity: WorkflowEntity; readonly planned: readonly PlannedEvent[] }>();
    for (const [key, entity] of index) {
        const planned = buildChain(entity.kind, entity, grouped.get(key) ?? []);
        if (planned === undefined) {
            skipped.push(key);
            continue;
        }
        accepted.set(key, { entity, planned });
    }
    // A skipped parent makes its descendants unrestorable; drop them too instead
    // of asking the workflow kernel to reject the whole snapshot.
    let changed = true;
    while (changed) {
        changed = false;
        for (const key of [...accepted.keys()]) {
            const entry = accepted.get(key);
            if (entry === undefined) continue;
            if (requiredReferences(entry.entity).some(reference => !accepted.has(reference))) {
                accepted.delete(key);
                skipped.push(key);
                changed = true;
            }
        }
    }
    // Reattach execution attempts: an action keeps only the attempt ids whose
    // `action_attempt` row exists. A missing attempt is reported instead of
    // quietly dropping the action (older databases have no attempt kind).
    const restored = new Map<string, WorkflowEntity>();
    const linked = new Set<string>();
    for (const [key, entry] of accepted) {
        if (entry.entity.kind !== "action") {
            restored.set(key, entry.entity);
            continue;
        }
        const present: string[] = [];
        for (const attemptId of entry.entity.attemptIds) {
            if (!attemptIndex.has(attemptId)) {
                skipped.push(attemptKey(attemptId));
                continue;
            }
            present.push(attemptId);
        }
        if (present.length < entry.entity.attemptIds.length && UNRESOLVED_ACTION_STATES.has(entry.entity.state)) {
            const unresolved = present.some((attemptId) => {
                const state = attemptIndex.get(attemptId)?.state;
                return state === "running" || state === "unknown_outcome";
            });
            if (!unresolved) {
                // The kernel requires an unresolved attempt for this action
                // state; filtering would make the whole snapshot invalid.
                skipped.push(key);
                continue;
            }
        }
        for (const attemptId of present) linked.add(attemptId);
        restored.set(key, present.length === entry.entity.attemptIds.length
            ? entry.entity
            : { ...entry.entity, attemptIds: present });
    }
    for (const attemptId of attemptIndex.keys()) {
        if (!linked.has(attemptId)) skipped.push(attemptKey(attemptId));
    }
    const ordered = [...accepted.entries()]
        .filter(([key]) => restored.has(key))
        .flatMap(([, entry]) => entry.planned)
        .sort((left, right) => left.order - right.order);
    reportEventFallbacks(ordered, skipped);
    const events = ordered.map((item, position) => ({ ...item.event, sequence: position + 1 }));
    const snapshotEntities = [...restored.values()];
    const snapshotAttempts = snapshotEntities.flatMap(entity => entity.kind === "action"
        ? entity.attemptIds.flatMap((attemptId) => {
            const attempt = attemptIndex.get(attemptId);
            return attempt === undefined ? [] : [attempt];
        })
        : []);
    const cancellationEpoch = snapshotEntities.reduce((maximum, entity) => Math.max(maximum, entity.cancellationEpoch), 0);
    return {
        schemaVersion: WORKFLOW_SNAPSHOT_SCHEMA_VERSION,
        sequence: events.length,
        cancellationEpoch,
        entities: snapshotEntities,
        attempts: snapshotAttempts,
        events,
    };
}

/** Entity identities the workflow kernel requires to exist for this entity. */
function requiredReferences(entity: WorkflowEntity): readonly string[] {
    const references: string[] = [];
    if (entity.kind !== "session") references.push(entityKey("session", entity.sessionId));
    if (entity.originTurnId !== undefined) references.push(entityKey("turn", entity.originTurnId));
    switch (entity.kind) {
        case "session":
            break;
        case "turn":
            if (entity.replyTo !== undefined) references.push(entityKey("turn", entity.replyTo));
            break;
        case "intent":
            references.push(entityKey("turn", entity.originTurnId));
            break;
        case "mission":
            references.push(entityKey("intent", entity.intentId));
            break;
        case "goal":
            references.push(entityKey("mission", entity.missionId));
            if (entity.correctivePlanId !== undefined) references.push(entityKey("plan", entity.correctivePlanId));
            break;
        case "plan":
            references.push(entityKey("goal", entity.goalId));
            break;
        case "task":
            references.push(entityKey("plan", entity.planId));
            for (const dependency of entity.dependsOn) references.push(entityKey("task", dependency));
            break;
        case "action":
            references.push(entityKey("task", entity.taskId));
            break;
    }
    return references;
}

/** Validates a snapshot envelope before handing it to the workflow kernel. */
function assertSnapshotEnvelope(snapshot: WorkflowSnapshot): void {
    if (snapshot === null || typeof snapshot !== "object") {
        throw new PersistenceError("invalid_snapshot", "workflow snapshot must be an object");
    }
    if (snapshot.schemaVersion !== WORKFLOW_SNAPSHOT_SCHEMA_VERSION) {
        throw new PersistenceError(
            "schema_version",
            `unsupported workflow snapshot schemaVersion: ${String(snapshot.schemaVersion)} (expected ${WORKFLOW_SNAPSHOT_SCHEMA_VERSION})`,
        );
    }
    if (!Array.isArray(snapshot.entities) || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.attempts)) {
        throw new PersistenceError("invalid_snapshot", "workflow snapshot requires entities, attempts and events arrays");
    }
    if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
        throw new PersistenceError("sequence_mismatch", `invalid workflow snapshot sequence: ${String(snapshot.sequence)}`);
    }
    if (snapshot.events.length !== snapshot.sequence) {
        throw new PersistenceError(
            "sequence_mismatch",
            `workflow snapshot sequence ${snapshot.sequence} does not match ${snapshot.events.length} events`,
        );
    }
    const seen = new Set<string>();
    for (const entity of snapshot.entities) {
        if (entity === null || typeof entity !== "object") {
            throw new PersistenceError("invalid_snapshot", "workflow snapshot contains a non-object entity");
        }
        const key = `${String(entity.kind)}${ENTITY_KEY_SEPARATOR}${String(entity.id)}`;
        if (seen.has(key)) throw new PersistenceError("duplicate_entity", `duplicate workflow entity: ${key}`);
        seen.add(key);
    }
    for (const [index, event] of snapshot.events.entries()) {
        if (event.sequence !== index + 1) {
            throw new PersistenceError(
                "sequence_mismatch",
                `workflow event sequence ${String(event.sequence)} at index ${index} is not ${index + 1}`,
            );
        }
    }
}

/**
 * Validates the append-only event journal order. `Store.events()` already sorts
 * ascending; this guard rejects a journal whose sequence numbers are not
 * strictly increasing (duplicates or regressions).
 */
export function validateEventOrder(events: readonly EventRecord[]): void {
    let previous = -1;
    for (const [index, event] of events.entries()) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous) {
            throw new PersistenceError(
                "sequence_mismatch",
                `event sequence ${String(event.sequence)} at index ${index} is not strictly greater than ${previous}`,
            );
        }
        previous = event.sequence;
    }
}

/**
 * State fields of the workflow kernel rewritten by {@link adoptWorkflowState}.
 *
 * `WorkflowStore.restore()` is static and always returns a new instance, so
 * there is no supported way to load a snapshot into an existing kernel. This
 * guarded shim copies the restored maps/counters into the caller's instance so
 * that `new WorkflowPersistence({ store, workflow })` and
 * `rehydrate(store, workflow)` really do restore *that* writer. If a future
 * kernel renames or hides these fields the shim declines and the layer falls
 * back to the restored instance exposed by `WorkflowPersistence.workflow`.
 */
const WORKFLOW_STATE_FIELDS = ["entities", "attempts", "events", "sequence", "epoch"] as const;

function adoptWorkflowState(target: WorkflowStore, source: WorkflowStore): boolean {
    const targetRecord = target as unknown as Record<string, unknown>;
    const sourceRecord = source as unknown as Record<string, unknown>;
    for (const field of WORKFLOW_STATE_FIELDS) {
        if (!(field in targetRecord) || !(field in sourceRecord)) return false;
    }
    for (const field of WORKFLOW_STATE_FIELDS) targetRecord[field] = sourceRecord[field];
    return true;
}

/**
 * Persists workflow aggregates, their lifecycle events and restores them in a
 * different process.
 */
export class WorkflowPersistence {
    readonly store: Store;
    private active: WorkflowStore;
    private readonly initial: WorkflowStore;
    private readonly now: () => string;

    constructor(options: WorkflowPersistenceInit) {
        this.store = options.store;
        this.active = options.workflow;
        this.initial = options.workflow;
        this.now = options.now ?? (() => new Date().toISOString());
    }

    /**
     * The live workflow kernel. `restoreAll` normally adopts the restored state
     * into the constructor's instance, so this getter keeps the same identity;
     * it changes only when the guarded adoption shim cannot recognise the
     * kernel layout.
     */
    get workflow(): WorkflowStore {
        return this.active;
    }

    /**
     * Creates a workflow entity, writes it through the store and appends
     * `<kind>.created` in the same database transaction. The event carries the
     * acting `actor` and the entity's `cancellationEpoch` (always 0 at creation).
     */
    create<K extends WorkflowKind>(
        kind: K,
        input: CreateEntity<K>,
        actorOrOptions: string | WorkflowCreateOptions = {},
    ): WorkflowEntities[K] {
        const actor = actorOf(typeof actorOrOptions === "string" ? actorOrOptions : actorOrOptions.actor);
        const before = this.active.snapshot();
        const created = this.active.create(kind, input, actor);
        try {
            this.store.transaction((tx) => {
                persistEntity(tx, kind, created as unknown as Persisted<K>);
                writeCreated(tx, kind, created.id, created.state, {
                    actor,
                    cancellationEpoch: created.cancellationEpoch,
                });
            });
        } catch (error) {
            this.active = WorkflowStore.restore(before, this.now);
            throw error;
        }
        return created;
    }

    /**
     * Transitions one workflow entity, persists the new version with
     * compare-and-swap against the previous version and appends
     * `<kind>.transitioned` in the same database transaction. The event carries
     * the request's `actor` and `reason` plus the entity's real
     * `cancellationEpoch`, so a restore rebuilds the audit fact the kernel
     * recorded rather than a placeholder.
     */
    transition<K extends WorkflowKind>(
        kind: K,
        id: string,
        to: WorkflowEntities[K]["state"],
        options: TransitionOptions,
    ): WorkflowEntities[K] {
        const previous = this.get(kind, id);
        const before = this.active.snapshot();
        const updated = this.active.transition(kind, id, to, options);
        try {
            this.store.transaction((tx) => {
                const saveOptions: SaveOptions = tx.state(kind, id) === "new" ? {} : { expectedVersion: previous.version };
                persistEntity(tx, kind, updated as unknown as Persisted<K>, saveOptions);
                writeTransition(tx, kind, {
                    id: updated.id,
                    from: previous.state,
                    to: updated.state,
                    version: updated.version,
                    actor: options.actor,
                    ...(options.reason === undefined ? {} : { reason: options.reason }),
                    // The kernel records the entity epoch, not the asserted one
                    // (a commit may assert an ancestor's newer epoch).
                    cancellationEpoch: updated.cancellationEpoch,
                });
            });
        } catch (error) {
            this.active = WorkflowStore.restore(before, this.now);
            throw error;
        }
        return updated;
    }

    /**
     * Appends the `<kind>.transitioned` envelope for a transition the caller
     * already applied to the kernel.
     *
     * `actor` / `reason` / `cancellationEpoch` are optional audit metadata: the
     * writer fills the actor with {@link DEFAULT_PERSISTENCE_ACTOR} when the
     * caller cannot name one and omits an unknown epoch, which `restoreAll`
     * then reports as a legacy fact. Call inside an outer `store.transaction`
     * to keep a mirrored entity and its event atomic.
     */
    saveTransition(kind: WorkflowKind, fact: WorkflowTransitionFact): void {
        writeTransition(this.store, kind, fact);
    }

    /**
     * Appends the durable envelope for an already-recorded {@link WorkflowEvent}.
     *
     * The payload is the shared `<kind>.created` / `<kind>.transitioned` base
     * plus the event's `actor`, `reason` and `cancellationEpoch`, so a caller
     * that owns the exact kernel fact (for example the kernel adapter) persists
     * the real audit metadata. `overrides` can supply a better value without
     * rebuilding the event.
     */
    persistEvent(event: WorkflowEvent, overrides: WorkflowEventAudit = {}): void {
        const reason = overrides.reason ?? event.reason;
        const audit: WorkflowEventAudit = {
            actor: overrides.actor ?? event.actor,
            ...(reason === undefined ? {} : { reason }),
            cancellationEpoch: overrides.cancellationEpoch ?? event.cancellationEpoch,
        };
        if (event.eventType === "created") {
            writeCreated(this.store, event.entityKind, event.entityId, event.to, audit);
            return;
        }
        writeTransition(this.store, event.entityKind, {
            id: event.entityId,
            from: event.from,
            to: event.to,
            version: event.version,
            ...audit,
        });
    }

    /**
     * Persists one execution attempt as an `action_attempt` entity. The write
     * carries the attempt fact unchanged, including its `version` (0 while
     * running, 1 once settled).
     */
    saveAttempt(attempt: ActionAttempt, options: SaveOptions = {}): ActionAttempt {
        persistEntity(this.store, ATTEMPT_KIND, attempt, options);
        return attempt;
    }

    /**
     * Persists one execution attempt and appends its
     * `action_attempt.created` / `action_attempt.transitioned` event in the same
     * database transaction. The phase follows the attempt version: 0 is the
     * creation fact, any later version is a settlement/reconciliation fact.
     * `actor`, `reason` and `cancellationEpoch` are persisted with the event;
     * an omitted epoch falls back to the attempt's own epoch.
     */
    persistAttempt(attempt: ActionAttempt, options: PersistAttemptOptions = {}): ActionAttempt {
        const phase: WorkflowEventPhase = attempt.version === 0 ? "created" : "transitioned";
        const audit: WorkflowEventAudit = {
            actor: options.actor,
            ...(options.reason === undefined ? {} : { reason: options.reason }),
            cancellationEpoch: options.cancellationEpoch ?? attempt.cancellationEpoch,
        };
        this.store.transaction((tx) => {
            const creating = tx.state(ATTEMPT_KIND, attempt.attemptId) === "new";
            persistEntity(
                tx,
                ATTEMPT_KIND,
                attempt,
                creating || phase === "created" ? {} : { expectedVersion: attempt.version - 1 },
            );
            const base = phase === "created"
                ? { id: attempt.attemptId, state: attempt.state }
                : { id: attempt.attemptId, from: options.from ?? "running", to: attempt.state, version: attempt.version };
            tx.appendEvent(`${ATTEMPT_KIND}.${phase}`, eventPayload(base, audit), attempt.attemptId);
        });
        return attempt;
    }

    /** Reads a workflow entity, falling back to a full restore from the store. */
    get<K extends WorkflowKind>(kind: K, id: string): WorkflowEntities[K] {
        const local = this.active.find(kind, id);
        if (local.isPresent()) return local.get();
        let exists: boolean;
        try {
            exists = loadEntity(this.store, kind, id) !== undefined;
        } catch (error) {
            if (!this.store.open) throw error;
            throw new PersistenceError("corrupt_payload", `cannot load ${kind} ${id}: ${messageOf(error)}`, { cause: error });
        }
        if (!exists) {
            throw new WorkflowError("not_found", `${kind} ${id} does not exist`);
        }
        this.restoreAll();
        return this.active.get(kind, id);
    }

    /** Lists workflow entities, restoring once when the kernel is still empty. */
    list<K extends WorkflowKind>(kind: K, sessionId?: string): WorkflowEntities[K][] {
        const local = this.active.list(kind, sessionId);
        if (local.length > 0) return local;
        let stored = false;
        try {
            stored = listEntities(this.store, kind, sessionId === undefined ? undefined : { sessionId }).length > 0;
        } catch {
            // A corrupt row in this kind is handled by restoreAll's skipped list.
            stored = true;
        }
        if (!stored) return local;
        this.restoreAll();
        return this.active.list(kind, sessionId);
    }

    /**
     * Rebuilds every workflow entity, execution attempt and event from the store
     * and restores it into the live kernel. Corrupt rows are reported in
     * `skipped`, never thrown.
     */
    restoreAll(): RestoreReport {
        if (!this.store.open) {
            throw new PersistenceError("unsupported_store", "cannot restore workflow state from a closed store");
        }
        const skipped: string[] = [];
        const entities: WorkflowEntity[] = [];
        for (const kind of WORKFLOW_KINDS) {
            entities.push(...this.readKind(kind, skipped));
        }
        const attempts = this.readAttempts(skipped);
        const facts = this.readFacts(skipped);
        const snapshot = assembleSnapshot(entities, facts, attempts, skipped);
        this.active = this.install(snapshot);
        return {
            restored: snapshot.entities.length,
            skipped,
            events: snapshot.events.length,
            attempts: snapshot.attempts.length,
        };
    }

    /**
     * Restores a supplied snapshot (used for imports and tests). Envelope
     * conflicts (schema version, sequence, duplicate entity) raise a typed
     * {@link PersistenceError} before the kernel sees the snapshot.
     */
    restoreSnapshot(snapshot: WorkflowSnapshot): RestoreReport {
        const copy = structuredClone(snapshot);
        this.active = this.install(copy);
        return {
            restored: copy.entities.length,
            skipped: [],
            events: copy.events.length,
            attempts: copy.attempts.length,
        };
    }

    private install(snapshot: WorkflowSnapshot): WorkflowStore {
        assertSnapshotEnvelope(snapshot);
        let restored: WorkflowStore;
        try {
            restored = WorkflowStore.restore(snapshot, this.now);
        } catch (error) {
            if (error instanceof PersistenceError) throw error;
            const code = error instanceof WorkflowError ? error.code : "unknown";
            throw new PersistenceError(
                "invalid_snapshot",
                `workflow snapshot rejected (${code}): ${messageOf(error)}`,
                { cause: error },
            );
        }
        return adoptWorkflowState(this.initial, restored) ? this.initial : restored;
    }

    private readKind<K extends WorkflowKind>(kind: K, skipped: string[]): readonly WorkflowEntities[K][] {
        let listed: readonly WorkflowEntities[K][];
        try {
            listed = listEntities(this.store, kind);
        } catch (error) {
            return this.recoverKind(kind, skipped, error);
        }
        const valid: WorkflowEntities[K][] = [];
        for (const proxy of listed) {
            const entity = plainEntity(proxy);
            if (!isWorkflowEntity(kind, entity)) {
                skipped.push(entityKeyOf(kind, entity));
                continue;
            }
            valid.push(entity);
        }
        return valid;
    }

    /**
     * Reads every stored execution attempt. A database written before the
     * `action_attempt` kind simply has no rows, which is handled by
     * {@link assembleSnapshot} as a missing, reported attempt.
     */
    private readAttempts(skipped: string[]): readonly ActionAttempt[] {
        let listed: readonly ActionAttempt[];
        try {
            listed = listEntities(this.store, ATTEMPT_KIND);
        } catch (error) {
            return this.recoverAttempts(skipped, error);
        }
        const valid: ActionAttempt[] = [];
        for (const proxy of listed) {
            const attempt = plainEntity(proxy);
            if (!isActionAttempt(attempt)) {
                skipped.push(attemptKeyOf(attempt));
                continue;
            }
            valid.push(attempt);
        }
        return valid;
    }

    private recoverAttempts(skipped: string[], cause: unknown): readonly ActionAttempt[] {
        const ids = this.scanEntityIds(ATTEMPT_KIND, cause);
        const valid: ActionAttempt[] = [];
        for (const id of ids) {
            let attempt: ActionAttempt;
            try {
                attempt = plainEntity(this.store.resolve<ActionAttempt>(ATTEMPT_KIND, id));
            } catch (error) {
                if (!this.store.open) throw error;
                skipped.push(attemptKey(id));
                continue;
            }
            if (!isActionAttempt(attempt)) {
                skipped.push(attemptKey(id));
                continue;
            }
            valid.push(attempt);
        }
        return valid;
    }

    private recoverKind<K extends WorkflowKind>(
        kind: K,
        skipped: string[],
        cause: unknown,
    ): readonly WorkflowEntities[K][] {
        const ids = this.scanEntityIds(kind, cause);
        const valid: WorkflowEntities[K][] = [];
        for (const id of ids) {
            let entity: WorkflowEntities[K];
            try {
                entity = plainEntity(this.store.resolve<WorkflowEntities[K]>(kind, id));
            } catch (error) {
                if (!this.store.open) throw error;
                skipped.push(entityKey(kind, id));
                continue;
            }
            if (!isWorkflowEntity(kind, entity)) {
                skipped.push(entityKey(kind, id));
                continue;
            }
            valid.push(entity);
        }
        return valid;
    }

    private readFacts(skipped: string[]): readonly WorkflowFact[] {
        const facts: WorkflowFact[] = [];
        for (const record of this.readEventRecords(skipped)) {
            const separator = record.kind.indexOf(".");
            if (separator <= 0) continue;
            const kind = record.kind.slice(0, separator);
            if (!isWorkflowKind(kind)) continue;
            const fact = parseWorkflowFact(record);
            if (fact === undefined) {
                skipped.push(`event:${record.sequence}`);
                continue;
            }
            facts.push(fact);
        }
        return facts;
    }

    private readEventRecords(skipped: string[]): readonly EventRecord[] {
        let events: readonly EventRecord[];
        try {
            events = this.store.events();
        } catch (error) {
            const scan = this.scanEventRecords(error);
            for (const sequence of scan.corrupt) skipped.push(`event:${sequence}`);
            events = scan.events;
        }
        validateEventOrder(events);
        return events;
    }

    private scanEntityIds(kind: EntityKind, cause: unknown): readonly string[] {
        if (this.store.path === ":memory:") {
            // An in-memory database cannot be reopened for a side-channel scan;
            // the journal still names every entity that went through this layer.
            const known = this.journalEntityIds(kind);
            if (known.length > 0) return known;
            throw new PersistenceError(
                "unsupported_store",
                `cannot recover ${kind} rows from an in-memory store: ${messageOf(cause)}`,
                { cause },
            );
        }
        try {
            const driver = openSqlite({ path: this.store.path, readonly: true, foreignKeys: false });
            try {
                const rows = driver.query<IdRow>({
                    sql: "SELECT id FROM entities WHERE kind = ?",
                    parameters: [kind],
                });
                return rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
            } finally {
                driver.close();
            }
        } catch (error) {
            throw new PersistenceError("corrupt_payload", `cannot scan stored ${kind} rows: ${messageOf(error)}`, { cause: error });
        }
    }

    /** Entity ids recoverable from journal entries for one entity kind. */
    private journalEntityIds(kind: EntityKind): readonly string[] {
        try {
            const ids = new Set<string>();
            for (const event of this.store.events()) {
                if (event.kind.startsWith(`${kind}.`) && typeof event.entityId === "string" && event.entityId.length > 0) {
                    ids.add(event.entityId);
                }
            }
            return [...ids];
        } catch {
            return [];
        }
    }

    private scanEventRecords(cause: unknown): RawEventScan {
        if (this.store.path === ":memory:") {
            throw new PersistenceError(
                "unsupported_store",
                `cannot recover events from an in-memory store: ${messageOf(cause)}`,
                { cause },
            );
        }
        try {
            const driver = openSqlite({ path: this.store.path, readonly: true, foreignKeys: false });
            try {
                const rows = driver.query<EventRow>({
                    sql: "SELECT sequence, kind, entity_id, recorded_at, payload FROM events ORDER BY sequence ASC",
                });
                const events: EventRecord[] = [];
                const corrupt: number[] = [];
                for (const row of rows) {
                    const sequence = typeof row.sequence === "bigint" ? Number(row.sequence) : row.sequence;
                    try {
                        const payload: unknown = JSON.parse(typeof row.payload === "string" ? row.payload : "");
                        events.push({
                            sequence,
                            kind: row.kind,
                            ...(typeof row.entity_id === "string" ? { entityId: row.entity_id } : {}),
                            recordedAt: row.recorded_at,
                            payload,
                        });
                    } catch {
                        corrupt.push(sequence);
                    }
                }
                return { events, corrupt };
            } finally {
                driver.close();
            }
        } catch (error) {
            throw new PersistenceError("corrupt_payload", `cannot scan stored events: ${messageOf(error)}`, { cause: error });
        }
    }
}
