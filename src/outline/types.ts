import type { Charset, SourceRange } from "../syntax/types.ts";
import type { FileNode, DirectoryNode, WireFileNode, WireDirectoryNode } from "../file/types.ts";

/**
 * Outline symbol kinds. The set is intentionally language-neutral; a renderer
 * can group by `language` and `kind` without learning a new enum per parser.
 */
export type OutlineKind =
    | "heading"
    | "part"
    | "chapter"
    | "section"
    | "subsection"
    | "paragraph"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "namespace"
    | "struct"
    | "trait"
    | "object"
    | "module"
    | "function"
    | "method"
    | "property"
    | "constant"
    | "variable"
    | "component"
    | "hook"
    | "props"
    | "jsx"
    | "key"
    | "environment"
    | "reference"
    | "package"
    | "dependency"
    | "plugin"
    | "target"
    | "task"
    | "script"
    | "workspace"
    | "profile"
    | "macro";

/**
 * Broad outline family. The `strategy` field on the result is the precise
 * parser; the category lets a caller render a code tree differently from a
 * project model or a book's table of contents without knowing every strategy.
 */
export type OutlineCategory = "code" | "project" | "prose" | "data" | "other";

/** Source coordinates shared with the syntax layer. */
export type OutlineRange = SourceRange;

/**
 * Node type. File/Directory anchor an outline to a tree object; the remaining
 * values are symbol kinds inside that object.
 */
export type OutlineType = "File" | "Directory" | OutlineKind;

/**
 * One outline node.
 *
 * The same shape describes a tree object and a symbol:
 * - a file anchor has `isFile: true`, `file` set, `path: "add.py"`, `type: "File"`;
 * - a directory anchor has `isDirectory: true`, `directory` set, `path: "src"`,
 *   `type: "Directory"`;
 * - a symbol has both flags false, no `file`/`directory`, a `path` such as
 *   `"add.py#add"` or `"add.py#Numerical.solve"`, and a symbol `type`.
 *
 * `file`/`directory` are optional so a symbol does not repeat a whole node and
 * a caller can decide whether it needs the anchor object.
 */
export interface OutlineNode {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly file?: FileNode;
    readonly directory?: DirectoryNode;
    readonly path: string;
    readonly type: OutlineType;
    readonly range: OutlineRange;
    readonly label: string;
    readonly depth: number;
    /**
     * Declaration modifiers in source order, e.g. `["static"]`,
     * `["public", "readonly"]`. Empty/absent means no modifier.
     */
    readonly modifiers?: readonly string[];
    readonly detail?: string;
    readonly children: readonly OutlineNode[];
}

/**
 * Outline extraction result. `language` is a stable lowercase tag such as
 * `markdown`, `typescript`, `json`, `css` or `tex`; `strategy` is the precise
 * parser (for example `maven` or `plainText`); `target` says whether the root
 * anchor is a file or a directory.
 */
export interface OutlineResult {
    readonly path: string;
    readonly fingerprint: string;
    readonly language: string;
    readonly strategy: string;
    readonly category: OutlineCategory;
    readonly target: "file" | "directory";
    readonly charset: Charset;
    readonly nodes: readonly OutlineNode[];
    readonly truncated: boolean;
}

/**
 * JSON projection of an `OutlineRange`. Byte/line values become decimal
 * strings because JSON has no bigint; a reader restores them with `BigInt`.
 */
export interface WireOutlineRange {
    readonly startByte: string;
    readonly endByte: string;
    readonly startLine: string;
    readonly endLine: string;
}

/**
 * JSON projection of an outline node. `file`/`directory` anchors use the same
 * wire projection as the `file` tool, so a client has one parser for both.
 */
export interface WireOutlineNode extends Omit<OutlineNode, "file" | "directory" | "range" | "children"> {
    readonly file?: WireFileNode;
    readonly directory?: WireDirectoryNode;
    readonly range: WireOutlineRange;
    readonly children: readonly WireOutlineNode[];
}

/**
 * JSON projection of a complete outline result, used by MCP responses and by
 * the `file_outlines.data_json` column.
 */
export interface WireOutlineResult extends Omit<OutlineResult, "nodes"> {
    readonly nodes: readonly WireOutlineNode[];
}

