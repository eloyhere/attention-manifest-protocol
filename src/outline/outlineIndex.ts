/**
 * Index structures over an outline.
 *
 * `buildOutline` produces a JSON tree, which is the right wire shape but the
 * wrong lookup structure: an agent that knows a symbol name should not walk the
 * whole tree, and an agent that knows a line range should not scan every node.
 * This module projects the tree into three indexes:
 *
 * - `AbstractSyntaxTree` for parent/child traversal and structural identity;
 * - `Trie` for case-insensitive label-prefix lookup;
 * - `SegmentTree` over line numbers for range/stabbing queries. Each leaf holds
 *   the ids of nodes covering that line; a range query concatenates the
 *   canonical segment values and deduplicates.
 *
 * The indexes are derived and disposable. They never mutate the `OutlineResult`
 * and are rebuilt from a changed fingerprint rather than patched in place.
 */
import { AbstractSyntaxTree } from "../structure/abstractSyntaxTree.ts";
import type { AstNode } from "../structure/abstractSyntaxTree.ts";
import { SegmentTree } from "../structure/segmentTree.ts";
import { Trie } from "../structure/trie.ts";
import { wireNode } from "../file/file.ts";
import type { DirectoryNode, FileNode, TreeNode, WireDirectoryNode, WireFileNode, WireTreeNode } from "../file/types.ts";
import type { OutlineNode, OutlineRange, OutlineResult, WireOutlineNode, WireOutlineRange, WireOutlineResult } from "./types.ts";

/**
 * Payload carried by the AST projection.
 */
export interface OutlinePayload {
    readonly node: OutlineNode;
    readonly path: string;
}

/**
 * Maximum number of lines a segment index will materialize. A structure with a
 * larger range is clamped; callers still see `truncated: true` from the parser.
 */
const MaxIndexedLines: number = 10_000;

