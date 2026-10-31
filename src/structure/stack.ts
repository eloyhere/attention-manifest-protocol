/**
 * Array-backed last-in, first-out stack.
 *
 * The implementation keeps its values in a native array, so `push` and `pop`
 * are O(1) amortized. Iteration visits the top first and works from a snapshot
 * taken when the iterator is created, so the traversal is not disturbed by
 * later pushes or pops.
 */

import { generatorFrom } from "./iterator.ts";

/**
 * A last-in, first-out stack.
 *
 * `pop` and `peek` return `undefined` when the stack is empty rather than
 * throwing. Since `undefined` is also a valid stored value, use {@link size} or
 * {@link isEmpty} when presence must be distinguished from absence.
 *
 * Iteration is top-to-bottom.
 *
 * @example
 * ```ts
 * const stack = new Stack([1, 2, 3]);
 * stack.peek(); // 3
 * stack.pop(); // 3
 * [...stack]; // [2, 1]
 * ```
 */
export class Stack<T> implements Iterable<T> {
    private readonly items: T[] = [];

    /**
     * Create a stack, optionally seeded from `values`.
     *
     * Values are pushed in iteration order, so the last value becomes the top.
     *
     * @param values - Values to push, in order.
     */
    constructor(values?: Iterable<T>) {
        if (values === (void 0)) {
            return;
        }
        const initialValues: T[] = [...values];
        for (let index: number = 0; index < initialValues.length; index += 1) {
            const value: T = initialValues[index];
            this.items.push(value);
        }
    }

    /**
     * Number of values currently on the stack.
     */
    get size(): number {
        return this.items.length;
    }

    /**
     * Whether the stack contains no values.
     */
    get isEmpty(): boolean {
        return this.items.length === 0;
    }

    /**
     * Push a value onto the top.
     *
     * @param value - Value to push.
     * @returns This stack, for chaining.
     */
    push(value: T): this {
        this.items.push(value);
        return this;
    }

    /**
     * Remove and return the top value.
     *
     * @returns The former top value, or `undefined` if the stack is empty.
     */
    pop(): T | undefined {
        return this.items.pop();
    }

    /**
     * Return the top value without removing it.
     *
     * @returns The top value, or `undefined` if the stack is empty.
     */
    peek(): T | undefined {
        if (this.items.length === 0) {
            return undefined;
        }
        return this.items[this.items.length - 1];
    }

    /**
     * Remove every value.
     */
    clear(): void {
        this.items.length = 0;
    }

    /**
     * Snapshot the stack from top to bottom.
     *
     * @returns A new array whose first item is the top of the stack.
     */
    toArray(): T[] {
        return this.items.slice().reverse();
    }

    /**
     * Iterate top to bottom over a snapshot taken when the iterator is created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }
}
