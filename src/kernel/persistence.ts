/**
 * Kernel persistence adapter.
 *
 * The workflow writer is the single in-memory source of truth; this adapter
 * mirrors every admitted fact into the SQLite `Store` in the same synchronous
 * transaction as the kernel event. It also rebuilds the workflow writer from
 * those facts after a restart.
 *
 * Since the persistence layer (`src/persistence`) owns the durable protocol,
 * this adapter speaks it instead of inventing a second one:
 *
 * - aggregates are written through `persistEntity` / `removeEntity`;
 * - workflow facts use the shared `<kind>.created` / `<kind>.transitioned`
 *   event kinds whose base payloads are `{ id, state }` and
 *   `{ id, from, to, version }`;
 * - kernel-only facts (the exact `WorkflowEvent`, `ActionAttempt`, and the
 *   free-form detail the kernel used to keep in its own envelope) travel as
 *   *additional* payload fields, never as a competing event name.
 *
 * Restore therefore reuses `WorkflowPersistence.restoreAll()`, which now reads
 * the persisted `action_attempt` rows as well as the eight workflow aggregates.
 * The adapter mirrors every attempt fact it appends as an `action_attempt`
 * entity, so a kernel-written database round-trips through the primary path.
 * The journal fallback is kept for older databases that stored attempt facts
 * only inside the `attempt` payload field.
 */

import { createHash } from "node:crypto";
import { isEntityKind } from "../entity/key.ts";
import type { EntityKind, EventRecord } from "../entity/types.ts";
import { persistEntity, removeEntity } from "../persistence/mappers.ts";
import {
    WORKFLOW_KINDS as PERSISTED_WORKFLOW_KINDS,
    workflowEventKind,
} from "../persistence/types.ts";
import type { Persisted, RestoreReport } from "../persistence/types.ts";
import { WorkflowPersistence } from "../persistence/workflow.ts";
import type { Store } from "../service/store.ts";
import type { Budget, BudgetUsage } from "../shared.ts";
import type { BudgetReservation } from "../tool/types.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { ActionAttempt, WorkflowEntity, WorkflowEvent, WorkflowKind, WorkflowSnapshot } from "../workflow/types.ts";

/**
 * Marker for the kernel-only payload extensions layered on the shared
 * persistence envelope. Version 2 names the unified `<kind>.<phase>` shape; the
 * base fields (`id`/`state`/`from`/`to`/`version`) are owned by `src/persistence`.
 */
export const KERNEL_EVENT_SCHEMA = "attention-manifest-protocol/kernel/event/v2";

/** The eight workflow aggregates, in forward-decomposition order. */
export const WORKFLOW_KINDS: readonly WorkflowKind[] = PERSISTED_WORKFLOW_KINDS;

/** Actor recorded on rebuilt workflow facts that carry no explicit actor. */
const KERNEL_ACTOR = "kernel";

/** Lifecycle operation suffixes that always describe the first write of a fact. */
const CREATION_OPERATIONS: ReadonlySet<string> = new Set([
    "created", "added", "issued", "business", "integrity_verified",
]);

/** Kernel-only facts attached to the shared event envelope. */
export interface KernelEventDetail {
    readonly entityKind?: EntityKind | WorkflowKind;
    readonly entityId?: string;
    /** Target state, supplied by the kernel for workflow events. */
    readonly state?: string;
    readonly version?: number;
    /** Exact workflow audit event; present for every state transition. */
    readonly workflow?: WorkflowEvent;
    /** Attempt fact attached to `action.transitioned` execution facts. */
    readonly attempt?: ActionAttempt;
    /** Free-form kernel detail (budget snapshot, receipt/evidence identifiers, ...). */
    readonly data?: unknown;
}

/**
 * One persisted kernel event: the `src/persistence` base payload plus the
 * kernel extensions declared by {@link KernelEventDetail}.
 */
export interface KernelEventPayload extends KernelEventDetail {
    /** Base envelope: entity identity (`<kind>.created` / `<kind>.transitioned`). */
    readonly id?: string;
    /** Base envelope: source state after `transitioned`. */
    readonly from?: string;
    /** Base envelope: target state after `transitioned`. */
    readonly to?: string;
    /** Schema marker for the kernel extensions above the shared base payload. */
    readonly schema?: string;
    /** Lifecycle operation the kernel named this fact with (e.g. `issued`). */
    readonly operation?: string;
}

/** Persisted `budget_ledger` aggregate for the tenant/root budget key. */
export interface BudgetLedgerRecord {
    readonly budgetKey: string;
    readonly tenantId: string;
    readonly version: number;
    readonly updatedAt: string;
    readonly limit: Budget;
    readonly settled: BudgetUsage;
    readonly reserved: BudgetUsage;
    readonly reservations: readonly BudgetReservation[];
}

