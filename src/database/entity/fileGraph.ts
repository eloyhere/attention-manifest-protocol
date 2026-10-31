/**
 * SQLite rows for static module edges: imports, exports and project-level
 * dependencies. Edges are generation-scoped by `(root_id, fingerprint)` so a
 * stale parse can be deleted without touching a newer generation.
 */
import type { TableMeta } from "./meta.ts";

/**
 * One import/export-from edge.
 */
export interface FileImportRow {
    import_id: string;
    root_id: string;
    from_path: string;
    to_path: string;
    specifier: string;
    kind: string;
    line: number;
    resolved: number;
    external: number;
    fingerprint: string;
    created_at: string;
}

export const FileImportTable: TableMeta = {
    table: "file_imports",
    primaryKey: "import_id",
    columns: ["import_id", "root_id", "from_path", "to_path", "specifier", "kind", "line", "resolved", "external", "fingerprint", "created_at"],
};

/**
 * One exported symbol.
 */
export interface FileExportRow {
    export_id: string;
    root_id: string;
    path: string;
    name: string;
    kind: string;
    line: number;
    signature: string;
    reexport_from: string | null;
    fingerprint: string;
    created_at: string;
}

export const FileExportTable: TableMeta = {
    table: "file_exports",
    primaryKey: "export_id",
    columns: ["export_id", "root_id", "path", "name", "kind", "line", "signature", "reexport_from", "fingerprint", "created_at"],
};

/**
 * One project-level dependency edge.
 */
export interface FileDependencyRow {
    dependency_id: string;
    root_id: string;
    from_path: string;
    to_path: string;
    kind: string;
    method: string;
    fingerprint: string;
    created_at: string;
}

export const FileDependencyTable: TableMeta = {
    table: "file_dependencies",
    primaryKey: "dependency_id",
    columns: ["dependency_id", "root_id", "from_path", "to_path", "kind", "method", "fingerprint", "created_at"],
};
