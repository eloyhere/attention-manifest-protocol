import type { EntityCache } from './types.ts';
import { safeStringify } from '../serialization/index.ts';

export interface ServiceProxyOptions {
    readonly namespace?: string;
    /** Explicit lists replace inference for their respective method category. */
    readonly readMethods?: readonly PropertyKey[];
    readonly writeMethods?: readonly PropertyKey[];
    readonly now?: () => string;
}

export interface ServiceProxyStats {
    readonly hits: number;
    readonly misses: number;
    readonly writes: number;
    readonly invalidations: number;
    readonly hitRate: number;
}

interface MutableStats { hits: number; misses: number; writes: number; invalidations: number }
const proxyStats = new WeakMap<object, MutableStats>();
let nextNamespace = 0;
const epochs = new WeakMap<EntityCache, Map<string, number>>();
function namespaceEpochs(cache: EntityCache): Map<string, number> {
    let values = epochs.get(cache);
    if (!values) { values = new Map(); epochs.set(cache, values); }
    return values;
}
function invalidateNamespace(cache: EntityCache, namespace: string): number {
    const values = namespaceEpochs(cache);
    values.set(namespace, (values.get(namespace) ?? 0) + 1);
    return cache.invalidate(key => key.startsWith(namespace));
}

/** Snapshots are independent of the backing cache's aggregate statistics. */
export function getServiceProxyStats(proxy: object): ServiceProxyStats | undefined {
    const stats = proxyStats.get(proxy);
    return stats && { ...stats, hitRate: stats.hits / (stats.hits + stats.misses || 1) };
}

function prefix(namespace: string): string {
    return `service:${safeStringify(namespace)}:`;
}

/** Deliberately bypass unsupported arguments rather than risk a false cache hit. */
function stableArgs(value: unknown, ancestors = new Set<object>()): string {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'undefined': return 'undefined';
        case 'string': return `string:${safeStringify(value)}`;
        case 'boolean': return `boolean:${value}`;
        case 'bigint': return `bigint:${value}`;
        case 'number': return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
        case 'object': break;
        default: throw new TypeError('Unsupported cache argument');
    }
    if (ancestors.has(value)) throw new TypeError('Cyclic cache argument');
    ancestors.add(value);
    try {
        if (value instanceof Date) return `date:${value.toISOString()}`;
        if (Array.isArray(value)) {
            const parts: string[] = [];
            for (let i = 0; i < value.length; i++) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
                if (descriptor && !('value' in descriptor)) throw new TypeError('Accessor argument');
                parts.push(descriptor ? stableArgs(descriptor.value, ancestors) : 'hole');
            }
            if (Reflect.ownKeys(value).length !== Object.keys(value).length + 1) {
                throw new TypeError('Unsupported array properties');
            }
            if (Object.keys(value).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
                throw new TypeError('Unsupported array properties');
            }
            return `array:[${parts.join(',')}]`;
        }
        const prototype: unknown = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Unsupported cache argument');
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key === 'symbol')) throw new TypeError('Symbol argument');
        return `${prototype === null ? 'null-object' : 'object'}:{${(keys as string[]).sort().map(key => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!('value' in descriptor)) throw new TypeError('Accessor argument');
            return `${safeStringify(key)}:${stableArgs(descriptor.value, ancestors)}`;
        }).join(',')}}`;
    } finally {
        ancestors.delete(value);
    }
}

function inferredRead(key: PropertyKey): boolean {
    return typeof key === 'string' && /^(get|find|list|read|query|search|fetch|has|count|load|lookup)(?:$|[A-Z_])/.test(key);
}
function inferredWrite(key: PropertyKey): boolean {
    return typeof key === 'string' && /^(set|create|update|delete|remove|add|put|save|insert|upsert|write|clear|append|patch|register)(?:$|[A-Z_])/.test(key);
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function';
}

