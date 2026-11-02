#!/usr/bin/env node
/** Boundary characterization for catalog persistence. Run with: node --test tools/boundaryCatalogPersistenceCheck.ts */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { catalogKey } from "../src/database/entity/catalog.ts";
import { Database } from "../src/database/service/database.ts";
import { withCatalogWrite } from "../src/database/store/catalogGuard.ts";

const record = (id: string, extras: Partial<CatalogRecord> = {}): CatalogRecord => ({
    id,
    kind: "module",
    name: id,
    summary: "",
    payload: { detail: { value: 1 } },
    ...extras,
});

const database = (): Database => new Database(":memory:");

test("namespace tuples isolate delimiters, empty reads and sync state", (context) => {
    const db = database();
    context.after(() => db.close());
    const left = record("item", { kind: "a|b", payload: { value: "left" } });
    const right = record("item", { kind: "a", payload: { value: "right" } });
    db.catalogService.replaceSnapshot("ns|x", [left]);
    db.catalogService.replaceSnapshot("ns", [record("item", { kind: "b|x" }), right]);

    assert.equal(catalogKey("ns|x", "a|b", "item"), JSON.stringify(["ns|x", "a|b", "item"]));
    assert.notEqual(catalogKey("ns|x", "a|b", "item"), catalogKey("ns", "b|x", "item"));
    assert.deepEqual(db.catalogService.read("ns|x", "a|b", "item")?.payload, { value: "left" });
    assert.deepEqual(db.catalogService.read("ns", "a", "item")?.payload, { value: "right" });
    assert.equal(db.catalogService.read("ns|x", "missing", "item"), undefined);
    assert.deepEqual(db.catalogService.state("uninitialized"), { generation: 0, syncedGeneration: 0 });
    assert.throws(() => db.catalogService.list("  "), /namespace/);
    assert.throws(() => db.catalogService.relations("ns", "", "item"), /kind/);
});

test("nested replacement participates in outer transaction and rollback restores rows, relations and generation", (context) => {
    const db = database();
    context.after(() => db.close());
    const before = record("stable", { relations: [{ relation: "edge", targetId: "outside" }] });
    db.catalogService.replaceSnapshot("tx", [before]);
    assert.throws(() => db.transaction(() => {
        db.catalogService.replaceSnapshot("tx", [record("transient")]);
        assert.equal(db.catalogService.state("tx").generation, 2);
        assert.equal(db.catalogService.read("tx", "module", "transient")?.id, "transient");
        throw new Error("abort outer transaction");
    }), /abort outer transaction/);
    assert.deepEqual(db.catalogService.list("tx"), [{ ...before, tags: [], searchTerms: [] }]);
    assert.deepEqual(db.catalogService.relations("tx", "module", "stable"), [{ relation: "edge", targetId: "outside" }]);
    assert.deepEqual(db.catalogService.state("tx"), { generation: 1, syncedGeneration: 0 });
    assert.equal(db.catalogStore.contains(catalogKey("tx", "module", "stable")), false);
});

test("validation failure inside outer transaction leaves its prior writes intact", (context) => {
    const db = database();
    context.after(() => db.close());
    db.catalogService.replaceSnapshot("validation", [record("old")]);
    db.transaction(() => {
        assert.throws(() => db.catalogService.replaceSnapshot("validation", [record("new"), record("new")]), /duplicate catalog record/);
        assert.equal(db.catalogService.read("validation", "module", "old")?.id, "old");
    });
    assert.deepEqual(db.catalogService.state("validation"), { generation: 1, syncedGeneration: 0 });
});

