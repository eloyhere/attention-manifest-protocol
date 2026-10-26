#!/usr/bin/env node
/**
 * Priority queues: the stable comparison queue, the keyed queue, the integer
 * bucket queue and bounded top-k selection.
 */
import assert from "node:assert/strict";

import { byKey } from "../src/structure/compare.ts";
import type { HeapOrder } from "../src/structure/heap.ts";
import { BucketQueue, IndexedPriorityQueue, PriorityQueue, TopK } from "../src/structure/priority.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed += 1;
        console.log(`✓ ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ ${name}\n      ${message}`);
    }
}

/**
 * Deterministic mulberry32 generator, so random checks are reproducible.
 */
function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

interface Row {
    id: number;
    rank: number;
}

const compareRows = (left: Row, right: Row): number => left.rank - right.rank;

/**
 * Reference order for the comparison queues: priority first, then arrival.
 *
 * `rows` is kept in arrival order and `sort` is stable, so equal ranks keep
 * their arrival order, which is exactly the contract the queues promise.
 */
function orderRows(rows: readonly Row[], order: HeapOrder): Row[] {
    const copy: Row[] = rows.slice();
    copy.sort((left: Row, right: Row): number => {
        return order === "max" ? compareRows(right, left) : compareRows(left, right);
    });
    return copy;
}

interface BucketRow {
    value: number;
    priority: number;
}

function orderBuckets(rows: readonly BucketRow[], order: HeapOrder): BucketRow[] {
    const copy: BucketRow[] = rows.slice();
    copy.sort((left: BucketRow, right: BucketRow): number => {
        return order === "max" ? right.priority - left.priority : left.priority - right.priority;
    });
    return copy;
}

/**
 * Compare two sequences position by position.
 *
 * `deepEqual` on a few thousand entries buries the first mismatch in a full
 * dump, so these checks report the index and the two values instead.
 */
function assertSameSequence<T>(actual: readonly T[], expected: readonly T[], label: string): void {
    assert.equal(actual.length, expected.length, `${label}: length ${actual.length} !== ${expected.length}`);
    for (let index = 0; index < expected.length; index += 1) {
        if (actual[index] !== expected[index]) {
            assert.fail(`${label}: index ${index}: ${String(actual[index])} !== ${String(expected[index])}`);
        }
    }
}

/**
 * Run the comparison queue against a stable-sort model.
 */
function runPriorityQueueDifferential(order: HeapOrder, seed: number): void {
    const random: () => number = createRandom(seed);
    const queue = new PriorityQueue<Row>({ compare: compareRows, order });
    const model: Row[] = [];
    let nextId = 0;

    for (let step = 0; step < 2000; step += 1) {
        if (model.length === 0 || random() < 0.6) {
            const row: Row = { id: nextId, rank: Math.floor(random() * 12) };
            nextId += 1;
            queue.enqueue(row);
            model.push(row);
            continue;
        }
        const expected: Row = orderRows(model, order)[0];
        const actual: Row | undefined = queue.dequeue();
        assert.equal(actual?.id, expected.id);
        model.splice(model.indexOf(expected), 1);
    }

    assert.equal(queue.size, model.length);
    assertSameSequence(
        queue.toArray().map((row: Row): number => row.id),
        orderRows(model, order).map((row: Row): number => row.id),
        `priority queue ${order}`,
    );
}

/**
 * Run the keyed queue against a Map model, exercising insert, replace, delete
 * and extract on the same keys.
 */