/** How {@link KernelPersistence.restoreWorkflow} rebuilt the workflow writer. */
export interface KernelRestoreReport {
    /** `restoreAll` when the persistence layer rebuilt every stored fact. */
    readonly path: "restoreAll" | "fallback";
    /** Number of workflow entities in the rebuilt writer. */
    readonly restored: number;
    /** Number of workflow events in the rebuilt writer. */
    readonly events: number;
    /** Number of execution attempts in the rebuilt writer. */
    readonly attempts: number;
    /** Facts the primary path could not restore; empty on a full restore. */
    readonly skipped: readonly string[];
    /** Why the primary `restoreAll` path was not used. */
    readonly reason?: string;
    /** Report produced by `restoreAll` when the fallback ran after it. */
    readonly primary?: RestoreReport;
}

/** JSON round-trip that unwraps managed store proxies through their `toJSON`. */
export function toPlain<T>(value: unknown): T {
    if (value === undefined || value === null) return value as T;
    const text = JSON.stringify(value);
    return (text === undefined ? value : JSON.parse(text)) as T;
}

/** Deterministic JSON used for receipt digests. */
export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Readonly<Record<string, unknown>>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

export function sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value !== "object" || value === null ? false : !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeVersion(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isWorkflowKindName(value: unknown): value is WorkflowKind {
    return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value);
}

/** The lifecycle operation encoded after the last dot of a kernel event name. */
function operationOf(name: string): string {
    const separator = name.lastIndexOf(".");
    return separator < 0 ? name : name.slice(separator + 1);
}

/**
 * `created` when the fact is the first write of an identity (an explicit
 * creation operation, or the journal/version says version 1), `transitioned`
 * otherwise. Non-workflow aggregates have no workflow state machine, so their
 * operation name doubles as the lifecycle state.
 */
function phaseOf(operation: string, version: number | undefined, previous: string | undefined): "created" | "transitioned" {
    if (CREATION_OPERATIONS.has(operation)) return "created";
    if (version !== undefined) return version <= 1 ? "created" : "transitioned";
    return previous === undefined ? "created" : "transitioned";
}

/** One workflow fact recovered from the journal, in store order. */
interface JournalFact {
    readonly order: number;
    readonly event: WorkflowEvent;
    /** True when the event was rebuilt from a shared envelope instead of `payload.workflow`. */
    readonly synthesized: boolean;
}

function isWorkflowEvent(value: unknown): value is WorkflowEvent {
    if (!isRecord(value)) return false;
    return isWorkflowKindName(value.entityKind)
        && text(value.entityId) !== undefined
        && text(value.eventType) !== undefined
        && typeof value.from === "string"
        && text(value.to) !== undefined
        && typeof value.expectedVersion === "number"
        && Number.isSafeInteger(value.expectedVersion) && value.expectedVersion >= -1
        && typeof value.version === "number"
        && Number.isSafeInteger(value.version) && value.version >= 0
        && text(value.actor) !== undefined
        && typeof value.cancellationEpoch === "number"
        && Number.isSafeInteger(value.cancellationEpoch) && value.cancellationEpoch >= 0
        && typeof value.timestamp === "string"
        && Number.isFinite(Date.parse(value.timestamp));
}

/**
 * Rebuilds a workflow audit event from the shared `<kind>.created` /
 * `<kind>.transitioned` envelope alone. This is what lets the kernel restore a
 * database whose workflow facts were written by `WorkflowPersistence`
 * (which never stores the exact kernel `WorkflowEvent`).
 */
function synthesizeWorkflowEvent(record: EventRecord): WorkflowEvent | undefined {
    const payload = record.payload;
    if (!isRecord(payload)) return undefined;
    const separator = record.kind.indexOf(".");
    if (separator <= 0) return undefined;
    const kind = record.kind.slice(0, separator);
    const phase = record.kind.slice(separator + 1);
    if (!isWorkflowKindName(kind)) return undefined;
    if (phase !== "created" && phase !== "transitioned") return undefined;
    const entityId = text(payload.id) ?? text(record.entityId);
    if (entityId === undefined) return undefined;
    if (phase === "created") {
        const state = text(payload.state);
        if (state === undefined) return undefined;
        return {
            sequence: 0,
            entityKind: kind,
            entityId,
            eventType: "created",
            from: "",
            to: state,
            expectedVersion: -1,
            version: 0,
            actor: KERNEL_ACTOR,
            cancellationEpoch: 0,
            timestamp: record.recordedAt,
        };
    }
    const version = safeVersion(payload.version);
    if (version === undefined || version < 1) return undefined;
    const from = typeof payload.from === "string" ? payload.from : undefined;
    const to = text(payload.to);
    if (from === undefined || to === undefined) return undefined;
    return {
        sequence: 0,
        entityKind: kind,
        entityId,
        eventType: `transition.${to}`,
        from,
        to,
        expectedVersion: version - 1,
        version,
        actor: KERNEL_ACTOR,
        cancellationEpoch: 0,
        timestamp: record.recordedAt,
    };
}

