import assert from "node:assert/strict";
import test from "node:test";
import type { SqlDriver, SqlResult, SqlRow, SqlStatement, SqlTransaction } from "../sql/types.ts";
import { ConnectionPoolError, createConnectionPool } from "./index.ts";

function fakeFactory(): { open: () => SqlDriver; drivers: SqlDriver[]; log: string[][] } {
    const drivers: SqlDriver[] = [];
    const log: string[][] = [];
    const open = (): SqlDriver => {
        const calls: string[] = [];
        log.push(calls);
        let isOpen = true;
        const driver: SqlDriver = {
            path: ":memory:",
            get open(): boolean { return isOpen; },
            query<T extends SqlRow = SqlRow>(_statement: SqlStatement): readonly T[] { return []; },
            run(_statement: SqlStatement): SqlResult { return { changes: 0, lastInsertRowid: 0 }; },
            exec(sql: string): void { calls.push(sql); },
            transaction<T>(work: (tx: SqlTransaction) => T): T { return work({ query: () => [], run: () => ({ changes: 0, lastInsertRowid: 0 }), exec: () => undefined }); },
            close(): void { isOpen = false; },
        };
        drivers.push(driver);
        return driver;
    };
    return { open, drivers, log };
}

function makePool(maxConnections = 2) {
    const fake = fakeFactory();
    return { ...fake, pool: createConnectionPool({ maxConnections, open: fake.open }) };
}

test("reuses connections, exhausts synchronously, and freezes stats", () => {
    const { pool } = makePool(1);
    const first = pool.acquire();
    assert.throws(() => pool.acquire(), (error: unknown) => error instanceof ConnectionPoolError && error.code === "pool_exhausted");
    first.release();
    assert.equal(first.released, true);
    first.release();
    const second = pool.acquire();
    assert.equal(first, second);
    const stats = pool.stats();
    assert.equal(Object.isFrozen(stats), true);
    assert.throws(() => { (stats as { idle: number }).idle = 4; }, TypeError);
    second.release();
    pool.close();
    assert.throws(() => pool.acquire(), (error: unknown) => error instanceof ConnectionPoolError && error.code === "pool_closed");
});

test("transactions commit and rollback while connection stays leased", () => {
    const { pool, log } = makePool();
    const connection = pool.acquire();
    const tx = connection.startTransaction();
    assert.throws(() => connection.startTransaction(), ConnectionPoolError);
    tx.commit();
    assert.equal(tx.state, "committed");
    assert.equal(connection.released, false);
    assert.throws(() => tx.rollback(), (error: unknown) => error instanceof ConnectionPoolError && error.code === "transaction_closed");
    connection.release();
    const second = pool.acquire();
    const tx2 = second.startTransaction();
    tx2.rollback();
    assert.equal(tx2.state, "rolled_back");
    second.release();
    assert.deepEqual(log[0], ["BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "ROLLBACK"]);
    pool.close();
});

test("transaction SQL methods forward to the leased driver until completion", () => {
    const { pool, log } = makePool(1);
    const connection = pool.acquire();
    const transaction = connection.startTransaction();
    assert.equal(transaction.connection, connection);
    assert.deepEqual(transaction.query({ sql: "SELECT 1" }), []);
    assert.deepEqual(transaction.run({ sql: "UPDATE items SET value = ?", parameters: [1] }), { changes: 0, lastInsertRowid: 0 });
    transaction.exec("SELECT 1");
    assert.deepEqual(log[0], ["BEGIN IMMEDIATE", "SELECT 1"]);
    transaction.commit();
    assert.throws(() => transaction.query({ sql: "SELECT 1" }), (error: unknown) => error instanceof ConnectionPoolError && error.code === "transaction_closed");
    connection.release();
    pool.close();
});

test("release automatically rolls back active transaction", () => {
    const { pool, log } = makePool();
    const connection = pool.acquire();
    const transaction = connection.startTransaction();
    connection.release();
    assert.equal(transaction.state, "rolled_back");
    assert.equal(pool.stats().idle, 1);
    assert.deepEqual(log[0], ["BEGIN IMMEDIATE", "ROLLBACK"]);
    pool.close();
});

test("savepoints roll back/release in LIFO order and reject invalid operations", () => {
    const { pool, log } = makePool();
    const connection = pool.acquire();
    const tx = connection.startTransaction();
    const outer = tx.savePoint();
    const inner = tx.savePoint("inner_2");
    assert.equal(outer.name, "sp_1");
    assert.throws(() => outer.release(), /LIFO/);
    inner.rollback();
    assert.equal(inner.active, false);
    assert.throws(() => inner.rollback(), (error: unknown) => error instanceof ConnectionPoolError && error.code === "savepoint_closed");
    outer.release();
    assert.throws(() => tx.savePoint("bad-name"), /invalid savepoint/);
    tx.commit();
    assert.throws(() => tx.savePoint(), (error: unknown) => error instanceof ConnectionPoolError && error.code === "transaction_closed");
    connection.release();
    assert.deepEqual(log[0], ["BEGIN IMMEDIATE", "SAVEPOINT sp_1", "SAVEPOINT inner_2", "ROLLBACK TO SAVEPOINT inner_2", "RELEASE SAVEPOINT inner_2", "RELEASE SAVEPOINT sp_1", "COMMIT"]);
    pool.close();
});

test("transaction rollback deactivates savepoints; withTransaction commits or rolls back", () => {
    const { pool, log } = makePool();
    const connection = pool.acquire();
    const tx = connection.startTransaction();
    const point = tx.savePoint();
    tx.rollback();
    assert.equal(point.active, false);
    connection.release();
    assert.equal(pool.withTransaction((transaction) => transaction.state), "active");
    assert.throws(() => pool.withTransaction(() => { throw new Error("failed"); }), /failed/);
    assert.deepEqual(log[0], ["BEGIN IMMEDIATE", "SAVEPOINT sp_1", "ROLLBACK", "BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "ROLLBACK"]);
    assert.equal(pool.stats().leased, 0);
    pool.close();
});

test("close refuses leased connections and closes all idle drivers", () => {
    const { pool, drivers } = makePool();
    const connection = pool.acquire();
    assert.throws(() => pool.close(), /leased/);
    connection.release();
    pool.close();
    assert.equal(drivers[0]?.open, false);
    assert.equal(pool.stats().closed, true);
});
