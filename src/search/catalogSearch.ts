import { createHash } from "node:crypto";
import { catalogKey } from "../database/entity/catalog.ts";
import type { CatalogRecord, CatalogService, CatalogSyncState } from "../database/service/catalogService.ts";
import { CatalogStore } from "../database/store/catalogStore.ts";
import type { DiscoverySearch, DiscoverySearchNode, DiscoverySearchOptions, DiscoverySearchResult, DiscoverySearchTree } from "../discover/types.ts";
import { ElasticsearchSearch } from "./elasticsearch.ts";
import type { ElasticsearchSearchOptions, SearchDocument, SearchScope } from "./types.ts";

/** A digest keeps Elasticsearch IDs bounded even when opaque business IDs are long. */
export const catalogSearchId = (namespace: string, kind: string, id: string): string =>
    createHash("sha256").update(catalogKey(namespace, kind, id)).digest("hex");

export interface CatalogSearchOptions {
    namespace: string;
    catalog: CatalogService;
    cache?: CatalogStore;
    /** Exclusive index for this catalog namespace; share a coordinator across services. */
    search: ElasticsearchSearch;
    ownsSearch?: boolean;
    maxNodes?: number;
}

/** Cancellation stops waiting; the adapter cannot prove server-side cancellation. */
export interface CatalogSyncOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

const integer = (value: number | undefined, fallback: number, min: number, max: number, label: string): number => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new RangeError(`invalid ${label}`);
    return result;
};
const bodyOf = (record: CatalogRecord): string | undefined => {
    const parts = [record.payload.content, record.payload.instructions].filter((value): value is string => typeof value === "string");
    return parts.length === 0 ? undefined : parts.join("\n");
};

/** SQLite is authoritative. Network operations never run within its transaction. */
export class CatalogSearch implements DiscoverySearch {
    private readonly namespace: string;
    private readonly catalog: CatalogService;
    private readonly cache: CatalogStore;
    private readonly ownsCache: boolean;
    private readonly searchAdapter: ElasticsearchSearch;
    private readonly ownsSearch: boolean;
    private readonly maxNodes: number;
    private tail: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(options: CatalogSearchOptions) {
        if (typeof options.namespace !== "string" || !options.namespace.trim()) throw new TypeError("namespace must be nonempty");
        this.namespace = options.namespace;
        this.catalog = options.catalog;
        this.cache = options.cache ?? new CatalogStore(options.catalog);
        this.ownsCache = options.cache === undefined;
        this.searchAdapter = options.search;
        this.searchAdapter.bindNamespace(this.namespace);
        this.ownsSearch = options.ownsSearch === true;
        this.maxNodes = integer(options.maxNodes, 200, 1, 200, "maxNodes");
    }

    static create(options: { namespace: string; catalog: CatalogService; cache?: CatalogStore; elasticsearch: ElasticsearchSearchOptions }): CatalogSearch {
        return new CatalogSearch({ ...options, search: new ElasticsearchSearch(options.elasticsearch), ownsSearch: true });
    }

    /** Persist first, then explicitly call sync. A failed index build remains dirty. */
    replaceSnapshot(records: readonly CatalogRecord[]): number {
        if (this.closed) throw new Error("catalog search is closed");
        return this.catalog.replaceSnapshot(this.namespace, records);
    }

    /** Isolated attempts can be retried immediately: late remote writes cannot reach another snapshot. */
    sync(options: CatalogSyncOptions = {}): Promise<CatalogSyncState> {
        if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return Promise.reject(new TypeError("invalid sync abort signal"));
        let timeout: number | undefined;
        try { timeout = options.timeoutMs === undefined ? undefined : integer(options.timeoutMs, 0, 1, 2_147_483_647, "sync timeout"); }
        catch (error) { return Promise.reject(error); }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rejectCancellation!: (reason: unknown) => void;
        const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
        const cancel = (): void => rejectCancellation(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
        const abort = (): void => controller.abort(options.signal?.reason ?? new Error("catalog synchronization aborted"));
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        if (timeout !== undefined) timer = setTimeout(() => controller.abort(new Error("catalog synchronization timed out; retry is safe")), timeout);
        const queued = this.exclusive(async () => {
            controller.signal.throwIfAborted();
            if (this.catalog.inTransaction) throw new Error("commit the catalog transaction before synchronization");
            const state = this.catalog.state(this.namespace);
            const documents = this.documents(this.catalog.list(this.namespace));
            const epoch = this.catalog.beginPublication(this.namespace);
            const rebuild = async (): Promise<CatalogSyncState> => {
                const snapshot = await this.searchAdapter.buildSnapshot(this.namespace, documents, controller.signal);
                controller.signal.throwIfAborted();
                if (this.catalog.inTransaction) throw new Error("commit the catalog transaction before publishing a snapshot");
                if (!this.catalog.publishSnapshot(this.namespace, epoch, state.generation, snapshot.index, snapshot.digest))
                    throw new Error("catalog changed during synchronization; synchronize again");
                return this.catalog.state(this.namespace);
            };
            return Promise.race([rebuild(), cancellation]);
        });
        return Promise.race([queued, cancellation]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            controller.signal.removeEventListener("abort", cancel);
        });
    }