test("repository snapshot rejects malformed JSON and JSON shapes before mutation", (context) => {
    const db = database();
    context.after(() => db.close());
    db.catalogService.replaceSnapshot("json", [record("bad-json")]);
    const key = catalogKey("json", "module", "bad-json");
    const row = db.catalog.findById(key);
    assert.ok(row);
    for (const patch of [
        { payload_json: "{" }, { tags_json: "not-json" }, { tags_json: "null" }, { tags_json: "[1]" },
        { search_terms_json: "null" }, { search_terms_json: "[null]" },
        { payload_json: "null" }, { payload_json: "[]" }, { payload_json: "1" }, { payload_json: '{"overflow":1e999}' },
    ]) {
        assert.throws(() => db.catalog.replaceSnapshot("json", [{ ...row, ...patch }], []), undefined, JSON.stringify(patch));
        assert.deepEqual(db.catalogService.state("json"), { generation: 1, syncedGeneration: 0 });
        assert.deepEqual(db.catalogService.read("json", "module", "bad-json")?.payload, { detail: { value: 1 } });
    }
});

test("repository generic CRUD rejects writes and preserves clean complete state", (context) => {
    const db = database();
    context.after(() => db.close());
    const item = record("row");
    db.catalogService.replaceSnapshot("repo", [item]);
    const key = catalogKey("repo", "module", "row");
    const row = db.catalog.findById(key);
    assert.ok(row);
    assert.throws(() => db.catalog.insert({ ...row, key: "", id: "" }));
    assert.throws(() => db.catalog.update(key, { namespace: "  " }));

    assert.throws(() => db.catalog.update(key, { name: "repository bypass" }), /replaceSnapshot/);
    assert.throws(() => db.catalog.insertOrIgnore({ ...row }), /replaceSnapshot/);
    assert.throws(() => db.catalog.upsert({ ...row }), /replaceSnapshot/);
    assert.throws(() => db.catalog.updateWhere("namespace = ?", { name: "bypass" }, "repo"), /replaceSnapshot/);
    assert.throws(() => db.catalog.deleteWhere("namespace = ?", "repo"), /replaceSnapshot/);
    assert.equal(db.catalogService.markSynced("repo", 1), true);
    assert.throws(() => db.catalog.delete(key), /replaceSnapshot/);
    assert.deepEqual(db.catalogService.state("repo"), { generation: 1, syncedGeneration: 1 });
    assert.equal(db.catalogService.read("repo", "module", "row")?.name, "row");
});

test("raw SQL corruption is refused before it can diverge from cached records", (context) => {
    const db = database();
    context.after(() => db.close());
    db.catalogService.replaceSnapshot("cache-corruption", [record("cached", { name: "valid" })]);
    const key = catalogKey("cache-corruption", "module", "cached");
    assert.equal(db.catalogStore.readRecord("cache-corruption", "module", "cached")?.name, "valid");
    assert.throws(() => db.db.prepare("UPDATE catalog_entries SET payload_json = ? WHERE key = ?").run("broken", key), /CatalogService/);
    assert.equal(db.catalogStore.readRecord("cache-corruption", "module", "cached")?.name, "valid");
    db.catalogStore.clear();
    assert.deepEqual(db.catalogStore.readRecord("cache-corruption", "module", "cached")?.payload, { detail: { value: 1 } });
});

test("relation source ownership is constrained, while unresolved targets are deliberately allowed", (context) => {
    const db = database();
    context.after(() => db.close());
    db.catalogService.replaceSnapshot("rel-a", [record("source", { relations: [{ relation: "external", targetId: "missing-target" }] })]);
    db.catalogService.replaceSnapshot("rel-b", [record("other")]);
    assert.deepEqual(db.catalogService.relations("rel-a", "module", "source"), [{ relation: "external", targetId: "missing-target" }]);
    const other = db.catalog.findById(catalogKey("rel-b", "module", "other"));
    assert.ok(other);
    assert.throws(() => db.db.prepare(
        "INSERT INTO catalog_relations (key, namespace, source_key, relation, target_id) VALUES (?, ?, ?, ?, ?)",
    ).run("wrong-owner", "rel-a", other.key, "cross", "target"));
    assert.throws(() => db.db.prepare(
        "INSERT INTO catalog_relations (key, namespace, source_key, relation, target_id) VALUES (?, ?, ?, ?, ?)",
    ).run("orphan", "rel-a", "missing-source", "orphan", "target"));
    assert.throws(() => db.db.prepare(
        "INSERT INTO catalog_relations (key, namespace, source_key, relation, target_id) VALUES (?, ?, ?, ?, ?)",
    ).run("duplicate", "rel-a", catalogKey("rel-a", "module", "source"), "external", "missing-target"));
});

