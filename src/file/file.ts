/**
 * File-node construction and wire projection.
 *
 * A file node is self-describing: its fingerprint covers every byte, while the
 * descriptive metadata is derived from a bounded head. Large files therefore
 * stay cheap to fingerprint (a streaming SHA-256 over 1 MiB chunks) without
 * loading them into memory. Charset detection and line counting are delegated
 * to `charset.ts` so the tree, the reader and the writer cannot disagree about
 * what a line is.
 *
 * Every host path stays inside this module. Callers supply a root-relative POSIX
 * path and receive detached metadata; errors are code-only.
 */
import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { SessionRoot } from "../session/types.ts";
import { countLines, decodeText, detectCharset } from "../syntax/charset.ts";
import type { DetectedCharset } from "../syntax/charset.ts";
import { fail } from "./errors.ts";
import { annotationFor, describeFile, extensionOfPath, nameOfPath } from "./metadata.ts";
import type { NodeDescription } from "./metadata.ts";
import { PathSandbox } from "./path.ts";
import { creationTime, formatNodeTime } from "./time.ts";
import type { Charset } from "../syntax/types.ts";
import type { DirectoryNode, FileNode, NodeTime, TreeNode, TreeOptions, WireDirectoryNode, WireFileNode, WireTreeNode } from "./types.ts";

const HeadBytes: number = 64 * 1024;
const LargeFileBytes: number = 32 * 1024 * 1024;
const ChunkBytes: number = 1024 * 1024;
const NewlineByte: number = 0x0a;
const ZeroByte: number = 0x00;
const ControlCharacters: RegExp = /[\u0000-\u001f\u007f]/;
const DriveLetter: RegExp = /^[A-Za-z]:/;

interface ByteTally {
    lf: bigint;
    le: bigint;
    be: bigint;
    previous: number;
    tail: number;
}

interface FileRead {
    readonly head: Uint8Array;
    readonly full?: Uint8Array;
    readonly fingerprint: string;
    readonly tally: ByteTally;
}

const errnoCode: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) === "object" && error !== null) {
        const candidate: { code?: unknown; } = error as { code?: unknown; };
        if (typeof(candidate.code) === "string") {
            return candidate.code;
        }
    }
    return "";
};

const failRead: (error: unknown) => never = (error: unknown): never => {
    const code: string = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
        return fail("not_found");
    }
    if (code === "EACCES" || code === "EPERM") {
        return fail("permission_denied");
    }
    if (code === "EISDIR") {
        return fail("not_file");
    }
    if (code === "ELOOP") {
        return fail("symlink_denied");
    }
    return fail("internal_error");
};

const normalizeFileRelative: (relative: string) => string = (relative: string): string => {
    if (typeof(relative) !== "string" || ControlCharacters.test(relative)) {
        return fail("invalid_path");
    }
    const text: string = relative.trim();
    if (text.length === 0) {
        return fail("not_file");
    }
    if (text.includes("\\")) {
        return fail("invalid_path");
    }
    if (isAbsolute(text) || DriveLetter.test(text) || text.startsWith("//")) {
        return fail("invalid_path");
    }
    const segments: string[] = [];
    const parts: string[] = text.split("/");
    for (let index: number = 0; index < parts.length; index += 1) {
        const part: string = parts[index];
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            return fail("path_escape");
        }
        segments.push(part);
    }
    if (segments.length === 0) {
        return fail("not_file");
    }
    return segments.join("/");
};

const absoluteOf: (root: SessionRoot, relative: string) => string = (root: SessionRoot, relative: string): string =>
    join(root.path, ...relative.split("/"));

const linkTargetStat: (root: SessionRoot, absolute: string, linkStat: Stats, options: TreeOptions) => Stats = (root: SessionRoot, absolute: string, linkStat: Stats, options: TreeOptions): Stats => {
    if (!linkStat.isSymbolicLink()) {
        return linkStat;
    }
    if (options.followSymlinks !== true) {
        return fail("symlink_denied");
    }
    let real: string;
    try {
        real = realpathSync(absolute);
    } catch (error: unknown) {
        return failRead(error);
    }
    const sandbox: PathSandbox = new PathSandbox([root], { followSymlinks: true });
    if (!sandbox.contains(root.path, real)) {
        return fail("path_escape");
    }
    try {
        return statSync(real);
    } catch (error: unknown) {
        return failRead(error);
    }
};

