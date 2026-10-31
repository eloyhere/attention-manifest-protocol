/**
 * Session domain types.
 *
 * A session is the authority boundary for one agent's workspace work: it binds
 * an agent identity to a set of real, host-approved roots, a permission set,
 * a TTL and a private JSON context. Nothing in this module is model-authored:
 * the host opens sessions and hands the resulting credential to the transport,
 * which binds every tool call to exactly one session.
 *
 * Sessions are deliberately separate from `runtime/session.ts`. That session is
 * the cognitive memory of a turn loop; this one is a data-isolation and identity
 * record. Sharing a word is cheaper than pretending the two lifecycles match.
 */

/**
 * Opaque session key. Kept as a branded string so a path, an agent id or a
 * random token can never be passed where a session id is expected.
 */
export type SessionId = string;

/**
 * Stable host-assigned agent identity. It is not a model name and not a token.
 */
export type AgentId = string;

/**
 * Closed session lifecycle. `expired` and `revoked` are terminal for reads;
 * a host may audit them, but no adapter may silently revive one.
 */
export type SessionStatus = "active" | "suspended" | "revoked" | "expired";

/**
 * Operations a session can be granted. `execute` is intentionally absent:
 * this layer reads and writes files, it does not spawn processes.
 */
export type SessionOperation = "read" | "write" | "create" | "remove" | "list";

/**
 * JSON value accepted by the session context store. The store rejects values
 * that cannot round-trip through canonical JSON (functions, symbols, bigint,
 * cyclic objects) instead of silently coercing them.
 */
export type SessionJson = null | boolean | number | string | SessionJson[] | { [key: string]: SessionJson };

/**
 * Coarse permission set plus per-session quotas. The limits are repeated here
 * rather than read from a global configuration so two sessions in one process
 * cannot widen each other's budget.
 */
export interface SessionPermissions {
    readonly read: boolean;
    readonly write: boolean;
    readonly create: boolean;
    readonly remove: boolean;
    readonly maxReadBytes: number;
    readonly maxWriteBytes: number;
    readonly maxTreeNodes: number;
    readonly maxContextEntries: number;
    readonly maxContextBytes: number;
}

/**
 * One host-approved directory. `path` must be absolute and is resolved through
 * `realpath` when the session is opened; `id` is the stable key tools use so a
 * response never has to echo a host path the model should not depend on.
 */
export interface SessionRoot {
    readonly id: string;
    readonly path: string;
    readonly writable: boolean;
    readonly exclude: readonly string[];
}

/**
 * Public session record. It never contains the bearer secret; authentication
 * state lives only as a hash inside the registry and the persistence adapter.
 */
