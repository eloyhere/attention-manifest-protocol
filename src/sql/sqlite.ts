import { DatabaseSync } from "node:sqlite";
import type { DatabaseSyncOptions } from "node:sqlite";
import type { SqlDriver, SqlResult, SqlRow, SqlStatement, SqlTransaction, SqliteOptions } from "./types.ts";

const DEFAULT_BUSY_TIMEOUT_MILLISECONDS = 5000;
const CLOSED_MESSAGE = "sqlite driver is closed";

function toChanges(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
}

/**
 * Opens a synchronous SQLite driver over `node:sqlite`.
 *
 * The connection runs with foreign-key enforcement by default and file-backed
 * databases switch to WAL unless disabled. In-memory databases and read-only
 * connections cannot change the journal mode and therefore skip that pragma.
 */
export function openSqlite(options: SqliteOptions): SqlDriver {
    if (typeof options.path !== "string" || options.path.length === 0) throw new TypeError("sqlite path must be a non-empty string");
    const path = options.path;
    const readonly = options.readonly === true;
    const busyTimeoutMilliseconds = options.busyTimeoutMilliseconds ?? DEFAULT_BUSY_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(busyTimeoutMilliseconds) || busyTimeoutMilliseconds < 0) {
        throw new RangeError("busyTimeoutMilliseconds must be a non-negative safe integer");
    }
    const foreignKeys = options.foreignKeys ?? true;
    const wal = (options.wal ?? true) && path !== ":memory:" && !readonly;
    const databaseOptions: DatabaseSyncOptions = {
        enableForeignKeyConstraints: foreignKeys,
        timeout: busyTimeoutMilliseconds,
        ...(readonly ? { readOnly: true } : {}),
    };
    const database = new DatabaseSync(path, databaseOptions);
    try {
        if (wal) database.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
        database.close();
        throw error;
    }

    let depth = 0;

    function assertOpen(): void {
        if (!database.isOpen) throw new Error(CLOSED_MESSAGE);
    }

    function query<T extends SqlRow = SqlRow>(statement: SqlStatement): readonly T[] {
        assertOpen();
        const rows = database.prepare(statement.sql).all(...(statement.parameters ?? []));
        return rows.map((row) => ({ ...row }) as unknown as T);
    }

    function run(statement: SqlStatement): SqlResult {
        assertOpen();
        const result = database.prepare(statement.sql).run(...(statement.parameters ?? []));
        return { changes: toChanges(result.changes), lastInsertRowid: result.lastInsertRowid };
    }

    function exec(sql: string): void {
        assertOpen();
        database.exec(sql);
    }

    const transactionApi: SqlTransaction = { query, run, exec };

    function transaction<T>(work: (tx: SqlTransaction) => T): T {
        assertOpen();
        if (depth > 0) {
            const savepoint = `amp_savepoint_${depth}`;
            depth += 1;
            try {
                database.exec(`SAVEPOINT ${savepoint}`);
                const result = work(transactionApi);
                database.exec(`RELEASE SAVEPOINT ${savepoint}`);
                return result;
            } catch (error) {
                try {
                    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
                } catch {
                    // The savepoint can already be gone when the connection failed mid-flight.
                }
                throw error;
            } finally {
                depth -= 1;
            }
        }
        database.exec("BEGIN IMMEDIATE");
        depth = 1;
        try {
            const result = work(transactionApi);
            database.exec("COMMIT");
            return result;
        } catch (error) {
            try {
                database.exec("ROLLBACK");
            } catch {
                // SQLite can auto-rollback certain failures before the error reaches us.
            }
            throw error;
        } finally {
            depth = 0;
        }
    }

    return {
        path,
        get open(): boolean {
            return database.isOpen;
        },
        query,
        run,
        exec,
        transaction,
        close(): void {
            if (!database.isOpen) return;
            database.close();
        },
    };
}
