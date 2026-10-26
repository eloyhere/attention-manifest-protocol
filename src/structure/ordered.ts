/**
 * Insertion-ordered hash set and map.
 *
 * Both containers use explicit buckets: a `Map<Hash, head>` maps a 64-bit hash
 * to the head of a collision chain, and hashing/equality come from
 * `./hash.ts`. Order is maintained by an intrusive doubly linked list threaded
 * through the same nodes, so iteration walks the list while lookups go through
 * the buckets. Updating an existing map key keeps its position; deleting and
 * re-adding a key moves it to the end.
 *
 * Iteration is deliberately fail-fast: any structural mutation after an
 * iterator is created (`add` of a new value, `set` of a new key, `delete`, or
 * `clear`) makes the iterator throw on its next `next()` call instead of
 * exposing an inconsistent traversal. Updating the value of an existing map
 * key is not structural and does not invalidate iterators.
 */

import { HashMask, hashKey, sameKey } from "./hash.ts";
import type { Hash, KeyStrategy } from "./hash.ts";

/**
 * One entry; the same node is in a bucket chain and in the order list.
 */
interface OrderedNode<K, V> {
    readonly key: K;
    value: V;
    readonly hash: Hash;
    previous: OrderedNode<K, V> | null;
    next: OrderedNode<K, V> | null;
    bucketNext: OrderedNode<K, V> | null;
}

/**
 * A node found in a bucket chain, together with the node before it.
 */
interface SearchHit<K, V> {
    node: OrderedNode<K, V>;
    bucketPrevious: OrderedNode<K, V> | null;
}

/**
 * A clear, uniform error for the fail-fast iteration contract.
 */
const concurrentModification: (label: string) => Error = (label: string): Error => new Error(`${label}: collection was mutated during iteration`);

/**
 * Shared bucket + intrusive-list machinery behind both public classes.
 */
class OrderedTable<K, V> {
    private readonly buckets = new Map<Hash, OrderedNode<K, V>>();
    private readonly hashFn: (key: K) => Hash;
    private readonly equalsFn: (a: K, b: K) => boolean;
    private readonly label: string;
    private head: OrderedNode<K, V> | null = null;
    private tail: OrderedNode<K, V> | null = null;
    private count = 0;
    private version = 0;

    constructor(label: string, options?: KeyStrategy<K>) {
        this.label = label;
        this.hashFn = options?.hash ?? hashKey;
        this.equalsFn = options?.equals ?? sameKey;
    }

    get size(): number {
        return this.count;
    }

    private hashOf(key: K): Hash {
        return this.hashFn(key) & HashMask;
    }

    /**
     * Find a node and the node before it in its bucket chain.
     */
    private find(key: K, hash: Hash): SearchHit<K, V> | null {
        let bucketPrevious: OrderedNode<K, V> | null = null;
        let node: OrderedNode<K, V> | null = this.buckets.get(hash) ?? null;
        while (node !== null) {
            if (this.equalsFn(key, node.key)) {
                return { node, bucketPrevious };
            }
            bucketPrevious = node;
            node = node.bucketNext;
        }
        return null;
    }

    has(key: K): boolean {
        return this.find(key, this.hashOf(key)) !== null;
    }

    get(key: K): V | undefined {
        const hit: SearchHit<K, V> | null = this.find(key, this.hashOf(key));
        return hit === null ? undefined : hit.node.value;
    }

    /**
     * Add a key that must not exist yet; returns whether a node was created.
     */
    add(key: K, value: V): boolean {
        const hash: Hash = this.hashOf(key);
        if (this.find(key, hash) !== null) {
            return false;
        }
        this.insert(key, value, hash);
        return true;
    }

    /**
     * Insert or update; returns whether a node was created.
     */
    set(key: K, value: V): boolean {
        const hash: Hash = this.hashOf(key);
        const hit: SearchHit<K, V> | null = this.find(key, hash);
        if (hit !== null) {
            hit.node.value = value;
            return false;
        }
        this.insert(key, value, hash);
        return true;
    }

    private insert(key: K, value: V, hash: Hash): void {
        const node: OrderedNode<K, V> = {
            key,
            value,
            hash,
            previous: this.tail,
            next: null,
            bucketNext: this.buckets.get(hash) ?? null,
        };
        if (this.tail === null) {
            this.head = node;
        } else {
            this.tail.next = node;
        }
        this.tail = node;
        this.buckets.set(hash, node);
        this.count += 1;
        this.version += 1;
    }

    delete(key: K): boolean {
        const hash: Hash = this.hashOf(key);
        const hit: SearchHit<K, V> | null = this.find(key, hash);
        if (hit === null) {
            return false;
        }
        const { node, bucketPrevious }: SearchHit<K, V> = hit;

        if (bucketPrevious === null) {
            if (node.bucketNext === null) {
                this.buckets.delete(hash);
            } else {
                this.buckets.set(hash, node.bucketNext);
            }
        } else {
            bucketPrevious.bucketNext = node.bucketNext;
        }

        if (node.previous === null) {
            this.head = node.next;
        } else {
            node.previous.next = node.next;
        }
        if (node.next === null) {
            this.tail = node.previous;
        } else {
            node.next.previous = node.previous;
        }

        node.previous = null;
        node.next = null;
        node.bucketNext = null;
        this.count -= 1;
        this.version += 1;
        return true;
    }

    clear(): void {
        if (this.count === 0) {
            return;
        }
        this.buckets.clear();
        this.head = null;
        this.tail = null;
        this.count = 0;
        this.version += 1;
    }

