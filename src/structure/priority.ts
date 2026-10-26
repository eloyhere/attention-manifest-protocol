/**
 * Priority-ordered containers.
 *
 * Every container in this module orders values by a {@link Comparator} and then
 * by arrival: when two values compare equal, the one enqueued first is served
 * first. The queues are therefore stable, and re-inserting an equal value never
 * reorders them.
 *
 * `order: 'max'` is the default and serves the greatest value first, matching
 * the priority convention used elsewhere in this project where a larger number
 * is more urgent; `order: 'min'` serves the smallest first. The comparator
 * decides priority only — it never changes which values are stored.
 *
 * Costs, with `n` entries and `b` live integer priorities:
 *
 * | Container | enqueue | dequeue | peek | re-prioritise |
 * | --- | --- | --- | --- | --- |
 * | {@link PriorityQueue} | O(log n) | O(log n) | O(1) | — |
 * | {@link IndexedPriorityQueue} | O(log n) | O(log n) | O(1) | O(log n) |
 * | {@link BucketQueue} | O(1) | O(1) amortised | O(1) | — |
 * | {@link TopK} | O(log k) | — | O(1) | — |
 *
 * `toArray`, iteration and `drain` expose **dequeue order**, not internal
 * storage order: the contract of a priority queue is the order in which it will
 * be served. This is the deliberate difference from {@link BinaryHeap}, whose
 * snapshots expose heap order. `drain` is the destructive version of `toArray`.
 */

import { compareNatural } from "./compare.ts";
import type { Comparator } from "./compare.ts";
import { BinaryHeap } from "./heap.ts";
import type { HeapOrder } from "./heap.ts";
import { generatorFrom } from "./iterator.ts";

/**
 * The part of a stored entry that ordering depends on: a value and the sequence
 * number that decides ties.
 */
interface Sequenced<T> {
    value: T;
    sequence: number;
}

/**
 * One FIFO bucket inside a {@link BucketQueue}.
 *
 * `head` advances through `values` as entries are served. Consumed slots are
 * compacted away once they outnumber the live ones, so a bucket that is drained
 * slowly does not pin its served entries forever.
 */
interface Bucket<T> {
    values: T[];
    head: number;
}

/**
 * Sign multiplier that turns a comparator into the serving order of a heap:
 * the smallest result is served first, so `'max'` inverts the comparator.
 */
const servingDirection: (order: HeapOrder) => number = (order: HeapOrder): number => {
    return order === "max" ? -1 : 1;
};

/**
 * Sign multiplier for "better than": a positive result means the left value is
 * better, so `'max'` keeps the comparator as it is.
 */
const qualityDirection: (order: HeapOrder) => number = (order: HeapOrder): number => {
    return order === "max" ? 1 : -1;
};

/**
 * Compare two stored entries: priority first, then arrival order.
 *
 * The multiplier is applied before the tie-break, so reversing the order flips
 * priorities without reversing equal entries. Arrival order is always the
 * earlier sequence first, which is what makes every queue in this module
 * stable.
 */
type EntryComparator = <T>(compare: Comparator<T>, direction: number) => Comparator<Sequenced<T>>;

const entryComparator: EntryComparator = <T>(compare: Comparator<T>, direction: number): Comparator<Sequenced<T>> => {
    return (left: Sequenced<T>, right: Sequenced<T>): number => {
        const byPriority: number = direction * compare(left.value, right.value);
        if (byPriority !== 0) {
            return byPriority;
        }
        return left.sequence - right.sequence;
    };
};

/**
 * Reject a capacity that cannot bound a container.
 */
const requireCapacity: (capacity: number) => void = (capacity: number): void => {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new RangeError("capacity must be a positive safe integer");
    }
};

/**
 * Options for {@link PriorityQueue}.
 */
export interface PriorityQueueOptions<T> {
    /**
     * Ordering that decides priority. Defaults to {@link compareNatural}.
     */
    compare?: Comparator<T>;
    /**
     * Which end is served first. Defaults to `'max'`.
     */
    order?: HeapOrder;
    /**
     * Initial values, enqueued in iteration order.
     */
    values?: Iterable<T>;
}

