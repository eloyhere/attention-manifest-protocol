import { SynchronousOrderedLRUMap } from "semantic-typescript";
import type { CacheStats, EntityCache, EntityCacheOptions } from "./types.ts";

interface Entry {
    readonly value: unknown;
    readonly expiresAt: number;
}

export function validateCacheOptions(options: EntityCacheOptions): void {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1) {
        throw new RangeError("maxEntries must be a positive safe integer");
    }
    if (!Number.isFinite(options.ttlMilliseconds) || options.ttlMilliseconds < 0) {
        throw new RangeError("ttlMilliseconds must be a non-negative finite number");
    }
}

function timestamp(now: string): number {
    const result = Date.parse(now);
    if (!Number.isFinite(result)) throw new TypeError("cache now must be a valid timestamp");
    return result;
}

/** Reference-preserving entity cache; recency and capacity belong to the library LRU. */
export function createEntityCache(options: Partial<EntityCacheOptions> = {}): EntityCache {
    const settings = { maxEntries: options.maxEntries ?? 1024, ttlMilliseconds: options.ttlMilliseconds ?? 60_000 };
    validateCacheOptions(settings);
    const entries = new SynchronousOrderedLRUMap<string, Entry>(undefined, { capacity: BigInt(settings.maxEntries) });
    let hits = 0;
    let misses = 0;
    let evictions = 0;
    let expirations = 0;

    return {
        get<T>(key: string, now: string): T | undefined {
            const time = timestamp(now);
            const entry = entries.get(key);
            if (entry.isEmpty()) { misses++; return undefined; }
            if (time >= entry.get().expiresAt) {
                entries.remove(key);
                expirations++;
                misses++;
                return undefined;
            }
            hits++;
            return entry.get().value as T;
        },
        set<T>(key: string, value: T, now: string): void {
            const time = timestamp(now);
            const expired: string[] = [];
            entries.forEach((entryKey, entry) => { if (time >= entry.expiresAt) expired.push(entryKey); });
            for (const expiredKey of expired) { entries.remove(expiredKey); expirations++; }
            if (!entries.containsKey(key) && entries.size() >= BigInt(settings.maxEntries)) evictions++;
            entries.put(key, { value, expiresAt: time + settings.ttlMilliseconds });
        },
        has: key => entries.containsKey(key),
        delete: key => entries.remove(key).isPresent(),
        invalidate(predicate): number {
            const keys: string[] = [];
            entries.forEach(key => { if (predicate(key)) keys.push(key); });
            for (const key of keys) entries.remove(key);
            return keys.length;
        },
        clear: () => entries.clear(),
        stats(): CacheStats {
            return Object.freeze({ entries: Number(entries.size()), hits, misses, evictions, expirations, hitRate: hits + misses === 0 ? 0 : hits / (hits + misses) });
        },
    };
}
