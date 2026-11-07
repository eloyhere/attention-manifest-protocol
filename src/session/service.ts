import { validateBudget } from "../shared.ts";
import type { Budget, Identifier } from "../shared.ts";
import { digestOf } from "../serialization/index.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { WorkflowEntityService } from "../workflow/service.ts";
import { isWorkflowSettled, isWorkflowTerminal, workflowTransitions } from "../workflow/transitions.ts";
import { WorkflowError } from "../workflow/types.ts";
import { IntentService } from "../intent/service.ts";
import { TurnService } from "../turn/service.ts";
import type { Turn } from "../turn/types.ts";
import {
    SESSION_PERSIST_KINDS, SESSION_SNAPSHOT_SCHEMA_VERSION, SESSION_STATES, SESSION_TYPES,
    SessionError, sessionTypeOf, WORKFLOW_SESSION_PERSIST_KINDS,
} from "./types.ts";
import type {
    Session, SessionPersistKind, SessionPersistReference, SessionSnapshot, SessionState, SessionType,
    WorkflowSessionPersistKind,
} from "./types.ts";

/** A reference whose referent could not be restored; the caller decides how to recover. */
export interface SessionPersistSkip {
    readonly reference: SessionPersistReference;
    readonly reason: "expired" | "unresolved";
}

/** Options for the snapshot-driven `resume(snapshot)` form. */
export interface SessionResumeOptions {
    readonly actor?: Identifier;
    /** Optimistic check against the live Session version before restoring. */
    readonly expectedVersion?: number;
    /** Scope assertion: the snapshot must belong to this Session. */
    readonly expectedSessionId?: Identifier;
    /** Injected clock for deterministic resume timestamps. */
    readonly now?: string;
}

export interface SessionResumeResult {
    readonly session: Session;
    readonly persist: readonly SessionPersistReference[];
    readonly skippedPersist: readonly SessionPersistSkip[];
    readonly budgetBalance: Budget;
    readonly resumedAt: string;
    /** True when this call applied the snapshot; false on an idempotent replay. */
    readonly resumed: boolean;
    readonly idempotent: boolean;
    /** Number of distinct snapshot applications; replaying the same snapshot does not increment it. */
    readonly resumeCount: number;
    readonly snapshotDigest: string;
}

export interface CloseWithTurnsOptions {
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
    readonly reason?: string;
    /** Abandon unfinished Turns instead of rejecting with `active_turns`. */
    readonly force?: boolean;
    /** Reason recorded on every force-abandoned Turn. */
    readonly forceReason?: string;
}

export interface CloseWithTurnsResult {
    readonly session: Session;
    /** All Turns after closure. */
    readonly turns: readonly Turn[];
    /** Turns that were force-abandoned by this call. */
    readonly abandoned: readonly Turn[];
    /** Unfinished Turns observed before the call; empty when the close was clean. */
    readonly activeTurns: readonly Turn[];
    /** Unresolved Intents settled as part of a forced close. */
    readonly settledIntents: readonly Identifier[];
}

interface SessionOverlay {
    readonly sessionType: SessionType;
    readonly participants?: readonly Identifier[];
    readonly expiresAt?: string;
    readonly persist: readonly SessionPersistReference[];
    readonly budget?: Budget;
    readonly budgetBalance: Budget;
    readonly lastResumeDigest: string;
    readonly resumeCount: number;
    readonly lastResumedAt: string;
}

/**
 * Session-scoped restore metadata that has no mutable slot in the workflow
 * writer (the writer owns lifecycle/version/CAS only). Keyed by store so
 * multiple services bound to the same writer observe one restored view.
 */
const overlays = new WeakMap<WorkflowStore, Map<Identifier, SessionOverlay>>();

