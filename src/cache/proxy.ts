import { SynchronousOrderedLRUMap } from "semantic-typescript";
import { safeStringify } from "../serialization/index.ts";
import { validateCacheOptions } from "./entityCache.ts";
import type { CacheStats } from "./types.ts";

export interface CachingProxyOptions {
    readonly maxEntries?: number;
    readonly ttlMilliseconds?: number;
    readonly readMethods?: readonly string[];
    readonly writeMethods?: readonly string[];
    /** byArgs invalidates cached reads whose complete argument tuple matches the write. */
    readonly invalidation?: "all" | "byArgs";
    readonly now?: () => number;
    readonly serializeArguments?: (args: readonly unknown[]) => string;
}

export interface CacheProxyHandle<T extends object = object> {
    readonly proxy: T;
    stats(): CacheStats;
    clear(): void;
    invalidateAll(): void;
    invalidate(key: string): boolean;
}

const handles = new WeakMap<object, CacheProxyHandle>();
const READ_PREFIXES = ["get", "find", "list", "load", "read", "count"];
const WRITE_PREFIXES = ["put", "save", "update", "delete", "remove", "append", "write"];

/** Tagged tuples distinguish undefined/null, numeric edge cases and nested argument shapes. */
export function stableSerializeArguments(args: readonly unknown[]): string {
    const ancestors = new Set<object>();
    function encode(value: unknown): unknown {
        if (value === null) return ["null"];
        switch (typeof value) {
            case "undefined": return ["undefined"];
            case "string": return ["string", value];
            case "boolean": return ["boolean", value];
            case "bigint": return ["bigint", String(value)];
            case "number": return ["number", Object.is(value, -0) ? "-0" : String(value)];
            case "function": case "symbol": throw new TypeError("cache arguments require a custom serializer for functions or symbols");
        }
        if (ancestors.has(value)) throw new TypeError("cache arguments must not contain cycles");
        ancestors.add(value);
        try {
            if (Array.isArray(value)) return ["array", Array.from({ length: value.length }, (_, i) => i in value ? encode(value[i]) : ["hole"])];
            if (value instanceof Date) return ["date", value.toISOString()];
            if (value instanceof RegExp) return ["regexp", value.source, value.flags];
            if (value instanceof Map) return ["map", [...value].map(([key, item]) => [encode(key), encode(item)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
            if (value instanceof Set) return ["set", [...value].map(encode).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
                throw new TypeError("cache arguments require a custom serializer for class instances");
            }
            if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("cache arguments require a custom serializer for symbol properties");
            return ["object", Object.keys(value).sort().map(key => [key, encode((value as Record<string, unknown>)[key])])];
        } finally {
            ancestors.delete(value);
        }
    }
    // The tagged encoding above is already cycle-checked; serialize it through
    // the shared helper so every cache-key path uses one canonical encoder.
    return safeStringify(encode(args));
}

export function cacheKey(method: string, args: readonly unknown[], serialize = stableSerializeArguments): string {
    return safeStringify([method, serialize(args)]);
}

function matches(method: string, configured: readonly string[] | undefined, prefixes: readonly string[]): boolean {
    if (configured !== undefined) return configured.includes(method);
    return prefixes.some(prefix => method === prefix || (method.startsWith(prefix) && /^[A-Z_]/.test(method.slice(prefix.length))));
}

interface ProxyEntry {
    readonly value: unknown;
    readonly args: string;
    readonly expiresAt: number;
}

/** Create a service Proxy and a separate management handle; no business methods are added. */
export function createCacheProxyHandle<T extends object>(service: T, options: CachingProxyOptions = {}): CacheProxyHandle<T> {
    if ((typeof service !== "object" && typeof service !== "function") || service === null) throw new TypeError("service must be an object");
    const settings = { maxEntries: options.maxEntries ?? 1024, ttlMilliseconds: options.ttlMilliseconds ?? 60_000 };
    validateCacheOptions(settings);
    if (options.invalidation !== undefined && options.invalidation !== "all" && options.invalidation !== "byArgs") throw new TypeError("unknown cache invalidation policy");
    const now = options.now ?? Date.now;
    const serialize = options.serializeArguments ?? stableSerializeArguments;
    const entries = new SynchronousOrderedLRUMap<string, ProxyEntry>(undefined, { capacity: BigInt(settings.maxEntries) });
    const methods = new Map<PropertyKey, { original: Function; bound: Function }>();
    let hits = 0;
    let misses = 0;
    let evictions = 0;
    let expirations = 0;

    function clock(): number {
        const time = now();
        if (!Number.isFinite(time)) throw new TypeError("cache clock must return finite milliseconds");
        return time;
    }
    function expire(time: number): void {
        const keys: string[] = [];
        entries.forEach((key, entry) => { if (time >= entry.expiresAt) keys.push(key); });
        for (const key of keys) { entries.remove(key); expirations++; }
    }
    function invalidateWrite(args: readonly unknown[]): void {
        if (options.invalidation !== "byArgs") { entries.clear(); return; }
        const signature = serialize(args);
        const keys: string[] = [];
        entries.forEach((key, entry) => { if (entry.args === signature) keys.push(key); });
        for (const key of keys) entries.remove(key);
    }
    const proxy = new Proxy(service, {
        get(target, property) {
            const original = Reflect.get(target, property, target);
            if (typeof original !== "function") return original;
            const previous = methods.get(property);
            if (previous?.original === original) return previous.bound;
            const method = typeof property === "string" ? property : "";
            const read = matches(method, options.readMethods, READ_PREFIXES);
            const write = matches(method, options.writeMethods, WRITE_PREFIXES);
            const bound = (...args: unknown[]): unknown => {
                if (!read && !write) return Reflect.apply(original, service, args);
                if (write) {
                    const result: unknown = Reflect.apply(original, service, args);
                    if (result instanceof Promise) return result.then(value => { invalidateWrite(args); return value; });
                    invalidateWrite(args);
                    return result;
                }
                const time = clock();
                expire(time);
                const signature = serialize(args);
                const key = safeStringify([method, signature]);
                const found = entries.get(key);
                if (found.isPresent()) { hits++; return found.get().value; }
                misses++;
                const result: unknown = Reflect.apply(original, service, args);
                const entry: ProxyEntry = { value: result, args: signature, expiresAt: time + settings.ttlMilliseconds };
                if (entries.size() >= BigInt(settings.maxEntries)) evictions++;
                entries.put(key, entry);
                if (result instanceof Promise) {
                    // Do not retain a failed read, or remove a newer entry created after invalidation.
                    void result.catch(() => {
                        const current = entries.get(key);
                        if (current.isPresent() && current.get() === entry) entries.remove(key);
                    });
                }
                return result;
            };
            methods.set(property, { original, bound });
            return bound;
        },
        set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    const handle: CacheProxyHandle<T> = Object.freeze({
        proxy,
        stats(): CacheStats {
            expire(clock());
            return Object.freeze({ entries: Number(entries.size()), hits, misses, evictions, expirations, hitRate: hits + misses === 0 ? 0 : hits / (hits + misses) });
        },
        clear: () => entries.clear(),
        invalidateAll: () => entries.clear(),
        invalidate: (key: string) => entries.remove(key).isPresent(),
    });
    handles.set(proxy, handle);
    return handle;
}

/** Returns the actual business Proxy. Use getCacheProxyHandle for management. */
export function createCachingProxy<T extends object>(service: T, options: CachingProxyOptions = {}): T {
    return createCacheProxyHandle(service, options).proxy;
}

export function getCacheProxyHandle<T extends object>(proxy: T): CacheProxyHandle<T> {
    const handle = handles.get(proxy);
    if (handle === undefined) throw new TypeError("object is not a caching proxy");
    return handle as CacheProxyHandle<T>;
}
