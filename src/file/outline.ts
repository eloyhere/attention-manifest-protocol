import { Optional, SynchronousAbstractSyntaxTree, SynchronousUnorderedMap, isNumber, isObject, isString, useFrom } from "semantic-typescript";
import type { FileSnapshot, OutlineEntry, OutlineProvider, StoredFile } from "./types.ts";
import { fileDigest } from "./core.ts";
import { useLazyProxy } from "../reactive/proxy.ts";
import { createDefaultLanguageRegistry } from "./language/builtins.ts";
import { validateParsedNodes, type LanguageRegistry } from "./language/registry.ts";
import { SourceText, freezeRange, isRange, unionRange, type Range } from "./range.ts";

export interface FileIdentity {
    readonly tenantId: string;
    readonly rootId: string;
    readonly path: string;
    readonly contentHash: string;
}

export interface SourceVersion extends Omit<FileIdentity, "contentHash"> {
    readonly contentHash: string;
    readonly version: number;
    readonly bufferVersion?: number;
}

export type OutlineNodeKind = "file" | "heading" | "symbol";

export interface OutlineNode {
    readonly id: string;
    readonly parentId?: string;
    readonly childIds: readonly string[];
    readonly kind: OutlineNodeKind;
    readonly name: string;
    readonly summary: string;
    readonly range: Range;
    /** True when the node describes content that is not committed to the stored file version. */
    readonly dirty: boolean;
}

/** Metadata-only tree projection. JSON emits metadata without expanding children. */
export interface LazyOutlineNode extends OutlineNode {
    readonly children: readonly LazyOutlineNode[];
    toJSON(): OutlineNode;
}

export interface LazyOutlineOptions {
    /** Called after a node's direct children have been loaded successfully. */
    readonly onLoad?: (nodeId: string) => void;
}

export interface ParsedOutlineNode {
    readonly id: string;
    readonly parentId?: string;
    readonly kind: Exclude<OutlineNodeKind, "file">;
    readonly name: string;
    readonly summary: string;
    readonly range: Range;
}

export interface OutlineParserPort {
    readonly language: string;
    parse(source: string): readonly ParsedOutlineNode[];
}

export interface OutlineBuildOptions {
    readonly parser?: OutlineParserPort;
    readonly language?: string;
    readonly mimeType?: string;
    readonly registry?: LanguageRegistry;
    /** Overrides the computed dirty flag, e.g. an editor buffer that is not yet saved. */
    readonly dirty?: boolean;
}

export interface OutlineCurrentVersion extends Omit<SourceVersion, "bufferVersion"> {
    readonly bufferVersion?: number;
}

export { parser as markdownHeadingParser } from "./language/markdown.ts";

function sourceVersion(source: StoredFile | FileSnapshot | SourceVersion): SourceVersion {
    if (!isObject(source) || !isString(source.tenantId) || !isString(source.rootId) || !isString(source.path)) {
        throw new TypeError("source must carry tenantId, rootId and path");
    }
    if ("hash" in source && isString(source.hash) && "version" in source && isNumber(source.version)) {
        if ("content" in source && isString(source.content) && fileDigest(source.content) !== source.hash) throw new TypeError("stored file content does not match its hash");
        return { tenantId: source.tenantId, rootId: source.rootId, path: source.path, contentHash: source.hash,
            version: source.version, ...("bufferVersion" in source && isNumber(source.bufferVersion) ? { bufferVersion: source.bufferVersion } : {}) };
    }
    if (!isString((source as SourceVersion).contentHash) || !isNumber((source as SourceVersion).version)) {
        throw new TypeError("source must provide a contentHash and version");
    }
    return structuredClone(source as SourceVersion);
}

function dirtySource(source: StoredFile | FileSnapshot | SourceVersion, version: SourceVersion): boolean {
    if ("dirty" in source && source.dirty === true) return true;
    return version.bufferVersion !== undefined && version.bufferVersion !== version.version;
}

