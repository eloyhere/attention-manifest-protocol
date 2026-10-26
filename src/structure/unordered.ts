/**
 * Unordered hash set and map.
 *
 * Both containers are separate-chaining hash tables over a power-of-two bucket
 * array, with a load factor of 0.75 and rehash-on-grow. The bucket index is
 * taken from the low bits of a 64-bit hash from `./hash.ts`; collisions are
 * walked as explicit chains and resolved with the equality strategy (never by
 * hash equality alone). No insertion order is maintained: iteration order is
 * unspecified bucket order and may change after a resize.
 *
 * Iteration is deliberately fail-fast: any structural mutation after an
 * iterator is created (`add` of a new value, `set` of a new key, `delete`, or
 * `clear`) makes the iterator throw on its next `next()` call, as does a
 * rehash. Updating the value of an existing map key is not structural and does
 * not invalidate iterators.
 */

import { HashMask, hashKey, sameKey } from "./hash.ts";
import type { Hash, KeyStrategy } from "./hash.ts";

const InitialCapacity: number = 16;

/**
 * One bucket-chain entry.
 */
interface ChainNode<K, V> {
    readonly key: K;
    value: V;
    readonly hash: Hash;
    next: ChainNode<K, V> | null;
}

/**
 * The node a lookup found, the node before it in its chain, and its bucket
 * index.
 */
type ChainHit<K, V> = {
    node: ChainNode<K, V>;
    previous: ChainNode<K, V> | null;
    index: number;
};

/**
 * A clear, uniform error for the fail-fast iteration contract.
 */
const concurrentModification: (label: string) => Error = (label: string): Error => {
    return new Error(`${label}: collection was mutated during iteration`);
};

/**
 * Shared power-of-two, separate-chaining table behind both public classes.
 */
class HashTable<K, V> {
    private buckets: Array<ChainNode<K, V> | null> = new Array<ChainNode<K, V> | null>(InitialCapacity).fill(null);
    private indexMask: bigint = BigInt(InitialCapacity - 1);
    private readonly hashFn: (key: K) => Hash;
    private readonly equalsFn: (a: K, b: K) => boolean;
    private readonly label: string;
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
     * Find a node, the node before it in its chain, and its bucket index.
     */
    private find(key: K, hash: Hash): ChainHit<K, V> | null {
        const index: number = Number(hash & this.indexMask);
        let previous: ChainNode<K, V> | null = null;
        let node: ChainNode<K, V> | null = this.buckets[index];
        while (node !== null) {
            if (this.equalsFn(key, node.key)) {
                return { node, previous, index };
            }
            previous = node;
            node = node.next;
        }
        return null;
    }

    has(key: K): boolean {
        return this.find(key, this.hashOf(key)) !== null;
    }

    get(key: K): V | undefined {
        const hit: ChainHit<K, V> | null = this.find(key, this.hashOf(key));
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
        const hit: ChainHit<K, V> | null = this.find(key, hash);
        if (hit !== null) {
            hit.node.value = value;
            return false;
        }
        this.insert(key, value, hash);
        return true;
    }

    private insert(key: K, value: V, hash: Hash): void {
        if (this.count + 1 > (this.buckets.length * 3) / 4) {
            this.grow();
        }
        const index: number = Number(hash & this.indexMask);
        const node: ChainNode<K, V> = { key, value, hash, next: this.buckets[index] };
        this.buckets[index] = node;
        this.count += 1;
        this.version += 1;
    }

    /**
     * Double the bucket array and relink every live node exactly once.
     */
    private grow(): void {
        const previousBuckets: Array<ChainNode<K, V> | null> = this.buckets;
        const nextBuckets: Array<ChainNode<K, V> | null> = new Array<ChainNode<K, V> | null>(previousBuckets.length * 2).fill(null);
        const nextMask: bigint = BigInt(nextBuckets.length - 1);
        for (let headIndex: number = 0; headIndex < previousBuckets.length; headIndex += 1) {
            let node: ChainNode<K, V> | null = previousBuckets[headIndex];
            while (node !== null) {
                const next: ChainNode<K, V> | null = node.next;
                const index: number = Number(node.hash & nextMask);
                node.next = nextBuckets[index];
                nextBuckets[index] = node;
                node = next;
            }
        }
        this.buckets = nextBuckets;
        this.indexMask = nextMask;
    }

    delete(key: K): boolean {
        const hit: ChainHit<K, V> | null = this.find(key, this.hashOf(key));
        if (hit === null) {
            return false;
        }
        const { node, previous, index }: ChainHit<K, V> = hit;
        if (previous === null) {
            this.buckets[index] = node.next;
        } else {
            previous.next = node.next;
        }
        node.next = null;
        this.count -= 1;
        this.version += 1;
        return true;
    }