test("generation CAS rejects stale and impossible acknowledgements; dirty state is durable", (context) => {
    const db = database();
    context.after(() => db.close());
    const generation = db.catalogService.replaceSnapshot("generation", [record("one")]);
    assert.equal(db.catalogService.markSynced("generation", generation - 1), false);
    assert.equal(db.catalogService.markSynced("generation", generation + 1), false);
    assert.throws(() => db.catalogService.markSynced("generation", -1), /generation/);
    assert.throws(() => db.catalogService.markSynced("generation", Number.MAX_SAFE_INTEGER + 1), /generation/);
    assert.equal(db.catalogService.markSynced("generation", generation), true);
    db.catalogService.invalidateSynced("generation");
    assert.deepEqual(db.catalogService.state("generation"), { generation, syncedGeneration: 0 });
    assert.equal(db.catalogService.markSynced("generation", generation), true);

    assert.throws(() => db.db.prepare("UPDATE catalog_sync_state SET generation = ? WHERE namespace = ?").run(Number.MAX_SAFE_INTEGER, "generation"), /CatalogService/);
    assert.deepEqual(db.catalogService.state("generation"), { generation, syncedGeneration: generation });
    assert.equal(db.catalogService.read("generation", "module", "one")?.id, "one");
});

test("direct repository replacement validates identity, ownership, metadata and relation keys", (context) => {
    const db = database();
    context.after(() => db.close());
    db.catalogService.replaceSnapshot("direct", [record("valid")]);
    const row = db.catalog.findById(catalogKey("direct", "module", "valid"));
    assert.ok(row);
    for (const patch of [
        { namespace: "different" }, { key: "forged" }, { id: "" }, { kind: " " }, { name: "" },
        { summary: null }, { project_id: 1 }, { revision: {} }, { source_uri: false }, { updated_at: "" },
        { unknown_metadata: "unexpected" },
    ]) {
        assert.throws(() => db.catalog.replaceSnapshot("direct", [{ ...row, ...patch } as typeof row], []));
    }
    assert.throws(() => db.catalog.replaceSnapshot(" ", [], []), /namespace/);
    assert.throws(() => db.catalog.replaceSnapshot("direct", [row, row], []), /duplicate/);
    const relation = { key: JSON.stringify([row.key, "external", "missing"]), namespace: "direct", source_key: row.key, relation: "external", target_id: "missing" };
    for (const patch of [{ key: "forged" }, { namespace: "other" }, { source_key: "absent" }, { relation: "" }, { target_id: " " }]) {
        assert.throws(() => db.catalog.replaceSnapshot("direct", [row], [{ ...relation, ...patch }]));
    }
    assert.throws(() => db.catalog.replaceSnapshot("direct", [row], [relation, relation]), /duplicate/);
    assert.deepEqual(db.catalogService.state("direct"), { generation: 1, syncedGeneration: 0 });
    assert.equal(db.catalogService.read("direct", "module", "valid")?.id, "valid");
});

test("all catalog table DML requires a permit, including prepared statements and transactions", (context) => {
    const db = database();
    context.after(() => db.close());
    db.catalogService.replaceSnapshot("raw", [record("source", { relations: [{ relation: "edge", targetId: "missing" }] })]);
    const lease = db.catalogService.acquireSync("raw", "owner");
    assert.ok(lease);
    withCatalogWrite(db.db, () => db.db.prepare("INSERT INTO catalog_search_publication (namespace, epoch) VALUES ('raw', 1)").run());
    for (const table of ["catalog_entries", "catalog_relations", "catalog_sync_state", "catalog_sync_ownership", "catalog_search_publication"]) {
        for (const sql of [`INSERT INTO ${table} SELECT * FROM ${table}`, `DELETE FROM ${table}`,
            `UPDATE ${table} SET namespace = namespace`]) {
            assert.throws(() => db.db.prepare(sql).run(), /CatalogService/, sql);
        }
    }
    const prepared = withCatalogWrite(db.db, () => db.db.prepare("UPDATE catalog_sync_state SET synced_generation = 1 WHERE namespace = 'raw'"));
    assert.throws(() => prepared.run(), /CatalogService/);
    assert.throws(() => db.transaction(() => prepared.run()), /CatalogService/);
    assert.equal(db.catalogService.releaseSync("raw", lease), true);
    assert.equal(db.catalogService.markSynced("raw", 1), true);
    assert.deepEqual(db.catalogService.state("raw"), { generation: 1, syncedGeneration: 1 });
});

