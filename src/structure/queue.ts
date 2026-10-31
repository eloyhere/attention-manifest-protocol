/**
 * Array-backed first-in, first-out queue.
 *
 * Values live in a circular buffer addressed by a head index and a count. Both
 * ends of the logical sequence are therefore updated by index arithmetic:
 * `enqueue` writes just past the current tail and `dequeue` advances the head
 * without ever calling `Array.prototype.shift`. The buffer is not required to
 * have a power-of-two length; it doubles when full and halves after a
 * dequeue leaves it sparsely occupied. All operations are O(1) amortized.
 */

import { generatorFrom } from "./iterator.ts";

const InitialCapacity: number = 8;

/**
 * A first-in, first-out queue.
 *
 * `dequeue` and `peek` return `undefined` when the queue is empty rather than
 * throwing. Since `undefined` is also a valid stored value, use {@link size} or
 * {@link isEmpty} when presence must be distinguished from absence.
 *
 * Iteration is front-to-back.
 *
 * @example
 * ```ts
 * const queue = new Queue(["a", "b"]);
 * queue.enqueue("c");
 * queue.dequeue(); // "a"
 * [...queue]; // ["b", "c"]
 * ```
 */
export class Queue<T> implements Iterable<T> {
    private items: Array<T | undefined> = new Array<T | undefined>(InitialCapacity);
    private head = 0;
    private count = 0;

    /**
     * Create a queue, optionally seeded from `values`.
     *
     * Values are enqueued in iteration order, so the first value becomes the
     * front.
     *
     * @param values - Values to enqueue, in order.
     */
    constructor(values?: Iterable<T>) {
        if (values === (void 0)) {
            return;
        }
        const initialValues: T[] = [...values];
        for (let index: number = 0; index < initialValues.length; index += 1) {
            this.enqueue(initialValues[index]);
        }
    }

    /**
     * Number of values currently in the queue.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Whether the queue contains no values.
     */
    get isEmpty(): boolean {
        return this.count === 0;
    }

    /**
     * Add a value at the back of the queue.
     *
     * @param value - Value to enqueue.
     * @returns This queue, for chaining.
     */
    enqueue(value: T): this {
        if (this.count === this.items.length) {
            this.resize(this.items.length * 2);
        }
        const tail: number = (this.head + this.count) % this.items.length;
        this.items[tail] = value;
        this.count += 1;
        return this;
    }

    /**
     * Remove and return the value at the front of the queue.
     *
     * @returns The former front value, or `undefined` if the queue is empty.
     */
    dequeue(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        const value: T = this.items[this.head] as T;
        this.items[this.head] = undefined;
        this.head = (this.head + 1) % this.items.length;
        this.count -= 1;
        this.shrinkIfSparse();
        return value;
    }

    /**
     * Return the value at the front of the queue without removing it.
     *
     * @returns The front value, or `undefined` if the queue is empty.
     */
    peek(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        return this.items[this.head] as T;
    }

    /**
     * Remove every value and reset the ring to its initial capacity.
     */
    clear(): void {
        this.items = new Array<T | undefined>(InitialCapacity);
        this.head = 0;
        this.count = 0;
    }

    /**
     * Snapshot the queue from front to back.
     *
     * @returns A new array whose first item is the front of the queue.
     */
    toArray(): T[] {
        const values: T[] = new Array<T>(this.count);
        for (let index: number = 0; index < this.count; index += 1) {
            values[index] = this.items[(this.head + index) % this.items.length] as T;
        }
        return values;
    }

    /**
     * Iterate front to back over a snapshot taken when the iterator is created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }

    /**
     * Copy the live values into a fresh ring, front to back.
     */
    private resize(capacity: number): void {
        const next: Array<T | undefined> = new Array<T | undefined>(capacity);
        for (let index: number = 0; index < this.count; index += 1) {
            next[index] = this.items[(this.head + index) % this.items.length];
        }
        this.items = next;
        this.head = 0;
    }

    /**
     * Halve an oversized ring after dequeueing leaves it at most quarter full.
     */
    private shrinkIfSparse(): void {
        if (this.items.length <= InitialCapacity) {
            return;
        }
        if (this.count > this.items.length / 4) {
            return;
        }
        this.resize(this.items.length / 2);
    }
}
