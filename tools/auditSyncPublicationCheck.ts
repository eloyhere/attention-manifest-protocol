#!/usr/bin/env node
/** Read-only coordinator audit: adversarial transaction and queue timing regressions. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Database } from "../src/database/service/database.ts";
import { withCatalogWrite } from "../src/database/store/catalogGuard.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { CatalogSearch } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import { catalogSnapshotFixture, deferred } from "./helpers/catalogSnapshotFixture.ts";

const namespace = "audit-sync-publication";
const scope = { projectIds: ["project"] };
const item = (name = "committed"): CatalogRecord => ({ id: "stable", kind: "module", name, summary: "", projectId: "project", payload: {} });
const fixture = () => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const catalog = new CatalogSearch({ namespace, catalog: db.catalogService, cache: db.catalogStore, search: new ElasticsearchSearch({ client: remote.fakeClient }) });
    return { db, remote, catalog };
};
const tick = () => new Promise<void>(done => setImmediate(done));
const settled = async (promise: Promise<unknown>, waitMs = 30): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), waitMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
};

test("audit: an outer transaction opened during build must prevent successful publication", async t => {
    const { db, remote, catalog } = fixture();
    const entered = deferred(); const release = deferred();
    t.after(async () => { release.resolve(); if (db.db.isTransaction) db.db.exec("ROLLBACK"); await catalog.close(); db.close(); });
    catalog.replaceSnapshot([item()]);
    remote.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    const sync = catalog.sync();
    await entered.promise;
    db.db.exec("BEGIN");
    release.resolve();
    const outcome = await sync.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    db.db.exec("ROLLBACK");
    assert.deepEqual(db.catalogService.state(namespace), { generation: 1, syncedGeneration: 0 });
    assert.equal(db.catalogService.publication(namespace).index, null);
    assert.equal(outcome.ok, false, `sync returned success inside caller transaction: ${JSON.stringify(outcome)}; verified rollback removes its publication`);
});

test("audit: publication service must not acknowledge publication inside an outer transaction", t => {
    const { db, catalog } = fixture();
    t.after(async () => { if (db.db.isTransaction) db.db.exec("ROLLBACK"); await catalog.close(); db.close(); });
    catalog.replaceSnapshot([item()]);
    const epoch = db.catalogService.beginPublication(namespace);
    db.db.exec("BEGIN");
    assert.throws(() => db.catalogService.publishSnapshot(namespace, epoch, 1, "candidate", "digest"), /transaction|commit/);
});

test("audit: a transaction opened during discovery must not hide a committed external generation", async t => {
    const directory = await mkdtemp(join(tmpdir(), "amp-audit-read-snapshot-"));
    const path = join(directory, "catalog.sqlite");
    assert.equal(resolve(directory), directory);
    const dbA = new Database(path); const dbB = new Database(path);
    const remote = catalogSnapshotFixture();
    const catalog = new CatalogSearch({ namespace, catalog: dbA.catalogService, search: new ElasticsearchSearch({ client: remote.fakeClient }) });
    const entered = deferred(); const release = deferred();
    t.after(async () => { release.resolve(); if (dbA.db.isTransaction) dbA.db.exec("ROLLBACK"); await catalog.close(); dbA.close(); dbB.close(); await rm(directory, { recursive: true, force: true }); });
    catalog.replaceSnapshot([item()]); await catalog.sync();
    remote.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const discovery = catalog.discover(scope, "query");
    await entered.promise;
    dbA.db.exec("BEGIN");
    assert.equal(dbA.catalogService.state(namespace).generation, 1); // Establish connection A's old WAL read snapshot.
    dbB.catalogService.replaceSnapshot(namespace, [item("new externally committed metadata")]);
    assert.equal(dbB.catalogService.state(namespace).generation, 2);
    release.resolve();
    const outcome = await discovery.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    dbA.db.exec("ROLLBACK");
    assert.equal(dbA.catalogService.state(namespace).generation, 2);
    assert.equal(outcome.ok, false, `discovery returned generation-1 results after generation-2 external commit: ${JSON.stringify(outcome)}`);
});

test("audit: an aborted sync in the queue must stop waiting before the running discovery completes", async t => {
    const { db, remote, catalog } = fixture();
    const entered = deferred(); const release = deferred();
    t.after(async () => { release.resolve(); await catalog.close(); db.close(); });
    catalog.replaceSnapshot([item()]); await catalog.sync();
    remote.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const discovery = catalog.discover(scope, "query");
    await entered.promise;
    const epoch = db.catalogService.publication(namespace).epoch;
    const created = remote.requests.filter(request => request.method === "PUT" && !request.path.includes("/_")).length;
    const abort = new AbortController();
    const sync = catalog.sync({ signal: abort.signal });
    const rejected = assert.rejects(sync, /queued request aborted/);
    abort.abort(new Error("queued request aborted"));
    const cancelledWhileQueued = await settled(sync);
    release.resolve(); await discovery;
    await rejected;
    await catalog.discover(scope, "queue barrier");
    assert.equal(db.catalogService.publication(namespace).epoch, epoch);
    assert.equal(remote.requests.filter(request => request.method === "PUT" && !request.path.includes("/_")).length, created);
    assert.equal(cancelledWhileQueued, true, "aborted sync did not settle until unrelated discovery released the queue");
});

test("audit: timeout bounds waiting for sync while a discovery holds the queue", async t => {
    const { db, remote, catalog } = fixture();
    const entered = deferred(); const release = deferred();
    t.after(async () => { release.resolve(); await catalog.close(); db.close(); });
    catalog.replaceSnapshot([item()]); await catalog.sync();
    remote.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const discovery = catalog.discover(scope, "query"); await entered.promise;
    const epoch = db.catalogService.publication(namespace).epoch;
    const created = remote.requests.filter(request => request.method === "PUT" && !request.path.includes("/_")).length;
    const sync = catalog.sync({ timeoutMs: 5 });
    const outcome = sync.then(() => ({ ok: true, error: undefined }), error => ({ ok: false, error }));
    const timedOutWhileQueued = await settled(sync);
    release.resolve(); await discovery;
    const result = await outcome;
    await catalog.discover(scope, "queue barrier");
    assert.equal(db.catalogService.publication(namespace).epoch, epoch);
    assert.equal(remote.requests.filter(request => request.method === "PUT" && !request.path.includes("/_")).length, created);
    assert.equal(timedOutWhileQueued, true, "sync timeout starts only after it reaches the queue head");
    assert.equal(result.ok, false, "queued sync must reject after its caller deadline expires");
    assert.match(String(result.error), /timed out/);
});

test("audit: close drains accepted discovery, rejects later work, and blocks queued sync transport", async t => {
    const { db, remote, catalog } = fixture();
    const entered = deferred(); const release = deferred();
    t.after(async () => { release.resolve(); db.close(); });
    catalog.replaceSnapshot([item()]); await catalog.sync();
    remote.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const discovery = catalog.discover(scope, "query"); await entered.promise;
    const closing = catalog.close();
    const rejected = assert.rejects(catalog.sync(), /closed/);
    const before = remote.requests.length;
    assert.equal(await settled(closing), false);
    assert.equal(remote.requests.length, before);
    release.resolve(); await discovery; await closing; await rejected;
});

test("audit: replacing a generation across connections during discovery rejects old results", async t => {
    const directory = await mkdtemp(join(tmpdir(), "amp-audit-publication-"));
    const path = join(directory, "catalog.sqlite");
    assert.equal(resolve(directory), directory);
    const dbA = new Database(path); const dbB = new Database(path);
    const remote = catalogSnapshotFixture();
    const catalog = new CatalogSearch({ namespace, catalog: dbA.catalogService, search: new ElasticsearchSearch({ client: remote.fakeClient }) });
    const entered = deferred(); const release = deferred();
    t.after(async () => { release.resolve(); await catalog.close(); dbA.close(); dbB.close(); await rm(directory, { recursive: true, force: true }); });
    catalog.replaceSnapshot([item()]); await catalog.sync();
    remote.intercept(async request => { if (request.path.endsWith("/_search")) { entered.resolve(); await release.promise; } });
    const rejected = assert.rejects(catalog.discover(scope, "query"), /changed during discovery/);
    await entered.promise; dbB.catalogService.replaceSnapshot(namespace, [item("new")]); release.resolve(); await rejected;
});

test("audit: legacy lease recovery survives connection reopen and fences reused owner tokens", async t => {
    const directory = await mkdtemp(join(tmpdir(), "amp-audit-lease-")); const path = join(directory, "catalog.sqlite");
    assert.equal(resolve(directory), directory);
    const first = new Database(path);
    first.catalogService.replaceSnapshot(namespace, [item()]);
    const old = first.catalogService.acquireSync(namespace, "owner")!; first.close();
    const second = new Database(path);
    t.after(async () => { second.close(); await rm(directory, { recursive: true, force: true }); });
    assert.deepEqual(second.catalogService.syncLease(namespace), old);
    assert.equal(second.catalogService.acquireSync(namespace, "other"), undefined);
    assert.equal(second.catalogService.recoverSync(namespace, { lease: old, writerStopped: true, remoteWritesQuiesced: true }), true);
    const current = second.catalogService.acquireSync(namespace, "owner")!;
    assert.equal(current.revision, old.revision + 1);
    assert.equal(second.catalogService.releaseSync(namespace, old), false);
    assert.equal(second.catalogService.markSynced(namespace, 1, old), false);
    assert.equal(second.catalogService.invalidateSynced(namespace, old), false);
    assert.equal(second.catalogService.recoverSync(namespace, { lease: old, writerStopped: true, remoteWritesQuiesced: true }), false);
    assert.equal(second.catalogService.markSynced(namespace, 1, current), true);
    assert.equal(second.catalogService.releaseSync(namespace, current), true);
});

test("audit: publication epoch overflow must reject atomically without persisting an unsafe epoch", async t => {
    const { db, catalog } = fixture();
    t.after(async () => { await catalog.close(); db.close(); });
    catalog.replaceSnapshot([item()]);
    db.catalogService.beginPublication(namespace);
    withCatalogWrite(db.db, () => db.db.prepare("UPDATE catalog_search_publication SET epoch=? WHERE namespace=?").run(Number.MAX_SAFE_INTEGER, namespace));
    assert.throws(() => db.catalogService.beginPublication(namespace), /overflow|too large|CHECK constraint/);
    const statement = db.db.prepare("SELECT epoch FROM catalog_search_publication WHERE namespace=?");
    statement.setReadBigInts(true);
    const row = statement.get(namespace) as { epoch: bigint };
    assert.equal(row.epoch, BigInt(Number.MAX_SAFE_INTEGER), "failed beginPublication persisted an out-of-range fencing epoch");
});

test("audit: fresh publication epoch rejects older completed build without dirtying committed snapshot", async t => {
    const { db, remote, catalog } = fixture();
    t.after(async () => { await catalog.close(); db.close(); });
    catalog.replaceSnapshot([item()]); await catalog.sync();
    const published = db.catalogService.publication(namespace);
    const freshEpoch = db.catalogService.beginPublication(namespace);
    assert.equal(db.catalogService.publishSnapshot(namespace, published.epoch, 1, "stale", "stale"), false);
    assert.equal(db.catalogService.publication(namespace).index, published.index);
    assert.deepEqual(db.catalogService.state(namespace), { generation: 1, syncedGeneration: 1 });
    assert.equal(db.catalogService.publication(namespace).epoch, freshEpoch);
    assert.equal(remote.indices.get(published.index!)!.blocked, true);
    await tick();
});