const flattenNodes: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] => {
    const result: OutlineNode[] = [];
    const stack: OutlineNode[] = [...nodes].reverse();
    while (stack.length > 0) {
        const node: OutlineNode = stack.pop()!;
        result.push(node);
        for (let index: number = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return result;
};

const lineNumber: (value: bigint) => number = (value: bigint): number => {
    const converted: number = Number(value);
    return Number.isSafeInteger(converted) && converted > 0 ? converted : 1;
};

const nodeId: (node: OutlineNode) => string = (node: OutlineNode): string => `${node.path}|${node.type}|${node.range.startLine.toString()}`;

/**
 * Line-oriented segment index. Leaves are line numbers; values are node ids.
 */
class LineOwners {
    private readonly tree: SegmentTree<readonly string[]>;
    private readonly lineCount: number;

    constructor(lineCount: number) {
        this.lineCount = Math.max(1, Math.min(lineCount, MaxIndexedLines));
        const values: string[][] = Array.from({ length: this.lineCount }, (): string[] => []);
        this.tree = new SegmentTree<readonly string[]>({
            size: this.lineCount,
            operation: (left: readonly string[], right: readonly string[]): readonly string[] => [...left, ...right],
            identity: [],
            values,
        });
    }

    add(line: number, id: string): void {
        if (line < 1 || line > this.lineCount) {
            return;
        }
        this.tree.update(line - 1, (previous: readonly string[]): readonly string[] => [...previous, id]);
    }

    query(startLine: number, endLine: number): string[] {
        const left: number = Math.max(1, startLine);
        const right: number = Math.min(this.lineCount, endLine);
        if (left > right) {
            return [];
        }
        return [...this.tree.query(left - 1, right)];
    }
}

export class OutlineIndex {
    readonly result: OutlineResult;
    readonly ast: AbstractSyntaxTree<OutlinePayload>;
    readonly size: number;
    private readonly labels: Trie<readonly OutlineNode[]> = new Trie<readonly OutlineNode[]>();
    private readonly byId: Map<string, OutlineNode> = new Map<string, OutlineNode>();
    private readonly paths: Map<string, string> = new Map<string, string>();
    private readonly owners: LineOwners;
    private readonly flat: readonly OutlineNode[];

    constructor(result: OutlineResult) {
        this.result = result;
        this.flat = flattenNodes(result.nodes);
        this.size = this.flat.length;
        const root: AstNode<OutlinePayload> = {
            kind: "outline",
            children: [],
        };
        const stack: Array<{ source: OutlineNode; target: AstNode<OutlinePayload>; path: string; }> = [];
        for (let index: number = result.nodes.length - 1; index >= 0; index -= 1) {
            stack.push({ source: result.nodes[index], target: root, path: "" });
        }
        let maxLine: number = 1;
        while (stack.length > 0) {
            const current: { source: OutlineNode; target: AstNode<OutlinePayload>; path: string; } = stack.pop()!;
            const id: string = nodeId(current.source);
            const path: string = current.source.path;
            const node: AstNode<OutlinePayload> = {
                kind: current.source.type,
                children: [],
                value: { node: current.source, path },
            };
            current.target.children.push(node);
            this.byId.set(id, current.source);
            this.paths.set(id, path);
            const key: string = current.source.label.trim().toLowerCase();
            if (key.length > 0) {
                const existing: readonly OutlineNode[] | undefined = this.labels.get(key);
                this.labels.insert(key, [...(existing ?? []), current.source]);
            }
            maxLine = Math.max(maxLine, lineNumber(current.source.range.endLine));
            for (let index: number = current.source.children.length - 1; index >= 0; index -= 1) {
                stack.push({ source: current.source.children[index], target: node, path });
            }
        }
        this.ast = new AbstractSyntaxTree<OutlinePayload>(root);
        this.owners = new LineOwners(maxLine);
        for (let index: number = 0; index < this.flat.length; index += 1) {
            const node: OutlineNode = this.flat[index];
            const id: string = nodeId(node);
            const start: number = lineNumber(node.range.startLine);
            const end: number = Math.min(lineNumber(node.range.endLine), MaxIndexedLines);
            for (let line: number = start; line <= end; line += 1) {
                this.owners.add(line, id);
            }
        }
    }

    /**
     * Case-insensitive label-prefix lookup, ordered by line then depth.
     */
    find(prefix: string, limit: number = 50): OutlineNode[] {
        const key: string = prefix.trim().toLowerCase();
        if (key.length === 0) {
            return [];
        }
        const matches: OutlineNode[] = [];
        const seen: Set<string> = new Set<string>();
        const entries: Array<readonly [string, readonly OutlineNode[]]> = this.labels.entries(key);
        for (let index: number = 0; index < entries.length; index += 1) {
            const nodes: readonly OutlineNode[] = entries[index][1];
            for (let nodeIndex: number = 0; nodeIndex < nodes.length; nodeIndex += 1) {
                const node: OutlineNode = nodes[nodeIndex];
                const id: string = nodeId(node);
                if (!seen.has(id)) {
                    seen.add(id);
                    matches.push(node);
                }
            }
        }
        matches.sort((left: OutlineNode, right: OutlineNode): number => lineNumber(left.range.startLine) - lineNumber(right.range.startLine) || left.depth - right.depth);
        return matches.slice(0, Math.max(1, limit));
    }

    /**
     * All nodes that cover one 1-based line, outermost first.
     */
    atLine(line: number): OutlineNode[] {
        return this.resolve(this.owners.query(line, line));
    }

    /**
     * All nodes overlapping a 1-based inclusive line range.
     */
    range(startLine: number, endLine: number, limit: number = 200): OutlineNode[] {
        const from: number = Math.max(1, Math.min(startLine, endLine));
        const to: number = Math.max(from, Math.max(startLine, endLine));
        return this.resolve(this.owners.query(from, to)).slice(0, Math.max(1, limit));
    }

    /**
     * Dotted path from the root to a node, e.g. `Parser / parseExpression`.
     */
    pathOf(node: OutlineNode): string {
        return this.paths.get(nodeId(node)) ?? node.label;
    }

    /**
     * Preorder snapshot of all nodes.
     */
    nodes(): readonly OutlineNode[] {
        return this.flat;
    }

    private resolve(ids: readonly string[]): OutlineNode[] {
        const seen: Set<string> = new Set<string>();
        const result: OutlineNode[] = [];
        for (let index: number = 0; index < ids.length; index += 1) {
            const id: string = ids[index];
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            const node: OutlineNode | undefined = this.byId.get(id);
            if (node !== (void 0)) {
                result.push(node);
            }
        }
        result.sort((left: OutlineNode, right: OutlineNode): number => lineNumber(left.range.startLine) - lineNumber(right.range.startLine) || left.depth - right.depth);
        return result;
    }
}

/**
 * Build an index for one result. Kept as a function so a caller can cache the
 * index by fingerprint without exposing the constructor's planning details.
 */
export const buildOutlineIndex: (result: OutlineResult) => OutlineIndex = (result: OutlineResult): OutlineIndex => new OutlineIndex(result);

/**
 * Filter an outline result to the nodes that match a prefix and/or a line
 * range, preserving ancestor context. Used by the `outline` tool; the returned
 * result keeps the original strategy/category metadata.
 */
export const filterOutline: (
    result: OutlineResult,
    filter: { prefix?: string; startLine?: number; endLine?: number; limit?: number; },
) => OutlineResult = (
    result: OutlineResult,
    filter: { prefix?: string; startLine?: number; endLine?: number; limit?: number; },
): OutlineResult => {
    const limit: number = Math.max(1, filter.limit ?? 200);
    const index: OutlineIndex = new OutlineIndex(result);
    const selected: OutlineNode[] = [];
    if (filter.prefix !== (void 0) && filter.prefix.trim().length > 0) {
        selected.push(...index.find(filter.prefix, limit));
    }
    if (filter.startLine !== (void 0) || filter.endLine !== (void 0)) {
        const start: number = filter.startLine ?? 1;
        const end: number = filter.endLine ?? Number.MAX_SAFE_INTEGER;
        selected.push(...index.range(start, end, limit));
    }
    if (selected.length === 0) {
        return { ...result, nodes: [], truncated: result.truncated };
    }
    const allowed: Set<string> = new Set<string>(selected.map(nodeId));
    const trim: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] => {
        const kept: OutlineNode[] = [];
        for (let index2: number = 0; index2 < nodes.length; index2 += 1) {
            const node: OutlineNode = nodes[index2];
            const children: OutlineNode[] = trim(node.children);
            if (allowed.has(nodeId(node)) || children.length > 0) {
                kept.push({ ...node, children });
            }
        }
        return kept;
    };
    return { ...result, nodes: trim(result.nodes), truncated: result.truncated || selected.length > limit };
};

/**
 * Whether a node list contains a matching label prefix. Exported for tests and
 * for callers that already have a flat list and do not need the full index.
 */
export const hasLabelPrefix: (nodes: readonly OutlineNode[], prefix: string) => boolean = (nodes: readonly OutlineNode[], prefix: string): boolean => {
    const key: string = prefix.trim().toLowerCase();
    return nodes.some((node: OutlineNode): boolean => node.label.toLowerCase().startsWith(key) || hasLabelPrefix(node.children, prefix));
};

/**
 * JSON-safe projection of an outline range.
 */
export const wireOutlineRange: (range: OutlineRange) => WireOutlineRange = (range: OutlineRange): WireOutlineRange => ({
    startByte: range.startByte.toString(),
    endByte: range.endByte.toString(),
    startLine: range.startLine.toString(),
    endLine: range.endLine.toString(),
});

/**
 * JSON-safe projection of one outline node. File/directory anchors reuse the
 * tree tool's wire projection so a client parses one node shape everywhere.
 */
export const wireOutlineNode: (node: OutlineNode) => WireOutlineNode = (node: OutlineNode): WireOutlineNode => ({
    isFile: node.isFile,
    isDirectory: node.isDirectory,
    ...(node.file === (void 0) ? {} : { file: wireNode(node.file) as WireFileNode }),
    ...(node.directory === (void 0) ? {} : { directory: wireNode(node.directory) as WireDirectoryNode }),
    path: node.path,
    type: node.type,
    range: wireOutlineRange(node.range),
    label: node.label,
    depth: node.depth,
    ...(node.modifiers === (void 0) ? {} : { modifiers: [...node.modifiers] }),
    ...(node.detail === (void 0) ? {} : { detail: node.detail }),
    children: node.children.map(wireOutlineNode),
});

/**
 * JSON-safe projection of a complete outline result.
 */
export const wireOutline: (result: OutlineResult) => WireOutlineResult = (result: OutlineResult): WireOutlineResult => ({
    ...result,
    nodes: result.nodes.map(wireOutlineNode),
});

const restoreRange: (range: WireOutlineRange) => OutlineRange = (range: WireOutlineRange): OutlineRange => ({
    startByte: BigInt(range.startByte),
    endByte: BigInt(range.endByte),
    startLine: BigInt(range.startLine),
    endLine: BigInt(range.endLine),
});

const restoreTreeNode: (node: WireTreeNode) => TreeNode = (node: WireTreeNode): TreeNode => {
    if (node.type === "File") {
        return {
            ...node,
            type: "File",
            children: [],
            lines: BigInt(node.lines),
            bytes: BigInt(node.bytes),
        } as FileNode;
    }
    return {
        ...node,
        type: "Directory",
        children: node.children.map(restoreTreeNode),
        lines: BigInt(node.lines),
        bytes: BigInt(node.bytes),
    } as DirectoryNode;
};

/**
 * Restore a wire outline after persistence. Used by the SQLite outline
 * repository so a cache hit returns the same bigint shape as a fresh parse.
 */
export const outlineFromWire: (result: WireOutlineResult) => OutlineResult = (result: WireOutlineResult): OutlineResult => {
    const restoreNode: (node: WireOutlineNode) => OutlineNode = (node: WireOutlineNode): OutlineNode => ({
        isFile: node.isFile,
        isDirectory: node.isDirectory,
        ...(node.file === (void 0) ? {} : { file: restoreTreeNode(node.file) as FileNode }),
        ...(node.directory === (void 0) ? {} : { directory: restoreTreeNode(node.directory) as DirectoryNode }),
        path: node.path,
        type: node.type,
        range: restoreRange(node.range),
        label: node.label,
        depth: node.depth,
        ...(node.modifiers === (void 0) ? {} : { modifiers: [...node.modifiers] }),
        ...(node.detail === (void 0) ? {} : { detail: node.detail }),
        children: node.children.map(restoreNode),
    });
    return { ...result, nodes: result.nodes.map(restoreNode) };
};
