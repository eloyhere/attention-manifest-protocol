/**
 * Session registry: identity, lifecycle, capacity and isolated context.
 *
 * A session binds a host-approved agent identity to real root directories, a
 * permission set, a TTL and a private context. The registry is the authority
 * boundary for that record: it mints the one-time credential, verifies it in
 * constant time, serialises every lifecycle transition and persists only the
 * token hash. It never shares mutable state with `runtime/session.ts`, which is
 * the cognitive memory of a turn loop rather than a data-isolation record.
 *
 * All methods are synchronous. That is deliberate: the registry is single
 * threaded, and an async API would invite an `await` between the status check
 * and the state update that lets two callers observe different lifetimes.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { SessionContexts } from "./context.ts";
import { fail } from "./errors.ts";
import { createSessionId, createSessionToken, hashSessionToken, verifySessionToken } from "./identity.ts";
import type {
    AgentId,
    SessionAuthentication,
    SessionClock,
    SessionCredential,
    SessionDefaults,
    SessionDescriptor,
    SessionForkInput,
    SessionId,
    SessionOpenInput,
    SessionPermissions,
    SessionRegistryLimits,
    SessionRegistryOptions,
    SessionRoot,
    SessionStore,
    SessionSummary,
} from "./types.ts";

const DefaultLimits: SessionRegistryLimits = {
    maxSessions: 256,
    maxRootsPerSession: 16,
    maxContextEntries: 256,
    maxContextBytes: 1024 * 1024,
    maxTokenRotations: 8,
};

const DefaultDefaults: SessionDefaults = {
    ttlMs: 8 * 60 * 60 * 1000,
    idleTtlMs: 30 * 60 * 1000,
    label: "session",
};

const DefaultPermissions: SessionPermissions = {
    read: true,
    write: false,
    create: false,
    remove: false,
    maxReadBytes: 8 * 1024 * 1024,
    maxWriteBytes: 4 * 1024 * 1024,
    maxTreeNodes: 20000,
    maxContextEntries: 256,
    maxContextBytes: 1024 * 1024,
};

const ControlCharacters: RegExp = /[\u0000-\u001f\u007f-\u009f]/;
const SystemClock: SessionClock = { now: (): Date => new Date() };

type SessionRecord = {
    descriptor: SessionDescriptor;
    tokenHash: string | undefined;
    rotations: number;
    idleTtlMs: number;
};

type OpenedSession = {
    descriptor: SessionDescriptor;
    credential: SessionCredential;
};

type PermissionResolution = {
    input?: Partial<SessionPermissions>;
    limits: SessionRegistryLimits;
};

/**
 * Optional `SessionStore` extension for the token-rotation counter. The base
 * port has no rotation column, so an adapter that wants the cap to survive a
 * restart implements these two methods; adapters that do not keep the counter
 * in memory only.
 */
export interface SessionRotationStore {
    loadRotations(sessionId: SessionId): number | undefined;
    saveRotations(sessionId: SessionId, rotations: number): void;
}

type RotationStoreCandidate = SessionStore & Partial<SessionRotationStore>;

type RotationSave = {
    store: SessionStore;
    sessionId: SessionId;
    rotations: number;
};

const clone: <T>(value: T) => T = <T>(value: T): T => structuredClone(value);

/**
 * Reject lone surrogates before a value reaches a store that binds UTF-8:
 * `JSON.stringify` can escape them, but a SQLite/JSON column cannot preserve
 * them, so a restored record would no longer name the same agent or root.
 */
const isWellFormed: (value: string) => boolean = (value: string): boolean => {
    for (let index: number = 0; index < value.length; index += 1) {
        const unit: number = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next: number = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (next < 0xdc00 || next > 0xdfff) {
                return false;
            }
            index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return false;
        }
    }
    return true;
};

/**
 * Identifiers, labels and metadata are host text: non-blank, no control
 * characters and well-formed Unicode. There is deliberately no length ceiling
 * here; the explicit 128-code-unit ceiling belongs to context namespaces/keys.
 */
const textIsValid: (value: unknown) => value is string = (value: unknown): value is string =>
    typeof(value) === "string" && value.trim().length > 0 && !ControlCharacters.test(value) && isWellFormed(value);

const requireText: (value: unknown) => string = (value: unknown): string => (textIsValid(value) ? value : fail("invalid_arguments"));

/**
 * A blank label is a host convenience, not an invalid session: it falls back to
 * the configured default. Other bad types still fail loudly.
 */
const resolveLabel: (value: string | undefined, fallback: string) => string = (value: string | undefined, fallback: string): string => {
    if (value === (void 0)) {
        return fallback;
    }
    if (typeof(value) === "string" && value.trim().length === 0) {
        return fallback;
    }
    return requireText(value);
};

