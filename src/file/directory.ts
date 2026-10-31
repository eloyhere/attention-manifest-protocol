/**
 * Directory-node aggregation, Merkle fingerprints and flat listings.
 *
 * A directory fingerprint covers only structure: the ordered `(type, name,
 * child fingerprint)` triples. Descriptions, summaries, purposes and timestamps
 * are deliberately excluded, so adding an annotation or touching a timestamp
 * cannot masquerade as a content change. The domain header `amp.fs.tree/1`
 * keeps a tree digest from ever colliding with a raw file digest.
 *
 * Byte and line totals are summed as `bigint`; the wire projection turns them
 * into decimal strings so a JSON transport cannot round them through 2^53.
 */
import { rawTextDigest } from "../fingerprint/raw.ts";
import { fail } from "./errors.ts";
import { wireTree } from "./file.ts";
import { annotationFor, describeDirectory, nameOfPath } from "./metadata.ts";
import type { NodeDescription } from "./metadata.ts";
import { formatNodeTime } from "./time.ts";
import type { WorkspaceTree } from "./tree.ts";
import type { DirectoryListing, DirectoryNode, NodeTime, TreeNode, TreeOptions, WireTreeNode } from "./types.ts";

const DefaultPageLimit: number = 50;
const MaxPageLimit: number = 500;

const compareNames: (left: string, right: string) => number = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Tree ordering: directories first, then files, each group ascending by name.
 *
 * @param left - Left node.
 * @param right - Right node.
 * @returns Negative, zero or positive for ascending order.
 */
export const compareTreeNodes: (left: TreeNode, right: TreeNode) => number = (left: TreeNode, right: TreeNode): number => {
    if (left.type !== right.type) {
        return left.type === "Directory" ? -1 : 1;
    }
    return compareNames(left.name, right.name);
};

const directoryFingerprint: (children: readonly TreeNode[]) => string = (children: readonly TreeNode[]): string => {
    const ordered: readonly TreeNode[] = [...children].sort((left: TreeNode, right: TreeNode): number => compareNames(left.name, right.name));
    const parts: string[] = ["amp.fs.tree/1\n"];
    for (let index: number = 0; index < ordered.length; index += 1) {
        const child: TreeNode = ordered[index];
        parts.push(`${child.type}\n${child.name}\n${child.fingerprint}\n`);
    }
    return rawTextDigest(parts.join(""));
};

const boundOffset: (value: number | undefined) => number = (value: number | undefined): number => {
    if (value === (void 0) || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.floor(value));
};

const boundLimit: (value: number | undefined) => number = (value: number | undefined): number => {
    if (value === (void 0) || Number.isNaN(value)) {
        return DefaultPageLimit;
    }
    return Math.min(MaxPageLimit, Math.max(0, Math.floor(value)));
};

/**
 * Build one directory node from already-built children.
 *
 * @param relative - Root-relative POSIX path.
 * @param children - Direct children, in any order.
 * @param options - Tree options (time zone and annotations).
 * @param createdAt - Directory creation time when the caller has one.
 * @param modifiedAt - Directory modification time when the caller has one.
 * @returns An aggregated directory node.
 */
export const buildDirectoryNode: (relative: string, children: readonly TreeNode[], options?: TreeOptions, createdAt?: Date, modifiedAt?: Date) => DirectoryNode = (relative: string, children: readonly TreeNode[], options: TreeOptions = {}, createdAt?: Date, modifiedAt?: Date): DirectoryNode => {
    const timeZone: "local" | "utc" = options.timeZone === "utc" ? "utc" : "local";
    const ordered: readonly TreeNode[] = [...children].sort(compareTreeNodes);
    let bytes: bigint = 0n;
    let lines: bigint = 0n;
    let earliest: NodeTime | undefined;
    let latest: NodeTime | undefined;
    for (let index: number = 0; index < ordered.length; index += 1) {
        const child: TreeNode = ordered[index];
        bytes += child.bytes;
        lines += child.lines;
        if (earliest === (void 0) || child.create < earliest) {
            earliest = child.create;
        }
        if (latest === (void 0) || child.modify > latest) {
            latest = child.modify;
        }
    }
    const epoch: NodeTime = formatNodeTime(new Date(0), timeZone);
    const directoryModify: NodeTime | undefined = modifiedAt !== (void 0) ? formatNodeTime(modifiedAt, timeZone) : undefined;
    const created: NodeTime = createdAt !== (void 0) ? formatNodeTime(createdAt, timeZone) : earliest ?? directoryModify ?? latest ?? epoch;
    let modified: NodeTime = latest ?? created;
    if (directoryModify !== (void 0) && directoryModify > modified) {
        modified = directoryModify;
    }
    const described: NodeDescription = describeDirectory(relative, ordered, annotationFor(options.annotations, relative));
    return {
        type: "Directory",
        path: relative,
        name: nameOfPath(relative),
        extension: "directory",
        children: ordered,
        fingerprint: directoryFingerprint(ordered),
        charset: "none",
        lines,
        bytes,
        create: created,
        modify: modified,
        description: described.description,
        summary: described.summary,
        purpose: described.purpose,
    };
};

/**
 * Page through the direct children of one directory.
 *
 * Entries are projected with `wireTree(..., 0, ...)` so a listing never carries
 * a nested subtree; the caller asks for a specific node when it needs one.
 *
 * @param tree - Workspace snapshot to read.
 * @param path - Root-relative directory path.
 * @param offset - Zero-based child offset.
 * @param limit - Page size, capped at 500.
 * @returns A bounded listing.
 */
export const listDirectory: (tree: WorkspaceTree, path: string, offset?: number, limit?: number) => DirectoryListing = (tree: WorkspaceTree, path: string, offset: number = 0, limit: number = DefaultPageLimit): DirectoryListing => {
    const found: TreeNode | undefined = tree.node(path);
    if (found === (void 0)) {
        return fail("not_found");
    }
    if (found.type === "File") {
        return fail("not_directory");
    }
    const ordered: readonly TreeNode[] = [...found.children].sort(compareTreeNodes);
    const total: number = ordered.length;
    const start: number = boundOffset(offset);
    const size: number = boundLimit(limit);
    const page: readonly TreeNode[] = ordered.slice(start, start + size);
    const entries: readonly WireTreeNode[] = page.map((child: TreeNode): WireTreeNode => wireTree(child, 0, 0, 0));
    return {
        path: found.path,
        revision: tree.revision(),
        entries,
        total,
        nextOffset: start + page.length < total ? start + page.length : null,
    };
};
