/**
 * Per-session JSON context with canonical byte accounting.
 *
 * The context is the only mutable data a session owns that is not a file. It is
 * partitioned by session id so two sessions in one process can never observe
 * each other's entries. Values are canonicalised before they are stored: that
 * proves the value round-trips through strict JSON, gives one definition of
 * "bytes" for quotas, and rejects `bigint`, functions, `undefined`, cycles and
 * unpaired surrogates instead of silently coercing them.
 *
 * Every returned entry is a `structuredClone`, so a caller that mutates a
 * result cannot corrupt the store. Persistence is a separate port: a host that
 * only wants identity persistence can omit it, and a host that supplies it gets
 * synchronous `put`/`delete`/`replace` writes on the same calls that mutate
 * memory. Loading is lazy (`ensure`) because a restored registry may hold many
 * sessions the process never touches.
 */
import { Buffer } from "node:buffer";

import { canonical } from "../semantic/canonical.ts";
import { fail } from "./errors.ts";
import type { SessionClock, SessionContextEntry, SessionContextSnapshot, SessionContextStore, SessionId, SessionJson, SessionRegistryLimits } from "./types.ts";

/**
 * Construction options for {@link SessionContexts}. Limits are registry-wide so
 * a caller cannot raise a per-session budget after construction.
 */
export interface SessionContextOptions {
    readonly persistence?: SessionContextStore;
    readonly clock?: SessionClock;
    readonly limits?: Pick<SessionRegistryLimits, "maxContextEntries" | "maxContextBytes">;
}

const DefaultMaxEntries: number = 256;
const DefaultMaxBytes: number = 1024 * 1024;
const MaxNameLength: number = 128;
const ControlCharacters: RegExp = /[\u0000-\u001f\u007f-\u009f]/;
const SystemClock: SessionClock = { now: (): Date => new Date() };

type NamespaceContext = Map<string, SessionContextEntry>;
type SessionContext = Map<string, NamespaceContext>;

const clone: <T>(value: T) => T = <T>(value: T): T => structuredClone(value);

/**
 * A name must be well-formed Unicode. `JSON.stringify` tolerates a lone
 * surrogate by escaping it, but a persistence adapter that binds UTF-8 cannot,
 * so accepting one would make the stored key differ from the key the caller
 * wrote.
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
 * Session ids are opaque handles. They share the text rules but not the
 * 128-code-unit namespace/key ceiling, because the ceiling is a context key
 * contract rather than a session-id contract.
 */
const sessionIdIsValid: (value: unknown) => value is string = (value: unknown): value is string =>
    typeof(value) === "string" && value.length > 0 && value.trim().length > 0 && !ControlCharacters.test(value) && isWellFormed(value);

const requireSessionId: (value: unknown) => string = (value: unknown): string => (sessionIdIsValid(value) ? value : fail("invalid_arguments"));

/**
 * Namespace and key share one grammar: non-empty, at most 128 code units, no
 * control characters and well-formed Unicode. The rule stays out of the error
 * message; the code is the entire contract.
 */
const nameIsValid: (value: unknown) => value is string = (value: unknown): value is string => sessionIdIsValid(value) && value.length <= MaxNameLength;

const requireName: (value: unknown) => string = (value: unknown): string => (nameIsValid(value) ? value : fail("invalid_arguments"));

const requireLimit: (value: number | undefined, fallback: number) => number = (value: number | undefined, fallback: number): number => {
    if (value === (void 0)) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return value;
};

const entryIdentity: (namespace: string, key: string) => string = (namespace: string, key: string): string => `${namespace}\u0000${key}`;

export class SessionContexts {
    private readonly persistence?: SessionContextStore;
    private readonly clock: SessionClock;
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    private readonly sessions: Map<SessionId, SessionContext> = new Map<SessionId, SessionContext>();
    private readonly sizes: Map<SessionId, number> = new Map<SessionId, number>();
    private readonly loaded: Set<SessionId> = new Set<SessionId>();

