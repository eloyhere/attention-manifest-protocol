import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CacheStats, EntityCache } from './types.ts';
import { createServiceProxy, getServiceProxyStats, registerService, ServiceRegistry } from './serviceProxy.ts';

class TestCache implements EntityCache {
    readonly entries = new Map<string, unknown>();
    hits = 0;
    misses = 0;
    get<T>(key: string, _now: string): T | undefined {
        if (this.entries.has(key)) { this.hits++; return this.entries.get(key) as T; }
        this.misses++;
        return undefined;
    }
    set<T>(key: string, value: T, _now: string): void { this.entries.set(key, value); }
    has(key: string): boolean { return this.entries.has(key); }
    delete(key: string): boolean { return this.entries.delete(key); }
    invalidate(predicate: (key: string) => boolean): number {
        let count = 0;
        for (const key of this.entries.keys()) if (predicate(key)) { this.entries.delete(key); count++; }
        return count;
    }
    clear(): void { this.entries.clear(); }
    stats(): CacheStats {
        return { entries: this.entries.size, hits: this.hits, misses: this.misses, evictions: 0, expirations: 0, hitRate: this.hits / (this.hits + this.misses || 1) };
    }
}

function fixture() {
    let calls = 0;
    const service = {
        label: 'service',
        get(input: unknown) { calls++; return { input, calls }; },
        update() { return 'updated'; },
        explain() { return this.label; },
    };
    const cache = new TestCache();
    return { cache, service, proxy: createServiceProxy(service, cache), calls: () => calls };
}

test('read misses then hits; stable object arguments preserve result identity', () => {
    const { proxy, calls } = fixture();
    const first = proxy.get({ a: 1, b: 2 });
    assert.strictEqual(proxy.get({ b: 2, a: 1 }), first);
    assert.notStrictEqual(proxy.get({ a: 2, b: 2 }), first);
    assert.equal(calls(), 2);
});

test('successful writes invalidate cached reads', () => {
    const { proxy } = fixture();
    const first = proxy.get(1);
    assert.equal(proxy.update(), 'updated');
    assert.notStrictEqual(proxy.get(1), first);
});

test('unknown properties pass through and methods retain their receiver', () => {
    const { service, proxy } = fixture();
    assert.equal(proxy.label, service.label);
    assert.equal(proxy.explain(), 'service');
    assert.equal(proxy.explain, proxy.explain);
    assert.equal(Reflect.get(proxy, 'absent'), undefined);
    proxy.label = 'changed';
    assert.equal(service.label, 'changed');
});

test('registry registers wrapped services, gets them and rejects duplicates', () => {
    const { service, cache } = fixture();
    const registry = new ServiceRegistry(cache);
    const proxy = registry.register('users', service);
    assert.notStrictEqual(proxy, service);
    assert.strictEqual(registry.get('users'), proxy);
    assert.deepEqual(registry.list(), ['users']);
    assert.throws(() => registry.register('users', service), /already registered/);
});

test('registry removal invalidates only the exact namespace and allows replacement', () => {
    const cache = new TestCache();
    const registry = new ServiceRegistry(cache);
    const one = registry.register('a', { get: () => ({}) });
    const two = registry.register('a:child', { get: () => ({}) });
    const old = one.get();
    const other = two.get();
    assert.equal(registry.remove('a'), true);
    assert.equal(registry.remove('a'), false);
    assert.equal(registry.get('a'), undefined);
    assert.deepEqual(registry.list(), ['a:child']);
    assert.strictEqual(two.get(), other);
    const replacement = registry.register('a', { get: () => ({}) });
    assert.notStrictEqual(replacement.get(), old);
});

test('write invalidation leaves another service namespace and foreign entries intact', () => {
    const cache = new TestCache();
    cache.set('foreign', 42, '');
    const a = createServiceProxy({ get: () => ({}), update() {} }, cache, { namespace: 'a' });
    const b = createServiceProxy({ get: () => ({}) }, cache, { namespace: 'b' });
    a.get();
    const original = b.get();
    a.update();
    assert.strictEqual(b.get(), original);
    assert.equal(cache.get('foreign', ''), 42);
});