/**
 * A stable priority queue backed by a binary heap.
 *
 * The value that compares greatest under `compare` is served first by default;
 * `order: 'min'` serves the least. Ties are broken by arrival, so two entries
 * with the same priority always leave in the order they were enqueued.
 *
 * `enqueue` and `dequeue` are O(log n), and `peek` is O(1). `toArray`,
 * iteration and `drain` return **dequeue order**; `drain` removes everything.
 *
 * `dequeue` and `peek` return `undefined` when the queue is empty. Because
 * `undefined` is also a valid stored value, check {@link size} or
 * {@link isEmpty} when presence matters.
 *
 * @example
 * ```ts
 * const queue = new PriorityQueue<number>({ values: [3, 1, 4, 1] });
 * queue.enqueue(2);
 * queue.dequeue(); // 4
 * [...queue];      // [3, 2, 1, 1]
 * queue.drain();   // [3, 2, 1, 1]
 * ```
 */
export class PriorityQueue<T> implements Iterable<T> {
    private readonly heap: BinaryHeap<Sequenced<T>>;
    private readonly compareFn: Comparator<Sequenced<T>>;
    private sequence = 0;

    /**
     * Create a queue, optionally seeded with values and a custom ordering.
     *
     * Seeded values are enqueued in iteration order, so among equal priorities
     * the first seeded value is served first.
     *
     * @param options - Comparator, order, and initial values.
     */
    constructor(options?: PriorityQueueOptions<T>) {
        const compare: Comparator<T> = options?.compare ?? compareNatural;
        const order: HeapOrder = options?.order ?? "max";
        this.compareFn = entryComparator<T>(compare, servingDirection(order));
        this.heap = new BinaryHeap<Sequenced<T>>({ compare: this.compareFn });
        if (options?.values !== (void 0)) {
            this.enqueueAll(options.values);
        }
    }

    /**
     * Build a queue from `values` without repeating the `values` option.
     *
     * @param values - Initial values to enqueue in iteration order.
     * @param options - Comparator and order options.
     * @returns A new priority queue containing every supplied value.
     */
    static from<T>(values: Iterable<T>, options?: Omit<PriorityQueueOptions<T>, "values">): PriorityQueue<T> {
        const queueOptions: PriorityQueueOptions<T> = { values };
        if (options?.compare !== (void 0)) {
            queueOptions.compare = options.compare;
        }
        if (options?.order !== (void 0)) {
            queueOptions.order = options.order;
        }
        return new PriorityQueue<T>(queueOptions);
    }

    /**
     * Number of values currently in the queue.
     */
    get size(): number {
        return this.heap.size;
    }

    /**
     * Whether the queue contains no values.
     */
    get isEmpty(): boolean {
        return this.heap.isEmpty;
    }

    /**
     * Add a value at its priority, behind any equal value already queued.
     *
     * @param value - Value to enqueue.
     * @returns This queue, for chaining.
     */
    enqueue(value: T): this {
        const entry: Sequenced<T> = { value, sequence: this.sequence };
        this.sequence += 1;
        this.heap.push(entry);
        return this;
    }

    /**
     * Enqueue every value in iteration order.
     *
     * @param values - Values to enqueue.
     * @returns This queue, for chaining.
     */
    enqueueAll(values: Iterable<T>): this {
        const items: T[] = [...values];
        for (let index: number = 0; index < items.length; index += 1) {
            this.enqueue(items[index]);
        }
        return this;
    }

    /**
     * Remove and return the value with the highest priority.
     *
     * @returns The served value, or `undefined` if the queue is empty.
     */
    dequeue(): T | undefined {
        const entry: Sequenced<T> | undefined = this.heap.pop();
        return entry === (void 0) ? undefined : entry.value;
    }

    /**
     * Return the value that would be served next, without removing it.
     *
     * @returns The next value, or `undefined` if the queue is empty.
     */
    peek(): T | undefined {
        const entry: Sequenced<T> | undefined = this.heap.peek();
        return entry === (void 0) ? undefined : entry.value;
    }

    /**
     * Remove every value and reset the arrival counter.
     */
    clear(): void {
        this.heap.clear();
        this.sequence = 0;
    }

    /**
     * Snapshot the values in dequeue order without changing the queue.
     *
     * The cost is O(n log n): the heap is copied, then sorted by the same
     * comparator the queue uses.
     *
     * @returns A new array whose first item is served first.
     */
    toArray(): T[] {
        const entries: Sequenced<T>[] = this.heap.toArray();
        entries.sort(this.compareFn);
        return entries.map((entry: Sequenced<T>): T => entry.value);
    }

