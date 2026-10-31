/**
 * SQLite repository for the persisted file/directory tree.
 *
 * One row per node. `node_id` is `rootId + "\0" + path`, which makes a point
 * lookup a primary-key read while `(root_id, path)` stays unique for joins.
 * `lines`/`bytes` are TEXT in the table because the domain uses `bigint`; the
 * repository converts explicitly instead of relying on driver coercion.
 *
 * `stats.truncated` has no column, so it is recorded in the shared `meta` table
 * under `file_nodes.truncated.<rootId>` inside the same transaction as the tree
 * rows. A reload therefore cannot present a truncated walk as complete.
 */
import type { DatabaseSync } from "node:sqlite";

import type { TreeSnapshot, TreeNode } from "../../file/types.ts";
import type { TableMeta } from "../entity/meta.ts";
import type { FileNodeRow } from "../entity/fileTree.ts";
import { FileNodeTable } from "../entity/fileTree.ts";
import { assertSqlIdentifier } from "../sql/sql.ts";
import { transaction } from "../store/database.ts";
import { BaseRepository } from "./base.ts";

/**
 * Meta table metadata.
 *
 * `meta` has no entity module; this local {@link TableMeta} keeps its
 * identifiers validated like every other table.
 */
const MetaTable: TableMeta = {
    table: "meta",
    primaryKey: "key",
    columns: ["key", "value"],
};

/**
 * Prefix for the truncation flag of one root.
 */
const TruncatedPrefix: string = "file_nodes.truncated.";

/**
 * Row shape of the one-column meta read.
 */
interface MetaValueRow {
    value: string;
}

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
 * Quote a table name that is declared by table metadata.
 *
 * @param meta - Table metadata.
 * @returns Double-quoted table name.
 */
const tableOf: (meta: TableMeta) => string = (meta: TableMeta): string => `"${assertSqlIdentifier(meta.table)}"`;

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
 * Deterministic node primary key.
 *
 * NUL is the separator, so a component containing NUL would alias another
 * `(rootId, path)` pair on the primary key while differing on the unique pair.
 *
 * @param rootId - Session root id.
 * @param path - Root-relative POSIX path.
 * @returns `rootId\0path`.
 * @throws Error when a component contains NUL.
 */
const nodeId: (rootId: string, path: string) => string = (rootId: string, path: string): string => {
    if (rootId.includes("\u0000") || path.includes("\u0000")) {
        throw new Error("file node components must not contain U+0000");
    }
    return `${rootId}\u0000${path}`;
};

/**
 * Reject a negative line/byte counter.
 *
 * @param value - Counter supplied by the tree snapshot.
 * @param field - Field name used in the error message.
 * @throws RangeError when the counter is negative.
 */
const assertCounter: (value: bigint, field: string) => void = (value: bigint, field: string): void => {
    if (value < 0n) {
        throw new RangeError(`${field} must not be negative`);
    }
};

/**
 * Root-relative parent path of a node.
 *
 * The snapshot root is `.` and has no parent; a direct child of the root has
 * `.` as its parent so a direct-children query stays a single index seek.
 *
 * @param path - Root-relative POSIX path.
 * @returns Parent path.
 */
const parentOf: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return slash < 0 ? "." : path.slice(0, slash);
};

/**
 * Repository for `file_nodes`.
 */
