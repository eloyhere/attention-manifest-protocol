/**
 * Least-recently-used containers.
 *
 * All keyed caches in this module use the same policy:
 *
 * - `get` and an existing-key `set` mark the entry most recently used;
 * - `has` and `peek` do not change recency;
 * - inserting past `capacity` evicts the least recently used entry;
 * - deleting and re-adding a key makes it the most recently used entry.
 *
 * The ordered variants iterate in insertion order, inherited from
 * `OrderedMap` / `OrderedSet`; the unordered variants iterate in bucket order.
 * Recency is tracked separately by {@link LRUList} and is independent of
 * iteration order.
 */

import { OrderedMap } from "./ordered.ts";
import { UnorderedMap } from "./unordered.ts";
import type { KeyStrategy } from "./hash.ts";

/**
 * A node in an LRU list. `owner` is maintained by {@link LRUList}.
 */
export class LRUListNode<T> {
    value: T;
    previous: LRUListNode<T> | null = null;
    next: LRUListNode<T> | null = null;
    /**
     * @internal The list that currently owns this node, if any.
     */
    owner: LRUList<T> | null = null;

    constructor(value: T) {
        this.value = value;
    }
}

/**
 * Doubly linked recency list.
 *
 * The front is the most recently used entry and the back is the least recently
 * used entry. Nodes returned by `pushFront`/`pushBack` can later be moved or
 * removed in O(1). Iteration is front-to-back over the live list; mutating the
 * list during iteration is not supported.
 */
export class LRUList<T> implements Iterable<T> {
    private headNode: LRUListNode<T> | null = null;
    private tailNode: LRUListNode<T> | null = null;
    private count = 0;

    /**
     * Seed the list front-to-back from `values`.
     */
    constructor(values?: Iterable<T>) {
        if (values === (void 0)) {
            return;
        }
        for (const value of values) {
            this.pushBack(value);
        }
    }

    get size(): number {
        return this.count;
    }

    get isEmpty(): boolean {
        return this.count === 0;
    }

    /**
     * Most recently used value, if any.
     */
    get front(): T | undefined {
        return this.headNode?.value;
    }

    /**
     * Least recently used value, if any.
     */
    get back(): T | undefined {
        return this.tailNode?.value;
    }

    /**
     * Insert at the front and return the owned node.
     */
    pushFront(value: T): LRUListNode<T> {
        const node = new LRUListNode(value);
        node.owner = this;
        node.next = this.headNode;
        if (this.headNode !== null) {
            this.headNode.previous = node;
        } else {
            this.tailNode = node;
        }
        this.headNode = node;
        this.count += 1;
        return node;
    }

    /**
     * Insert at the back and return the owned node.
     */
    pushBack(value: T): LRUListNode<T> {
        const node = new LRUListNode(value);
        node.owner = this;
        node.previous = this.tailNode;
        if (this.tailNode !== null) {
            this.tailNode.next = node;
        } else {
            this.headNode = node;
        }
        this.tailNode = node;
        this.count += 1;
        return node;
    }

    /**
     * Remove a node owned by this list.
     */
    remove(node: LRUListNode<T>): boolean {
        if (node.owner !== this) {
            return false;
        }
        this.detach(node);
        node.owner = null;
        this.count -= 1;
        return true;
    }

    /**
     * Move an owned node to the front without changing the size.
     */
    moveToFront(node: LRUListNode<T>): boolean {
        if (node.owner !== this) {
            return false;
        }
        if (this.headNode === node) {
            return true;
        }
        this.detach(node);
        node.next = this.headNode;
        if (this.headNode !== null) {
            this.headNode.previous = node;
        } else {
            this.tailNode = node;
        }
        this.headNode = node;
        return true;
    }

    /**
     * Remove and return the front value.
     */
    popFront(): T | undefined {
        if (this.headNode === null) {
            return undefined;
        }
        const value = this.headNode.value;
        this.remove(this.headNode);
        return value;
    }

    /**
     * Remove and return the back value.
     */
    popBack(): T | undefined {
        if (this.tailNode === null) {
            return undefined;
        }
        const value = this.tailNode.value;
        this.remove(this.tailNode);
        return value;
    }

    /**
     * Remove every node and release its owner link.
     */
    clear(): void {
        let node = this.headNode;
        while (node !== null) {
            const next = node.next;
            node.owner = null;
            node.previous = null;
            node.next = null;
            node = next;
        }
        this.headNode = null;
        this.tailNode = null;
        this.count = 0;
    }

    /**
     * Snapshot front-to-back.
     */
    toArray(): T[] {
        const values: T[] = [];
        for (const value of this) {
            values.push(value);
        }
        return values;
    }

    /**
     * Iterate front-to-back over the live list.
     */
    *[Symbol.iterator](): Generator<T> {
        let node = this.headNode;
        while (node !== null) {
            const next = node.next;
            yield node.value;
            node = next;
        }
    }