function identityKey(identity: FileIdentity): string {
    return JSON.stringify([identity.tenantId, identity.rootId, identity.path]);
}

function sameVersion(left: SourceVersion, right: OutlineCurrentVersion): boolean {
    return left.tenantId === right.tenantId && left.rootId === right.rootId && left.path === right.path
        && left.contentHash === right.contentHash && left.version === right.version
        && left.bufferVersion === right.bufferVersion;
}

interface InternalNode {
    readonly id: string;
    readonly kind: OutlineNodeKind;
    readonly name: string;
    readonly summary: string;
    range: Range;
    readonly dirty: boolean;
    readonly parentId?: string;
    childIds: string[];
}

function snapshot(node: InternalNode): OutlineNode {
    return {
        id: node.id, kind: node.kind, name: node.name, summary: node.summary, range: freezeRange(node.range), dirty: node.dirty,
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }), childIds: Object.freeze([...node.childIds]),
    };
}

export class FileOutline {
    readonly identity: Readonly<FileIdentity>;
    readonly language: string;
    readonly dirty: boolean;
    private readonly nodeStore = new SynchronousUnorderedMap<string, InternalNode>();
    private readonly titleIndex = new SynchronousUnorderedMap<string, SynchronousUnorderedMap<string, number>>();
    private readonly tree: ReturnType<typeof createTree>;
    private readonly rootId: string;
    private readonly capturedVersion: SourceVersion;

    constructor(version: SourceVersion, parserLanguage: string, nodes: readonly ParsedOutlineNode[], text: SourceText, dirty: boolean) {
        this.capturedVersion = structuredClone(version);
        this.identity = Object.freeze({ tenantId: version.tenantId, rootId: version.rootId, path: version.path, contentHash: version.contentHash });
        this.language = parserLanguage;
        this.dirty = dirty;
        this.rootId = `file:${identityKey(this.identity)}:${version.contentHash}`;

        const childrenByParent = new SynchronousUnorderedMap<string, string[]>();
        const mutableNodes = new SynchronousUnorderedMap<string, InternalNode>();
        for (const parsed of nodes) {
            if (!isRange(parsed.range)) throw new TypeError(`invalid range for outline node ${parsed.id}`);
            if (parsed.range.endLine > text.lineCount || parsed.range.endByte > text.byteLength) throw new TypeError(`range exceeds source for outline node ${parsed.id}`);
            if (parsed.id === this.rootId || mutableNodes.containsKey(parsed.id)) throw new TypeError(`duplicate outline node id: ${parsed.id}`);
            const parentId = parsed.parentId ?? this.rootId;
            const node: InternalNode = { id: parsed.id, kind: parsed.kind, name: parsed.name, summary: parsed.summary,
                range: freezeRange(parsed.range), dirty, parentId, childIds: [] };
            mutableNodes.put(node.id, node);
            const children = childrenByParent.get(parentId).orElse([]) as string[];
            children.push(node.id);
            childrenByParent.put(parentId, children);
        }

        const root: InternalNode = { id: this.rootId, kind: "file", name: version.path, summary: "File outline",
            range: freezeRange({ startLine: 0, endLine: text.lineCount, startByte: 0, endByte: text.byteLength }), dirty,
            childIds: childrenByParent.get(this.rootId).orElse([]) as string[] };

        // Children precede parents here, so widening a parent also covers widened descendants.
        const ordered = useFrom(nodes).map(node => node.id).toCollectable().toArray().reverse();
        for (const id of ordered) {
            const node = mutableNodes.get(id).get();
            const parentId = node.parentId;
            if (parentId === undefined) continue;
            if (parentId !== this.rootId && !mutableNodes.containsKey(parentId)) throw new TypeError(`unknown parent for outline node ${id}`);
            let ancestorId: string | undefined = parentId;
            const ancestry = new SynchronousUnorderedMap<string, number>();
            while (ancestorId !== undefined) {
                if (ancestorId === id || ancestry.containsKey(ancestorId)) throw new TypeError(`parent cycle for outline node ${id}`);
                ancestry.put(ancestorId, 1);
                const ancestor: InternalNode | undefined = ancestorId === this.rootId
                    ? root : mutableNodes.get(ancestorId).orElse(undefined) as InternalNode | undefined;
                if (!ancestor) throw new TypeError(`unknown parent for outline node ${id}`);
                ancestor.range = unionRange(ancestor.range, node.range);
                ancestorId = ancestor.parentId;
            }
        }

        this.nodeStore.put(root.id, root);
        for (const entry of mutableNodes.entrySet()) {
            const node = { ...entry.getValue(), childIds: childrenByParent.get(entry.getKey()).orElse([]) as string[] };
            this.nodeStore.put(node.id, node);
            const title = this.titleIndex.get(node.name).orElse(new SynchronousUnorderedMap<string, number>()) as SynchronousUnorderedMap<string, number>;
            title.put(node.id, 1);
            this.titleIndex.put(node.name, title);
        }
        this.tree = createTree(this.nodeStore.values().toArray());
    }