export class FileNodeRepository extends BaseRepository<FileNodeRow, string> {
    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, FileNodeTable);
    }

    /**
     * Replace the whole persisted tree of one root in one transaction.
     *
     * Old rows are deleted first, so a node that disappeared from the snapshot
     * cannot linger. Every node of `snapshot.root` is inserted recursively with
     * the snapshot revision and the supplied update timestamp, and the
     * truncation flag is recorded in the same transaction.
     *
     * @param rootId - Session root id.
     * @param snapshot - Tree snapshot built by the filesystem domain.
     * @param updatedAt - ISO timestamp for the write.
     * @throws RangeError when a node reports negative lines or bytes.
     * @throws Error when a root id or path contains NUL.
     */
    replaceTree(rootId: string, snapshot: TreeSnapshot, updatedAt: string): void {
        transaction(this.db, (): void => {
            this.deleteTree(rootId);
            this.insertNode(rootId, snapshot.root, snapshot.revision, updatedAt);
            this.writeMeta(`${TruncatedPrefix}${rootId}`, snapshot.stats.truncated ? "1" : "0");
        });
    }

    /**
     * Read one node.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @returns The row, or `undefined` when absent.
     */
    findNode(rootId: string, path: string): FileNodeRow | undefined {
        const rows: FileNodeRow[] = this.queries.select({
            where: conditions(FileNodeTable, ["root_id", "path"]),
            params: [rootId, path],
            limit: 1,
        });
        return rows.length === 0 ? undefined : rows[0];
    }

    /**
     * List the direct children of one directory.
     *
     * @param rootId - Session root id.
     * @param parentPath - Parent path; `.` for the root.
     * @returns Child rows, directories before files and each group by name.
     */
    children(rootId: string, parentPath: string): FileNodeRow[] {
        return this.queries.select({
            where: conditions(FileNodeTable, ["root_id", "parent_path"]),
            params: [rootId, parentPath],
            orderBy: `ORDER BY ${quoted(FileNodeTable, "type")} ASC, ${quoted(FileNodeTable, "name")} ASC`,
        });
    }

    /**
     * List every row of one root.
     *
     * Used to rebuild a snapshot without one query per directory.
     *
     * @param rootId - Session root id.
     * @returns Rows ordered by path.
     */
    listNodes(rootId: string): FileNodeRow[] {
        return this.queries.select({
            where: conditions(FileNodeTable, ["root_id"]),
            params: [rootId],
            orderBy: `ORDER BY ${quoted(FileNodeTable, "path")} ASC`,
        });
    }

    /**
     * Read the truncation flag persisted with the tree.
     *
     * @param rootId - Session root id.
     * @returns `true` when the persisted snapshot was truncated.
     */
    loadTruncated(rootId: string): boolean {
        return this.readMeta(`${TruncatedPrefix}${rootId}`) === "1";
    }

    /**
     * Delete every node of one root and its truncation flag.
     *
     * @param rootId - Session root id.
     */
    deleteTree(rootId: string): void {
        this.deleteWhere(conditions(FileNodeTable, ["root_id"]), rootId);
        this.deleteMeta(`${TruncatedPrefix}${rootId}`);
    }

    /**
     * Count the persisted nodes of one root.
     *
     * @param rootId - Session root id.
     * @returns Number of rows.
     */
    count(rootId: string): number {
        return this.queries.count(conditions(FileNodeTable, ["root_id"]), rootId);
    }

    /**
     * Insert one node and then its descendants.
     *
     * @param rootId - Session root id.
     * @param node - Node to persist.
     * @param revision - Snapshot revision shared by every row.
     * @param updatedAt - ISO timestamp for the write.
     */
    private insertNode(rootId: string, node: TreeNode, revision: string, updatedAt: string): void {
        assertCounter(node.lines, "node lines");
        assertCounter(node.bytes, "node bytes");
        this.insert({
            node_id: nodeId(rootId, node.path),
            root_id: rootId,
            path: node.path,
            parent_path: node.path === "." ? null : parentOf(node.path),
            type: node.type,
            name: node.name,
            extension: node.extension,
            fingerprint: node.fingerprint,
            charset: node.charset,
            lines: `${node.lines}`,
            bytes: `${node.bytes}`,
            created_at: node.create,
            modified_at: node.modify,
            description: node.description,
            summary: node.summary,
            purpose: node.purpose,
            revision,
            updated_at: updatedAt,
        });
        if (node.type === "Directory") {
            for (let index: number = 0; index < node.children.length; index += 1) {
                this.insertNode(rootId, node.children[index], revision, updatedAt);
            }
        }
    }

    /**
     * Read one meta value.
     *
     * @param key - Meta key.
     * @returns Value, or `undefined` when absent.
     */
    private readMeta(key: string): string | undefined {
        const sql: string = `SELECT ${quoted(MetaTable, "value")} AS value FROM ${tableOf(MetaTable)} WHERE ${quoted(MetaTable, "key")} = ? LIMIT 1`;
        const row: MetaValueRow | undefined = this.db.prepare(sql).get(key) as unknown as MetaValueRow | undefined;
        return row === (void 0) ? undefined : row.value;
    }

    /**
     * Insert or replace one meta value.
     *
     * @param key - Meta key.
     * @param value - Meta value.
     */
    private writeMeta(key: string, value: string): void {
        const keyColumn: string = quoted(MetaTable, "key");
        const valueColumn: string = quoted(MetaTable, "value");
        const sql: string = `INSERT INTO ${tableOf(MetaTable)} (${keyColumn}, ${valueColumn}) VALUES (?, ?) ON CONFLICT(${keyColumn}) DO UPDATE SET ${valueColumn} = excluded.${valueColumn}`;
        this.db.prepare(sql).run(key, value);
    }

    /**
     * Delete one meta value.
     *
     * @param key - Meta key.
     */
    private deleteMeta(key: string): void {
        const sql: string = `DELETE FROM ${tableOf(MetaTable)} WHERE ${quoted(MetaTable, "key")} = ?`;
        this.db.prepare(sql).run(key);
    }
}
