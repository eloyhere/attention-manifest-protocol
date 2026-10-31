import { parseOffice } from "./officeBridge.ts";
/**
 * Structural outline extraction.
 *
 * An outline answers "what is in this file, and where?" before an agent pays
 * for the content. The module has two layers:
 *
 * - `OutlineRegistry` owns selection and I/O: it resolves the caller path
 *   through the session sandbox, enforces the 4 MiB file ceiling, refuses
 *   binary content, decodes text, picks exactly one strategy and bounds the
 *   resulting tree. Callers only see `buildOutline`.
 * - `OutlineStrategy` implementations (in `outlineStrategies.ts`) are pure
 *   functions from decoded text to a line-addressable symbol tree. A strategy
 *   never touches the filesystem, so the same parse can be replayed from a
 *   cache or a test fixture that never existed on disk.
 *
 * The result is anchored. A file outline returns one file anchor as its root
 * (`isFile: true`, `type: "File"`, whole-file range) with every symbol as a
 * descendant; a symbol path is `"add.py#add"` and nesting uses dots, e.g.
 * `"add.py#Numerical.solve"`. A directory outline returns a directory anchor
 * plus the direct child anchors; expanding child symbols is opt-in through
 * `options.symbols`. Symbol path segments escape `%`, `#` and `/` so the
 * anchor/symbol boundary is never ambiguous.
 *
 * Ranges are UTF-8 byte offsets plus 1-based inclusive lines. Bytes come from
 * `ByteLineIndex`, never from `String.length`, so a BMP character, an emoji and
 * a CJK glyph each contribute the right number of bytes. `endByte` is the first
 * byte after the ranged text.
 *
 * Selection order is fixed: exact file names first (`package.json`, `pom.xml`,
 * `CMakeLists.txt`, `build.gradle*`, `Cargo.toml`, `go.mod`,
 * `pyproject.toml`, `Makefile`), then file extensions, then content sniffing
 * (XML), and finally the plain-text strategy as a fallback.
 *
 * Results are bounded and explicitly truncated. A file beyond the byte ceiling
 * is refused with `quota_exceeded`; the node budget, the depth ceiling and the
 * 3000-line structure scan set `truncated: true` instead of silently dropping
 * structure. `fingerprint` always covers the whole file even when only its
 * first 3000 lines were scanned, so it remains a valid cache key.
 */
import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";

import { rawDigest, rawTextDigest } from "../fingerprint/raw.ts";
import { ByteLineIndex } from "../syntax/byteIndex.ts";
import { LineIndex, decodeText, detectCharset } from "../syntax/charset.ts";
import type { OutlineMatchInput, OutlineStrategy } from "./strategy.ts";
import type { DetectedCharset } from "../syntax/charset.ts";
import { fail, isFilesystemError } from "../file/errors.ts";
import { buildFileNode } from "../file/file.ts";
import { installOfficeOutlineParser } from "./office.ts";
import { OfficeOutlineStrategy, builtinOutlineStrategies } from "./outlineStrategies.ts";
import { ReactStrategy } from "./reactOutline.ts";
import type { PathSandbox } from "../file/path.ts";
import { buildTree } from "../file/tree.ts";
import type { Charset } from "../syntax/types.ts";
import type { DirectoryNode, FileNode, RootedPath, TreeNode, TreeOptions, TreeSnapshot } from "../file/types.ts";
import type { OutlineNode, OutlineRange, OutlineResult, OutlineType } from "./types.ts";

/**
 * Anchor objects a service can hand to the builder so it does not read or stat
 * the same file twice. A mismatched path is ignored and the anchor is rebuilt.
 */
export interface OutlineAnchor {
    readonly file?: FileNode;
    readonly directory?: DirectoryNode;
}

/**
 * One outline node that carries its own content fingerprint.
 *
 * `OutlineNode` in `types.ts` is owned by the shared contract; this projection
 * adds the `fingerprint` property every emitted node has at runtime. Once the
 * contract declares the field, the two types are identical.
 */
export type FingerprintedOutlineNode = OutlineNode & { readonly fingerprint: string; };

/**
 * Read a node's fingerprint without requiring the contract type to declare it.
 *
 * @param node - Any outline node returned by `buildOutline`.
 * @returns `sha256:<hex>` over the node's own text/byte range.
 */
export const outlineNodeFingerprint: (node: OutlineNode) => string = (node: OutlineNode): string =>
    (node as FingerprintedOutlineNode).fingerprint;

/**
 * Options that bound an outline build. `maxNodes` and `maxDepth` are clamped
 * rather than allowed to grow without limit; an invalid value is rejected as
 * `invalid_arguments` so a caller cannot ask for "zero but infinite".
 *
 * For a directory target, `symbols` opts into expanding each direct child
 * file's symbols; the default is anchors only, because a directory can hold
 * more content than one tool result should carry.
 */