    /**
     * Unlink a node without changing ownership or count.
     */
    private detach(node: LRUListNode<T>): void {
        if (node.previous !== null) {
            node.previous.next = node.next;
        } else {
            this.headNode = node.next;
        }
        if (node.next !== null) {
            node.next.previous = node.previous;
        } else {
            this.tailNode = node.previous;
        }
        node.previous = null;
        node.next = null;
    }
}

interface LruEntry<K, V> {
    key: K;
    value: V;
}

/**
 * Minimal ordered/unordered map surface used by the shared LRU map base.
 */
interface LruIndex<K, V> {
    get(key: K): V | undefined;
    set(key: K, value: V): unknown;
    has(key: K): boolean;
    delete(key: K): boolean;
    clear(): void;
    readonly size: number;
    keys(): Generator<K>;
    values(): Generator<V>;
    entries(): Generator<[K, V]>;
}

/**
 * Shared implementation behind the two keyed LRU maps.
 *
 * The index provides membership and the public iteration order; the list
 * provides recency. Keeping them separate is what lets the ordered variants
 * retain insertion order while still evicting by recency.
 */
class LruMapBase<K, V> {
    readonly capacity: number;
    private readonly index: LruIndex<K, LRUListNode<LruEntry<K, V>>>;
    private readonly order = new LRUList<LruEntry<K, V>>();

    protected constructor(capacity: number, index: LruIndex<K, LRUListNode<LruEntry<K, V>>>) {
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new RangeError("capacity must be a positive safe integer");
        }
        this.capacity = capacity;
        this.index = index;
    }

    get size(): number {
        return this.index.size;
    }

    get isFull(): boolean {
        return this.size >= this.capacity;
    }

    has(key: K): boolean {
        return this.index.has(key);
    }

    /**
     * Read without changing recency.
     */
    peek(key: K): V | undefined {
        return this.index.get(key)?.value.value;
    }

    /**
     * Read and mark the entry most recently used.
     */
    get(key: K): V | undefined {
        const node = this.index.get(key);
        if (node === (void 0)) {
            return undefined;
        }
        this.order.moveToFront(node);
        return node.value.value;
    }

    /**
     * Insert or update; an existing key is marked most recently used.
     */
    set(key: K, value: V): this {
        const existing = this.index.get(key);
        if (existing !== (void 0)) {
            existing.value.value = value;
            this.order.moveToFront(existing);
            return this;
        }

        const entry: LruEntry<K, V> = { key, value };
        const node = this.order.pushFront(entry);
        this.index.set(key, node);

        if (this.index.size > this.capacity) {
            const oldest = this.order.back;
            if (oldest !== (void 0)) {
                this.order.popBack();
                this.index.delete(oldest.key);
            }
        }
        return this;
    }

    delete(key: K): boolean {
        const node = this.index.get(key);
        if (node === (void 0)) {
            return false;
        }
        this.order.remove(node);
        this.index.delete(key);
        return true;
    }

    clear(): void {
        this.index.clear();
        this.order.clear();
    }

    /**
     * Mark an existing key most recently used without reading its value.
     */
    touch(key: K): boolean {
        const node = this.index.get(key);
        if (node === (void 0)) {
            return false;
        }
        this.order.moveToFront(node);
        return true;
    }

    /**
     * Least recently used key/value pair, without changing recency.
     */
    leastRecentlyUsed(): [K, V] | undefined {
        const entry = this.order.back;
        return entry === (void 0) ? undefined : [entry.key, entry.value];
    }

    /**
     * Most recently used key/value pair, without changing recency.
     */
    mostRecentlyUsed(): [K, V] | undefined {
        const entry = this.order.front;
        return entry === (void 0) ? undefined : [entry.key, entry.value];
    }

    keys(): Generator<K> {
        return this.index.keys();
    }

    *values(): Generator<V> {
        for (const node of this.index.values()) {
            yield node.value.value;
        }
    }

    *entries(): Generator<[K, V]> {
        for (const [key, node] of this.index.entries()) {
            yield [key, node.value.value];
        }
    }

    [Symbol.iterator](): Generator<[K, V]> {
        return this.entries();
    }

    forEach(callback: (value: V, key: K, map: this) => void, thisArg?: unknown): void {
        for (const [key, value] of this.entries()) {
            callback.call(thisArg, value, key, this);
        }
    }
}

/**
 * LRU cache whose iteration follows insertion order.
 *
 * `get`/`touch` move an entry to the recency front but do not move it in
 * insertion order. Updating an existing key keeps its insertion position;
 * deleting and re-adding appends it.
 */