    /**
     * Remove and return every value in dequeue order.
     *
     * @returns A new array in the order the values would have been served.
     */
    drain(): T[] {
        const values: T[] = [];
        while (!this.heap.isEmpty) {
            const entry: Sequenced<T> | undefined = this.heap.pop();
            if (entry !== (void 0)) {
                values.push(entry.value);
            }
        }
        return values;
    }

    /**
     * Iterate in dequeue order over a snapshot taken when the iterator is
     * created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }
}

/**
 * Options for {@link IndexedPriorityQueue}.
 */
export interface IndexedPriorityQueueOptions<K, T> {
    /**
     * Derives the key that identifies a value. It is evaluated once per
     * {@link IndexedPriorityQueue.set}.
     */
    keyOf: (value: T) => K;
    /**
     * Ordering that decides priority. Defaults to {@link compareNatural}.
     */
    compare?: Comparator<T>;
    /**
     * Which end is served first. Defaults to `'max'`.
     */
    order?: HeapOrder;
}

/**
 * A keyed entry stored by {@link IndexedPriorityQueue}.
 */
interface KeyedEntry<K, T> extends Sequenced<T> {
    key: K;
}

/**
 * A priority queue that can be addressed by key.
 *
 * A plain {@link PriorityQueue} cannot re-prioritise or remove an entry it has
 * already accepted, because finding it costs a scan. This queue keeps a map
 * from key to heap position, so `set`, `delete`, `get` and `has` are O(log n)
 * or O(1) — the shape Dijkstra's algorithm and task schedulers need.
 *
 * `set` inserts a new key or replaces the value stored under an existing one.
 * A replaced entry keeps its original arrival sequence, so re-setting an entry
 * at an unchanged priority does not move it behind entries that arrived later.
 * Ties are still served in arrival order.
 *
 * `toArray` and `keys` are O(n log n) snapshots in dequeue order; `dequeue`,
 * `peek`, `get` and `delete` do not scan.
 *
 * @example
 * ```ts
 * const queue = new IndexedPriorityQueue<string, Task>({
 *     keyOf: (task: Task): string => task.id,
 *     compare: (left: Task, right: Task): number => left.rank - right.rank,
 * });
 * queue.set({ id: "a", rank: 2 }).set({ id: "b", rank: 5 });
 * queue.peek()?.id;          // "b"
 * queue.set({ id: "a", rank: 9 });
 * queue.dequeue()?.id;       // "a"
 * queue.delete("b");         // true
 * ```
 */
export class IndexedPriorityQueue<K, T> implements Iterable<T> {
    private readonly entries: KeyedEntry<K, T>[] = [];
    private readonly positions = new Map<K, number>();
    private readonly keyOf: (value: T) => K;
    private readonly compareFn: Comparator<Sequenced<T>>;
    private sequence = 0;

    /**
     * Create an empty keyed queue.
     *
     * @param options - Key selector, comparator and order.
     */
    constructor(options: IndexedPriorityQueueOptions<K, T>) {
        const compare: Comparator<T> = options.compare ?? compareNatural;
        const order: HeapOrder = options.order ?? "max";
        this.keyOf = options.keyOf;
        this.compareFn = entryComparator<T>(compare, servingDirection(order));
    }

    /**
     * Number of entries currently in the queue.
     */
    get size(): number {
        return this.entries.length;
    }

    /**
     * Whether the queue contains no entries.
     */
    get isEmpty(): boolean {
        return this.entries.length === 0;
    }

    /**
     * Insert a value, or replace the value stored under its key.
     *
     * A new key is appended behind entries with equal priority. An existing key
     * keeps its arrival sequence and only moves if its priority changed.
     *
     * @param value - Value to insert or replace.
     * @returns This queue, for chaining.
     */
    set(value: T): this {
        const key: K = this.keyOf(value);
        const index: number | undefined = this.positions.get(key);
        if (index === (void 0)) {
            const entry: KeyedEntry<K, T> = { key, value, sequence: this.sequence };
            this.sequence += 1;
            this.positions.set(key, this.entries.length);
            this.entries.push(entry);
            this.siftUp(this.entries.length - 1);
            return this;
        }
        const entry: KeyedEntry<K, T> = this.entries[index];
        entry.value = value;
        const moved: number = this.siftUp(index);
        this.siftDown(moved);
        return this;
    }

    /**
     * Remove the entry stored under `key`.
     *
     * @param key - Key to remove.
     * @returns `true` if an entry was removed, `false` if the key was absent.
     */
    delete(key: K): boolean {
        const index: number | undefined = this.positions.get(key);
        if (index === (void 0)) {
            return false;
        }
        this.removeAt(index);
        return true;
    }

