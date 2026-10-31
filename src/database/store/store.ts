/**
 * JPA-style first-level entity cache over one service.
 *
 * The store mirrors the identity map of a JPA persistence context: one managed
 * row per primary key, loaded through the service, and explicitly detached or
 * cleared when stale. It is intentionally read-through; writes still belong to
 * the service and repository so the cache cannot become a second source of
 * truth.
 *
 * @typeParam TEntity - Cached row shape.
 * @typeParam TKey - Primary-key type.
 * @typeParam TService - Concrete service used to load rows.
 */
import type { PrimaryKey } from "../entity/entity.ts";
import type { Service } from "../service/service.ts";

/**
 * Options for a store cache.
 */
export interface StoreOptions {
    /**
     * Maximum resident rows; the oldest entry is evicted first.
     */
    readonly maxEntries?: number;
    /**
     * Entry lifetime in milliseconds; zero disables expiry.
     */
    readonly ttlMs?: number;
    /**
     * Clock used for expiry, injectable for tests.
     */
    readonly now?: () => number;
}

/**
 * Cache counters exposed for diagnostics.
 */
export interface StoreStats {
    /**
     * Cache hits.
     */
    readonly hits: number;
    /**
     * Cache misses.
     */
    readonly misses: number;
    /**
     * Entries removed by expiry or capacity.
     */
    readonly evictions: number;
    /**
     * Current resident rows.
     */
    readonly size: number;
}

interface CacheEntry<TEntity> {
    readonly value: TEntity;
    readonly expiresAt: number;
}

export abstract class Store<TEntity extends object, TKey extends PrimaryKey = PrimaryKey, TService extends Service<TEntity, TKey> = Service<TEntity, TKey>> {
    protected readonly service: TService;
    private readonly entries: Map<TKey, CacheEntry<TEntity>>;
    private readonly maxEntries: number;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private hits: number;
    private misses: number;
    private evictions: number;

    /**
     * Create a read-through entity cache.
     *
     * @param service - Service used on cache misses.
     * @param options - Capacity, TTL and clock options.
     */
    protected constructor(service: TService, options: StoreOptions = {}) {
        this.service = service;
        this.entries = new Map<TKey, CacheEntry<TEntity>>();
        this.maxEntries = options.maxEntries ?? 256;
        this.ttlMs = options.ttlMs ?? 0;
        this.now = options.now ?? Date.now;
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
        if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
            throw new RangeError("maxEntries must be a positive integer");
        }
        if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) {
            throw new RangeError("ttlMs must be a non-negative number");
        }
    }

    /**
     * Find a row through the identity map.
     *
     * @param id - Primary-key value.
     * @returns The managed row, or `undefined`.
     */
    findById(id: TKey): TEntity | undefined {
        const cached: TEntity | undefined = this.read(id);
        if (cached !== (void 0)) {
            this.hits += 1;
            this.touch(id);
            return cached;
        }
        this.misses += 1;
        const loaded: TEntity | undefined = this.service.findById(id);
        if (loaded !== (void 0)) {
            this.put(id, loaded);
        }
        return loaded;
    }

    /**
     * Find a row or throw through the service.
     *
     * @param id - Primary-key value.
     * @param entityName - Optional label override.
     * @returns The managed row.
     * @throws EntityNotFoundError when the row is absent.
     */
    requireById(id: TKey, entityName?: string): TEntity {
        const cached: TEntity | undefined = this.read(id);
        if (cached !== (void 0)) {
            this.hits += 1;
            this.touch(id);
            return cached;
        }
        this.misses += 1;
        const loaded: TEntity = this.service.requireById(id, entityName);
        this.put(id, loaded);
        return loaded;
    }

    /**
     * Put a row into the identity map.
     *
     * @param id - Primary-key value.
     * @param entity - Managed row.
     */
    put(id: TKey, entity: TEntity): void {
        this.entries.delete(id);
        const expiresAt: number = this.ttlMs === 0 ? 0 : this.now() + this.ttlMs;
        this.entries.set(id, { value: entity, expiresAt });
        while (this.entries.size > this.maxEntries) {
            const keys: TKey[] = [...this.entries.keys()];
            const oldest: TKey | undefined = keys.length > 0 ? keys[0] : (void 0);
            if (oldest === (void 0)) {
                break;
            }
            this.entries.delete(oldest);
            this.evictions += 1;
        }
    }

    /**
     * Test whether a row is resident and unexpired.
     *
     * @param id - Primary-key value.
     * @returns `true` when the identity map contains the row.
     */
    contains(id: TKey): boolean {
        return this.read(id) !== (void 0);
    }

    /**
     * Remove one row from the identity map.
     *
     * @param id - Primary-key value.
     * @returns `true` when an entry was removed.
     */
    detach(id: TKey): boolean {
        return this.entries.delete(id);
    }

    /**
     * Remove every resident row.
     */
    clear(): void {
        this.entries.clear();
    }

    /**
     * Drop a row and load it again through the service.
     *
     * @param id - Primary-key value.
     * @returns The refreshed row, or `undefined`.
     */
    refresh(id: TKey): TEntity | undefined {
        this.detach(id);
        return this.findById(id);
    }

    /**
     * Number of resident rows.
     */
    get size(): number {
        this.compact();
        return this.entries.size;
    }

    /**
     * Read cache counters.
     *
     * @returns A snapshot of hits, misses, evictions and size.
     */
    stats(): StoreStats {
        this.compact();
        return {
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            size: this.entries.size,
        };
    }

    /**
     * Read an entry and remove it when expired.
     *
     * @param id - Primary-key value.
     * @returns The cached row, or `undefined`.
     */
    private read(id: TKey): TEntity | undefined {
        const entry: CacheEntry<TEntity> | undefined = this.entries.get(id);
        if (entry === (void 0)) {
            return (void 0);
        }
        if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
            this.entries.delete(id);
            this.evictions += 1;
            return (void 0);
        }
        return entry.value;
    }

    /**
     * Move a resident entry to the newest position.
     *
     * @param id - Primary-key value.
     */
    private touch(id: TKey): void {
        const entry: CacheEntry<TEntity> | undefined = this.entries.get(id);
        if (entry === (void 0)) {
            return;
        }
        this.entries.delete(id);
        this.entries.set(id, entry);
    }

    /**
     * Remove all expired entries.
     */
    private compact(): void {
        const keys: TKey[] = [...this.entries.keys()];
        for (let index: number = 0; index < keys.length; index += 1) {
            const id: TKey = keys[index];
            const entry: CacheEntry<TEntity> | undefined = this.entries.get(id);
            if (entry !== (void 0) && entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
                this.entries.delete(id);
                this.evictions += 1;
            }
        }
    }
}
