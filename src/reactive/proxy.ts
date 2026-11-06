import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet } from "semantic-typescript";

export interface ProxyHooks<T extends object> {
    beforeGet?: (target: T, key: PropertyKey) => void;
    afterGet?: (target: T, key: PropertyKey, value: unknown) => void;
}
/** Read-only observable projection. The caller owns authorization and source facts. */
export function useProxy<T extends object>(target: T, hooks: ProxyHooks<T> = {}): Readonly<T> {
    return new Proxy(target, {
        get(value, key, receiver) {
            Optional.ofNullable(hooks.beforeGet).ifPresent(hook => hook(value, key));
            const result: unknown = Reflect.get(value, key, receiver);
            Optional.ofNullable(hooks.afterGet).ifPresent(hook => hook(value, key, result));
            return result;
        },
        set() { throw new TypeError("Proxy projection is read-only"); },
        defineProperty() { throw new TypeError("Proxy projection is read-only"); },
        deleteProperty() { throw new TypeError("Proxy projection is read-only"); },
        setPrototypeOf() { throw new TypeError("Proxy projection is read-only"); },
        preventExtensions() { throw new TypeError("Proxy projection cannot be frozen"); },
    });
}
export interface LazyProxyOptions<T extends object, K extends keyof T> {
    load: { [P in K]: () => T[P] };
    /** Runs on every property read, even when a lazy value is cached. */
    assertCurrent?: () => void;
    onLoad?: (key: K) => void;
    /** Per-property access policy; also applied to extracted lazy descriptor getters. */
    beforeGet?: (key: PropertyKey) => void;
}
export interface LazyProxy<T extends object> {
    readonly value: Readonly<T>;
    invalidate(key?: keyof T): void;
    isLoaded(key: keyof T): boolean;
}
/** Synchronous loaders. Enumeration/has/descriptors do not invoke them. */
export function useLazyProxy<T extends object, K extends keyof T>(initial: Omit<T, K>, options: LazyProxyOptions<T, K>): LazyProxy<T> {
    const cache = new SynchronousUnorderedMap<PropertyKey, { value: unknown }>();
    const loading = new SynchronousUnorderedSet<PropertyKey>();
    const load = { ...options.load };
    const assertCurrent = Optional.ofNullable(options.assertCurrent);
    const onLoad = Optional.ofNullable(options.onLoad);
    const beforeGet = Optional.ofNullable(options.beforeGet);
    const guard = (key: PropertyKey): void => {
        assertCurrent.ifPresent(check => check());
        beforeGet.ifPresent(check => check(key));
    };
    const target = { ...initial } as T;
    for (const key of Reflect.ownKeys(load)) {
        if (Reflect.has(target, key)) { throw new TypeError(`Lazy key duplicates eager field: ${String(key)}`); }
        Object.defineProperty(target, key, { enumerable: true, configurable: true, get: () => {
            guard(key);
            const cached = cache.get(key);
            if (cached.isPresent()) { return cached.get().value; }
            if (loading.contains(key)) { throw new Error(`Recursive lazy load: ${String(key)}`); }
            loading.add(key);
            try {
                const loader = Reflect.get(load, key) as () => unknown;
                const value = loader();
                guard(key);
                onLoad.ifPresent(hook => hook(key as K));
                cache.put(key, { value });
                return value;
            } finally { loading.remove(key); }
        } });
    }
    return {
        value: useProxy(target, { beforeGet: (_target, key) => {
            // Lazy accessors guard themselves, including when extracted with Reflect.
            if (!Object.prototype.hasOwnProperty.call(load, key)) { guard(key); }
        } }),
        invalidate(key?: keyof T): void {
            const selected = Optional.ofNullable(key);
            if (selected.isPresent()) { cache.remove(selected.get()); }
            else { cache.clear(); }
        },
        isLoaded: key => cache.containsKey(key),
    };
}
