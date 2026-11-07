import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConnectionPool } from "../connection/index.ts";
import { Store } from "./store.ts";
import { openSqlite } from "../sql/index.ts";
import type { EntityKind } from "../entity/types.ts";

const kind: EntityKind = "store_meta";
let serial = 0;
function temporaryPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "amp-store-"));
    return join(directory, `case-${++serial}.sqlite`);
}
function cleanup(path: string): void {
    rmSync(join(path, ".."), { recursive: true, force: true });
}
function entity(id: string, patch: Record<string, unknown> = {}) {
    return { id, key: id, version: 0, updatedAt: "", payload: { nested: { value: 1 }, list: [1, 2] }, ...patch };
}
type TestEntity = ReturnType<typeof entity>;
function withStore(run: (store: Store, path: string) => void): void {
    const path = temporaryPath();
    const store = Store.open({ path });
    try { run(store, path); }
    finally { store.close(); cleanup(path); }
}

test("load is lazy and first property access hydrates from repository", () => withStore((store) => {
    store.save(kind, entity("lazy"));
    const loaded = Store.open({ path: store.path });
    try {
        const proxy = loaded.load<TestEntity>(kind, "lazy")!;
        assert.equal(proxy.id, "lazy");
        assert.equal(proxy.payload.nested.value, 1);
    } finally { loaded.close(); }
}));

test("same database shares identity proxy across stores", () => withStore((store) => {
    store.save(kind, entity("identity"));
    const another = Store.open({ path: store.path });
    try { assert.equal(store.load(kind, "identity"), another.load(kind, "identity")); }
    finally { another.close(); }
}));

test("save, get and list persist CRUD state", () => withStore((store) => {
    const saved = store.save(kind, entity("crud"));
    assert.equal(store.resolve<typeof saved>(kind, "crud").id, "crud");
    assert.equal(store.list(kind).some((value: any) => value.id === "crud"), true);
}));

test("save expectedVersion enforces optimistic compare-and-swap", () => withStore((store) => {
    store.save(kind, entity("cas"));
    assert.throws(() => store.save(kind, entity("cas"), { expectedVersion: 9 }), /version_conflict/);
}));

test("nested property writes persist through proxy", () => withStore((store) => {
    store.save(kind, entity("deep"));
    const value = store.load<any>(kind, "deep")!;
    value.payload.nested.value = 7;
    assert.equal(store.refresh<any>(kind, "deep").payload.nested.value, 7);
}));

test("array mutators persist through proxy", () => withStore((store) => {
    store.save(kind, entity("array"));
    const value = store.load<any>(kind, "array")!;
    value.payload.list.push(3);
    assert.deepEqual([...value.payload.list], [1, 2, 3]);
}));

test("property deletion persists through proxy", () => withStore((store) => {
    store.save(kind, entity("delete-prop"));
    const value = store.load<any>(kind, "delete-prop")!;
    delete value.payload.nested.value;
    assert.equal("value" in value.payload.nested, false);
}));

test("remove marks managed proxy removed and prevents resurrection", () => withStore((store) => {
    store.save(kind, entity("removed"));
    const proxy = store.load<any>(kind, "removed")!;
    assert.equal(store.remove(kind, "removed"), true);
    assert.throws(() => proxy.id, /not_found/);
}));

test("detach retains snapshot but makes mutations local", () => withStore((store) => {
    store.save(kind, entity("detached"));
    const old = store.load<any>(kind, "detached")!;
    store.detach(kind, "detached");
    old.payload.nested.value = 8;
    assert.equal(store.resolve<any>(kind, "detached").payload.nested.value, 1);
}));

test("refresh discards local persisted snapshot", () => withStore((store) => {
    store.save(kind, entity("refresh"));
    const value = store.load<any>(kind, "refresh")!;
    value.payload.nested.value = 6;
    assert.equal(store.refresh<any>(kind, "refresh").payload.nested.value, 6);
}));

test("events append and query", () => withStore((store) => {
    store.appendEvent("tested", { ok: true }, "event-1");
    assert.equal(store.events({ kind: "tested" })[0]?.entityId, "event-1");
}));

test("transaction commits nested entity write", () => withStore((store) => {
    store.transaction((tx) => tx.save(kind, entity("committed")));
    assert.equal(store.resolve<any>(kind, "committed").id, "committed");
}));

test("transaction rollback leaves no entity", () => withStore((store) => {
    assert.throws(() => store.transaction((tx) => { tx.save(kind, entity("rolled")); throw new Error("rollback"); }), /rollback/);
    assert.throws(() => store.resolve(kind, "rolled"), /not_found/);
}));

test("nested transaction uses savepoint rollback", () => withStore((store) => {
    store.transaction((tx) => {
        tx.save(kind, entity("outer"));
        assert.throws(() => tx.transaction((inner) => { inner.save(kind, entity("inner")); throw new Error("savepoint"); }), /savepoint/);
    });
    assert.equal(store.resolve<any>(kind, "outer").id, "outer");
    assert.throws(() => store.resolve(kind, "inner"), /not_found/);
}));

test("closed store rejects operations", () => {
    const path = temporaryPath();
    const store = Store.open({ path });
    store.close();
    assert.throws(() => store.load(kind, "closed"), /store is closed/);
    cleanup(path);
});

test("closing one store does not close another owner proxy", () => withStore((store) => {
    store.save(kind, entity("multi"));
    const second = Store.open({ path: store.path });
    const proxy = second.load<any>(kind, "multi")!;
    store.close();
    assert.equal(proxy.id, "multi");
    second.close();
    assert.throws(() => proxy.id, /store is closed/);
}));

test("stats report entities, events, identity and schema", () => withStore((store) => {
    store.save(kind, entity("stats"));
    store.appendEvent("stats-event", {});
    const stats = store.stats();
    assert.equal(stats.entities, 1);
    assert.equal(stats.events, 1);
    assert.equal(stats.identity, 1);
    assert.ok(stats.schemaVersion > 0);
}));

test("directory path resolves to store.sqlite", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-store-dir-"));
    const store = Store.open({ path: directory });
    try { assert.equal(store.path, join(directory, "store.sqlite")); }
    finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("connection pool transaction exposes SQL API and savepoint rollback", () => {
    const path = temporaryPath();
    const pool = createConnectionPool({ maxConnections: 1, open: () => openSqlite({ path }) });
    try {
        pool.withTransaction((transaction) => {
            transaction.exec("CREATE TABLE IF NOT EXISTS probe (value INTEGER)");
            transaction.run({ sql: "INSERT INTO probe(value) VALUES (?)", parameters: [1] });
            const point = transaction.savePoint("probe_point");
            transaction.query({ sql: "SELECT value FROM probe" });
            transaction.run({ sql: "INSERT INTO probe(value) VALUES (?)", parameters: [2] });
            point.rollback();
            assert.equal(transaction.query({ sql: "SELECT value FROM probe" }).length, 1);
        });
    } finally { pool.close(); cleanup(path); }
});