export interface OutlineOptions {
    readonly maxNodes?: number;
    readonly maxDepth?: number;
    readonly symbols?: boolean;
    readonly anchor?: OutlineAnchor;
}

export type { OutlineMatchInput, OutlineParseInput, OutlineStrategy } from "./strategy.ts";

/**
 * Largest file an outline will load, in bytes. The whole file is decoded so
 * the fingerprint and the charset are trustworthy; beyond this ceiling the
 * caller should read selected pages instead of asking for structure.
 */
export const OutlineMaxFileBytes: number = 4 * 1024 * 1024;

/**
 * Number of leading lines a structure scan keeps. The bound protects a single
 * pathological file from dominating a turn; `truncated` makes the loss visible.
 */
export const OutlineMaxScanLines: number = 3000;

/**
 * Default and hard bounds for the node budget.
 */
export const OutlineDefaultMaxNodes: number = 2000;
export const OutlineHardMaxNodes: number = 5000;

/**
 * Default and hard bounds for the depth ceiling.
 */
export const OutlineDefaultMaxDepth: number = 8;
export const OutlineHardMaxDepth: number = 16;

/**
 * Longest label and detail kept on one node. Longer text is cut, not wrapped:
 * a renderer decides how to elide.
 */
const MaxLabelLength: number = 200;
const MaxDetailLength: number = 200;

/**
 * Number of decoded characters offered to content-sniffing matchers.
 */
const SniffHeadLength: number = 4096;

/**
 * Extract an `errno` code from an unknown thrown value without trusting it.
 */
const errorCode: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) !== "object" || error === null) {
        return "";
    }
    const code: unknown = (error as { code?: unknown; }).code;
    return typeof(code) === "string" ? code : "";
};

/**
 * Translate a host filesystem failure into the closed domain taxonomy. Host
 * paths never appear in the replacement message.
 */
const mapFsError: (error: unknown) => never = (error: unknown): never => {
    if (isFilesystemError(error)) {
        throw error;
    }
    switch (errorCode(error)) {
        case "ENOENT": {
            return fail("not_found");
        }
        case "EACCES":
        case "EPERM": {
            return fail("permission_denied");
        }
        case "EISDIR": {
            return fail("not_file");
        }
        case "ENOTDIR": {
            return fail("not_directory");
        }
        case "ELOOP": {
            return fail("symlink_denied");
        }
        case "ENOSPC":
        case "EDQUOT": {
            return fail("quota_exceeded");
        }
        default: {
            return fail("internal_error");
        }
    }
};

/**
 * `lstat` a resolved path, translating a failure instead of leaking it.
 */
