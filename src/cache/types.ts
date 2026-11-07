/** Write-through entity cache contracts. */

export interface EntityCacheOptions {
    readonly maxEntries: number;
    readonly ttlMilliseconds: number;
}

export interface CacheStats {
    readonly entries: number;
    readonly hits: number;
    readonly misses: number;
    readonly evictions: number;
    readonly expirations: number;
    readonly hitRate: number;
}

export interface EntityCache {
    get<T>(key: string, now: string): T | undefined;
    set<T>(key: string, value: T, now: string): void;
    has(key: string): boolean;
    delete(key: string): boolean;
    invalidate(predicate: (key: string) => boolean): number;
    clear(): void;
    stats(): CacheStats;
}