function runIndexedDifferential(order: HeapOrder, seed: number): void {
    const random: () => number = createRandom(seed);
    const queue = new IndexedPriorityQueue<number, Row>({ keyOf: (row: Row): number => row.id, compare: compareRows, order });
    const model = new Map<number, Row>();
    let nextId = 0;

    for (let step = 0; step < 3000; step += 1) {
        const roll: number = random();
        if (roll < 0.45) {
            const keys: number[] = [...model.keys()];
            const reuse: boolean = keys.length > 0 && random() < 0.5;
            const id: number = reuse ? keys[Math.floor(random() * keys.length)] : nextId;
            if (!reuse) {
                nextId += 1;
            }
            const row: Row = { id, rank: Math.floor(random() * 12) };
            queue.set(row);
            model.set(id, row);
        } else if (roll < 0.7) {
            const keys: number[] = [...model.keys()];
            if (keys.length === 0) {
                continue;
            }
            const key: number = keys[Math.floor(random() * keys.length)];
            assert.equal(queue.delete(key), model.delete(key));
        } else if (model.size > 0) {
            const expected: Row = orderRows([...model.values()], order)[0];
            const actual: Row | undefined = queue.dequeue();
            assert.equal(actual?.id, expected.id);
            model.delete(expected.id);
        }
        assert.equal(queue.size, model.size);
        if (model.size > 0) {
            assert.deepEqual(queue.peek()?.id, orderRows([...model.values()], order)[0].id);
        }
    }

    assertSameSequence(
        queue.keys(),
        orderRows([...model.values()], order).map((row: Row): number => row.id),
        `indexed queue keys ${order}`,
    );
}

/**
 * Run the bucket queue against a stable-sort model over sparse priorities.
 */
function runBucketDifferential(order: HeapOrder, seed: number): void {
    const random: () => number = createRandom(seed);
    const queue = new BucketQueue<number>({ order });
    const model: BucketRow[] = [];
    let nextValue = 0;

    for (let step = 0; step < 2000; step += 1) {
        if (model.length === 0 || random() < 0.55) {
            const priority: number = Math.floor(random() * 9) - 4;
            queue.enqueue(nextValue, priority);
            model.push({ value: nextValue, priority });
            nextValue += 1;
            continue;
        }
        const expected: BucketRow = orderBuckets(model, order)[0];
        assert.equal(queue.peekPriority(), expected.priority);
        assert.equal(queue.dequeue(), expected.value);
        model.splice(model.indexOf(expected), 1);
    }

    assert.equal(queue.size, model.length);
    assertSameSequence(
        queue.toArray(),
        orderBuckets(model, order).map((row: BucketRow): number => row.value),
        `bucket queue ${order}`,
    );
}

test("PriorityQueue serves the greatest value first by default", () => {
    const queue = new PriorityQueue<number>();
    queue.enqueue(3).enqueue(9).enqueue(1).enqueue(7);
    assert.equal(queue.size, 4);
    assert.equal(queue.isEmpty, false);
    assert.equal(queue.peek(), 9);
    assert.equal(queue.dequeue(), 9);
    assert.equal(queue.dequeue(), 7);
    assert.equal(queue.dequeue(), 3);
    assert.equal(queue.dequeue(), 1);
    assert.equal(queue.dequeue(), undefined);
    assert.equal(queue.isEmpty, true);
});

test("PriorityQueue serves the smallest value first with order: 'min'", () => {
    const queue = new PriorityQueue<number>({ order: "min" });
    queue.enqueueAll([5, 2, 8, 1]);
    assert.equal(queue.peek(), 1);
    assert.deepEqual(queue.drain(), [1, 2, 5, 8]);
});

test("PriorityQueue breaks ties by arrival, in both orders", () => {
    const compare = (left: string, right: string): number => left.length - right.length;
    const maxQueue = new PriorityQueue<string>({ compare, values: ["bb", "a", "cc", "dd", "e"] });
    assert.deepEqual(maxQueue.toArray(), ["bb", "cc", "dd", "a", "e"]);

    const minQueue = new PriorityQueue<string>({ compare, order: "min", values: ["bb", "a", "cc", "dd", "e"] });
    assert.deepEqual(minQueue.toArray(), ["a", "e", "bb", "cc", "dd"]);
});

