/**
 * SQLite repository for the append-only write journal.
 *
 * A row is metadata only: path, mode, before/after fingerprints, byte count and
 * timestamp. Content is never copied here, so a crash cannot leave a stale body
 * that contradicts the workspace file. `write_id` is autoincremented and gives a
 * total order per store; a session's history is read newest first.
 */
import type { DatabaseSync } from "node:sqlite";

import type { WriteJournalEntry, WriteMode } from "../../file/types.ts";
import type { FileWriteRow } from "../entity/fileTree.ts";
import { FileWriteTable } from "../entity/fileTree.ts";
import type { TableMeta } from "../entity/meta.ts";
import { assertSqlIdentifier } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";

/**
 * Quote a column that is declared by the table metadata.
 *
 * @param meta - Table metadata.
 * @param column - Column name.
 * @returns Double-quoted column name.
 */
const quoted: (meta: TableMeta, column: string) => string = (meta: TableMeta, column: string): string => {
    if (!meta.columns.includes(column)) {
        throw new Error(`unknown column for ${meta.table}: ${column}`);
    }
    return `"${assertSqlIdentifier(column)}"`;
};

/**
 * Build a bound `column = ?` conjunction from declared columns.
 *
 * @param meta - Table metadata.
 * @param columns - Column names in bind order.
 * @returns SQL fragment with one placeholder per column.
 */
const conditions: (meta: TableMeta, columns: readonly string[]) => string = (meta: TableMeta, columns: readonly string[]): string =>
    columns.map((column: string): string => `${quoted(meta, column)} = ?`).join(" AND ");

/**
 * Validate one journal mode against the closed write-mode set.
 *
 * @param value - Mode supplied by the caller.
 * @returns The validated mode.
 * @throws Error when the mode is outside the closed set.
 */
const parseMode: (value: string) => WriteMode = (value: string): WriteMode => {
    if (value === "create" || value === "overwrite" || value === "upsert" || value === "append") {
        return value;
    }
    throw new Error(`invalid write mode: ${value}`);
};

/**
 * Repository for `file_writes`.
 */
export class FileWriteRepository extends BaseRepository<FileWriteRow, number> {
    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, FileWriteTable);
    }

    /**
     * Append one successful write, letting SQLite assign `write_id`.
     *
     * @param entry - Journal record.
     * @param rootId - Session root id; the entry's own copy is not trusted for
     * the row, so a caller cannot journal into another root.
     * @throws Error when the mode is outside the closed write-mode set.
     * @throws RangeError when the byte count is negative.
     */
    append(entry: WriteJournalEntry, rootId: string): void {
        const mode: WriteMode = parseMode(entry.mode);
        if (entry.bytes < 0n) {
            throw new RangeError("write bytes must not be negative");
        }
        this.insert({
            session_id: entry.sessionId,
            root_id: rootId,
            path: entry.path,
            mode,
            previous_fingerprint: entry.previousFingerprint,
            next_fingerprint: entry.nextFingerprint,
            bytes: `${entry.bytes}`,
            at: entry.at,
        });
    }

    /**
     * Read a session's journal, newest first.
     *
     * @param sessionId - Session handle.
     * @param limit - Maximum rows; zero is allowed and returns nothing.
     * @returns Journal rows.
     */
    list(sessionId: string, limit: number): FileWriteRow[] {
        if (!Number.isInteger(limit) || limit < 0) {
            throw new RangeError("limit must be a non-negative integer");
        }
        return this.queries.select({
            where: conditions(FileWriteTable, ["session_id"]),
            params: [sessionId],
            orderBy: `ORDER BY ${quoted(FileWriteTable, "write_id")} DESC`,
            limit,
        });
    }
}