const concatBytes: (parts: readonly Uint8Array[]) => Uint8Array = (parts: readonly Uint8Array[]): Uint8Array => {
    let total: number = 0;
    for (let index: number = 0; index < parts.length; index += 1) {
        total += parts[index].length;
    }
    const result: Uint8Array = new Uint8Array(total);
    let offset: number = 0;
    for (let index: number = 0; index < parts.length; index += 1) {
        result.set(parts[index], offset);
        offset += parts[index].length;
    }
    return result;
};

const tallyChunk: (tally: ByteTally, chunk: Uint8Array) => void = (tally: ByteTally, chunk: Uint8Array): void => {
    for (let index: number = 0; index < chunk.length; index += 1) {
        if (chunk[index] === NewlineByte) {
            tally.lf += 1n;
        }
    }
    for (let index: number = 0; index + 1 < chunk.length; index += 2) {
        if (chunk[index] === NewlineByte && chunk[index + 1] === ZeroByte) {
            tally.le += 1n;
        }
        if (chunk[index] === ZeroByte && chunk[index + 1] === NewlineByte) {
            tally.be += 1n;
        }
    }
    if (chunk.length > 0) {
        tally.previous = chunk.length > 1 ? chunk[chunk.length - 2] : tally.tail;
        tally.tail = chunk[chunk.length - 1];
    }
};

const readFileBytes: (absolute: string, size: number) => FileRead = (absolute: string, size: number): FileRead => {
    const collect: boolean = size <= LargeFileBytes;
    const chunks: Buffer[] = [];
    const headParts: Buffer[] = [];
    const tally: ByteTally = { lf: 0n, le: 0n, be: 0n, previous: -1, tail: -1 };
    const hasher: Hash = createHash("sha256");
    const fd: number = openSync(absolute, "r");
    let position: number = 0;
    let headLength: number = 0;
    try {
        while (position < size) {
            const length: number = Math.min(ChunkBytes, size - position);
            const buffer: Buffer = Buffer.allocUnsafe(length);
            const read: number = readSync(fd, buffer, 0, length, position);
            if (read <= 0) {
                break;
            }
            const chunk: Buffer = buffer.subarray(0, read);
            hasher.update(chunk);
            if (collect) {
                chunks.push(chunk);
            } else {
                tallyChunk(tally, chunk);
            }
            if (headLength < HeadBytes) {
                const take: number = Math.min(HeadBytes - headLength, chunk.length);
                headParts.push(chunk.subarray(0, take));
                headLength += take;
            }
            position += read;
        }
    } finally {
        closeSync(fd);
    }
    return {
        head: concatBytes(headParts),
        full: collect ? concatBytes(chunks) : undefined,
        fingerprint: `sha256:${hasher.digest("hex")}`,
        tally,
    };
};

const countStreamedLines: (charset: Charset, size: number, tally: ByteTally) => bigint = (charset: Charset, size: number, tally: ByteTally): bigint => {
    if (size === 0 || charset === "binary" || charset === "none") {
        return 0n;
    }
    if (charset === "utf-16le") {
        const endsWithNewline: boolean = tally.previous === NewlineByte && tally.tail === ZeroByte;
        return tally.le + (endsWithNewline ? 0n : 1n);
    }
    if (charset === "utf-16be") {
        const endsWithNewline: boolean = tally.previous === ZeroByte && tally.tail === NewlineByte;
        return tally.be + (endsWithNewline ? 0n : 1n);
    }
    return tally.lf + (tally.tail === NewlineByte ? 0n : 1n);
};

const timeZoneOf: (options: TreeOptions) => "local" | "utc" = (options: TreeOptions): "local" | "utc" => (options.timeZone === "utc" ? "utc" : "local");

/**
 * Build one file node by stat-ing and reading the file behind a root-relative
 * path.
 *
 * @param root - Session root that owns the file.
 * @param relative - Root-relative POSIX path.
 * @param options - Tree bounds and metadata options.
 * @returns A file node with a full-content fingerprint.
 */