    /**
     * Build a fail-fast iterator. The expected version is captured here, when
     * the iterator is requested, not on the first `next()` call.
     */
    private *iterate<T>(expectedVersion: number, select: (node: OrderedNode<K, V>) => T): Generator<T> {
        let node: OrderedNode<K, V> | null = this.head;
        while (node !== null) {
            if (expectedVersion !== this.version) {
                throw concurrentModification(this.label);
            }
            const value: T = select(node);
            yield value;
            if (expectedVersion !== this.version) {
                throw concurrentModification(this.label);
            }
            node = node.next;
        }
    }

    keys(): Generator<K> {
        return this.iterate(this.version, (node) => node.key);
    }

    values(): Generator<V> {
        return this.iterate(this.version, (node) => node.value);
    }

    entries(): Generator<[K, V]> {
        return this.iterate(this.version, (node): [K, V] => [node.key, node.value]);
    }

    /**
     * Entries for a set, where the stored value is irrelevant.
     */
    keyPairs(): Generator<[K, K]> {
        return this.iterate(this.version, (node): [K, K] => [node.key, node.key]);
    }
}

/**
 * A set that iterates in insertion order.
 *
 * Lookup is average O(1) through explicit hash buckets with collision chains;
 * order is an intrusive doubly linked list. Re-adding an existing value has no
 * effect, deleting and re-adding moves the value to the end.
 *
 * Iteration is fail-fast: a structural mutation (`add` of a new value,
 * `delete`, or `clear`) after an iterator is obtained makes that iterator throw
 * on its next step. Mutating during `forEach` therefore also throws once the
 * callback returns and the loop advances; finish collecting changes first if
 * that behaviour is not wanted.
 */
export class OrderedSet<T> implements Iterable<T> {
    private readonly table: OrderedTable<T, undefined>;

    constructor(values?: Iterable<T>, options?: KeyStrategy<T>) {
        this.table = new OrderedTable("OrderedSet", options);
        if (values === (void 0)) {
            return;
        }
        const items: T[] = [...values];
        for (let index: number = 0; index < items.length; index += 1) {
            this.table.add(items[index], undefined);
        }
    }

    get size(): number {
        return this.table.size;
    }

    clear(): void {
        this.table.clear();
    }

    add(value: T): this {
        this.table.add(value, undefined);
        return this;
    }

    has(value: T): boolean {
        return this.table.has(value);
    }

    delete(value: T): boolean {
        return this.table.delete(value);
    }

    /**
     * Alias of {@link OrderedSet.values}.
     */
    keys(): Generator<T> {
        return this.table.keys();
    }

    values(): Generator<T> {
        return this.table.keys();
    }

    entries(): Generator<[T, T]> {
        return this.table.keyPairs();
    }

    [Symbol.iterator](): Generator<T> {
        return this.table.keys();
    }

    /**
     * Call `callback` for each value in insertion order.
     *
     * @param callback - Receives the value twice (matching the native `Set`
     * shape) and the set itself.
     * @param thisArg - Value used as `this` when invoking `callback`.
     */
    forEach(callback: (value: T, value2: T, set: this) => void, thisArg?: unknown): void {
        const iterator: Iterator<T> = this.table.keys();
        let step: IteratorResult<T, undefined> = iterator.next();
        while (step.done !== true) {
            callback.call(thisArg, step.value, step.value, this);
            step = iterator.next();
        }
    }
}

/**
 * A map that iterates in insertion order.
 *
 * Lookup is average O(1) through explicit hash buckets with collision chains;
 * order is an intrusive doubly linked list. Setting an existing key updates
 * its value without moving it; deleting and re-adding moves it to the end.
 * Membership is determined by {@link OrderedMap.has}, so `undefined` is a
 * perfectly valid value.
 *
 * Iteration is fail-fast: a structural mutation (`set` of a new key, `delete`,
 * or `clear`) after an iterator is obtained makes that iterator throw on its
 * next step; updating an existing key's value is allowed. Mutating the key set
 * during `forEach` also throws once the callback returns and the loop advances.
 */
export class OrderedMap<K, V> implements Iterable<[K, V]> {
    private readonly table: OrderedTable<K, V>;

    constructor(entries?: Iterable<readonly [K, V]>, options?: KeyStrategy<K>) {
        this.table = new OrderedTable("OrderedMap", options);
        if (entries === (void 0)) {
            return;
        }
        const items: (readonly [K, V])[] = [...entries];
        for (let index: number = 0; index < items.length; index += 1) {
            this.table.set(items[index][0], items[index][1]);
        }
    }

    get size(): number {
        return this.table.size;
    }

    clear(): void {
        this.table.clear();
    }

    set(key: K, value: V): this {
        this.table.set(key, value);
        return this;
    }

    get(key: K): V | undefined {
        return this.table.get(key);
    }

    has(key: K): boolean {
        return this.table.has(key);
    }

    delete(key: K): boolean {
        return this.table.delete(key);
    }

    keys(): Generator<K> {
        return this.table.keys();
    }

    values(): Generator<V> {
        return this.table.values();
    }

    entries(): Generator<[K, V]> {
        return this.table.entries();
    }

    [Symbol.iterator](): Generator<[K, V]> {
        return this.table.entries();
    }

    /**
     * Call `callback` for each entry in insertion order.
     *
     * @param callback - Receives the value, the key, and the map itself.
     * @param thisArg - Value used as `this` when invoking `callback`.
     */
    forEach(callback: (value: V, key: K, map: this) => void, thisArg?: unknown): void {
        const iterator: Iterator<[K, V]> = this.table.entries();
        let step: IteratorResult<[K, V], undefined> = iterator.next();
        while (step.done !== true) {
            const [key, value]: [K, V] = step.value;
            callback.call(thisArg, value, key, this);
            step = iterator.next();
        }
    }
}