    private documents(records: readonly CatalogRecord[]): SearchDocument[] {
        return records.map(record => ({ id: catalogSearchId(this.namespace, record.kind, record.id), kind: record.kind, title: record.name, summary: record.summary,
            ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
            ...(record.revision === undefined ? {} : { revision: record.revision }),
            ...(record.sourceUri === undefined ? {} : { sourceUri: record.sourceUri }),
            tags: [...(record.tags ?? [])], searchTerms: [...(record.searchTerms ?? [])],
            ...(bodyOf(record) === undefined ? {} : { content: bodyOf(record) }),
        }));
    }

    discover(scope: SearchScope, queries: string | readonly string[], options: DiscoverySearchOptions = {}): Promise<DiscoverySearchResult> {
        return this.exclusive(async () => {
            if (scope === null || typeof scope !== "object" || !Array.isArray(scope.projectIds) ||
                scope.projectIds.some((id) => typeof id !== "string" || !id.trim()) ||
                (scope.includeGlobal !== undefined && typeof scope.includeGlobal !== "boolean")) throw new TypeError("invalid search scope");
            if (typeof queries !== "string" && !Array.isArray(queries)) throw new TypeError("queries must be a string or array");
            const requested = typeof queries === "string" ? [queries] : [...queries];
            if (requested.length < 1 || requested.length > 8 || requested.some((query) => typeof query !== "string" || !query.trim() || Array.from(query).length > 512))
                throw new RangeError("discover requires one to eight nonempty queries of at most 512 characters");
            const limit = integer(options.limit, 20, 1, 100, "limit");
            const maxDepth = integer(options.maxDepth, 6, 0, 12, "maxDepth");
            const nodeLimit = integer(options.nodeLimit, this.maxNodes, 1, this.maxNodes, "nodeLimit");
            if (options.revision !== undefined && (typeof options.revision !== "string" || !options.revision.trim())) throw new TypeError("invalid revision");
            for (const values of [options.kinds, options.tags]) {
                if (values !== undefined && (!Array.isArray(values) || values.length > 32 || values.some((value) => typeof value !== "string" || !value.trim())))
                    throw new TypeError("invalid metadata filter");
            }
            if (this.catalog.inTransaction) throw new Error("commit the catalog transaction before discovery");
            const state = this.catalog.state(this.namespace);
            const published = this.catalog.publication(this.namespace);
            if (state.generation === 0 || state.generation !== state.syncedGeneration || published.generation !== state.generation || published.index === null || published.digest === null)
                throw new Error("catalog search index is stale");
            if (scope.projectIds.length === 0 && scope.includeGlobal !== true) return { trees: [] };
            const snapshot = { index: published.index, digest: published.digest };
            const expected = this.documents(this.catalog.list(this.namespace));
            const authorized = (record: CatalogRecord): boolean => record.projectId === undefined
                ? scope.includeGlobal === true
                : scope.projectIds.includes(record.projectId) && (options.revision === undefined || record.revision === options.revision);
            const records = this.catalog.list(this.namespace).filter(authorized);
            const bySearchId = new Map(records.map((record) => [catalogSearchId(this.namespace, record.kind, record.id), record]));
            const byKey = new Map(records.map((record) => [catalogKey(this.namespace, record.kind, record.id), record]));
            const byId = new Map<string, CatalogRecord[]>();
            for (const record of records) byId.set(record.id, [...(byId.get(record.id) ?? []), record]);
            const resolve = (targetId: string): CatalogRecord[] => {
                const typed = byKey.get(targetId);
                if (typed !== undefined) return [typed];
                let tuple: unknown;
                try { tuple = JSON.parse(targetId) as unknown; } catch { tuple = undefined; }
                // Composite keys are namespace-qualified; never reinterpret an absent/foreign key as a raw ID.
                if (Array.isArray(tuple) && tuple.length === 3 && tuple.every((part) => typeof part === "string")) return [];
                const candidates = byId.get(targetId) ?? [];
                return candidates.length === 1 ? candidates : [];
            };
            const results = await Promise.all(requested.map(async (query): Promise<DiscoverySearchTree[]> => {
                const found = await this.searchAdapter.searchSnapshot(this.namespace, snapshot, expected, scope, { text: query, limit,
                    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
                    ...(options.tags === undefined ? {} : { tags: options.tags }),
                    ...(options.revision === undefined ? {} : { revision: options.revision }),
                });
                const trees: DiscoverySearchTree[] = [];
                const seen = new Set<string>();
                for (const hit of found.hits) {
                    const identity = bySearchId.get(hit.document.id);
                    if (identity === undefined || identity.kind !== hit.document.kind || seen.has(hit.document.id)) continue;
                    // This list is a fresh SQLite snapshot; instance-local cache entries can be stale across DB connections.
                    const root = identity;
                    if (root === undefined || !authorized(root) || hit.document.projectId !== root.projectId || hit.document.revision !== root.revision) continue;
                    if (options.kinds?.length && !options.kinds.includes(root.kind)) continue;
                    if (options.tags?.length && !options.tags.some((tag) => root.tags?.includes(tag))) continue;
                    seen.add(hit.document.id);
                    const budget = { remaining: nodeLimit, truncated: false };
                    const tree = this.buildTree(root, hit.score, new Set(), 0, maxDepth, budget, resolve);
                    trees.push({ query, tree, total: found.total, totalRelation: found.totalRelation, took: found.took,
                        timedOut: found.timedOut, truncated: budget.truncated || found.total > found.hits.length });
                }
                return trees;
            }));
            if (this.catalog.inTransaction) throw new Error("commit the catalog transaction before completing discovery");
            const current = this.catalog.state(this.namespace);
            const currentPublication = this.catalog.publication(this.namespace);
            if (currentPublication.index !== published.index || currentPublication.digest !== published.digest ||
                current.generation !== state.generation || current.syncedGeneration !== state.generation)
                throw new Error("catalog changed during discovery; synchronize again");
            return { trees: results.flat() };
        });
    }