const overlayMap = (store: WorkflowStore): Map<Identifier, SessionOverlay> => {
    const existing = overlays.get(store);
    if (existing !== undefined) return existing;
    const created = new Map<Identifier, SessionOverlay>();
    overlays.set(store, created);
    return created;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const validDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

const safeBudget = (value: unknown, field: string): Budget => {
    if (!isRecord(value)) throw new SessionError("invalid_snapshot", `Session snapshot ${field} must be a budget object`);
    try {
        validateBudget(value as Budget);
    } catch (error) {
        throw new SessionError("invalid_snapshot", `Session snapshot ${field} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...(value as Budget) };
};

/** Content digest of the restorable snapshot facts; capture time is not identity. */
const snapshotDigest = (snapshot: SessionSnapshot): string => digestOf({
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    version: snapshot.version,
    state: snapshot.state,
    sessionType: snapshot.sessionType,
    participants: snapshot.participants,
    expiresAt: snapshot.expiresAt,
    persist: snapshot.persist,
    budget: snapshot.budget,
    budgetBalance: snapshot.budgetBalance,
});

/**
 * Canonical fresh-store replay paths. A snapshot restored into an empty writer
 * may only reproduce versions this canonical path can reach; arbitrary
 * active/idle churn must be restored through `WorkflowStore.restore` instead.
 */
const SESSION_RESTORE_PATHS: Readonly<Partial<Record<SessionState, readonly (readonly SessionState[])[]>>> = {
    created: [[]],
    active: [["active"]],
    idle: [["active", "idle"]],
    suspended: [["active", "suspended"], ["active", "idle", "suspended"]],
    resumed: [["active", "suspended", "resumed"], ["active", "idle", "suspended", "resumed"]],
};

const validateSnapshot = (input: unknown, options: SessionResumeOptions): { snapshot: SessionSnapshot; digest: string } => {
    if (!isRecord(input)) throw new SessionError("invalid_snapshot", "Session snapshot must be an object");
    if (input.schemaVersion !== SESSION_SNAPSHOT_SCHEMA_VERSION) {
        throw new SessionError("invalid_snapshot", `Unsupported session snapshot schema version: ${String(input.schemaVersion)}`);
    }
    if (!text(input.sessionId)) throw new SessionError("invalid_snapshot", "Session snapshot requires a nonempty sessionId");
    if (options.expectedSessionId !== void 0 && options.expectedSessionId !== input.sessionId) {
        throw new SessionError("scope_mismatch", `Snapshot scope ${input.sessionId} does not match ${options.expectedSessionId}`);
    }
    if (typeof input.version !== "number" || !Number.isSafeInteger(input.version) || input.version < 0) {
        throw new SessionError("invalid_snapshot", "Session snapshot version must be a nonnegative safe integer");
    }
    if (typeof input.state !== "string" || !(SESSION_STATES as readonly string[]).includes(input.state)) {
        throw new SessionError("invalid_snapshot", `Invalid session snapshot state: ${String(input.state)}`);
    }
    if (typeof input.sessionType !== "string" || !(SESSION_TYPES as readonly string[]).includes(input.sessionType)) {
        throw new SessionError("invalid_snapshot", `Invalid session snapshot type: ${String(input.sessionType)}`);
    }
    if (input.participants !== void 0 && (!Array.isArray(input.participants) || !input.participants.every(text))) {
        throw new SessionError("invalid_snapshot", "Session snapshot participants must be nonempty identifiers");
    }
    if (input.expiresAt !== void 0 && !validDate(input.expiresAt)) {
        throw new SessionError("invalid_snapshot", "Session snapshot expiresAt must be a valid instant");
    }
    if (input.capturedAt !== void 0 && !validDate(input.capturedAt)) {
        throw new SessionError("invalid_snapshot", "Session snapshot capturedAt must be a valid instant");
    }

    if (input.persist !== void 0 && !Array.isArray(input.persist)) {
        throw new SessionError("invalid_snapshot", "Session snapshot persist must be an array");
    }
    const seen = new Set<string>();
    const persist: SessionPersistReference[] = [];
    for (const value of (input.persist ?? []) as readonly unknown[]) {
        if (!isRecord(value)) throw new SessionError("invalid_snapshot", "Session snapshot persist entries must be objects");
        if (typeof value.kind !== "string" || !(SESSION_PERSIST_KINDS as readonly string[]).includes(value.kind)) {
            throw new SessionError("invalid_snapshot", `Invalid persist kind: ${String(value.kind)}`);
        }
        if (!text(value.id)) throw new SessionError("invalid_snapshot", "Persist references require nonempty ids");
        if (!text(value.reason)) throw new SessionError("invalid_snapshot", `Persist reference ${value.id} requires a reason`);
        if (value.expiresAt !== void 0 && !validDate(value.expiresAt)) {
            throw new SessionError("invalid_snapshot", `Persist reference ${value.id} has an invalid expiry`);
        }
        const key = `${value.kind}:${value.id}`;
        if (seen.has(key)) throw new SessionError("invalid_snapshot", `Duplicate persist reference: ${key}`);
        seen.add(key);
        persist.push({
            kind: value.kind as SessionPersistKind,
            id: value.id as string,
            reason: value.reason as string,
            ...(value.expiresAt === void 0 ? {} : { expiresAt: value.expiresAt as string }),
        });
    }

    const budget = input.budget === void 0 ? void 0 : safeBudget(input.budget, "budget");
    const budgetBalance = safeBudget(input.budgetBalance, "budgetBalance");
    const snapshot: SessionSnapshot = {
        schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
        sessionId: input.sessionId as string,
        version: input.version,
        state: input.state as SessionState,
        sessionType: input.sessionType as SessionType,
        ...(input.participants === void 0 ? {} : { participants: [...(input.participants as string[])] }),
        ...(input.expiresAt === void 0 ? {} : { expiresAt: input.expiresAt as string }),
        persist,
        ...(budget === void 0 ? {} : { budget }),
        budgetBalance,
        ...(input.capturedAt === void 0 ? {} : { capturedAt: input.capturedAt as string }),
    };
    return { snapshot, digest: snapshotDigest(snapshot) };
};

export class SessionService extends WorkflowEntityService<"session"> {
    private readonly turns: TurnService;
    private readonly intents: IntentService;

    constructor(store: WorkflowStore) {
        super(store, "session");
        this.turns = new TurnService(store);
        this.intents = new IntentService(store);
    }

    /** A detached Session view with restored persist/budget metadata applied. */
    override get(id: Identifier): Session {
        return this.effective(super.get(id));
    }

    override find(id: Identifier) {
        const found = super.find(id);
        return found.map(session => this.effective(session));
    }

    override list(sessionId?: Identifier): Session[] {
        return super.list(sessionId).map(session => this.effective(session));
    }

    override transition(id: Identifier, state: SessionState, options: TransitionOptions): Session {
        return this.effective(super.transition(id, state, options));
    }

    activate(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "active", options); }
    idle(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "idle", options); }
    suspend(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "suspended", options); }
    resume(id: Identifier, options: TransitionOptions): Session;
    resume(snapshot: SessionSnapshot, options?: SessionResumeOptions): SessionResumeResult;
    resume(idOrSnapshot: Identifier | SessionSnapshot, options?: TransitionOptions | SessionResumeOptions): Session | SessionResumeResult {
        if (typeof idOrSnapshot === "string") {
            if (options === void 0) throw new SessionError("invalid_state", "resume(id) requires transition options");
            return this.transition(idOrSnapshot, "resumed", options as TransitionOptions);
        }
        return this.restore(idOrSnapshot, (options ?? {}) as SessionResumeOptions);
    }
    beginClose(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "closing", options); }
    close(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "closed", options); }
    archive(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "archived", options); }

    /**
     * Captures the session-scoped snapshot consumed by `resume(snapshot)`.
     * `persist` follows §4.2: only persisted attention objects are captured;
     * `budgetBalance` defaults to the session allocation when no ledger value
     * is present (the host owns exact accounting).
     */
    snapshot(id: Identifier, now: string = new Date().toISOString()): SessionSnapshot {
        const session = this.get(id);
        return {
            schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
            sessionId: session.id,
            version: session.version,
            state: session.state,
            sessionType: sessionTypeOf(session),
            participants: [...session.participants],
            ...(session.expiresAt === void 0 ? {} : { expiresAt: session.expiresAt }),
            persist: [...(session.persist ?? [])],
            ...(session.budget === void 0 ? {} : { budget: { ...session.budget } }),
            budgetBalance: { ...(session.budgetBalance ?? session.budget ?? {}) },
            capturedAt: now,
        };
    }

    /** Alias for `snapshot`; a Session snapshot may be captured or named explicitly. */
    capture(id: Identifier, now?: string): SessionSnapshot {
        return this.snapshot(id, now);
    }

    /**
     * Closes a Session while accounting for its Turns (§4.1 "closing 必须处理未完成 Turn").
     * Without `force` an unfinished Turn rejects the close with `active_turns`.
     * With `force` every unfinished Turn is abandoned first (with a reason), then
     * the Session is driven to `closed` through the legal lifecycle path.
     */
    closeWithTurns(sessionId: Identifier, options: CloseWithTurnsOptions = {}): CloseWithTurnsResult {
        const actor = options.actor ?? "host";
        const session = this.get(sessionId);
        if (options.expectedVersion !== void 0 && session.version !== options.expectedVersion) {
            throw new SessionError("version_conflict", `Session ${sessionId} expected version ${options.expectedVersion}, current ${session.version}`);
        }
        if (session.state === "closed" || session.state === "archived") {
            return { session, turns: this.store.list("turn", sessionId), abandoned: [], activeTurns: [], settledIntents: [] };
        }
        if (session.state === "expired" || session.state === "aborted") {
            throw new SessionError("invalid_state", `Session ${sessionId} is ${session.state} and cannot be closed`);
        }

        const activeTurns = this.store.list("turn", sessionId).filter(turn => !isWorkflowTerminal(turn));
        if (activeTurns.length > 0 && options.force !== true) {
            throw new SessionError("active_turns", `Session ${sessionId} has ${activeTurns.length} unfinished turn(s): ${activeTurns.map(turn => turn.id).join(", ")}`);
        }

        const abandoned: Turn[] = [];
        if (activeTurns.length > 0) {
            const reason = options.forceReason ?? options.reason ?? "session closed with force";
            for (const turn of activeTurns) {
                abandoned.push(this.turns.abandon(turn.id, { expectedVersion: turn.version, actor, reason }));
            }
            const remaining = this.store.list("turn", sessionId).filter(turn => !isWorkflowTerminal(turn));
            if (remaining.length > 0) {
                throw new SessionError("active_turns", `Session ${sessionId} still has unfinished turn(s): ${remaining.map(turn => turn.id).join(", ")}`);
            }
        }

        const reason = options.reason ?? options.forceReason;
        const settledIntents = options.force === true
            ? this.settleIntents(sessionId, actor, reason ?? "session closed with force")
            : [];
        let current = this.effective(this.store.get("session", sessionId));
        const transitionOptions = (expectedVersion: number): TransitionOptions => ({
            expectedVersion, actor, ...(reason === void 0 ? {} : { reason }),
        });
        if (current.state === "created") current = this.activate(current.id, transitionOptions(current.version));
        if (current.state !== "closing") current = this.beginClose(current.id, transitionOptions(current.version));
        current = this.close(current.id, transitionOptions(current.version));
        return { session: current, turns: this.store.list("turn", sessionId), abandoned, activeTurns, settledIntents };
    }

    /**
     * Expire every session whose absolute `expiresAt` is at or before the injected `now`.
     * The caller supplies the clock, so this method never reads ambient time and never
     * changes non-expirable sessions or unrelated behaviour.
     */
    expireIfDue(now: string | Date, actor: Identifier = "system"): readonly Session[] {
        const at = typeof now === "string" ? now : now.toISOString();
        if (!Number.isFinite(Date.parse(at))) throw new WorkflowError("guard_rejected", "expireIfDue requires a valid timestamp");
        return this.store.list("session")
            .filter(session => {
                if (session.expiresAt === void 0 || !Number.isFinite(Date.parse(session.expiresAt))) return false;
                if (Date.parse(session.expiresAt) > Date.parse(at)) return false;
                return (workflowTransitions.session[session.state] ?? []).includes("expired");
            })
            .map(session => this.transition(session.id, "expired", {
                expectedVersion: session.version, actor, reason: `expired at ${at}`,
            }));
    }

    private effective(session: Session): Session {
        const overlay = overlayMap(this.store).get(session.id);
        if (overlay === void 0) return session;
        return {
            ...session,
            sessionType: overlay.sessionType,
            ...(overlay.participants === void 0 ? {} : { participants: [...overlay.participants] }),
            ...(overlay.expiresAt === void 0 ? {} : { expiresAt: overlay.expiresAt }),
            persist: [...overlay.persist],
            ...(overlay.budget === void 0 ? {} : { budget: { ...overlay.budget } }),
            budgetBalance: { ...overlay.budgetBalance },
        };
    }

    private restore(input: SessionSnapshot, options: SessionResumeOptions): SessionResumeResult {
        const { snapshot, digest } = validateSnapshot(input, options);
        const now = options.now ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(now))) throw new SessionError("invalid_snapshot", "Resume requires a valid timestamp");

        const map = overlayMap(this.store);
        const replay = map.get(snapshot.sessionId);
        if (replay !== void 0 && replay.lastResumeDigest === digest) {
            const live = this.store.find("session", snapshot.sessionId);
            if (live.isPresent()) {
                return {
                    session: this.effective(live.get()),
                    persist: [...replay.persist],
                    skippedPersist: [],
                    budgetBalance: { ...replay.budgetBalance },
                    resumedAt: replay.lastResumedAt,
                    resumed: false,
                    idempotent: true,
                    resumeCount: replay.resumeCount,
                    snapshotDigest: digest,
                };
            }
        }

        const existing = this.store.find("session", snapshot.sessionId);
        const created = existing.isEmpty();
        const actor = options.actor ?? "host";
        if (options.expectedVersion !== void 0) {
            const version = existing.map(session => session.version).orElse(snapshot.version);
            if (version !== options.expectedVersion) {
                throw new SessionError("version_conflict", `Session ${snapshot.sessionId} expected version ${options.expectedVersion}, current ${existing.map(session => session.version).orElse(-1)}`);
            }
        }
        if (created) {
            const paths = SESSION_RESTORE_PATHS[snapshot.state] ?? [];
            if (!paths.some(path => path.length === snapshot.version)) {
                throw new SessionError("invalid_snapshot", `Session snapshot version ${snapshot.version} cannot reproduce state ${snapshot.state} in an empty store`);
            }
        }

        const persist = this.validatePersist(snapshot.persist ?? [], snapshot.sessionId, now, created);
        let current = created ? this.restoreIntoEmptyStore(snapshot, actor) : existing.get();
        const versionMatches = current.version === snapshot.version;
        const completesResume = current.state === "resumed" && snapshot.state === "suspended" && current.version === snapshot.version + 1;
        if (!versionMatches && !completesResume) {
            throw new SessionError("version_conflict", `Session ${snapshot.sessionId} expected version ${snapshot.version}, current ${current.version}`);
        }
        if (current.state === "suspended" && snapshot.state !== "suspended") {
            throw new SessionError("invalid_state", `Snapshot state ${snapshot.state} cannot resume a suspended Session`);
        }
        if (current.state === "resumed" && snapshot.state !== "resumed" && !completesResume) {
            throw new SessionError("invalid_state", `Snapshot state ${snapshot.state} cannot resume a resumed Session`);
        }
        if ((current.state === "active" || current.state === "idle" || current.state === "created") && snapshot.state !== current.state) {
            throw new SessionError("invalid_state", `Snapshot state ${snapshot.state} cannot overlay a ${current.state} Session`);
        }
        if (!["suspended", "resumed", "active", "idle", "created"].includes(current.state)) {
            throw new SessionError("invalid_state", `Session ${current.id} is ${current.state} and cannot be resumed`);
        }

        let lifecycleChanged = false;
        if (current.state === "suspended") {
            current = this.transition(current.id, "resumed", {
                expectedVersion: current.version, actor, reason: `resume from snapshot ${digest}`,
            });
            current = this.transition(current.id, "active", {
                expectedVersion: current.version, actor, reason: `resume from snapshot ${digest}`,
            });
            lifecycleChanged = true;
        } else if (current.state === "resumed") {
            current = this.transition(current.id, "active", {
                expectedVersion: current.version, actor, reason: `resume from snapshot ${digest}`,
            });
            lifecycleChanged = true;
        }

        const previous = map.get(snapshot.sessionId);
        const overlay: SessionOverlay = {
            sessionType: snapshot.sessionType,
            ...(snapshot.participants === void 0 ? {} : { participants: [...snapshot.participants] }),
            ...(snapshot.expiresAt === void 0 ? {} : { expiresAt: snapshot.expiresAt }),
            persist: persist.restored,
            ...(snapshot.budget === void 0
                ? (previous?.budget === void 0 ? {} : { budget: { ...previous.budget } })
                : { budget: { ...snapshot.budget } }),
            budgetBalance: { ...snapshot.budgetBalance },
            lastResumeDigest: digest,
            resumeCount: (previous?.resumeCount ?? 0) + 1,
            lastResumedAt: now,
        };
        map.set(snapshot.sessionId, overlay);
        return {
            session: this.effective(this.store.get("session", snapshot.sessionId)),
            persist: [...persist.restored],
            skippedPersist: persist.skipped,
            budgetBalance: { ...snapshot.budgetBalance },
            resumedAt: now,
            resumed: lifecycleChanged || created || !versionMatches,
            idempotent: false,
            resumeCount: overlay.resumeCount,
            snapshotDigest: digest,
        };
    }

    private restoreIntoEmptyStore(snapshot: SessionSnapshot, actor: Identifier): Session {
        const created = this.create({
            id: snapshot.sessionId,
            sessionId: snapshot.sessionId,
            participants: [...(snapshot.participants ?? [])],
            sessionType: snapshot.sessionType,
            ...(snapshot.expiresAt === void 0 ? {} : { expiresAt: snapshot.expiresAt }),
            ...(snapshot.budget === void 0 ? {} : { budget: { ...snapshot.budget } }),
            budgetBalance: { ...snapshot.budgetBalance },
            persist: [...(snapshot.persist ?? [])],
        }, actor);
        const paths = SESSION_RESTORE_PATHS[snapshot.state] ?? [];
        const path = paths.find(candidate => candidate.length === snapshot.version);
        if (path === void 0) {
            throw new SessionError("invalid_snapshot", `Session snapshot version ${snapshot.version} cannot reproduce state ${snapshot.state} in an empty store`);
        }
        let current = created;
        for (const next of path) {
            current = super.transition(current.id, next, {
                expectedVersion: current.version, actor, reason: "session snapshot restore",
            });
        }
        return current;
    }

    /** A forced close also settles Intents that a Turn captured but did not resolve. */
    private settleIntents(sessionId: Identifier, actor: Identifier, reason: string): Identifier[] {
        const settled: Identifier[] = [];
        for (const intent of this.store.list("intent", sessionId)) {
            if (isWorkflowSettled(intent)) continue;
            const edges = workflowTransitions.intent[intent.state] ?? [];
            if (!edges.includes("abandoned")) continue;
            this.intents.transition(intent.id, "abandoned", { expectedVersion: intent.version, actor, reason });
            settled.push(intent.id);
        }
        return settled;
    }

    private validatePersist(
        references: readonly SessionPersistReference[],
        sessionId: Identifier,
        now: string,
        created: boolean,
    ): { restored: readonly SessionPersistReference[]; skipped: readonly SessionPersistSkip[] } {
        const restored: SessionPersistReference[] = [];
        const skipped: SessionPersistSkip[] = [];
        for (const reference of references) {
            if (reference.expiresAt !== void 0 && Date.parse(reference.expiresAt) <= Date.parse(now)) {
                skipped.push({ reference, reason: "expired" });
                continue;
            }
            if (!(WORKFLOW_SESSION_PERSIST_KINDS as readonly string[]).includes(reference.kind)) {
                // Host-owned attention/cooperation/file references keep their pointer.
                restored.push(reference);
                continue;
            }
            const entity = this.store.find(reference.kind as WorkflowSessionPersistKind, reference.id);
            if (entity.isEmpty()) {
                if (created) {
                    skipped.push({ reference, reason: "unresolved" });
                    continue;
                }
                throw new SessionError("invalid_snapshot", `Persist reference ${reference.kind}:${reference.id} does not exist in this store`);
            }
            if (entity.get().sessionId !== sessionId) {
                throw new SessionError("scope_mismatch", `Persist reference ${reference.kind}:${reference.id} belongs to another Session`);
            }
            restored.push(reference);
        }
        return { restored, skipped };
    }
}