export class LRUOrderedMap<K, V> extends LruMapBase<K, V> implements Iterable<[K, V]> {
    constructor(capacity: number, entries?: Iterable<readonly [K, V]>, options?: KeyStrategy<K>) {
        super(capacity, new OrderedMap<K, LRUListNode<LruEntry<K, V>>>(undefined, options));
        if (entries !== (void 0)) {
            for (const [key, value] of entries) {
                this.set(key, value);
            }
        }
    }
}

/**
 * LRU cache without an iteration-order guarantee.
 *
 * Iteration follows the underlying `UnorderedMap` bucket order, which may
 * change after resizing; recency is still tracked exactly.
 */
export class LRUUnorderedMap<K, V> extends LruMapBase<K, V> implements Iterable<[K, V]> {
    constructor(capacity: number, entries?: Iterable<readonly [K, V]>, options?: KeyStrategy<K>) {
        super(capacity, new UnorderedMap<K, LRUListNode<LruEntry<K, V>>>(undefined, options));
        if (entries !== (void 0)) {
            for (const [key, value] of entries) {
                this.set(key, value);
            }
        }
    }
}

/**
 * Recency view of an {@link LRUOrderedMap} used as a set.
 */
export class LRUOrderedSet<T> implements Iterable<T> {
    private readonly map: LRUOrderedMap<T, true>;

    constructor(capacity: number, values?: Iterable<T>, options?: KeyStrategy<T>) {
        this.map = new LRUOrderedMap<T, true>(capacity, undefined, options);
        if (values !== (void 0)) {
            for (const value of values) {
                this.add(value);
            }
        }
    }

    get size(): number {
        return this.map.size;
    }

    get capacity(): number {
        return this.map.capacity;
    }

    get isFull(): boolean {
        return this.map.isFull;
    }

    add(value: T): this {
        this.map.set(value, true);
        return this;
    }

    has(value: T): boolean {
        return this.map.has(value);
    }

    /**
     * Membership test that does not change recency.
     */
    peek(value: T): boolean {
        return this.map.has(value);
    }

    get(value: T): boolean {
        return this.map.get(value) === true;
    }

    delete(value: T): boolean {
        return this.map.delete(value);
    }

    touch(value: T): boolean {
        return this.map.touch(value);
    }

    clear(): void {
        this.map.clear();
    }

    leastRecentlyUsed(): T | undefined {
        return this.map.leastRecentlyUsed()?.[0];
    }

    mostRecentlyUsed(): T | undefined {
        return this.map.mostRecentlyUsed()?.[0];
    }

    keys(): Generator<T> {
        return this.map.keys();
    }

    values(): Generator<T> {
        return this.map.keys();
    }

    *entries(): Generator<[T, T]> {
        for (const value of this.map.keys()) {
            yield [value, value];
        }
    }

    [Symbol.iterator](): Generator<T> {
        return this.map.keys();
    }

    forEach(callback: (value: T, value2: T, set: this) => void, thisArg?: unknown): void {
        for (const value of this.map.keys()) {
            callback.call(thisArg, value, value, this);
        }
    }
}

/**
 * Recency view of an {@link LRUUnorderedMap} used as a set.
 */
export class LRUUnorderedSet<T> implements Iterable<T> {
    private readonly map: LRUUnorderedMap<T, true>;

    constructor(capacity: number, values?: Iterable<T>, options?: KeyStrategy<T>) {
        this.map = new LRUUnorderedMap<T, true>(capacity, undefined, options);
        if (values !== (void 0)) {
            for (const value of values) {
                this.add(value);
            }
        }
    }

    get size(): number {
        return this.map.size;
    }

    get capacity(): number {
        return this.map.capacity;
    }

    get isFull(): boolean {
        return this.map.isFull;
    }

    add(value: T): this {
        this.map.set(value, true);
        return this;
    }

    has(value: T): boolean {
        return this.map.has(value);
    }

    /**
     * Membership test that does not change recency.
     */
    peek(value: T): boolean {
        return this.map.has(value);
    }

    get(value: T): boolean {
        return this.map.get(value) === true;
    }

    delete(value: T): boolean {
        return this.map.delete(value);
    }

    touch(value: T): boolean {
        return this.map.touch(value);
    }

    clear(): void {
        this.map.clear();
    }

    leastRecentlyUsed(): T | undefined {
        return this.map.leastRecentlyUsed()?.[0];
    }

    mostRecentlyUsed(): T | undefined {
        return this.map.mostRecentlyUsed()?.[0];
    }

    keys(): Generator<T> {
        return this.map.keys();
    }

    values(): Generator<T> {
        return this.map.keys();
    }

    *entries(): Generator<[T, T]> {
        for (const value of this.map.keys()) {
            yield [value, value];
        }
    }

    [Symbol.iterator](): Generator<T> {
        return this.map.keys();
    }

    forEach(callback: (value: T, value2: T, set: this) => void, thisArg?: unknown): void {
        for (const value of this.map.keys()) {
            callback.call(thisArg, value, value, this);
        }
    }
}