/** Cache service results; this layer does not manage entity identities. */
export function createServiceProxy<T extends object>(service: T, cache: EntityCache, options: ServiceProxyOptions = {}): T {
    const namespace = prefix(options.namespace ?? `anonymous-${++nextNamespace}`);
    const now = options.now ?? (() => new Date().toISOString());
    const reads = options.readMethods && new Set(options.readMethods);
    const writes = options.writeMethods && new Set(options.writeMethods);
    const stats: MutableStats = { hits: 0, misses: 0, writes: 0, invalidations: 0 };
    const methods = new Map<PropertyKey, { original: Function; wrapped: Function }>();
    const values = namespaceEpochs(cache);
    const invalidate = (): void => {
        stats.writes++;
        stats.invalidations += invalidateNamespace(cache, namespace);
    };
    const proxy = new Proxy(service, {
        get(target, key) {
            const value: unknown = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            // ECMAScript requires exact values for frozen own data properties.
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (descriptor && !descriptor.configurable && 'value' in descriptor && !descriptor.writable) return value;
            const previous = methods.get(key);
            if (previous?.original === value) return previous.wrapped;
            const write = writes ? writes.has(key) : inferredWrite(key);
            const read = !write && (reads ? reads.has(key) : inferredRead(key));
            const wrapped = (...args: unknown[]): unknown => {
                if (write) {
                    const result: unknown = Reflect.apply(value, target, args);
                    if (isPromiseLike(result)) return Promise.resolve(result).then(output => { invalidate(); return output; });
                    invalidate();
                    return result;
                }
                if (!read || typeof key === 'symbol') return Reflect.apply(value, target, args);
                let cacheKey: string;
                try { cacheKey = namespace + safeStringify(key) + ':' + stableArgs(args); }
                catch { return Reflect.apply(value, target, args); }
                const entry = cache.get<{ value: unknown }>(cacheKey, now());
                if (entry !== undefined) { stats.hits++; return entry.value; }
                stats.misses++;
                const started = values.get(namespace);
                const result: unknown = Reflect.apply(value, target, args);
                if (isPromiseLike(result)) {
                    // Do not cache failures or repopulate a namespace after a write.
                    const pending = Promise.resolve(result).then(output => {
                        if (values.get(namespace) === started) cache.set(cacheKey, { value: pending }, now());
                        return output;
                    });
                    return pending;
                }
                if (values.get(namespace) === started) cache.set(cacheKey, { value: result }, now());
                return result;
            };
            methods.set(key, { original: value, wrapped });
            return wrapped;
        },
    });
    proxyStats.set(proxy, stats);
    return proxy;
}

export class ServiceRegistry {
    private readonly cache: EntityCache;
    private readonly services = new Map<string, object>();

    constructor(cache: EntityCache) { this.cache = cache; }

    register<T extends object>(name: string, service: T, options: ServiceProxyOptions = {}): T {
        if (this.services.has(name)) throw new Error(`Service already registered: ${name}`);
        // Names exclusively own their namespaces, regardless of caller options.
        const proxy = createServiceProxy(service, this.cache, { ...options, namespace: name });
        this.services.set(name, proxy);
        return proxy;
    }

    get<T extends object = object>(name: string): T | undefined {
        return this.services.get(name) as T | undefined;
    }

    remove(name: string): boolean {
        if (!this.services.delete(name)) return false;
        invalidateNamespace(this.cache, prefix(name));
        return true;
    }

    list(): string[] { return [...this.services.keys()]; }
}

const registries = new WeakMap<EntityCache, ServiceRegistry>();

/** Automatically register services in a registry scoped to the supplied cache. */
export function registerService<T extends object>(cache: EntityCache, name: string, service: T, options?: ServiceProxyOptions): T {
    let registry = registries.get(cache);
    if (!registry) { registry = new ServiceRegistry(cache); registries.set(cache, registry); }
    return registry.register(name, service, options);
}