    close(): Promise<void> {
        return this.exclusive(async () => {
            this.closed = true;
            if (this.ownsCache) this.cache.dispose();
            if (this.ownsSearch) await this.searchAdapter.close();
        });
    }

    private exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.tail.then(() => {
            if (this.closed) throw new Error("catalog search is closed");
            return operation();
        });
        this.tail = next.then(() => {}, () => {});
        return next;
    }

    private buildTree(record: CatalogRecord, score: number | null, ancestors: Set<string>, depth: number, maxDepth: number,
        budget: { remaining: number; truncated: boolean }, resolve: (id: string) => CatalogRecord[]): DiscoverySearchNode {
        const node: DiscoverySearchNode = { id: record.id, kind: record.kind, label: record.name, summary: record.summary,
            ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
            ...(record.sourceUri === undefined ? {} : { sourceUri: record.sourceUri }),
            ...(depth === 0 ? { score } : {}), matched: depth === 0, children: [] };
        budget.remaining -= 1;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(catalogKey(this.namespace, record.kind, record.id));
        const targets = new Map<string, CatalogRecord>();
        for (const relation of record.relations ?? []) {
            const matches = resolve(relation.targetId);
            if (matches.length === 0) {
                budget.truncated = true;
                continue;
            }
            for (const target of matches) {
                const key = catalogKey(this.namespace, target.kind, target.id);
                if (nextAncestors.has(key)) budget.truncated = true;
                else targets.set(key, target);
            }
        }
        for (const target of targets.values()) {
            if (depth >= maxDepth || budget.remaining <= 0) { budget.truncated = true; break; }
            node.children.push(this.buildTree(target, null, nextAncestors, depth + 1, maxDepth, budget, resolve));
        }
        return node;
    }
}
