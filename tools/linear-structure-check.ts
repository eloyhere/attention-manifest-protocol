#!/usr/bin/env node
/**
 * Behavioural checks for the linear structures and the binary heap.
 */
import assert from "node:assert/strict";

import { Deque } from "../src/structure/deque.ts";
import { BinaryHeap } from "../src/structure/heap.ts";
import type { HeapOrder } from "../src/structure/heap.ts";
import { Queue } from "../src/structure/queue.ts";
import { Stack } from "../src/structure/stack.ts";

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

/**
 * Insert into an ascending array using binary search, preserving duplicates.
 */
function insertSorted(values: number[], value: number): void {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (values[middle] < value) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    values.splice(low, 0, value);
}

function sortedNumbers(values: readonly number[]): number[] {
    return values.slice().sort((a, b) => a - b);
}

/**
 * Pop every value, asserting that the heap never reports empty prematurely.
 */
function drainHeap<T>(heap: BinaryHeap<T>): T[] {
    const values: T[] = [];
    while (!heap.isEmpty) {
        const value = heap.pop();
        assert.notEqual(value, undefined);
        values.push(value as T);
    }
    assert.equal(heap.pop(), undefined);
    return values;
}

function runHeapDifferential(order: HeapOrder, seed: number): void {
    const random = createRandom(seed);
    const heap = new BinaryHeap<number>({ order });
    const sorted: number[] = [];

    for (let step = 0; step < 5_000; step += 1) {
        const push = sorted.length === 0 || random() < 0.59;
        if (push) {
            const value = Math.floor(random() * 2_001) - 1_000;
            heap.push(value);
            insertSorted(sorted, value);
        } else {
            const expected = order === "min" ? sorted.shift() : sorted.pop();
            assert.equal(heap.pop(), expected);
        }
        assert.equal(heap.size, sorted.length);
    }

    while (sorted.length > 0) {
        const expected = order === "min" ? sorted.shift() : sorted.pop();
        assert.equal(heap.pop(), expected);
    }
    assert.equal(heap.size, 0);
    assert.equal(heap.isEmpty, true);
}

test("Stack is LIFO and empty pop/peek return undefined", () => {
    const stack = new Stack<number>();
    assert.equal(stack.size, 0);
    assert.equal(stack.isEmpty, true);
    assert.equal(stack.pop(), undefined);
    assert.equal(stack.peek(), undefined);

    assert.equal(stack.push(1), stack);
    stack.push(2).push(3);
    assert.equal(stack.size, 3);
    assert.equal(stack.isEmpty, false);
    assert.equal(stack.peek(), 3);
    assert.equal(stack.pop(), 3);
    assert.equal(stack.pop(), 2);
    assert.equal(stack.peek(), 1);

    stack.clear();
    assert.equal(stack.size, 0);
    assert.equal(stack.isEmpty, true);
    assert.equal(stack.pop(), undefined);
    assert.equal(stack.peek(), undefined);
    assert.deepEqual(stack.toArray(), []);
});

test("Stack constructor, iteration order, and toArray copies are correct", () => {
    const stack = new Stack(["first", "second", "third"]);
    assert.equal(stack.size, 3);
    assert.equal(stack.peek(), "third");
    assert.deepEqual([...stack], ["third", "second", "first"]);
    assert.deepEqual(stack.toArray(), ["third", "second", "first"]);

    const copy = stack.toArray();
    copy[0] = "mutated";
    copy.push("extra");
    assert.deepEqual(stack.toArray(), ["third", "second", "first"]);

    const snapshot = stack[Symbol.iterator]();
    stack.push("fourth");
    assert.deepEqual([...snapshot], ["third", "second", "first"]);
    assert.deepEqual([...stack], ["fourth", "third", "second", "first"]);
});

test("Queue preserves FIFO order and copies toArray and iteration results", () => {
    const queue = new Queue<number>([10, 20, 30]);
    assert.equal(queue.size, 3);
    assert.equal(queue.isEmpty, false);
    assert.equal(queue.peek(), 10);
    assert.equal(queue.enqueue(40), queue);
    assert.deepEqual([...queue], [10, 20, 30, 40]);
    assert.deepEqual(queue.toArray(), [10, 20, 30, 40]);

    const copy = queue.toArray();
    copy[0] = -1;
    copy.push(50);
    assert.deepEqual(queue.toArray(), [10, 20, 30, 40]);

    const snapshot = queue[Symbol.iterator]();
    queue.enqueue(50);
    assert.deepEqual([...snapshot], [10, 20, 30, 40]);

    assert.equal(queue.dequeue(), 10);
    assert.equal(queue.dequeue(), 20);
    assert.equal(queue.peek(), 30);
    assert.deepEqual([...queue], [30, 40, 50]);

    queue.clear();
    assert.equal(queue.size, 0);
    assert.equal(queue.isEmpty, true);
    assert.equal(queue.dequeue(), undefined);
    assert.equal(queue.peek(), undefined);
    assert.deepEqual(queue.toArray(), []);
    assert.deepEqual([...queue], []);
    queue.enqueue(7);
    assert.deepEqual([...queue], [7]);
});

