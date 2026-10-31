import type { Charset } from "../syntax/types.ts";
import type { OutlineResult } from "../outline/types.ts";
export type { OutlineKind, OutlineCategory, OutlineRange, OutlineType, OutlineNode, OutlineResult, WireOutlineRange, WireOutlineNode, WireOutlineResult } from "../outline/types.ts";

/**
 * Filesystem domain types.
 *
 * The model is deliberately tree-first. A directory owns an ordered set of
 * `File`/`Directory` nodes; a file has no children. Every node carries the
 * metadata an agent needs to decide whether to read it before paying for the
 * content: a content fingerprint, charset, line/byte counts, timestamps and a
 * short description/summary/purpose.
 *
 * The in-process shape uses `bigint` for `lines` and `bytes` so a large tree
 * cannot silently lose precision. JSON has no bigint, so the wire projection
 * (`WireTreeNode`) spells the same values as decimal strings; both forms are
 * part of the public contract.
 */
import type { SessionRoot } from "../session/types.ts";

/**
 * Charset detected for a node. Directories use `none`; files that do not
 * decode as UTF-8/UTF-16 and do not look like text use `binary`.
 */
export type { Charset } from "../syntax/types.ts";

/**
 * Timestamp format used by node metadata: `yyyy-MM-ddTHH:mm:ss` with no zone
 * suffix. The filesystem service defaults to host-local wall time because that
 * is what a user sees in an explorer; hosts that need reproducible snapshots
 * can request UTC.
 */
export type NodeTime = string;

/**
 * `Date.toISOString()`-shaped timestamp used by protocol envelopes, audits and
 * persistence rows. Node metadata uses the shorter `NodeTime` form.
 */
export type IsoTime = string;

/**
 * Host-supplied, path-keyed override of the derived metadata. An override is
 * descriptive only: it never changes access checks or the content fingerprint.
 */
export interface NodeAnnotation {
    readonly description?: string;
    readonly summary?: string;
    readonly purpose?: string;
}

/**
 * Metadata shared by files and directories. `fingerprint` is a content-address
 * ref: `sha256:<hex>` of the file bytes, or a domain-separated Merkle digest of
 * the sorted child refs for a directory.
 */
export interface NodeMetadata {
    readonly fingerprint: string;
    readonly charset: Charset;
    readonly lines: bigint;
    readonly bytes: bigint;
    readonly create: NodeTime;
    readonly modify: NodeTime;
    readonly description: string;
    readonly summary: string;
    readonly purpose: string;
}

/**
 * Leaf node. `children` is always the empty tuple, which makes the tree shape
 * checkable by the type system rather than by a convention.
 */
export interface FileNode extends NodeMetadata {
    readonly type: "File";
    readonly path: string;
    readonly name: string;
    readonly extension: string;
    readonly children: readonly [];
}

/**
 * Interior node. `bytes`/`lines` aggregate descendants; `modify` is the latest
 * descendant modification so a directory answers "when did this subtree last
 * change?" without walking it again.
 */
export interface DirectoryNode extends NodeMetadata {
    readonly type: "Directory";
    readonly path: string;
    readonly name: string;
    readonly extension: "directory";
    readonly children: readonly TreeNode[];
}

/**
 * Any tree node.
 */
export type TreeNode = FileNode | DirectoryNode;

/**
 * Derived node statistics used by service limits without re-walking the tree.
 */
export interface TreeStats {
    readonly files: bigint;
    readonly directories: bigint;
    readonly lines: bigint;
    readonly bytes: bigint;
    readonly truncated: boolean;
}

/**
 * Options that bound a tree build. `maxNodes` and `maxBytes` stop the walk with
 * `truncated: true` instead of exhausting memory; callers can then list a
 * subtree or raise the bound explicitly.
 */
export interface TreeOptions {
    readonly maxNodes?: number;
    readonly maxBytes?: bigint;
    readonly exclude?: readonly string[];
    readonly annotations?: Readonly<Record<string, NodeAnnotation>>;
    readonly followSymlinks?: boolean;
    readonly timeZone?: "local" | "utc";
    readonly includeHidden?: boolean;
}

/**
 * Snapshot returned by a tree build. `revision` changes whenever a node's
 * fingerprint, annotation or child set changes.
 */
export interface TreeSnapshot {
    readonly root: DirectoryNode;
    readonly revision: string;
    readonly stats: TreeStats;
}

/**
 * Wire projection of a node. Lines and bytes are decimal strings because JSON
 * cannot represent `bigint`; a reader parses them with `BigInt`.
 */
