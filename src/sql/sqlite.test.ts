import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CORE_MIGRATIONS, migrate, openSqlite, schemaVersion } from "./index.ts";

test("core migrations are idempotent and report the schema version", () => {
    const driver = openSqlite({ path: ":memory:" });
    try {
        assert.equal(schemaVersion(driver), 0);
        assert.equal(CORE_MIGRATIONS.length, 1);
        assert.equal(CORE_MIGRATIONS[0]?.version, 1);
        assert.equal(migrate(driver), 1);
        assert.equal(migrate(driver), 1);
        assert.equal(schemaVersion(driver), 1);
        const tables = driver.query({ sql: "SELECT name FROM sqlite_master WHERE type = 'table'" }).map((row) => row.name);
        for (const table of ["entities", "events", "schema_migrations", "store_meta"]) assert.equal(tables.includes(table), true);
        const applied = driver.query({ sql: "SELECT version FROM schema_migrations ORDER BY version" }).map((row) => row.version);
        assert.deepEqual(applied, [1]);
        assert.equal(migrate(driver, [{ version: 2, name: "extra", statements: ["CREATE TABLE extra (id TEXT PRIMARY KEY)"] }]), 2);
        assert.equal(schemaVersion(driver), 2);
        assert.deepEqual(driver.query({ sql: "SELECT version FROM schema_migrations ORDER BY version" }).map((row) => row.version), [1, 2]);
    } finally {
        driver.close();
    }
});

test("transactions roll back and nested transactions use savepoints", () => {
    const driver = openSqlite({ path: ":memory:" });
    try {
        migrate(driver);
        const insert = (key: string) => ({ sql: "INSERT INTO store_meta (key, value) VALUES (?, ?)", parameters: [key, key] });
        const stored = (key: string): unknown => driver.query({ sql: "SELECT value FROM store_meta WHERE key = ?", parameters: [key] })[0]?.value;
        assert.throws(() => driver.transaction((tx) => {
            tx.run(insert("rolled-back"));
            throw new Error("rollback");
        }), /rollback/);
        assert.equal(stored("rolled-back"), undefined);
        const result = driver.transaction((tx) => {
            tx.run(insert("outer"));
            try {
                driver.transaction((inner) => {
                    inner.run(insert("inner-rolled-back"));
                    throw new Error("inner-rollback");
                });
            } catch (error) {
                assert.equal(error instanceof Error ? error.message : "", "inner-rollback");
            }
            return "committed";
        });
        assert.equal(result, "committed");
        assert.equal(stored("outer"), "outer");
        assert.equal(stored("inner-rolled-back"), undefined);
        driver.transaction((tx) => {
            tx.run(insert("outer-again"));
            driver.transaction((inner) => {
                inner.run(insert("inner-committed"));
            });
        });
        assert.equal(stored("outer-again"), "outer-again");
        assert.equal(stored("inner-committed"), "inner-committed");
    } finally {
        driver.close();
    }
});

test("read-only databases reject writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-sqlite-"));
    try {
        const file = join(directory, "store.sqlite");
        const writer = openSqlite({ path: file, wal: false });
        try {
            migrate(writer);
            writer.exec("INSERT INTO store_meta (key, value) VALUES ('k', 'v')");
        } finally {
            writer.close();
        }
        const reader = openSqlite({ path: file, readonly: true, wal: false });
        try {
            assert.equal(reader.query({ sql: "SELECT COUNT(*) AS count FROM store_meta" })[0]?.count, 1);
            assert.throws(() => reader.run({ sql: "INSERT INTO store_meta (key, value) VALUES (?, ?)", parameters: ["x", "x"] }), /readonly/i);
            assert.throws(() => reader.exec("CREATE TABLE denied (id TEXT)"), /readonly/i);
        } finally {
            reader.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("close is idempotent and closed drivers reject every operation", () => {
    const driver = openSqlite({ path: ":memory:" });
    driver.close();
    driver.close();
    assert.equal(driver.open, false);
    const operations: readonly (() => unknown)[] = [
        () => driver.query({ sql: "SELECT 1" }),
        () => driver.run({ sql: "SELECT 1" }),
        () => driver.exec("SELECT 1"),
        () => driver.transaction(() => "unreachable"),
    ];
    for (const operation of operations) {
        assert.throws(operation, (error: unknown) => error instanceof Error && error.message === "sqlite driver is closed");
    }
});

test("file databases enable WAL and honour SQLite options", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-sqlite-"));
    try {
        const driver = openSqlite({ path: join(directory, "wal.sqlite"), busyTimeoutMilliseconds: 1234 });
        try {
            assert.equal(driver.query({ sql: "PRAGMA journal_mode" })[0]?.journal_mode, "wal");
            assert.equal(driver.query({ sql: "PRAGMA busy_timeout" })[0]?.timeout, 1234);
            assert.equal(driver.query({ sql: "PRAGMA foreign_keys" })[0]?.foreign_keys, 1);
        } finally {
            driver.close();
        }
        const memory = openSqlite({ path: ":memory:", foreignKeys: false });
        try {
            assert.equal(memory.query({ sql: "PRAGMA journal_mode" })[0]?.journal_mode, "memory");
            assert.equal(memory.query({ sql: "PRAGMA foreign_keys" })[0]?.foreign_keys, 0);
        } finally {
            memory.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