/** Prefers the exact kernel event, falling back to the shared envelope. */
function journalFactOf(record: EventRecord): JournalFact | undefined {
    const payload = record.payload;
    if (!isRecord(payload)) return undefined;
    if (isWorkflowEvent(payload.workflow)) {
        return { order: record.sequence, event: payload.workflow, synthesized: false };
    }
    const synthesized = synthesizeWorkflowEvent(record);
    return synthesized === undefined ? undefined : { order: record.sequence, event: synthesized, synthesized: true };
}

function isAttempt(value: unknown): value is ActionAttempt {
    if (!isRecord(value)) return false;
    return text(value.attemptId) !== undefined
        && text(value.executionId) !== undefined
        && text(value.operationId) !== undefined
        && text(value.actionId) !== undefined
        && text(value.sessionId) !== undefined
        && text(value.state) !== undefined
        && typeof value.version === "number"
        && Number.isSafeInteger(value.version) && value.version >= 0
        && typeof value.cancellationEpoch === "number"
        && Number.isSafeInteger(value.cancellationEpoch) && value.cancellationEpoch >= 0
        && typeof value.startedAt === "string"
        && Number.isFinite(Date.parse(value.startedAt));
}

export class KernelPersistence {
    readonly store: Store;
    readonly tenantId: string;
    private readonly clock: () => string;
    /** Lifecycle label of the last fact written per `kind:id`, for `transitioned` payloads. */
    private readonly lifecycle = new Map<string, string>();
    private lastRestore: KernelRestoreReport | undefined;

    constructor(store: Store, tenantId: string, clock: () => string) {
        this.store = store;
        this.tenantId = tenantId;
        this.clock = clock;
    }

    /** Report of the most recent {@link restoreWorkflow}; `undefined` before the first restore. */
    get restoreReport(): KernelRestoreReport | undefined {
        return this.lastRestore;
    }

    /**
     * Saves an aggregate payload through the persistence layer. The descriptor
     * of every registry kind selects its own key (`id`, `budgetKey`, ...), so
     * the payload is passed through unchanged apart from the tenant scope,
     * version and timestamp defaults.
     */
    saveEntity(kind: EntityKind, payload: object, version?: number, sessionId?: string): void {
        const record: Record<string, unknown> = { ...(payload as Readonly<Record<string, unknown>>) };
        record.tenantId = text(record.tenantId) ?? this.tenantId;
        const resolvedSession = sessionId ?? text(record.sessionId) ?? (isRecord(record.scope) ? text(record.scope.sessionId) : undefined);
        if (resolvedSession !== undefined) record.sessionId = resolvedSession;
        record.version = version ?? safeVersion(record.version) ?? 1;
        if (text(record.updatedAt) === undefined) {
            record.updatedAt = text(record.createdAt)
                ?? text(record.issuedAt)
                ?? text(record.compiledAt)
                ?? text(record.verifiedAt)
                ?? this.clock();
        }
        persistEntity(this.store, kind, record as unknown as Persisted<EntityKind>);
    }

    /** Mirrors one workflow aggregate exactly as the writer holds it. */
    saveWorkflow(entity: WorkflowEntity): void {
        persistEntity(this.store, entity.kind, entity as unknown as Persisted<WorkflowKind>);
    }

    /**
     * Mirrors one execution attempt exactly as the writer holds it. Attempts are
     * a first-class `action_attempt` aggregate, not a field of the action row.
     */
    saveAttempt(attempt: ActionAttempt): void {
        persistEntity(this.store, "action_attempt", attempt);
    }

    /** Removes one aggregate through the persistence layer's lifecycle-aware helper. */
    remove(kind: EntityKind, id: string): boolean {
        return removeEntity(this.store, kind, id);
    }

