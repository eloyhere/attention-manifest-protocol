import test from "node:test";
import assert from "node:assert/strict";
import { cacheKey, createCachingProxy, createCacheProxyHandle, getCacheProxyHandle, createEntityCache, stableSerializeArguments } from "./index.ts";

function fixture(options: Parameters<typeof createCacheProxyHandle>[1] = {}) {
    let calls = 0;
    const service = {
        marker: "original",
        get(id: unknown) { calls++; return { id, marker: this.marker, calls }; },
        findById(id: unknown) { return this.get(id); },
        list() { return [this.get("all")]; },
        save(id: unknown) { return { id, marker: this.marker }; },
        custom() { return { marker: this.marker }; },
    };
    const handle = createCacheProxyHandle(service, options);
    return { service, handle, proxy: handle.proxy, calls: () => calls };
}

test("Proxy caches hits/misses and returns stable object identity", () => {
    const { proxy, handle, calls } = fixture();
    const first = proxy.get("a");
    assert.strictEqual(proxy.get("a"), first);
    assert.equal(calls(), 1);
    assert.deepEqual(handle.stats(), { entries: 1, hits: 1, misses: 1, evictions: 0, expirations: 0, hitRate: 0.5 });
    assert.equal("stats" in proxy, false);
    assert.equal("invalidateAll" in proxy, false);
});

test("createCachingProxy returns the business Proxy with separate management", () => {
    const service = { get() { return {}; } };
    const proxy = createCachingProxy(service);
    assert.notStrictEqual(proxy, service);
    assert.strictEqual(proxy.get(), proxy.get());
    assert.strictEqual(getCacheProxyHandle(proxy).proxy, proxy);
    assert.throws(() => getCacheProxyHandle(service), /not a caching proxy/);
});

test("method name and stable sorted arguments isolate keys", () => {
    const { proxy, handle } = fixture();
    assert.strictEqual(proxy.get({ a: 1, b: 2 }), proxy.get({ b: 2, a: 1 }));
    assert.notStrictEqual(proxy.get("1"), proxy.get(1));
    assert.notStrictEqual(proxy.get("a"), proxy.findById("a"));
    assert.equal(handle.stats().entries, 5);
    assert.notEqual(cacheKey("get", []), cacheKey("get", [undefined]));
    assert.notEqual(cacheKey("get", [null]), cacheKey("get", [undefined]));
    assert.notEqual(cacheKey("get", [-0]), cacheKey("get", [0]));
});

test("successful writes invalidate all reads by default", () => {
    const { proxy, handle } = fixture();
    const a = proxy.get("a");
    const b = proxy.get("b");
    proxy.save("a");
    assert.equal(handle.stats().entries, 0);
    assert.notStrictEqual(proxy.get("a"), a);
    assert.notStrictEqual(proxy.get("b"), b);
});

test("byArgs writes only invalidate matching argument tuples", () => {
    const { proxy } = fixture({ invalidation: "byArgs" });
    const a = proxy.get("a");
    const b = proxy.get("b");
    proxy.save("a");
    assert.notStrictEqual(proxy.get("a"), a);
    assert.strictEqual(proxy.get("b"), b);
});

test("TTL expires on the exact boundary using the supplied clock", () => {
    let time = 0;
    const { proxy, handle } = fixture({ ttlMilliseconds: 10, now: () => time });
    const first = proxy.get("a");
    time = 9;
    assert.strictEqual(proxy.get("a"), first);
    time = 10;
    assert.notStrictEqual(proxy.get("a"), first);
    assert.equal(handle.stats().expirations, 1);
    time = 20;
    assert.equal(handle.stats().entries, 0);
    assert.equal(handle.stats().expirations, 2);
});

test("library LRU evicts the least recently read entry", () => {
    const { proxy, handle } = fixture({ maxEntries: 2 });
    const a = proxy.get("a");
    const b = proxy.get("b");
    assert.strictEqual(proxy.get("a"), a);
    proxy.get("c");
    assert.strictEqual(proxy.get("a"), a);
    assert.notStrictEqual(proxy.get("b"), b);
    assert.equal(handle.stats().entries, 2);
    assert.equal(handle.stats().evictions, 2);
});

test("clear, invalidate and invalidateAll operate through the management handle", () => {
    const { proxy, handle } = fixture();
    const a = proxy.get("a");
    const b = proxy.get("b");
    assert.equal(handle.invalidate(cacheKey("get", ["a"])), true);
    assert.equal(handle.invalidate("missing"), false);
    assert.notStrictEqual(proxy.get("a"), a);
    assert.strictEqual(proxy.get("b"), b);
    handle.clear();
    assert.equal(handle.stats().entries, 0);
    proxy.get("a");
    handle.invalidateAll();
    assert.equal(handle.stats().entries, 0);
    assert.equal(handle.stats().misses, 4);
});

