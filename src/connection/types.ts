import type { SqlDriver, SqlResult, SqlRow, SqlStatement } from "../sql/types.ts";

export type TransactionState = "active" | "committed" | "rolled_back";
export type ConnectionPoolErrorCode = "pool_closed" | "pool_exhausted" | "connection_released" | "transaction_closed" | "savepoint_closed";

export class ConnectionPoolError extends Error {
    public readonly code: ConnectionPoolErrorCode;

    public constructor(code: ConnectionPoolErrorCode, message: string = code) {
        super(message);
        this.code = code;
        this.name = "ConnectionPoolError";
    }
}

export interface SavePoint {
    readonly name: string;
    readonly active: boolean;
    release(): void;
    rollback(): void;
}

export interface Transaction {
    readonly state: TransactionState;
    readonly connection: Connection;
    query<T extends SqlRow = SqlRow>(statement: SqlStatement): readonly T[];
    run(statement: SqlStatement): SqlResult;
    exec(sql: string): void;
    savePoint(name?: string): SavePoint;
    commit(): void;
    rollback(): void;
}

export interface Connection {
    readonly id: number;
    readonly driver: SqlDriver;
    readonly released: boolean;
    startTransaction(): Transaction;
    release(): void;
}

export interface ConnectionPool {
    acquire(): Connection;
    withConnection<T>(work: (connection: Connection) => T): T;
    withTransaction<T>(work: (transaction: Transaction) => T): T;
    stats(): PoolStats;
    close(): void;
}

export interface PoolStats {
    readonly size: number;
    readonly idle: number;
    readonly leased: number;
    readonly maxConnections: number;
    readonly closed: boolean;
}

export interface ConnectionPoolOptions {
    readonly maxConnections: number;
    readonly open: () => SqlDriver;
}