test("Queue handles wrap-around and growth across many enqueues and dequeues", () => {
    const queue = new Queue<number>();
    for (let value = 0; value < 120; value += 1) {
        queue.enqueue(value);
    }
    for (let value = 0; value < 75; value += 1) {
        assert.equal(queue.dequeue(), value);
    }
    for (let value = 120; value < 260; value += 1) {
        queue.enqueue(value);
    }

    const expected: number[] = [];
    for (let value = 75; value < 260; value += 1) {
        expected.push(value);
    }
    assert.equal(queue.size, expected.length);
    assert.equal(queue.peek(), 75);
    assert.deepEqual(queue.toArray(), expected);
    assert.deepEqual([...queue], expected);

    for (const value of expected) {
        assert.equal(queue.dequeue(), value);
    }
    assert.equal(queue.isEmpty, true);
    assert.equal(queue.dequeue(), undefined);
});

test("Queue matches a native array across 15,000 interleaved operations", () => {
    const random = createRandom(0x51e4e);
    const queue = new Queue<number>();
    const reference: number[] = [];

    for (let step = 0; step < 15_000; step += 1) {
        if (reference.length === 0 || random() < 0.58) {
            const value = Math.floor(random() * 100_000);
            queue.enqueue(value);
            reference.push(value);
        } else {
            assert.equal(queue.dequeue(), reference.shift());
        }
        assert.equal(queue.size, reference.length);
        if (step % 499 === 0) {
            assert.equal(queue.isEmpty, reference.length === 0);
            assert.equal(queue.peek(), reference[0]);
            assert.deepEqual(queue.toArray(), reference);
            assert.deepEqual([...queue], reference);
        }
    }

    assert.equal(queue.size, reference.length);
    assert.deepEqual(queue.toArray(), reference);
    for (let index = 0; index < reference.length; index += 1) {
        assert.equal(queue.dequeue(), reference[index]);
    }
    assert.equal(queue.dequeue(), undefined);
});

test("Deque supports both ends, iteration, and independent toArray copies", () => {
    const deque = new Deque<number>([2, 3]);
    assert.equal(deque.size, 2);
    assert.equal(deque.peekFront(), 2);
    assert.equal(deque.peekBack(), 3);
    assert.equal(deque.pushFront(1), deque);
    assert.equal(deque.pushBack(4), deque);
    assert.equal(deque.push(5), deque);
    assert.deepEqual([...deque], [1, 2, 3, 4, 5]);
    assert.deepEqual(deque.toArray(), [1, 2, 3, 4, 5]);

    const copy = deque.toArray();
    copy[0] = 99;
    copy.push(6);
    assert.deepEqual(deque.toArray(), [1, 2, 3, 4, 5]);

    assert.equal(deque.popFront(), 1);
    assert.equal(deque.popBack(), 5);
    assert.equal(deque.peekFront(), 2);
    assert.equal(deque.peekBack(), 4);
    assert.deepEqual([...deque], [2, 3, 4]);

    const snapshot = deque[Symbol.iterator]();
    deque.pushBack(6);
    assert.deepEqual([...snapshot], [2, 3, 4]);
    assert.deepEqual([...deque], [2, 3, 4, 6]);
});

test("Deque empty operations return undefined and clear resets state", () => {
    const deque = new Deque<string>();
    assert.equal(deque.size, 0);
    assert.equal(deque.isEmpty, true);
    assert.equal(deque.popFront(), undefined);
    assert.equal(deque.popBack(), undefined);
    assert.equal(deque.peekFront(), undefined);
    assert.equal(deque.peekBack(), undefined);

    deque.pushFront("a").pushBack("b");
    assert.deepEqual([...deque], ["a", "b"]);
    deque.clear();
    assert.equal(deque.size, 0);
    assert.equal(deque.isEmpty, true);
    assert.equal(deque.popFront(), undefined);
    assert.equal(deque.popBack(), undefined);
    assert.deepEqual(deque.toArray(), []);
});

