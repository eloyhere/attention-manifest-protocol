#!/usr/bin/env node
/** Isolated snapshots, durable publication fencing and safe retry regressions. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { Database } from "../src/database/service/database.ts";
import { CatalogSearch } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import { catalogSnapshotFixture, deferred } from "./helpers/catalogSnapshotFixture.ts";
import type { SnapshotIndex } from "./helpers/catalogSnapshotFixture.ts";

const namespace = "sync-ownership-boundary";
const scope = { projectIds: ["project"] };
const record = (id: string): CatalogRecord => ({ id, kind: "module", name: id, summary: "", projectId: "project", revision: "r1", payload: {} });
const coordinator = (db: Database, remote = catalogSnapshotFixture()) => new CatalogSearch({
    namespace, catalog: db.catalogService, cache: db.catalogStore, search: new ElasticsearchSearch({ client: remote.fakeClient }),
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("parallel coordinators build independent snapshots and later-started epoch fences the first", async t => {
    const directory = await mkdtemp(join(tmpdir(), "catalog-sync-ownership-"));
    const path = join(directory, "catalog.sqlite");
    const dbA = new Database(path);
    const dbB = new Database(path);
    const remoteA = catalogSnapshotFixture();
    const remoteB = catalogSnapshotFixture(remoteA.indices);
    const entered = deferred();
    const release = deferred();
    remoteA.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    const first = coordinator(dbA, remoteA);
    const second = coordinator(dbB, remoteB);
    t.after(async () => {
        release.resolve(); await Promise.allSettled([first.close(), second.close()]);
        dbA.close(); dbB.close(); await rm(directory, { recursive: true, force: true });
    });
    first.replaceSnapshot([record("item")]);
    const rejected = assert.rejects(first.sync(), /changed during synchronization/);
    await entered.promise;
    assert.deepEqual(await second.sync(), { generation: 1, syncedGeneration: 1 });
    const published = dbB.catalogService.publication(namespace);
    assert.equal(published.epoch, 2);
    assert.deepEqual((await second.discover(scope, "query")).trees.map(tree => tree.tree.id), ["item"]);
    release.resolve(); await rejected;
    assert.deepEqual(dbA.catalogService.publication(namespace), published);
    assert.equal(remoteA.indices.size, 2);
    assert.ok([...remoteA.indices.values()].every(index => index.blocked));
    assert.equal(remoteA.requests.some(request => request.path.endsWith("/_delete_by_query")), false);
});

test("a later failed attempt still fences an earlier build and retry publishes a fresh index", async t => {
    const db = new Database(":memory:");
    const remoteA = catalogSnapshotFixture();
    const remoteB = catalogSnapshotFixture(remoteA.indices);
    const entered = deferred();
    const release = deferred();
    remoteA.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    remoteB.setFailBulk(true);
    const first = coordinator(db, remoteA);
    const second = coordinator(db, remoteB);
    t.after(async () => { release.resolve(); await Promise.allSettled([first.close(), second.close()]); db.close(); });
    first.replaceSnapshot([record("item")]);
    const oldRejected = assert.rejects(first.sync(), /changed during synchronization/);
    await entered.promise;
    await assert.rejects(second.sync(), /incomplete/);
    release.resolve(); await oldRejected;
    assert.equal(db.catalogService.publication(namespace).index, null);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 0);
    remoteB.setFailBulk(false);
    await second.sync();
    assert.equal(remoteA.indices.size, 3);
    assert.equal(db.catalogService.publication(namespace).epoch, 3);
});

test("transport rejection permits immediate retry while a server-side orphan write completes later", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const first = coordinator(db, remote);
    const lateWrite = deferred();
    let orphan: SnapshotIndex | undefined;
    let remoteTask = Promise.resolve();
    let firstBulk = true;
    remote.intercept(async request => {
        if (!firstBulk || !request.path.endsWith("/_bulk")) return;
        firstBulk = false;
        orphan = remote.indices.get(request.path.split("/")[1]);
        const lines = structuredClone(request.lines);
        remoteTask = lateWrite.promise.then(() => {
            for (let i = 0; i < lines.length; i += 2) orphan!.documents.set(lines[i].index._id, lines[i + 1]);
        });
        throw new Error("transport failure");
    });
    t.after(async () => { lateWrite.resolve(); await remoteTask; await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]);
    await assert.rejects(first.sync(), /transport failure|outcome is unknown/);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 0);
    assert.equal(db.catalogService.syncStatus(namespace).owned, false);
    await first.sync();
    const published = db.catalogService.publication(namespace);
    lateWrite.resolve(); await remoteTask;
    assert.deepEqual(db.catalogService.publication(namespace), published);
    assert.notEqual(remote.indices.get(published.index!), orphan);
    assert.deepEqual((await first.discover(scope, "query")).trees.map(tree => tree.tree.id), ["item"]);
});

test("an interrupted publication survives reopen and a new sync needs no recovery", async t => {
    const directory = await mkdtemp(join(tmpdir(), "catalog-sync-crash-"));
    const path = join(directory, "catalog.sqlite");
    const remote = catalogSnapshotFixture();
    const beforeCrash = new Database(path);
    const first = coordinator(beforeCrash, remote);
    first.replaceSnapshot([record("item")]);
    await first.sync();
    const original = beforeCrash.catalogService.publication(namespace);
    const interruptedEpoch = beforeCrash.catalogService.beginPublication(namespace);
    await first.close(); beforeCrash.close();
    const reopened = new Database(path);
    const next = coordinator(reopened, remote);
    t.after(async () => { await next.close(); reopened.close(); await rm(directory, { recursive: true, force: true }); });
    assert.equal(reopened.catalogService.publication(namespace).epoch, interruptedEpoch);
    assert.deepEqual((await next.discover(scope, "query")).trees.map(tree => tree.tree.id), ["item"]);
    await next.sync();
    const current = reopened.catalogService.publication(namespace);
    assert.equal(current.epoch, interruptedEpoch + 1);
    assert.notEqual(current.index, original.index);
    assert.equal(reopened.catalogService.publishSnapshot(namespace, interruptedEpoch, 1, original.index!, original.digest!), false);
});

test("timeout during create allows immediate retry and late response starts no later stages", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const entered = deferred();
    const release = deferred();
    let delayed = true;
    remote.intercept(async request => {
        if (delayed && request.method === "PUT" && !request.path.includes("/_")) {
            delayed = false; entered.resolve(); await release.promise;
        }
    });
    const first = coordinator(db, remote);
    t.after(async () => { release.resolve(); await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]);
    const pending = assert.rejects(first.sync({ timeoutMs: 25 }), /timed out/);
    await entered.promise; await pending;
    await first.sync();
    const published = db.catalogService.publication(namespace);
    release.resolve(); await tick();
    assert.deepEqual(db.catalogService.publication(namespace), published);
    assert.equal(remote.requests.filter(request => request.path.endsWith("/_bulk")).length, 1);
    assert.equal(remote.indices.size, 2);
});

test("abort during bulk permits retry and late bulk success cannot publish or seal the orphan", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const entered = deferred();
    const release = deferred();
    let delayed = true;
    let orphanName = "";
    remote.intercept(async request => {
        if (delayed && request.path.endsWith("/_bulk")) {
            delayed = false; orphanName = request.path.split("/")[1]; entered.resolve(); await release.promise;
        }
    });
    const first = coordinator(db, remote);
    const abort = new AbortController();
    t.after(async () => { release.resolve(); await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]);
    const rejected = assert.rejects(first.sync({ signal: abort.signal }), /caller aborted/);
    await entered.promise; abort.abort(new Error("caller aborted")); await rejected;
    await first.sync();
    const published = db.catalogService.publication(namespace);
    release.resolve(); await tick();
    assert.deepEqual(db.catalogService.publication(namespace), published);
    assert.equal(remote.indices.get(orphanName)!.blocked, false);
    assert.notEqual(published.index, orphanName);
});

test("pre-aborted and local projection failures start no publication or network request", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const first = coordinator(db, remote);
    t.after(async () => { await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]);
    const abort = new AbortController(); abort.abort(new Error("already aborted"));
    await assert.rejects(first.sync({ signal: abort.signal }), /already aborted/);
    const original = db.catalogService.list;
    db.catalogService.list = () => { throw new Error("local projection failed"); };
    await assert.rejects(first.sync(), /local projection failed/);
    db.catalogService.list = original;
    assert.equal(db.catalogService.publication(namespace).epoch, 0);
    assert.equal(remote.requests.length, 0);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 0);
    await first.sync();
});

test("known bulk item failures stay unpublished and safely retry; failed rebuild preserves prior publication", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const first = coordinator(db, remote);
    t.after(async () => { await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]);
    remote.setFailBulk(true);
    await assert.rejects(first.sync(), /incomplete/);
    assert.equal(db.catalogService.publication(namespace).index, null);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 0);
    remote.setFailBulk(false); await first.sync();
    const published = db.catalogService.publication(namespace);
    remote.setFailBulk(true); await assert.rejects(first.sync(), /incomplete/);
    const current = db.catalogService.publication(namespace);
    assert.equal(current.index, published.index);
    assert.equal(current.digest, published.digest);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 1);
    assert.equal((await first.discover(scope, "query")).trees.length, 1);
});

test("generation changes during completed bulk fail CAS and a later full sync publishes current records", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const entered = deferred();
    const release = deferred();
    remote.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    const first = coordinator(db, remote);
    t.after(async () => { release.resolve(); await first.close(); db.close(); });
    first.replaceSnapshot([record("first")]);
    const rejected = assert.rejects(first.sync(), /catalog changed/);
    await entered.promise; first.replaceSnapshot([record("second")]); release.resolve(); await rejected;
    assert.deepEqual(db.catalogService.state(namespace), { generation: 2, syncedGeneration: 0 });
    remote.intercept();
    assert.deepEqual(await first.sync(), { generation: 2, syncedGeneration: 2 });
    assert.deepEqual((await first.discover(scope, "q")).trees.map(tree => tree.tree.id), ["second"]);
});

test("sealing and full-data verification failures never publish and allow retry", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const first = coordinator(db, remote);
    t.after(async () => { await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]);
    for (const failure of ["seal", "count", "digest"]) {
        remote.intercept(async request => {
            if (failure === "seal" && request.path.endsWith("/_block/write")) throw new Error("seal transport failed");
            if (request.path.endsWith("/_count")) {
                const index = remote.indices.get(request.path.split("/")[1])!;
                if (failure === "count") index.documents.set("extra", { id: "extra" });
                if (failure === "digest") [...index.documents.values()][0].title = "corrupted";
            }
        });
        await assert.rejects(first.sync(), /seal transport|count mismatch|digest mismatch/);
        assert.equal(db.catalogService.publication(namespace).index, null);
    }
    remote.intercept(); await first.sync();
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 1);
});

test("discovery checks full data before and after search and rejects identity mismatches", async t => {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const first = coordinator(db, remote);
    t.after(async () => { await first.close(); db.close(); });
    first.replaceSnapshot([record("item")]); await first.sync();
    const index = remote.indices.get(db.catalogService.publication(namespace).index!)!;
    const [id, original] = [...index.documents.entries()][0];
    index.blocked = false;
    await assert.rejects(first.discover(scope, "q"), /not write-blocked/);
    index.blocked = true;
    index.documents.set("extra", { id: "extra" });
    await assert.rejects(first.discover(scope, "q"), /count mismatch/);
    index.documents.delete("extra");
    index.documents.set(id, { ...original, title: "corrupt before search" });
    await assert.rejects(first.discover(scope, "q"), /digest mismatch/);
    index.documents.set(id, original);
    remote.setSearch(state => {
        const source = structuredClone(state.documents.get(id)!);
        state.documents.set(id, { ...source, content: "corrupt after search" });
        return { took: 1, timed_out: false, hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: id, _source: source }] } };
    });
    await assert.rejects(first.discover(scope, "q"), /digest mismatch/);
    index.documents.set(id, original);
    remote.setSearch(() => ({ took: 1, timed_out: false, hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: "forged-id", _source: original }] } }));
    await assert.rejects(first.discover(scope, "q"), /identity mismatch/);
    remote.setSearch();
    assert.equal((await first.discover(scope, "q")).trees.length, 1);
});

test("legacy stale recovery cannot release or acknowledge a replacement lease with a reused owner token", t => {
    const db = new Database(":memory:");
    t.after(() => db.close());
    const recovery = (lease: NonNullable<ReturnType<typeof db.catalogService.syncLease>>) => ({ lease, writerStopped: true, remoteWritesQuiesced: true } as const);
    db.catalogService.replaceSnapshot(namespace, [record("item")]);
    const oldLease = db.catalogService.acquireSync(namespace, "same-owner-token")!;
    assert.throws(() => db.catalogService.recoverSync(namespace, undefined!), /stopped writer/);
    assert.throws(() => db.catalogService.recoverSync(namespace, { lease: oldLease, writerStopped: true, remoteWritesQuiesced: false } as never), /quiesced/);
    assert.equal(db.catalogService.recoverSync(namespace, recovery(oldLease)), true);
    const newLease = db.catalogService.acquireSync(namespace, "same-owner-token")!;
    assert.equal(newLease.revision, oldLease.revision + 1);
    assert.equal(db.catalogService.ownsSync(namespace, oldLease), false);
    assert.equal(db.catalogService.markSynced(namespace, 1, oldLease), false);
    assert.equal(db.catalogService.releaseSync(namespace, oldLease), false);
    assert.equal(db.catalogService.markSynced(namespace, 1, newLease), true);
    assert.equal(db.catalogService.invalidateSynced(namespace, oldLease), false);
    assert.equal(db.catalogService.recoverSync(namespace, recovery(oldLease)), false);
    assert.equal(db.catalogService.syncStatus(namespace).owned, true);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 1);
    assert.equal(db.catalogService.releaseSync(namespace, newLease), true);
    assert.equal(db.catalogService.recoverSync(namespace, recovery(oldLease)), false);
    assert.equal(db.catalogService.state(namespace).syncedGeneration, 1);
});