test("internal permits nest, remain connection-local, and expire on throws and async results", (context) => {
    const db = database();
    const other = database();
    context.after(() => { db.close(); other.close(); });
    for (const store of [db, other]) store.catalogService.replaceSnapshot("permit", [record("source")]);
    const allowed = (): number => (db.db.prepare("SELECT amp_catalog_write_allowed() AS allowed").get() as { allowed: number }).allowed;
    assert.equal(allowed(), 0);
    withCatalogWrite(db.db, () => {
        assert.equal(allowed(), 1);
        withCatalogWrite(db.db, () => assert.equal(allowed(), 1));
        assert.equal(allowed(), 1);
        assert.throws(() => other.db.exec("DELETE FROM catalog_entries"), /CatalogService/);
    });
    assert.equal(allowed(), 0);
    assert.throws(() => withCatalogWrite(db.db, () => { throw new Error("permit failure"); }), /permit failure/);
    assert.equal(allowed(), 0);
    let invoked = false;
    assert.throws(() => withCatalogWrite(db.db, async () => { invoked = true; }), /synchronous/);
    assert.equal(invoked, false);
    assert.throws(() => withCatalogWrite(db.db, () => Promise.resolve()), /synchronous/);
    assert.equal(allowed(), 0);
    assert.throws(() => db.db.exec("DELETE FROM catalog_entries"), /CatalogService/);
});

test("approved direct repository replacements refresh cached rows without service notifications", (context) => {
    const db = database();
    context.after(() => db.close());
    const key = catalogKey("cache-repo", "module", "source");
    db.catalogService.replaceSnapshot("cache-repo", [record("source", { name: "before" })]);
    assert.equal(db.catalogStore.readRecord("cache-repo", "module", "source")?.name, "before");
    const row = db.catalog.findById(key);
    assert.ok(row);
    db.catalog.replaceSnapshot("cache-repo", [{ ...row, name: "after" }], []);
    assert.equal(db.catalogStore.requireById(key).name, "after");
    assert.equal(db.catalogStore.readRecord("cache-repo", "module", "source")?.name, "after");
    db.catalog.replaceSnapshot("cache-repo", [], []);
    assert.equal(db.catalogStore.contains(key), false);
    assert.equal(db.catalogStore.findById(key), undefined);
    assert.throws(() => db.catalogStore.requireById(key));
});

test("commits from another connection invalidate namespace cache generations", (context) => {
    const directory = mkdtempSync(join(tmpdir(), "catalog-cache-boundary-"));
    const path = join(directory, "catalog.sqlite");
    const first = new Database(path);
    const second = new Database(path);
    context.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
    const key = catalogKey("shared", "module", "source");
    first.catalogService.replaceSnapshot("shared", [record("source", { name: "before" })]);
    assert.equal(first.catalogStore.readRecord("shared", "module", "source")?.name, "before");
    second.catalogService.replaceSnapshot("shared", [record("source", { name: "after" })]);
    assert.equal(first.catalogStore.findById(key)?.name, "after");
    assert.equal(first.catalogStore.requireById(key).name, "after");
    second.catalogService.replaceSnapshot("shared", []);
    assert.equal(first.catalogStore.contains(key), false);
    assert.equal(first.catalogStore.readRecord("shared", "module", "source"), undefined);
});
