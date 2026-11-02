#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TableSql } from "../src/database/sql/sql.ts";
import { CatalogEntryTable } from "../src/database/entity/catalog.ts";

import { catalogKey } from "../src/database/entity/catalog.ts";
import { CatalogRepository } from "../src/database/repository/catalogRepository.ts";
import { CatalogPublicationRepository } from "../src/database/repository/catalogPublication.ts";
import { Database } from "../src/database/service/database.ts";
import { withCatalogWrite } from "../src/database/store/catalogGuard.ts";

let passed = 0;
let asyncContinuationError: unknown;
const test = (name: string, run: () => void): void => {
    run();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
};
const record = (id: string, extra: Record<string, unknown> = {}) => ({
    id, kind: "kind/with:delimiters", name: id, summary: "", payload: { ok: true }, ...extra,
});
const db = new Database(":memory:");
try {
    test("ordinary direct DML denied for every guarded catalog table and verb", () => {
        db.catalogService.replaceSnapshot("guard", [record("entry", { relations: [{ relation: "r", targetId: "t" }] })]);
        db.catalogService.acquireSync("guard", "audit-owner");
        db.catalogService.beginPublication("guard");
        const key = catalogKey("guard", "kind/with:delimiters", "entry");
        const sql = [
            ["INSERT INTO catalog_entries(key,namespace,id,kind,name,summary,tags_json,search_terms_json,payload_json,updated_at) VALUES ('x','guard','x','k','x','','[]','[]','{}','now')", []],
            ["UPDATE catalog_entries SET name='changed' WHERE key=?", [key]],
            ["DELETE FROM catalog_entries WHERE key=?", [key]],
            ["INSERT INTO catalog_relations(key,namespace,source_key,relation,target_id) VALUES ('x','guard',?,'r','t')", [key]],
            ["UPDATE catalog_relations SET target_id='changed'", []], ["DELETE FROM catalog_relations", []],
            ["INSERT INTO catalog_sync_state(namespace,generation,synced_generation) VALUES ('x',0,0)", []],
            ["UPDATE catalog_sync_state SET synced_generation=0 WHERE namespace='guard'", []],
            ["DELETE FROM catalog_sync_state WHERE namespace='guard'", []],
            ["INSERT INTO catalog_sync_ownership(namespace,owner_token,revision) VALUES ('guard','x',1)", []],
            ["UPDATE catalog_sync_ownership SET owner_token='x' WHERE namespace='guard'", []],
            ["DELETE FROM catalog_sync_ownership WHERE namespace='guard'", []],
            ["INSERT INTO catalog_search_publication(namespace,epoch) VALUES ('guard',1)", []],
        ] as const;
        for (const [statement, params] of sql) assert.throws(() => db.db.prepare(statement).run(...params), /CatalogService/);
        assert.throws(() => db.db.exec("UPDATE catalog_search_publication SET epoch=epoch+1"), /CatalogService/);
        assert.throws(() => db.db.exec("DELETE FROM catalog_search_publication"), /CatalogService/);
        assert.throws(() => db.catalog.insert({}), /replaceSnapshot/);
        assert.throws(() => db.catalog.insertOrIgnore({}), /replaceSnapshot/);
        assert.throws(() => db.catalog.update(key, { name: "x" }), /replaceSnapshot/);
        assert.throws(() => db.catalog.updateWhere("namespace=?", { name: "x" }, "guard"), /replaceSnapshot/);
        assert.throws(() => db.catalog.delete(key), /replaceSnapshot/);
        assert.throws(() => db.catalog.deleteWhere("namespace=?", "guard"), /replaceSnapshot/);
        assert.throws(() => db.catalog.upsert({ key }), /replaceSnapshot/);
        assert.throws(() => new TableSql(db.db, CatalogEntryTable).update(key, { name: "x" }), /CatalogService/);
        assert.throws(() => new CatalogRepository(db.db).delete(key), /replaceSnapshot/);
        assert.equal(db.catalogService.read("guard", "kind/with:delimiters", "entry")?.name, "entry");
    });

    test("prepared SQL cannot be authorized before a later run", () => {
        db.catalogService.replaceSnapshot("prepared", [record("kept")]);
        const statement = db.db.prepare("DELETE FROM catalog_entries WHERE namespace=?");
        assert.throws(() => statement.run("prepared"), /CatalogService/);
        db.catalogService.replaceSnapshot("unrelated", [record("temporary")]);
        assert.throws(() => statement.run("prepared"), /CatalogService/);
        assert.equal(db.catalogService.list("prepared").length, 1);
    });

    test("metadata replacement cannot bypass ordinary CRUD guard", () => {
        assert.throws(() => db.db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql=sql WHERE name='catalog_entries'"));
        assert.throws(() => db.db.prepare("UPDATE catalog_entries SET name='x'").run(), /CatalogService/);
    });

    test("strict repository snapshot rejects incomplete, extra, mismatched and duplicate rows before mutation", () => {
        const repository = db.catalog;
        const generation = db.catalogService.replaceSnapshot("strict", [record("keep")]);
        const valid = repository.listNamespace("strict")[0]!;
        const relation = { key: JSON.stringify([valid.key, "r", "target"]), namespace: "strict", source_key: valid.key, relation: "r", target_id: "target" };
        assert.throws(() => repository.replaceSnapshot("strict", [{ ...valid, unrecognized_metadata: 1 } as never], []), /complete entities/);
        assert.throws(() => repository.replaceSnapshot("strict", [{ ...valid, namespace: "other" }], []), /namespace/);
        assert.throws(() => repository.replaceSnapshot("strict", [valid, valid], []), /duplicate catalog record/);
        assert.throws(() => repository.replaceSnapshot("strict", [valid], [{ ...relation, namespace: "other" }]), /source/);
        assert.throws(() => repository.replaceSnapshot("strict", [valid], [relation, relation]), /duplicate catalog relation/);
        assert.equal(db.catalogService.state("strict").generation, generation);
        assert.equal(db.catalogService.list("strict")[0]?.id, "keep");
    });

    test("namespace tuple keys isolate delimiter-heavy identities", () => {
        const firstNamespace = "ns|:[\\\"a\\\",b]";
        const secondNamespace = "ns|:[\\\"a\\\",b]x";
        db.catalogService.replaceSnapshot(firstNamespace, [record("id|x")]);
        db.catalogService.replaceSnapshot(secondNamespace, [record("id|x")]);
        assert.notEqual(catalogKey(firstNamespace, "kind/with:delimiters", "id|x"), catalogKey(secondNamespace, "kind/with:delimiters", "id|x"));
        assert.equal(db.catalogService.read(firstNamespace, "kind/with:delimiters", "id|x")?.id, "id|x");
        assert.equal(db.catalogService.read(secondNamespace, "kind/with:delimiters", "id|x")?.id, "id|x");
        assert.equal(db.catalogService.read("missing", "kind/with:delimiters", "id|x"), undefined);
    });

    test("async capability callback is rejected and its continuation cannot write", () => {
        // The internal helper is exercised as a trusted implementation contract, not a public DML interface.
        assert.throws(() => withCatalogWrite(db.db, async () => 1), /synchronous/);
        assert.throws(() => withCatalogWrite(db.db, () => ({ then: Promise.resolve.bind(Promise) })), /synchronous/);
        assert.throws(() => withCatalogWrite(db.db, () => {
            queueMicrotask(() => {
                try { db.db.prepare("UPDATE catalog_sync_state SET synced_generation=0").run(); }
                catch (error) { asyncContinuationError = error; }
            });
            return Promise.resolve();
        }), /synchronous/);
        assert.throws(() => db.db.prepare("UPDATE catalog_sync_state SET synced_generation=0").run(), /CatalogService/);
    });

    test("rollback and nested savepoint do not retain cache rows", () => {
        const initial = record("item", { name: "committed" });
        db.catalogService.replaceSnapshot("cache", [initial]);
        const key = catalogKey("cache", initial.kind, initial.id);
        assert.throws(() => db.transaction(() => {
            db.catalogService.replaceSnapshot("cache", [record("item", { name: "temporary" })]);
            assert.equal(db.catalogStore.requireById(key).name, "temporary");
            throw Error("rollback");
        }), /rollback/);
        assert.equal(db.catalogStore.readRecord("cache", initial.kind, initial.id)?.name, "committed");
        db.transaction(() => {
            db.catalogService.replaceSnapshot("cache", [record("item", { name: "savepoint" })]);
            assert.equal(db.catalogStore.readRecord("cache", initial.kind, initial.id)?.name, "savepoint");
        });
        assert.equal(db.catalogStore.readRecord("cache", initial.kind, initial.id)?.name, "savepoint");
    });

    test("separate connection observes committed generation and invalidates resident cache", () => {
        const directory = mkdtempSync(join(tmpdir(), "catalog-guard-audit-"));
        const path = join(directory, "catalog.sqlite");
        const first = new Database(path);
        const second = new Database(path);
        try {
            first.catalogService.replaceSnapshot("cross", [record("item", { name: "old" })]);
            const key = catalogKey("cross", "kind/with:delimiters", "item");
            assert.equal(first.catalogStore.requireById(key).name, "old");
            second.catalogService.replaceSnapshot("cross", [record("item", { name: "new" })]);
            assert.equal(first.catalogStore.requireById(key).name, "new");
            assert.equal(first.catalogService.state("cross").generation, 2);
            const raw = new DatabaseSync(path);
            try {
                assert.throws(() => raw.prepare("UPDATE catalog_entries SET name='unauthorized'").run(), /amp_catalog_write_allowed/);
            } finally { raw.close(); }
        } finally {
            first.close();
            second.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("generation overflow rejects replacement atomically", () => {
        db.catalogService.replaceSnapshot("overflow", [record("keep")]);
        withCatalogWrite(db.db, () => db.db.prepare("UPDATE catalog_sync_state SET generation=? WHERE namespace=?").run(Number.MAX_SAFE_INTEGER, "overflow"));
        assert.throws(() => db.catalogService.replaceSnapshot("overflow", [record("new")]), /safe integer/);
        assert.equal(db.catalogService.list("overflow")[0]?.id, "keep");
        assert.equal(db.catalogService.state("overflow").generation, Number.MAX_SAFE_INTEGER);
    });

    test("publication epoch and generation compare-and-swap reject stale attempts", () => {
        db.catalogService.replaceSnapshot("publish", [record("one")]);
        const publication = new CatalogPublicationRepository(db.db);
        const epoch1 = db.catalogService.beginPublication("publish");
        assert.equal(db.catalogService.publishSnapshot("publish", epoch1, 1, "idx-a", "digest-a"), true);
        const epoch2 = db.catalogService.beginPublication("publish");
        assert.ok(epoch2 > epoch1);
        assert.equal(db.catalogService.publishSnapshot("publish", epoch1, 1, "idx-stale", "digest-stale"), false);
        assert.equal(db.catalogService.publishSnapshot("publish", epoch2, 999, "idx-wrong-generation", "d"), false);
        assert.equal(publication.read("publish").index, "idx-a");
        assert.equal(db.catalogService.replaceSnapshot("publish", [record("two")]), 2);
        assert.equal(db.catalogService.publishSnapshot("publish", epoch2, 1, "idx-old-generation", "d"), false);
        assert.equal(publication.read("publish").generation, 1);
        assert.equal(db.catalogService.publication("missing").epoch, 0);
        assert.throws(() => db.catalogService.beginPublication("missing"), /no persisted snapshot/);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(String(asyncContinuationError), /CatalogService/);
} finally {
    db.close();
}
console.log(`1..${passed}`);
console.log(`${passed} catalog guard audit checks passed`);
