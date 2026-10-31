/**
 * SQLite repository for static module graphs: imports, exports and
 * project-level dependency edges.
 *
 * Every replace is scoped to one file (imports/exports) or one root
 * (dependencies) and runs in a transaction, so a stale parse generation cannot
 * be mixed with a newer one. Edges are keyed by a digest of their identity
 * fields, which makes a repeated parse idempotent instead of duplicating rows.
 *
 * `file_imports` and `file_exports` have no header row, so a per-file report
 * header (fingerprint, truncation flag, re-export edges) is stored in the
 * shared `meta` table under a digest of `(rootId, path)`. That header is what
 * lets a zero-edge or zero-symbol report be cached and lets `truncated` and
 * exact re-export edges survive a reload without changing the schema.
 *
 * The dependency table has no specifier or line column, so the specifier is
 * stored in `method` and the line is still not persisted. Node ids are stored
 * verbatim; known schemes (`file:`, `directory:`, `package:`, `external:`) are
 * only interpreted when rebuilding `DependencyNode.path`/`kind`.
 */
import type { DatabaseSync } from "node:sqlite";

import { canonical, digestOf } from "../../semantic/canonical.ts";
import type { DependencyEdge, DependencyEdgeKind, DependencyNode, ExportKind, ExportReport, ExportSymbol, ImportEdge, ImportKind, ImportReport } from "../../file/types.ts";
import type { FileDependencyRow, FileExportRow, FileImportRow } from "../entity/fileGraph.ts";
import { FileDependencyTable, FileExportTable, FileImportTable } from "../entity/fileGraph.ts";
import type { TableMeta } from "../entity/meta.ts";
import { assertSqlIdentifier, TableSql } from "../sql/sql.ts";
import { transaction } from "../store/database.ts";
import { BaseRepository } from "./base.ts";

/**
 * Dependency node/edge pair exchanged with the filesystem service.
 */
export interface DependencyGraph {
    readonly nodes: readonly DependencyNode[];
    readonly edges: readonly DependencyEdge[];
}

/**
 * Meta table metadata.
 *
 * `meta` predates the entity layer and has no entity module; this local
 * {@link TableMeta} keeps its identifiers validated like every other table.
 */
const MetaTable: TableMeta = {
    table: "meta",
    primaryKey: "key",
    columns: ["key", "value"],
};

/**
 * Prefix for the dependency revision row of one root.
 */
const DependencyRevisionPrefix: string = "file_dependencies.revision.";

/**
 * Prefix for the import report header of one file.
 */
const ImportReportPrefix: string = "file_imports.report.";

/**
 * Prefix for the export report header of one file.
 */
const ExportReportPrefix: string = "file_exports.report.";

/**
 * Prefix for the dependency graph header of one root.
 */
const DependencyGraphPrefix: string = "file_dependencies.graph.";

/**
 * Scheme prefixes understood by the dependency node projection.
 */
const FileScheme: string = "file:";
const DirectoryScheme: string = "directory:";
const PackageScheme: string = "package:";
const ExternalScheme: string = "external:";

/**
 * Row shape of the one-column meta read.
 */
interface MetaValueRow {
    value: string;
}

/**
 * Per-file report metadata that has no column in the edge tables.
 */
interface ReportHeader {
    readonly fingerprint: string;
    readonly truncated: boolean;
    readonly reexports?: readonly ImportEdge[];
}

/**
 * Per-root dependency metadata that has no column in the dependency table:
 * the node cards (including isolated nodes and fingerprints) and the line of
 * each edge keyed by its dependency id.
 */