export interface WireFileNode extends Omit<FileNode, "children" | "lines" | "bytes"> {
    readonly children: readonly [];
    readonly lines: string;
    readonly bytes: string;
}

/**
 * Wire projection of a directory node.
 */
export interface WireDirectoryNode extends Omit<DirectoryNode, "children" | "lines" | "bytes"> {
    readonly children: readonly WireTreeNode[];
    readonly lines: string;
    readonly bytes: string;
}

/**
 * Wire node union.
 */
export type WireTreeNode = WireFileNode | WireDirectoryNode;

/**
 * A bounded directory listing. `nextOffset` is null when the page is complete.
 */
export interface DirectoryListing {
    readonly path: string;
    readonly revision: string;
    readonly entries: readonly WireTreeNode[];
    readonly total: number;
    readonly nextOffset: number | null;
}

/**
 * Read request. Offsets are 1-based line numbers; `maxBytes` bounds the decoded
 * text and `maxLines` bounds the line count. `startLine > 1` costs a scan to
 * that line, so a caller paging a huge file should keep the page size stable.
 */
export interface ReadRequest {
    readonly path: string;
    readonly startLine?: number;
    readonly maxLines?: number;
    readonly maxBytes?: number;
    readonly includeLineNumbers?: boolean;
}

/**
 * One bounded read page. `nextStartLine` is null at EOF. `text` is decoded with
 * the node charset; binary files are refused before any text is produced.
 */
export interface ReadPage {
    readonly path: string;
    readonly fingerprint: string;
    readonly charset: Charset;
    readonly offset: number;
    readonly startLine: number;
    readonly endLine: number;
    readonly totalLines: bigint;
    readonly bytesRead: number;
    readonly totalBytes: bigint;
    readonly text: string;
    readonly nextStartLine: number | null;
    readonly truncated: boolean;
    readonly binary: boolean;
}

/**
 * Write mode. `create` fails when the file exists, `overwrite` requires an
 * existing file, and `upsert` does either. CAS via `expectFingerprint` is an
 * additional guard on top of the mode.
 */
export type WriteMode = "create" | "overwrite" | "upsert" | "append";

/**
 * Write request. When `expectFingerprint` is present the write is rejected
 * unless the current file still has that fingerprint; `null` means "expect no
 * file". `dryRun` runs every check and returns the projected node without
 * touching the disk.
 */
export interface WriteRequest {
    readonly path: string;
    readonly content: string | Uint8Array;
    readonly encoding?: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1";
    readonly mode?: WriteMode;
    readonly expectFingerprint?: string | null;
    readonly createParents?: boolean;
    readonly dryRun?: boolean;
}

/**
 * Result of a successful (or dry-run) write.
 */
export interface WriteResult {
    readonly node: FileNode;
    readonly previousFingerprint: string | null;
    readonly created: boolean;
    readonly dryRun: boolean;
    readonly bytesWritten: bigint;
    readonly revision: string;
}

/**
 * Journal record for one successful write. The journal is metadata only; the
 * previous bytes are recoverable from the object store/CAS when the host keeps
 * one, so this module does not duplicate file content.
 */
export interface WriteJournalEntry {
    readonly id: string;
    readonly sessionId: string;
    readonly rootId: string;
    readonly path: string;
    readonly mode: WriteMode;
    readonly previousFingerprint: string | null;
    readonly nextFingerprint: string;
    readonly bytes: bigint;
    readonly at: IsoTime;
}

/**
 * Import edge kinds. `export-from` is tracked because a re-export is still a
 * dependency edge even though it is not an import statement.
 */
export type ImportKind = "static" | "dynamic" | "require" | "export-from" | "type";

/**
 * One module edge. `from` and `to` are root-relative POSIX paths; `to` is the
 * resolved path for internal edges and the bare specifier for external ones.
 */
export interface ImportEdge {
    readonly from: string;
    readonly to: string;
    readonly specifier: string;
    readonly kind: ImportKind;
    readonly line: number;
    readonly resolved: boolean;
    readonly external: boolean;
}

/**
 * Import report for one file. `importedBy` is the reverse edge list, which is
 * what makes "who breaks if I change this?" cheap.
 */
export interface ImportReport {
    readonly path: string;
    readonly fingerprint: string;
    readonly imports: readonly ImportEdge[];
    readonly importedBy: readonly ImportEdge[];
    readonly external: readonly string[];
    readonly unresolved: readonly string[];
    readonly truncated: boolean;
}