export interface SessionDescriptor {
    readonly id: SessionId;
    readonly agentId: AgentId;
    readonly label: string;
    readonly status: SessionStatus;
    readonly roots: readonly SessionRoot[];
    readonly permissions: SessionPermissions;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly idleExpiresAt: string;
    readonly revision: number;
    readonly parentId?: SessionId;
    readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Host input for opening a session. Every field except the agent identity is
 * optional and defaults are deliberately conservative.
 */
export interface SessionOpenInput {
    readonly agentId: AgentId;
    readonly label?: string;
    readonly roots: readonly SessionRoot[];
    readonly permissions?: Partial<SessionPermissions>;
    readonly ttlMs?: number;
    readonly idleTtlMs?: number;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly parentId?: SessionId;
}

/**
 * One-time credential returned by `open`/`fork`/`rotate`. The raw token is
 * shown exactly once; only its hash is persisted.
 */
export interface SessionCredential {
    readonly sessionId: SessionId;
    readonly token: string;
}

/**
 * Result of a successful authentication. Callers keep the descriptor and never
 * the token hash; the hash is exposed for audit adapters only.
 */
export interface SessionAuthentication {
    readonly descriptor: SessionDescriptor;
    readonly tokenHash: string;
}

/**
 * One namespaced context entry. `bytes` is the canonical UTF-8 size used for
 * quota accounting, not `String.length`.
 */
export interface SessionContextEntry {
    readonly namespace: string;
    readonly key: string;
    readonly value: SessionJson;
    readonly bytes: number;
    readonly updatedAt: string;
}

/**
 * Immutable view of a session's context. `bytes` is the sum of entry sizes.
 */
export interface SessionContextSnapshot {
    readonly sessionId: SessionId;
    readonly entries: readonly SessionContextEntry[];
    readonly bytes: number;
}

/**
 * Fork input. A fork gets a fresh id, secret and revision; it shares no mutable
 * object with its parent, so a write in one cannot be observed by the other.
 */
export interface SessionForkInput {
    readonly label?: string;
    readonly ttlMs?: number;
    readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Persistence port for descriptors. Adapters may be in-memory, JSON or SQLite;
 * the registry never knows which. Context persistence is a separate port
 * because some hosts persist session identity but never persist workspace data.
 */
export interface SessionStore {
    load(sessionId: SessionId): SessionDescriptor | undefined;
    /**
     * Token hash needed to restore authentication after a restart. A store that
     * chooses not to persist secrets returns `undefined`, which makes restored
     * sessions host-only until the host rotates the token.
     */
    loadSecret(sessionId: SessionId): string | undefined;
    save(descriptor: SessionDescriptor, tokenHash: string): void;
    delete(sessionId: SessionId): boolean;
    list(agentId?: AgentId): SessionDescriptor[];
}

/**
 * Persistence port for context entries. `replace` is atomic per session so a
 * crash cannot leave half a context visible to the next process.
 */
export interface SessionContextStore {
    load(sessionId: SessionId): SessionContextEntry[];
    put(sessionId: SessionId, entry: SessionContextEntry): void;
    delete(sessionId: SessionId, namespace: string, key: string): boolean;
    deleteSession(sessionId: SessionId): void;
    replace(sessionId: SessionId, entries: readonly SessionContextEntry[]): void;
}

/**
 * Clock injection point. Tests use it to exercise TTL/expiry paths without
 * sleeping; production uses `Date.now`.
 */
export interface SessionClock {
    now(): Date;
}

/**
 * Registry limits. A host cannot raise them after construction, which keeps a
 * compromised caller from turning many small sessions into unbounded memory.
 */
export interface SessionRegistryLimits {
    readonly maxSessions: number;
    readonly maxRootsPerSession: number;
    readonly maxContextEntries: number;
    readonly maxContextBytes: number;
    readonly maxTokenRotations: number;
}

/**
 * Normalized defaults for opening a session when the host omits a field.
 */
export interface SessionDefaults {
    readonly ttlMs: number;
    readonly idleTtlMs: number;
    readonly label: string;
}

/**
 * Options for the registry. `store` and `contextStore` are optional so the
 * module is useful in memory-only tests; a SQLite host supplies both adapters.
 */
export interface SessionRegistryOptions {
    readonly limits?: Partial<SessionRegistryLimits>;
    readonly defaults?: Partial<SessionDefaults>;
    readonly store?: SessionStore;
    readonly contextStore?: SessionContextStore;
    readonly clock?: SessionClock;
}

/**
 * Error codes are part of the adapter contract: a transport can map a failure
 * to a stable code without parsing English prose.
 */
export type SessionErrorCode =
    | "invalid_arguments"
    | "invalid_identity"
    | "session_not_found"
    | "session_expired"
    | "session_revoked"
    | "session_suspended"
    | "session_forbidden"
    | "session_capacity"
    | "context_quota"
    | "context_conflict"
    | "store_failure";

/**
 * Host-side session summary used by diagnostics and the `session` tool.
 */
export interface SessionSummary {
    readonly id: SessionId;
    readonly agentId: AgentId;
    readonly label: string;
    readonly status: SessionStatus;
    readonly roots: readonly Pick<SessionRoot, "id" | "writable">[];
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly remainingMs: number;
    readonly revision: number;
}
