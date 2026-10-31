/**
 * SQLite adapter for the filesystem persistence port.
 *
 * The adapter owns the mapping between `src/file` domain values and the
 * row repositories; the service never sees a row, and the repositories never
 * see a `TreeSnapshot`. `loadTree` rebuilds the snapshot from flat rows with one
 * query per root (no per-directory round trips), and `saveTree` replaces the
 * whole tree in one transaction so a half-written index is not observable.
 *
 * Timestamps that the port does not carry are taken from the wall clock as ISO
 * strings; the domain's node times are already stored on the node rows.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Charset } from "../../syntax/types.ts";
import type { DirectoryNode, ExportReport, FileNode, FilesystemStore, ImportReport, NodeAnnotation, TreeSnapshot, TreeNode, WriteJournalEntry, WriteMode } from "../../file/types.ts";
import type { OutlineResult } from "../../outline/types.ts";
import type { FileNodeRow, FileWriteRow } from "../entity/fileTree.ts";
import { FileAnnotationRepository } from "../repository/fileAnnotationRepository.ts";
import { FileGraphRepository } from "../repository/fileGraphRepository.ts";
import { FileNodeRepository } from "../repository/fileNodeRepository.ts";
import { FileOutlineRepository } from "../repository/fileOutlineRepository.ts";
import { FileWriteRepository } from "../repository/fileWriteRepository.ts";

/**
 * Current wall-clock timestamp for writes the port does not date itself.
 *
 * @returns ISO timestamp.
 */
const now: () => string = (): string => new Date().toISOString();

/**
 * Order direct children directory-first, then by name.
 *
 * @param left - Left row.
 * @param right - Right row.
 * @returns Negative, zero or positive for the usual sort contract.
 */