/**
 * Exported symbol kinds.
 */
export type ExportKind = "function" | "class" | "interface" | "type" | "enum" | "const" | "let" | "var" | "default" | "namespace" | "reexport";

/**
 * One exported symbol with its source range and a bounded signature.
 */
export interface ExportSymbol {
    readonly name: string;
    readonly kind: ExportKind;
    readonly line: number;
    readonly signature: string;
    readonly reexportFrom?: string;
}

/**
 * Export report for one file.
 */
export interface ExportReport {
    readonly path: string;
    readonly fingerprint: string;
    readonly exports: readonly ExportSymbol[];
    readonly reexports: readonly ImportEdge[];
    readonly truncated: boolean;
}

/**
 * Node role in a dependency graph. Packages are included so a workspace file
 * can depend on an external package without pretending it is a source file.
 */
export type DependencyNodeKind = "file" | "directory" | "package";

/**
 * One dependency graph node.
 */
export interface DependencyNode {
    readonly id: string;
    readonly path: string;
    readonly kind: DependencyNodeKind;
    readonly fingerprint: string;
}

/**
 * Dependency edge kinds. `import`/`export`/`reference` come from source facts;
 * `package` comes from a manifest declaration.
 */
export type DependencyEdgeKind = "import" | "export" | "reference" | "package";

/**
 * One directed dependency edge. `to` is a node id, not necessarily a path.
 */
export interface DependencyEdge {
    readonly from: string;
    readonly to: string;
    readonly kind: DependencyEdgeKind;
    readonly specifier?: string;
    readonly line?: number;
}

/**
 * Graph query mode. `cycles` returns strongly connected components with more
 * than one node; `topological` returns a deterministic order or the blocking
 * SCCs when the graph is cyclic.
 */
export type DependencyMode = "cycles" | "topological" | "dependencies" | "dependents" | "closure";

/**
 * Bounded dependency report. `order` is present for `topological`; `cycles`
 * is present for `cycles` (and for a cyclic topological request).
 */
export interface DependencyReport {
    readonly revision: string;
    readonly mode: DependencyMode;
    readonly roots: readonly string[];
    readonly nodes: readonly DependencyNode[];
    readonly edges: readonly DependencyEdge[];
    readonly order: readonly string[];
    readonly cycles: readonly (readonly string[])[];
    readonly unresolved: readonly string[];
    readonly external: readonly string[];
    readonly truncated: boolean;
}

/**
 * Errors are classified so a transport can map them to stable tool error codes
 * without parsing messages. Every message is code-only, mirroring the existing
 * workspace service: host paths never leak through an error string.
 */
export type FilesystemErrorCode =
    | "invalid_arguments"
    | "session_unavailable"
    | "permission_denied"
    | "invalid_path"
    | "path_escape"
    | "symlink_denied"
    | "excluded_path"
    | "not_found"
    | "not_file"
    | "not_directory"
    | "already_exists"
    | "binary_file"
    | "charset_unsupported"
    | "fingerprint_mismatch"
    | "lock_conflict"
    | "quota_exceeded"
    | "parse_failed"
    | "store_failure"
    | "internal_error";

/**
 * Persistence port for the filesystem domain. The SQLite adapter implements
 * this; the service itself only sees the port so the tree can also run in
 * memory for tests and one-shot CLI use.
 */
export interface FilesystemStore {
    loadTree(rootId: string): TreeSnapshot | undefined;
    saveTree(rootId: string, snapshot: TreeSnapshot): void;
    loadAnnotations(rootId: string): Record<string, NodeAnnotation>;
    saveAnnotation(rootId: string, path: string, annotation: NodeAnnotation, source: string): void;
    appendWrite(entry: WriteJournalEntry): void;
    listWrites(sessionId: string, limit: number): WriteJournalEntry[];
    loadOutline(rootId: string, path: string, fingerprint: string): OutlineResult | undefined;
    saveOutline(rootId: string, outline: OutlineResult): void;
    loadImports(rootId: string, path: string, fingerprint: string): ImportReport | undefined;
    saveImports(rootId: string, report: ImportReport): void;
    loadExports(rootId: string, path: string, fingerprint: string): ExportReport | undefined;
    saveExports(rootId: string, report: ExportReport): void;
    loadDependencyRevision(rootId: string): string | undefined;
    saveDependencyRevision(rootId: string, revision: string): void;
}

/**
 * Resolved path within one session root.
 */
export interface RootedPath {
    readonly root: SessionRoot;
    readonly relative: string;
    readonly absolute: string;
}