test("PriorityQueue seeds from values, enqueueAll and from()", () => {
    const seeded = new PriorityQueue<number>({ values: [4, 1, 4, 2] });
    assert.equal(seeded.size, 4);
    assert.deepEqual(seeded.drain(), [4, 4, 2, 1]);

    const from = PriorityQueue.from([5, 3, 8, 1]);
    assert.equal(from.size, 4);
    assert.deepEqual([...from], [8, 5, 3, 1]);

    const minFrom = PriorityQueue.from(["pear", "apple", "fig"], { order: "min" });
    assert.deepEqual(minFrom.drain(), ["apple", "fig", "pear"]);
});

test("PriorityQueue snapshots are non-destructive and drain removes everything", () => {
    const queue = new PriorityQueue<number>({ values: [2, 7, 4] });
    const view: number[] = queue.toArray();
    assert.deepEqual(view, [7, 4, 2]);
    assert.equal(queue.size, 3);

    view[0] = -1;
    view.push(100);
    assert.deepEqual(queue.toArray(), [7, 4, 2]);
    assert.deepEqual([...queue], [7, 4, 2]);

    const iterator: Generator<number, void, unknown> = queue[Symbol.iterator]();
    queue.enqueue(10);
    assert.deepEqual([...iterator], [7, 4, 2]);

    assert.deepEqual(queue.drain(), [10, 7, 4, 2]);
    assert.equal(queue.isEmpty, true);
    assert.deepEqual(queue.toArray(), []);
    assert.deepEqual([...queue], []);
});

test("PriorityQueue accepts a key-derived comparator", () => {
    interface Job {
        name: string;
        priority: number;
    }
    const jobs: Job[] = [
        { name: "low", priority: 1 },
        { name: "urgent", priority: 9 },
        { name: "medium", priority: 5 },
    ];
    const queue = new PriorityQueue<Job>({ compare: byKey((job: Job): number => job.priority) });
    queue.enqueueAll(jobs);
    assert.equal(queue.peek()?.name, "urgent");
    queue.enqueue({ name: "critical", priority: 10 });
    assert.deepEqual(
        queue.drain().map((job: Job): string => job.name),
        ["critical", "urgent", "medium", "low"],
    );
});

test("PriorityQueue empty behavior and clear are well-defined", () => {
    const queue = new PriorityQueue<string>();
    assert.equal(queue.size, 0);
    assert.equal(queue.isEmpty, true);
    assert.equal(queue.peek(), undefined);
    assert.equal(queue.dequeue(), undefined);
    assert.deepEqual(queue.toArray(), []);
    assert.deepEqual(queue.drain(), []);

    queue.enqueue("a").enqueue("b");
    assert.equal(queue.size, 2);
    queue.clear();
    assert.equal(queue.size, 0);
    assert.equal(queue.isEmpty, true);
    assert.equal(queue.peek(), undefined);

    queue.enqueue("z");
    assert.equal(queue.dequeue(), "z");
});

test("PriorityQueue keeps undefined values without losing count", () => {
    const compare = (left: number | undefined, right: number | undefined): number => (left ?? -1) - (right ?? -1);
    const queue = new PriorityQueue<number | undefined>({ compare });
    queue.enqueue(undefined).enqueue(1);
    assert.equal(queue.size, 2);
    assert.equal(queue.dequeue(), 1);
    assert.equal(queue.size, 1);
    assert.equal(queue.dequeue(), undefined);
    assert.equal(queue.isEmpty, true);
});

test("PriorityQueue drains 10,000 values in priority order", () => {
    const random: () => number = createRandom(0x5eed);
    const queue = new PriorityQueue<number>();
    const values: number[] = [];
    for (let index = 0; index < 10000; index += 1) {
        const value: number = Math.floor(random() * 1000);
        values.push(value);
        queue.enqueue(value);
    }
    const expected: number[] = values.slice().sort((left: number, right: number): number => right - left);
    assertSameSequence(queue.drain(), expected, "10,000 value drain");
});