const loadRotationCount: (store: SessionStore, sessionId: SessionId) => number = (store: SessionStore, sessionId: SessionId): number => {
    const candidate: RotationStoreCandidate = store;
    if (typeof(candidate.loadRotations) !== "function") {
        return 0;
    }
    let rotations: number | undefined;
    try {
        rotations = candidate.loadRotations(sessionId);
    } catch {
        return fail("store_failure");
    }
    if (rotations === (void 0)) {
        return 0;
    }
    if (!Number.isSafeInteger(rotations) || rotations < 0) {
        return fail("store_failure");
    }
    return rotations;
};

const persistRotationCount: (request: RotationSave) => void = (request: RotationSave): void => {
    const candidate: RotationStoreCandidate = request.store;
    if (typeof(candidate.saveRotations) !== "function") {
        return;
    }
    try {
        candidate.saveRotations(request.sessionId, request.rotations);
    } catch {
        fail("store_failure");
    }
};

/**
 * Best-effort rollback for a rotation whose descriptor save failed. The
 * original failure is more useful than a rollback failure, so this never
 * throws.
 */
const restoreRotationCount: (request: RotationSave) => void = (request: RotationSave): void => {
    try {
        persistRotationCount(request);
    } catch {
        return;
    }
};

const requirePositive: (value: number | undefined, fallback: number) => number = (value: number | undefined, fallback: number): number => {
    if (value === (void 0)) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return value;
};

const requireNonNegative: (value: number | undefined, fallback: number) => number = (value: number | undefined, fallback: number): number => {
    if (value === (void 0)) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        return fail("invalid_arguments");
    }
    return value;
};

const requireFlag: (value: boolean | undefined, fallback: boolean) => boolean = (value: boolean | undefined, fallback: boolean): boolean => {
    if (value === (void 0)) {
        return fallback;
    }
    if (typeof(value) !== "boolean") {
        return fail("invalid_arguments");
    }
    return value;
};

const parseTime: (value: string) => number | undefined = (value: string): number | undefined => {
    const parsed: number = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : (void 0);
};

const MaxDateMs: number = 8_640_000_000_000_000;

/**
 * Convert epoch milliseconds to an ISO timestamp. A duration large enough to
 * leave the `Date` range is an argument error, not a `RangeError` that escapes
 * the closed error taxonomy.
 */
const isoAt: (milliseconds: number) => string = (milliseconds: number): string => {
    if (!Number.isFinite(milliseconds) || milliseconds < -MaxDateMs || milliseconds > MaxDateMs) {
        return fail("invalid_arguments");
    }
    return new Date(milliseconds).toISOString();
};

const isDue: (descriptor: SessionDescriptor, nowMs: number) => boolean = (descriptor: SessionDescriptor, nowMs: number): boolean => {
    const expires: number | undefined = parseTime(descriptor.expiresAt);
    if (expires === (void 0) || nowMs >= expires) {
        return true;
    }
    const idle: number | undefined = parseTime(descriptor.idleExpiresAt);
    return idle === (void 0) || nowMs >= idle;
};