    isCurrent(current: OutlineCurrentVersion): boolean {
        try { return sameVersion(this.capturedVersion, current); } catch { return false; }
    }

    requireCurrent(current: OutlineCurrentVersion): this {
        if (current.tenantId !== this.identity.tenantId || current.rootId !== this.identity.rootId) throw new Error("outline scope mismatch");
        if (!this.isCurrent(current)) throw new Error("outline is stale for the supplied file version");
        return this;
    }

    lookup(id: string): Optional<OutlineNode> {
        return this.nodeStore.get(id).map(node => snapshot(node));
    }

    /** Flat document-order nodes, excluding the synthetic file root; used by outline edit targets. */
    entries(): readonly OutlineNode[] {
        return Object.freeze(useFrom(this.tree.preorder())
            .map(treeNode => treeNode.getElement().get())
            .filter(node => node.kind !== "file")
            .map(node => snapshot(node))
            .toCollectable().toArray());
    }

    /** The resolver must read the host's current version metadata, never a captured version. */
    lazyNode(id: string, current: () => OutlineCurrentVersion, options: LazyOutlineOptions = {}): Optional<LazyOutlineNode> {
        const assertCurrent = (): void => { this.requireCurrent(current()); };
        assertCurrent();
        const cached = new SynchronousUnorderedMap<string, LazyOutlineNode>();
        const project = (nodeId: string): Optional<LazyOutlineNode> => {
            assertCurrent();
            const existing = cached.get(nodeId);
            if (existing.isPresent()) return existing;
            return this.nodeStore.get(nodeId).map(node => {
                const metadata = snapshot(node);
                const proxy = useLazyProxy<LazyOutlineNode, "children">({
                    ...metadata,
                    toJSON: (): OutlineNode => { assertCurrent(); return snapshot(node); },
                }, {
                    assertCurrent,
                    load: {
                        children: () => Object.freeze(useFrom(metadata.childIds)
                            .map(childId => project(childId).get())
                            .toCollectable().toArray()),
                    },
                    onLoad: () => options.onLoad?.(metadata.id),
                }).value;
                cached.put(nodeId, proxy);
                return proxy;
            });
        };
        return project(id);
    }

    lazyTree(current: () => OutlineCurrentVersion, options: LazyOutlineOptions = {}): LazyOutlineNode {
        return this.lazyNode(this.rootId, current, options).get();
    }

    find(name: string, current?: OutlineCurrentVersion): Optional<OutlineNode> {
        if (current) this.requireCurrent(current);
        const matches = this.titleIndex.get(name);
        if (matches.isEmpty()) return Optional.empty<OutlineNode>();
        const first = matches.get().keySet().toArray()[0];
        return first === undefined ? Optional.empty<OutlineNode>() : this.lookup(first);
    }

