#!/usr/bin/env node
/** SQLite + real Elasticsearch SDK integration checks; no Elasticsearch service needed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@elastic/elasticsearch";

import { catalogKey } from "../src/database/entity/catalog.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { Database } from "../src/database/service/database.ts";
import { CatalogSearch, catalogSearchId } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import type { DiscoverySearchNode } from "../src/discover/types.ts";
import { catalogSnapshotFixture } from "./helpers/catalogSnapshotFixture.ts";

type Json = Record<string, any>;
const namespace = "host/catalog";
const scope = { projectIds: ["project-a"] };
const record = (id: string, extras: Partial<CatalogRecord> = {}): CatalogRecord => ({
    id, kind: "knowledge", name: `Label ${id}`, summary: `Summary ${id}`, projectId: "project-a", revision: "r1",
    tags: ["trusted"], searchTerms: ["search"], payload: { content: `SECRET-CONTENT-${id}`, instructions: "SECRET-INSTRUCTIONS", token: "SECRET-TOKEN" },
    ...extras,
});
const links = (...ids: string[]) => ids.map(targetId => ({ relation: "related", targetId }));
const flatten = (node: DiscoverySearchNode): DiscoverySearchNode[] => [node, ...node.children.flatMap(flatten)];
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t: TestContext) {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const requests = remote.requests;
    let hits: Json[] = [];
    let total: number | undefined;
    remote.setSearch(() => ({ took: 4, timed_out: false, hits: { total: { value: total ?? hits.length, relation: "eq" }, hits } }));
    const server = createServer(remote.http);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client({ node: `http://127.0.0.1:${address.port}`, maxRetries: 0, requestTimeout: 2_000 });
    const adapter = new ElasticsearchSearch({ client });
    const catalog = new CatalogSearch({ namespace, catalog: db.catalogService, cache: db.catalogStore, search: adapter });
    t.after(async () => {
        remote.intercept();
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        db.close();
    });
    const hit = (entry: CatalogRecord, overrides: Json = {}) => ({ _id: catalogSearchId(namespace, entry.kind, entry.id), _score: 2.5,
        _source: { id: catalogSearchId(namespace, entry.kind, entry.id), kind: entry.kind, title: entry.name, summary: entry.summary,
            ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }), ...(entry.revision === undefined ? {} : { revision: entry.revision }),
            content: "SECRET-ES-CONTENT", unknown: "SECRET-ES-UNKNOWN", ...overrides } });
    return { db, catalog, adapter, client, requests, hit,
        setHits(value: Json[], count?: number) { hits = value; total = count; },
        setFailBulk: remote.setFailBulk,
        intercept: remote.intercept,
        indices: remote.indices,
    };
}

test("sync projects persisted snapshots to bounded hash IDs without leaking arbitrary payload", async t => {
    const f = await fixture(t);
    const input = record("opaque/" + "界".repeat(600), { kind: "custom/kind" });
    assert.equal(f.requests.length, 0);
    assert.equal(f.catalog.replaceSnapshot([input]), 1);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await f.catalog.sync(), { generation: 1, syncedGeneration: 1 });
    const bulk = f.requests.find(request => request.path.endsWith("/_bulk"))!;
    const id = bulk.lines[0].index._id;
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.equal(id, catalogSearchId(namespace, input.kind, input.id));
    assert.equal(id, createHash("sha256").update(JSON.stringify([namespace, input.kind, input.id])).digest("hex"));
    assert.notEqual(id, catalogSearchId("another-host", input.kind, input.id));
    assert.notEqual(id, catalogSearchId(namespace, "another-kind", input.id));
    assert.equal(bulk.lines[1].content, `${input.payload.content}\n${input.payload.instructions}`);
    assert.equal(bulk.lines[1].title, input.name);
    assert.equal(bulk.lines[1].payload, undefined);
    assert.equal(bulk.lines[1].token, undefined);
    const published = f.db.catalogService.publication(namespace);
    const hash = createHash("sha256").update(namespace).digest("hex").slice(0, 24);
    assert.match(published.index!, new RegExp(`^amp-search-ns-${hash}-[a-f0-9-]{36}$`));
    assert.equal(published.digest, createHash("sha256").update(JSON.stringify([bulk.lines[1]])).digest("hex"));
    const snapshot = f.indices.get(published.index!)!;
    assert.deepEqual(snapshot.mappings._meta, { amp_search: { version: 1, namespace } });
    assert.equal(snapshot.blocked, true);
    const routes = f.requests.map(request => request.path);
    assert.ok(routes.indexOf(`/${published.index}/_refresh`) < routes.indexOf(`/${published.index}/_block/write`));
    assert.ok(routes.indexOf(`/${published.index}/_block/write`) < routes.indexOf(`/${published.index}/_count`));
    assert.ok(routes.includes(`/${published.index}/_settings`));
    assert.ok(routes.includes(`/${published.index}/_mget`));
    assert.ok(!routes.some(path => path.endsWith("/_delete_by_query")));
});

test("each query returns one independent metadata tree per hit with real business IDs", async t => {
    const f = await fixture(t);
    const a = record("a", { relations: links("shared") });
    const b = record("b", { relations: links("shared") });
    const shared = record("shared");
    f.catalog.replaceSnapshot([a, b, shared]);
    await f.catalog.sync();
    f.setHits([f.hit(a, { title: "SECRET-STALE-TITLE", summary: "SECRET-STALE-SUMMARY" }), f.hit(b)]);
    const result = await f.catalog.discover(scope, ["first", "second"], { nodeLimit: 2 });
    assert.deepEqual(result.trees.map(tree => [tree.query, tree.tree.id]), [["first", "a"], ["first", "b"], ["second", "a"], ["second", "b"]]);
    for (const tree of result.trees) {
        assert.equal(tree.tree.score, 2.5);
        assert.equal(tree.tree.matched, true);
        assert.deepEqual(tree.tree.children.map(child => child.id), ["shared"]);
        assert.equal(tree.tree.children[0].matched, false);
        assert.equal(tree.tree.children[0].score, undefined);
        assert.equal(tree.truncated, false);
        assert.equal(tree.total, 2);
    }
    assert.ok(!JSON.stringify(result).includes("SECRET"));
    const cached = f.db.catalogStore.readRecord(namespace, a.kind, a.id)!;
    cached.payload.content = "MUTATED";
    const again = await f.catalog.discover(scope, "again");
    assert.ok(!JSON.stringify(again).includes("MUTATED"));
    assert.equal(f.db.catalogStore.readRecord(namespace, a.kind, a.id)?.payload.content, a.payload.content);
});

test("zero query hits return no trees even though related catalog records exist", async t => {
    const f = await fixture(t);
    f.catalog.replaceSnapshot([record("exists")]);
    await f.catalog.sync();
    f.setHits([]);
    assert.deepEqual(await f.catalog.discover(scope, ["absent", "also absent"]), { trees: [] });
    const before = f.requests.length;
    assert.deepEqual(await f.catalog.discover({ projectIds: [] }, "anything"), { trees: [] });
    assert.equal(f.requests.length, before, "empty authorized scope must not issue ES requests");
});

test("cycles, maximum depth and per-tree node budgets bound graph expansion", async t => {
    const f = await fixture(t);
    const a = record("a", { relations: links("b", "c", "missing", catalogKey("other-namespace", "knowledge", "foreign")) });
    const b = record("b", { relations: links("a", "c") });
    const c = record("c");
    f.catalog.replaceSnapshot([a, b, c]);
    f.db.catalogService.replaceSnapshot("other-namespace", [record("foreign")]);
    await f.catalog.sync();
    f.setHits([f.hit(a), f.hit(b)]);
    const limited = await f.catalog.discover(scope, "q", { nodeLimit: 2 });
    assert.equal(limited.trees.length, 2);
    for (const tree of limited.trees) {
        assert.equal(flatten(tree.tree).length, 2);
        assert.equal(tree.truncated, true);
    }
    const shallow = await f.catalog.discover(scope, "q", { maxDepth: 0 });
    for (const tree of shallow.trees) { assert.deepEqual(tree.tree.children, []); assert.equal(tree.truncated, true); }
    const deep = await f.catalog.discover(scope, "q", { nodeLimit: 20 });
    for (const tree of deep.trees) assert.ok(flatten(tree.tree).length < 10, "cycles must terminate");
    assert.ok(deep.trees.every(tree => !flatten(tree.tree).some(node => node.id === "foreign")));
});

test("SQLite authorization rejects malicious out-of-scope and stale hits and relations", async t => {
    const f = await fixture(t);
    const a = record("a", { relations: links("good", "other", "old", "global", "global-old") });
    const good = record("good");
    const other = record("other", { projectId: "project-b" });
    const old = record("old", { revision: "r0" });
    const global = record("global", { projectId: undefined, revision: undefined });
    const globalOld = record("global-old", { projectId: undefined, revision: "r0" });
    f.catalog.replaceSnapshot([a, good, other, old, global, globalOld]);
    await f.catalog.sync();
    f.setHits([f.hit(a), f.hit(other), f.hit(old), f.hit(global), f.hit(globalOld)]);
    const scoped = await f.catalog.discover(scope, "q", { revision: "r1" });
    assert.deepEqual(scoped.trees.map(tree => tree.tree.id), ["a"]);
    assert.deepEqual(scoped.trees[0].tree.children.map(node => node.id), ["good"]);
    const globals = await f.catalog.discover({ ...scope, includeGlobal: true }, "q", { revision: "r1" });
    // Registry globals are not tied to the workspace revision, including globals with their own revision.
    assert.deepEqual(globals.trees.map(tree => tree.tree.id), ["a", "global", "global-old"]);
    assert.deepEqual(globals.trees[0].tree.children.map(node => node.id), ["good", "global", "global-old"]);
});

test("hit scope and revision are checked even when its hash names an authorized SQLite record", async t => {
    const f = await fixture(t);
    const a = record("a");
    f.catalog.replaceSnapshot([a]);
    await f.catalog.sync();
    for (const overrides of [{ projectId: "project-b" }, { revision: "r0" }, { kind: "other-kind" }]) {
        f.setHits([f.hit(a, overrides)]);
        assert.deepEqual(await f.catalog.discover(scope, "q", { revision: "r1" }), { trees: [] }, JSON.stringify(overrides));
    }
});

test("root kind and tags filters are rechecked against SQLite rather than trusting ES", async t => {
    const f = await fixture(t);
    const a = record("a");
    const b = record("b", { kind: "skill" });
    const c = record("c", { tags: ["untrusted"] });
    f.catalog.replaceSnapshot([a, b, c]);
    await f.catalog.sync();
    f.setHits([f.hit(a), f.hit(b), f.hit(c), f.hit(a)]);
    const result = await f.catalog.discover(scope, "q", { kinds: ["knowledge"], tags: ["trusted"], revision: "r1" });
    assert.deepEqual(result.trees.map(tree => tree.tree.id), ["a"]);
    const request = f.requests.findLast(request => request.path.endsWith("/_search"))!;
    assert.equal(request.body.query.bool.must[0].multi_match.query, "q");
    assert.ok(JSON.stringify(request.body.query).includes('"revision":"r1"'));
});

test("stale snapshots refuse queries without transport and a failed new generation remains dirty until retry", async t => {
    const f = await fixture(t);
    await assert.rejects(() => f.catalog.sync(), /snapshot/);
    await assert.rejects(() => f.catalog.discover(scope, "q"), /stale/);
    const a = record("a");
    f.catalog.replaceSnapshot([a]);
    await assert.rejects(() => f.catalog.discover(scope, "q"), /stale/);
    assert.equal(f.requests.length, 0);
    await f.catalog.sync();
    f.catalog.replaceSnapshot([a]);
    f.setFailBulk(true);
    await assert.rejects(() => f.catalog.sync(), /incomplete/);
    const dirty = f.db.catalogService.state(namespace);
    assert.notEqual(dirty.generation, dirty.syncedGeneration);
    const count = f.requests.length;
    await assert.rejects(() => f.catalog.discover(scope, "q"), /stale/);
    assert.equal(f.requests.length, count);
    f.setFailBulk(false);
    assert.deepEqual(await f.catalog.sync(), { generation: 2, syncedGeneration: 2 });
    f.setHits([f.hit(a)]);
    assert.equal((await f.catalog.discover(scope, "q")).trees.length, 1);
});

test("replaceSnapshot during awaited sync defeats generation CAS; retry syncs the new snapshot", async t => {
    const f = await fixture(t);
    const a = record("a");
    const b = record("b");
    f.catalog.replaceSnapshot([a]);
    const entered = deferred();
    const release = deferred();
    f.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    const pending = f.catalog.sync();
    const rejected = assert.rejects(pending, /changed during synchronization/);
    await entered.promise;
    f.catalog.replaceSnapshot([b]);
    release.resolve();
    await rejected;
    assert.notEqual(f.db.catalogService.state(namespace).generation, f.db.catalogService.state(namespace).syncedGeneration);
    f.intercept();
    assert.deepEqual(await f.catalog.sync(), { generation: 2, syncedGeneration: 2 });
    f.setHits([f.hit(a), f.hit(b)]);
    assert.deepEqual((await f.catalog.discover(scope, "q")).trees.map(tree => tree.tree.id), ["b"]);
});

test("replaceSnapshot during awaited discover refuses to return results from an obsolete generation", async t => {
    const f = await fixture(t);
    const a = record("a");
    f.catalog.replaceSnapshot([a]);
    await f.catalog.sync();
    f.setHits([f.hit(a)]);
    const entered = deferred();
    const release = deferred();
    f.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const rejected = assert.rejects(f.catalog.discover(scope, "q"), /changed during discovery/);
    await entered.promise;
    f.catalog.replaceSnapshot([record("b")]);
    release.resolve();
    await rejected;
});

test("one coordinator queues discovery behind its snapshot build", async t => {
    const f = await fixture(t);
    const a = record("a");
    f.catalog.replaceSnapshot([a]);
    await f.catalog.sync();
    f.setHits([f.hit(a)]);
    const entered = deferred();
    const release = deferred();
    f.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    const syncing = f.catalog.sync();
    await entered.promise;
    const discovering = f.catalog.discover(scope, "queued query");
    let completed = false;
    void discovering.then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(f.requests.some(request => request.path.endsWith("/_search")), false);
    release.resolve();
    await syncing;
    assert.equal((await discovering).trees.length, 1);
    const published = f.db.catalogService.publication(namespace);
    assert.ok(f.requests.some(request => request.path === `/${published.index}/_search`));
    assert.equal(f.requests.at(-1)?.path, `/${published.index}/_mget`);
});

test("one coordinator finishes discovery verification before starting its queued snapshot build", async t => {
    const f = await fixture(t);
    const a = record("a");
    f.catalog.replaceSnapshot([a]);
    await f.catalog.sync();
    f.setHits([f.hit(a)]);
    const entered = deferred();
    const release = deferred();
    f.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const discovering = f.catalog.discover(scope, "q");
    await entered.promise;
    const before = f.requests.length;
    const syncing = f.catalog.sync();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, before);
    release.resolve();
    assert.equal((await discovering).trees.length, 1);
    await syncing;
    assert.equal(f.requests[before].method, "GET", "running discovery completes its post-search verification before queued sync");
    assert.ok(f.requests.slice(before).some(request => request.method === "PUT" && !request.path.includes("/_")));
});

test("uncommitted catalog transactions cannot be synchronized or discovered", async t => {
    const f = await fixture(t);
    f.catalog.replaceSnapshot([record("committed")]);
    await f.catalog.sync();
    const before = f.requests.length;
    f.db.db.exec("BEGIN");
    try {
        // A clean generation must still refuse operations inside an outer transaction.
        await assert.rejects(() => f.catalog.sync(), /transaction|commit/);
        await assert.rejects(() => f.catalog.discover(scope, "q"), /transaction|commit/);
        f.catalog.replaceSnapshot([record("uncommitted")]);
        await assert.rejects(() => f.catalog.sync(), /transaction|commit/);
        await assert.rejects(() => f.catalog.discover(scope, "q"), /transaction|commit|stale/);
        assert.equal(f.requests.length, before);
    } finally {
        f.db.db.exec("ROLLBACK");
    }
    assert.equal(f.db.catalogService.list(namespace)[0].id, "committed");
});

test("invalid query options fail without network; closing the coordinator leaves injected dependencies owned by host", async t => {
    const f = await fixture(t);
    for (const query of ["", " ", [], Array(9).fill("q"), "x".repeat(513)]) await assert.rejects(() => f.catalog.discover(scope, query));
    for (const options of [{ maxDepth: 13 }, { nodeLimit: 201 }, { limit: 101 }, { revision: " " }, { kinds: [""] }])
        await assert.rejects(() => f.catalog.discover(scope, "q", options));
    assert.equal(f.requests.length, 0);
    await f.catalog.close();
    assert.throws(() => f.catalog.replaceSnapshot([record("a")]), /closed/);
    await assert.rejects(() => f.catalog.sync(), /closed/);
    await assert.rejects(() => f.catalog.discover(scope, "q"), /closed/);
    f.db.catalogService.replaceSnapshot(namespace, [record("still-owned")]);
    assert.equal(f.db.catalogStore.readRecord(namespace, "knowledge", "still-owned")?.id, "still-owned");
    const snapshot = await f.adapter.buildSnapshot(namespace, []);
    assert.equal(f.indices.get(snapshot.index)?.blocked, true);
    assert.equal((await f.client.count({ index: snapshot.index })).count, 0);
    assert.ok(f.requests.length > 0, "injected adapter and client remain available after coordinator close");
});