    /**
     * Appends one kernel fact using the shared persistence protocol.
     *
     * Workflow facts become `<kind>.created` / `<kind>.transitioned` with the
     * exact base payload of `src/persistence`; the kernel's own detail travels
     * as additional payload fields. Other aggregates follow the same rule and
     * use their lifecycle operation as the non-workflow state label.
     */
    append(name: string, entityId: string | undefined, detail: KernelEventDetail = {}): void {
        const workflow = detail.workflow;
        if (workflow === undefined) {
            this.appendLifecycle(name, entityId, detail);
            return;
        }
        const phase = workflow.eventType === "created" ? "created" : "transitioned";
        const payload: KernelEventPayload = {
            id: workflow.entityId,
            ...(phase === "created" ? { state: workflow.to } : { from: workflow.from, to: workflow.to }),
            version: workflow.version,
            schema: KERNEL_EVENT_SCHEMA,
            entityKind: workflow.entityKind,
            entityId: workflow.entityId,
            workflow,
            ...(detail.attempt === undefined ? {} : { attempt: detail.attempt }),
            ...(detail.data === undefined ? {} : { data: detail.data }),
        };
        // The attempt fact is also its own aggregate row, so restoreAll can
        // rebuild the kernel even when the journal envelope is not consulted.
        if (detail.attempt !== undefined) this.saveAttempt(detail.attempt);
        this.store.appendEvent(workflowEventKind(workflow.entityKind, phase), payload, workflow.entityId);
    }

    find<T>(kind: EntityKind, id: string): T | undefined {
        try {
            return toPlain<T>(this.store.resolve<T>(kind, id));
        } catch {
            return undefined;
        }
    }

    list<T>(kind: EntityKind): readonly T[] {
        return this.store.list<T>(kind).map(value => toPlain<T>(value));
    }

    budgetRecord(budgetKey: string): BudgetLedgerRecord | undefined {
        return this.list<BudgetLedgerRecord>("budget_ledger").find(record => record.budgetKey === budgetKey);
    }

    /**
     * Rebuilds the single workflow writer from the persisted aggregates, the
     * execution attempts and the journal.
     *
     * The primary path is `WorkflowPersistence.restoreAll()`, which now restores
     * `action_attempt` rows, so an attempt-bearing kernel database restores
     * through it. When that path cannot rebuild every stored fact (for example a
     * legacy journal that only carries attempts in the event payload), the
     * adapter falls back to its own snapshot rebuild and records both attempts
     * in {@link restoreReport}.
     */
    restoreWorkflow(clock: () => string): WorkflowStore {
        this.lifecycle.clear();
        this.lastRestore = undefined;
        let primary: RestoreReport | undefined;
        let reason: string | undefined;
        try {
            const persistence = new WorkflowPersistence({
                store: this.store,
                workflow: new WorkflowStore(clock),
                now: clock,
            });
            primary = persistence.restoreAll();
            if (primary.skipped.length === 0) {
                this.indexLifecycle();
                this.lastRestore = {
                    path: "restoreAll",
                    restored: primary.restored,
                    events: primary.events,
                    attempts: primary.attempts,
                    skipped: primary.skipped,
                };
                return persistence.workflow;
            }
            reason = `restoreAll skipped ${primary.skipped.length} stored fact(s): ${primary.skipped.join(", ")}`;
        } catch (error) {
            reason = `restoreAll failed: ${messageOf(error)}`;
        }
        let workflow: WorkflowStore;
        try {
            workflow = this.restoreFromJournal(clock);
        } catch (error) {
            if (error instanceof Error && reason !== undefined) {
                error.message = `${reason}; fallback failed: ${error.message}`;
            }
            throw error;
        }
        const snapshot = workflow.snapshot();
        this.indexLifecycle();
        this.lastRestore = {
            path: "fallback",
            restored: snapshot.entities.length,
            events: snapshot.sequence,
            attempts: snapshot.attempts.length,
            skipped: primary?.skipped ?? [],
            ...(reason === undefined ? {} : { reason }),
            ...(primary === undefined ? {} : { primary }),
        };
        return workflow;
    }

