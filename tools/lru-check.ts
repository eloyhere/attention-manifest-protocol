#!/usr/bin/env node
/**
 * LRU list, ordered/unordered maps and sets.
 */
import assert from "node:assert/strict";

import { LRUList, LRUOrderedMap, LRUOrderedSet, LRUUnorderedMap, LRUUnorderedSet } from "../src/structure/lru.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

test("LRUList maintains front-to-back order and node operations", () => {
    const list = new LRUList<number>([2, 3]);
    const one = list.pushFront(1);
    const four = list.pushBack(4);
    assert.deepEqual([...list], [1, 2, 3, 4]);
    assert.equal(list.front, 1);
    assert.equal(list.back, 4);
    assert.equal(list.size, 4);

    assert.equal(list.moveToFront(four), true);
    assert.deepEqual([...list], [4, 1, 2, 3]);
    assert.equal(list.remove(one), true);
    assert.deepEqual([...list], [4, 2, 3]);
    assert.equal(list.remove(one), false);
    assert.equal(list.popFront(), 4);
    assert.equal(list.popBack(), 3);
    assert.deepEqual([...list], [2]);
    list.clear();
    assert.equal(list.size, 0);
    assert.equal(list.front, undefined);
});

test("LRUOrderedMap evicts by recency while iterating in insertion order", () => {
    const map = new LRUOrderedMap<string, number>(3);
    map.set("a", 1).set("b", 2).set("c", 3);
    assert.deepEqual([...map.keys()], ["a", "b", "c"]);
    assert.equal(map.get("a"), 1);
    assert.deepEqual(map.mostRecentlyUsed(), ["a", 1]);
    assert.deepEqual(map.leastRecentlyUsed(), ["b", 2]);

    map.set("d", 4);
    assert.equal(map.has("b"), false);
    assert.deepEqual([...map.keys()], ["a", "c", "d"]);
    assert.equal(map.size, 3);
    assert.equal(map.isFull, true);
    assert.deepEqual(
        [...map.entries()],
        [
            ["a", 1],
            ["c", 3],
            ["d", 4],
        ],
    );
    assert.deepEqual([...map.values()], [1, 3, 4]);

    map.set("c", 30);
    assert.deepEqual([...map.keys()], ["a", "c", "d"]);
    assert.equal(map.get("c"), 30);
    assert.deepEqual(map.mostRecentlyUsed(), ["c", 30]);
});

test("LRUOrderedMap has/peek do not touch and touch does", () => {
    const map = new LRUOrderedMap<string, number>(2);
    map.set("a", 1).set("b", 2);
    assert.equal(map.peek("a"), 1);
    assert.equal(map.has("a"), true);
    assert.deepEqual(map.leastRecentlyUsed(), ["a", 1]);
    assert.equal(map.touch("a"), true);
    assert.deepEqual(map.leastRecentlyUsed(), ["b", 2]);
    map.set("c", 3);
    assert.equal(map.has("b"), false);
    assert.equal(map.touch("missing"), false);
    assert.equal(map.peek("missing"), undefined);
});

test("LRUOrderedMap delete/re-add moves the key to the insertion tail", () => {
    const map = new LRUOrderedMap<string, number>(3, [
        ["a", 1],
        ["b", 2],
    ]);
    assert.equal(map.delete("a"), true);
    map.set("a", 10);
    assert.deepEqual([...map.keys()], ["b", "a"]);
    assert.equal(map.get("a"), 10);
});

test("LRUOrderedSet shares recency and capacity semantics", () => {
    const set = new LRUOrderedSet<number>(2, [1, 2]);
    assert.equal(set.has(1), true);
    assert.equal(set.get(1), true);
    assert.deepEqual([...set], [1, 2]);
    set.add(3);
    assert.equal(set.has(2), false);
    assert.deepEqual([...set], [1, 3]);
    assert.deepEqual(set.leastRecentlyUsed(), 1);
    set.touch(1);
    assert.deepEqual(set.leastRecentlyUsed(), 3);
    set.delete(1);
    assert.equal(set.has(1), false);
    assert.equal(set.size, 1);
    set.add(1);
    assert.deepEqual([...set], [3, 1]);
});

test("LRUUnorderedMap preserves recency and eviction without order promises", () => {
    const map = new LRUUnorderedMap<string, number>(2);
    map.set("a", 1).set("b", 2);
    assert.equal(map.get("a"), 1);
    map.set("c", 3);
    assert.equal(map.has("b"), false);
    assert.equal(map.size, 2);
    assert.deepEqual(new Set(map.keys()), new Set(["a", "c"]));
    assert.deepEqual(map.leastRecentlyUsed(), ["a", 1]);
    assert.deepEqual(map.mostRecentlyUsed(), ["c", 3]);
});

test("LRUUnorderedSet preserves recency and capacity", () => {
    const set = new LRUUnorderedSet<string>(2, ["a", "b"]);
    assert.equal(set.has("a"), true);
    set.add("c");
    assert.equal(set.has("a"), false);
    assert.equal(set.has("b"), true);
    assert.equal(set.size, 2);
    assert.equal(set.leastRecentlyUsed(), "b");
    set.touch("b");
    assert.equal(set.leastRecentlyUsed(), "c");
    assert.equal(set.entries().next().value?.[0] !== undefined, true);
});

test("capacity and custom key strategies are honored", () => {
    assert.throws(() => new LRUOrderedMap(0), RangeError);
    assert.throws(() => new LRUUnorderedSet(0), RangeError);
    interface Key {
        id: number;
    }
    const strategy = {
        hash: (key: Key): bigint => BigInt(key.id),
        equals: (left: Key, right: Key): boolean => left.id === right.id,
    };
    const map = new LRUOrderedMap<Key, string>(2, undefined, strategy);
    map.set({ id: 1 }, "a");
    map.set({ id: 2 }, "b");
    assert.equal(map.get({ id: 1 }), "a");
    map.set({ id: 3 }, "c");
    assert.equal(map.has({ id: 2 }), false);
    assert.equal(map.get({ id: 1 }), "a");
});

test("forEach and constructor capacity eviction", () => {
    const map = new LRUOrderedMap<string, number>(2, [
        ["a", 1],
        ["b", 2],
        ["c", 3],
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.has("a"), false);
    const seen: Array<[string, number]> = [];
    map.forEach((value, key) => seen.push([key, value]));
    assert.deepEqual(seen, [
        ["b", 2],
        ["c", 3],
    ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
