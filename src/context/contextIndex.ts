/**
 * ContextIndex: the hot path over ContextAst.
 *
 * exact map answers "which node?", CAS answers "what content?", LRU answers
 * "what is resident?". Bloom/Cuckoo are intentionally absent until profiling
 * shows that negative lookups or deletions dominate; they are indexes, not the
 * source of truth.
 */
import { ContextAst } from "./ast.ts";
import type { ContextAstNode, ContextAstView } from "./ast.ts";
import type { ContentStore } from "./contentStore.ts";
import { MemoryContentStore } from "./contentStore.ts";
import { LRUUnorderedMap } from "../structure/lru.ts";

export interface ContextIndexOptions {
    store?: ContentStore;
    cacheEntries?: number;
}

export interface ContextIndexStats {
    nodes: number;
    cachedDetails: number;
    hits: number;
    misses: number;
}

export class ContextIndex {
    readonly ast: ContextAst;
    private readonly store: ContentStore;
    private readonly cache: LRUUnorderedMap<string, string>;
    private hits = 0;
    private misses = 0;

    constructor(ast = new ContextAst(), options: ContextIndexOptions = {}) {
        this.ast = ast;
        this.store = options.store ?? new MemoryContentStore();
        this.cache = new LRUUnorderedMap<string, string>(options.cacheEntries ?? 64);
    }

    /**
     * Add a node and, when given, store its detail behind a content ref.
     */
    add(node: ContextAstNode, detail?: string): ContextAstNode {
        if (this.ast.node(node.id) !== (void 0)) {
            throw new Error(`duplicate indexed node ${node.id}`);
        }
        const detailRef = detail === (void 0) ? node.detailRef : this.store.put(detail);
        const indexed: ContextAstNode = { ...node, ...(detailRef === (void 0) ? {} : { detailRef }) };
        this.ast.add(indexed);
        return this.ast.node(indexed.id)!;
    }

    node(id: string): ContextAstNode | undefined {
        return this.ast.node(id);
    }

    /**
     * LRU -> CAS retrieval; a miss is explicit.
     */
    getDetail(nodeId: string): string | undefined {
        const node = this.ast.node(nodeId);
        if (node?.detailRef === (void 0)) {
            return undefined;
        }
        const cached = this.cache.get(node.detailRef);
        if (cached !== (void 0)) {
            this.hits += 1;
            return cached;
        }
        this.misses += 1;
        const detail = this.store.get(node.detailRef);
        if (detail !== (void 0)) {
            this.cache.set(node.detailRef, detail);
        }
        return detail;
    }

    view(budgetTokens: number, targetIds?: readonly string[]): ContextAstView {
        return this.ast.view(budgetTokens, targetIds);
    }

    stats(): ContextIndexStats {
        return { nodes: this.ast.size, cachedDetails: this.cache.size, hits: this.hits, misses: this.misses };
    }
}