test("Deque grows and shrinks correctly around both ends", () => {
    const deque = new Deque<number>();
    const reference: number[] = [];
    for (let value = 0; value < 2_048; value += 1) {
        deque.pushBack(value);
        reference.push(value);
    }

    for (let step = 0; step < 1_800; step += 1) {
        if (step % 2 === 0) {
            assert.equal(deque.popFront(), reference.shift());
        } else {
            assert.equal(deque.popBack(), reference.pop());
        }
    }
    assert.equal(deque.size, reference.length);
    assert.deepEqual(deque.toArray(), reference);

    for (let value = 1; value <= 300; value += 1) {
        deque.pushFront(-value);
        reference.unshift(-value);
    }
    for (let value = 3_000; value < 3_300; value += 1) {
        deque.pushBack(value);
        reference.push(value);
    }
    assert.equal(deque.size, reference.length);
    assert.deepEqual([...deque], reference);
    assert.equal(deque.peekFront(), reference[0]);
    assert.equal(deque.peekBack(), reference[reference.length - 1]);

    while (reference.length > 0) {
        if (reference.length % 2 === 0) {
            assert.equal(deque.popBack(), reference.pop());
        } else {
            assert.equal(deque.popFront(), reference.shift());
        }
    }
    assert.equal(deque.isEmpty, true);
    assert.equal(deque.popFront(), undefined);
    assert.equal(deque.popBack(), undefined);
});

test("Deque matches a native array across 15,000 interleaved operations", () => {
    const random = createRandom(0xd3e9e);
    const deque = new Deque<number>();
    const reference: number[] = [];

    for (let step = 0; step < 15_000; step += 1) {
        const action = reference.length === 0 ? 0 : random();
        if (action < 0.28) {
            const value = Math.floor(random() * 100_000);
            deque.pushBack(value);
            reference.push(value);
        } else if (action < 0.56) {
            const value = Math.floor(random() * 100_000);
            deque.pushFront(value);
            reference.unshift(value);
        } else if (action < 0.78) {
            assert.equal(deque.popFront(), reference.shift());
        } else {
            assert.equal(deque.popBack(), reference.pop());
        }

        assert.equal(deque.size, reference.length);
        if (step % 503 === 0) {
            assert.equal(deque.isEmpty, reference.length === 0);
            assert.equal(deque.peekFront(), reference[0]);
            assert.equal(deque.peekBack(), reference[reference.length - 1]);
            assert.deepEqual(deque.toArray(), reference);
            assert.deepEqual([...deque], reference);
        }
    }

    assert.equal(deque.size, reference.length);
    assert.deepEqual(deque.toArray(), reference);
    while (reference.length > 0) {
        assert.equal(deque.popFront(), reference.shift());
        if (reference.length > 0) {
            assert.equal(deque.popBack(), reference.pop());
        }
    }
    assert.equal(deque.isEmpty, true);
    assert.equal(deque.popFront(), undefined);
    assert.equal(deque.popBack(), undefined);
});

test("BinaryHeap defaults to min order and supports explicit max order", () => {
    const source = [4, 1, 7, 2, 9, 4];
    const minHeap = new BinaryHeap<number>({ values: source });
    assert.equal(minHeap.peek(), 1);
    assert.deepEqual(drainHeap(minHeap), [1, 2, 4, 4, 7, 9]);

    const maxHeap = new BinaryHeap<number>({ order: "max", values: source });
    assert.equal(maxHeap.peek(), 9);
    assert.deepEqual(drainHeap(maxHeap), [9, 7, 4, 4, 2, 1]);

    const strings = new BinaryHeap<string>({ values: ["pear", "apple", "fig"] });
    assert.deepEqual(drainHeap(strings), ["apple", "fig", "pear"]);
});

test("BinaryHeap min and max match sorted arrays across 5,000 random operations each", () => {
    runHeapDifferential("min", 0x91e4);
    runHeapDifferential("max", 0x7a11);
});

test("BinaryHeap heapifies constructor values and BinaryHeap.from builds a heap", () => {
    const source: number[] = [];
    for (let index = 0; index < 257; index += 1) {
        source.push(((index * 37) % 257) - 128);
    }
    const heap = new BinaryHeap<number>({ values: source });
    const view = heap.toArray();
    assert.equal(view.length, source.length);
    for (let child = 1; child < view.length; child += 1) {
        assert.ok(view[Math.floor((child - 1) / 2)] <= view[child]);
    }
    assert.deepEqual(drainHeap(heap), sortedNumbers(source));

    const from = BinaryHeap.from([5, 3, 8, 1], { order: "max" });
    assert.equal(from.size, 4);
    assert.deepEqual(drainHeap(from), [8, 5, 3, 1]);
});

