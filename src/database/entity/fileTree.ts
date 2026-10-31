/**
 * SQLite rows for the persisted file tree, annotations and write journal.
 *
 * `lines`/`bytes` stay TEXT because the domain uses `bigint`; the repository
 * parses them explicitly instead of relying on driver coercion.
 */
import type { TableMeta } from "./meta.ts";

/**
 * One `File` or `Directory` node. `node_id` is `rootId + "\0" + path`, so a
 * point lookup does not need a composite index.
 */
export interface FileNodeRow {
    node_id: string;
    root_id: string;
    path: string;
    parent_path: string | null;
    type: string;
    name: string;
    extension: string;
    fingerprint: string;
    charset: string;
    lines: string;
    bytes: string;
    created_at: string;
    modified_at: string;
    description: string;
    summary: string;
    purpose: string;
    revision: string;
    updated_at: string;
}

export const FileNodeTable: TableMeta = {
    table: "file_nodes",
    primaryKey: "node_id",
    columns: [
        "node_id",
        "root_id",
        "path",
        "parent_path",
        "type",
        "name",
        "extension",
        "fingerprint",
        "charset",
        "lines",
        "bytes",
        "created_at",
        "modified_at",
        "description",
        "summary",
        "purpose",
        "revision",
        "updated_at",
    ],
};

/**
 * A host annotation override, kept apart from the derived node row.
 */
export interface FileAnnotationRow {
    annotation_id: string;
    root_id: string;
    path: string;
    description: string | null;
    summary: string | null;
    purpose: string | null;
    source: string;
    updated_at: string;
}

export const FileAnnotationTable: TableMeta = {
    table: "file_annotations",
    primaryKey: "annotation_id",
    columns: ["annotation_id", "root_id", "path", "description", "summary", "purpose", "source", "updated_at"],
};

/**
 * Append-only write journal row. No content copy.
 */
export interface FileWriteRow {
    write_id: number;
    session_id: string;
    root_id: string;
    path: string;
    mode: string;
    previous_fingerprint: string | null;
    next_fingerprint: string;
    bytes: string;
    at: string;
}

export const FileWriteTable: TableMeta = {
    table: "file_writes",
    primaryKey: "write_id",
    columns: ["write_id", "session_id", "root_id", "path", "mode", "previous_fingerprint", "next_fingerprint", "bytes", "at"],
};

/**
 * Cached outline for one file fingerprint.
 */
export interface FileOutlineRow {
    outline_id: string;
    root_id: string;
    path: string;
    fingerprint: string;
    language: string;
    charset: string;
    data_json: string;
    truncated: number;
    created_at: string;
}

export const FileOutlineTable: TableMeta = {
    table: "file_outlines",
    primaryKey: "outline_id",
    columns: ["outline_id", "root_id", "path", "fingerprint", "language", "charset", "data_json", "truncated", "created_at"],
};