interface DependencyHeader {
    readonly nodes: readonly DependencyNode[];
    readonly lines: Readonly<Record<string, number>>;
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
 * Append a value once, preserving first-seen order.
 *
 * @param values - Accumulator.
 * @param value - Candidate value.
 */
const pushUnique: (values: string[], value: string) => void = (values: string[], value: string): void => {
    if (!values.includes(value)) {
        values.push(value);
    }
};

/**
 * Meta key for one per-file report header.
 *
 * The digest keeps the key bounded and free of path separators while remaining
 * deterministic for `(rootId, path)`.
 *
 * @param prefix - Header family prefix.
 * @param rootId - Session root id.
 * @param path - Root-relative POSIX path.
 * @returns Meta key.
 */
const reportKey: (prefix: string, rootId: string, path: string) => string = (prefix: string, rootId: string, path: string): string =>
    `${prefix}${digestOf({ root: rootId, path })}`;

/**
 * Parse a persisted report header; malformed text is treated as absent.
 *
 * @param text - Meta value.
 * @returns Header, or `undefined` when absent or malformed.
 */
const parseReportHeader: (text: string) => ReportHeader | undefined = (text: string): ReportHeader | undefined => {
    try {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof(value) !== "object" || Array.isArray(value)) {
            return undefined;
        }
        const record: Record<string, unknown> = value as Record<string, unknown>;
        const fingerprint: unknown = record["fingerprint"];
        const truncated: unknown = record["truncated"];
        if (typeof(fingerprint) !== "string" || typeof(truncated) !== "boolean") {
            return undefined;
        }
        const reexports: unknown = record["reexports"];
        if (reexports === (void 0)) {
            return { fingerprint, truncated };
        }
        if (!Array.isArray(reexports)) {
            return undefined;
        }
        return { fingerprint, truncated, reexports: reexports as readonly ImportEdge[] };
    } catch {
        return undefined;
    }
};

/**
 * Parse a persisted dependency header; malformed text is treated as absent.
 *
 * @param text - Meta value.
 * @returns Header, or `undefined` when absent or malformed.
 */
const parseDependencyHeader: (text: string) => DependencyHeader | undefined = (text: string): DependencyHeader | undefined => {
    try {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof(value) !== "object" || Array.isArray(value)) {
            return undefined;
        }
        const record: Record<string, unknown> = value as Record<string, unknown>;
        const rawNodes: unknown = record["nodes"];
        const rawLines: unknown = record["lines"];
        if (!Array.isArray(rawNodes) || rawLines === null || typeof(rawLines) !== "object" || Array.isArray(rawLines)) {
            return undefined;
        }
        const nodes: DependencyNode[] = [];
        for (let index: number = 0; index < rawNodes.length; index += 1) {
            const rawNode: unknown = rawNodes[index];
            if (rawNode === null || typeof(rawNode) !== "object" || Array.isArray(rawNode)) {
                return undefined;
            }
            const node: Record<string, unknown> = rawNode as Record<string, unknown>;
            const id: unknown = node["id"];
            const path: unknown = node["path"];
            const kind: unknown = node["kind"];
            const fingerprint: unknown = node["fingerprint"];
            if (typeof(id) !== "string" || typeof(path) !== "string" || typeof(fingerprint) !== "string") {
                return undefined;
            }
            if (kind !== "file" && kind !== "directory" && kind !== "package") {
                return undefined;
            }
            nodes.push({ id, path, kind, fingerprint });
        }
        const lines: Record<string, number> = {};
        const lineKeys: string[] = Object.keys(rawLines as Record<string, unknown>);
        for (let index: number = 0; index < lineKeys.length; index += 1) {
            const lineKey: string = lineKeys[index];
            const line: unknown = (rawLines as Record<string, unknown>)[lineKey];
            if (typeof(line) === "number" && Number.isInteger(line)) {
                lines[lineKey] = line;
            }
        }
        return { nodes, lines };
    } catch {
        return undefined;
    }
};

/**
 * Identity digest for one dependency edge.
 *
 * The specifier and line are part of the identity, so the same endpoint pair
 * with different evidence remains two edges.
 *
 * @param rootId - Session root id.
 * @param edge - Dependency edge.
 * @returns Stable edge primary key.
 */
const dependencyId: (rootId: string, edge: DependencyEdge) => string = (rootId: string, edge: DependencyEdge): string =>
    digestOf({
        root: rootId,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        specifier: edge.specifier ?? null,
        line: edge.line ?? null,
    });

/**
 * Derive re-export edges from the symbols that carry `reexportFrom`.
 *
 * Used only when no report header exists (rows written before headers) or when
 * the header predates re-export persistence. The flags are conservative because
 * the symbol row has no resolved/external information.
 *
 * @param rows - Export rows.
 * @returns Deduped re-export edges in row order.
 */