    /**
     * Fallback rebuild: reconstructs the workflow snapshot from the unified
     * journal. Exact `payload.workflow` events are preferred; envelopes written
     * by `WorkflowPersistence` are synthesized from their base payload. Attempt
     * facts come from the additional `payload.attempt` field.
     */
    private restoreFromJournal(clock: () => string): WorkflowStore {
        const facts: JournalFact[] = [];
        const attempts = new Map<string, ActionAttempt>();
        for (const record of this.store.events()) {
            const fact = journalFactOf(record);
            if (fact !== undefined) facts.push(fact);
            const payload = record.payload;
            if (isRecord(payload) && isAttempt(payload.attempt)) {
                attempts.set(payload.attempt.attemptId, payload.attempt);
            }
        }
        if (facts.length === 0) return new WorkflowStore(clock);
        const entities: WorkflowEntity[] = [];
        const epochs = new Map<string, number>();
        for (const kind of WORKFLOW_KINDS) {
            for (const entity of this.list<WorkflowEntity>(kind)) {
                entities.push(entity);
                epochs.set(`${entity.kind}:${entity.id}`, entity.cancellationEpoch);
            }
        }
        facts.sort((left, right) => left.order - right.order);
        const events: WorkflowEvent[] = facts.map((fact, index) => ({ ...fact.event, sequence: index + 1 }));
        // Envelopes do not carry the per-event cancellation epoch. Walk each
        // entity's chain backwards and give synthesized facts the epoch of the
        // following fact (or the entity's final epoch), so the restored journal
        // stays non-decreasing even when both layers wrote parts of one chain.
        const followingEpoch = new Map<string, number>();
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            const fact = facts[index];
            if (event === undefined || fact === undefined) continue;
            const key = `${event.entityKind}:${event.entityId}`;
            const epoch = followingEpoch.get(key) ?? epochs.get(key) ?? event.cancellationEpoch;
            if (fact.synthesized) {
                events[index] = { ...event, cancellationEpoch: epoch };
            } else {
                followingEpoch.set(key, event.cancellationEpoch);
            }
        }
        const cancellationEpoch = Math.max(
            0,
            ...events.map(event => event.cancellationEpoch),
            ...entities.map(entity => entity.cancellationEpoch),
        );
        const snapshot: WorkflowSnapshot = {
            schemaVersion: 1,
            sequence: events.length,
            cancellationEpoch,
            entities,
            attempts: [...attempts.values()],
            events,
        };
        return WorkflowStore.restore(snapshot, clock);
    }

    /** Writes one non-workflow fact under the shared `<kind>.<phase>` rule. */
    private appendLifecycle(name: string, entityId: string | undefined, detail: KernelEventDetail): void {
        const kind = this.entityKindOf(name, detail);
        if (kind === undefined) {
            throw new TypeError(`kernel event ${name} is not bound to a registered entity kind`);
        }
        const id = text(detail.entityId) ?? text(entityId);
        if (id === undefined) throw new TypeError(`kernel event ${name} requires an entity id`);
        const operation = operationOf(name);
        const version = safeVersion(detail.version);
        const key = `${kind}:${id}`;
        const previous = this.lifecycle.get(key);
        const phase = phaseOf(operation, version, previous);
        const base: KernelEventPayload = phase === "created"
            ? { id, state: "created", operation, ...(version === undefined ? {} : { version }) }
            : { id, from: previous ?? "created", to: operation, version: version ?? 1, operation };
        const payload: KernelEventPayload = {
            ...base,
            schema: KERNEL_EVENT_SCHEMA,
            entityKind: kind,
            entityId: id,
            ...(detail.attempt === undefined ? {} : { attempt: detail.attempt }),
            ...(detail.data === undefined ? {} : { data: detail.data }),
        };
        this.lifecycle.set(key, phase === "created" ? "created" : operation);
        this.store.appendEvent(`${kind}.${phase}`, payload, id);
    }

    /** Entity kind addressed by a kernel append: explicit detail first, then the name prefix. */
    private entityKindOf(name: string, detail: KernelEventDetail): EntityKind | undefined {
        if (isEntityKind(detail.entityKind)) return detail.entityKind;
        const separator = name.indexOf(".");
        const prefix = separator < 0 ? name : name.slice(0, separator);
        return isEntityKind(prefix) ? prefix : undefined;
    }

    /** Seeds the lifecycle-label map from the stored non-workflow journal. */
    private indexLifecycle(): void {
        this.lifecycle.clear();
        try {
            for (const record of this.store.events()) {
                const payload = record.payload;
                if (!isRecord(payload) || payload.workflow !== undefined) continue;
                const kind = isEntityKind(payload.entityKind) ? payload.entityKind : undefined;
                const id = text(payload.id) ?? text(record.entityId);
                if (kind === undefined || id === undefined) continue;
                const separator = record.kind.lastIndexOf(".");
                if (separator < 0) continue;
                const phase = record.kind.slice(separator + 1);
                if (phase === "created") {
                    this.lifecycle.set(`${kind}:${id}`, "created");
                    continue;
                }
                const to = text(payload.to);
                if (phase === "transitioned" && to !== undefined) this.lifecycle.set(`${kind}:${id}`, to);
            }
        } catch {
            // The label map is advisory metadata; a corrupt journal is reported by restoreAll.
            this.lifecycle.clear();
        }
    }
}