const normalizeExclude: (input: readonly string[] | undefined) => readonly string[] = (input: readonly string[] | undefined): readonly string[] => {
    if (input === (void 0)) {
        return [];
    }
    if (!Array.isArray(input)) {
        return fail("invalid_arguments");
    }
    const seen: Set<string> = new Set<string>();
    const excludes: string[] = [];
    for (let index: number = 0; index < input.length; index += 1) {
        const entry: string = input[index];
        if (typeof(entry) !== "string" || ControlCharacters.test(entry) || !isWellFormed(entry)) {
            return fail("invalid_arguments");
        }
        const normalized: string = entry
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\.?\//, "")
            .replace(/^\/+/, "")
            .replace(/\/+$/, "");
        if (normalized.length === 0 || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        excludes.push(normalized);
    }
    return excludes;
};

const pathIdentity: (value: string) => string = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

const normalizeMetadata: (input: Readonly<Record<string, string>> | undefined) => Readonly<Record<string, string>> = (
    input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> => {
    if (input === (void 0)) {
        return {};
    }
    if (input === null || typeof(input) !== "object" || Array.isArray(input)) {
        return fail("invalid_arguments");
    }
    const source: Record<string, unknown> = input as Record<string, unknown>;
    const keys: string[] = Object.keys(source);
    const metadata: Record<string, string> = {};
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: string = keys[index];
        const value: unknown = source[key];
        if (key.length === 0 || ControlCharacters.test(key) || !isWellFormed(key) || typeof(value) !== "string" || !isWellFormed(value)) {
            return fail("invalid_arguments");
        }
        metadata[key] = value;
    }
    return metadata;
};

const resolvePermissions: (options: PermissionResolution) => SessionPermissions = (options: PermissionResolution): SessionPermissions => {
    const source: Partial<SessionPermissions> = options.input ?? {};
    return {
        read: requireFlag(source.read, DefaultPermissions.read),
        write: requireFlag(source.write, DefaultPermissions.write),
        create: requireFlag(source.create, DefaultPermissions.create),
        remove: requireFlag(source.remove, DefaultPermissions.remove),
        maxReadBytes: requirePositive(source.maxReadBytes, DefaultPermissions.maxReadBytes),
        maxWriteBytes: requirePositive(source.maxWriteBytes, DefaultPermissions.maxWriteBytes),
        maxTreeNodes: requirePositive(source.maxTreeNodes, DefaultPermissions.maxTreeNodes),
        maxContextEntries: Math.min(requirePositive(source.maxContextEntries, DefaultPermissions.maxContextEntries), options.limits.maxContextEntries),
        maxContextBytes: Math.min(requirePositive(source.maxContextBytes, DefaultPermissions.maxContextBytes), options.limits.maxContextBytes),
    };
};

export class SessionRegistry {
    readonly context: SessionContexts;
    private readonly limits: SessionRegistryLimits;
    private readonly defaults: SessionDefaults;
    private readonly store?: SessionStore;
    private readonly clock: SessionClock;
    private readonly records: Map<SessionId, SessionRecord> = new Map<SessionId, SessionRecord>();

    constructor(options: SessionRegistryOptions = {}) {
        this.limits = {
            maxSessions: requirePositive(options.limits?.maxSessions, DefaultLimits.maxSessions),
            maxRootsPerSession: requirePositive(options.limits?.maxRootsPerSession, DefaultLimits.maxRootsPerSession),
            maxContextEntries: requirePositive(options.limits?.maxContextEntries, DefaultLimits.maxContextEntries),
            maxContextBytes: requirePositive(options.limits?.maxContextBytes, DefaultLimits.maxContextBytes),
            maxTokenRotations: requireNonNegative(options.limits?.maxTokenRotations, DefaultLimits.maxTokenRotations),
        };
        this.defaults = {
            ttlMs: requirePositive(options.defaults?.ttlMs, DefaultDefaults.ttlMs),
            idleTtlMs: requirePositive(options.defaults?.idleTtlMs, DefaultDefaults.idleTtlMs),
            label: options.defaults?.label === (void 0) ? DefaultDefaults.label : requireText(options.defaults.label),
        };
        this.store = options.store;
        this.clock = options.clock ?? SystemClock;
        this.context = new SessionContexts({
            persistence: options.contextStore,
            clock: this.clock,
            limits: { maxContextEntries: this.limits.maxContextEntries, maxContextBytes: this.limits.maxContextBytes },
        });
        this.restore();
    }

    /**
     * Open a new session. Roots are resolved through `realpathSync` once, at
     * this boundary, so replacing a parent directory later cannot move an
     * already-authorized root. The raw token is returned exactly once.
     */
    open(input: SessionOpenInput): OpenedSession {
        if (input === null || typeof(input) !== "object") {
            return fail("invalid_arguments");
        }
        const agentId: AgentId = requireText(input.agentId);
        const roots: readonly SessionRoot[] = this.normalizeRoots(input.roots);
        const permissions: SessionPermissions = resolvePermissions({ input: input.permissions, limits: this.limits });
        const label: string = resolveLabel(input.label, this.defaults.label);
        const ttlMs: number = requirePositive(input.ttlMs, this.defaults.ttlMs);
        const idleTtlMs: number = requirePositive(input.idleTtlMs, this.defaults.idleTtlMs);
        const metadata: Readonly<Record<string, string>> = normalizeMetadata(input.metadata);
        const parentId: SessionId | undefined = input.parentId === (void 0) ? (void 0) : requireText(input.parentId);
        this.assertCapacity();
        const now: Date = this.clock.now();
        const nowMs: number = now.getTime();
        const expiresAt: string = isoAt(nowMs + ttlMs);
        const idleExpiresAt: string = isoAt(Math.min(nowMs + idleTtlMs, nowMs + ttlMs));
        const sessionId: SessionId = createSessionId();
        const token: string = createSessionToken();
        const tokenHash: string = hashSessionToken(token);
        const descriptor: SessionDescriptor = {
            id: sessionId,
            agentId,
            label,
            status: "active",
            roots,
            permissions,
            createdAt: now.toISOString(),
            expiresAt,
            idleExpiresAt,
            revision: 0,
            ...(parentId === (void 0) ? {} : { parentId }),
            metadata,
        };
        this.persist(descriptor, tokenHash);
        this.records.set(sessionId, { descriptor: clone(descriptor), tokenHash, rotations: 0, idleTtlMs });
        return { descriptor: clone(descriptor), credential: { sessionId, token } };
    }

    /**
     * Verify a bearer token and refresh the idle deadline. The absolute deadline
     * is never extended; a successful call advances `revision` and is persisted.
     */
    authenticate(sessionId: SessionId, token: string): SessionAuthentication {
        const record: SessionRecord = this.require(sessionId);
        const now: Date = this.clock.now();
        const nowMs: number = now.getTime();
        if (record.descriptor.status === "revoked") {
            return fail("session_revoked");
        }
        if (record.descriptor.status === "expired") {
            return fail("session_expired");
        }
        if (isDue(record.descriptor, nowMs)) {
            this.markExpired(record);
            return fail("session_expired");
        }
        if (record.descriptor.status === "suspended") {
            return fail("session_suspended");
        }
        const storedHash: string | undefined = record.tokenHash;
        if (storedHash === (void 0) || !verifySessionToken(token, storedHash)) {
            return fail("invalid_identity");
        }
        const expiresMs: number | undefined = parseTime(record.descriptor.expiresAt);
        const idleMs: number = expiresMs === (void 0) ? nowMs : Math.min(nowMs + record.idleTtlMs, expiresMs);
        record.descriptor = {
            ...record.descriptor,
            idleExpiresAt: isoAt(idleMs),
            revision: record.descriptor.revision + 1,
        };
        this.saveRecord(record);
        return { descriptor: clone(record.descriptor), tokenHash: storedHash };
    }

    /**
     * Host-side descriptor lookup. It is safe to call for an expired or revoked
     * session: the terminal status is returned for audit rather than revived.
     * `authenticate` is the operation that refuses terminal sessions.
     */
    get(sessionId: SessionId): SessionDescriptor {
        const record: SessionRecord = this.require(sessionId);
        this.expireIfDue(record, this.clock.now().getTime());
        return clone(record.descriptor);
    }

    /**
     * List descriptors, optionally filtered to one agent. Terminal records are
     * included; a host that needs only live sessions filters on `status`.
     */
    list(agentId?: AgentId): SessionDescriptor[] {
        const records: SessionRecord[] = [...this.records.values()];
        const descriptors: SessionDescriptor[] = [];
        for (let index: number = 0; index < records.length; index += 1) {
            const descriptor: SessionDescriptor = records[index].descriptor;
            if (agentId !== (void 0) && descriptor.agentId !== agentId) {
                continue;
            }
            descriptors.push(clone(descriptor));
        }
        descriptors.sort((left: SessionDescriptor, right: SessionDescriptor): number => {
            if (left.createdAt === right.createdAt) {
                return 0;
            }
            return left.createdAt < right.createdAt ? -1 : 1;
        });
        return descriptors;
    }

    /**
     * Diagnostics summary for one session. Terminal sessions stay inspectable.
     */
    summary(sessionId: SessionId): SessionSummary {
        const record: SessionRecord = this.require(sessionId);
        const now: Date = this.clock.now();
        this.expireIfDue(record, now.getTime());
        const descriptor: SessionDescriptor = record.descriptor;
        const expiresMs: number | undefined = parseTime(descriptor.expiresAt);
        const live: boolean = descriptor.status === "active" || descriptor.status === "suspended";
        const remainingMs: number = live && expiresMs !== (void 0) ? Math.max(0, expiresMs - now.getTime()) : 0;
        const roots: Pick<SessionRoot, "id" | "writable">[] = descriptor.roots.map((root: SessionRoot): Pick<SessionRoot, "id" | "writable"> => ({
            id: root.id,
            writable: root.writable,
        }));
        return {
            id: descriptor.id,
            agentId: descriptor.agentId,
            label: descriptor.label,
            status: descriptor.status,
            roots,
            createdAt: descriptor.createdAt,
            expiresAt: descriptor.expiresAt,
            remainingMs,
            revision: descriptor.revision,
        };
    }

    /**
     * Refresh the idle deadline for an active session without checking a token.
     * Host-only keepalive; a caller that needs the token path uses
     * `authenticate`.
     */
    touch(sessionId: SessionId): SessionDescriptor {
        const record: SessionRecord = this.require(sessionId);
        const now: Date = this.clock.now();
        this.expireIfDue(record, now.getTime());
        if (record.descriptor.status === "revoked") {
            return fail("session_revoked");
        }
        if (record.descriptor.status === "expired") {
            return fail("session_expired");
        }
        if (record.descriptor.status === "suspended") {
            return fail("session_suspended");
        }
        const expiresMs: number | undefined = parseTime(record.descriptor.expiresAt);
        if (expiresMs === (void 0)) {
            this.markExpired(record);
            return fail("session_expired");
        }
        record.descriptor = {
            ...record.descriptor,
            idleExpiresAt: isoAt(Math.min(now.getTime() + record.idleTtlMs, expiresMs)),
            revision: record.descriptor.revision + 1,
        };
        this.saveRecord(record);
        return clone(record.descriptor);
    }

    /**
     * Suspend an active session. Suspending an already suspended session is
     * idempotent; terminal sessions are never revived.
     */
    suspend(sessionId: SessionId): SessionDescriptor {
        const record: SessionRecord = this.require(sessionId);
        this.expireIfDue(record, this.clock.now().getTime());
        if (record.descriptor.status === "revoked") {
            return fail("session_revoked");
        }
        if (record.descriptor.status === "expired") {
            return fail("session_expired");
        }
        if (record.descriptor.status === "suspended") {
            return clone(record.descriptor);
        }
        record.descriptor = { ...record.descriptor, status: "suspended", revision: record.descriptor.revision + 1 };
        this.saveRecord(record);
        return clone(record.descriptor);
    }

    /**
     * Resume a suspended session. Only the absolute deadline blocks a resume;
     * the idle deadline is refreshed by this call, so a host that explicitly
     * reactivates a session does not have to race the idle timer.
     */
    resume(sessionId: SessionId): SessionDescriptor {
        const record: SessionRecord = this.require(sessionId);
        const now: Date = this.clock.now();
        if (record.descriptor.status === "revoked") {
            return fail("session_revoked");
        }
        if (record.descriptor.status === "expired") {
            return fail("session_expired");
        }
        if (record.descriptor.status !== "suspended") {
            return fail("session_forbidden");
        }
        const expiresMs: number | undefined = parseTime(record.descriptor.expiresAt);
        if (expiresMs === (void 0) || now.getTime() >= expiresMs) {
            this.markExpired(record);
            return fail("session_expired");
        }
        record.descriptor = {
            ...record.descriptor,
            status: "active",
            idleExpiresAt: isoAt(Math.min(now.getTime() + record.idleTtlMs, expiresMs)),
            revision: record.descriptor.revision + 1,
        };
        this.saveRecord(record);
        return clone(record.descriptor);
    }

    /**
     * Revoke a session permanently. The descriptor and context are retained for
     * audit, but the stored secret is replaced with an empty hash, so a restored
     * registry cannot authenticate the old token either. `authenticate` checks
     * `revoked` before the token, which makes the failure unambiguous. A session
     * whose deadline has already passed is reported as `session_expired`; the
     * host uses `close` to remove it.
     */
    revoke(sessionId: SessionId): SessionDescriptor {
        const record: SessionRecord = this.require(sessionId);
        this.expireIfDue(record, this.clock.now().getTime());
        if (record.descriptor.status === "revoked") {
            return clone(record.descriptor);
        }
        if (record.descriptor.status === "expired") {
            return fail("session_expired");
        }
        record.descriptor = { ...record.descriptor, status: "revoked", revision: record.descriptor.revision + 1 };
        record.tokenHash = (void 0);
        this.saveRecord(record);
        return clone(record.descriptor);
    }

    /**
     * Replace the bearer token, invalidating the previous one immediately.
     * Active and suspended sessions may rotate, up to `maxTokenRotations`. When
     * the store implements {@link SessionRotationStore}, the counter is persisted
     * before the descriptor so a restart keeps the same budget.
     */
    rotate(sessionId: SessionId): SessionCredential {
        const record: SessionRecord = this.require(sessionId);
        this.expireIfDue(record, this.clock.now().getTime());
        if (record.descriptor.status === "revoked") {
            return fail("session_revoked");
        }
        if (record.descriptor.status === "expired") {
            return fail("session_expired");
        }
        if (record.rotations >= this.limits.maxTokenRotations) {
            return fail("session_forbidden");
        }
        const previousHash: string | undefined = record.tokenHash;
        const previousRevision: number = record.descriptor.revision;
        const previousRotations: number = record.rotations;
        const token: string = createSessionToken();
        const tokenHash: string = hashSessionToken(token);
        record.tokenHash = tokenHash;
        record.rotations = previousRotations + 1;
        record.descriptor = { ...record.descriptor, revision: record.descriptor.revision + 1 };
        const store: SessionStore | undefined = this.store;
        try {
            if (store !== (void 0)) {
                persistRotationCount({ store, sessionId: record.descriptor.id, rotations: record.rotations });
            }
            this.saveRecord(record);
        } catch (error: unknown) {
            if (store !== (void 0)) {
                restoreRotationCount({ store, sessionId: record.descriptor.id, rotations: previousRotations });
            }
            record.tokenHash = previousHash;
            record.rotations = previousRotations;
            record.descriptor = { ...record.descriptor, revision: previousRevision };
            throw error;
        }
        return { sessionId: record.descriptor.id, token };
    }

    /**
     * Fork an active session. The child copies roots, permissions and context
     * by value, gets a fresh id and token, and cannot outlive the absolute
     * deadline of its parent.
     */
    fork(parentId: SessionId, input: SessionForkInput = {}): OpenedSession {
        const parent: SessionRecord = this.require(parentId);
        const now: Date = this.clock.now();
        this.expireIfDue(parent, now.getTime());
        if (parent.descriptor.status === "revoked") {
            return fail("session_revoked");
        }
        if (parent.descriptor.status === "expired") {
            return fail("session_expired");
        }
        if (parent.descriptor.status !== "active") {
            return fail("session_suspended");
        }
        if (input === null || typeof(input) !== "object") {
            return fail("invalid_arguments");
        }
        const ttlMs: number = requirePositive(input.ttlMs, this.defaults.ttlMs);
        const label: string = resolveLabel(input.label, this.defaults.label);
        const metadata: Readonly<Record<string, string>> = input.metadata === (void 0) ? clone(parent.descriptor.metadata) : normalizeMetadata(input.metadata);
        this.assertCapacity();
        const nowMs: number = now.getTime();
        const parentExpiresMs: number | undefined = parseTime(parent.descriptor.expiresAt);
        const expiresMs: number = parentExpiresMs === (void 0) ? nowMs + ttlMs : Math.min(nowMs + ttlMs, parentExpiresMs);
        if (expiresMs <= nowMs) {
            this.markExpired(parent);
            return fail("session_expired");
        }
        const idleTtlMs: number = parent.idleTtlMs;
        const sessionId: SessionId = createSessionId();
        const token: string = createSessionToken();
        const tokenHash: string = hashSessionToken(token);
        const descriptor: SessionDescriptor = {
            id: sessionId,
            agentId: parent.descriptor.agentId,
            label,
            status: "active",
            roots: clone(parent.descriptor.roots),
            permissions: clone(parent.descriptor.permissions),
            createdAt: now.toISOString(),
            expiresAt: isoAt(expiresMs),
            idleExpiresAt: isoAt(Math.min(nowMs + idleTtlMs, expiresMs)),
            revision: 0,
            parentId: parent.descriptor.id,
            metadata,
        };
        this.context.fork(parent.descriptor.id, sessionId);
        try {
            this.persist(descriptor, tokenHash);
        } catch (error: unknown) {
            this.discardContext(sessionId);
            throw error;
        }
        this.records.set(sessionId, { descriptor: clone(descriptor), tokenHash, rotations: 0, idleTtlMs });
        return { descriptor: clone(descriptor), credential: { sessionId, token } };
    }

    /**
     * Lazily expire every active or suspended session whose absolute or idle
     * deadline has passed. Returns the number of transitions performed.
     */
    sweep(now: Date = this.clock.now()): number {
        const nowMs: number = now.getTime();
        const records: SessionRecord[] = [...this.records.values()];
        let expired: number = 0;
        for (let index: number = 0; index < records.length; index += 1) {
            const record: SessionRecord = records[index];
            if (record.descriptor.status !== "active" && record.descriptor.status !== "suspended") {
                continue;
            }
            if (!isDue(record.descriptor, nowMs)) {
                continue;
            }
            this.markExpired(record);
            expired += 1;
        }
        return expired;
    }

    /**
     * Revoke and forget a session: descriptor index, context and persisted row
     * are removed. `revoke` is the audit-friendly variant that keeps the
     * descriptor; `close` is the end-of-life cleanup.
     */
    close(sessionId: SessionId): void {
        const record: SessionRecord = this.require(sessionId);
        if (record.descriptor.status !== "revoked") {
            record.descriptor = { ...record.descriptor, status: "revoked", revision: record.descriptor.revision + 1 };
            record.tokenHash = (void 0);
            this.saveRecord(record);
        }
        this.context.remove(record.descriptor.id);
        this.deletePersisted(record.descriptor.id);
        this.records.delete(record.descriptor.id);
    }

    /**
     * Load persisted descriptors and token hashes at construction. Terminal
     * statuses are preserved exactly. The descriptor carries only the idle
     * deadline, not the configured idle window, so the window is recovered from
     * `idleExpiresAt - createdAt` and capped by the current registry default; a
     * persisted store that exceeds `maxSessions` is rejected rather than
     * silently breaking the capacity invariant.
     */
    private restore(): void {
        const store: SessionStore | undefined = this.store;
        if (store === (void 0) || typeof(store.list) !== "function") {
            return;
        }
        let listed: SessionDescriptor[];
        try {
            listed = store.list();
        } catch {
            return fail("store_failure");
        }
        if (!Array.isArray(listed)) {
            return fail("store_failure");
        }
        for (let index: number = 0; index < listed.length; index += 1) {
            const descriptor: SessionDescriptor = listed[index];
            if (!this.storedDescriptorIsValid(descriptor)) {
                return fail("store_failure");
            }
            let secret: string | undefined;
            try {
                secret = typeof(store.loadSecret) === "function" ? store.loadSecret(descriptor.id) : (void 0);
            } catch {
                return fail("store_failure");
            }
            const createdMs: number | undefined = parseTime(descriptor.createdAt);
            const idleExpiresMs: number | undefined = parseTime(descriptor.idleExpiresAt);
            const idleWindow: number = createdMs === (void 0) || idleExpiresMs === (void 0) ? 0 : idleExpiresMs - createdMs;
            this.records.set(descriptor.id, {
                descriptor: clone(descriptor),
                tokenHash: typeof(secret) === "string" && secret.length > 0 ? secret : (void 0),
                rotations: loadRotationCount(store, descriptor.id),
                idleTtlMs: idleWindow > 0 ? Math.min(this.defaults.idleTtlMs, idleWindow) : this.defaults.idleTtlMs,
            });
        }
        if (this.records.size > this.limits.maxSessions) {
            return fail("session_capacity");
        }
    }

    private storedDescriptorIsValid(descriptor: SessionDescriptor): boolean {
        try {
            if (descriptor === null || typeof(descriptor) !== "object" || Array.isArray(descriptor)) {
                return false;
            }
            const status: unknown = descriptor.status;
            if (
                !textIsValid(descriptor.id) ||
                !textIsValid(descriptor.agentId) ||
                !textIsValid(descriptor.label) ||
                (status !== "active" && status !== "suspended" && status !== "revoked" && status !== "expired") ||
                !Number.isSafeInteger(descriptor.revision) ||
                descriptor.revision < 0
            ) {
                return false;
            }
            const created: number | undefined = parseTime(descriptor.createdAt);
            const expires: number | undefined = parseTime(descriptor.expiresAt);
            const idleExpires: number | undefined = parseTime(descriptor.idleExpiresAt);
            if (created === (void 0) || expires === (void 0) || idleExpires === (void 0) || expires < created || idleExpires > expires) {
                return false;
            }
            if (descriptor.parentId !== (void 0) && !textIsValid(descriptor.parentId)) {
                return false;
            }
            if (!Array.isArray(descriptor.roots) || descriptor.roots.length === 0 || descriptor.roots.length > this.limits.maxRootsPerSession) {
                return false;
            }
            const rootIds: Set<string> = new Set<string>();
            const rootPaths: Set<string> = new Set<string>();
            for (let index: number = 0; index < descriptor.roots.length; index += 1) {
                const root: SessionRoot = descriptor.roots[index];
                if (
                    root === null ||
                    typeof(root) !== "object" ||
                    !textIsValid(root.id) ||
                    rootIds.has(root.id) ||
                    typeof(root.path) !== "string" ||
                    !isAbsolute(root.path) ||
                    typeof(root.writable) !== "boolean" ||
                    !Array.isArray(root.exclude) ||
                    root.exclude.some((entry: unknown): boolean => typeof(entry) !== "string" || ControlCharacters.test(entry) || !isWellFormed(entry))
                ) {
                    return false;
                }
                let resolved: string;
                if (!statSync(root.path).isDirectory()) {
                    return false;
                }
                resolved = realpathSync(root.path);
                if (pathIdentity(resolved) !== pathIdentity(root.path) || rootPaths.has(pathIdentity(resolved))) {
                    return false;
                }
                rootIds.add(root.id);
                rootPaths.add(pathIdentity(resolved));
            }
            const permissions: SessionPermissions = descriptor.permissions;
            if (permissions === null || typeof(permissions) !== "object" || Array.isArray(permissions)) {
                return false;
            }
            const flags: boolean[] = [permissions.read, permissions.write, permissions.create, permissions.remove];
            if (flags.some((flag: unknown): boolean => typeof(flag) !== "boolean")) {
                return false;
            }
            const permissionLimits: number[] = [
                permissions.maxReadBytes,
                permissions.maxWriteBytes,
                permissions.maxTreeNodes,
                permissions.maxContextEntries,
                permissions.maxContextBytes,
            ];
            if (permissionLimits.some((limit: number): boolean => !Number.isSafeInteger(limit) || limit < 1)) {
                return false;
            }
            if (permissions.maxContextEntries > this.limits.maxContextEntries || permissions.maxContextBytes > this.limits.maxContextBytes) {
                return false;
            }
            const metadata: unknown = descriptor.metadata;
            if (metadata === null || typeof(metadata) !== "object" || Array.isArray(metadata)) {
                return false;
            }
            return Object.entries(metadata).every(
                ([key, value]: [string, unknown]): boolean =>
                    key.length > 0 && !ControlCharacters.test(key) && isWellFormed(key) && typeof(value) === "string" && isWellFormed(value),
            );
        } catch {
            return false;
        }
    }

    private normalizeRoots(input: readonly SessionRoot[]): readonly SessionRoot[] {
        if (!Array.isArray(input) || input.length === 0 || input.length > this.limits.maxRootsPerSession) {
            return fail("invalid_arguments");
        }
        const seen: Set<string> = new Set<string>();
        const seenPaths: Set<string> = new Set<string>();
        const roots: SessionRoot[] = [];
        for (let index: number = 0; index < input.length; index += 1) {
            const root: SessionRoot = input[index];
            if (root === null || typeof(root) !== "object") {
                return fail("invalid_arguments");
            }
            const id: string = requireText(root.id);
            if (seen.has(id)) {
                return fail("invalid_arguments");
            }
            seen.add(id);
            const path: string = root.path;
            if (typeof(path) !== "string" || path.length === 0 || !isAbsolute(path)) {
                return fail("invalid_arguments");
            }
            let directory: boolean;
            try {
                directory = statSync(path).isDirectory();
            } catch {
                return fail("invalid_arguments");
            }
            if (!directory) {
                return fail("invalid_arguments");
            }
            let resolved: string;
            try {
                resolved = realpathSync(path);
            } catch {
                return fail("invalid_arguments");
            }
            const identity: string = pathIdentity(resolved);
            if (seenPaths.has(identity)) {
                return fail("invalid_arguments");
            }
            seenPaths.add(identity);
            roots.push({ id, path: resolved, writable: root.writable === true, exclude: normalizeExclude(root.exclude) });
        }
        return roots;
    }

    /**
     * Capacity counts retained descriptors, including terminal records kept
     * for audit. `close` is the operation that frees a slot.
     */
    private assertCapacity(): void {
        if (this.records.size >= this.limits.maxSessions) {
            fail("session_capacity");
        }
    }

    private require(sessionId: SessionId): SessionRecord {
        if (typeof(sessionId) !== "string" || sessionId.length === 0) {
            return fail("session_not_found");
        }
        const record: SessionRecord | undefined = this.records.get(sessionId);
        return record === (void 0) ? fail("session_not_found") : record;
    }

    private expireIfDue(record: SessionRecord, nowMs: number): void {
        if (record.descriptor.status !== "active" && record.descriptor.status !== "suspended") {
            return;
        }
        if (isDue(record.descriptor, nowMs)) {
            this.markExpired(record);
        }
    }

    private markExpired(record: SessionRecord): void {
        if (record.descriptor.status === "expired") {
            return;
        }
        record.descriptor = { ...record.descriptor, status: "expired", revision: record.descriptor.revision + 1 };
        this.saveRecord(record);
    }

    private saveRecord(record: SessionRecord): void {
        this.persist(record.descriptor, record.tokenHash ?? "");
    }

    private persist(descriptor: SessionDescriptor, tokenHash: string): void {
        const store: SessionStore | undefined = this.store;
        if (store === (void 0)) {
            return;
        }
        try {
            store.save(clone(descriptor), tokenHash);
        } catch {
            fail("store_failure");
        }
    }

    private deletePersisted(sessionId: SessionId): void {
        const store: SessionStore | undefined = this.store;
        if (store === (void 0)) {
            return;
        }
        try {
            store.delete(sessionId);
        } catch {
            fail("store_failure");
        }
    }

    /**
     * Best-effort rollback for a fork whose descriptor could not be persisted.
     * The original store error is more useful than a cleanup error, so this
     * never throws.
     */
    private discardContext(sessionId: SessionId): void {
        try {
            this.context.remove(sessionId);
        } catch {
            return;
        }
    }
}