    constructor(options: SessionContextOptions = {}) {
        this.persistence = options.persistence;
        this.clock = options.clock ?? SystemClock;
        this.maxEntries = requireLimit(options.limits?.maxContextEntries, DefaultMaxEntries);
        this.maxBytes = requireLimit(options.limits?.maxContextBytes, DefaultMaxBytes);
    }

    /**
     * Load one session's persisted entries exactly once. An absent store, a
     * store that has no row for the session and an empty result all mean "this
     * session has no entries yet". A persisted partition that exceeds the
     * current limits is rejected with `context_quota` rather than silently
     * bypassing the quota; `clear` and `remove` still work without loading.
     */
    ensure(sessionId: SessionId): void {
        const id: SessionId = requireSessionId(sessionId);
        if (this.loaded.has(id)) {
            return;
        }
        const partition: SessionContext = new Map<string, NamespaceContext>();
        let total: number = 0;
        const persistence: SessionContextStore | undefined = this.persistence;
        if (persistence !== (void 0)) {
            let loaded: SessionContextEntry[] | undefined;
            try {
                loaded = persistence.load(id);
            } catch {
                return fail("store_failure");
            }
            if (loaded === (void 0)) {
                loaded = [];
            }
            if (!Array.isArray(loaded)) {
                return fail("store_failure");
            }
            const stored: SessionContextEntry[] = loaded;
            const seen: Set<string> = new Set<string>();
            for (let index: number = 0; index < stored.length; index += 1) {
                const storedEntry: SessionContextEntry = stored[index];
                if (!this.storedEntryIsValid(storedEntry)) {
                    return fail("store_failure");
                }
                const entry: SessionContextEntry = clone(storedEntry);
                const identity: string = entryIdentity(entry.namespace, entry.key);
                if (seen.has(identity)) {
                    return fail("store_failure");
                }
                seen.add(identity);
                let bucket: NamespaceContext | undefined = partition.get(entry.namespace);
                if (bucket === (void 0)) {
                    bucket = new Map<string, SessionContextEntry>();
                    partition.set(entry.namespace, bucket);
                }
                bucket.set(entry.key, entry);
                total += entry.bytes;
            }
            if (stored.length > this.maxEntries || total > this.maxBytes) {
                return fail("context_quota");
            }
        }
        this.sessions.set(id, partition);
        this.sizes.set(id, total);
        this.loaded.add(id);
    }

    /**
     * Return one entry, or `undefined`. A missing session is an empty context,
     * not an error: the registry owns session existence.
     */
    get(sessionId: SessionId, namespace: string, key: string): SessionContextEntry | undefined {
        const id: SessionId = requireSessionId(sessionId);
        const space: string = requireName(namespace);
        const entryKey: string = requireName(key);
        const bucket: NamespaceContext | undefined = this.partitionOf(id).get(space);
        if (bucket === (void 0)) {
            return (void 0);
        }
        const entry: SessionContextEntry | undefined = bucket.get(entryKey);
        return entry === (void 0) ? (void 0) : clone(entry);
    }

    /**
     * Canonicalise, quota-check and store one value, returning the stored entry
     * as a detached copy.
     */
    set(sessionId: SessionId, namespace: string, key: string, value: SessionJson, at: string): SessionContextEntry {
        const id: SessionId = requireSessionId(sessionId);
        const space: string = requireName(namespace);
        const entryKey: string = requireName(key);
        if (typeof(at) !== "string") {
            return fail("invalid_arguments");
        }
        let updatedAt: string;
        if (at.length === 0) {
            updatedAt = this.clock.now().toISOString();
        } else {
            updatedAt = at;
        }
        let text: string;
        try {
            text = canonical(value);
        } catch {
            return fail("invalid_arguments");
        }
        const normalized: SessionJson = JSON.parse(text) as SessionJson;
        const bytes: number = Buffer.byteLength(text, "utf8");
        const partition: SessionContext = this.partitionOf(id);
        const bucket: NamespaceContext | undefined = partition.get(space);
        const previous: SessionContextEntry | undefined = bucket === (void 0) ? (void 0) : bucket.get(entryKey);
        const total: number = (this.sizes.get(id) ?? 0) - (previous === (void 0) ? 0 : previous.bytes);
        if (previous === (void 0) && this.countOf(id) + 1 > this.maxEntries) {
            return fail("context_quota");
        }
        if (total + bytes > this.maxBytes) {
            return fail("context_quota");
        }
        const entry: SessionContextEntry = { namespace: space, key: entryKey, value: normalized, bytes, updatedAt };
        this.persistPut(id, entry);
        const target: NamespaceContext = bucket === (void 0) ? new Map<string, SessionContextEntry>() : bucket;
        if (bucket === (void 0)) {
            partition.set(space, target);
        }
        target.set(entryKey, entry);
        this.sizes.set(id, total + bytes);
        return clone(entry);
    }

