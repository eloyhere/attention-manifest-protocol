import { createHash } from "node:crypto";
import { isNumber, isString, Optional, SynchronousUnorderedMap } from "semantic-typescript";
import { useLazyProxy, type LazyProxy } from "../reactive/proxy.ts";
import { safeStringify } from "../serialization/index.ts";

export type FileTreeKind = "file" | "directory";
export type FileTreeOperation = "metadata" | "list" | "read";

export interface FileTreeScope {
    readonly tenantId: string;
    readonly rootId: string;
    readonly path: string;
}

export interface FileTreeRootScope {
    readonly tenantId: string;
    readonly rootId: string;
}

export interface FileTreeOptions extends FileTreeRootScope {
    readonly rootPath?: string;
}

export interface FileTreeMetadata extends FileTreeScope {
    readonly kind: FileTreeKind;
    readonly version: number;
    readonly hash: string;
    readonly revision?: string;
}

export interface FileTreeRead extends FileTreeScope {
    readonly content: string;
    readonly version: number;
    readonly hash: string;
    readonly revision?: string;
}

export interface FileTreeHost {
    metadata(path: string): Optional<FileTreeMetadata>;
    listChildren(scope: FileTreeScope): readonly FileTreeMetadata[];
    readFile(scope: FileTreeScope): FileTreeRead;
    authorize(operation: FileTreeOperation, scope: FileTreeScope): boolean;
    revision(): string;
}

export interface FileTreeNode extends FileTreeMetadata {
    readonly children: readonly FileTreeNode[];
    readonly content: string | undefined;
    toJSON(): FileTreeMetadata;
}

function digest(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

function validatePath(path: string): void {
    if (path === "") return;
    if (!isString(path) || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)
        || path.split("/").some(part => part === "" || part === "." || part === "..")) {
        throw new TypeError(`Invalid workspace-relative file-tree path: ${path}`);
    }
}

function scopeKey(scope: FileTreeScope): string {
    return safeStringify([scope.tenantId, scope.rootId, scope.path]);
}

function requireOptional<T>(value: Optional<T>, message: string): T {
    if (value.isEmpty()) throw new Error(message);
    return value.get();
}

function cloneMetadata(metadata: FileTreeMetadata): FileTreeMetadata {
    return Object.freeze({ ...metadata });
}

function validateMetadata(metadata: FileTreeMetadata, revision: string): void {
    validatePath(metadata.path);
    if (!metadata.tenantId || !metadata.rootId || !isString(metadata.hash) || metadata.hash.length === 0
        || !isNumber(metadata.version) || !Number.isSafeInteger(metadata.version) || metadata.version < 0
        || (metadata.kind !== "file" && metadata.kind !== "directory")
        || (metadata.revision !== undefined && metadata.revision !== revision)) {
        throw new Error("invalid file-tree metadata");
    }
}

function assertSameScope(metadata: FileTreeMetadata, expected: FileTreeRootScope): void {
    if (metadata.tenantId !== expected.tenantId || metadata.rootId !== expected.rootId) throw new Error("file-tree scope mismatch");
}

function assertDirectChild(metadata: FileTreeMetadata, parent: FileTreeScope, revision: string): void {
    validateMetadata(metadata, revision);
    assertSameScope(metadata, parent);
    if (metadata.path === parent.path) throw new Error("file-tree child equals parent");
    const prefix = parent.path === "" ? "" : `${parent.path}/`;
    if (!metadata.path.startsWith(prefix) || metadata.path.slice(prefix.length).includes("/")) throw new Error("file-tree child is outside direct scope");
}

function assertSameVersion(metadata: FileTreeMetadata, expected: FileTreeMetadata, revision: string): void {
    if (metadata.tenantId !== expected.tenantId || metadata.rootId !== expected.rootId || metadata.path !== expected.path
        || metadata.kind !== expected.kind || metadata.version !== expected.version || metadata.hash !== expected.hash
        || (metadata.revision ?? revision) !== (expected.revision ?? revision)) throw new Error("file-tree source changed");
}

/** Lazy metadata/content tree over a host port. It never accesses a real filesystem or network. */
export class FileTree {
    private readonly host: FileTreeHost;
    private readonly rootPath: string;
    private readonly scopeValue: FileTreeRootScope;
    private revisionValue: string | undefined;
    private rootValue: FileTreeNode | undefined;
    private readonly cache = new SynchronousUnorderedMap<string, FileTreeNode>();

    constructor(host: FileTreeHost, options: FileTreeOptions) {
        this.host = host;
        this.rootPath = options.rootPath ?? "";
        this.scopeValue = { tenantId: options.tenantId, rootId: options.rootId };
        validatePath(this.rootPath);
        if (!this.scopeValue.tenantId || !this.scopeValue.rootId) throw new TypeError("FileTree scope is required");
    }

