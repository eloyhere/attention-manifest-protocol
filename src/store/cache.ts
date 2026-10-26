/**
 * Proxy cache over a service loader.
 *
 * `store` is the read-through cache between callers and `database/service`.
 * Property access on `cache.entities` triggers a load; repeated access hits the
 * `LRUUnorderedMap` until the TTL expires. The cache is bounded, so a long
 * session cannot grow it without limit.
 *
 * It is deliberately not reactive (no Pinia/Vue): the kernel is a Node process,
 * and a Proxy plus an LRU is enough for lazy loading and invalidation.
 */
import { LRUUnorderedMap } from "../structure/lru.ts";
import { UnorderedMap } from "../structure/unordered.ts";

export interface EntityCacheOptions<T> {
    load: (key: string) => T | undefined;
    keyOf: (value: T) => string;
    capacity?: number;
    ttlMs?: number;
    now?: () => number;
}

export interface CacheStats {
    loads: number;
    hits: number;
    misses: number;
    evictions: number;
    size: number;
    capacity: number;
}

export class EntityCache<T> {
    readonly capacity: number;
    readonly ttlMs: number;
    private readonly lru: LRUUnorderedMap<string, T>;
    private readonly loadedAt: UnorderedMap<string, number>;
    private readonly proxy: Record<string, T>;
    private readonly load: (key: string) => T | undefined;
    private readonly keyOf: (value: T) => string;
    private readonly now: () => number;
    private loads: number = 0;
    private hits: number = 0;
    private misses: number = 0;
    private evictions: number = 0;

    constructor(options: EntityCacheOptions<T>) {
        this.capacity = options.capacity ?? 256;
        this.ttlMs = options.ttlMs ?? 2000;
        this.lru = new LRUUnorderedMap<string, T>(this.capacity);
        this.loadedAt = new UnorderedMap<string, number>();
        this.load = options.load;
        this.keyOf = options.keyOf;
        this.now = options.now ?? (() => Date.now());
        this.proxy = new Proxy({} as Record<string, T>, {
            get: (_target, property) => {
                if (typeof(property) !== "string") return undefined;
                if (property === "toJSON") return undefined;
                return this.get(property);
            },
            set: (_target, property, value: T) => {
                if (typeof(property) !== "string") return false;
                this.evictIfNeeded();
                this.lru.set(property, value);
                this.loadedAt.set(property, this.now());
                return true;
            },
            deleteProperty: (_target, property) => {
                if (typeof(property) === "string") this.invalidate(property);
                return true;
            },
            has: (_target, property) => typeof(property) === "string" && this.lru.has(property),
            ownKeys: () => [...this.lru.keys()],
            getOwnPropertyDescriptor: (_target, property) => {
                if (typeof(property) !== "string") return undefined;
                const value: T | undefined = this.peek(property);
                if (value === undefined) return undefined;
                return { enumerable: true, configurable: true, value };
            },
        });
    }

    /** Read through the cache; a miss calls the service loader. */
    get(id: string | number): T | undefined {
        const key: string = `${id}`;
        const cached: T | undefined = this.lru.get(key);
        if (cached !== undefined) {
            const at: number = this.loadedAt.get(key) ?? 0;
            if (this.now() - at <= this.ttlMs) {
                this.hits += 1;
                return cached;
            }
            this.lru.delete(key);
            this.loadedAt.delete(key);
        }

        const loaded: T | undefined = this.load(key);
        this.misses += 1;
        if (loaded === undefined) return undefined;
        this.evictIfNeeded();
        this.lru.set(key, loaded);
        this.loadedAt.set(key, this.now());
        this.loads += 1;
        return loaded;
    }

    /** Look at a cached value without loading or extending its TTL. */
    peek(id: string | number): T | undefined {
        return this.lru.get(`${id}`);
    }

    put(value: T): void {
        const key: string = this.keyOf(value);
        this.evictIfNeeded();
        this.lru.set(key, value);
        this.loadedAt.set(key, this.now());
    }

    invalidate(id?: string | number): void {
        if (id === undefined) {
            this.lru.clear();
            this.loadedAt.clear();
            return;
        }
        const key: string = `${id}`;
        this.lru.delete(key);
        this.loadedAt.delete(key);
    }

    entries(): T[] {
        return [...this.lru.values()];
    }

    get size(): number {
        return this.lru.size;
    }

    stats(): CacheStats {
        return {
            loads: this.loads,
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            size: this.lru.size,
            capacity: this.capacity,
        };
    }

    /** The Proxy view: `cache.entities["42"]` reads through to the service. */
    get entities(): Record<string, T> {
        return this.proxy;
    }

    private evictIfNeeded(): void {
        while (this.lru.size >= this.capacity) {
            const victim: [string, T] | undefined = this.lru.leastRecentlyUsed();
            if (victim === undefined) return;
            this.lru.delete(victim[0]);
            this.loadedAt.delete(victim[0]);
            this.evictions += 1;
        }
    }
}