test("unknown methods pass through and all calls bind this to original service", () => {
    class Service {
        #value = 42;
        calls = 0;
        getValue() { this.calls++; return { value: this.#value }; }
        custom() { return { value: this.#value }; }
        saveValue() { this.#value++; }
        get value() { return this.#value; }
    }
    const service = new Service();
    const proxy = createCachingProxy(service);
    const detached = proxy.getValue;
    assert.equal(detached().value, 42);
    assert.equal(proxy.value, 42);
    assert.notStrictEqual(proxy.custom(), proxy.custom());
    assert.equal(service.calls, 1);
    proxy.saveValue();
    assert.equal(proxy.getValue().value, 43);
    assert.strictEqual(proxy.getValue, proxy.getValue);
});

test("all default read and write method prefixes are recognized", () => {
    for (const method of ["get", "find", "list", "load", "read", "count"]) {
        const proxy = createCachingProxy({ [method]: () => ({}) });
        assert.strictEqual(proxy[method](), proxy[method]());
    }
    for (const method of ["put", "save", "update", "delete", "remove", "append", "write"]) {
        const proxy = createCachingProxy({ get: () => ({}), [method]: () => undefined });
        const first = proxy.get();
        proxy[method]();
        assert.notStrictEqual(proxy.get(), first);
    }
});

test("configured method names override defaults", () => {
    const proxy = createCachingProxy({ lookup: () => ({}), get: () => ({}), commit: () => 1 }, { readMethods: ["lookup"], writeMethods: ["commit"] });
    const first = proxy.lookup();
    assert.strictEqual(proxy.lookup(), first);
    assert.notStrictEqual(proxy.get(), proxy.get());
    proxy.commit();
    assert.notStrictEqual(proxy.lookup(), first);
});

test("async reads coalesce with identical Promise and resolved object identity", async () => {
    let calls = 0;
    const proxy = createCachingProxy({ async load(id: string) { calls++; return { id }; } });
    const first = proxy.load("a");
    const second = proxy.load("a");
    assert.strictEqual(first, second);
    assert.strictEqual(await first, await second);
    assert.strictEqual(await proxy.load("a"), await first);
    assert.equal(calls, 1);
});

test("async writes invalidate only after success and failures retain reads", async () => {
    let release!: () => void;
    const handle = createCacheProxyHandle({
        get: () => ({}),
        save: () => new Promise<void>(resolve => { release = resolve; }),
        update: async () => { throw new Error("failed"); },
        remove: () => { throw new Error("failed"); },
    });
    const first = handle.proxy.get();
    const saving = handle.proxy.save();
    assert.strictEqual(handle.proxy.get(), first);
    release();
    await saving;
    assert.notStrictEqual(handle.proxy.get(), first);
    const second = handle.proxy.get();
    await assert.rejects(handle.proxy.update(), /failed/);
    assert.throws(() => handle.proxy.remove(), /failed/);
    assert.strictEqual(handle.proxy.get(), second);
});

test("failed async reads are removed without deleting newer replacement entries", async () => {
    let reject!: (reason: Error) => void;
    let calls = 0;
    const handle = createCacheProxyHandle({ load() { calls++; return calls === 1 ? new Promise<object>((_, fail) => { reject = fail; }) : Promise.resolve({}); } });
    const failing = handle.proxy.load();
    handle.clear();
    const replacement = handle.proxy.load();
    reject(new Error("failed"));
    await assert.rejects(failing, /failed/);
    assert.strictEqual(handle.proxy.load(), replacement);
    assert.equal(calls, 2);
});

test("serialization handles supported rich values and rejects ambiguous inputs", () => {
    assert.equal(stableSerializeArguments([new Map([["b", 2], ["a", 1]]), new Set([2, 1])]), stableSerializeArguments([new Map([["a", 1], ["b", 2]]), new Set([1, 2])]));
    assert.notEqual(stableSerializeArguments([1n]), stableSerializeArguments([1]));
    assert.notEqual(stableSerializeArguments([new Date(0)]), stableSerializeArguments([new Date(1)]));
    const cycle: unknown[] = []; cycle.push(cycle);
    assert.throws(() => stableSerializeArguments(cycle), /cycles/);
    assert.throws(() => stableSerializeArguments([() => 1]), /custom serializer/);
});

test("entity cache preserves references and reports hits misses TTL and LRU", () => {
    const cache = createEntityCache({ maxEntries: 2, ttlMilliseconds: 10 });
    const a = {};
    const b = {};
    cache.set("a", a, "2026-01-01T00:00:00.000Z");
    cache.set("b", b, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(cache.get("a", "2026-01-01T00:00:00.001Z"), a);
    cache.set("c", {}, "2026-01-01T00:00:00.001Z");
    assert.equal(cache.get("b", "2026-01-01T00:00:00.001Z"), undefined);
    assert.equal(cache.get("a", "2026-01-01T00:00:00.010Z"), undefined);
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.stats().misses, 2);
    assert.equal(cache.stats().evictions, 1);
    assert.equal(cache.stats().expirations, 1);
});

test("entity cache retains its frozen contract operations", () => {
    const cache = createEntityCache();
    const now = "2026-01-01T00:00:00Z";
    cache.set("a", {}, now); cache.set("b", {}, now);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.delete("a"), true);
    assert.equal(cache.delete("a"), false);
    assert.equal(cache.invalidate(key => key === "b"), 1);
    cache.set("a", {}, now);
    cache.clear();
    assert.equal(cache.stats().entries, 0);
    assert.throws(() => cache.get("x", "invalid"), /timestamp/);
});

test("invalid capacity TTL and clocks fail early", () => {
    for (const maxEntries of [0, -1, 0.5, NaN]) assert.throws(() => createEntityCache({ maxEntries }), /maxEntries/);
    assert.throws(() => createCacheProxyHandle({}, { ttlMilliseconds: -1 }), /ttlMilliseconds/);
    assert.throws(() => createCacheProxyHandle({ get: () => 1 }, { now: () => NaN }).proxy.get(), /clock/);
});
