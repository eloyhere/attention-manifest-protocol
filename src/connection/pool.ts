import type { SqlDriver, SqlResult, SqlRow, SqlStatement } from "../sql/types.ts";
import { ConnectionPoolError } from "./types.ts";
import type { Connection, ConnectionPool, ConnectionPoolOptions, PoolStats, SavePoint, Transaction, TransactionState } from "./types.ts";

export function createConnectionPool(options: ConnectionPoolOptions): ConnectionPool {
    if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) {
        throw new RangeError("maxConnections must be a positive safe integer");
    }

    interface ManagedConnection extends Connection {
        readonly driver: SqlDriver;
        activate(): void;
    }

    const all = new Set<ManagedConnection>();
    const idle: ManagedConnection[] = [];
    let closed = false;
    let nextId = 1;

    function assertPoolOpen(): void {
        if (closed) throw new ConnectionPoolError("pool_closed");
    }

    function assertConnectionActive(connection: ManagedConnection): void {
        assertPoolOpen();
        if (connection.released) throw new ConnectionPoolError("connection_released");
    }

    function makeConnection(driver: SqlDriver): ManagedConnection {
        let released = false;
        let activeTransaction: Transaction | undefined;
        const connection: ManagedConnection = {
            id: nextId++,
            driver,
            activate(): void { released = false; },
            get released(): boolean { return released; },
            startTransaction(): Transaction {
                assertConnectionActive(connection);
                if (activeTransaction?.state === "active") {
                    throw new ConnectionPoolError("transaction_closed", "connection already has an active transaction");
                }
                driver.exec("BEGIN IMMEDIATE");
                let state: TransactionState = "active";
                const savepoints: SavePoint[] = [];
                let nextSavepoint = 1;
                const assertActive = (): void => {
                    assertConnectionActive(connection);
                    if (state !== "active") throw new ConnectionPoolError("transaction_closed");
                };
                const assertTop = (point: SavePoint): void => {
                    if (savepoints.at(-1) !== point) throw new Error("savepoints must be operated in LIFO order");
                };
                const transaction: Transaction = {
                    get state(): TransactionState { return state; },
                    connection,
                    query<T extends SqlRow = SqlRow>(statement: SqlStatement): readonly T[] {
                        assertActive();
                        return driver.query<T>(statement);
                    },
                    run(statement: SqlStatement): SqlResult {
                        assertActive();
                        return driver.run(statement);
                    },
                    exec(sql: string): void {
                        assertActive();
                        driver.exec(sql);
                    },
                    savePoint(name?: string): SavePoint {
                        assertActive();
                        const pointName = name ?? `sp_${nextSavepoint++}`;
                        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(pointName)) throw new TypeError("invalid savepoint name");
                        driver.exec(`SAVEPOINT ${pointName}`);
                        let pointActive = true;
                        const point: SavePoint & { deactivate(): void } = {
                            name: pointName,
                            get active(): boolean { return pointActive; },
                            deactivate(): void { pointActive = false; },
                            release(): void {
                                assertActive();
                                if (!pointActive) throw new ConnectionPoolError("savepoint_closed");
                                assertTop(point);
                                driver.exec(`RELEASE SAVEPOINT ${pointName}`);
                                savepoints.pop();
                                pointActive = false;
                            },
                            rollback(): void {
                                assertActive();
                                if (!pointActive) throw new ConnectionPoolError("savepoint_closed");
                                assertTop(point);
                                driver.exec(`ROLLBACK TO SAVEPOINT ${pointName}`);
                                driver.exec(`RELEASE SAVEPOINT ${pointName}`);
                                savepoints.pop();
                                pointActive = false;
                            },
                        };
                        savepoints.push(point);
                        return point;
                    },
                    commit(): void {
                        assertActive();
                        if (savepoints.length > 0) throw new Error("cannot commit with active savepoints");
                        driver.exec("COMMIT");
                        state = "committed";
                    },
                    rollback(): void {
                        assertActive();
                        driver.exec("ROLLBACK");
                        state = "rolled_back";
                        for (const point of savepoints) (point as SavePoint & { deactivate(): void }).deactivate();
                        savepoints.length = 0;
                    },
                };
                activeTransaction = transaction;
                return transaction;
            },
            release(): void {
                if (released) return;
                if (activeTransaction?.state === "active") activeTransaction.rollback();
                released = true;
                idle.push(connection);
            },
        };
        return connection;
    }

    return {
        acquire(): Connection {
            assertPoolOpen();
            const reused = idle.pop();
            if (reused) {
                reused.activate();
                return reused;
            }
            if (all.size >= options.maxConnections) throw new ConnectionPoolError("pool_exhausted");
            const driver = options.open();
            const connection = makeConnection(driver);
            all.add(connection);
            return connection;
        },
        withConnection<T>(work: (connection: Connection) => T): T {
            const connection = this.acquire();
            try { return work(connection); }
            finally { connection.release(); }
        },
        withTransaction<T>(work: (transaction: Transaction) => T): T {
            const connection = this.acquire();
            const transaction = connection.startTransaction();
            try {
                const result = work(transaction);
                transaction.commit();
                return result;
            } catch (error) {
                if (transaction.state === "active") transaction.rollback();
                throw error;
            } finally {
                connection.release();
            }
        },
        stats(): PoolStats {
            return Object.freeze({ size: all.size, idle: idle.length, leased: all.size - idle.length, maxConnections: options.maxConnections, closed });
        },
        close(): void {
            if (closed) return;
            if (idle.length !== all.size) throw new Error("cannot close pool while connections are leased");
            for (const connection of all) connection.driver.close();
            idle.length = 0;
            all.clear();
            closed = true;
        },
    };
}