export const buildFileNode: (root: SessionRoot, relative: string, options?: TreeOptions) => FileNode = (root: SessionRoot, relative: string, options: TreeOptions = {}): FileNode => {
    const path: string = normalizeFileRelative(relative);
    const absolute: string = absoluteOf(root, path);
    const rootExclude: readonly string[] = Array.isArray(root.exclude) ? root.exclude : [];
    const optionExclude: readonly string[] = Array.isArray(options.exclude) ? options.exclude : [];
    const scopedRoot: SessionRoot = { ...root, exclude: [...rootExclude, ...optionExclude] };
    const sandbox: PathSandbox = new PathSandbox([scopedRoot], { followSymlinks: options.followSymlinks === true });
    if (sandbox.isExcluded(scopedRoot, path)) {
        return fail("excluded_path");
    }
    sandbox.revalidate({ root: scopedRoot, relative: path, absolute });
    let linkStat: Stats;
    try {
        linkStat = lstatSync(absolute);
    } catch (error: unknown) {
        return failRead(error);
    }
    const stat: Stats = linkTargetStat(scopedRoot, absolute, linkStat, options);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    let read: FileRead;
    try {
        read = readFileBytes(absolute, stat.size);
    } catch (error: unknown) {
        return failRead(error);
    }
    const body: Uint8Array | undefined = read.full;
    const detected: DetectedCharset = detectCharset(body ?? read.head);
    let charset: Charset = detected.binary ? "binary" : detected.charset;
    let lines: bigint = 0n;
    if (charset !== "binary") {
        if (body !== (void 0)) {
            try {
                lines = countLines(decodeText(body, charset));
            } catch {
                charset = "binary";
                lines = 0n;
            }
        } else {
            lines = countStreamedLines(charset, stat.size, read.tally);
        }
    }
    const described: NodeDescription = describeFile(absolute, path, charset, read.head, annotationFor(options.annotations, path));
    const timeZone: "local" | "utc" = timeZoneOf(options);
    const create: NodeTime = formatNodeTime(creationTime(stat), timeZone);
    const modify: NodeTime = formatNodeTime(new Date(stat.mtimeMs), timeZone);
    return {
        type: "File",
        path,
        name: nameOfPath(path),
        extension: extensionOfPath(path),
        children: [],
        fingerprint: read.fingerprint,
        charset,
        lines,
        bytes: BigInt(stat.size),
        create,
        modify,
        description: described.description,
        summary: described.summary,
        purpose: described.purpose,
    };
};

const wireFile: (node: FileNode) => WireFileNode = (node: FileNode): WireFileNode => ({
    ...node,
    lines: `${node.lines}`,
    bytes: `${node.bytes}`,
    children: [],
});

const wireDirectory: (node: DirectoryNode, children: readonly WireTreeNode[]) => WireDirectoryNode = (node: DirectoryNode, children: readonly WireTreeNode[]): WireDirectoryNode => ({
    ...node,
    lines: `${node.lines}`,
    bytes: `${node.bytes}`,
    children,
});

/**
 * Project an in-process node into its JSON-safe wire shape. `lines`/`bytes`
 * become decimal strings and every descendant is projected as well.
 *
 * @param node - Node to project.
 * @returns Wire node.
 */
export const wireNode: (node: TreeNode) => WireTreeNode = (node: TreeNode): WireTreeNode => {
    if (node.type === "File") {
        return wireFile(node);
    }
    return wireDirectory(
        node,
        node.children.map((child: TreeNode): WireTreeNode => wireNode(child)),
    );
};

/**
 * Project a node with a bounded number of child levels. `depth` 0 returns the
 * node with an empty child list, which is what a flat directory listing needs.
 *
 * @param node - Node to project.
 * @param depth - Maximum child levels to include.
 * @param offset - Child offset at the first level.
 * @param limit - Maximum children at the first level.
 * @returns Wire node.
 */
export const wireTree: (node: TreeNode, depth: number, offset: number, limit: number) => WireTreeNode = (node: TreeNode, depth: number, offset: number, limit: number): WireTreeNode => {
    if (node.type === "File") {
        return wireFile(node);
    }
    const levels: number = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : depth > 0 ? Number.MAX_SAFE_INTEGER : 0;
    if (levels === 0) {
        return wireDirectory(node, []);
    }
    const start: number = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const size: number = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : node.children.length;
    const selected: readonly TreeNode[] = node.children.slice(start, start + size);
    return wireDirectory(
        node,
        selected.map((child: TreeNode): WireTreeNode => wireTree(child, levels - 1, 0, Number.MAX_SAFE_INTEGER)),
    );
};

/**
 * Re-read a file and fail unless its content fingerprint matches the expected
 * value. The whole file is hashed; no partial comparison is attempted.
 *
 * @param root - Session root that owns the file.
 * @param relative - Root-relative POSIX path.
 * @param expected - Expected `sha256:<hex>` reference.
 */
export const verifyFingerprint: (root: SessionRoot, relative: string, expected: string) => void = (root: SessionRoot, relative: string, expected: string): void => {
    const node: FileNode = buildFileNode(root, relative);
    if (node.fingerprint !== expected) {
        return fail("fingerprint_mismatch");
    }
};