    /**
     * Read the value stored under `key` without changing the queue.
     *
     * @param key - Key to read.
     * @returns The stored value, or `undefined` if the key is absent.
     */
    get(key: K): T | undefined {
        const index: number | undefined = this.positions.get(key);
        return index === (void 0) ? undefined : this.entries[index].value;
    }

    /**
     * Whether an entry is stored under `key`.
     *
     * @param key - Key to test.
     */
    has(key: K): boolean {
        return this.positions.has(key);
    }

    /**
     * Remove and return the value with the highest priority.
     *
     * @returns The served value, or `undefined` if the queue is empty.
     */
    dequeue(): T | undefined {
        if (this.entries.length === 0) {
            return undefined;
        }
        return this.removeAt(0).value;
    }

    /**
     * Return the value that would be served next, without removing it.
     *
     * @returns The next value, or `undefined` if the queue is empty.
     */
    peek(): T | undefined {
        return this.entries.length === 0 ? undefined : this.entries[0].value;
    }

    /**
     * Return the key that would be served next, without removing it.
     *
     * @returns The next key, or `undefined` if the queue is empty.
     */
    peekKey(): K | undefined {
        return this.entries.length === 0 ? undefined : this.entries[0].key;
    }

    /**
     * Remove every entry.
     */
    clear(): void {
        this.entries.length = 0;
        this.positions.clear();
        this.sequence = 0;
    }

    /**
     * Snapshot the values in dequeue order.
     *
     * @returns A new array whose first item is served first.
     */
    toArray(): T[] {
        const ordered: Sequenced<T>[] = this.entries.slice();
        ordered.sort(this.compareFn);
        return ordered.map((entry: Sequenced<T>): T => entry.value);
    }

    /**
     * Snapshot the keys in dequeue order.
     *
     * @returns A new array whose first key is served first.
     */
    keys(): K[] {
        const ordered: KeyedEntry<K, T>[] = this.entries.slice();
        ordered.sort(this.compareFn);
        return ordered.map((entry: KeyedEntry<K, T>): K => entry.key);
    }

    /**
     * Iterate in dequeue order over a snapshot taken when the iterator is
     * created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }

    /**
     * Remove the entry at `index` and return it.
     *
     * The last entry fills the hole, then moves either up or down to restore
     * the heap property; the key index follows both moves.
     */
    private removeAt(index: number): KeyedEntry<K, T> {
        const removed: KeyedEntry<K, T> = this.entries[index];
        const lastIndex: number = this.entries.length - 1;
        const last: KeyedEntry<K, T> = this.entries[lastIndex];
        this.entries.pop();
        this.positions.delete(removed.key);
        if (index !== lastIndex) {
            this.entries[index] = last;
            this.positions.set(last.key, index);
            const moved: number = this.siftUp(index);
            this.siftDown(moved);
        }
        return removed;
    }

    /**
     * Move an entry toward the root until its parent has priority.
     *
     * @returns The index the entry ended up at.
     */
    private siftUp(index: number): number {
        let child: number = index;
        while (child > 0) {
            const parent: number = Math.floor((child - 1) / 2);
            if (this.compareFn(this.entries[child], this.entries[parent]) >= 0) {
                return child;
            }
            this.swap(child, parent);
            child = parent;
        }
        return child;
    }

    /**
     * Move an entry toward the leaves until both children have lower priority.
     */
    private siftDown(index: number): void {
        let parent: number = index;
        while (true) {
            const left: number = parent * 2 + 1;
            if (left >= this.entries.length) {
                return;
            }
            const right: number = left + 1;
            let first: number = left;
            if (right < this.entries.length && this.compareFn(this.entries[right], this.entries[left]) < 0) {
                first = right;
            }
            if (this.compareFn(this.entries[first], this.entries[parent]) >= 0) {
                return;
            }
            this.swap(parent, first);
            parent = first;
        }
    }

