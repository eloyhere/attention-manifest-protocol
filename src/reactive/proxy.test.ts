import test from "node:test";
import assert from "node:assert/strict";
import { useLazyProxy, useProxy } from "./index.ts";

test("Proxy hooks observe reads and block projection writes", () => {
    const reads: PropertyKey[] = [];
    const proxy = useProxy({ name: "node" }, { beforeGet: (_target, key) => { reads.push(key); } });
    assert.equal(proxy.name, "node");
    assert.deepEqual(reads, ["name"]);
    assert.throws(() => Reflect.set(proxy, "name", "changed"), /read-only/);
    assert.throws(() => Reflect.defineProperty(proxy, "name", { value: "changed" }), /read-only/);
    assert.throws(() => Reflect.deleteProperty(proxy, "name"), /read-only/);
});

test("lazy properties load only on access, cache nullish values, and can be invalidated", () => {
    let calls = 0;
    const lazy = useLazyProxy<{ id: string; children: readonly string[]; missing: undefined }, "children" | "missing">({ id: "root" }, {
        load: { children: () => { calls++; return Object.freeze(["child"]); }, missing: () => { calls++; return undefined; } },
    });
    assert.equal(lazy.value.id, "root");
    assert.deepEqual(Object.keys(lazy.value), ["id", "children", "missing"]);
    assert.equal("children" in lazy.value, true);
    assert.equal(calls, 0);
    assert.equal(lazy.isLoaded("children"), false);
    const first = lazy.value.children;
    assert.equal(lazy.value.children, first);
    assert.equal(calls, 1);
    assert.equal(lazy.value.missing, undefined);
    assert.equal(lazy.value.missing, undefined);
    assert.equal(calls, 2);
    lazy.invalidate("children");
    assert.equal(lazy.isLoaded("children"), false);
    assert.notEqual(lazy.value.children, first);
    assert.equal(calls, 3);
});

test("failed lazy loads retry and stale sources cannot return cached values", () => {
    let failed = true;
    let current = true;
    const lazy = useLazyProxy<{ id: string; children: number[] }, "children">({ id: "r" }, {
        assertCurrent: () => { if (!current) { throw new Error("stale"); } },
        load: { children: () => { if (failed) { throw new Error("load failed"); } return [1]; } },
    });
    assert.throws(() => lazy.value.children, /load failed/);
    assert.equal(lazy.isLoaded("children"), false);
    failed = false;
    assert.deepEqual(lazy.value.children, [1]);
    current = false;
    assert.throws(() => lazy.value.children, /stale/);
    assert.throws(() => lazy.value.id, /stale/);
});

test("cached and extracted lazy getters retain their per-property access policy", () => {
    let allowed = true;
    const lazy = useLazyProxy<{ content: string }, "content">({}, {
        beforeGet: key => { if (key === "content" && !allowed) { throw new Error("forbidden"); } },
        load: { content: () => "private" },
    });
    const getter = Object.getOwnPropertyDescriptor(lazy.value, "content")!.get!;
    assert.equal(getter(), "private");
    allowed = false;
    assert.throws(() => lazy.value.content, /forbidden/);
    assert.throws(() => getter(), /forbidden/);
});

test("recursive lazy properties fail explicitly rather than recursing forever", () => {
    let read!: () => number;
    const lazy = useLazyProxy<{ child: number }, "child">({}, { load: { child: () => read() } });
    read = () => lazy.value.child;
    assert.throws(read, /Recursive lazy load/);
    assert.equal(lazy.isLoaded("child"), false);
});
