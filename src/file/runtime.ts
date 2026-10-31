/**
 * Per-session runtime state.
 *
 * One `SessionRuntime` exists per live session handle. It owns the path
 * sandbox, the lazily built tree per root, and the annotation snapshot. Nothing
 * here is shared across sessions: two agents looking at the same directory still
 * get separate trees, separate revisions and separate write journals, which is
 * what makes the isolation claim testable instead of stylistic.
 */
import type { SessionDescriptor, SessionOperation, SessionRoot } from "../session/types.ts";
import { fail } from "./errors.ts";
import { PathSandbox } from "./path.ts";
import { WorkspaceTree } from "./tree.ts";
import type { FilesystemStore } from "./types.ts";
import type { NodeAnnotation, RootedPath, TreeNode, TreeOptions, TreeSnapshot } from "./types.ts";

/**
 * Host-supplied annotations, keyed by root id and then by root-relative path.
 */
export type AnnotationMap = Readonly<Record<string, Readonly<Record<string, NodeAnnotation>>>>;

/**
 * Runtime construction options.
 */
export interface SessionRuntimeOptions {
    readonly store?: FilesystemStore;
    readonly annotations?: AnnotationMap;
    readonly timeZone?: "local" | "utc";
    readonly followSymlinks?: boolean;
    readonly includeHidden?: boolean;
}

/**
 * Tree wrapper returned for one resolved path.
 */
export interface ResolvedNode {
    readonly rooted: RootedPath;
    readonly tree: WorkspaceTree;
    readonly node: TreeNode;
    readonly revision: string;
}

export class SessionRuntime {
    readonly descriptor: SessionDescriptor;
    readonly sandbox: PathSandbox;
    private readonly store?: FilesystemStore;
    private readonly hostAnnotations: AnnotationMap;
    private readonly timeZone: "local" | "utc";
    private readonly followSymlinks: boolean;
    private readonly includeHidden: boolean;
    private readonly trees: Map<string, WorkspaceTree> = new Map<string, WorkspaceTree>();
    private readonly annotations: Map<string, Record<string, NodeAnnotation>> = new Map<string, Record<string, NodeAnnotation>>();

    constructor(descriptor: SessionDescriptor, options: SessionRuntimeOptions = {}) {
        this.descriptor = descriptor;
        this.sandbox = new PathSandbox(descriptor.roots, { followSymlinks: options.followSymlinks === true });
        this.store = options.store;
        this.hostAnnotations = options.annotations ?? {};
        this.timeZone = options.timeZone === "utc" ? "utc" : "local";
        this.followSymlinks = options.followSymlinks === true;
        this.includeHidden = options.includeHidden === true;
    }

    /**
     * Resolve a caller path and return the tree that owns it.
     */
    resolve(input: unknown, operation: SessionOperation): { rooted: RootedPath; tree: WorkspaceTree; } {
        const rooted: RootedPath = this.sandbox.resolve(input, operation);
        return { rooted, tree: this.treeFor(rooted.root) };
    }

    /**
     * Resolve and locate one node, failing with `not_found` when it is absent.
     */
    node(input: unknown, operation: SessionOperation = "read"): ResolvedNode {
        const { rooted, tree } = this.resolve(input, operation);
        const node: TreeNode | undefined = tree.node(rooted.relative);
        if (node === (void 0)) {
            return fail("not_found");
        }
        return { rooted, tree, node, revision: tree.revision() };
    }

    /**
     * Cached tree for one root. Options bind the session's own quota, so a
     * second session cannot raise another's node ceiling.
     */
    treeFor(root: SessionRoot): WorkspaceTree {
        const existing: WorkspaceTree | undefined = this.trees.get(root.id);
        if (existing !== (void 0)) {
            return existing;
        }
        const options: TreeOptions = {
            maxNodes: this.descriptor.permissions.maxTreeNodes,
            annotations: this.annotationsFor(root),
            exclude: root.exclude,
            followSymlinks: this.followSymlinks,
            includeHidden: this.includeHidden,
            timeZone: this.timeZone,
        };
        const tree: WorkspaceTree = new WorkspaceTree(root, options);
        this.trees.set(root.id, tree);
        return tree;
    }

    /**
     * Latest revision of one root, building the tree if necessary.
     */
    revisionFor(root: SessionRoot): string {
        return this.treeFor(root).revision();
    }

    /**
     * Persist the current snapshot after a write. A store failure is surfaced as
     * `store_failure`; the in-memory tree stays valid, so a caller can retry the
     * persistence step without replaying the write.
     */
    persist(root: SessionRoot, snapshot: TreeSnapshot): void {
        if (this.store === (void 0)) {
            return;
        }
        try {
            this.store.saveTree(root.id, snapshot);
        } catch {
            return fail("store_failure");
        }
    }

    /**
     * Record one journal entry when a store is configured.
     */
    journal(entry: Parameters<FilesystemStore["appendWrite"]>[0]): void {
        if (this.store === (void 0)) {
            return;
        }
        try {
            this.store.appendWrite(entry);
        } catch {
            return fail("store_failure");
        }
    }

    /**
     * Fresh copy of the merged annotations for one root. Stored annotations are
     * loaded once; host annotations win on a key collision because they are the
     * more trusted, more recent declaration.
     */
    annotationsFor(root: SessionRoot): Record<string, NodeAnnotation> {
        const existing: Record<string, NodeAnnotation> | undefined = this.annotations.get(root.id);
        if (existing !== (void 0)) {
            return { ...existing };
        }
        const merged: Record<string, NodeAnnotation> = {};
        if (this.store !== (void 0)) {
            try {
                const stored: Record<string, NodeAnnotation> = this.store.loadAnnotations(root.id);
                Object.assign(merged, stored);
            } catch {
                return fail("store_failure");
            }
        }
        const host: Readonly<Record<string, NodeAnnotation>> | undefined = this.hostAnnotations[root.id];
        if (host !== (void 0)) {
            Object.assign(merged, host);
        }
        this.annotations.set(root.id, merged);
        return { ...merged };
    }

    /**
     * Replace one in-memory annotation after a successful `annotate`-style
     * write. Kept here so a future annotation tool does not need a second cache.
     */
    setAnnotation(root: SessionRoot, path: string, annotation: NodeAnnotation): void {
        const current: Record<string, NodeAnnotation> = this.annotationsFor(root);
        current[path] = annotation;
        this.annotations.set(root.id, current);
        if (this.store !== (void 0)) {
            try {
                this.store.saveAnnotation(root.id, path, annotation, "session");
            } catch {
                return fail("store_failure");
            }
        }
    }

    /**
     * Drop all cached trees and annotations. Called when a session is revoked or
     * expires so a later session id cannot inherit the old state.
     */
    dispose(): void {
        this.trees.clear();
        this.annotations.clear();
    }
}