test("PriorityQueue matches a stable-sort model across 2,000 random operations per order", () => {
    runPriorityQueueDifferential("max", 0x9e37);
    runPriorityQueueDifferential("min", 0x1f2a);
});

test("IndexedPriorityQueue orders by priority and exposes keys", () => {
    const queue = new IndexedPriorityQueue<number, Row>({ keyOf: (row: Row): number => row.id, compare: compareRows });
    queue.set({ id: 2, rank: 2 }).set({ id: 5, rank: 5 }).set({ id: 3, rank: 2 });
    assert.equal(queue.size, 3);
    assert.equal(queue.isEmpty, false);
    assert.equal(queue.peek()?.id, 5);
    assert.equal(queue.peekKey(), 5);
    assert.deepEqual(queue.keys(), [5, 2, 3]);
    assert.deepEqual(
        queue.toArray().map((row: Row): number => row.id),
        [5, 2, 3],
    );
    assert.equal(queue.get(3)?.rank, 2);
    assert.equal(queue.has(5), true);
    assert.equal(queue.has(9), false);
    assert.equal(queue.dequeue()?.id, 5);
    assert.equal(queue.size, 2);
});

test("IndexedPriorityQueue re-prioritises an existing key without reordering ties", () => {
    const queue = new IndexedPriorityQueue<number, Row>({ keyOf: (row: Row): number => row.id, compare: compareRows });
    queue.set({ id: 0, rank: 2 });
    queue.set({ id: 1, rank: 5 });
    queue.set({ id: 2, rank: 2 });
    assert.deepEqual(queue.keys(), [1, 0, 2]);

    queue.set({ id: 0, rank: 9 });
    assert.deepEqual(queue.keys(), [0, 1, 2]);
    assert.equal(queue.size, 3);

    queue.set({ id: 0, rank: 2 });
    assert.deepEqual(queue.keys(), [1, 0, 2]);

    queue.set({ id: 0, rank: 1 });
    assert.deepEqual(queue.keys(), [1, 2, 0]);
    assert.equal(queue.size, 3);
});

test("IndexedPriorityQueue replaces the value under an existing key", () => {
    const queue = new IndexedPriorityQueue<string, { id: string; rank: number; note: string }>({
        keyOf: (value: { id: string; rank: number; note: string }): string => value.id,
        compare: (left: { id: string; rank: number; note: string }, right: { id: string; rank: number; note: string }): number => left.rank - right.rank,
    });
    queue.set({ id: "x", rank: 1, note: "old" });
    queue.set({ id: "x", rank: 1, note: "new" });
    assert.equal(queue.size, 1);
    assert.equal(queue.get("x")?.note, "new");
    assert.deepEqual(queue.keys(), ["x"]);
});

test("IndexedPriorityQueue deletes by key at every heap position", () => {
    const queue = new IndexedPriorityQueue<number, Row>({ keyOf: (row: Row): number => row.id, compare: compareRows });
    queue.set({ id: 0, rank: 1 });
    queue.set({ id: 1, rank: 2 });
    queue.set({ id: 2, rank: 3 });
    queue.set({ id: 3, rank: 4 });
    queue.set({ id: 4, rank: 5 });
    assert.deepEqual(queue.keys(), [4, 3, 2, 1, 0]);

    assert.equal(queue.delete(9), false);
    assert.equal(queue.delete(2), true);
    assert.deepEqual(queue.keys(), [4, 3, 1, 0]);
    assert.equal(queue.size, 4);

    assert.equal(queue.delete(4), true);
    assert.deepEqual(queue.keys(), [3, 1, 0]);

    assert.equal(queue.delete(0), true);
    assert.deepEqual(queue.keys(), [3, 1]);

    assert.equal(queue.delete(3), true);
    assert.deepEqual(queue.keys(), [1]);

    assert.equal(queue.delete(1), true);
    assert.equal(queue.isEmpty, true);
    assert.equal(queue.peek(), undefined);
    assert.equal(queue.dequeue(), undefined);
});