    /**
     * Remove one entry. Returns `false` when it never existed.
     */
    delete(sessionId: SessionId, namespace: string, key: string): boolean {
        const id: SessionId = requireSessionId(sessionId);
        const space: string = requireName(namespace);
        const entryKey: string = requireName(key);
        const partition: SessionContext = this.partitionOf(id);
        const bucket: NamespaceContext | undefined = partition.get(space);
        if (bucket === (void 0)) {
            return false;
        }
        const entry: SessionContextEntry | undefined = bucket.get(entryKey);
        if (entry === (void 0)) {
            return false;
        }
        const persistence: SessionContextStore | undefined = this.persistence;
        if (persistence !== (void 0)) {
            try {
                persistence.delete(id, space, entryKey);
            } catch {
                return fail("store_failure");
            }
        }
        bucket.delete(entryKey);
        if (bucket.size === 0) {
            partition.delete(space);
        }
        this.sizes.set(id, Math.max(0, (this.sizes.get(id) ?? 0) - entry.bytes));
        return true;
    }

    /**
     * List entries for one session, optionally narrowed to one namespace.
     * Ordering is deterministic (namespace, then key) so snapshots diff cleanly.
     */
    list(sessionId: SessionId, namespace?: string): SessionContextEntry[] {
        const id: SessionId = requireSessionId(sessionId);
        const wanted: string | undefined = namespace === (void 0) ? (void 0) : requireName(namespace);
        const partition: SessionContext = this.partitionOf(id);
        const entries: SessionContextEntry[] = [];
        const namespaces: string[] = [...partition.keys()].sort();
        for (let spaceIndex: number = 0; spaceIndex < namespaces.length; spaceIndex += 1) {
            const space: string = namespaces[spaceIndex];
            if (wanted !== (void 0) && space !== wanted) {
                continue;
            }
            const bucket: NamespaceContext | undefined = partition.get(space);
            if (bucket === (void 0)) {
                continue;
            }
            const keys: string[] = [...bucket.keys()].sort();
            for (let keyIndex: number = 0; keyIndex < keys.length; keyIndex += 1) {
                const entry: SessionContextEntry | undefined = bucket.get(keys[keyIndex]);
                if (entry !== (void 0)) {
                    entries.push(clone(entry));
                }
            }
        }
        return entries;
    }

    /**
     * Immutable view of one session's whole context.
     */
    snapshot(sessionId: SessionId): SessionContextSnapshot {
        const id: SessionId = requireSessionId(sessionId);
        const entries: SessionContextEntry[] = this.list(id);
        return { sessionId: id, entries, bytes: this.sizes.get(id) ?? 0 };
    }

    /**
     * Canonical UTF-8 bytes charged against one session.
     */
    bytes(sessionId: SessionId): number {
        const id: SessionId = requireSessionId(sessionId);
        this.ensure(id);
        return this.sizes.get(id) ?? 0;
    }

    /**
     * Drop every entry for one session. The empty state is persisted as a
     * `replace`, which is atomic for an adapter that honours the port. This is
     * deliberately an overwrite rather than a load-then-clear: a corrupt or
     * over-quota persisted partition must still be removable by its host.
     */
    clear(sessionId: SessionId): void {
        const id: SessionId = requireSessionId(sessionId);
        const persistence: SessionContextStore | undefined = this.persistence;
        if (persistence !== (void 0)) {
            try {
                persistence.replace(id, []);
            } catch {
                return fail("store_failure");
            }
        }
        this.sessions.set(id, new Map<string, NamespaceContext>());
        this.sizes.set(id, 0);
        this.loaded.add(id);
    }

