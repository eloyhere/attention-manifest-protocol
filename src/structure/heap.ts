/**
 * Array-backed binary heap.
 *
 * The heap is stored in breadth-first array order: the root is index 0 and the
 * children of index `i` are indices `2i + 1` and `2i + 2`. Push and pop are
 * O(log n), peek is O(1), and constructing from an iterable heapifies in O(n)
 * rather than pushing each value. Duplicate values are allowed; equivalence is
 * decided by the effective comparator.
 */

import { compareNatural, reverseComparator } from "./compare.ts";
import type { Comparator } from "./compare.ts";
import { generatorFrom } from "./iterator.ts";

/**
 * Whether the root is the least or the greatest value under the comparator.
 */
export type HeapOrder = "min" | "max";

/**
 * Construction options for {@link BinaryHeap}.
 */
export interface HeapOptions<T> {
    /**
     * Ordering used to prioritise values. Defaults to {@link compareNatural}.
     */
    compare?: Comparator<T>;
    /**
     * Root priority. Defaults to `'min'`; `'max'` inverts the comparator.
     */
    order?: HeapOrder;
    /**
     * Initial values; supplied values are heapified in O(n).
     */
    values?: Iterable<T>;
}

/**
 * A priority heap with O(log n) insertion and removal.
 *
 * By default the root is the minimum under {@link compareNatural}. Set
 * `order: 'max'` to invert the effective comparator and make the root the
 * maximum. The `compare` option controls priority and may be used for values
 * that have no natural ordering.
 *
 * `toArray` and iteration expose the internal breadth-first heap order, not
 * sorted order: the root comes first, but children may appear in any relative
 * order that satisfies the heap property. Iteration works from a snapshot
 * taken when the iterator is created.
 *
 * `pop`, `peek`, and `replace` return `undefined` when the heap is empty.
 * Because `undefined` remains a valid stored value, check {@link size} or
 * {@link isEmpty} when presence matters. There is intentionally no
 * decrease-key operation.
 *
 * @example
 * ```ts
 * const heap = new BinaryHeap({ values: [4, 1, 7] });
 * heap.peek(); // 1
 * heap.push(0).push(9);
 * heap.pop(); // 0
 * const maxHeap = new BinaryHeap({ order: "max", values: [4, 1, 7] });
 * maxHeap.peek(); // 7
 * ```
 */
export class BinaryHeap<T> implements Iterable<T> {
    private readonly values: T[] = [];
    private readonly compareFn: Comparator<T>;

    /**
     * Create a heap, optionally seeded with values and custom ordering.
     *
     * Seeded values are heapified in O(n). If `order` is `'max'`, the effective
     * comparator is the reverse of `compare`, including when `compare` is the
     * natural-order default.
     *
     * @param options - Comparator, order, and initial values.
     */
    constructor(options?: HeapOptions<T>) {
        const base: Comparator<T> = options?.compare ?? compareNatural;
        this.compareFn = options?.order === "max" ? reverseComparator(base) : base;
        if (options?.values === (void 0)) {
            return;
        }
        const initialValues: T[] = [...options.values];
        for (let index: number = 0; index < initialValues.length; index += 1) {
            this.values.push(initialValues[index]);
        }
        this.heapify();
    }

    /**
     * Build a heap from `values` without repeating the `values` option.
     *
     * @param values - Initial values to heapify in O(n).
     * @param options - Comparator and order options.
     * @returns A new heap containing every supplied value.
     */
    static from<T>(values: Iterable<T>, options?: Omit<HeapOptions<T>, "values">): BinaryHeap<T> {
        const heapOptions: HeapOptions<T> = { values };
        if (options?.compare !== (void 0)) {
            heapOptions.compare = options.compare;
        }
        if (options?.order !== (void 0)) {
            heapOptions.order = options.order;
        }
        return new BinaryHeap<T>(heapOptions);
    }

    /**
     * Number of values currently in the heap.
     */
    get size(): number {
        return this.values.length;
    }

    /**
     * Whether the heap contains no values.
     */
    get isEmpty(): boolean {
        return this.values.length === 0;
    }

    /**
     * Add a value to the heap.
     *
     * @param value - Value to insert.
     * @returns This heap, for chaining.
     */
    push(value: T): this {
        this.values.push(value);
        this.siftUp(this.values.length - 1);
        return this;
    }

    /**
     * Remove and return the root value.
     *
     * @returns The former root, or `undefined` if the heap is empty.
     */
    pop(): T | undefined {
        if (this.values.length === 0) {
            return undefined;
        }
        const root: T = this.values[0];
        const last: T = this.values.pop() as T;
        if (this.values.length > 0) {
            this.values[0] = last;
            this.siftDown(0);
        }
        return root;
    }

    /**
     * Return the root value without removing it.
     *
     * @returns The root value, or `undefined` if the heap is empty.
     */
    peek(): T | undefined {
        if (this.values.length === 0) {
            return undefined;
        }
        return this.values[0];
    }

    /**
     * Replace the root value and restore the heap property in O(log n).
     *
     * On an empty heap this inserts `value` and returns `undefined`, matching
     * the push-then-return-old-root shape.
     *
     * @param value - New root value.
     * @returns The previous root, or `undefined` if the heap was empty.
     */
    replace(value: T): T | undefined {
        if (this.values.length === 0) {
            this.values.push(value);
            return undefined;
        }
        const previousRoot: T = this.values[0];
        this.values[0] = value;
        this.siftDown(0);
        return previousRoot;
    }

    /**
     * Remove every value.
     */
    clear(): void {
        this.values.length = 0;
    }

    /**
     * Snapshot the values in breadth-first heap order.
     *
     * The result is not sorted; it is a copy of the internal array, where only
     * the root is guaranteed to be the highest-priority value.
     *
     * @returns A new array in heap order.
     */
    toArray(): T[] {
        return this.values.slice();
    }

    /**
     * Iterate in breadth-first heap order over a snapshot taken when the
     * iterator is created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }

    /**
     * Restore the heap property bottom-up in O(n).
     */
    private heapify(): void {
        for (let index: number = Math.floor(this.values.length / 2) - 1; index >= 0; index -= 1) {
            this.siftDown(index);
        }
    }

    /**
     * Move a value toward the root until its parent has priority.
     */
    private siftUp(index: number): void {
        let child: number = index;
        while (child > 0) {
            const parent: number = Math.floor((child - 1) / 2);
            if (this.compareFn(this.values[child], this.values[parent]) >= 0) {
                return;
            }
            this.swap(child, parent);
            child = parent;
        }
    }

    /**
     * Move a value toward the leaves until both children have lower priority.
     */
    private siftDown(index: number): void {
        let parent: number = index;
        while (true) {
            const left: number = parent * 2 + 1;
            if (left >= this.values.length) {
                return;
            }
            const right: number = left + 1;
            let first: number = left;
            if (right < this.values.length && this.compareFn(this.values[right], this.values[left]) < 0) {
                first = right;
            }
            if (this.compareFn(this.values[first], this.values[parent]) >= 0) {
                return;
            }
            this.swap(parent, first);
            parent = first;
        }
    }

    /**
     * Exchange two values in the backing array.
     */
    private swap(a: number, b: number): void {
        const temporary: T = this.values[a];
        this.values[a] = this.values[b];
        this.values[b] = temporary;
    }
}
