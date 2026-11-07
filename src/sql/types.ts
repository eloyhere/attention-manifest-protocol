/** SQL access contracts shared by the repository and service layers. */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
    readonly sql: string;
    readonly parameters?: readonly SqlValue[];
}

export interface SqlResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
}

export interface SqlTransaction {
    query<T extends SqlRow = SqlRow>(statement: SqlStatement): readonly T[];
    run(statement: SqlStatement): SqlResult;
    exec(sql: string): void;
}

export interface SqlDriver {
    readonly path: string;
    readonly open: boolean;
    query<T extends SqlRow = SqlRow>(statement: SqlStatement): readonly T[];
    run(statement: SqlStatement): SqlResult;
    exec(sql: string): void;
    /** Single writer transaction; rolls back on throw. */
    transaction<T>(work: (tx: SqlTransaction) => T): T;
    close(): void;
}

export interface SqliteOptions {
    /** ":memory:" for tests, otherwise a file path. */
    readonly path: string;
    readonly readonly?: boolean;
    readonly busyTimeoutMilliseconds?: number;
    readonly wal?: boolean;
    readonly foreignKeys?: boolean;
}

export interface SchemaMigration {
    readonly version: number;
    readonly name: string;
    readonly statements: readonly string[];
}