const derivedReexports: (rows: readonly FileExportRow[]) => ImportEdge[] = (rows: readonly FileExportRow[]): ImportEdge[] => {
    const reexports: ImportEdge[] = [];
    const seen: Set<string> = new Set<string>();
    for (let index: number = 0; index < rows.length; index += 1) {
        const row: FileExportRow = rows[index];
        if (row.reexport_from === null) {
            continue;
        }
        const key: string = `${row.reexport_from}\u0000${row.line}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        reexports.push({
            from: row.path,
            to: row.reexport_from,
            specifier: row.reexport_from,
            kind: "export-from",
            line: row.line,
            resolved: false,
            external: false,
        });
    }
    return reexports;
};

/**
 * Build the node card for one dependency id.
 *
 * The id itself is preserved exactly; only the `path`/`kind` projection
 * interprets known schemes, so a raw path id and an `external:<specifier>` id
 * both round-trip without being rewritten.
 *
 * Fingerprints are not persisted by this table, so a rebuilt node reports the
 * empty fingerprint; callers that need the content ref read `file_nodes`.
 *
 * @param id - Node id.
 * @returns Dependency node.
 */
const dependencyNode: (id: string) => DependencyNode = (id: string): DependencyNode => {
    if (id.startsWith(FileScheme)) {
        return { id, path: id.slice(FileScheme.length), kind: "file", fingerprint: "" };
    }
    if (id.startsWith(DirectoryScheme)) {
        return { id, path: id.slice(DirectoryScheme.length), kind: "directory", fingerprint: "" };
    }
    if (id.startsWith(PackageScheme)) {
        return { id, path: id.slice(PackageScheme.length), kind: "package", fingerprint: "" };
    }
    if (id.startsWith(ExternalScheme)) {
        return { id, path: id.slice(ExternalScheme.length), kind: "package", fingerprint: "" };
    }
    return { id, path: id, kind: "file", fingerprint: "" };
};

/**
 * Project one import row onto the domain edge.
 *
 * @param row - Import row.
 * @returns Import edge.
 */
const importEdgeOf: (row: FileImportRow) => ImportEdge = (row: FileImportRow): ImportEdge => ({
    from: row.from_path,
    to: row.to_path,
    specifier: row.specifier,
    kind: row.kind as ImportKind,
    line: row.line,
    resolved: row.resolved === 1,
    external: row.external === 1,
});

/**
 * Project one export row onto the domain symbol.
 *
 * @param row - Export row.
 * @returns Exported symbol.
 */
const exportSymbolOf: (row: FileExportRow) => ExportSymbol = (row: FileExportRow): ExportSymbol =>
    row.reexport_from === null
        ? { name: row.name, kind: row.kind as ExportKind, line: row.line, signature: row.signature }
        : { name: row.name, kind: row.kind as ExportKind, line: row.line, signature: row.signature, reexportFrom: row.reexport_from };

/**
 * Repository for `file_imports`, `file_exports` and `file_dependencies`.
 *
 * The primary table is `file_imports`; the other two use their own generated
 * table adapters.
 */
export class FileGraphRepository extends BaseRepository<FileImportRow, string> {
    private readonly exportsSql: TableSql<FileExportRow>;
    private readonly dependenciesSql: TableSql<FileDependencyRow>;

    /**
     * Create the repository.
     *
     * @param db - Open SQLite connection.
     */
    constructor(db: DatabaseSync) {
        super(db, FileImportTable);
        this.exportsSql = new TableSql<FileExportRow>(db, FileExportTable);
        this.dependenciesSql = new TableSql<FileDependencyRow>(db, FileDependencyTable);
    }

    /**
     * Replace the outgoing import edges of one file in one transaction.
     *
     * Rows are deleted by `(root_id, from_path)` rather than by fingerprint, so
     * a stale generation is removed even when the file's fingerprint changed.
     * The report path is the cache key, so an edge whose `from` names another
     * file is rejected before the transaction instead of being stored under a
     * path that `loadImports` would never query. The header keeps the truncation
     * flag and makes a zero-edge report cacheable.
     *
     * @param rootId - Session root id.
     * @param report - Parsed import report.
     * @param at - ISO timestamp for the write.
     * @throws Error when an edge's `from` is not the report path.
     */
    replaceImports(rootId: string, report: ImportReport, at: string): void {
        for (let index: number = 0; index < report.imports.length; index += 1) {
            const edge: ImportEdge = report.imports[index];
            if (edge.from !== report.path) {
                throw new Error(`import edge from ${edge.from} does not belong to report ${report.path}`);
            }
        }
        transaction(this.db, (): void => {
            this.deleteWhere(conditions(FileImportTable, ["root_id", "from_path"]), rootId, report.path);
            for (let index: number = 0; index < report.imports.length; index += 1) {
                const edge: ImportEdge = report.imports[index];
                this.upsert({
                    import_id: digestOf({
                        root: rootId,
                        from: edge.from,
                        to: edge.to,
                        specifier: edge.specifier,
                        kind: edge.kind,
                        line: edge.line,
                        resolved: edge.resolved,
                        external: edge.external,
                        fingerprint: report.fingerprint,
                    }),
                    root_id: rootId,
                    from_path: edge.from,
                    to_path: edge.to,
                    specifier: edge.specifier,
                    kind: edge.kind,
                    line: edge.line,
                    resolved: edge.resolved ? 1 : 0,
                    external: edge.external ? 1 : 0,
                    fingerprint: report.fingerprint,
                    created_at: at,
                });
            }
            this.writeReportHeader(ImportReportPrefix, rootId, report.path, {
                fingerprint: report.fingerprint,
                truncated: report.truncated,
            });
        });
    }

    /**
     * Rebuild the import report of one exact file fingerprint.
     *
     * Only outgoing edges are persisted, so `importedBy` stays empty; the
     * service fills it from its index. `external` and `unresolved` are derived
     * from the stored edge flags. A report with no edges is served from the
     * header written by {@link replaceImports}, so an empty parse is cached
     * instead of being reparsed on every load.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param fingerprint - File content fingerprint.
     * @returns The rebuilt report, or `undefined` when absent or stale.
     */
    loadImports(rootId: string, path: string, fingerprint: string): ImportReport | undefined {
        const header: ReportHeader | undefined = this.readReportHeader(ImportReportPrefix, rootId, path);
        const rows: FileImportRow[] = this.queries.select({
            where: conditions(FileImportTable, ["root_id", "from_path", "fingerprint"]),
            params: [rootId, path, fingerprint],
            orderBy: `ORDER BY ${quoted(FileImportTable, "line")} ASC, ${quoted(FileImportTable, "import_id")} ASC`,
        });
        if (rows.length === 0) {
            if (header === (void 0) || header.fingerprint !== fingerprint) {
                return undefined;
            }
            return { path, fingerprint, imports: [], importedBy: [], external: [], unresolved: [], truncated: header.truncated };
        }
        const imports: ImportEdge[] = [];
        const external: string[] = [];
        const unresolved: string[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: FileImportRow = rows[index];
            imports.push(importEdgeOf(row));
            if (row.external === 1) {
                pushUnique(external, row.specifier);
            } else if (row.resolved === 0) {
                pushUnique(unresolved, row.specifier);
            }
        }
        return {
            path,
            fingerprint,
            imports,
            importedBy: [],
            external,
            unresolved,
            truncated: header !== (void 0) && header.fingerprint === fingerprint ? header.truncated : false,
        };
    }

    /**
     * Replace the exported symbols of one file in one transaction.
     *
     * The report header stores the exact re-export edges, including their
     * resolved/external flags, so reloading does not have to guess them from the
     * symbol rows.
     *
     * @param rootId - Session root id.
     * @param report - Parsed export report.
     * @param at - ISO timestamp for the write.
     */
    replaceExports(rootId: string, report: ExportReport, at: string): void {
        transaction(this.db, (): void => {
            this.exportsSql.deleteWhere(conditions(FileExportTable, ["root_id", "path"]), rootId, report.path);
            for (let index: number = 0; index < report.exports.length; index += 1) {
                const symbol: ExportSymbol = report.exports[index];
                this.exportsSql.upsert({
                    export_id: digestOf({
                        root: rootId,
                        path: report.path,
                        name: symbol.name,
                        kind: symbol.kind,
                        line: symbol.line,
                        signature: symbol.signature,
                        reexport: symbol.reexportFrom ?? null,
                        fingerprint: report.fingerprint,
                    }),
                    root_id: rootId,
                    path: report.path,
                    name: symbol.name,
                    kind: symbol.kind,
                    line: symbol.line,
                    signature: symbol.signature,
                    reexport_from: symbol.reexportFrom ?? null,
                    fingerprint: report.fingerprint,
                    created_at: at,
                });
            }
            this.writeReportHeader(ExportReportPrefix, rootId, report.path, {
                fingerprint: report.fingerprint,
                truncated: report.truncated,
                reexports: report.reexports,
            });
        });
    }

    /**
     * Rebuild the export report of one exact file fingerprint.
     *
     * Symbols come from `file_exports`; re-export edges and the truncation flag
     * come from the report header when it matches the requested fingerprint. For
     * rows written before headers existed, re-exports fall back to the symbols'
     * `reexportFrom` with conservative flags. A zero-symbol report is served
     * from the header so it remains cached.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param fingerprint - File content fingerprint.
     * @returns The rebuilt report, or `undefined` when absent or stale.
     */
    loadExports(rootId: string, path: string, fingerprint: string): ExportReport | undefined {
        const header: ReportHeader | undefined = this.readReportHeader(ExportReportPrefix, rootId, path);
        const rows: FileExportRow[] = this.exportsSql.select({
            where: conditions(FileExportTable, ["root_id", "path", "fingerprint"]),
            params: [rootId, path, fingerprint],
            orderBy: `ORDER BY ${quoted(FileExportTable, "line")} ASC, ${quoted(FileExportTable, "export_id")} ASC`,
        });
        if (rows.length === 0) {
            if (header === (void 0) || header.fingerprint !== fingerprint) {
                return undefined;
            }
            return { path, fingerprint, exports: [], reexports: header.reexports ?? [], truncated: header.truncated };
        }
        const exports: ExportSymbol[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            exports.push(exportSymbolOf(rows[index]));
        }
        const matches: boolean = header !== (void 0) && header.fingerprint === fingerprint;
        const reexports: readonly ImportEdge[] = matches && header !== (void 0) && header.reexports !== (void 0) ? header.reexports : derivedReexports(rows);
        return { path, fingerprint, exports, reexports, truncated: matches && header !== (void 0) ? header.truncated : false };
    }

    /**
     * Replace the dependency edges of one root in one transaction.
     *
     * Edge ids are stored verbatim in `from_path`/`to_path`, so both raw
     * root-relative path ids (the domain's usual file id) and scheme-qualified
     * ids such as `external:<specifier>` round-trip without rewriting. The table
     * has no specifier or line column, so the specifier is stored in `method`
     * and the line is still not persisted.
     *
     * @param rootId - Session root id.
     * @param graph - Dependency nodes and edges.
     * @param at - ISO timestamp for the write.
     */
    replaceDependencies(rootId: string, graph: DependencyGraph, at: string): void {
        const lines: Record<string, number> = {};
        transaction(this.db, (): void => {
            this.dependenciesSql.deleteWhere(conditions(FileDependencyTable, ["root_id"]), rootId);
            for (let index: number = 0; index < graph.edges.length; index += 1) {
                const edge: DependencyEdge = graph.edges[index];
                const id: string = dependencyId(rootId, edge);
                if (edge.line !== (void 0)) {
                    lines[id] = edge.line;
                }
                this.dependenciesSql.upsert({
                    dependency_id: id,
                    root_id: rootId,
                    from_path: edge.from,
                    to_path: edge.to,
                    kind: edge.kind,
                    method: edge.specifier ?? "",
                    fingerprint: "",
                    created_at: at,
                });
            }
            this.writeMeta(`${DependencyGraphPrefix}${rootId}`, canonical({ nodes: graph.nodes, lines }));
        });
    }

    /**
     * Rebuild the dependency nodes and edges of one root.
     *
     * Nodes are derived from the edge endpoints, so a node that has no edge is
     * not recoverable; every rebuilt node reports the empty fingerprint. Node
     * ids are returned exactly as stored. Edges are ordered by from-id, to-id
     * and edge id so a reload is stable.
     *
     * @param rootId - Session root id.
     * @returns Rebuilt graph, or `undefined` when the root has no edges.
     */
    loadDependencies(rootId: string): DependencyGraph | undefined {
        const header: DependencyHeader | undefined = this.readDependencyHeader(rootId);
        const rows: FileDependencyRow[] = this.dependenciesSql.select({
            where: conditions(FileDependencyTable, ["root_id"]),
            params: [rootId],
            orderBy: `ORDER BY ${quoted(FileDependencyTable, "from_path")} ASC, ${quoted(FileDependencyTable, "to_path")} ASC, ${quoted(FileDependencyTable, "dependency_id")} ASC`,
        });
        if (rows.length === 0 && (header === (void 0) || header.nodes.length === 0)) {
            return undefined;
        }
        const nodes: Map<string, DependencyNode> = new Map<string, DependencyNode>();
        if (header !== (void 0)) {
            for (let index: number = 0; index < header.nodes.length; index += 1) {
                const stored: DependencyNode = header.nodes[index];
                nodes.set(stored.id, stored);
            }
        }
        const edges: DependencyEdge[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: FileDependencyRow = rows[index];
            const from: string = row.from_path;
            const to: string = row.to_path;
            if (!nodes.has(from)) {
                nodes.set(from, dependencyNode(from));
            }
            if (!nodes.has(to)) {
                nodes.set(to, dependencyNode(to));
            }
            const kind: DependencyEdgeKind = row.kind as DependencyEdgeKind;
            const base: DependencyEdge = row.method.length === 0 ? { from, to, kind } : { from, to, kind, specifier: row.method };
            const line: number | undefined = header === (void 0) ? undefined : header.lines[row.dependency_id];
            edges.push(line === (void 0) ? base : { ...base, line });
        }
        return {
            nodes: [...nodes.values()].sort((left: DependencyNode, right: DependencyNode): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
            edges,
        };
    }

    /**
     * Read the dependency revision recorded for one root.
     *
     * The value lives in the shared `meta` table under
     * `file_dependencies.revision.<rootId>` because the dependency table has no
     * revision column and adding a table is outside this repository's contract.
     *
     * @param rootId - Session root id.
     * @returns Revision text, or `undefined` when the root has none.
     */
    loadRevision(rootId: string): string | undefined {
        return this.readMeta(`${DependencyRevisionPrefix}${rootId}`);
    }

    /**
     * Record the dependency revision of one root.
     *
     * @param rootId - Session root id.
     * @param revision - Revision text.
     */
    saveRevision(rootId: string, revision: string): void {
        this.writeMeta(`${DependencyRevisionPrefix}${rootId}`, revision);
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
     * Read the report header of one file.
     *
     * @param prefix - Header family prefix.
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @returns Header, or `undefined` when absent or malformed.
     */
    private readReportHeader(prefix: string, rootId: string, path: string): ReportHeader | undefined {
        const text: string | undefined = this.readMeta(reportKey(prefix, rootId, path));
        return text === (void 0) ? undefined : parseReportHeader(text);
    }

    /**
     * Insert or replace the report header of one file.
     *
     * @param prefix - Header family prefix.
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param header - Header to persist.
     */
    private writeReportHeader(prefix: string, rootId: string, path: string, header: ReportHeader): void {
        this.writeMeta(reportKey(prefix, rootId, path), canonical(header));
    }

    /**
     * Read the dependency header of one root.
     *
     * @param rootId - Session root id.
     * @returns Header, or `undefined` when absent or malformed.
     */
    private readDependencyHeader(rootId: string): DependencyHeader | undefined {
        const text: string | undefined = this.readMeta(`${DependencyGraphPrefix}${rootId}`);
        return text === (void 0) ? undefined : parseDependencyHeader(text);
    }
}