    /**
     * Copy the source context into the target session. Values are deep copies,
     * so the two sessions share no mutable object. The target's previous
     * context, if any, is replaced.
     */
    fork(from: SessionId, to: SessionId): void {
        const source: SessionId = requireSessionId(from);
        const target: SessionId = requireSessionId(to);
        if (source === target) {
            return fail("invalid_arguments");
        }
        const entries: SessionContextEntry[] = this.list(source);
        let total: number = 0;
        for (let index: number = 0; index < entries.length; index += 1) {
            total += entries[index].bytes;
        }
        if (entries.length > this.maxEntries || total > this.maxBytes) {
            return fail("context_quota");
        }
        const persistence: SessionContextStore | undefined = this.persistence;
        if (persistence !== (void 0)) {
            try {
                persistence.replace(
                    target,
                    entries.map((entry: SessionContextEntry): SessionContextEntry => clone(entry)),
                );
            } catch {
                return fail("store_failure");
            }
        }
        const partition: SessionContext = new Map<string, NamespaceContext>();
        for (let index: number = 0; index < entries.length; index += 1) {
            const entry: SessionContextEntry = clone(entries[index]);
            let bucket: NamespaceContext | undefined = partition.get(entry.namespace);
            if (bucket === (void 0)) {
                bucket = new Map<string, SessionContextEntry>();
                partition.set(entry.namespace, bucket);
            }
            bucket.set(entry.key, entry);
        }
        this.sessions.set(target, partition);
        this.sizes.set(target, total);
        this.loaded.add(target);
    }

    /**
     * Remove every entry for one session and its persisted partition.
     */
    remove(sessionId: SessionId): void {
        const id: SessionId = requireSessionId(sessionId);
        const persistence: SessionContextStore | undefined = this.persistence;
        if (persistence !== (void 0)) {
            try {
                persistence.deleteSession(id);
            } catch {
                return fail("store_failure");
            }
        }
        this.sessions.delete(id);
        this.sizes.delete(id);
        this.loaded.delete(id);
    }

    private partitionOf(sessionId: SessionId): SessionContext {
        this.ensure(sessionId);
        const existing: SessionContext | undefined = this.sessions.get(sessionId);
        if (existing !== (void 0)) {
            return existing;
        }
        const created: SessionContext = new Map<string, NamespaceContext>();
        this.sessions.set(sessionId, created);
        this.sizes.set(sessionId, 0);
        return created;
    }

    private countOf(sessionId: SessionId): number {
        const partition: SessionContext | undefined = this.sessions.get(sessionId);
        if (partition === (void 0)) {
            return 0;
        }
        let count: number = 0;
        const buckets: NamespaceContext[] = [...partition.values()];
        for (let index: number = 0; index < buckets.length; index += 1) {
            count += buckets[index].size;
        }
        return count;
    }

    private storedEntryIsValid(entry: SessionContextEntry): boolean {
        if (entry === null || typeof(entry) !== "object") {
            return false;
        }
        if (!nameIsValid(entry.namespace) || !nameIsValid(entry.key)) {
            return false;
        }
        if (typeof(entry.updatedAt) !== "string" || entry.updatedAt.length === 0 || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
            return false;
        }
        let text: string;
        try {
            text = canonical(entry.value);
        } catch {
            return false;
        }
        return Buffer.byteLength(text, "utf8") === entry.bytes;
    }

    private persistPut(sessionId: SessionId, entry: SessionContextEntry): void {
        const persistence: SessionContextStore | undefined = this.persistence;
        if (persistence === (void 0)) {
            return;
        }
        try {
            persistence.put(sessionId, clone(entry));
        } catch {
            fail("store_failure");
        }
    }
}