    /**
     * Exchange two entries and keep the key index consistent.
     */
    private swap(a: number, b: number): void {
        const left: KeyedEntry<K, T> = this.entries[a];
        const right: KeyedEntry<K, T> = this.entries[b];
        this.entries[a] = right;
        this.entries[b] = left;
        this.positions.set(right.key, a);
        this.positions.set(left.key, b);
    }
}

/**
 * Options for {@link BucketQueue}.
 */
export interface BucketQueueOptions {
    /**
     * Which end is served first. Defaults to `'max'`.
     */
    order?: HeapOrder;
}

/**
 * A priority queue for integer priorities, with one FIFO bucket per priority.
 *
 * Values sharing a priority wait in a single bucket, so serving the next entry
 * costs O(1) until the active bucket empties; switching to the next live bucket
 * costs O(log b) once, where `b` is the number of non-empty buckets. This is
 * the right shape when priorities come from a small domain — scheduler ticks,
 * T-shirt sizes, the 0–100 behaviour priorities used in this project — and the
 * per-entry generality of a comparison heap is wasted.
 *
 * Priorities must be safe integers; anything else raises a `RangeError`, since
 * a bucket index cannot represent it. Negative priorities are fine, and the
 * live priorities need not be contiguous: only buckets that hold values are
 * tracked.
 *
 * @example
 * ```ts
 * const queue = new BucketQueue<string>();
 * queue.enqueue("cold", 0).enqueue("warm", 1).enqueue("hot", 9);
 * queue.dequeue();          // "hot"
 * queue.peekPriority();     // 1
 * queue.toArray();          // ["warm", "cold"]
 * ```
 */
export class BucketQueue<T> implements Iterable<T> {
    private readonly buckets = new Map<number, Bucket<T>>();
    private readonly active: BinaryHeap<number>;
    private readonly order: HeapOrder;
    private count = 0;