    root(): FileTreeNode {
        if (this.rootValue) return this.rootValue;
        const revision = this.captureRevision();
        const metadata = this.readMetadata(this.rootPath, revision);
        assertSameScope(metadata, this.scopeValue);
        const node = this.createNode(metadata, revision);
        this.rootValue = node;
        return node;
    }

    /** Explicitly starts a new identity/cache after the caller observes a source change. */
    refresh(): FileTreeNode {
        this.revisionValue = this.host.revision();
        this.rootValue = undefined;
        this.cache.clear();
        return this.root();
    }

    private captureRevision(): string {
        const revision = this.host.revision();
        if (this.revisionValue === undefined) this.revisionValue = revision;
        if (this.revisionValue !== revision) throw new Error("file-tree source changed; call refresh");
        return this.revisionValue;
    }

    private readMetadata(path: string, revision: string): FileTreeMetadata {
        validatePath(path);
        const requestScope: FileTreeScope = {
            tenantId: this.scopeValue?.tenantId ?? "",
            rootId: this.scopeValue?.rootId ?? "",
            path,
        };
        this.authorize("metadata", requestScope);
        const metadata = requireOptional(this.host.metadata(path), `file-tree metadata not found: ${path}`);
        validateMetadata(metadata, revision);
        if (this.scopeValue) assertSameScope(metadata, this.scopeValue);
        if (metadata.path !== path) throw new Error("file-tree metadata path mismatch");
        return cloneMetadata(metadata);
    }

    private authorize(operation: FileTreeOperation, scope: FileTreeScope): void {
        if (!this.host.authorize(operation, scope)) throw new Error("file-tree authorization denied");
    }

    private createNode(metadata: FileTreeMetadata, revision: string): FileTreeNode {
        const key = `${revision}:${scopeKey(metadata)}`;
        const cached = this.cache.get(key);
        if (cached.isPresent()) return cached.get();
        const expectedScope: FileTreeScope = { tenantId: metadata.tenantId, rootId: metadata.rootId, path: metadata.path };
        const assertRevision = (): void => {
            if (this.host.revision() !== revision) throw new Error("file-tree source changed; call refresh");
        };
        const lazy: LazyProxy<FileTreeNode> = useLazyProxy<FileTreeNode, "children" | "content">({
            ...metadata,
            toJSON: (): FileTreeMetadata => { assertRevision(); this.authorize("metadata", expectedScope); return cloneMetadata(metadata); },
        }, {
            assertCurrent: assertRevision,
            beforeGet: key => {
                const operation: FileTreeOperation = key === "children" ? "list" : key === "content" ? "read" : "metadata";
                this.authorize(operation, expectedScope);
            },
            load: {
                children: () => {
                    if (metadata.kind === "file") return Object.freeze([] as FileTreeNode[]);
                    const children = this.host.listChildren(expectedScope);
                    const seen = new SynchronousUnorderedMap<string, boolean>();
                    const result: FileTreeNode[] = [];
                    for (const child of children) {
                        assertDirectChild(child, expectedScope, revision);
                        if (seen.containsKey(child.path)) throw new Error("duplicate file-tree child");
                        seen.put(child.path, true);
                        result.push(this.createNode(cloneMetadata(child), revision));
                    }
                    return Object.freeze(result);
                },
                content: () => {
                    if (metadata.kind === "directory") return undefined;
                    const beforeRevision = this.host.revision();
                    if (beforeRevision !== revision) throw new Error("file-tree source changed; call refresh");
                    const before = this.readMetadata(metadata.path, revision);
                    assertSameVersion(before, metadata, revision);
                    const read = this.host.readFile(expectedScope);
                    if (read.tenantId !== metadata.tenantId || read.rootId !== metadata.rootId || read.path !== metadata.path
                        || read.version !== metadata.version || read.hash !== metadata.hash || (read.revision ?? revision) !== (metadata.revision ?? revision)
                        || digest(read.content) !== read.hash) throw new Error("file-tree read version/hash mismatch");
                    const afterRevision = this.host.revision();
                    const after = this.readMetadata(metadata.path, revision);
                    if (afterRevision !== beforeRevision) throw new Error("file-tree source changed during read");
                    assertSameVersion(after, metadata, revision);
                    return read.content;
                },
            },
        });
        const node = lazy.value;
        this.cache.put(key, node);
        return node;
    }
}

export function createFileTree(host: FileTreeHost, options: FileTreeOptions): FileTree {
    return new FileTree(host, options);
}
