/**
 * SQLite repository for host annotations.
 *
 * Annotations are kept apart from `file_nodes` so a re-index cannot silently
 * overwrite a human or agent override. `annotation_id` is
 * `rootId + "\0" + path`; the table also declares a unique `(root_id, path)`
 * pair, so an upsert is either a primary-key or a unique-key operation.
 *
 * `upsert` and `delete` are overloaded with the generated CRUD shapes from
 * `BaseRepository` so the aggregate method names the domain needs do not remove
 * the repository's substitutability for the base class.
 */
import type { DatabaseSync } from "node:sqlite";

import type { NodeAnnotation } from "../../file/types.ts";
import type { FileAnnotationRow } from "../entity/fileTree.ts";
import { FileAnnotationTable } from "../entity/fileTree.ts";
import type { TableMeta } from "../entity/meta.ts";
import type { MutationResult } from "../sql/sql.ts";
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
 * Deterministic annotation primary key.
 *
 * NUL is the separator, so a component containing NUL would alias another
 * `(rootId, path)` pair on the primary key while differing on the unique pair.
 *
 * @param rootId - Session root id.
 * @param path - Root-relative POSIX path.
 * @returns `rootId\0path`.
 * @throws Error when a component contains NUL.
 */
const annotationId: (rootId: string, path: string) => string = (rootId: string, path: string): string => {
    if (rootId.includes("\u0000") || path.includes("\u0000")) {
        throw new Error("annotation components must not contain U+0000");
    }
    return `${rootId}\u0000${path}`;
};

/**
 * Project one row onto the optional annotation shape.
 *
 * @param row - Annotation row.
 * @returns Annotation with only the fields the host actually set.
 */
const annotationOf: (row: FileAnnotationRow) => NodeAnnotation = (row: FileAnnotationRow): NodeAnnotation => ({
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.purpose === null ? {} : { purpose: row.purpose }),
});

/**
 * Raw column map accepted by the generated CRUD shape.
 */
type RawColumns = Readonly<Record<string, unknown>>;

/**
 * Repository for `file_annotations`.
 */
export class FileAnnotationRepository extends BaseRepository<FileAnnotationRow, string> {
    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, FileAnnotationTable);
    }

    /**
     * Insert or replace the annotation of one node.
     *
     * The base-repository shape inserts a raw column map; the aggregate shape
     * takes the domain annotation and expands it, keeping one row per
     * `(root_id, path)`.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param annotation - Host override.
     * @param source - Who supplied the override.
     * @param at - ISO timestamp for the write.
     */
    upsert(rootId: string, path: string, annotation: NodeAnnotation, source: string, at: string): void;
    /**
     * Generated-CRUD compatible upsert.
     *
     * @param values - Column values.
     * @param conflictColumns - Unique columns; defaults to the primary key.
     * @returns Mutation metadata.
     */
    upsert(values: Readonly<Record<string, unknown>>, conflictColumns?: readonly string[]): MutationResult;
    upsert(rootId: string | RawColumns, path?: string | readonly string[], annotation?: NodeAnnotation, source?: string, at?: string): void | MutationResult {
        if (typeof(rootId) !== "string") {
            const conflicts: readonly string[] | undefined = typeof(path) === "string" ? undefined : path;
            return super.upsert(rootId, conflicts);
        }
        if (typeof(path) !== "string" || annotation === (void 0) || source === (void 0) || at === (void 0)) {
            throw new Error("annotation upsert requires a path, annotation, source and timestamp");
        }
        super.upsert({
            annotation_id: annotationId(rootId, path),
            root_id: rootId,
            path,
            description: annotation.description ?? null,
            summary: annotation.summary ?? null,
            purpose: annotation.purpose ?? null,
            source,
            updated_at: at,
        });
    }

    /**
     * Read every annotation of one root.
     *
     * @param rootId - Session root id.
     * @returns Path-keyed annotations.
     */
    load(rootId: string): Record<string, NodeAnnotation> {
        const rows: FileAnnotationRow[] = this.queries.select({
            where: conditions(FileAnnotationTable, ["root_id"]),
            params: [rootId],
            orderBy: `ORDER BY ${quoted(FileAnnotationTable, "path")} ASC`,
        });
        const annotations: Record<string, NodeAnnotation> = {};
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: FileAnnotationRow = rows[index];
            annotations[row.path] = annotationOf(row);
        }
        return annotations;
    }

    /**
     * Delete the annotation of one node, or the base-compatible row id.
     *
     * With a path the aggregate deletes by `(root_id, path)` and reports whether
     * a row was removed. With one argument the generated CRUD behavior is kept.
     *
     * @param rootId - Session root id, or annotation id for the base overload.
     * @param path - Root-relative POSIX path.
     * @returns `true` when the path-scoped delete removed a row.
     */
    delete(rootId: string, path: string): boolean;
    /**
     * Generated-CRUD compatible delete.
     *
     * @param id - Annotation primary key.
     * @returns Number of removed rows.
     */
    delete(id: string): number;
    delete(rootId: string, path?: string): boolean | number {
        if (path === (void 0)) {
            return super.delete(rootId);
        }
        return this.deleteWhere(conditions(FileAnnotationTable, ["root_id", "path"]), rootId, path) > 0;
    }
}
