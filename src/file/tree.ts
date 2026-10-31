/**
 * Bounded workspace tree construction, indexing and revisioning.
 *
 * The tree is the read side of the filesystem domain: every file and directory
 * becomes one immutable node, directories aggregate their descendants' bytes and
 * lines, and a bounded walk stops with `truncated: true` instead of exhausting
 * memory. Exclusions come from `PathSandbox` so the tree service and the tool
 * resolver cannot disagree about what a root excludes.
 *
 * A snapshot is cached per `WorkspaceTree`. `refresh()` rebuilds it (a targeted
 * subtree rebuild is an optimisation this implementation does not need yet) and
 * the revision covers structure, annotations and the truncated flag, not
 * timestamps or raw bytes.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

import { digestOf } from "../semantic/canonical.ts";
import type { SessionRoot } from "../session/types.ts";
import { buildDirectoryNode } from "./directory.ts";
import { fail } from "./errors.ts";
import { buildFileNode } from "./file.ts";
import { annotationFor, describeDirectory } from "./metadata.ts";
import type { NodeDescription } from "./metadata.ts";
import { PathSandbox } from "./path.ts";
import { creationTime } from "./time.ts";
import type { DirectoryNode, NodeAnnotation, TreeNode, TreeOptions, TreeSnapshot, TreeStats } from "./types.ts";

const DefaultMaxNodes: number = 20000;
const DefaultMaxBytes: bigint = 268435456n;
const ControlCharacters: RegExp = /[\u0000-\u001f\u007f]/;
const DriveLetter: RegExp = /^[A-Za-z]:/;
const ReadmeName: RegExp = /^readme(?:\.(?:md|markdown|mdx|txt|rst))?$/i;

interface WalkState {
    nodes: number;
    files: bigint;
    directories: bigint;
    lines: bigint;
    bytes: bigint;
    truncated: boolean;
}

interface WalkCandidate {
    readonly name: string;
    readonly relative: string;
    readonly absolute: string;
    readonly stat: Stats;
    readonly directory: boolean;
    readonly real?: string;
}

interface RevisionAnnotation {
    readonly path: string;
    readonly description: string | null;
    readonly summary: string | null;
    readonly purpose: string | null;
}

const compareNames: (left: string, right: string) => number = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const compareCandidates: (left: WalkCandidate, right: WalkCandidate) => number = (left: WalkCandidate, right: WalkCandidate): number => {
    if (left.directory !== right.directory) {
        return left.directory ? -1 : 1;
    }
    return compareNames(left.name, right.name);
};

const errnoCode: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) === "object" && error !== null) {
        const candidate: { code?: unknown; } = error as { code?: unknown; };
        if (typeof(candidate.code) === "string") {
            return candidate.code;
        }
    }
    return "";
};

const rootStat: (path: string) => Stats = (path: string): Stats => {
    try {
        return lstatSync(path);
    } catch (error: unknown) {
        const code: string = errnoCode(error);
        if (code === "ENOENT") {
            return fail("not_found");
        }
        if (code === "EACCES" || code === "EPERM") {
            return fail("permission_denied");
        }
        return fail("internal_error");
    }
};

const normalizeMaxNodes: (value: number | undefined) => number = (value: number | undefined): number => {
    if (value === (void 0) || !Number.isFinite(value)) {
        return DefaultMaxNodes;
    }
    return Math.max(1, Math.floor(value));
};

const normalizeMaxBytes: (value: bigint | undefined) => bigint = (value: bigint | undefined): bigint => {
    if (value === (void 0)) {
        return DefaultMaxBytes;
    }
    return value < 0n ? 0n : value;
};

const normalizeTreePath: (input: string) => string | undefined = (input: string): string | undefined => {
    if (typeof(input) !== "string" || ControlCharacters.test(input)) {
        return undefined;
    }
    const text: string = input.trim();
    if (text.length === 0 || text === ".") {
        return ".";
    }
    if (text.includes("\\") || DriveLetter.test(text) || text.startsWith("/")) {
        return undefined;
    }
    const segments: string[] = [];
    const parts: string[] = text.split("/");
    for (let index: number = 0; index < parts.length; index += 1) {
        const part: string = parts[index];
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            return undefined;
        }
        segments.push(part);
    }
    return segments.length === 0 ? "." : segments.join("/");
};

const freezeNode: (node: TreeNode) => TreeNode = (node: TreeNode): TreeNode => {
    if (node.type === "Directory") {
        for (let index: number = 0; index < node.children.length; index += 1) {
            freezeNode(node.children[index]);
        }
    }
    Object.freeze(node.children);
    return Object.freeze(node);
};

const indexNode: (node: TreeNode, index: Map<string, TreeNode>) => void = (node: TreeNode, index: Map<string, TreeNode>): void => {
    index.set(node.path, node);
    if (node.type === "Directory") {
        for (let child: number = 0; child < node.children.length; child += 1) {
            indexNode(node.children[child], index);
        }
    }
};

/**
 * Apply a directory's direct README paragraph as its purpose. The README file
 * node already carries the deterministic first-paragraph summary, so this needs
 * no second read. An explicit annotation always wins.
 */
