import type { Budget, Identifier } from "../shared.ts";
import type { VersionedEntity, WorkflowKind } from "../workflow/types.ts";

/** Session lifecycle states from refract §4.1. */
export const SESSION_STATES = [
    "created", "active", "idle", "suspended", "resumed", "closing", "closed", "archived", "expired", "aborted",
] as const;
export type SessionState = typeof SESSION_STATES[number];

/** Session types from refract §4.1. `user_interactive` is the default. */
export const SESSION_TYPES = ["user_interactive", "autonomous", "scheduled", "delegated"] as const;
export type SessionType = typeof SESSION_TYPES[number];
export const DEFAULT_SESSION_TYPE: SessionType = "user_interactive";

/**
 * Objects that may be referenced by a Session's persist set. Workflow kinds are
 * checked against the session scope and liveness; host-owned kinds (`attention`,
 * `cooperation`, `file`) are accepted by reference because their ledgers live
 * outside the workflow writer.
 */
export const SESSION_PERSIST_KINDS = [
    "intent", "mission", "goal", "plan", "task", "action", "attention", "cooperation", "file",
] as const;
export type SessionPersistKind = typeof SESSION_PERSIST_KINDS[number];
/** Persist kinds whose referents are workflow entities and can be scope-checked. */
export type WorkflowSessionPersistKind = Extract<SessionPersistKind, WorkflowKind>;
export const WORKFLOW_SESSION_PERSIST_KINDS = [
    "intent", "mission", "goal", "plan", "task", "action",
] as const satisfies readonly WorkflowSessionPersistKind[];

/** A single persisted object reference that survives a suspend/resume cycle (§4.1). */
export interface SessionPersistReference {
    readonly kind: SessionPersistKind;
    readonly id: Identifier;
    /** Why this object is persisted; `persist` must carry a reason (§11.8). */
    readonly reason: string;
    /** Absolute expiry. An expired reference is not restored (§4.1 "stale 不恢复"). */
    readonly expiresAt?: string;
}

export interface Session extends VersionedEntity<"session", SessionState> {
    readonly participants: readonly Identifier[];
    /** Optional for backward compatibility; an omitted value reads as `user_interactive`. */
    readonly sessionType?: SessionType;
    /** Absolute expiry instant. `SessionService.expireIfDue(now)` moves due sessions to `expired`. */
    readonly expiresAt?: string;
    /** Persisted attention references restored with the Session (§4.1). */
    readonly persist?: readonly SessionPersistReference[];
    /** Remaining budget balance; restored exactly on resume (§4.1 recovery principle). */
    readonly budgetBalance?: Budget;
}

export const sessionTypeOf = (session: Session): SessionType => session.sessionType ?? DEFAULT_SESSION_TYPE;

export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Session-scoped recovery snapshot (refract §4.1 "Session 状态恢复").
 *
 * The snapshot is deliberately independent of `WorkflowSnapshot`: the workflow
 * kernel owns entity/event integrity, while this snapshot carries the fields a
 * resumed Session must re-present to the attention scheduler (type, expiry,
 * persist set and budget balance) plus the lifecycle position it was taken at.
 */
export interface SessionSnapshot {
    readonly schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
    /** Identity and scope of the snapshot; `sessionId` is the only accepted scope. */
    readonly sessionId: Identifier;
    /** Entity version at capture time. Used for optimistic restore checks. */
    readonly version: number;
    /** Lifecycle state at capture time; resume restores the active position. */
    readonly state: SessionState;
    readonly sessionType: SessionType;
    /** Optional; when omitted the live Session participants are kept. */
    readonly participants?: readonly Identifier[];
    readonly expiresAt?: string;
    /** Only persist objects are restored; stale/expired references are skipped. */
    readonly persist?: readonly SessionPersistReference[];
    /** Session budget allocation, when known. */
    readonly budget?: Budget;
    /** Remaining budget balance, restored exactly. */
    readonly budgetBalance: Budget;
    readonly capturedAt?: string;
}

/** Stable failure codes for the session recovery surface. */
export type SessionErrorCode =
    | "invalid_snapshot"
    | "scope_mismatch"
    | "version_conflict"
    | "active_turns"
    | "invalid_state"
    | "not_found";

export class SessionError extends Error {
    readonly code: SessionErrorCode;
    constructor(code: SessionErrorCode, message: string) {
        super(message);
        this.name = "SessionError";
        this.code = code;
    }
}
