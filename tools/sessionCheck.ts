#!/usr/bin/env node
/**
 * Session domain checks: identity, lifecycle, context isolation, fork, quotas,
 * capacity and persistence round trips.
 *
 * Every root is a temporary directory created under the OS temp directory and
 * removed by the `after` hook. The persistence adapters are in-memory so the
 * check never needs SQLite and never writes to the repository.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { canonical } from "../src/semantic/canonical.ts";
import {
    SessionContexts,
    SessionRegistry,
    createSessionId,
    createSessionToken,
    hashSessionToken,
    isSessionError,
    verifySessionToken,
} from "../src/session/index.ts";
import type {
    AgentId,
    SessionAuthentication,
    SessionClock,
    SessionContextEntry,
    SessionContextSnapshot,
    SessionContextStore,
    SessionCredential,
    SessionDescriptor,
    SessionErrorCode,
    SessionId,
    SessionJson,
    SessionOpenInput,
    SessionRoot,
    SessionStore,
} from "../src/session/index.ts";

type Opened = {
    descriptor: SessionDescriptor;
    credential: SessionCredential;
};

type DepthValue = {
    nested: {
        depth: number;
    };
};

type TagsValue = {
    tags: string[];
};

type NestedList = {
    nested: number[];
};

type SessionStoreFixture = {
    descriptors: SessionDescriptor[];
    secret?: string;
};

const Sandbox: string = mkdtempSync(join(tmpdir(), "amp-session-"));
const RootA: string = join(Sandbox, "root-a");
const RootB: string = join(Sandbox, "root-b");
const PlainFile: string = join(Sandbox, "plain.txt");
mkdirSync(RootA, { recursive: true });
mkdirSync(RootB, { recursive: true });
writeFileSync(PlainFile, "not a directory", "utf8");

after((): void => {
    rmSync(Sandbox, { recursive: true, force: true });
});

class ManualClock implements SessionClock {
    private current: number = 0;

    constructor(iso: string) {
        this.current = Date.parse(iso);
    }

    now(): Date {
        return new Date(this.current);
    }

    advance(ms: number): void {
        this.current += ms;
    }
}

class MemorySessionStore implements SessionStore {
    private readonly descriptors: Map<SessionId, SessionDescriptor> = new Map<SessionId, SessionDescriptor>();
    private readonly secrets: Map<SessionId, string> = new Map<SessionId, string>();
    private readonly rotations: Map<SessionId, number> = new Map<SessionId, number>();
    private readonly persistSecret: boolean;
    saves: number = 0;

    constructor(persistSecret: boolean = true) {
        this.persistSecret = persistSecret;
    }

    load(sessionId: SessionId): SessionDescriptor | undefined {
        const descriptor: SessionDescriptor | undefined = this.descriptors.get(sessionId);
        return descriptor === (void 0) ? (void 0) : structuredClone(descriptor);
    }

    loadSecret(sessionId: SessionId): string | undefined {
        return this.persistSecret ? this.secrets.get(sessionId) : (void 0);
    }

    loadRotations(sessionId: SessionId): number | undefined {
        return this.rotations.get(sessionId);
    }

    save(descriptor: SessionDescriptor, tokenHash: string): void {
        this.descriptors.set(descriptor.id, structuredClone(descriptor));
        this.secrets.set(descriptor.id, tokenHash);
        this.saves += 1;
    }

    saveRotations(sessionId: SessionId, rotations: number): void {
        this.rotations.set(sessionId, rotations);
    }

    delete(sessionId: SessionId): boolean {
        const removed: boolean = this.descriptors.delete(sessionId);
        this.secrets.delete(sessionId);
        this.rotations.delete(sessionId);
        return removed;
    }

    list(agentId?: AgentId): SessionDescriptor[] {
        const all: SessionDescriptor[] = [...this.descriptors.values()].map((descriptor: SessionDescriptor): SessionDescriptor => structuredClone(descriptor));
        if (agentId === (void 0)) {
            return all;
        }
        return all.filter((descriptor: SessionDescriptor): boolean => descriptor.agentId === agentId);
    }
}

class MemoryContextStore implements SessionContextStore {
    loads: number = 0;
    private readonly partitions: Map<SessionId, Map<string, SessionContextEntry>> = new Map<SessionId, Map<string, SessionContextEntry>>();

    load(sessionId: SessionId): SessionContextEntry[] {
        this.loads += 1;
        const partition: Map<string, SessionContextEntry> | undefined = this.partitions.get(sessionId);
        if (partition === (void 0)) {
            return [];
        }
        return [...partition.values()].map((entry: SessionContextEntry): SessionContextEntry => structuredClone(entry));
    }

    put(sessionId: SessionId, entry: SessionContextEntry): void {
        let partition: Map<string, SessionContextEntry> | undefined = this.partitions.get(sessionId);
        if (partition === (void 0)) {
            partition = new Map<string, SessionContextEntry>();
            this.partitions.set(sessionId, partition);
        }
        partition.set(`${entry.namespace}\u0000${entry.key}`, structuredClone(entry));
    }

    delete(sessionId: SessionId, namespace: string, key: string): boolean {
        const partition: Map<string, SessionContextEntry> | undefined = this.partitions.get(sessionId);
        if (partition === (void 0)) {
            return false;
        }
        return partition.delete(`${namespace}\u0000${key}`);
    }

    deleteSession(sessionId: SessionId): void {
        this.partitions.delete(sessionId);
    }

    replace(sessionId: SessionId, entries: readonly SessionContextEntry[]): void {
        const partition: Map<string, SessionContextEntry> = new Map<string, SessionContextEntry>();
        for (let index: number = 0; index < entries.length; index += 1) {
            const entry: SessionContextEntry = entries[index];
            partition.set(`${entry.namespace}\u0000${entry.key}`, structuredClone(entry));
        }
        this.partitions.set(sessionId, partition);
    }

    count(sessionId: SessionId): number {
        const partition: Map<string, SessionContextEntry> | undefined = this.partitions.get(sessionId);
        return partition === (void 0) ? 0 : partition.size;
    }
}

class FlakyContextStore extends MemoryContextStore {
    failPut: boolean = false;
    failDelete: boolean = false;
    failReplace: boolean = false;
    failDeleteSession: boolean = false;

    put(sessionId: SessionId, entry: SessionContextEntry): void {
        if (this.failPut) {
            throw new Error("/secret/host/path");
        }
        super.put(sessionId, entry);
    }

    delete(sessionId: SessionId, namespace: string, key: string): boolean {
        if (this.failDelete) {
            throw new Error("/secret/host/path");
        }
        return super.delete(sessionId, namespace, key);
    }

    deleteSession(sessionId: SessionId): void {
        if (this.failDeleteSession) {
            throw new Error("/secret/host/path");
        }
        super.deleteSession(sessionId);
    }

    replace(sessionId: SessionId, entries: readonly SessionContextEntry[]): void {
        if (this.failReplace) {
            throw new Error("/secret/host/path");
        }
        super.replace(sessionId, entries);
    }
}

class FlakySessionStore extends MemorySessionStore {
    failList: boolean = false;
    failSave: boolean = false;
    failLoadSecret: boolean = false;
    failDelete: boolean = false;

    loadSecret(sessionId: SessionId): string | undefined {
        if (this.failLoadSecret) {
            throw new Error("/secret/host/path");
        }
        return super.loadSecret(sessionId);
    }

    save(descriptor: SessionDescriptor, tokenHash: string): void {
        if (this.failSave) {
            throw new Error("/secret/host/path");
        }
        super.save(descriptor, tokenHash);
    }

    delete(sessionId: SessionId): boolean {
        if (this.failDelete) {
            throw new Error("/secret/host/path");
        }
        return super.delete(sessionId);
    }

    list(agentId?: AgentId): SessionDescriptor[] {
        if (this.failList) {
            throw new Error("/secret/host/path");
        }
        return super.list(agentId);
    }
}

class FailingForkStore extends MemorySessionStore {
    childId: string = "";

    save(descriptor: SessionDescriptor, tokenHash: string): void {
        if (descriptor.parentId !== (void 0)) {
            this.childId = descriptor.id;
            throw new Error("/secret/host/path");
        }
        super.save(descriptor, tokenHash);
    }
}

const contextStoreReturning: (value: unknown) => SessionContextStore = (value: unknown): SessionContextStore => ({
    load: (): SessionContextEntry[] => value as SessionContextEntry[],
    put: (): void => undefined,
    delete: (): boolean => false,
    deleteSession: (): void => undefined,
    replace: (): void => undefined,
});

const contextStoreThrowing: () => SessionContextStore = (): SessionContextStore => ({
    load: (): SessionContextEntry[] => {
        throw new Error("/secret/host/path");
    },
    put: (): void => undefined,
    delete: (): boolean => false,
    deleteSession: (): void => undefined,
    replace: (): void => undefined,
});

const sessionStoreOf: (fixture: SessionStoreFixture) => SessionStore = (fixture: SessionStoreFixture): SessionStore => ({
    load: (sessionId: SessionId): SessionDescriptor | undefined =>
        fixture.descriptors.find((descriptor: SessionDescriptor): boolean => descriptor.id === sessionId),
    loadSecret: (): string | undefined => fixture.secret,
    save: (): void => undefined,
    delete: (): boolean => false,
    list: (agentId?: AgentId): SessionDescriptor[] =>
        agentId === (void 0) ? fixture.descriptors : fixture.descriptors.filter((descriptor: SessionDescriptor): boolean => descriptor.agentId === agentId),
});

const rootOf: (path: string, id?: string) => SessionRoot = (path: string, id: string = "root.a"): SessionRoot => ({
    id,
    path,
    writable: false,
    exclude: [],
});

const writableRootOf: (path: string) => SessionRoot = (path: string): SessionRoot => ({ id: "root.a", path, writable: true, exclude: [] });

const openSession: (registry: SessionRegistry) => Opened = (registry: SessionRegistry): Opened =>
    registry.open({ agentId: "agent.one", label: "one", roots: [rootOf(RootA)] });

const expectSessionError: (code: SessionErrorCode, action: () => unknown) => void = (code: SessionErrorCode, action: () => unknown): void => {
    assert.throws(action, (error: unknown): boolean => isSessionError(error) && error.code === code);
};

test("session ids and tokens are opaque, well shaped and unique", (): void => {
    const ids: Set<string> = new Set<string>();
    for (let index: number = 0; index < 64; index += 1) {
        const id: string = createSessionId();
        assert.match(id, /^ses_[0-9a-f]{32}$/);
        ids.add(id);
    }
    assert.equal(ids.size, 64);
    const tokens: Set<string> = new Set<string>();
    for (let index: number = 0; index < 64; index += 1) {
        const token: string = createSessionToken();
        assert.match(token, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(token.includes("="), false);
        tokens.add(token);
    }
    assert.equal(tokens.size, 64);
    const probe: string = createSessionToken();
    assert.equal(Buffer.from(probe, "base64url").length, 32);
});

test("token hashes are one-way and verification never throws on a malformed hash", (): void => {
    const token: string = createSessionToken();
    const digest: string = hashSessionToken(token);
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(digest.includes(token), false);
    assert.equal(verifySessionToken(token, digest), true);
    assert.equal(verifySessionToken(`${token}x`, digest), false);
    assert.equal(verifySessionToken(token, hashSessionToken(`${token}x`)), false);
    assert.equal(verifySessionToken(token, ""), false);
    assert.equal(verifySessionToken(token, digest.slice(0, -1)), false);
    assert.equal(verifySessionToken(token, `${digest}0`), false);
    assert.equal(verifySessionToken("", digest), false);
    assert.equal(verifySessionToken(token, "sha256:zzzz"), false);
    assert.doesNotThrow((): void => {
        verifySessionToken(token, digest.slice(0, 10));
        verifySessionToken(token, "");
    });
    assert.equal(hashSessionToken(""), hashSessionToken(""));
    assert.notEqual(hashSessionToken(""), hashSessionToken("x"));
});

test("open, authenticate, get and list expose exactly one session", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const opened: Opened = registry.open({
        agentId: "agent.coder",
        label: "coder",
        roots: [{ id: "root.project", path: RootA, writable: true, exclude: ["/node_modules/", ".git/", "./dist/"] }],
        metadata: { tier: "dev" },
    });
    const descriptor: SessionDescriptor = opened.descriptor;
    assert.equal(descriptor.status, "active");
    assert.equal(descriptor.agentId, "agent.coder");
    assert.equal(descriptor.label, "coder");
    assert.equal(descriptor.roots[0].path, realpathSync(RootA));
    assert.deepEqual(descriptor.roots[0].exclude, ["node_modules", ".git", "dist"]);
    assert.equal(descriptor.roots[0].writable, true);
    assert.equal(descriptor.permissions.read, true);
    assert.equal(descriptor.permissions.write, false);
    assert.equal(descriptor.permissions.create, false);
    assert.equal(descriptor.permissions.remove, false);
    assert.equal(descriptor.permissions.maxReadBytes, 8 * 1024 * 1024);
    assert.equal(descriptor.permissions.maxWriteBytes, 4 * 1024 * 1024);
    assert.equal(descriptor.permissions.maxTreeNodes, 20000);
    assert.equal(descriptor.permissions.maxContextEntries, 256);
    assert.equal(descriptor.permissions.maxContextBytes, 1024 * 1024);
    assert.equal(descriptor.revision, 0);
    assert.deepEqual(descriptor.metadata, { tier: "dev" });
    assert.equal(opened.credential.sessionId, descriptor.id);
    assert.match(opened.credential.token, /^[A-Za-z0-9_-]{43}$/);
    const authentication: SessionAuthentication = registry.authenticate(descriptor.id, opened.credential.token);
    assert.equal(authentication.descriptor.id, descriptor.id);
    assert.equal(authentication.tokenHash, hashSessionToken(opened.credential.token));
    assert.equal(authentication.descriptor.revision, 1);
    assert.deepEqual(registry.get(descriptor.id), authentication.descriptor);
    assert.deepEqual(registry.list("agent.coder"), [authentication.descriptor]);
    assert.deepEqual(registry.list("agent.other"), []);
    assert.equal(registry.summary(descriptor.id).remainingMs > 0, true);
    expectSessionError("invalid_identity", (): unknown => registry.authenticate(descriptor.id, createSessionToken()));
    expectSessionError("session_not_found", (): unknown => registry.authenticate("ses_00000000000000000000000000000000", opened.credential.token));
});

test("open rejects unsafe roots without leaking a host path", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const valid: SessionOpenInput = { agentId: "agent.one", roots: [rootOf(RootA)] };
    expectSessionError("invalid_arguments", (): unknown => registry.open({ ...valid, agentId: "" }));
    expectSessionError("invalid_arguments", (): unknown => registry.open({ ...valid, roots: [] }));
    expectSessionError("invalid_arguments", (): unknown =>
        registry.open({ agentId: "agent.one", roots: [{ id: "root.a", path: "relative/path", writable: false, exclude: [] }] }),
    );
    expectSessionError("invalid_arguments", (): unknown =>
        registry.open({ agentId: "agent.one", roots: [{ id: "root.a", path: PlainFile, writable: false, exclude: [] }] }),
    );
    expectSessionError("invalid_arguments", (): unknown =>
        registry.open({ agentId: "agent.one", roots: [{ id: "root.a", path: join(Sandbox, "missing"), writable: false, exclude: [] }] }),
    );
    expectSessionError("invalid_arguments", (): unknown => registry.open({ agentId: "agent.one", roots: [rootOf(RootA), rootOf(RootB, "root.a")] }));
    const narrow: SessionRegistry = new SessionRegistry({ limits: { maxRootsPerSession: 1 } });
    expectSessionError("invalid_arguments", (): unknown => narrow.open({ agentId: "agent.one", roots: [rootOf(RootA, "root.a"), rootOf(RootB, "root.b")] }));
    let caught: unknown = (void 0);
    try {
        registry.open({ agentId: "agent.one", roots: [{ id: "root.a", path: join(Sandbox, "missing"), writable: false, exclude: [] }] });
    } catch (error: unknown) {
        caught = error;
    }
    assert.equal(isSessionError(caught), true);
    if (isSessionError(caught)) {
        assert.equal(caught.message, "invalid_arguments");
        assert.equal(caught.message.includes(Sandbox), false);
    }
});

test("contexts are partitioned per session and every result is a deep copy", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const first: Opened = openSession(registry);
    const second: Opened = openSession(registry);
    const at: string = new Date().toISOString();
    const value: SessionJson = { nested: { depth: 1 }, tags: ["a"] };
    const entry: SessionContextEntry = registry.context.set(first.descriptor.id, "cfg", "profile", value, at);
    assert.equal(entry.bytes, Buffer.byteLength(canonical(value), "utf8"));
    assert.equal(entry.updatedAt, at);
    assert.equal(registry.context.get(second.descriptor.id, "cfg", "profile"), undefined);
    assert.equal(registry.context.list(second.descriptor.id).length, 0);
    assert.equal(registry.context.bytes(second.descriptor.id), 0);
    const readBack: SessionContextEntry | undefined = registry.context.get(first.descriptor.id, "cfg", "profile");
    assert.ok(readBack !== (void 0));
    assert.deepEqual(readBack.value, value);
    (readBack.value as DepthValue).nested.depth = 42;
    assert.deepEqual(registry.context.get(first.descriptor.id, "cfg", "profile")?.value, value);
    const snapshot: SessionContextSnapshot = registry.context.snapshot(first.descriptor.id);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.bytes, entry.bytes);
    (snapshot.entries[0].value as TagsValue).tags.push("mutated");
    assert.deepEqual(registry.context.get(first.descriptor.id, "cfg", "profile")?.value, value);
    registry.context.set(first.descriptor.id, "b", "k", 2, at);
    registry.context.set(first.descriptor.id, "a", "k", 1, at);
    assert.deepEqual(
        registry.context.list(first.descriptor.id).map((item: SessionContextEntry): string => `${item.namespace}/${item.key}`),
        ["a/k", "b/k", "cfg/profile"],
    );
    assert.deepEqual(
        registry.context.list(first.descriptor.id, "a").map((item: SessionContextEntry): string => `${item.namespace}/${item.key}`),
        ["a/k"],
    );
    assert.equal(registry.context.delete(first.descriptor.id, "cfg", "profile"), true);
    assert.equal(registry.context.delete(first.descriptor.id, "cfg", "profile"), false);
    assert.equal(registry.context.list(first.descriptor.id, "a").length, 1);
    assert.deepEqual(registry.context.get("ses_unknown", "cfg", "profile"), undefined);
});

test("context quotas count entries and canonical bytes per session", (): void => {
    const registry: SessionRegistry = new SessionRegistry({ limits: { maxContextEntries: 2, maxContextBytes: 64 } });
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    const at: string = new Date().toISOString();
    registry.context.set(id, "ns", "one", 1, at);
    registry.context.set(id, "ns", "two", 2, at);
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "ns", "three", 3, at));
    assert.equal(registry.context.list(id).length, 2);
    const replaced: SessionContextEntry = registry.context.set(id, "ns", "two", "x", at);
    assert.equal(replaced.bytes, 3);
    assert.equal(registry.context.list(id).length, 2);
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "ns", "three", "y".repeat(100), at));
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "ns", "one", "z".repeat(100), at));
    assert.equal(registry.context.list(id).length, 2);
    assert.equal(registry.context.bytes(id), 4);
});

test("context rejects invalid names and non-canonical values", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    const at: string = new Date().toISOString();
    const names: string[] = ["", "x".repeat(129), "bad\u0000name"];
    for (let index: number = 0; index < names.length; index += 1) {
        expectSessionError("invalid_arguments", (): unknown => registry.context.set(id, names[index], "key", 1, at));
        expectSessionError("invalid_arguments", (): unknown => registry.context.set(id, "ns", names[index], 1, at));
        expectSessionError("invalid_arguments", (): unknown => registry.context.get(id, "ns", names[index]));
        expectSessionError("invalid_arguments", (): unknown => registry.context.delete(id, names[index], "key"));
        expectSessionError("invalid_arguments", (): unknown => registry.context.list(id, names[index]));
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidValues: SessionJson[] = [
        cyclic as unknown as SessionJson,
        1n as unknown as SessionJson,
        (() => 1) as unknown as SessionJson,
        undefined as unknown as SessionJson,
        "\ud800" as unknown as SessionJson,
        NaN as unknown as SessionJson,
    ];
    for (let index: number = 0; index < invalidValues.length; index += 1) {
        expectSessionError("invalid_arguments", (): unknown => registry.context.set(id, "ns", `bad-${index}`, invalidValues[index], at));
    }
    assert.equal(registry.context.bytes(id), 0);
});

test("fork deep-copies roots, permissions and context while isolating both sides", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-01T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({ clock });
    const parent: Opened = registry.open({ agentId: "agent.fork", label: "parent", roots: [writableRootOf(RootA)] });
    registry.context.set(parent.descriptor.id, "ns", "k", { nested: [1, 2] }, clock.now().toISOString());
    const forked: Opened = registry.fork(parent.descriptor.id, { label: "child" });
    assert.equal(forked.descriptor.parentId, parent.descriptor.id);
    assert.equal(forked.descriptor.agentId, parent.descriptor.agentId);
    assert.deepEqual(forked.descriptor.roots, parent.descriptor.roots);
    assert.notEqual(forked.descriptor.roots, parent.descriptor.roots);
    assert.notEqual(forked.descriptor.roots[0], parent.descriptor.roots[0]);
    assert.deepEqual(forked.descriptor.permissions, parent.descriptor.permissions);
    assert.notEqual(forked.credential.token, parent.credential.token);
    assert.deepEqual(registry.context.get(forked.descriptor.id, "ns", "k")?.value, { nested: [1, 2] });
    registry.context.set(parent.descriptor.id, "ns", "k", { nested: [9] }, clock.now().toISOString());
    assert.deepEqual(registry.context.get(forked.descriptor.id, "ns", "k")?.value, { nested: [1, 2] });
    const childEntry: SessionContextEntry | undefined = registry.context.get(forked.descriptor.id, "ns", "k");
    assert.ok(childEntry !== (void 0));
    (childEntry.value as NestedList).nested.push(3);
    assert.deepEqual(registry.context.get(parent.descriptor.id, "ns", "k")?.value, { nested: [9] });
    assert.deepEqual(registry.context.get(forked.descriptor.id, "ns", "k")?.value, { nested: [1, 2] });
    registry.authenticate(forked.descriptor.id, forked.credential.token);
    expectSessionError("invalid_identity", (): unknown => registry.authenticate(forked.descriptor.id, parent.credential.token));
    registry.suspend(parent.descriptor.id);
    expectSessionError("session_suspended", (): unknown => registry.fork(parent.descriptor.id));
});

test("absolute and idle deadlines expire lazily; idle refresh never extends the absolute deadline", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-01T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({ clock, defaults: { ttlMs: 60_000, idleTtlMs: 10_000 } });
    const absolute: Opened = openSession(registry);
    clock.advance(60_000);
    expectSessionError("session_expired", (): unknown => registry.authenticate(absolute.descriptor.id, absolute.credential.token));
    assert.equal(registry.get(absolute.descriptor.id).status, "expired");
    assert.equal(registry.summary(absolute.descriptor.id).status, "expired");
    assert.equal(registry.summary(absolute.descriptor.id).remainingMs, 0);
    const idle: Opened = openSession(registry);
    clock.advance(10_000);
    expectSessionError("session_expired", (): unknown => registry.authenticate(idle.descriptor.id, idle.credential.token));
    const refreshed: Opened = openSession(registry);
    clock.advance(9_000);
    registry.authenticate(refreshed.descriptor.id, refreshed.credential.token);
    clock.advance(9_000);
    registry.authenticate(refreshed.descriptor.id, refreshed.credential.token);
    clock.advance(42_000);
    expectSessionError("session_expired", (): unknown => registry.authenticate(refreshed.descriptor.id, refreshed.credential.token));
});

test("suspend, resume and revoke follow the closed lifecycle", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-01T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({ clock, defaults: { ttlMs: 60_000, idleTtlMs: 10_000 } });
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    registry.context.set(id, "ns", "k", { kept: true }, clock.now().toISOString());
    expectSessionError("session_forbidden", (): unknown => registry.resume(id));
    assert.equal(registry.suspend(id).status, "suspended");
    expectSessionError("session_suspended", (): unknown => registry.authenticate(id, opened.credential.token));
    clock.advance(5_000);
    const resumed: SessionDescriptor = registry.resume(id);
    assert.equal(resumed.status, "active");
    assert.equal(Date.parse(resumed.idleExpiresAt) > clock.now().getTime(), true);
    const touched: SessionDescriptor = registry.touch(id);
    assert.equal(touched.revision, resumed.revision + 1);
    const revoked: SessionDescriptor = registry.revoke(id);
    assert.equal(revoked.status, "revoked");
    expectSessionError("session_revoked", (): unknown => registry.authenticate(id, opened.credential.token));
    assert.equal(registry.get(id).status, "revoked");
    expectSessionError("session_revoked", (): unknown => registry.resume(id));
    expectSessionError("session_revoked", (): unknown => registry.suspend(id));
    assert.deepEqual(registry.context.get(id, "ns", "k")?.value, { kept: true });
    assert.equal(registry.revoke(id).status, "revoked");
});

test("resume blocks on the absolute deadline but not on a passed idle deadline", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-02T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({ clock, defaults: { ttlMs: 10_000, idleTtlMs: 5_000 } });
    const opened: Opened = openSession(registry);
    registry.suspend(opened.descriptor.id);
    clock.advance(6_000);
    assert.equal(registry.resume(opened.descriptor.id).status, "active");
    registry.suspend(opened.descriptor.id);
    clock.advance(11_000);
    expectSessionError("session_expired", (): unknown => registry.resume(opened.descriptor.id));
    assert.equal(registry.get(opened.descriptor.id).status, "expired");
    expectSessionError("session_expired", (): unknown => registry.suspend(opened.descriptor.id));
});

test("rotate invalidates the previous token and respects the rotation budget", (): void => {
    const registry: SessionRegistry = new SessionRegistry({ limits: { maxTokenRotations: 2 } });
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    const first: SessionCredential = registry.rotate(id);
    assert.notEqual(first.token, opened.credential.token);
    expectSessionError("invalid_identity", (): unknown => registry.authenticate(id, opened.credential.token));
    registry.authenticate(id, first.token);
    registry.suspend(id);
    const second: SessionCredential = registry.rotate(id);
    assert.notEqual(second.token, first.token);
    registry.resume(id);
    expectSessionError("invalid_identity", (): unknown => registry.authenticate(id, first.token));
    registry.authenticate(id, second.token);
    expectSessionError("session_forbidden", (): unknown => registry.rotate(id));
    registry.authenticate(id, second.token);
});

test("capacity bounds open and close releases a slot", (): void => {
    const registry: SessionRegistry = new SessionRegistry({ limits: { maxSessions: 2 } });
    const first: Opened = openSession(registry);
    openSession(registry);
    expectSessionError("session_capacity", (): unknown => openSession(registry));
    assert.equal(registry.list().length, 2);
    registry.close(first.descriptor.id);
    assert.equal(registry.list().length, 1);
    expectSessionError("session_not_found", (): unknown => registry.get(first.descriptor.id));
    const third: Opened = openSession(registry);
    assert.equal(third.descriptor.status, "active");
    expectSessionError("session_capacity", (): unknown => openSession(registry));
});

test("sweep expires every due session exactly once", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-03T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({ clock, defaults: { ttlMs: 1_000, idleTtlMs: 1_000 } });
    openSession(registry);
    openSession(registry);
    clock.advance(1_000);
    assert.equal(registry.sweep(), 2);
    assert.deepEqual(
        registry.list().map((descriptor: SessionDescriptor): string => descriptor.status),
        ["expired", "expired"],
    );
    assert.equal(registry.sweep(), 0);
});

test("a store restores descriptors and secrets while context loading stays lazy", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-04T00:00:00.000Z");
    const store: MemorySessionStore = new MemorySessionStore();
    const contexts: MemoryContextStore = new MemoryContextStore();
    const first: SessionRegistry = new SessionRegistry({ store, contextStore: contexts, clock });
    const opened: Opened = first.open({ agentId: "agent.persist", label: "persist", roots: [rootOf(RootA)] });
    first.context.set(opened.descriptor.id, "ns", "k", { value: 7 }, clock.now().toISOString());
    const loadsBefore: number = contexts.loads;
    const second: SessionRegistry = new SessionRegistry({ store, contextStore: contexts, clock });
    assert.equal(contexts.loads, loadsBefore);
    assert.equal(second.list("agent.persist").length, 1);
    assert.equal(second.get(opened.descriptor.id).status, "active");
    second.authenticate(opened.descriptor.id, opened.credential.token);
    assert.equal(contexts.loads, loadsBefore);
    assert.deepEqual(second.context.get(opened.descriptor.id, "ns", "k")?.value, { value: 7 });
    assert.equal(contexts.loads, loadsBefore + 1);
    assert.equal(second.context.bytes(opened.descriptor.id) > 0, true);
});

test("restored revoked and expired sessions keep their terminal status", (): void => {
    const clock: ManualClock = new ManualClock("2026-01-05T00:00:00.000Z");
    const store: MemorySessionStore = new MemorySessionStore();
    const contexts: MemoryContextStore = new MemoryContextStore();
    const first: SessionRegistry = new SessionRegistry({ store, contextStore: contexts, clock, defaults: { ttlMs: 1_000, idleTtlMs: 1_000 } });
    const revoked: Opened = openSession(first);
    first.revoke(revoked.descriptor.id);
    const expired: Opened = openSession(first);
    clock.advance(1_000);
    expectSessionError("session_expired", (): unknown => first.authenticate(expired.descriptor.id, expired.credential.token));
    const second: SessionRegistry = new SessionRegistry({ store, contextStore: contexts, clock, defaults: { ttlMs: 1_000, idleTtlMs: 1_000 } });
    assert.equal(second.get(revoked.descriptor.id).status, "revoked");
    assert.equal(second.get(expired.descriptor.id).status, "expired");
    expectSessionError("session_revoked", (): unknown => second.authenticate(revoked.descriptor.id, revoked.credential.token));
    expectSessionError("session_expired", (): unknown => second.authenticate(expired.descriptor.id, expired.credential.token));
});

test("a store without secrets requires a rotation before authentication", (): void => {
    const store: MemorySessionStore = new MemorySessionStore(false);
    const first: SessionRegistry = new SessionRegistry({ store });
    const opened: Opened = openSession(first);
    const second: SessionRegistry = new SessionRegistry({ store });
    expectSessionError("invalid_identity", (): unknown => second.authenticate(opened.descriptor.id, opened.credential.token));
    const rotated: SessionCredential = second.rotate(opened.descriptor.id);
    assert.equal(second.authenticate(opened.descriptor.id, rotated.token).descriptor.id, opened.descriptor.id);
});

test("context persistence is synchronous for set, delete, clear, fork and remove", (): void => {
    const contexts: MemoryContextStore = new MemoryContextStore();
    const store: SessionContexts = new SessionContexts({ persistence: contexts });
    const at: string = new Date().toISOString();
    store.set("ses_a", "ns", "k", { v: 1 }, at);
    assert.equal(contexts.count("ses_a"), 1);
    assert.deepEqual(new SessionContexts({ persistence: contexts }).get("ses_a", "ns", "k")?.value, { v: 1 });
    store.fork("ses_a", "ses_b");
    assert.equal(contexts.count("ses_b"), 1);
    assert.deepEqual(new SessionContexts({ persistence: contexts }).get("ses_b", "ns", "k")?.value, { v: 1 });
    assert.equal(store.delete("ses_a", "ns", "k"), true);
    assert.equal(contexts.count("ses_a"), 0);
    store.set("ses_a", "ns", "k", 2, at);
    store.clear("ses_a");
    assert.equal(contexts.count("ses_a"), 0);
    store.set("ses_a", "ns", "k", 3, at);
    store.remove("ses_a");
    assert.equal(contexts.count("ses_a"), 0);
    assert.equal(new SessionContexts({ persistence: contexts }).get("ses_a", "ns", "k"), undefined);
    const empty: SessionContexts = new SessionContexts({ persistence: contexts });
    assert.equal(empty.get("ses_missing", "ns", "k"), undefined);
    assert.equal(empty.bytes("ses_missing"), 0);
});

test("boundary: context names accept exactly 128 code units and reject 129 or controls", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    const at: string = "t0";
    const limitName: string = "n".repeat(128);
    const stored: SessionContextEntry = registry.context.set(id, limitName, limitName, 1, at);
    assert.equal(stored.namespace.length, 128);
    assert.equal(stored.key.length, 128);
    assert.equal(registry.context.get(id, limitName, limitName)?.value, 1);
    const emojiLimit: string = "😀".repeat(64);
    assert.equal(emojiLimit.length, 128);
    assert.equal(registry.context.set(id, "emoji", emojiLimit, 1, at).key.length, 128);
    const rejected: string[] = ["n".repeat(129), "😀".repeat(65), "", "\u0000", "\u001f", "\u007f", "\u0085", "\u009f", "\ud800", "\udc00"];
    for (let index: number = 0; index < rejected.length; index += 1) {
        expectSessionError("invalid_arguments", (): unknown => registry.context.set(id, rejected[index], "k", 1, at));
        expectSessionError("invalid_arguments", (): unknown => registry.context.set(id, "ns", rejected[index], 1, at));
        expectSessionError("invalid_arguments", (): unknown => registry.context.get(id, rejected[index], "k"));
        expectSessionError("invalid_arguments", (): unknown => registry.context.delete(id, "ns", rejected[index]));
    }
    const longSession: SessionId = "s".repeat(129);
    assert.equal(registry.context.set(longSession, "ns", "k", 1, at).bytes, 1);
});

test("boundary: entry quota is exact and a delete frees exactly one slot", (): void => {
    const registry: SessionRegistry = new SessionRegistry({ limits: { maxContextEntries: 2, maxContextBytes: 1024 } });
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    const at: string = "t0";
    registry.context.set(id, "a", "k1", 1, at);
    registry.context.set(id, "b", "k2", 2, at);
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "c", "k3", 3, at));
    assert.equal(registry.context.list(id).length, 2);
    assert.equal(registry.context.delete(id, "a", "k1"), true);
    registry.context.set(id, "c", "k3", 3, at);
    assert.equal(registry.context.list(id).length, 2);
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "d", "k4", 4, at));
});

test("boundary: byte quota is exact, UTF-8 aware and atomic on failure", (): void => {
    const persistence: MemoryContextStore = new MemoryContextStore();
    const registry: SessionRegistry = new SessionRegistry({ limits: { maxContextBytes: 12, maxContextEntries: 10 }, contextStore: persistence });
    const opened: Opened = openSession(registry);
    const id: SessionId = opened.descriptor.id;
    const at: string = "t0";
    const exactValue: string = "x".repeat(10);
    const exact: SessionContextEntry = registry.context.set(id, "ns", "exact", exactValue, at);
    assert.equal(exact.bytes, 12);
    assert.equal(registry.context.bytes(id), 12);
    assert.equal(persistence.count(id), 1);
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "ns", "one", 1, at));
    expectSessionError("context_quota", (): unknown => registry.context.set(id, "ns", "exact", "x".repeat(11), at));
    assert.deepEqual(registry.context.get(id, "ns", "exact")?.value, exactValue);
    assert.equal(registry.context.bytes(id), 12);
    assert.equal(persistence.count(id), 1);
    const multibyte: SessionRegistry = new SessionRegistry({ limits: { maxContextBytes: 6, maxContextEntries: 10 } });
    const emojiSession: Opened = openSession(multibyte);
    const emoji: SessionContextEntry = multibyte.context.set(emojiSession.descriptor.id, "ns", "emoji", "😀", at);
    assert.equal(emoji.bytes, 6);
    expectSessionError("context_quota", (): unknown => multibyte.context.set(emojiSession.descriptor.id, "ns", "more", "a", at));
    expectSessionError("context_quota", (): unknown => multibyte.context.set(emojiSession.descriptor.id, "ns", "big", "x".repeat(100), at));
    assert.equal(multibyte.context.bytes(emojiSession.descriptor.id), 6);
});

test("boundary: canonical JSON edges round-trip while non-JSON values are rejected atomically", (): void => {
    const persistence: MemoryContextStore = new MemoryContextStore();
    const contexts: SessionContexts = new SessionContexts({ persistence });
    const id: SessionId = "ses_values";
    const at: string = "t0";
    const valid: SessionJson[] = [null, true, false, 0, "", [], {}, "😀", { a: [null, 1, "x"] }];
    for (let index: number = 0; index < valid.length; index += 1) {
        const key: string = `k${index}`;
        const entry: SessionContextEntry = contexts.set(id, "v", key, valid[index], at);
        assert.equal(entry.bytes, Buffer.byteLength(canonical(valid[index]), "utf8"));
        assert.equal(entry.updatedAt, at);
        assert.deepEqual(contexts.get(id, "v", key)?.value, valid[index]);
    }
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 1;
    const invalid: unknown[] = [
        -0,
        NaN,
        Infinity,
        1n,
        (): number => 1,
        undefined,
        Symbol("s"),
        new Date(),
        new Map(),
        new Set(),
        sparse,
        { a: undefined },
        {
            get x(): number {
                return 1;
            },
        },
        "\ud800",
        "\udc00",
    ];
    const before: SessionContextSnapshot = contexts.snapshot(id);
    for (let index: number = 0; index < invalid.length; index += 1) {
        expectSessionError("invalid_arguments", (): unknown => contexts.set(id, "v", `bad${index}`, invalid[index] as unknown as SessionJson, at));
    }
    assert.deepEqual(contexts.snapshot(id), before);
    assert.equal(persistence.count(id), valid.length);
});

test("boundary: exact absolute and idle deadlines are expired", (): void => {
    const absoluteClock: ManualClock = new ManualClock("2026-04-01T00:00:00.000Z");
    const absoluteRegistry: SessionRegistry = new SessionRegistry({ clock: absoluteClock, defaults: { ttlMs: 1_000, idleTtlMs: 10_000 } });
    const absolute: Opened = openSession(absoluteRegistry);
    absoluteClock.advance(999);
    assert.equal(absoluteRegistry.get(absolute.descriptor.id).status, "active");
    absoluteClock.advance(1);
    const expired: SessionDescriptor = absoluteRegistry.get(absolute.descriptor.id);
    assert.equal(expired.status, "expired");
    const revision: number = expired.revision;
    assert.equal(absoluteRegistry.get(absolute.descriptor.id).revision, revision);
    expectSessionError("session_expired", (): unknown => absoluteRegistry.authenticate(absolute.descriptor.id, absolute.credential.token));
    assert.equal(absoluteRegistry.summary(absolute.descriptor.id).remainingMs, 0);
    const idleClock: ManualClock = new ManualClock("2026-04-02T00:00:00.000Z");
    const idleRegistry: SessionRegistry = new SessionRegistry({ clock: idleClock, defaults: { ttlMs: 10_000, idleTtlMs: 1_000 } });
    const idle: Opened = openSession(idleRegistry);
    idleClock.advance(999);
    assert.equal(idleRegistry.get(idle.descriptor.id).status, "active");
    idleClock.advance(1);
    assert.equal(idleRegistry.get(idle.descriptor.id).status, "expired");
    expectSessionError("session_expired", (): unknown => idleRegistry.authenticate(idle.descriptor.id, idle.credential.token));
    const sweepClock: ManualClock = new ManualClock("2026-04-03T00:00:00.000Z");
    const sweepRegistry: SessionRegistry = new SessionRegistry({ clock: sweepClock, defaults: { ttlMs: 1_000, idleTtlMs: 1_000 } });
    const swept: Opened = openSession(sweepRegistry);
    const deadline: number = Date.parse(swept.descriptor.expiresAt);
    assert.equal(sweepRegistry.sweep(new Date(deadline - 1)), 0);
    assert.equal(sweepRegistry.sweep(new Date(deadline)), 1);
    assert.equal(sweepRegistry.sweep(new Date(deadline)), 0);
    const resumeClock: ManualClock = new ManualClock("2026-04-04T00:00:00.000Z");
    const resumeRegistry: SessionRegistry = new SessionRegistry({ clock: resumeClock, defaults: { ttlMs: 1_000, idleTtlMs: 1_000 } });
    const resumed: Opened = openSession(resumeRegistry);
    resumeRegistry.suspend(resumed.descriptor.id);
    resumeClock.advance(999);
    assert.equal(resumeRegistry.resume(resumed.descriptor.id).status, "active");
    resumeRegistry.suspend(resumed.descriptor.id);
    resumeClock.advance(1);
    expectSessionError("session_expired", (): unknown => resumeRegistry.resume(resumed.descriptor.id));
    const touchClock: ManualClock = new ManualClock("2026-04-05T00:00:00.000Z");
    const touchRegistry: SessionRegistry = new SessionRegistry({ clock: touchClock, defaults: { ttlMs: 10_000, idleTtlMs: 1_000 } });
    const touched: Opened = openSession(touchRegistry);
    touchClock.advance(1_000);
    expectSessionError("session_expired", (): unknown => touchRegistry.touch(touched.descriptor.id));
    assert.equal(touchRegistry.get(touched.descriptor.id).status, "expired");
});

test("boundary: duration and limit arguments reject non-finite, non-integer and unrepresentable values", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const badDurations: number[] = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER * 2];
    for (let index: number = 0; index < badDurations.length; index += 1) {
        expectSessionError("invalid_arguments", (): unknown => registry.open({ agentId: "a", roots: [rootOf(RootA)], ttlMs: badDurations[index] }));
        expectSessionError("invalid_arguments", (): unknown => registry.open({ agentId: "a", roots: [rootOf(RootA)], idleTtlMs: badDurations[index] }));
    }
    expectSessionError("invalid_arguments", (): unknown => registry.open({ agentId: "a", roots: [rootOf(RootA)], ttlMs: Number.MAX_SAFE_INTEGER }));
    const clamped: Opened = registry.open({ agentId: "a", roots: [rootOf(RootA)], ttlMs: 1_000, idleTtlMs: Number.MAX_SAFE_INTEGER });
    assert.equal(clamped.descriptor.idleExpiresAt, clamped.descriptor.expiresAt);
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ limits: { maxSessions: 0 } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ limits: { maxTokenRotations: -1 } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ limits: { maxContextEntries: 1.5 } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ limits: { maxContextBytes: NaN } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ defaults: { ttlMs: 0 } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ defaults: { idleTtlMs: -1 } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry({ defaults: { label: "" } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionContexts({ limits: { maxContextEntries: 0, maxContextBytes: 1 } }));
    expectSessionError("invalid_arguments", (): unknown => new SessionContexts({ limits: { maxContextEntries: 1, maxContextBytes: NaN } }));
});

test("boundary: zero and one rotation budgets behave exactly", (): void => {
    const zero: SessionRegistry = new SessionRegistry({ limits: { maxTokenRotations: 0 } });
    const zeroSession: Opened = openSession(zero);
    expectSessionError("session_forbidden", (): unknown => zero.rotate(zeroSession.descriptor.id));
    zero.authenticate(zeroSession.descriptor.id, zeroSession.credential.token);
    const one: SessionRegistry = new SessionRegistry({ limits: { maxTokenRotations: 1 } });
    const opened: Opened = openSession(one);
    const rotated: SessionCredential = one.rotate(opened.descriptor.id);
    assert.notEqual(rotated.token, opened.credential.token);
    expectSessionError("invalid_identity", (): unknown => one.authenticate(opened.descriptor.id, opened.credential.token));
    expectSessionError("session_forbidden", (): unknown => one.rotate(opened.descriptor.id));
    assert.equal(one.authenticate(opened.descriptor.id, rotated.token).descriptor.id, opened.descriptor.id);
    const clock: ManualClock = new ManualClock("2026-04-06T00:00:00.000Z");
    const timed: SessionRegistry = new SessionRegistry({ clock, defaults: { ttlMs: 1_000, idleTtlMs: 1_000 } });
    const session: Opened = openSession(timed);
    clock.advance(1_000);
    expectSessionError("session_expired", (): unknown => timed.rotate(session.descriptor.id));
    assert.equal(timed.get(session.descriptor.id).status, "expired");
});

test("boundary: capacity keeps terminal records and close frees exactly one slot", (): void => {
    const registry: SessionRegistry = new SessionRegistry({ limits: { maxSessions: 1 } });
    const opened: Opened = openSession(registry);
    expectSessionError("session_capacity", (): unknown => openSession(registry));
    registry.revoke(opened.descriptor.id);
    expectSessionError("session_capacity", (): unknown => openSession(registry));
    registry.close(opened.descriptor.id);
    expectSessionError("session_not_found", (): unknown => registry.get(opened.descriptor.id));
    const second: Opened = openSession(registry);
    assert.equal(second.descriptor.status, "active");
    expectSessionError("session_capacity", (): unknown => openSession(registry));
    registry.close(second.descriptor.id);
    expectSessionError("session_not_found", (): unknown => registry.close(second.descriptor.id));
});

test("boundary: fork copies a full context and caps the child at the parent deadline", (): void => {
    const clock: ManualClock = new ManualClock("2026-05-01T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({
        clock,
        limits: { maxContextEntries: 2, maxContextBytes: 1024 },
        defaults: { ttlMs: 1_000, idleTtlMs: 1_000 },
    });
    const parent: Opened = openSession(registry);
    registry.context.set(parent.descriptor.id, "a", "k1", 1, "t0");
    registry.context.set(parent.descriptor.id, "b", "k2", 2, "t0");
    const child: Opened = registry.fork(parent.descriptor.id);
    assert.equal(child.descriptor.expiresAt, parent.descriptor.expiresAt);
    assert.equal(registry.context.list(child.descriptor.id).length, 2);
    expectSessionError("context_quota", (): unknown => registry.context.set(child.descriptor.id, "c", "k3", 3, "t0"));
    clock.advance(500);
    const late: Opened = registry.fork(parent.descriptor.id);
    assert.equal(late.descriptor.expiresAt, parent.descriptor.expiresAt);
    clock.advance(500);
    expectSessionError("session_expired", (): unknown => registry.authenticate(child.descriptor.id, child.credential.token));
    expectSessionError("session_expired", (): unknown => registry.authenticate(parent.descriptor.id, parent.credential.token));
    const tiny: SessionRegistry = new SessionRegistry({ limits: { maxSessions: 1 } });
    const only: Opened = openSession(tiny);
    expectSessionError("session_capacity", (): unknown => tiny.fork(only.descriptor.id));
    expectSessionError("invalid_arguments", (): unknown => tiny.fork(only.descriptor.id, { ttlMs: 0 }));
    tiny.revoke(only.descriptor.id);
    expectSessionError("session_revoked", (): unknown => tiny.fork(only.descriptor.id));
});

test("boundary: root count, id uniqueness and exclude normalisation edges", (): void => {
    const exact: SessionRegistry = new SessionRegistry({ limits: { maxRootsPerSession: 2 } });
    const opened: Opened = exact.open({ agentId: "a", roots: [rootOf(RootA, "r1"), rootOf(RootB, "r2")] });
    assert.equal(opened.descriptor.roots.length, 2);
    expectSessionError("invalid_arguments", (): unknown =>
        exact.open({ agentId: "a", roots: [rootOf(RootA, "r1"), rootOf(RootB, "r2"), rootOf(RootA, "r3")] }),
    );
    expectSessionError("invalid_arguments", (): unknown => exact.open({ agentId: "a", roots: [rootOf(RootA, "r1"), rootOf(RootB, "r1")] }));
    const normalized: Opened = new SessionRegistry().open({
        agentId: "a",
        roots: [{ id: "r", path: `${RootA}/`, writable: true, exclude: ["/a/", "a", "./b/", "\\c\\", "///", ".git/"] }],
    });
    assert.equal(normalized.descriptor.roots[0].path, realpathSync(RootA));
    assert.deepEqual(normalized.descriptor.roots[0].exclude, ["a", "b", "c", ".git"]);
    const coerced: Opened = new SessionRegistry().open({
        agentId: "a",
        roots: [{ id: "r", path: RootA, writable: 1 as unknown as boolean, exclude: [] }],
    });
    assert.equal(coerced.descriptor.roots[0].writable, false);
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry().open({ agentId: "a", roots: [rootOf(RootA, "r1"), rootOf(RootA, "r2")] }));
    const longId: string = "r".repeat(129);
    const longIds: Opened = new SessionRegistry().open({ agentId: "a".repeat(129), label: "   ", roots: [rootOf(RootA, longId)] });
    assert.equal(longIds.descriptor.agentId.length, 129);
    assert.equal(longIds.descriptor.roots[0].id.length, 129);
    assert.equal(longIds.descriptor.label, "session");
    expectSessionError("invalid_arguments", (): unknown => new SessionRegistry().open({ agentId: "a", roots: [rootOf(`${RootA}\u0000`, "r")] }));
    expectSessionError("invalid_arguments", (): unknown =>
        new SessionRegistry().open({ agentId: "a", roots: [rootOf(RootA, "r")], metadata: { "\ud800": "x" } }),
    );
    expectSessionError("invalid_arguments", (): unknown =>
        new SessionRegistry().open({ agentId: "a", roots: [rootOf(RootA, "r")], metadata: { k: "\ud800" } }),
    );
});

test("boundary: context loads accept undefined as empty and classify corrupt rows", (): void => {
    const contexts: SessionContexts = new SessionContexts({ persistence: contextStoreReturning(undefined) });
    assert.equal(contexts.get("ses_x", "ns", "k"), undefined);
    assert.equal(contexts.bytes("ses_x"), 0);
    assert.equal(contexts.set("ses_x", "ns", "k", 1, "t0").bytes, 1);
    expectSessionError("store_failure", (): unknown => new SessionContexts({ persistence: contextStoreReturning({}) }).get("ses_x", "ns", "k"));
    const row: SessionContextEntry = { namespace: "ns", key: "k", value: 1, bytes: 1, updatedAt: "t0" };
    expectSessionError("store_failure", (): unknown => new SessionContexts({ persistence: contextStoreReturning([row, row]) }).get("ses_x", "ns", "k"));
    expectSessionError("store_failure", (): unknown =>
        new SessionContexts({ persistence: contextStoreReturning([{ ...row, bytes: 2 }]) }).get("ses_x", "ns", "k"),
    );
    expectSessionError("store_failure", (): unknown =>
        new SessionContexts({ persistence: contextStoreReturning([{ ...row, key: "" }]) }).get("ses_x", "ns", "k"),
    );
    expectSessionError("store_failure", (): unknown =>
        new SessionContexts({ persistence: contextStoreReturning([{ ...row, value: "\ud800" }]) }).get("ses_x", "ns", "k"),
    );
    const rows: SessionContextEntry[] = [];
    for (let index: number = 0; index < 3; index += 1) {
        rows.push({ ...row, key: `k${index}` });
    }
    const overQuota: SessionContexts = new SessionContexts({
        persistence: contextStoreReturning(rows),
        limits: { maxContextEntries: 1, maxContextBytes: 100 },
    });
    expectSessionError("context_quota", (): unknown => overQuota.get("ses_x", "ns", "k0"));
    overQuota.clear("ses_x");
    assert.equal(overQuota.get("ses_x", "ns", "k0"), undefined);
    assert.equal(overQuota.set("ses_x", "ns", "k0", 1, "t0").bytes, 1);
    let caught: unknown = (void 0);
    try {
        new SessionContexts({ persistence: contextStoreThrowing() }).get("ses_x", "ns", "k");
    } catch (error: unknown) {
        caught = error;
    }
    assert.equal(isSessionError(caught), true);
    if (isSessionError(caught)) {
        assert.equal(caught.code, "store_failure");
        assert.equal(caught.message, "store_failure");
        assert.equal(caught.message.includes("/secret/host/path"), false);
    }
});

test("boundary: context write failures leave memory unchanged", (): void => {
    const persistence: FlakyContextStore = new FlakyContextStore();
    const contexts: SessionContexts = new SessionContexts({ persistence });
    const id: SessionId = "ses_write";
    const at: string = "t0";
    persistence.failPut = true;
    expectSessionError("store_failure", (): unknown => contexts.set(id, "ns", "k", { v: 1 }, at));
    assert.equal(contexts.get(id, "ns", "k"), undefined);
    assert.equal(contexts.bytes(id), 0);
    assert.equal(persistence.count(id), 0);
    persistence.failPut = false;
    contexts.set(id, "ns", "k", { v: 1 }, at);
    const before: number = contexts.bytes(id);
    persistence.failDelete = true;
    expectSessionError("store_failure", (): unknown => contexts.delete(id, "ns", "k"));
    assert.deepEqual(contexts.get(id, "ns", "k")?.value, { v: 1 });
    assert.equal(contexts.bytes(id), before);
    assert.equal(persistence.count(id), 1);
    persistence.failDelete = false;
    persistence.failReplace = true;
    expectSessionError("store_failure", (): unknown => contexts.fork(id, "ses_child"));
    expectSessionError("store_failure", (): unknown => contexts.clear(id));
    assert.equal(contexts.list(id).length, 1);
    persistence.failReplace = false;
    persistence.failDeleteSession = true;
    expectSessionError("store_failure", (): unknown => contexts.remove(id));
    assert.equal(contexts.list(id).length, 1);
});

test("boundary: corrupt session stores and failing writes are classified", (): void => {
    const listThrows: FlakySessionStore = new FlakySessionStore();
    listThrows.failList = true;
    expectSessionError("store_failure", (): unknown => new SessionRegistry({ store: listThrows }));
    const nonArray: SessionStore = {
        load: (): SessionDescriptor | undefined => (void 0),
        loadSecret: (): string | undefined => (void 0),
        save: (): void => undefined,
        delete: (): boolean => false,
        list: (): SessionDescriptor[] => undefined as unknown as SessionDescriptor[],
    };
    expectSessionError("store_failure", (): unknown => new SessionRegistry({ store: nonArray }));
    const base: FlakySessionStore = new FlakySessionStore();
    const created: SessionRegistry = new SessionRegistry({ store: base });
    openSession(created);
    const descriptor: SessionDescriptor = base.list()[0];
    const malformedDescriptors: SessionDescriptor[] = [
        { ...descriptor, status: "paused" as unknown as SessionDescriptor["status"] },
        { ...descriptor, id: "" },
        { ...descriptor, agentId: "" },
        { ...descriptor, roots: [] },
        { ...descriptor, roots: [{ ...descriptor.roots[0], writable: "yes" as unknown as boolean }] },
        { ...descriptor, permissions: { ...descriptor.permissions, read: "yes" as unknown as boolean } },
        { ...descriptor, permissions: { ...descriptor.permissions, maxWriteBytes: 0 } },
        { ...descriptor, metadata: { valid: 3 as unknown as string } },
        { ...descriptor, createdAt: "not-a-date" },
        { ...descriptor, expiresAt: "not-a-date" },
        { ...descriptor, revision: -1 },
        { ...descriptor, parentId: "   " },
    ];
    malformedDescriptors.forEach((malformed: SessionDescriptor): void => {
        expectSessionError("store_failure", (): unknown => new SessionRegistry({ store: sessionStoreOf({ descriptors: [malformed] }) }));
    });
    const capacityStore: FlakySessionStore = new FlakySessionStore();
    const capacityCreated: SessionRegistry = new SessionRegistry({ store: capacityStore });
    openSession(capacityCreated);
    openSession(capacityCreated);
    expectSessionError("session_capacity", (): unknown => new SessionRegistry({ store: capacityStore, limits: { maxSessions: 1 } }));
    const secretThrows: FlakySessionStore = new FlakySessionStore();
    const secretCreated: SessionRegistry = new SessionRegistry({ store: secretThrows });
    openSession(secretCreated);
    secretThrows.failLoadSecret = true;
    expectSessionError("store_failure", (): unknown => new SessionRegistry({ store: secretThrows }));
    const saveThrows: FlakySessionStore = new FlakySessionStore();
    saveThrows.failSave = true;
    const saveRegistry: SessionRegistry = new SessionRegistry({ store: saveThrows });
    expectSessionError("store_failure", (): unknown => openSession(saveRegistry));
    assert.equal(saveRegistry.list().length, 0);
    const deleteThrows: FlakySessionStore = new FlakySessionStore();
    const deleteRegistry: SessionRegistry = new SessionRegistry({ store: deleteThrows });
    const deleteSession: Opened = openSession(deleteRegistry);
    deleteThrows.failDelete = true;
    expectSessionError("store_failure", (): unknown => deleteRegistry.close(deleteSession.descriptor.id));
    assert.equal(deleteRegistry.get(deleteSession.descriptor.id).status, "revoked");
    assert.equal(deleteThrows.list().length, 1);
    const partial: SessionStore = {
        load: (): SessionDescriptor | undefined => (void 0),
        loadSecret: (): string | undefined => (void 0),
        save: (): void => undefined,
        delete: (): boolean => false,
    } as unknown as SessionStore;
    const partialRegistry: SessionRegistry = new SessionRegistry({ store: partial });
    assert.equal(partialRegistry.list().length, 0);
    assert.equal(openSession(partialRegistry).descriptor.status, "active");
});

test("boundary: unknown handles fail closed and close removes every persisted row", (): void => {
    const registry: SessionRegistry = new SessionRegistry();
    const missing: SessionId = "ses_ffffffffffffffffffffffffffffffff";
    const actions: Array<() => unknown> = [
        (): unknown => registry.get(missing),
        (): unknown => registry.summary(missing),
        (): unknown => registry.touch(missing),
        (): unknown => registry.suspend(missing),
        (): unknown => registry.resume(missing),
        (): unknown => registry.revoke(missing),
        (): unknown => registry.rotate(missing),
        (): unknown => registry.fork(missing),
        (): unknown => registry.close(missing),
        (): unknown => registry.authenticate(missing, createSessionToken()),
        (): unknown => registry.get(null as unknown as SessionId),
    ];
    for (let index: number = 0; index < actions.length; index += 1) {
        expectSessionError("session_not_found", actions[index]);
    }
    assert.equal(registry.list().length, 0);
    assert.equal(registry.sweep(), 0);
    const store: MemorySessionStore = new MemorySessionStore();
    const contexts: MemoryContextStore = new MemoryContextStore();
    const persisted: SessionRegistry = new SessionRegistry({ store, contextStore: contexts });
    const opened: Opened = openSession(persisted);
    persisted.context.set(opened.descriptor.id, "ns", "k", 1, "t0");
    persisted.close(opened.descriptor.id);
    expectSessionError("session_not_found", (): unknown => persisted.get(opened.descriptor.id));
    assert.equal(persisted.list().length, 0);
    assert.equal(store.list().length, 0);
    assert.equal(store.loadSecret(opened.descriptor.id), undefined);
    assert.equal(contexts.count(opened.descriptor.id), 0);
    const restored: SessionRegistry = new SessionRegistry({ store, contextStore: contexts });
    assert.equal(restored.list().length, 0);
    assert.equal(restored.context.get(opened.descriptor.id, "ns", "k"), undefined);
});

test("boundary: token verification handles empty, truncated, oversized and mis-prefixed hashes", (): void => {
    const token: string = createSessionToken();
    const digest: string = hashSessionToken(token);
    const emptyDigest: string = hashSessionToken("");
    assert.match(emptyDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(verifySessionToken("", emptyDigest), true);
    assert.equal(verifySessionToken("", digest), false);
    assert.equal(verifySessionToken(token, ""), false);
    assert.equal(verifySessionToken(token, `${digest}${"0".repeat(1024)}`), false);
    assert.equal(verifySessionToken(token, `sha256:${digest.slice(7).toUpperCase()}`), false);
    assert.equal(verifySessionToken(token, digest.slice(7)), false);
    assert.equal(verifySessionToken(token, digest.slice(0, 70)), false);
    assert.equal(verifySessionToken(null as unknown as string, digest), false);
    assert.doesNotThrow((): void => {
        verifySessionToken(token, `${digest}${"0".repeat(1024)}`);
    });
    expectSessionError("invalid_arguments", (): unknown => hashSessionToken(null as unknown as string));
});

test("boundary: a fork whose descriptor cannot be saved rolls its context back", (): void => {
    const store: FailingForkStore = new FailingForkStore();
    const registry: SessionRegistry = new SessionRegistry({ store });
    const parent: Opened = openSession(registry);
    registry.context.set(parent.descriptor.id, "ns", "k", 1, "t0");
    expectSessionError("store_failure", (): unknown => registry.fork(parent.descriptor.id));
    assert.equal(store.childId.length > 0, true);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.context.get(store.childId, "ns", "k"), undefined);
    assert.deepEqual(registry.context.get(parent.descriptor.id, "ns", "k")?.value, 1);
});

test("boundary: revoke after the idle deadline reports expired, not revoked", (): void => {
    const clock: ManualClock = new ManualClock("2026-08-01T00:00:00.000Z");
    const registry: SessionRegistry = new SessionRegistry({ clock, defaults: { ttlMs: 10_000, idleTtlMs: 1_000 } });
    const opened: Opened = openSession(registry);
    clock.advance(1_000);
    expectSessionError("session_expired", (): unknown => registry.revoke(opened.descriptor.id));
    assert.equal(registry.get(opened.descriptor.id).status, "expired");
    expectSessionError("session_expired", (): unknown => registry.authenticate(opened.descriptor.id, opened.credential.token));
});

test("boundary: a restored session recovers its idle window instead of widening to the default", (): void => {
    const clock: ManualClock = new ManualClock("2026-08-02T00:00:00.000Z");
    const store: MemorySessionStore = new MemorySessionStore();
    const first: SessionRegistry = new SessionRegistry({ store, clock, defaults: { ttlMs: 8 * 60 * 60 * 1000, idleTtlMs: 1_000 } });
    const opened: Opened = openSession(first);
    clock.advance(500);
    const second: SessionRegistry = new SessionRegistry({ store, clock, defaults: { ttlMs: 8 * 60 * 60 * 1000, idleTtlMs: 30 * 60 * 1000 } });
    const authenticated: SessionAuthentication = second.authenticate(opened.descriptor.id, opened.credential.token);
    assert.equal(Date.parse(authenticated.descriptor.idleExpiresAt), clock.now().getTime() + 1_000);
});

test("boundary: rotation budget survives restore when the store implements the optional hook", (): void => {
    const store: MemorySessionStore = new MemorySessionStore();
    const first: SessionRegistry = new SessionRegistry({ store, limits: { maxTokenRotations: 1 } });
    const opened: Opened = openSession(first);
    const rotated: SessionCredential = first.rotate(opened.descriptor.id);
    const second: SessionRegistry = new SessionRegistry({ store, limits: { maxTokenRotations: 1 } });
    assert.equal(second.authenticate(opened.descriptor.id, rotated.token).descriptor.id, opened.descriptor.id);
    expectSessionError("session_forbidden", (): unknown => second.rotate(opened.descriptor.id));
});