test("BinaryHeap.replace swaps the root in logarithmic time and handles empty heaps", () => {
    const heap = new BinaryHeap<number>({ values: [5, 1, 9, 3, 7] });
    assert.equal(heap.size, 5);
    assert.equal(heap.replace(0), 1);
    assert.equal(heap.size, 5);
    assert.equal(heap.peek(), 0);
    assert.equal(heap.replace(8), 0);
    assert.equal(heap.peek(), 3);
    assert.deepEqual(drainHeap(heap), [3, 5, 7, 8, 9]);

    const empty = new BinaryHeap<number>();
    assert.equal(empty.replace(42), undefined);
    assert.equal(empty.size, 1);
    assert.deepEqual(empty.toArray(), [42]);

    const maxHeap = new BinaryHeap<number>({ order: "max" });
    assert.equal(maxHeap.replace(100), undefined);
    maxHeap.push(50);
    assert.equal(maxHeap.replace(10), 100);
    assert.equal(maxHeap.peek(), 50);
    maxHeap.push(75);
    assert.equal(maxHeap.replace(150), 75);
    assert.equal(maxHeap.peek(), 150);
});

test("BinaryHeap keeps duplicate values", () => {
    const heap = new BinaryHeap<number>({ values: [5, 1, 5, 1, 3, 5] });
    assert.equal(heap.size, 6);
    assert.deepEqual(drainHeap(heap), [1, 1, 3, 5, 5, 5]);

    heap.push(2).push(2).push(2);
    assert.deepEqual(drainHeap(heap), [2, 2, 2]);
});

test("BinaryHeap honors custom comparators and reverses them for max order", () => {
    interface Job {
        name: string;
        priority: number;
    }
    const jobs: Job[] = [
        { name: "low", priority: 1 },
        { name: "urgent", priority: 9 },
        { name: "medium", priority: 5 },
        { name: "background", priority: 3 },
        { name: "high", priority: 7 },
    ];
    const compareJobs = (a: Job, b: Job): number => a.priority - b.priority;

    const minJobs = new BinaryHeap<Job>({ compare: compareJobs, values: jobs });
    assert.equal(minJobs.peek()?.name, "low");
    assert.deepEqual(
        drainHeap(minJobs).map((job) => job.name),
        ["low", "background", "medium", "high", "urgent"],
    );

    const maxJobs = new BinaryHeap<Job>({ compare: compareJobs, order: "max", values: jobs });
    assert.equal(maxJobs.peek()?.name, "urgent");
    maxJobs.push({ name: "critical", priority: 10 });
    assert.equal(maxJobs.pop()?.name, "critical");

    const byMagnitude = new BinaryHeap<number>({
        compare: (a, b) => Math.abs(a) - Math.abs(b),
        values: [5, -1, 3, -7],
    });
    assert.deepEqual(drainHeap(byMagnitude), [-1, 3, 5, -7]);
});

test("BinaryHeap toArray and iteration expose heap-ordered copies", () => {
    const source = [9, 4, 7, 1, 8, 2, 6, 3, 5];
    const heap = new BinaryHeap<number>({ values: source });
    const view = heap.toArray();
    assert.equal(view.length, source.length);
    assert.deepEqual(sortedNumbers(view), sortedNumbers(source));
    for (let child = 1; child < view.length; child += 1) {
        assert.ok(view[Math.floor((child - 1) / 2)] <= view[child]);
    }
    assert.deepEqual([...heap], view);

    const snapshot = heap[Symbol.iterator]();
    heap.push(0);
    assert.deepEqual([...snapshot], view);

    const copy = heap.toArray();
    copy[0] = -1;
    copy.push(100);
    assert.equal(heap.size, source.length + 1);
    assert.deepEqual(sortedNumbers(heap.toArray()), sortedNumbers([...source, 0]));
});

test("BinaryHeap empty behavior and clear are well-defined", () => {
    const heap = new BinaryHeap<number>();
    assert.equal(heap.size, 0);
    assert.equal(heap.isEmpty, true);
    assert.equal(heap.peek(), undefined);
    assert.equal(heap.pop(), undefined);
    assert.deepEqual(heap.toArray(), []);
    assert.deepEqual([...heap], []);

    heap.push(2).push(1).push(3);
    assert.equal(heap.size, 3);
    heap.clear();
    assert.equal(heap.size, 0);
    assert.equal(heap.isEmpty, true);
    assert.equal(heap.peek(), undefined);
    assert.equal(heap.pop(), undefined);
    assert.deepEqual(heap.toArray(), []);

    heap.push(11);
    assert.equal(heap.pop(), 11);
    assert.equal(heap.isEmpty, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