    clear(): void {
        if (this.count === 0) {
            return;
        }
        this.buckets = new Array<ChainNode<K, V> | null>(InitialCapacity).fill(null);
        this.indexMask = BigInt(InitialCapacity - 1);
        this.count = 0;
        this.version += 1;
    }

    /**
     * Build a fail-fast iterator. The expected version is captured here, when
     * the iterator is requested, not on the first `next()` call.
     */
    private *iterate<T>(expectedVersion: number, select: (node: ChainNode<K, V>) => T): Generator<T> {
        for (let index: number = 0; index < this.buckets.length; index += 1) {
            let node: ChainNode<K, V> | null = this.buckets[index];
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
 * An unordered set backed by a separate-chaining hash table.
 *
 * Average O(1) membership, explicit collision chains, power-of-two buckets, a
 * 0.75 load factor, and rehash-on-grow. Iteration order is unspecified (bucket
 * order) and may change after a resize. The public API mirrors
 * `OrderedSet`, including custom {@link KeyStrategy} support.
 *
 * Iteration is fail-fast: a structural mutation (`add` of a new value,
 * `delete`, `clear`, or an internal rehash caused by growth) after an iterator
 * is obtained makes that iterator throw on its next step. Mutating the set
 * during `forEach` therefore also throws once the callback returns and the
 * loop advances.
 */
export class UnorderedSet<T> implements Iterable<T> {
    private readonly table: HashTable<T, undefined>;

    constructor(values?: Iterable<T>, options?: KeyStrategy<T>) {
        this.table = new HashTable("UnorderedSet", options);
        if (values === (void 0)) {
            return;
        }
        const initialValues: T[] = [...values];
        for (let valueIndex: number = 0; valueIndex < initialValues.length; valueIndex += 1) {
            this.table.add(initialValues[valueIndex], undefined);
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
     * Alias of {@link UnorderedSet.values}.
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
     * Call `callback` for each value; order is unspecified.
     *
     * The table generator is driven by hand so that the fail-fast version check
     * keeps throwing between callback invocations, exactly as a `for…of` loop
     * over `keys()` would.
     *
     * @param callback - Receives the value twice (matching the native `Set`
     * shape) and the set itself.
     * @param thisArg - Value used as `this` when invoking `callback`.
     */
    forEach(callback: (value: T, value2: T, set: this) => void, thisArg?: unknown): void {
        const iterator: Generator<T> = this.table.keys();
        let step: IteratorResult<T> = iterator.next();
        while (!step.done) {
            callback.call(thisArg, step.value, step.value, this);
            step = iterator.next();
        }
    }
}

/**
 * An unordered map backed by a separate-chaining hash table.
 *
 * Average O(1) lookup, explicit collision chains, power-of-two buckets, a 0.75
 * load factor, and rehash-on-grow. Iteration order is unspecified (bucket
 * order) and may change after a resize. The public API mirrors `OrderedMap`,
 * including custom {@link KeyStrategy} support. Membership is determined by
 * {@link UnorderedMap.has}, so `undefined` is a perfectly valid value.
 *
 * Iteration is fail-fast: a structural mutation (`set` of a new key, `delete`,
 * `clear`, or an internal rehash caused by growth) after an iterator is
 * obtained makes that iterator throw on its next step; updating an existing
 * key's value is allowed. Mutating the key set during `forEach` also throws
 * once the callback returns and the loop advances.
 */
export class UnorderedMap<K, V> implements Iterable<[K, V]> {
    private readonly table: HashTable<K, V>;

    constructor(entries?: Iterable<readonly [K, V]>, options?: KeyStrategy<K>) {
        this.table = new HashTable("UnorderedMap", options);
        if (entries === (void 0)) {
            return;
        }
        const initialEntries: Array<readonly [K, V]> = [...entries];
        for (let entryIndex: number = 0; entryIndex < initialEntries.length; entryIndex += 1) {
            const [key, value]: readonly [K, V] = initialEntries[entryIndex];
            this.table.set(key, value);
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
     * Call `callback` for each entry; order is unspecified.
     *
     * The table generator is driven by hand so that the fail-fast version check
     * keeps throwing between callback invocations, exactly as a `for…of` loop
     * over `entries()` would.
     *
     * @param callback - Receives the value, the key, and the map itself.
     * @param thisArg - Value used as `this` when invoking `callback`.
     */
    forEach(callback: (value: V, key: K, map: this) => void, thisArg?: unknown): void {
        const iterator: Generator<[K, V]> = this.table.entries();
        let step: IteratorResult<[K, V]> = iterator.next();
        while (!step.done) {
            const [key, value]: [K, V] = step.value;
            callback.call(thisArg, value, key, this);
            step = iterator.next();
        }
    }
}