const withReadmePurpose: (node: DirectoryNode, relative: string, children: readonly TreeNode[], options: TreeOptions) => DirectoryNode = (node: DirectoryNode, relative: string, children: readonly TreeNode[], options: TreeOptions): DirectoryNode => {
    const annotation: NodeAnnotation | undefined = annotationFor(options.annotations, relative);
    if (annotation !== (void 0) && annotation.purpose !== (void 0)) {
        return node;
    }
    let readme: TreeNode | undefined;
    for (let index: number = 0; index < children.length; index += 1) {
        const child: TreeNode = children[index];
        if (child.type === "File" && ReadmeName.test(child.name) && child.charset !== "binary") {
            readme = child;
            break;
        }
    }
    if (readme === (void 0) || readme.type !== "File") {
        return node;
    }
    const fallback: string = `File ${readme.name}.`;
    const source: string = readme.purpose !== "not declared" ? readme.purpose : readme.summary;
    if (source.length === 0 || source === fallback) {
        return node;
    }
    const described: NodeDescription = describeDirectory(relative, children, annotation, source);
    if (described.purpose === "not declared" || described.purpose === node.purpose) {
        return node;
    }
    return { ...node, purpose: described.purpose };
};

const revisionOf: (root: DirectoryNode, options: TreeOptions, truncated: boolean) => string = (root: DirectoryNode, options: TreeOptions, truncated: boolean): string => {
    const annotations: RevisionAnnotation[] = [];
    const configured: Readonly<Record<string, NodeAnnotation>> | undefined = options.annotations;
    if (configured !== (void 0)) {
        const paths: string[] = Object.keys(configured).sort(compareNames);
        for (let index: number = 0; index < paths.length; index += 1) {
            const path: string = paths[index];
            const annotation: NodeAnnotation = configured[path];
            annotations.push({
                path,
                description: annotation.description === (void 0) ? null : annotation.description,
                summary: annotation.summary === (void 0) ? null : annotation.summary,
                purpose: annotation.purpose === (void 0) ? null : annotation.purpose,
            });
        }
    }
    return digestOf({
        version: "amp.fs.rev/1",
        tree: root.fingerprint,
        annotations,
        truncated,
    });
};

/**
 * Build one immutable snapshot of a session root.
 *
 * The walk skips hidden entries unless `includeHidden`, skips excluded paths,
 * refuses symbolic links unless `followSymlinks`, and records read failures in
 * `stats.truncated` rather than throwing mid-tree.
 *
 * @param root - Session root to scan.
 * @param options - Bounds and metadata options.
 * @returns A snapshot whose root is the session root directory.
 */
