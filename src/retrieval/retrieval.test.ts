import assert from "node:assert/strict";
import test from "node:test";
import { Optional, SynchronousOrderedMap, SynchronousOrderedSet } from "semantic-typescript";
import { RetrievalHandleStore, paginate, retrieve, retrieveOptional, shape } from "./index.ts";
import type { CandidateStream } from "./types.ts";

const lookup = <K, V>(entries: Iterable<readonly [K, V]> = []): SynchronousOrderedMap<K, V> => new SynchronousOrderedMap(entries);
const manifest = (manifestId: string, tenantId: string, tools: readonly { toolId: string; summary: string }[]) => ({
    manifestId, tenantId, endpointId: `endpoint-${manifestId}`, endpointIdentity: "local", serverVersion: "1", digest: `digest-${manifestId}`,
    policyScope: "read", issuedAt: "2026-01-01T00:00:00.000Z", tools: tools.map(tool => ({ ...tool, version: "1", digest: "tool-digest", inputSchema: {}, risk: "read" as const, effect: "read_only" as const, policyScope: "read" })),
});

test("retrieves all matching authorized tools across manifests with explainable scores", () => {
    const stream: CandidateStream = { manifests: [manifest("m1", "t1", [{ toolId: "search", summary: "search documents" }]), manifest("m2", "t1", [{ toolId: "lookup", summary: "document lookup" }])], statusByToolId: lookup([["search", "available"], ["lookup", "available"]]) };
    const result = retrieve(stream, { tenantId: "t1", query: "document search", authorizedToolIds: new SynchronousOrderedSet(["search", "lookup"]), minimumScore: 0.2 });
    assert.deepEqual(result.tools.map(item => item.tool.toolId), ["lookup", "search"]);
    assert.equal(result.tools[0]?.reason.matchedTerms.length, 1);
});

test("returns empty for no match and never exposes unauthorized or other-tenant candidates", () => {
    const stream: CandidateStream = { manifests: [manifest("m1", "t1", [{ toolId: "secret", summary: "database dump" }]), manifest("m2", "t2", [{ toolId: "other", summary: "database query" }])], statusByToolId: lookup() };
    assert.equal(retrieve(stream, { tenantId: "t1", query: "unknown", authorizedToolIds: new SynchronousOrderedSet(["secret"]) }).tools.length, 0);
    assert.equal(retrieve(stream, { tenantId: "t1", query: "database", authorizedToolIds: new SynchronousOrderedSet<string>() }).tools.length, 0);
});

test("keeps precondition status distinct from authorization", () => {
    const stream: CandidateStream = { manifests: [manifest("m", "t", [{ toolId: "deploy", summary: "deploy release" }])], statusByToolId: lookup([["deploy", "missing_precondition"]]) };
    const found = retrieve(stream, { tenantId: "t", query: "deploy release", authorizedToolIds: new SynchronousOrderedSet(["deploy"]) });
    assert.equal(found.tools[0]?.reason.status, "missing_precondition");
});

test("optional query and index reads handle Optional, null, and undefined", () => {
    const toolManifest = manifest("m", "t", [{ toolId: "search", summary: "search documents" }]);
    const stream: CandidateStream = { manifests: [toolManifest], statusByToolId: lookup([["search", "available"]]) };
    const result = retrieveOptional(stream, { tenantId: Optional.of("t"), authorizedToolIds: Optional.of(new SynchronousOrderedSet(["search"])), query: Optional.of("search") });
    assert.equal(result.tools.length, 1);
    assert.throws(() => retrieveOptional(stream, { tenantId: Optional.empty(), authorizedToolIds: Optional.of(new SynchronousOrderedSet(["search"])), query: Optional.of("search") }), /required/);
    assert.throws(() => retrieveOptional(stream, { tenantId: null, authorizedToolIds: Optional.of(new SynchronousOrderedSet(["search"])), query: Optional.of("search") }), /required/);
    assert.throws(() => retrieveOptional(stream, { tenantId: undefined, authorizedToolIds: Optional.of(new SynchronousOrderedSet(["search"])), query: Optional.of("search") }), /required/);

    const nullableIndex: CandidateStream = {
        manifests: [toolManifest],
        statusByToolId: { get: () => null },
        semanticScores: { get: () => undefined },
        signatureCompatibility: { get: () => Optional.empty() },
    };
    const fallback = retrieve(nullableIndex, { tenantId: "t", authorizedToolIds: new SynchronousOrderedSet(["search"]), query: "search" });
    assert.equal(fallback.tools[0]?.reason.status, "disabled");
});

test("handle enforces scope, expiry, pagination, and host authorization on each read", async () => {
    let now = "2026-01-01T00:00:00.000Z";
    const store = new RetrievalHandleStore<string>(() => now);
    const handle = store.create({ id: "h", tenantId: "t1", ownerId: "o1", sessionId: "s1", sourceDigest: "source", ttlMilliseconds: 1000, revocationEpoch: 0, records: ["a", "b", "c"] });
    const request = { tenantId: "t1", ownerId: "o1", sessionId: "s1", limit: 2, now, expectedRevocationEpoch: 0 };
    const auth = () => true;
    const first = await store.read(handle.id, request, auth);
    assert.deepEqual(first.items, ["a", "b"]);
    assert.equal(first.nextCursor, "2");
    assert.deepEqual((await store.read(handle.id, { ...request, cursor: first.nextCursor }, auth)).items, ["c"]);
    await assert.rejects(store.read(handle.id, { ...request, tenantId: "t2" }, auth), /scope_mismatch/);
    await assert.rejects(store.read(handle.id, request, () => false), /forbidden/);
    await assert.rejects(store.read(handle.id, { ...request, now: "not-a-time" }, auth), /valid timestamp/);
    now = "2026-01-01T00:00:02.000Z";
    await assert.rejects(store.read(handle.id, { ...request, now }, auth), /expired/);
    store.revoke(handle.id);
    const revokedHandle = store.getHandle(handle.id)!;
    assert.equal(revokedHandle.revoked, true);
    await assert.rejects(store.read(handle.id, { ...request, expectedRevocationEpoch: revokedHandle.revocationEpoch }, auth), /handle_revoked/);
});

test("a revoke during asynchronous authorization prevents data release", async () => {
    const store = new RetrievalHandleStore<string>(() => "2026-01-01T00:00:00.000Z");
    const handle = store.create({ id: "race", tenantId: "t", ownerId: "o", sessionId: "s", sourceDigest: "d", ttlMilliseconds: 10000, revocationEpoch: 3, records: ["private"] });
    const request = { tenantId: "t", ownerId: "o", sessionId: "s", limit: 1, now: "2026-01-01T00:00:01.000Z", expectedRevocationEpoch: handle.revocationEpoch };
    let releaseAuthorization: (() => void) | undefined;
    const pendingAuthorization = new Promise<boolean>(resolve => { releaseAuthorization = () => resolve(true); });
    const pendingRead = store.read(handle.id, request, () => pendingAuthorization);
    store.revoke(handle.id);
    releaseAuthorization!();
    await assert.rejects(pendingRead, /handle_revoked/);
});

test("pagination bounds and shaping preserve the raw source as retrievable data, not truth", () => {
    assert.throws(() => paginate([1, 2], undefined, 0), /positive/);
    const raw = { secret: "original" };
    const shaped = shape(raw, { summary: value => value.secret, digest: value => `digest:${value.secret}`, fields: value => ({ key: value.secret }) });
    assert.equal(shaped.summary, "original");
    assert.deepEqual(shaped.original, raw);
    assert.equal(shaped.originalDigest, "digest:original");
});
