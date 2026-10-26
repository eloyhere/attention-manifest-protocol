/**
 * Array-backed double-ended queue.
 *
 * Values live in a circular buffer addressed by a head index and a count, so
 * both the front and back of the logical sequence can be updated in O(1)
 * amortized time without moving the other values. The buffer is not required
 * to have a power-of-two length; it doubles when full and halves after a pop
 * leaves it at most quarter full. Popped slots are cleared so the ring does not
 * retain references to removed values.
 */

import { generatorFrom } from "./iterator.ts";

const INITIAL_CAPACITY = 8;

/**
 * A double-ended queue.
 *
 * Values can be added and removed at either end. `popFront`, `popBack`,
 * `peekFront`, and `peekBack` return `undefined` when the deque is empty rather
 * than throwing. Since `undefined` is also a valid stored value, use
 * {@link size} or {@link isEmpty} when presence must be distinguished from
 * absence.
 *
 * Iteration is front-to-back.
 *
 * @example
 * ```ts
 * const deque = new Deque([2, 3]);
 * deque.pushFront(1).pushBack(4);
 * [...deque]; // [1, 2, 3, 4]
 * ```
 */
export class Deque<T> implements Iterable<T> {
    private items: Array<T | undefined> = new Array<T | undefined>(INITIAL_CAPACITY);
    private head = 0;
    private count = 0;

    /**
     * Create a deque, optionally seeded from `values`.
     *
     * Values are pushed onto the back in iteration order, so the last value
     * becomes the back.
     *
     * @param values - Values to insert, in order.
     */
    constructor(values?: Iterable<T>) {
        if (values === (void 0)) {
            return;
        }
        for (const value of values) {
            this.pushBack(value);
        }
    }

    /**
     * Number of values currently in the deque.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Whether the deque contains no values.
     */
    get isEmpty(): boolean {
        return this.count === 0;
    }

    /**
     * Add a value at the front of the deque.
     *
     * @param value - Value to insert.
     * @returns This deque, for chaining.
     */
    pushFront(value: T): this {
        if (this.count === this.items.length) {
            this.resize(this.items.length * 2);
        }
        this.head = (this.head - 1 + this.items.length) % this.items.length;
        this.items[this.head] = value;
        this.count += 1;
        return this;
    }

    /**
     * Add a value at the back of the deque.
     *
     * @param value - Value to insert.
     * @returns This deque, for chaining.
     */
    pushBack(value: T): this {
        if (this.count === this.items.length) {
            this.resize(this.items.length * 2);
        }
        const tail = (this.head + this.count) % this.items.length;
        this.items[tail] = value;
        this.count += 1;
        return this;
    }

    /**
     * Alias of {@link pushBack}.
     *
     * @param value - Value to insert at the back.
     * @returns This deque, for chaining.
     */
    push(value: T): this {
        return this.pushBack(value);
    }

    /**
     * Remove and return the value at the front of the deque.
     *
     * @returns The former front value, or `undefined` if the deque is empty.
     */
    popFront(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        const value = this.items[this.head] as T;
        this.items[this.head] = undefined;
        this.head = (this.head + 1) % this.items.length;
        this.count -= 1;
        this.shrinkIfSparse();
        return value;
    }

    /**
     * Remove and return the value at the back of the deque.
     *
     * @returns The former back value, or `undefined` if the deque is empty.
     */
    popBack(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        const tail = (this.head + this.count - 1) % this.items.length;
        const value = this.items[tail] as T;
        this.items[tail] = undefined;
        this.count -= 1;
        this.shrinkIfSparse();
        return value;
    }

    /**
     * Return the value at the front without removing it.
     *
     * @returns The front value, or `undefined` if the deque is empty.
     */
    peekFront(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        return this.items[this.head] as T;
    }

    /**
     * Return the value at the back without removing it.
     *
     * @returns The back value, or `undefined` if the deque is empty.
     */
    peekBack(): T | undefined {
        if (this.count === 0) {
            return undefined;
        }
        return this.items[(this.head + this.count - 1) % this.items.length] as T;
    }

    /**
     * Remove every value and reset the ring to its initial capacity.
     */
    clear(): void {
        this.items = new Array<T | undefined>(INITIAL_CAPACITY);
        this.head = 0;
        this.count = 0;
    }

    /**
     * Snapshot the deque from front to back.
     *
     * @returns A new array whose first item is the front of the deque.
     */
    toArray(): T[] {
        const values = new Array<T>(this.count);
        for (let index = 0; index < this.count; index += 1) {
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
        const next = new Array<T | undefined>(capacity);
        for (let index = 0; index < this.count; index += 1) {
            next[index] = this.items[(this.head + index) % this.items.length];
        }
        this.items = next;
        this.head = 0;
    }

    /**
     * Halve an oversized ring after a pop leaves it at most quarter full.
     */
    private shrinkIfSparse(): void {
        if (this.items.length <= INITIAL_CAPACITY) {
            return;
        }
        if (this.count > this.items.length / 4) {
            return;
        }
        this.resize(this.items.length / 2);
    }
}