test("IndexedPriorityQueue clear resets keys and iteration", () => {
    const queue = new IndexedPriorityQueue<number, Row>({ keyOf: (row: Row): number => row.id, compare: compareRows });
    queue.set({ id: 1, rank: 1 }).set({ id: 2, rank: 2 });
    queue.clear();
    assert.equal(queue.size, 0);
    assert.equal(queue.has(1), false);
    assert.deepEqual([...queue], []);
    queue.set({ id: 3, rank: 3 });
    assert.deepEqual(queue.keys(), [3]);
});

test("IndexedPriorityQueue matches a Map model across 3,000 random operations per order", () => {
    runIndexedDifferential("max", 0x2c1b);
    runIndexedDifferential("min", 0x77e1);
});

test("BucketQueue serves priorities in order and stays FIFO inside a bucket", () => {
    const queue = new BucketQueue<string>();
    queue.enqueue("cold", 0).enqueue("warm", 1).enqueue("hot", 9).enqueue("warm again", 1);
    assert.equal(queue.size, 4);
    assert.equal(queue.peekPriority(), 9);
    assert.equal(queue.peek(), "hot");
    assert.deepEqual(queue.toArray(), ["hot", "warm", "warm again", "cold"]);
    assert.equal(queue.size, 4);

    assert.equal(queue.dequeue(), "hot");
    assert.equal(queue.peekPriority(), 1);
    assert.equal(queue.dequeue(), "warm");
    assert.equal(queue.dequeue(), "warm again");
    assert.equal(queue.dequeue(), "cold");
    assert.equal(queue.dequeue(), undefined);
    assert.equal(queue.peekPriority(), undefined);
    assert.equal(queue.isEmpty, true);
});

test("BucketQueue honors order: 'min'", () => {
    const queue = new BucketQueue<number>({ order: "min" });
    queue.enqueue(5, 3).enqueue(1, 1).enqueue(9, 9);
    assert.equal(queue.peekPriority(), 1);
    assert.deepEqual([queue.dequeue(), queue.dequeue(), queue.dequeue()], [1, 5, 9]);
});

test("BucketQueue tolerates sparse and negative priorities", () => {
    const queue = new BucketQueue<string>();
    queue.enqueue("far", 1000000).enqueue("near", -1000000).enqueue("middle", 0);
    assert.deepEqual(queue.toArray(), ["far", "middle", "near"]);
    assert.equal(queue.peekPriority(), 1000000);
    queue.dequeue();
    assert.equal(queue.peekPriority(), 0);
    queue.dequeue();
    assert.equal(queue.peekPriority(), -1000000);
});