export const buildTree: (root: SessionRoot, options?: TreeOptions) => TreeSnapshot = (root: SessionRoot, options: TreeOptions = {}): TreeSnapshot => {
    const maxNodes: number = normalizeMaxNodes(options.maxNodes);
    const maxBytes: bigint = normalizeMaxBytes(options.maxBytes);
    const includeHidden: boolean = options.includeHidden === true;
    const rootExclude: readonly string[] = Array.isArray(root.exclude) ? root.exclude : [];
    const scopedRoot: SessionRoot = {
        ...root,
        exclude: [...rootExclude, ...(Array.isArray(options.exclude) ? options.exclude : [])],
    };
    const sandbox: PathSandbox = new PathSandbox([scopedRoot], { followSymlinks: options.followSymlinks === true });
    const state: WalkState = {
        nodes: 1,
        files: 0n,
        directories: 1n,
        lines: 0n,
        bytes: 0n,
        truncated: false,
    };

    const walkDirectory: (relative: string, absolute: string, stat: Stats, ancestry: ReadonlySet<string>) => DirectoryNode | undefined = (relative: string, absolute: string, stat: Stats, ancestry: ReadonlySet<string>): DirectoryNode | undefined => {
        let names: string[];
        try {
            names = readdirSync(absolute);
        } catch {
            state.truncated = true;
            return undefined;
        }
        const candidates: WalkCandidate[] = [];
        for (let index: number = 0; index < names.length; index += 1) {
            const name: string = names[index];
            if (!includeHidden && name.startsWith(".")) {
                continue;
            }
            const childRelative: string = relative === "." ? name : `${relative}/${name}`;
            if (sandbox.isExcluded(scopedRoot, childRelative)) {
                continue;
            }
            const childAbsolute: string = join(absolute, name);
            let linkStat: Stats;
            try {
                linkStat = lstatSync(childAbsolute);
            } catch {
                state.truncated = true;
                continue;
            }
            let entryStat: Stats = linkStat;
            let realPath: string | undefined;
            const symbolic: boolean = linkStat.isSymbolicLink();
            if (symbolic) {
                if (options.followSymlinks !== true) {
                    continue;
                }
                try {
                    entryStat = statSync(childAbsolute);
                    realPath = realpathSync(childAbsolute);
                } catch {
                    state.truncated = true;
                    continue;
                }
                if (!sandbox.contains(root.path, realPath)) {
                    continue;
                }
            }
            if (!entryStat.isDirectory() && !entryStat.isFile()) {
                continue;
            }
            if (entryStat.isDirectory() && options.followSymlinks === true) {
                let directoryReal: string;
                if (realPath === (void 0)) {
                    try {
                        directoryReal = realpathSync(childAbsolute);
                    } catch {
                        state.truncated = true;
                        continue;
                    }
                } else {
                    directoryReal = realPath;
                }
                if (!sandbox.contains(root.path, directoryReal)) {
                    continue;
                }
                realPath = directoryReal;
            }
            candidates.push({ name, relative: childRelative, absolute: childAbsolute, stat: entryStat, directory: entryStat.isDirectory(), real: realPath });
        }
        candidates.sort(compareCandidates);
        const children: TreeNode[] = [];
        for (let index: number = 0; index < candidates.length; index += 1) {
            const candidate: WalkCandidate = candidates[index];
            if (state.nodes + 1 > maxNodes) {
                state.truncated = true;
                break;
            }
            if (candidate.directory) {
                if (candidate.real !== (void 0) && ancestry.has(candidate.real)) {
                    continue;
                }
                state.nodes += 1;
                state.directories += 1n;
                const childAncestry: ReadonlySet<string> =
                    candidate.real === (void 0) ? ancestry : new Set<string>([...ancestry, candidate.real]);
                const child: DirectoryNode | undefined = walkDirectory(candidate.relative, candidate.absolute, candidate.stat, childAncestry);
                if (child === (void 0)) {
                    state.nodes -= 1;
                    state.directories -= 1n;
                    continue;
                }
                children.push(child);
                continue;
            }
            const size: bigint = BigInt(candidate.stat.size);
            if (state.bytes + size > maxBytes) {
                state.truncated = true;
                continue;
            }
            try {
                const child: TreeNode = buildFileNode(root, candidate.relative, options);
                state.nodes += 1;
                state.files += 1n;
                state.bytes += child.bytes;
                state.lines += child.lines;
                children.push(child);
            } catch {
                state.truncated = true;
            }
        }
        const built: DirectoryNode = buildDirectoryNode(relative, children, options, creationTime(stat), new Date(stat.mtimeMs));
        return withReadmePurpose(built, relative, children, options);
    };

    const stat: Stats = rootStat(root.path);
    if (!stat.isDirectory()) {
        return fail("not_directory");
    }
    let rootReal: string = root.path;
    try {
        rootReal = realpathSync(root.path);
    } catch {
        rootReal = root.path;
    }
    const rootNode: DirectoryNode =
        walkDirectory(".", root.path, stat, new Set<string>([rootReal])) ??
        buildDirectoryNode(".", [], options, creationTime(stat), new Date(stat.mtimeMs));
    const frozen: DirectoryNode = freezeNode(rootNode) as DirectoryNode;
    const stats: TreeStats = Object.freeze({
        files: state.files,
        directories: state.directories,
        lines: state.lines,
        bytes: state.bytes,
        truncated: state.truncated,
    });
    return Object.freeze({
        root: frozen,
        revision: revisionOf(frozen, options, state.truncated),
        stats,
    });
};