test('proxy statistics are independent snapshots', () => {
    const { proxy } = fixture();
    assert.deepEqual(getServiceProxyStats(proxy), { hits: 0, misses: 0, writes: 0, invalidations: 0, hitRate: 0 });
    proxy.get(1);
    proxy.get(1);
    const snapshot = getServiceProxyStats(proxy);
    proxy.update();
    assert.deepEqual(snapshot, { hits: 1, misses: 1, writes: 0, invalidations: 0, hitRate: 0.5 });
    assert.deepEqual(getServiceProxyStats(proxy), { hits: 1, misses: 1, writes: 1, invalidations: 1, hitRate: 0.5 });
    assert.equal(getServiceProxyStats({}), undefined);
});

test('automatic registration rejects duplicate names per cache', () => {
    const cache = new TestCache();
    const proxy = registerService(cache, 'users', { get: () => ({}) });
    assert.strictEqual(proxy.get(), proxy.get());
    assert.throws(() => registerService(cache, 'users', {}), /already registered/);
    assert.doesNotThrow(() => registerService(new TestCache(), 'users', {}));
});

test('undefined and primitive reads are cached without confusing a miss', () => {
    let calls = 0;
    const proxy = createServiceProxy({ get() { calls++; return undefined; } }, new TestCache());
    assert.equal(proxy.get(), undefined);
    assert.equal(proxy.get(), undefined);
    assert.equal(calls, 1);
});

test('explicit method policies support custom APIs and receiver private fields', () => {
    class Service {
        #count = 0;
        inspect() { return { count: this.#count }; }
        commit() { this.#count++; }
    }
    const proxy = createServiceProxy(new Service(), new TestCache(), { readMethods: ['inspect'], writeMethods: ['commit'] });
    assert.strictEqual(proxy.inspect(), proxy.inspect());
    proxy.commit();
    assert.equal(proxy.inspect().count, 1);
});

test('synchronous and asynchronous failed writes preserve cached values', async () => {
    const proxy = createServiceProxy({ get: () => ({}), update() { throw new Error('sync'); }, async save() { throw new Error('async'); } }, new TestCache());
    const original = proxy.get();
    assert.throws(() => proxy.update(), /sync/);
    await assert.rejects(proxy.save(), /async/);
    assert.strictEqual(proxy.get(), original);
    assert.equal(getServiceProxyStats(proxy)?.writes, 0);
});

test('async reads retain promise and result identity after success and reject without caching', async () => {
    let calls = 0;
    const proxy = createServiceProxy({ async get(fail = false) { calls++; if (fail) throw new Error('failed'); return {}; } }, new TestCache());
    const promise = proxy.get();
    const value = await promise;
    assert.strictEqual(proxy.get(), promise);
    assert.strictEqual(await proxy.get(), value);
    await assert.rejects(proxy.get(true), /failed/);
    await assert.rejects(proxy.get(true), /failed/);
    assert.equal(calls, 3);
});

test('successful async writes invalidate only after completion', async () => {
    let finish!: () => void;
    const proxy = createServiceProxy({ get: () => ({}), update: () => new Promise<void>(resolve => { finish = resolve; }) }, new TestCache());
    const old = proxy.get();
    const pending = proxy.update();
    assert.strictEqual(proxy.get(), old);
    finish();
    await pending;
    assert.notStrictEqual(proxy.get(), old);
});

test('pending reads cannot repopulate a namespace after writes or removal', async () => {
    for (const remove of [false, true]) {
        const cache = new TestCache();
        const registry = new ServiceRegistry(cache);
        let finish!: (value: object) => void;
        const proxy = registry.register('users', { get: () => new Promise<object>(resolve => { finish = resolve; }), update() {} });
        const pending = proxy.get();
        if (remove) registry.remove('users'); else proxy.update();
        finish({});
        await pending;
        assert.equal(cache.entries.size, 0);
    }
});

test('argument types stay distinct and unsupported arguments bypass caching', () => {
    const { proxy, calls } = fixture();
    const values = [undefined, null, NaN, 'NaN', 0, -0, 1n, '1', [], [undefined], Array(1)];
    for (const value of values) proxy.get(value);
    assert.equal(calls(), values.length);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, new Map(), () => 1, Symbol('x')]) {
        assert.notStrictEqual(proxy.get(value), proxy.get(value));
    }
});
