#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { catalogKey } from "../src/database/entity/catalog.ts";
import { Database } from "../src/database/service/database.ts";

const record = (id: string, extras: Partial<CatalogRecord> = {}): CatalogRecord => ({
    id,
    kind: "module.kind/from-anywhere",
    name: id,
    summary: "",
    payload: { nested: { value: 1 }, values: ["one"] },
    ...extras,
});

let passed = 0;
const test = (name: string, run: () => void): void => {
    run();
    passed += 1;
    console.log(`✓ ${name}`);
};

const db = new Database(":memory:");
try {
    test("snapshot round-trip, unresolved relations, namespace isolation and generation CAS", () => {
        const a = record("alpha", { relations: [{ relation: "depends_on", targetId: "not-yet-synced" }] });
        assert.equal(db.catalogService.replaceSnapshot("project-a", [a]), 1);
        db.catalogService.replaceSnapshot("project-b", [record("beta")]);
        assert.deepEqual(db.catalogService.read("project-a", a.kind, a.id), { ...a, tags: [], searchTerms: [] });
        assert.deepEqual(db.catalogService.relations("project-a", a.kind, a.id), [{ relation: "depends_on", targetId: "not-yet-synced" }]);
        assert.equal(db.catalogService.markSynced("project-a", 1), true);
        assert.deepEqual(db.catalogService.state("project-a"), { generation: 1, syncedGeneration: 1 });
        assert.equal(db.catalogService.replaceSnapshot("project-a", [record("next")]), 2);
        assert.equal(db.catalogService.markSynced("project-a", 1), false);
        assert.deepEqual(db.catalogService.state("project-a"), { generation: 2, syncedGeneration: 1 });
        assert.equal(db.catalogService.read("project-b", "module.kind/from-anywhere", "beta")?.id, "beta");
    });

    test("clean index can be marked dirty and acknowledged only by current generation", () => {
        const source = record("dirty");
        const generation = db.catalogService.replaceSnapshot("dirty-ns", [source]);
        assert.equal(db.catalogService.markSynced("dirty-ns", generation), true);
        db.catalogStore.readRecord("dirty-ns", source.kind, source.id);
        const key = catalogKey("dirty-ns", source.kind, source.id);
        assert.equal(db.catalogStore.contains(key), true);
        db.catalogService.invalidateSynced("dirty-ns");
        assert.deepEqual(db.catalogService.state("dirty-ns"), { generation, syncedGeneration: 0 });
        assert.equal(db.catalogStore.contains(key), true, "state-only invalidation must preserve entry cache");
        assert.equal(db.catalogService.markSynced("dirty-ns", generation + 1), false);
        assert.equal(db.catalogService.markSynced("dirty-ns", generation), true);
        assert.deepEqual(db.catalogService.state("dirty-ns"), { generation, syncedGeneration: generation });
        assert.throws(() => db.catalogService.invalidateSynced("  "), /namespace/);
    });

    test("generic service and repository writes cannot bypass catalog generation tracking", () => {
        const source = record("write-guard");
        db.catalogService.replaceSnapshot("guard", [source]);
        const key = catalogKey("guard", source.kind, source.id);
        const before = db.catalogService.list("guard");
        assert.throws(() => db.catalogService.insert({}), /replaceSnapshot/);
        assert.throws(() => db.catalogService.update(key, { name: "bypass" }), /replaceSnapshot/);
        assert.throws(() => db.catalogService.delete(key), /replaceSnapshot/);
        assert.throws(() => db.catalogService.upsert({ key }), /replaceSnapshot/);
        assert.throws(() => db.catalog.insert({}), /replaceSnapshot/);
        assert.throws(() => db.catalog.insertOrIgnore({}), /replaceSnapshot/);
        assert.throws(() => db.catalog.update(key, { name: "bypass" }), /replaceSnapshot/);
        assert.throws(() => db.catalog.updateWhere("namespace = ?", { name: "bypass" }, "guard"), /replaceSnapshot/);
        assert.throws(() => db.catalog.delete(key), /replaceSnapshot/);
        assert.throws(() => db.catalog.deleteWhere("namespace = ?", "guard"), /replaceSnapshot/);
        assert.throws(() => db.catalog.upsert({ key }), /replaceSnapshot/);
        assert.deepEqual(db.catalogService.list("guard"), before);
        assert.deepEqual(db.catalogService.state("guard"), { generation: 1, syncedGeneration: 0 });
    });

    test("cache never retains rows read inside an outer transaction that rolls back", () => {
        const source = record("rollback", { name: "committed" });
        const key = catalogKey("rollback-ns", source.kind, source.id);
        db.catalogService.replaceSnapshot("rollback-ns", [source]);
        db.catalogStore.readRecord("rollback-ns", source.kind, source.id);
        assert.throws(() => db.transaction(() => {
            db.catalogService.replaceSnapshot("rollback-ns", [record(source.id, { name: "uncommitted" })]);
            assert.equal(db.catalogStore.readRecord("rollback-ns", source.kind, source.id)?.name, "uncommitted");
            assert.equal(db.catalogStore.requireById(key).name, "uncommitted");
            assert.equal(db.catalogStore.contains(key), false);
            throw new Error("abort outer transaction");
        }), /abort outer transaction/);
        assert.equal(db.catalogStore.readRecord("rollback-ns", source.kind, source.id)?.name, "committed");
        assert.deepEqual(db.catalogService.state("rollback-ns"), { generation: 1, syncedGeneration: 0 });
    });

    test("JSON values are cloned and cache invalidates after successful replacement", () => {
        const input = record("clone");
        db.catalogService.replaceSnapshot("clone-ns", [input]);
        const first = db.catalogStore.readRecord("clone-ns", input.kind, input.id);
        assert.ok(first);
        (first.payload.nested as Record<string, unknown>).value = 99;
        assert.equal(db.catalogStore.readRecord("clone-ns", input.kind, input.id)?.payload.nested && (db.catalogStore.readRecord("clone-ns", input.kind, input.id)?.payload.nested as Record<string, unknown>).value, 1);
        db.catalogService.replaceSnapshot("clone-ns", [record("clone", { name: "updated" })]);
        assert.equal(db.catalogStore.readRecord("clone-ns", input.kind, input.id)?.name, "updated");
        assert.equal(db.catalogStore.contains(catalogKey("clone-ns", input.kind, input.id)), true);
    });

    test("validation rejects duplicate records and non-JSON payload before mutation", () => {
        db.catalogService.replaceSnapshot("validate", [record("kept")]);
        assert.throws(() => db.catalogService.replaceSnapshot("validate", [record("dup"), record("dup")]), /duplicate catalog record/);
        const invalid = record("bad");
        invalid.payload.self = invalid.payload;
        assert.throws(() => db.catalogService.replaceSnapshot("validate", [invalid]), /cycle/);
        assert.equal(db.catalogService.list("validate")[0]?.id, "kept");
    });

    test("SQL failure rolls back deleted rows, relation cascade, and generation", () => {
        db.catalogService.replaceSnapshot("atomic", [record("before", { relations: [{ relation: "links", targetId: "external" }] })]);
        db.db.exec("CREATE TRIGGER fail_catalog_insert BEFORE INSERT ON catalog_entries WHEN NEW.id = 'fail' BEGIN SELECT RAISE(ABORT, 'forced catalog failure'); END");
        assert.throws(() => db.catalogService.replaceSnapshot("atomic", [record("fail")]), /forced catalog failure/);
        db.db.exec("DROP TRIGGER fail_catalog_insert");
        assert.equal(db.catalogService.list("atomic")[0]?.id, "before");
        assert.deepEqual(db.catalogService.relations("atomic", "module.kind/from-anywhere", "before"), [{ relation: "links", targetId: "external" }]);
        assert.deepEqual(db.catalogService.state("atomic"), { generation: 1, syncedGeneration: 0 });
        assert.throws(() => db.db.prepare("DELETE FROM catalog_entries WHERE key = ?").run(catalogKey("atomic", "module.kind/from-anywhere", "before")), /CatalogService/);
        assert.equal(db.catalogService.relations("atomic", "module.kind/from-anywhere", "before").length, 1);
        db.catalogService.replaceSnapshot("atomic", []);
        assert.equal(db.catalogService.relations("atomic", "module.kind/from-anywhere", "before").length, 0);
    });

    test("foreign namespace relations cannot point to another entry", () => {
        const row = db.catalog.findById(catalogKey("project-b", "module.kind/from-anywhere", "beta"));
        assert.ok(row);
        assert.throws(() => db.db.prepare(
            "INSERT INTO catalog_relations (key, namespace, source_key, relation, target_id) VALUES (?, ?, ?, ?, ?)",
        ).run("bad-relation", "project-a", row.key, "bad", "x"));
    });
} finally {
    db.close();
}

const directory = mkdtempSync(join(tmpdir(), "catalog-persistence-"));
const path = join(directory, "catalog.sqlite");
try {
    test("file database persists catalog rows and sync state after reopen", () => {
        const first = new Database(path);
        first.catalogService.replaceSnapshot("durable", [record("saved", { tags: ["tag"], searchTerms: ["term"] })]);
        first.catalogService.markSynced("durable", 1);
        first.close();
        const reopened = new Database(path);
        try {
            assert.equal(reopened.catalogService.read("durable", "module.kind/from-anywhere", "saved")?.payload.values instanceof Array, true);
            assert.deepEqual(reopened.catalogService.state("durable"), { generation: 1, syncedGeneration: 1 });
            reopened.catalogService.invalidateSynced("durable");
        } finally {
            reopened.close();
        }
        const dirtyReopened = new Database(path);
        try {
            assert.deepEqual(dirtyReopened.catalogService.state("durable"), { generation: 1, syncedGeneration: 0 });
            assert.equal(dirtyReopened.catalogService.markSynced("durable", 1), true);
        } finally {
            dirtyReopened.close();
        }
    });
} finally {
    rmSync(directory, { recursive: true, force: true });
}

console.log(`\n${passed} catalog persistence checks passed`);