/**
 * Cached, immutable view of one session root.
 */
export class WorkspaceTree {
    readonly root: SessionRoot;
    readonly options: TreeOptions;
    private cached: TreeSnapshot | undefined;
    private index: Map<string, TreeNode> | undefined;

    constructor(root: SessionRoot, options: TreeOptions = {}) {
        this.root = { ...root, exclude: Array.isArray(root.exclude) ? [...root.exclude] : [] };
        this.options = { ...options };
    }

    /**
     * Return the cached snapshot, building it on first use.
     */
    snapshot(): TreeSnapshot {
        return this.ensure();
    }

    /**
     * Look up one node by root-relative POSIX path.
     */
    node(relative: string): TreeNode | undefined {
        this.ensure();
        const normalized: string | undefined = normalizeTreePath(relative);
        if (normalized === (void 0)) {
            return undefined;
        }
        const index: Map<string, TreeNode> | undefined = this.index;
        return index === (void 0) ? undefined : index.get(normalized);
    }

    /**
     * Direct children of a directory; an empty array for a file or missing path.
     */
    children(relative: string): readonly TreeNode[] {
        const found: TreeNode | undefined = this.node(relative);
        if (found === (void 0) || found.type === "File") {
            return [];
        }
        return found.children;
    }

    /**
     * Current tree revision.
     */
    revision(): string {
        return this.ensure().revision;
    }

    /**
     * Discard the cache and rebuild the whole tree.
     *
     * @param relative - Subtree hint accepted for future targeted rebuilds.
     * @returns The fresh snapshot.
     */
    refresh(relative?: string): TreeSnapshot {
        void relative;
        return this.rebuild();
    }

    /**
     * Aggregate statistics for the current snapshot.
     */
    stats(): TreeStats {
        return this.ensure().stats;
    }

    private ensure(): TreeSnapshot {
        const cached: TreeSnapshot | undefined = this.cached;
        if (cached !== (void 0)) {
            return cached;
        }
        return this.rebuild();
    }

    private rebuild(): TreeSnapshot {
        const snapshot: TreeSnapshot = buildTree(this.root, this.options);
        this.cached = snapshot;
        const index: Map<string, TreeNode> = new Map<string, TreeNode>();
        indexNode(snapshot.root, index);
        this.index = index;
        return snapshot;
    }
}