const compareRows: (left: FileNodeRow, right: FileNodeRow) => number = (left: FileNodeRow, right: FileNodeRow): number => {
    if (left.type !== right.type) {
        return left.type === "Directory" ? -1 : 1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
};

/**
 * Build a leaf node from one row.
 *
 * @param row - `File` row.
 * @returns File node with the decimal counts parsed back to `bigint`.
 */
const fileNodeOf: (row: FileNodeRow) => FileNode = (row: FileNodeRow): FileNode => ({
    type: "File",
    path: row.path,
    name: row.name,
    extension: row.extension,
    children: [],
    fingerprint: row.fingerprint,
    charset: row.charset as Charset,
    lines: BigInt(row.lines),
    bytes: BigInt(row.bytes),
    create: row.created_at,
    modify: row.modified_at,
    description: row.description,
    summary: row.summary,
    purpose: row.purpose,
});

/**
 * Factory shape for interior nodes.
 */
type DirectoryNodeFactory = (row: FileNodeRow, children: readonly TreeNode[]) => DirectoryNode;

/**
 * Build an interior node from one row and its already-built children.
 *
 * @param row - `Directory` row.
 * @param children - Ordered child nodes.
 * @returns Directory node.
 * @throws Error when the persisted extension is not the directory marker.
 */
const directoryNodeOf: DirectoryNodeFactory = (row: FileNodeRow, children: readonly TreeNode[]): DirectoryNode => {
    if (row.extension !== "directory") {
        throw new Error(`invalid directory extension: ${row.extension}`);
    }
    return {
        type: "Directory",
        path: row.path,
        name: row.name,
        extension: row.extension,
        children,
        fingerprint: row.fingerprint,
        charset: row.charset as Charset,
        lines: BigInt(row.lines),
        bytes: BigInt(row.bytes),
        create: row.created_at,
        modify: row.modified_at,
        description: row.description,
        summary: row.summary,
        purpose: row.purpose,
    };
};

/**
 * Filesystem port adapter over the file tree, journal, outline and graph tables.
 */
export class SqliteFilesystemStore implements FilesystemStore {
    private readonly nodes: FileNodeRepository;
    private readonly annotations: FileAnnotationRepository;
    private readonly writes: FileWriteRepository;
    private readonly outlines: FileOutlineRepository;
    private readonly graphs: FileGraphRepository;

    /**
     * Create the adapter.
     *
     * @param db - Open SQLite connection with the schema applied.
     */
    constructor(db: DatabaseSync) {
        this.nodes = new FileNodeRepository(db);
        this.annotations = new FileAnnotationRepository(db);
        this.writes = new FileWriteRepository(db);
        this.outlines = new FileOutlineRepository(db);
        this.graphs = new FileGraphRepository(db);
    }

    /**
     * Rebuild a snapshot from the persisted rows.
     *
     * @param rootId - Session root id.
     * @returns The snapshot, or `undefined` when the root has no persisted tree.
     */
    loadTree(rootId: string): TreeSnapshot | undefined {
        const rows: FileNodeRow[] = this.nodes.listNodes(rootId);
        if (rows.length === 0) {
            return undefined;
        }
        const byParent: Map<string | null, FileNodeRow[]> = new Map<string | null, FileNodeRow[]>();
        let rootRow: FileNodeRow | undefined = undefined;
        let rootCount: number = 0;
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: FileNodeRow = rows[index];
            if (row.parent_path === null) {
                rootCount += 1;
                rootRow = row;
            }
            const bucket: FileNodeRow[] | undefined = byParent.get(row.parent_path);
            if (bucket === (void 0)) {
                byParent.set(row.parent_path, [row]);
            } else {
                bucket.push(row);
            }
        }
        if (rootRow === (void 0)) {
            return undefined;
        }
        if (rootCount > 1) {
            throw new Error(`multiple root nodes for ${rootId}`);
        }
        const root: TreeNode = this.buildNode(rootRow, byParent);
        if (root.type !== "Directory") {
            throw new Error(`root node is not a directory: ${rootId}`);
        }
        let files: bigint = 0n;
        let directories: bigint = 0n;
        let lines: bigint = 0n;
        let bytes: bigint = 0n;
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: FileNodeRow = rows[index];
            if (row.type === "File") {
                files += 1n;
                lines += BigInt(row.lines);
                bytes += BigInt(row.bytes);
            } else {
                directories += 1n;
            }
        }
        return {
            root,
            revision: rootRow.revision,
            stats: { files, directories, lines, bytes, truncated: this.nodes.loadTruncated(rootId) },
        };
    }

    /**
     * Replace the persisted tree of one root.
     *
     * @param rootId - Session root id.
     * @param snapshot - Snapshot to persist.
     */
    saveTree(rootId: string, snapshot: TreeSnapshot): void {
        this.nodes.replaceTree(rootId, snapshot, now());
    }

    /**
     * Read every annotation of one root.
     *
     * @param rootId - Session root id.
     * @returns Path-keyed annotations.
     */
    loadAnnotations(rootId: string): Record<string, NodeAnnotation> {
        return this.annotations.load(rootId);
    }

    /**
     * Insert or replace one annotation.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param annotation - Host override.
     * @param source - Who supplied the override.
     */
    saveAnnotation(rootId: string, path: string, annotation: NodeAnnotation, source: string): void {
        this.annotations.upsert(rootId, path, annotation, source, now());
    }

    /**
     * Append one journal record.
     *
     * @param entry - Journal entry.
     */
    appendWrite(entry: WriteJournalEntry): void {
        this.writes.append(entry, entry.rootId);
    }

    /**
     * Read a session's journal, newest first.
     *
     * @param sessionId - Session handle.
     * @param limit - Maximum rows.
     * @returns Journal entries.
     */
    listWrites(sessionId: string, limit: number): WriteJournalEntry[] {
        const rows: FileWriteRow[] = this.writes.list(sessionId, limit);
        const entries: WriteJournalEntry[] = [];
        for (let index: number = 0; index < rows.length; index += 1) {
            const row: FileWriteRow = rows[index];
            entries.push({
                id: `${row.write_id}`,
                sessionId: row.session_id,
                rootId: row.root_id,
                path: row.path,
                mode: row.mode as WriteMode,
                previousFingerprint: row.previous_fingerprint,
                nextFingerprint: row.next_fingerprint,
                bytes: BigInt(row.bytes),
                at: row.at,
            });
        }
        return entries;
    }

    /**
     * Load a cached outline by exact fingerprint.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param fingerprint - File content fingerprint.
     * @returns Cached outline, or `undefined`.
     */
    loadOutline(rootId: string, path: string, fingerprint: string): OutlineResult | undefined {
        return this.outlines.load(rootId, path, fingerprint);
    }

    /**
     * Insert or replace one outline.
     *
     * @param rootId - Session root id.
     * @param outline - Parsed outline.
     */
    saveOutline(rootId: string, outline: OutlineResult): void {
        this.outlines.save(rootId, outline, now());
    }

    /**
     * Load a cached import report by exact fingerprint.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param fingerprint - File content fingerprint.
     * @returns Cached report, or `undefined`.
     */
    loadImports(rootId: string, path: string, fingerprint: string): ImportReport | undefined {
        return this.graphs.loadImports(rootId, path, fingerprint);
    }

    /**
     * Replace the import edges of one file.
     *
     * @param rootId - Session root id.
     * @param report - Parsed import report.
     */
    saveImports(rootId: string, report: ImportReport): void {
        this.graphs.replaceImports(rootId, report, now());
    }

    /**
     * Load a cached export report by exact fingerprint.
     *
     * @param rootId - Session root id.
     * @param path - Root-relative POSIX path.
     * @param fingerprint - File content fingerprint.
     * @returns Cached report, or `undefined`.
     */
    loadExports(rootId: string, path: string, fingerprint: string): ExportReport | undefined {
        return this.graphs.loadExports(rootId, path, fingerprint);
    }

    /**
     * Replace the exported symbols of one file.
     *
     * @param rootId - Session root id.
     * @param report - Parsed export report.
     */
    saveExports(rootId: string, report: ExportReport): void {
        this.graphs.replaceExports(rootId, report, now());
    }

    /**
     * Read the dependency revision recorded for one root.
     *
     * @param rootId - Session root id.
     * @returns Revision text, or `undefined`.
     */
    loadDependencyRevision(rootId: string): string | undefined {
        return this.graphs.loadRevision(rootId);
    }

    /**
     * Record the dependency revision of one root.
     *
     * @param rootId - Session root id.
     * @param revision - Revision text.
     */
    saveDependencyRevision(rootId: string, revision: string): void {
        this.graphs.saveRevision(rootId, revision);
    }

    /**
     * Build one node and its descendants from the grouped rows.
     *
     * @param row - Row to build.
     * @param byParent - Rows grouped by `parent_path`.
     * @returns The built node.
     */
    private buildNode(row: FileNodeRow, byParent: Map<string | null, FileNodeRow[]>): TreeNode {
        if (row.type === "File") {
            return fileNodeOf(row);
        }
        if (row.type !== "Directory") {
            throw new Error(`invalid file node type: ${row.type}`);
        }
        const bucket: FileNodeRow[] | undefined = byParent.get(row.path);
        const children: TreeNode[] = [];
        if (bucket !== (void 0)) {
            const ordered: FileNodeRow[] = [...bucket].sort(compareRows);
            for (let index: number = 0; index < ordered.length; index += 1) {
                children.push(this.buildNode(ordered[index], byParent));
            }
        }
        return directoryNodeOf(row, children);
    }
}
