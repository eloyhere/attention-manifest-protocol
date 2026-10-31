/**
 * SQLite store: one file, WAL mode, hash-chained objects plus scheduler tables.
 *
 * `node:sqlite` is built into Node 24, so the database adds no dependency. The
 * `objects` table is the append-only evidence log (the same digest chain the
 * JSONL store used); `processes`, `threads` and `steps` are the mutable
 * scheduler state. A step commits its state change, its receipt and its step
 * row in one transaction, so a crash cannot leave a thread "running" without a
 * receipt or a receipt without a step.
 */
import { DatabaseSync } from "node:sqlite";

import type { Digest } from "../../types/common.ts";
import { canonical, digestOf } from "../../semantic/canonical.ts";
import { MetaSchema, Schema } from "../sql/schema.ts";

export const GENESIS: Digest = `sha256:${"0".repeat(64)}`;

export interface ObjectRow {
    seq: number;
    kind: string;
    id: string;
    body: string;
    hash: Digest;
    prev: Digest;
    at: string;
}

export interface PutObjectResult {
    seq: number;
    hash: Digest;
}

interface ColumnInfo {
    name: string;
}

interface SchemaVersionRow {
    value?: string;
}

interface HashRow {
    hash?: string;
}

interface TableNameRow {
    name: string;
}

interface VerifyResult {
    ok: boolean;
    reasons: string[];
}

interface MutationChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
}

/**
 * Signature for adding a missing column.
 */
type EnsureColumn = (db: DatabaseSync, table: string, column: string, definition: string) => void;

/**
 * Signature for appending an object.
 */
type PutObject = (db: DatabaseSync, kind: string, id: string, body: unknown, at: string) => PutObjectResult;

/**
 * Signature for reading an object.
 */
type GetObject = (db: DatabaseSync, kind: string, id: string) => ObjectRow | undefined;

/**
 * Add a column to a pre-existing table without rewriting the whole schema.
 */
const ensureColumn: EnsureColumn = (db, table, column, definition): void => {
    const columns: ColumnInfo[] = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
    if (!columns.some((entry: ColumnInfo) => entry.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
};

/**
 * Open (or create) a store and apply the schema. WAL is skipped for `:memory:`.
 */
export const openStore: (path: string) => DatabaseSync = (path: string): DatabaseSync => {
    const db: DatabaseSync = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    /**
     * A second worker waits for the write lock instead of failing immediately.
     */
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
        db.exec("PRAGMA journal_mode = WAL");
    }
    db.exec(MetaSchema);
    const version: SchemaVersionRow | undefined = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as SchemaVersionRow | undefined;
    if (version?.value === "1") {
        /**
         * Pre-release stores kept the v1 message and handle shapes. They carry
         * no durable contract yet, so migrate by replacing just those tables.
         */
        db.exec("DROP TABLE IF EXISTS messages");
        db.exec("DROP TABLE IF EXISTS handles");
    }
    if (version?.value !== (void 0) && version.value !== "4") {
        /**
         * v4 inverted the kernel semantics: process = agent, thread = task.
         * Pre-release data has no durable contract, so rebuild the scheduler
         * tables instead of pretending old rows mean the same thing.
         */
        db.exec("PRAGMA foreign_keys = OFF");
        db.exec("DROP TABLE IF EXISTS messages");
        db.exec("DROP TABLE IF EXISTS process_objects");
        db.exec("DROP TABLE IF EXISTS steps");
        db.exec("DROP TABLE IF EXISTS threads");
        db.exec("DROP TABLE IF EXISTS processes");
        db.exec("PRAGMA foreign_keys = ON");
    }
    db.exec(Schema);
    ensureColumn(db, "modules", "content_digest", "content_digest TEXT");
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    return db;
};

/**
 * Run a function inside `BEGIN IMMEDIATE` / `COMMIT`, rolling back on throw.
 */
export const transaction: <T>(db: DatabaseSync, fn: () => T) => T = <T>(db: DatabaseSync, fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result: T = fn();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        try {
            db.exec("ROLLBACK");
        } catch {
            // Never mask the operation failure with a secondary rollback error.
        }
        throw error;
    }
};

/**
 * Read the newest object digest.
 */
export const lastObjectHash: (db: DatabaseSync) => Digest = (db: DatabaseSync): Digest => {
    const row: HashRow | undefined = db.prepare("SELECT hash FROM objects ORDER BY seq DESC LIMIT 1").get() as HashRow | undefined;
    return row?.hash ?? GENESIS;
};

/**
 * Append one object and return its position and hash.
 *
 * The hash covers `prev`, `kind`, `id` and the canonical body, so editing any
 * row breaks every subsequent link. Callers that need several writes to land
 * together should wrap them in {@link transaction}.
 */
export const putObject: PutObject = (db, kind, id, body, at): PutObjectResult => {
    const prev: Digest = lastObjectHash(db);
    const bodyText: string = canonical(body);
    const hash: Digest = digestOf({ prev, kind, id, body: bodyText });
    const result: MutationChanges = db
        .prepare("INSERT INTO objects (kind, id, body, hash, prev, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(kind, id, bodyText, hash, prev, at);
    return { seq: Number(result.lastInsertRowid), hash };
};

/**
 * Read one object by kind and id.
 */
export const getObject: GetObject = (db, kind, id): ObjectRow | undefined => {
    return db.prepare("SELECT seq, kind, id, body, hash, prev, at FROM objects WHERE kind = ? AND id = ?").get(kind, id) as unknown as ObjectRow | undefined;
};

/**
 * Recompute the chain from row one; the only proof the store itself offers.
 */
export const verifyObjectChain: (db: DatabaseSync) => VerifyResult = (db: DatabaseSync): VerifyResult => {
    const reasons: string[] = [];
    const rows: ObjectRow[] = db.prepare("SELECT seq, kind, id, body, hash, prev FROM objects ORDER BY seq ASC").all() as unknown as ObjectRow[];
    let prev: Digest = GENESIS;
    for (let index: number = 0; index < rows.length; index += 1) {
        const row: ObjectRow = rows[index];
        if (row.prev !== prev) {
            reasons.push(`seq ${row.seq}: prev does not continue the chain`);
        }
        const expected: Digest = digestOf({ prev: row.prev, kind: row.kind, id: row.id, body: row.body });
        if (row.hash !== expected) {
            reasons.push(`seq ${row.seq}: hash does not cover its body`);
        }
        prev = row.hash;
    }
    return { ok: reasons.length === 0, reasons };
};

/**
 * Table names present in the store; useful for migration checks and tests.
 */
export const tableNames: (db: DatabaseSync) => string[] = (db: DatabaseSync): string[] => {
    const rows: TableNameRow[] = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as TableNameRow[];
    return rows.map((row: TableNameRow) => row.name);
};

/**
 * Close a store; kept here so callers do not import `node:sqlite` directly.
 */
export const closeStore: (db: DatabaseSync) => void = (db: DatabaseSync): void => {
    db.close();
};