    expand(id: string, current: OutlineCurrentVersion): readonly OutlineNode[] {
        this.requireCurrent(current);
        const root = this.nodeStore.get(id);
        if (root.isEmpty()) return [];
        const start = root.get();
        const rootTreeNode = useFrom(this.tree.preorder())
            .filter(treeNode => Boolean(treeNode.getElement().map(value => value.id === start.id).orElse(false)))
            .toCollectable()
            .findFirst();
        if (rootTreeNode.isEmpty()) return [];
        const ids = useFrom(rootTreeNode.get().preorder()).map(treeNode => treeNode.getElement().get().id as string).toCollectable().toArray();
        return useFrom(ids).map(nodeId => this.nodeStore.get(nodeId).get()).map(node => snapshot(node)).toCollectable().toArray();
    }

    locate(line: number, current: OutlineCurrentVersion): Optional<OutlineNode> {
        this.requireCurrent(current);
        if (!Number.isSafeInteger(line) || line < 0) throw new RangeError("line must be a nonnegative safe integer");
        let match: InternalNode | undefined;
        for (const treeNode of this.tree.preorder()) {
            const element = treeNode.getElement();
            if (element.isEmpty()) continue;
            const node = element.get();
            const span = node.range.endLine - node.range.startLine;
            if (node.range.startLine <= line && line < node.range.endLine
                && (!match || span <= match.range.endLine - match.range.startLine)) match = node;
        }
        return match ? this.lookup(match.id) : Optional.empty<OutlineNode>();
    }
}

function createTree(nodes: readonly InternalNode[]) {
    const byId = new SynchronousUnorderedMap<string, InternalNode>();
    for (const node of nodes) byId.put(node.id, node);
    return new SynchronousAbstractSyntaxTree<InternalNode, OutlineNodeKind>(nodes, {
        childrenOf: node => node.childIds.flatMap(id => {
            const child = byId.get(id);
            return child.isPresent() ? [child.get()] : [];
        }),
        kindOf: node => node.kind,
        spanOf: node => ({ start: BigInt(node.range.startLine), end: BigInt(node.range.endLine) }),
    });
}

export function createFileOutline(source: StoredFile | FileSnapshot | SourceVersion, content?: string, options: OutlineBuildOptions = {}): FileOutline {
    const version = sourceVersion(source);
    if (!isString(content)) throw new TypeError("outline parsing requires source text as a separate argument");
    if (fileDigest(content) !== version.contentHash) throw new TypeError("source text hash does not match the supplied file version");
    const registry = options.registry ?? createDefaultLanguageRegistry();
    const explicit = Optional.ofNullable(options.parser);
    const detected = Optional.ofNullable(options.language)
        .flatMap(language => registry.find(language))
        .map(language => language.id);
    const selected = options.language ? detected : registry.resolve(version.path, options.mimeType).map(match => match.language.id);
    const resolved = explicit.isPresent() ? explicit : selected.flatMap(id => registry.load(id));
    if (resolved.isEmpty()) throw new TypeError(`no outline parser is registered for language ${options.language ?? version.path}`);
    const parser = resolved.get();
    if (!isString(parser.language)) throw new TypeError("parser language must be a string");
    const text = new SourceText(content);
    const parsed = validateParsedNodes(content, parser.parse(content));
    const dirty = Optional.ofNullable(options.dirty).get(dirtySource(source, version));
    return new FileOutline(version, parser.language, parsed, text, dirty);
}

/**
 * Builds an `OutlineProvider` for edit targets. The provider is a pure function of the
 * supplied buffer text, so it always reflects unsaved edits.
 */
export function createOutlineProvider(options: OutlineBuildOptions = {}): OutlineProvider {
    return Object.freeze({
        entries(path: string, text: string): readonly OutlineEntry[] {
            if (!isString(text)) throw new TypeError("outline provider needs the current buffer text");
            const version: SourceVersion = { tenantId: "outline", rootId: "outline", path,
                contentHash: fileDigest(text), version: 0, bufferVersion: 0 };
            return Object.freeze(createFileOutline(version, text, options).entries()
                .map(node => Object.freeze({ id: node.id, name: node.name, kind: node.kind, range: node.range })));
        },
    });
}