const statOrFail: (absolute: string) => Stats = (absolute: string): Stats => {
    try {
        return lstatSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Read whole-file bytes.
 */
const readBytes: (absolute: string) => Uint8Array = (absolute: string): Uint8Array => {
    try {
        return readFileSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Decode with a detected charset. A decoder failure is `charset_unsupported`; a
 * classified domain error passes through unchanged.
 */
const decodeOrFail: (bytes: Uint8Array, charset: Charset) => string = (bytes: Uint8Array, charset: Charset): string => {
    try {
        return decodeText(bytes, charset);
    } catch (error: unknown) {
        if (isFilesystemError(error)) {
            throw error;
        }
        return fail("charset_unsupported");
    }
};

/**
 * Resolve a bounded positive integer option.
 *
 * @param value - Caller value, or `undefined` for the default.
 * @param fallback - Default when the value is absent.
 * @param maximum - Inclusive upper bound.
 * @returns The effective value.
 */
const boundedInteger: (value: number | undefined, fallback: number, maximum: number) => number = (value: number | undefined, fallback: number, maximum: number): number => {
    if (value === (void 0)) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return Math.min(value, maximum);
};

/**
 * Last segment of a slash path.
 */
const baseName: (path: string) => string = (path: string): string => {
    const slash: number = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
};

/**
 * Stable lowercase language tag for a path. A file without an extension (or
 * with only a dot-file name) answers `text`, matching the fallback contract.
 *
 * @param path - Root-relative or absolute path.
 * @returns Lowercase extension without the dot, or `text`.
 */
export const outlineLanguage: (path: string) => string = (path: string): string => {
    const name: string = baseName(path);
    const dot: number = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) {
        return "text";
    }
    return name.slice(dot + 1).toLowerCase();
};

/**
 * Escape one symbol segment so the anchor/symbol boundary in `path` stays
 * parseable. `%` is escaped first, then the two structural separators.
 */
const escapeSegment: (value: string) => string = (value: string): string =>
    value.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\//g, "%2F");

/**
 * Collapse whitespace and cut a label to the wire bound.
 */
const cleanLabel: (value: unknown) => string = (value: unknown): string => {
    if (typeof(value) !== "string") {
        return "";
    }
    return value.replace(/\s+/g, " ").trim().slice(0, MaxLabelLength);
};

/**
 * Collapse whitespace and cut a detail to the wire bound.
 */
const cleanDetail: (value: unknown) => string = (value: unknown): string => {
    if (typeof(value) !== "string") {
        return "";
    }
    return value.replace(/\s+/g, " ").trim().slice(0, MaxDetailLength);
};

/**
 * Clamp one reported line into `[1, totalLines]`.
 */
const clampLine: (value: number, totalLines: number) => number = (value: number, totalLines: number): number => {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.min(Math.max(1, Math.trunc(value)), Math.max(1, totalLines));
};

/**
 * Convert a persisted bigint line value back to a number for the in-process
 * outline model. A value beyond `Number.MAX_SAFE_INTEGER` is clamped instead of
 * silently losing precision.
 */
const lineNumber: (value: bigint) => number = (value: bigint): number => {
    const converted: number = Number(value);
    return Number.isSafeInteger(converted) ? converted : 1;
};

/**
 * Zero-length-at-origin range for an anchor that has no text of its own.
 */
const anchorRange: (bytes: bigint, lines: bigint) => OutlineRange = (bytes: bigint, lines: bigint): OutlineRange => ({
    startByte: 0n,
    endByte: bytes,
    startLine: 1n,
    endLine: lines > 0n ? lines : 1n,
});

/**
 * Range for an anchor copied from a tree node: aggregate bytes and lines.
 */
const treeNodeRange: (node: TreeNode) => OutlineRange = (node: TreeNode): OutlineRange => anchorRange(node.bytes, node.lines);

/**
 * Read raw bytes for a container format (Office) that is not required to decode
 * as text. The same byte ceiling as a text outline still applies.
 */
const readOutlineBytes: (sandbox: PathSandbox, rooted: RootedPath) => Uint8Array = (sandbox: PathSandbox, rooted: RootedPath): Uint8Array => {
    sandbox.revalidate(rooted);
    const stat: Stats = statOrFail(rooted.absolute);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    if (stat.size > OutlineMaxFileBytes) {
        return fail("quota_exceeded");
    }
    sandbox.revalidate(rooted);
    const bytes: Uint8Array = readBytes(rooted.absolute);
    if (bytes.byteLength > OutlineMaxFileBytes) {
        return fail("quota_exceeded");
    }
    return bytes;
};

/**
 * Highest line number a strategy tree refers to, used where a file has no text
 * lines and sections are numbered in document order.
 */
const maxNodeLine: (nodes: readonly OutlineNode[]) => number = (nodes: readonly OutlineNode[]): number => {
    let highest: number = 1;
    const stack: OutlineNode[] = [...nodes];
    while (stack.length > 0) {
        const node: OutlineNode = stack.pop()!;
        highest = Math.max(highest, lineNumber(node.range.startLine), lineNumber(node.range.endLine));
        for (let index: number = 0; index < node.children.length; index += 1) {
            stack.push(node.children[index]);
        }
    }
    return highest;
};

/**
 * Mutable bookkeeping shared by one finalization pass.
 */
interface FinalizeState {
    remaining: number;
    readonly maxDepth: number;
    totalLines: number;
    truncated: boolean;
}

/**
 * Decoded file plus the indexes an outline needs.
 */
interface OutlineSource {
    readonly bytes: Uint8Array;
    readonly text: string;
    readonly detected: DetectedCharset;
    readonly byteIndex: ByteLineIndex;
    /**
     * Raw-file prefix that `byteIndex` does not see because decoding removed it.
     * Only a UTF-8 BOM is bridged this way: the decoded text is still UTF-8, so
     * adding the three prefix bytes restores raw-file offsets. UTF-16/latin1
     * files keep decoded-UTF-8 offsets, which are documented as approximate.
     */
    readonly byteOffsetBase: bigint;
    readonly scanText: string;
    readonly scanIndex: LineIndex;
    readonly totalLines: number;
    readonly scanTruncated: boolean;
}

/**
 * Read, sniff and index one file for outline extraction.
 */
const readOutlineSource: (sandbox: PathSandbox, rooted: RootedPath) => OutlineSource = (sandbox: PathSandbox, rooted: RootedPath): OutlineSource => {
    sandbox.revalidate(rooted);
    const stat: Stats = statOrFail(rooted.absolute);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    if (stat.size > OutlineMaxFileBytes) {
        return fail("quota_exceeded");
    }
    sandbox.revalidate(rooted);
    const bytes: Uint8Array = readBytes(rooted.absolute);
    if (bytes.byteLength > OutlineMaxFileBytes) {
        return fail("quota_exceeded");
    }
    const detected: DetectedCharset = detectCharset(bytes);
    if (detected.binary) {
        return fail("binary_file");
    }
    const text: string = decodeOrFail(bytes, detected.charset);
    const byteOffsetBase: bigint = detected.charset === "utf-8-bom" ? BigInt(detected.bomLength) : 0n;
    const fullIndex: LineIndex = new LineIndex(text);
    const totalLines: number = fullIndex.count;
    const scanTruncated: boolean = totalLines > OutlineMaxScanLines;
    const scanText: string = scanTruncated ? text.slice(0, fullIndex.start(OutlineMaxScanLines + 1)) : text;
    const scanIndex: LineIndex = scanTruncated ? new LineIndex(scanText) : fullIndex;
    return {
        bytes,
        text,
        detected,
        byteIndex: new ByteLineIndex(text),
        byteOffsetBase,
        scanText,
        scanIndex,
        totalLines,
        scanTruncated,
    };
};

/**
 * Resolver from inclusive line numbers (plus a strategy's own rough range) to
 * the authoritative byte/line range.
 */
type RangeResolver = (startLine: number, endLine: number, source: OutlineRange) => OutlineRange;

/**
 * Shift a decoded-text range into raw-file coordinates by a fixed byte prefix.
 */
const shiftRange: (range: OutlineRange, base: bigint) => OutlineRange = (range: OutlineRange, base: bigint): OutlineRange =>
    base === 0n
        ? range
        : {
              startByte: range.startByte + base,
              endByte: range.endByte + base,
              startLine: range.startLine,
              endLine: range.endLine,
          };

/**
 * Resolve inclusive line numbers to raw-file byte offsets for one source.
 */
const rangeResolverFor: (source: OutlineSource) => RangeResolver = (source: OutlineSource): RangeResolver =>
    (startLine: number, endLine: number): OutlineRange =>
        shiftRange(source.byteIndex.range(startLine, endLine), source.byteOffsetBase);

/**
 * Fingerprint the decoded-text slice behind a raw-file range.
 */
const fingerprintResolverFor: (source: OutlineSource) => (range: OutlineRange) => string = (
    source: OutlineSource,
): ((range: OutlineRange) => string) =>
    (range: OutlineRange): string => rawTextDigest(source.byteIndex.slice(shiftRange(range, -source.byteOffsetBase)));

/**
 * Whole-file range, starting at byte zero so the decoded prefix is covered too.
 */
const fileRangeFor: (source: OutlineSource) => OutlineRange = (source: OutlineSource): OutlineRange => {
    const full: OutlineRange = source.byteIndex.fullRange();
    return source.byteOffsetBase === 0n ? full : { ...full, endByte: full.endByte + source.byteOffsetBase };
};

/**
 * One symbol finalization pass.
 */
interface FinalizeSymbolsInput {
    readonly nodes: readonly OutlineNode[];
    readonly parentDepth: number;
    readonly baseDepth: number;
    readonly parentPath: string;
    readonly filePath: string;
    readonly rangeOf: RangeResolver;
    readonly fingerprintOf: (range: OutlineRange) => string;
    readonly state: FinalizeState;
}

/**
 * Rebuild a strategy tree as immutable, bounded, anchored symbols.
 *
 * Depth comes from the strategy but is offset by the anchor level and made
 * monotonic against the parent, so a parser bug cannot produce a child that is
 * not deeper than its parent. A node beyond the depth ceiling is dropped with
 * its whole subtree; a node beyond the count budget is dropped with everything
 * after it and flips `truncated`.
 *
 * @param input - Strategy output, anchor context and shared bounds.
 * @returns New frozen symbol nodes.
 */
const finalizeSymbols: (input: FinalizeSymbolsInput) => OutlineNode[] = (input: FinalizeSymbolsInput): OutlineNode[] => {
    const kept: OutlineNode[] = [];
    const labelCounts: Map<string, number> = new Map<string, number>();
    for (const node of input.nodes) {
        const label: string = cleanLabel(node.label);
        if (label.length > 0) {
            labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }
    }
    const usedSegments: Set<string> = new Set<string>();
    for (const [label, count] of labelCounts) {
        if (count === 1) {
            usedSegments.add(escapeSegment(label));
        }
    }
    const siblingOccurrences: Map<string, number> = new Map<string, number>();
    for (let index: number = 0; index < input.nodes.length; index += 1) {
        const node: OutlineNode = input.nodes[index];
        const label: string = cleanLabel(node.label);
        if (label.length === 0) {
            continue;
        }
        const declaredDepth: number = Number.isSafeInteger(node.depth) ? node.depth : 0;
        const depth: number = Math.max(input.baseDepth + declaredDepth, input.parentDepth + 1);
        if (depth > input.state.maxDepth) {
            input.state.truncated = true;
            continue;
        }
        if (input.state.remaining <= 0) {
            input.state.truncated = true;
            continue;
        }
        input.state.remaining -= 1;
        const startLine: number = clampLine(lineNumber(node.range.startLine), input.state.totalLines);
        const endLine: number = Math.max(startLine, clampLine(lineNumber(node.range.endLine), input.state.totalLines));
        const occurrence: number = siblingOccurrences.get(label) ?? 0;
        siblingOccurrences.set(label, occurrence + 1);
        let segment: string = escapeSegment(label);
        if ((labelCounts.get(label) ?? 0) > 1) {
            const discriminator: string = `${segment}~${node.type}-${startLine}-${occurrence + 1}`;
            segment = discriminator;
            let collision: number = 2;
            while (usedSegments.has(segment)) {
                segment = `${discriminator}-${collision}`;
                collision += 1;
            }
        }
        usedSegments.add(segment);
        const path: string = input.parentPath.length === 0 ? `${input.filePath}#${segment}` : `${input.parentPath}.${segment}`;
        const type: OutlineType = node.type === "File" || node.type === "Directory" ? "heading" : node.type;
        const children: readonly OutlineNode[] = Array.isArray(node.children) ? node.children : [];
        const detail: string = cleanDetail(node.detail);
        const range: OutlineRange = input.rangeOf(startLine, endLine, node.range);
        const frozen: FingerprintedOutlineNode = Object.freeze<FingerprintedOutlineNode>({
            isFile: false,
            isDirectory: false,
            path,
            type,
            range,
            fingerprint: input.fingerprintOf(range),
            label,
            depth,
            ...(node.modifiers === (void 0) || node.modifiers.length === 0 ? {} : { modifiers: Object.freeze([...node.modifiers]) }),
            ...(detail.length === 0 ? {} : { detail }),
            children: Object.freeze(
                finalizeSymbols({
                    nodes: children,
                    parentDepth: depth,
                    baseDepth: input.baseDepth,
                    parentPath: path,
                    filePath: input.filePath,
                    rangeOf: input.rangeOf,
                    fingerprintOf: input.fingerprintOf,
                    state: input.state,
                }),
            ),
        });
        kept.push(frozen);
    }
    return kept;
};

/**
 * One file anchor.
 */
interface FileAnchorSpec {
    readonly node: FileNode;
    readonly range: OutlineRange;
    readonly children: readonly OutlineNode[];
}

const fileAnchorNode: (spec: FileAnchorSpec) => OutlineNode = (spec: FileAnchorSpec): OutlineNode =>
    Object.freeze<FingerprintedOutlineNode>({
        isFile: true,
        isDirectory: false,
        file: spec.node,
        path: spec.node.path,
        type: "File",
        range: spec.range,
        fingerprint: spec.node.fingerprint,
        label: cleanLabel(spec.node.name),
        depth: 0,
        children: Object.freeze([...spec.children]),
    });

/**
 * One directory anchor.
 */
interface DirectoryAnchorSpec {
    readonly node: DirectoryNode;
    readonly range: OutlineRange;
    readonly children: readonly OutlineNode[];
    readonly depth: number;
}

const directoryAnchorNode: (spec: DirectoryAnchorSpec) => OutlineNode = (spec: DirectoryAnchorSpec): OutlineNode =>
    Object.freeze<FingerprintedOutlineNode>({
        isFile: false,
        isDirectory: true,
        directory: spec.node,
        path: spec.node.path,
        type: "Directory",
        range: spec.range,
        fingerprint: spec.node.fingerprint,
        label: cleanLabel(spec.node.name),
        depth: spec.depth,
        children: Object.freeze([...spec.children]),
    });

/**
 * Anchor for one direct child of a directory outline. A child directory keeps
 * its own aggregate range but is not expanded, because the directory result is
 * a one-level listing by contract.
 */
const treeAnchorNode: (node: TreeNode, depth: number) => OutlineNode = (node: TreeNode, depth: number): OutlineNode => {
    if (node.type === "File") {
        return fileAnchorNode({ node, range: treeNodeRange(node), children: [] });
    }
    return directoryAnchorNode({ node, range: treeNodeRange(node), children: [], depth });
};

/**
 * Locate one node inside an already-built tree.
 */
const findTreeNode: (root: DirectoryNode, relative: string) => TreeNode | undefined = (root: DirectoryNode, relative: string): TreeNode | undefined => {
    if (relative === ".") {
        return root;
    }
    const segments: string[] = relative.split("/");
    let current: TreeNode = root;
    for (let index: number = 0; index < segments.length; index += 1) {
        if (current.type !== "Directory") {
            return undefined;
        }
        const segment: string = segments[index];
        const next: TreeNode | undefined = current.children.find((child: TreeNode): boolean => child.name === segment);
        if (next === (void 0)) {
            return undefined;
        }
        current = next;
    }
    return current;
};

/**
 * Registry of outline strategies.
 *
 * Registration order is selection priority. A registry without a strategy that
 * matches still returns a well-formed empty result instead of throwing, so an
 * unknown file type is a cheap "nothing structured here" answer.
 */
export class OutlineRegistry {
    private readonly strategies: OutlineStrategy[] = [];
    private readonly byId: Map<string, OutlineStrategy> = new Map<string, OutlineStrategy>();

    constructor(strategies: readonly OutlineStrategy[] = []) {
        for (let index: number = 0; index < strategies.length; index += 1) {
            this.register(strategies[index]);
        }
    }

    /**
     * Append one strategy. Duplicate ids are rejected at registration time so a
     * later lookup can never be ambiguous.
     *
     * @param strategy - Strategy to add.
     */
    register(strategy: OutlineStrategy): void {
        if (typeof(strategy) !== "object" || strategy === null || typeof(strategy.id) !== "string" || strategy.id.trim().length === 0) {
            throw new Error("invalid outline strategy");
        }
        if (this.byId.has(strategy.id)) {
            throw new Error(`duplicate outline strategy: ${strategy.id}`);
        }
        this.byId.set(strategy.id, strategy);
        this.strategies.push(strategy);
    }

    /**
     * Strategies in selection order.
     */
    list(): readonly OutlineStrategy[] {
        return [...this.strategies];
    }

    /**
     * First registered strategy that matches, with the plain-text strategy as a
     * deliberate fallback.
     *
     * @param input - Path, base name and content head.
     * @returns The selected strategy, or `undefined` when the registry has no
     * plain-text fallback.
     */
    select(input: OutlineMatchInput): OutlineStrategy | undefined {
        for (let index: number = 0; index < this.strategies.length; index += 1) {
            const strategy: OutlineStrategy = this.strategies[index];
            if (strategy.matches(input)) {
                return strategy;
            }
        }
        return this.byId.get("plainText");
    }

    /**
     * Resolve, read, decode and outline one path.
     *
     * The order is strict: sandbox resolution, target-type dispatch, regular
     * file checks, byte ceiling, sandbox revalidation, charset sniff, decode,
     * strategy selection, parse and bounded finalization.
     *
     * @param sandbox - Session sandbox that owns path resolution.
     * @param path - Root-relative POSIX path; a root-id prefix is accepted by
     * the sandbox.
     * @param options - Node/depth bounds, symbol expansion and an optional anchor.
     * @param anchor - Anchor objects supplied by the service, overriding
     * `options.anchor`.
     * @returns The outline, including the whole-file fingerprint and charset.
     */
    build(sandbox: PathSandbox, path: string, options: OutlineOptions = {}, anchor?: OutlineAnchor): OutlineResult {
        const maxNodes: number = boundedInteger(options.maxNodes, OutlineDefaultMaxNodes, OutlineHardMaxNodes);
        const maxDepth: number = boundedInteger(options.maxDepth, OutlineDefaultMaxDepth, OutlineHardMaxDepth);
        const provided: OutlineAnchor = anchor ?? options.anchor ?? {};
        const rooted: RootedPath = sandbox.resolve(path, "read");
        sandbox.revalidate(rooted);
        const stat: Stats = statOrFail(rooted.absolute);
        const state: FinalizeState = { remaining: maxNodes, maxDepth, totalLines: 1, truncated: false };
        if (stat.isDirectory()) {
            return this.buildDirectory(sandbox, rooted, provided, options, state);
        }
        if (!stat.isFile()) {
            return fail("not_file");
        }
        return this.buildFile(sandbox, rooted, provided, state);
    }

    private buildFile(sandbox: PathSandbox, rooted: RootedPath, anchor: OutlineAnchor, state: FinalizeState): OutlineResult {
        const fileName: string = baseName(rooted.relative);
        if (OfficeOutlineStrategy.matches({ path: rooted.relative, name: fileName, head: "" })) {
            return this.buildOffice(sandbox, rooted, anchor, state);
        }
        const source: OutlineSource = readOutlineSource(sandbox, rooted);
        state.totalLines = source.totalLines;
        state.remaining = Math.max(0, state.remaining - 1);
        const fileNode: FileNode = anchor.file !== (void 0) && anchor.file.path === rooted.relative ? anchor.file : buildFileNode(rooted.root, rooted.relative);
        const name: string = baseName(rooted.relative);
        const head: string = source.text.slice(0, SniffHeadLength);
        let strategy: OutlineStrategy | undefined;
        let parsed: readonly OutlineNode[] = [];
        try {
            strategy = this.select({ path: rooted.relative, name, head });
            if (strategy !== (void 0)) {
                const nodes: OutlineNode[] = strategy.parse({
                    path: rooted.relative,
                    text: source.scanText,
                    lineIndex: source.scanIndex,
                    markTruncated: (): void => {
                        state.truncated = true;
                    },
                });
                parsed = Array.isArray(nodes) ? nodes : fail("parse_failed");
            }
        } catch (error: unknown) {
            if (isFilesystemError(error)) {
                throw error;
            }
            return fail("parse_failed");
        }
        const rangeOf: RangeResolver = rangeResolverFor(source);
        const fingerprintOf: (range: OutlineRange) => string = fingerprintResolverFor(source);
        const children: readonly OutlineNode[] = finalizeSymbols({
            nodes: parsed,
            parentDepth: 0,
            baseDepth: 1,
            parentPath: "",
            filePath: rooted.relative,
            rangeOf,
            fingerprintOf,
            state,
        });
        const anchorNode: OutlineNode = fileAnchorNode({ node: fileNode, range: fileRangeFor(source), children });
        const language: string = strategy === (void 0) ? outlineLanguage(rooted.relative) : strategy.language ?? outlineLanguage(rooted.relative);
        return Object.freeze<OutlineResult>({
            path: rooted.relative,
            fingerprint: rawDigest(source.bytes),
            language,
            strategy: strategy === (void 0) ? "none" : strategy.id,
            category: strategy === (void 0) ? "other" : strategy.category,
            target: "file",
            charset: source.detected.charset,
            nodes: Object.freeze([anchorNode]),
            truncated: source.scanTruncated || state.truncated,
        });
    }

    private buildOffice(sandbox: PathSandbox, rooted: RootedPath, anchor: OutlineAnchor, state: FinalizeState): OutlineResult {
        installOfficeOutlineParser();
        const bytes: Uint8Array = readOutlineBytes(sandbox, rooted);
        state.remaining = Math.max(0, state.remaining - 1);
        const fileNode: FileNode = anchor.file !== (void 0) && anchor.file.path === rooted.relative ? anchor.file : buildFileNode(rooted.root, rooted.relative);
        let parsed: readonly OutlineNode[] = [];
        try {
            const nodes: OutlineNode[] = parseOffice({ path: rooted.relative, bytes });
            parsed = Array.isArray(nodes) ? nodes : fail("parse_failed");
        } catch (error: unknown) {
            if (isFilesystemError(error)) {
                throw error;
            }
            return fail("parse_failed");
        }
        state.totalLines = maxNodeLine(parsed);
        const byteLength: bigint = BigInt(bytes.byteLength);
        const officeLines: bigint = BigInt(Math.max(1, state.totalLines));
        /**
         * Office containers have no text line offsets. A section is numbered in
         * document order, so its byte span is the proportional slice of the
         * container. The mapping is monotonic and every section still gets a
         * stable range; it is explicitly approximate, not a parser claim.
         */
        const rangeOf: (startLine: number, endLine: number, rough: OutlineRange) => OutlineRange = (
            startLine: number, endLine: number, rough: OutlineRange,
        ): OutlineRange => ({
            startByte: rough.startByte === 0n && rough.endByte === 0n ? (byteLength * BigInt(Math.max(0, startLine - 1))) / officeLines : rough.startByte,
            endByte: rough.startByte === 0n && rough.endByte === 0n ? (byteLength * BigInt(Math.max(0, endLine))) / officeLines : rough.endByte,
            startLine: BigInt(startLine),
            endLine: BigInt(endLine),
        });
        const fingerprintOf: (range: OutlineRange) => string = (range: OutlineRange): string =>
            rawDigest(bytes.subarray(Number(range.startByte), Number(range.endByte)));
        const children: readonly OutlineNode[] = finalizeSymbols({
            nodes: parsed,
            parentDepth: 0,
            baseDepth: 1,
            parentPath: "",
            filePath: rooted.relative,
            rangeOf,
            fingerprintOf,
            state,
        });
        const detected: DetectedCharset = detectCharset(bytes);
        const anchorNode: OutlineNode = fileAnchorNode({
            node: fileNode,
            range: { startByte: 0n, endByte: byteLength, startLine: 1n, endLine: 1n },
            children,
        });
        return Object.freeze<OutlineResult>({
            path: rooted.relative,
            fingerprint: rawDigest(bytes),
            language: "office",
            strategy: "office",
            category: "data",
            target: "file",
            charset: detected.binary ? "binary" : detected.charset,
            nodes: Object.freeze([anchorNode]),
            truncated: state.truncated,
        });
    }

    private buildDirectory(sandbox: PathSandbox, rooted: RootedPath, anchor: OutlineAnchor, options: OutlineOptions, state: FinalizeState): OutlineResult {
        const directoryNode: DirectoryNode = this.directoryNodeFor(rooted, anchor);
        state.remaining = Math.max(0, state.remaining - 1);
        const children: OutlineNode[] = [];
        for (let index: number = 0; index < directoryNode.children.length; index += 1) {
            const child: TreeNode = directoryNode.children[index];
            if (state.remaining <= 0) {
                state.truncated = true;
                break;
            }
            state.remaining -= 1;
            if (options.symbols === true && child.type === "File") {
                const symbols: readonly OutlineNode[] = this.expandChildFile(sandbox, child.path, state);
                children.push(fileAnchorNode({ node: child, range: treeNodeRange(child), children: symbols }));
            } else {
                children.push(treeAnchorNode(child, 1));
            }
        }
        const anchorNode: OutlineNode = directoryAnchorNode({ node: directoryNode, range: treeNodeRange(directoryNode), children, depth: 0 });
        return Object.freeze<OutlineResult>({
            path: rooted.relative,
            fingerprint: directoryNode.fingerprint,
            language: "directory",
            strategy: "directory",
            category: "other",
            target: "directory",
            charset: "none",
            nodes: Object.freeze([anchorNode]),
            truncated: state.truncated,
        });
    }

    private directoryNodeFor(rooted: RootedPath, anchor: OutlineAnchor): DirectoryNode {
        if (anchor.directory !== (void 0) && anchor.directory.path === rooted.relative) {
            return anchor.directory;
        }
        const options: TreeOptions = { maxNodes: OutlineHardMaxNodes };
        const snapshot: TreeSnapshot = buildTree(rooted.root, options);
        const found: TreeNode | undefined = findTreeNode(snapshot.root, rooted.relative);
        if (found === (void 0) || found.type !== "Directory") {
            return fail("not_directory");
        }
        return found;
    }

    private expandChildFile(sandbox: PathSandbox, relative: string, state: FinalizeState): readonly OutlineNode[] {
        try {
            const rooted: RootedPath = sandbox.resolve(relative, "read");
            const source: OutlineSource = readOutlineSource(sandbox, rooted);
            state.totalLines = Math.max(state.totalLines, source.totalLines);
            if (source.scanTruncated) {
                state.truncated = true;
            }
            const strategy: OutlineStrategy | undefined = this.select({
                path: rooted.relative,
                name: baseName(rooted.relative),
                head: source.text.slice(0, SniffHeadLength),
            });
            if (strategy === (void 0)) {
                return [];
            }
            const nodes: OutlineNode[] = strategy.parse({
                path: rooted.relative,
                text: source.scanText,
                lineIndex: source.scanIndex,
                markTruncated: (): void => {
                    state.truncated = true;
                },
            });
            const rangeOf: RangeResolver = rangeResolverFor(source);
            const fingerprintOf: (range: OutlineRange) => string = fingerprintResolverFor(source);
            return finalizeSymbols({
                nodes: Array.isArray(nodes) ? nodes : [],
                parentDepth: 1,
                baseDepth: 2,
                parentPath: "",
                filePath: rooted.relative,
                rangeOf,
                fingerprintOf,
                state,
            });
        } catch (error: unknown) {
            if (isFilesystemError(error)) {
                return [];
            }
            return fail("parse_failed");
        }
    }
}

/**
 * Registry with every built-in strategy, in selection priority order.
 *
 * The PascalCase binding is the project's top-level-data convention; the
 * lowerCamel alias is the service-facing name.
 */
/**
 * React precedes TypeScript/JavaScript because all three claim `.tsx`/`.jsx`;
 * React only wins when the file carries React evidence, so plain TSX still falls
 * through to the TypeScript strategy.
 */
export const DefaultOutlineRegistry: OutlineRegistry = new OutlineRegistry([ReactStrategy, ...builtinOutlineStrategies]);
export { DefaultOutlineRegistry as defaultOutlineRegistry };

/**
 * Snapshot of the default selection order, useful for a service catalog.
 */
export const OutlineStrategies: readonly OutlineStrategy[] = DefaultOutlineRegistry.list();

/**
 * Create an empty registry without built-ins. A host registers the strategies
 * it trusts and then calls `build` exactly like the default registry.
 */
export const createOutlineRegistry: () => OutlineRegistry = (): OutlineRegistry => new OutlineRegistry();

/**
 * Build the default outline for one workspace path.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param path - Root-relative POSIX path.
 * @param options - Node/depth bounds, symbol expansion and an optional anchor.
 * @param anchor - Anchor objects supplied by the service.
 * @returns The outline result.
 */
export const buildOutline: (sandbox: PathSandbox, path: string, options?: OutlineOptions, anchor?: OutlineAnchor) => OutlineResult = (
    sandbox: PathSandbox, path: string, options: OutlineOptions = {}, anchor?: OutlineAnchor,
): OutlineResult => DefaultOutlineRegistry.build(sandbox, path, options, anchor);
