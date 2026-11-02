#!/usr/bin/env node
/** Independent adversarial reproductions; deliberately does not alter implementation. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Client } from "@elastic/elasticsearch";
import { Database } from "../src/database/service/database.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { CatalogSearch, catalogSearchId } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import { catalogSnapshotFixture, deferred } from "./helpers/catalogSnapshotFixture.ts";

const ns = "boundary";
const doc = (kind: string, id: string, relations: CatalogRecord["relations"] = []): CatalogRecord => ({
    id, kind, name: `${kind}:${id}`, summary: "", projectId: "project-a", revision: "r1", tags: [], searchTerms: [], payload: {}, relations,
});

test("a raw ambiguous relation target is not expanded to multiple kinds", async t => {
    const root = doc("knowledge", "root", [{ relation: "points_to", targetId: "same-id" }]);
    const remote = catalogSnapshotFixture();
    remote.setSearch(index => {
        const id = catalogSearchId(ns, root.kind, root.id);
        return { hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: id, _score: 1, _source: index.documents.get(id) }] }, took: 1, timed_out: false };
    });
    const db = new Database(":memory:");
    const catalog = new CatalogSearch({ namespace: ns, catalog: db.catalogService, cache: db.catalogStore, search: new ElasticsearchSearch({ client: remote.fakeClient }) });
    t.after(async () => { await catalog.close(); db.close(); });
    catalog.replaceSnapshot([root, doc("skill", "same-id"), doc("knowledge", "same-id")]);
    await catalog.sync();
    const result = await catalog.discover({ projectIds: ["project-a"] }, "query");
    assert.deepEqual(result.trees[0].tree.children, []);
    assert.equal(result.trees[0].truncated, true);
});

test("a second SQLite connection cannot leave discover metadata stale after generation sync", async t => {
    const directory = await mkdtemp(join(tmpdir(), "catalog-cache-boundary-"));
    const dbPath = join(directory, "catalog.sqlite");
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    const remote = catalogSnapshotFixture();
    const make = (db: Database) => new CatalogSearch({ namespace: ns, catalog: db.catalogService, cache: db.catalogStore, search: new ElasticsearchSearch({ client: remote.fakeClient }) });
    const oldCoordinator = make(dbA);
    const writer = make(dbB);
    t.after(async () => {
        await Promise.allSettled([oldCoordinator.close(), writer.close()]);
        dbA.close(); dbB.close(); await rm(directory, { recursive: true, force: true });
    });
    oldCoordinator.replaceSnapshot([doc("knowledge", "stable-id")]);
    await oldCoordinator.sync();
    const oldHit = await oldCoordinator.discover({ projectIds: ["project-a"] }, "q");
    assert.equal(oldHit.trees[0].tree.label, "knowledge:stable-id");
    writer.replaceSnapshot([{ ...doc("knowledge", "stable-id"), name: "New metadata after external generation" }]);
    await writer.sync();
    const current = await oldCoordinator.discover({ projectIds: ["project-a"] }, "q");
    assert.equal(dbA.catalogService.state(ns).generation, dbA.catalogService.state(ns).syncedGeneration);
    assert.equal(current.trees[0].tree.label, "New metadata after external generation");
});

test("an alias target is rejected before bound index access", async () => {
    let deletedIndex = "";
    const fakeClient = {
        indices: {
            exists: async () => true,
            resolveIndex: async ({ name }: { name: string }) => ({ indices: [], aliases: [{ name, indices: ["shared-search-000001"] }], data_streams: [] }),
        },
        search: async () => { deletedIndex = "searched"; return {}; },

        close: async () => {},
    } as unknown as Client;
    const adapter = new ElasticsearchSearch({ client: fakeClient, index: "shared-search-alias", namespace: ns });
    await assert.rejects(adapter.search({ projectIds: ["project-a"] }), /concrete index/);
    assert.equal(deletedIndex, "");
});

test("cross-connection independent builds publish the new generation and fence the older attempt", async t => {
    const directory = await mkdtemp(join(tmpdir(), "catalog-boundary-"));
    const dbPath = join(directory, "catalog.sqlite");
    const dbA = new Database(dbPath);
    const dbB = new Database(dbPath);
    const oldRemote = catalogSnapshotFixture();
    const freshRemote = catalogSnapshotFixture(oldRemote.indices);
    const entered = deferred();
    const release = deferred();
    oldRemote.intercept(async request => { if (request.path.endsWith("/_bulk")) { entered.resolve(); await release.promise; } });
    const old = new CatalogSearch({ namespace: ns, catalog: dbA.catalogService, cache: dbA.catalogStore, search: new ElasticsearchSearch({ client: oldRemote.fakeClient }) });
    const fresh = new CatalogSearch({ namespace: ns, catalog: dbB.catalogService, cache: dbB.catalogStore, search: new ElasticsearchSearch({ client: freshRemote.fakeClient }) });
    t.after(async () => {
        release.resolve(); await Promise.allSettled([old.close(), fresh.close()]);
        dbA.close(); dbB.close(); await rm(directory, { recursive: true, force: true });
    });
    old.replaceSnapshot([doc("knowledge", "old")]);
    const oldRejected = assert.rejects(old.sync(), /changed during synchronization/);
    await entered.promise;
    fresh.replaceSnapshot([doc("knowledge", "new")]);
    assert.deepEqual(await fresh.sync(), { generation: 2, syncedGeneration: 2 });
    const publication = dbB.catalogService.publication(ns);
    assert.deepEqual((await fresh.discover({ projectIds: ["project-a"] }, "query")).trees.map(tree => tree.tree.id), ["new"]);
    release.resolve();
    await oldRejected;
    assert.deepEqual(dbB.catalogService.publication(ns), publication, "late old completion cannot replace the publication");
    assert.equal(oldRemote.indices.size, 2);
    const published = oldRemote.indices.get(publication.index!)!;
    assert.equal(published.documents.has(catalogSearchId(ns, "knowledge", "old")), false);
    assert.equal(published.documents.has(catalogSearchId(ns, "knowledge", "new")), true);
    assert.equal(published.blocked, true);
});
