/**
 * SQLite repository for the outline cache.
 *
 * A result is keyed by `rootId + "\0" + path + "\0" + fingerprint`, so an
 * unchanged file reuses its parsed outline and a changed file can never read a
 * stale tree. The node list is stored as JSON; language, charset and the
 * truncation flag stay as columns so a reader can filter without parsing.
 */
import type { DatabaseSync } from "node:sqlite";

import { outlineFromWire, wireOutline } from "../../outline/outlineIndex.ts";
import type { Charset } from "../../syntax/types.ts";
import type { OutlineResult, WireOutlineResult } from "../../outline/types.ts";
import type { FileOutlineRow } from "../entity/fileTree.ts";
import { FileOutlineTable } from "../entity/fileTree.ts";
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
 * Deterministic outline primary key.
 *
 * NUL is the separator, so a component containing NUL would alias another
 * `(rootId, path, fingerprint)` triple on the primary key.
 *
 * @param rootId - Session root id.
 * @param path - Root-relative POSIX path.
 * @param fingerprint - File content fingerprint.
 * @returns `rootId\0path\0fingerprint`.
 * @throws Error when a component contains NUL.
 */
const outlineId: (rootId: string, path: string, fingerprint: string) => string = (rootId: string, path: string, fingerprint: string): string => {
    if (rootId.includes("\u0000") || path.includes("\u0000") || fingerprint.includes("\u0000")) {
        throw new Error("outline components must not contain U+0000");
    }
    return `${rootId}\u0000${path}\u0000${fingerprint}`;
};

/**
 * Repository for `file_outlines`.
 */
export class FileOutlineRepository extends BaseRepository<FileOutlineRow, string> {
    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, FileOutlineTable);
    }

    /**
     * Insert or replace the outline of one fingerprint.
     *
     * @param rootId - Session root id.
     * @param outline - Parsed outline.
     * @param at - ISO timestamp for the write.
     */
    save(rootId: string, outline: OutlineResult, at: string): void {
        this.upsert({
            outline_id: outlineId(rootId, outline.path, outline.fingerprint),
            root_id: rootId,
            path: outline.path,
            fingerprint: outline.fingerprint,
            language: outline.language,
            charset: outline.charset,
            data_json: JSON.stringify(wireOutline(outline)),
            truncated: outline.truncated ? 1 : 0,
            created_at: at,
        });
    }

    /**
     * Load the outline of one exact fingerprint.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param fingerprint - File content fingerprint.
     * @returns The cached outline, or `undefined` when absent or stale.
     */
    load(rootId: string, path: string, fingerprint: string): OutlineResult | undefined {
        const rows: FileOutlineRow[] = this.queries.select({
            where: conditions(FileOutlineTable, ["root_id", "path", "fingerprint"]),
            params: [rootId, path, fingerprint],
            limit: 1,
        });
        if (rows.length === 0) {
            return undefined;
        }
        const row: FileOutlineRow = rows[0];
        const wire: WireOutlineResult = JSON.parse(row.data_json) as WireOutlineResult;
        return outlineFromWire({
            ...wire,
            path: row.path,
            fingerprint: row.fingerprint,
            language: row.language,
            charset: row.charset as Charset,
            truncated: row.truncated === 1,
        });
    }
}