    /**
     * Create an empty bucket queue.
     *
     * @param options - Which end is served first.
     */
    constructor(options?: BucketQueueOptions) {
        this.order = options?.order ?? "max";
        this.active = new BinaryHeap<number>({ order: this.order });
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
     * Append a value to the bucket for `priority`.
     *
     * Values with the same priority leave in enqueue order.
     *
     * @param value - Value to enqueue.
     * @param priority - Integer priority; greater is served first by default.
     * @returns This queue, for chaining.
     */
    enqueue(value: T, priority: number): this {
        if (!Number.isSafeInteger(priority)) {
            throw new RangeError("priority must be a safe integer");
        }
        let bucket: Bucket<T> | undefined = this.buckets.get(priority);
        if (bucket === (void 0)) {
            bucket = { values: [], head: 0 };
            this.buckets.set(priority, bucket);
            this.active.push(priority);
        }
        bucket.values.push(value);
        this.count += 1;
        return this;
    }

    /**
     * Remove and return the value with the highest priority.
     *
     * @returns The served value, or `undefined` if the queue is empty.
     */
    dequeue(): T | undefined {
        const priority: number | undefined = this.peekPriority();
        if (priority === (void 0)) {
            return undefined;
        }
        const bucket: Bucket<T> | undefined = this.buckets.get(priority);
        if (bucket === (void 0)) {
            return undefined;
        }
        const value: T = bucket.values[bucket.head];
        bucket.head += 1;
        this.count -= 1;
        if (bucket.head === bucket.values.length) {
            this.buckets.delete(priority);
            this.active.pop();
        } else if (bucket.head > 32 && bucket.head * 2 >= bucket.values.length) {
            bucket.values = bucket.values.slice(bucket.head);
            bucket.head = 0;
        }
        return value;
    }

    /**
     * Return the value that would be served next, without removing it.
     *
     * @returns The next value, or `undefined` if the queue is empty.
     */
    peek(): T | undefined {
        const priority: number | undefined = this.peekPriority();
        if (priority === (void 0)) {
            return undefined;
        }
        const bucket: Bucket<T> | undefined = this.buckets.get(priority);
        return bucket === (void 0) ? undefined : bucket.values[bucket.head];
    }

    /**
     * Priority of the next entry to be served, without removing it.
     *
     * @returns The next priority, or `undefined` if the queue is empty.
     */
    peekPriority(): number | undefined {
        while (!this.active.isEmpty) {
            const priority: number | undefined = this.active.peek();
            if (priority !== (void 0) && this.buckets.has(priority)) {
                return priority;
            }
            this.active.pop();
        }
        return undefined;
    }

    /**
     * Remove every value.
     */
    clear(): void {
        this.buckets.clear();
        this.active.clear();
        this.count = 0;
    }

    /**
     * Snapshot the values in dequeue order without changing the queue.
     *
     * @returns A new array whose first item is served first.
     */
    toArray(): T[] {
        const priorities: number[] = [...this.buckets.keys()];
        priorities.sort((left: number, right: number): number => {
            return this.order === "max" ? right - left : left - right;
        });
        const values: T[] = [];
        for (let priorityIndex: number = 0; priorityIndex < priorities.length; priorityIndex += 1) {
            const priority: number = priorities[priorityIndex];
            const bucket: Bucket<T> | undefined = this.buckets.get(priority);
            if (bucket === (void 0)) {
                continue;
            }
            for (let index: number = bucket.head; index < bucket.values.length; index += 1) {
                values.push(bucket.values[index]);
            }
        }
        return values;
    }

    /**
     * Iterate in dequeue order over a snapshot taken when the iterator is
     * created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }
}

/**
 * Options for {@link TopK}.
 */
export interface TopKOptions<T> {
    /**
     * Ordering that decides which values are best. Defaults to
     * {@link compareNatural}.
     */
    compare?: Comparator<T>;
    /**
     * Which end is best. Defaults to `'max'`, so the greatest values are kept.
     */
    order?: HeapOrder;
}

/**
 * The `k` best values seen so far, in a bounded buffer.
 *
 * `offer` keeps the best `capacity` values under the comparator and discards
 * the rest, in O(log k): the retained values live in a heap whose root is the
 * current worst, so a new value only displaces that root. A value equal to the
 * worst is refused rather than swapping equal entries, which keeps the buffer
 * stable and its contents independent of later arrivals.
 *
 * The buffer is useful when a full sort is wasteful — for example keeping the
 * `k` most salient candidates out of a stream that never ends.
 *
 * @example
 * ```ts
 * const best = new TopK<number>(3);
 * for (const value of [5, 1, 9, 3, 7]) {
 *     best.offer(value);
 * }
 * best.toArray(); // [9, 7, 5]
 * best.worst;     // 5
 * ```
 */
export class TopK<T> implements Iterable<T> {
    /**
     * Maximum number of values retained.
     */
    readonly capacity: number;
    private readonly retained: BinaryHeap<T>;
    private readonly compareFn: Comparator<T>;
    private readonly quality: number;

    /**
     * Create an empty buffer for the `capacity` best values.
     *
     * @param capacity - Maximum number of values retained; positive integer.
     * @param options - Comparator and which end is best.
     */
    constructor(capacity: number, options?: TopKOptions<T>) {
        requireCapacity(capacity);
        this.capacity = capacity;
        this.compareFn = options?.compare ?? compareNatural;
        this.quality = qualityDirection(options?.order ?? "max");
        this.retained = new BinaryHeap<T>({
            compare: (left: T, right: T): number => this.signedCompare(left, right),
        });
    }

    /**
     * Number of values currently retained.
     */
    get size(): number {
        return this.retained.size;
    }

    /**
     * Whether the buffer holds `capacity` values.
     */
    get isFull(): boolean {
        return this.retained.size >= this.capacity;
    }

    /**
     * The weakest retained value: the next one to be displaced.
     *
     * @returns The current worst value, or `undefined` if nothing is retained.
     */
    get worst(): T | undefined {
        return this.retained.peek();
    }

    /**
     * Offer a value to the buffer.
     *
     * A value is retained while there is room; once full, only a value that
     * strictly outranks {@link worst} is kept and the worst is displaced. A tie
     * keeps the value that arrived first.
     *
     * @param value - Value to offer.
     * @returns `true` if the value is retained afterwards, `false` otherwise.
     */
    offer(value: T): boolean {
        if (!this.isFull) {
            this.retained.push(value);
            return true;
        }
        const worst: T | undefined = this.retained.peek();
        if (worst === (void 0)) {
            return false;
        }
        if (this.signedCompare(value, worst) <= 0) {
            return false;
        }
        this.retained.replace(value);
        return true;
    }

    /**
     * Discard every retained value.
     */
    clear(): void {
        this.retained.clear();
    }

    /**
     * Snapshot the retained values, best first.
     *
     * @returns A new array in dequeue order.
     */
    toArray(): T[] {
        const values: T[] = this.retained.toArray();
        values.sort((left: T, right: T): number => this.signedCompare(right, left));
        return values;
    }

    /**
     * Iterate best first over a snapshot taken when the iterator is created.
     */
    [Symbol.iterator](): Generator<T, void, unknown> {
        return generatorFrom(this.toArray());
    }

    /**
     * Compare two values so that a positive result means the left one is
     * better, whichever order is in effect.
     */
    private signedCompare(left: T, right: T): number {
        return this.quality * this.compareFn(left, right);
    }
}