test("BucketQueue rejects priorities a bucket cannot index", () => {
    const queue = new BucketQueue<string>();
    assert.throws(() => queue.enqueue("x", 1.5), RangeError);
    assert.throws(() => queue.enqueue("x", Number.NaN), RangeError);
    assert.throws(() => queue.enqueue("x", Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => queue.enqueue("x", 2 ** 53), RangeError);
    assert.equal(queue.size, 0);
});

test("BucketQueue drains a single large bucket in FIFO order", () => {
    const queue = new BucketQueue<number>();
    for (let index = 0; index < 500; index += 1) {
        queue.enqueue(index, 5);
    }
    const drained: number[] = [];
    while (!queue.isEmpty) {
        const value: number | undefined = queue.dequeue();
        assert.notEqual(value, undefined);
        drained.push(value as number);
    }
    assert.equal(drained.length, 500);
    for (let index = 0; index < drained.length; index += 1) {
        assert.equal(drained[index], index);
    }
});

test("BucketQueue toArray is a sorted view and clear resets the queue", () => {
    const queue = new BucketQueue<number>();
    queue.enqueue(1, 2).enqueue(2, 4).enqueue(3, 2);
    const view: number[] = queue.toArray();
    assert.deepEqual(view, [2, 1, 3]);
    view.push(99);
    assert.deepEqual(queue.toArray(), [2, 1, 3]);
    assert.equal(queue.size, 3);

    queue.clear();
    assert.equal(queue.size, 0);
    assert.equal(queue.isEmpty, true);
    assert.equal(queue.peek(), undefined);
    assert.equal(queue.peekPriority(), undefined);
    assert.deepEqual(queue.toArray(), []);
});

test("BucketQueue matches a stable-sort model across 2,000 random operations per order", () => {
    runBucketDifferential("max", 0x51ab);
    runBucketDifferential("min", 0x0d1e);
});

test("TopK keeps the k best values in order", () => {
    const best = new TopK<number>(3);
    assert.equal(best.capacity, 3);
    assert.equal(best.size, 0);
    assert.equal(best.isFull, false);
    assert.equal(best.worst, undefined);

    for (const value of [5, 1, 9, 3, 7]) {
        assert.equal(best.offer(value), true);
    }
    assert.equal(best.size, 3);
    assert.equal(best.isFull, true);
    assert.deepEqual(best.toArray(), [9, 7, 5]);
    assert.equal(best.worst, 5);

    assert.equal(best.offer(0), false);
    assert.equal(best.offer(5), false);
    assert.equal(best.offer(4), false);
    assert.equal(best.offer(6), true);
    assert.deepEqual(best.toArray(), [9, 7, 6]);
    assert.equal(best.worst, 6);
    assert.deepEqual([...best], [9, 7, 6]);

    best.clear();
    assert.equal(best.size, 0);
    assert.deepEqual(best.toArray(), []);
});

test("TopK honors order: 'min' and custom comparators", () => {
    const smallest = new TopK<number>(3, { order: "min" });
    for (const value of [5, 1, 9, 3, 7]) {
        smallest.offer(value);
    }
    assert.deepEqual(smallest.toArray(), [1, 3, 5]);
    assert.equal(smallest.worst, 5);

    const best = new TopK<{ name: string; rank: number }>(2, {
        compare: (left: { name: string; rank: number }, right: { name: string; rank: number }): number => left.rank - right.rank,
    });
    best.offer({ name: "a", rank: 5 });
    best.offer({ name: "b", rank: 5 });
    assert.equal(best.offer({ name: "c", rank: 5 }), false);
    assert.equal(best.size, 2);
    assert.equal(best.offer({ name: "d", rank: 6 }), true);
    assert.deepEqual(
        best
            .toArray()
            .map((entry: { name: string; rank: number }): string => entry.name)
            .sort(),
        ["b", "d"],
    );
});

test("TopK rejects capacities that cannot bound a buffer", () => {
    assert.throws(() => new TopK<number>(0), RangeError);
    assert.throws(() => new TopK<number>(-3), RangeError);
    assert.throws(() => new TopK<number>(1.5), RangeError);
    assert.throws(() => new TopK<number>(Number.POSITIVE_INFINITY), RangeError);
});

test("TopK matches a full sort across 1,500 random offers per order", () => {
    for (const [order, seed] of [
        ["max", 0x3a5f],
        ["min", 0x64c9],
    ] as Array<[HeapOrder, number]>) {
        const random: () => number = createRandom(seed);
        const best = new TopK<number>(7, { order });
        const offered: number[] = [];
        for (let step = 0; step < 1500; step += 1) {
            const value: number = Math.floor(random() * 60);
            offered.push(value);
            best.offer(value);
        }
        const expected: number[] = offered
            .slice()
            .sort((left: number, right: number): number => (order === "max" ? right - left : left - right))
            .slice(0, 7);
        assertSameSequence(best.toArray(), expected, `top-k ${order}`);
        assert.equal(best.size, 7);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
