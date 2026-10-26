import { hashBytes } from "./hash.ts";
import { assertFilterKey, filterKeyBytes } from "./filterKey.ts";
import type { FilterKey } from "./filterKey.ts";

/**
 * A cuckoo filter with two candidate buckets and compact fingerprints.
 *
 * Unlike a Bloom filter, a cuckoo filter supports deletion of individual keys.
 * Each key is reduced to a small fingerprint and two bucket indices; insertion
 * places the fingerprint in either bucket, kicking existing fingerprints to
 * their alternate bucket when both are full. A bounded kick chain is fully
 * rolled back if it cannot find a free slot, so a failed `add` never silently
 * loses a previously accepted key.
 *
 * False positives are possible (a different key may share both buckets and the
 * fingerprint); false negatives are not, provided the same key bytes are used
 * for insert, lookup, and delete. Duplicate keys are allowed.
 */

/**
 * Construction options for {@link CuckooFilter}.
 */
export interface CuckooFilterOptions {
    /**
     * Requested key capacity; the actual slot count rounds up to a power of two.
     */
    capacity: number;
    /**
     * Fingerprints per bucket. Defaults to `4`.
     */
    bucketSize?: number;
    /**
     * Fingerprint width in bits, 4..30. Defaults to `8`.
     */
    fingerprintBits?: number;
    /**
     * Maximum kick chain before insertion fails and rolls back. Defaults to `500`.
     */
    maxKicks?: number;
    /**
     * Domain seed for key and fingerprint hashing. Defaults to `0n`.
     */
    seed?: bigint;
}

const DEFAULT_BUCKET_SIZE = 4;
const DEFAULT_FINGERPRINT_BITS = 8;
const DEFAULT_MAX_KICKS = 500;
const FINGERPRINT_SEED = 0xd1b54a32d192ed03n;
const MIN_FINGERPRINT_BITS = 4;
const MAX_FINGERPRINT_BITS = 30;

interface KickRecord {
    bucket: number;
    slot: number;
    displaced: number;
}

/**
 * A cuckoo filter over string or `Uint8Array` keys.
 *
 * `capacity` is the number of fingerprint slots, not the requested value: it is
 * `bucketCount * bucketSize`, rounded up from the constructor's `capacity`.
 * `loadFactor` is the fraction of those slots currently occupied.
 */
export class CuckooFilter {
    /**
     * Requested key capacity before bucket rounding.
     */
    readonly requestedCapacity: number;
    /**
     * Fingerprints per bucket.
     */
    readonly bucketSize: number;
    /**
     * Number of buckets (a power of two).
     */
    readonly bucketCount: number;
    /**
     * Total fingerprint slots: `bucketCount * bucketSize`.
     */
    readonly capacity: number;
    /**
     * Fingerprint width in bits.
     */
    readonly fingerprintBits: number;
    /**
     * Maximum number of displacements per insertion.
     */
    readonly maxKicks: number;

    private readonly buckets: number[][];
    private readonly seed: bigint;
    private readonly indexMask: number;
    private readonly fingerprintMask: bigint;
    private readonly initialRng: number;
    private rngState: number;
    private count = 0;

    /**
     * Create an empty filter.
     *
     * @throws RangeError for non-positive capacity, an invalid bucket/fingerprint
     * size, a negative kick limit, or a bucket array too large to index safely.
     */
    constructor(options: CuckooFilterOptions) {
        if (options === null || typeof options !== "object") {
            throw new TypeError("options must be an object");
        }
        if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
            throw new RangeError("capacity must be a positive safe integer");
        }
        const bucketSize = options.bucketSize ?? DEFAULT_BUCKET_SIZE;
        if (!Number.isSafeInteger(bucketSize) || bucketSize <= 0 || bucketSize > 32) {
            throw new RangeError("bucketSize must be an integer in [1, 32]");
        }
        const fingerprintBits = options.fingerprintBits ?? DEFAULT_FINGERPRINT_BITS;
        if (!Number.isSafeInteger(fingerprintBits) || fingerprintBits < MIN_FINGERPRINT_BITS || fingerprintBits > MAX_FINGERPRINT_BITS) {
            throw new RangeError(`fingerprintBits must be an integer in [${MIN_FINGERPRINT_BITS}, ${MAX_FINGERPRINT_BITS}]`);
        }
        const maxKicks = options.maxKicks ?? DEFAULT_MAX_KICKS;
        if (!Number.isSafeInteger(maxKicks) || maxKicks < 0) {
            throw new RangeError("maxKicks must be a non-negative safe integer");
        }

        let bucketCount = 1;
        while (bucketCount * bucketSize < options.capacity) {
            bucketCount *= 2;
            if (bucketCount > 2 ** 30) {
                throw new RangeError("capacity is too large for a cuckoo filter");
            }
        }

        this.requestedCapacity = options.capacity;
        this.bucketSize = bucketSize;
        this.bucketCount = bucketCount;
        this.capacity = bucketCount * bucketSize;
        this.fingerprintBits = fingerprintBits;
        this.maxKicks = maxKicks;
        this.seed = options.seed ?? 0n;
        this.indexMask = bucketCount - 1;
        this.fingerprintMask = (1n << BigInt(fingerprintBits)) - 1n;
        this.buckets = Array.from({ length: bucketCount }, () => []);
        const seeded = Number((options.seed ?? 0n) & 0xffff_ffffn);
        this.initialRng = seeded === 0 ? 0x9e37_79b9 : seeded;
        this.rngState = this.initialRng;
    }

    /**
     * Insert a key.
     *
     * @returns `true` if the fingerprint was stored, `false` if the kick chain
     * was exhausted. A failed insertion is rolled back and leaves the filter
     * unchanged.
     */
    add(key: FilterKey): boolean {
        assertFilterKey(key);
        const { index, fingerprint } = this.locate(key);
        let first = index;
        let second = this.alternate(first, fingerprint);
        let currentFingerprint = fingerprint;
        let currentIndex = this.pickBucket(first, second);
        const history: KickRecord[] = [];

        for (let kick = 0; kick <= this.maxKicks; kick += 1) {
            const bucket = this.buckets[currentIndex];
            if (bucket.length < this.bucketSize) {
                bucket.push(currentFingerprint);
                this.count += 1;
                return true;
            }
            if (kick === this.maxKicks) {
                break;
            }

            const slot = this.randomInt(bucket.length);
            const displaced = bucket[slot] ?? 0;
            history.push({ bucket: currentIndex, slot, displaced });
            bucket[slot] = currentFingerprint;
            currentFingerprint = displaced;
            currentIndex = this.alternate(currentIndex, currentFingerprint);
        }

        /**
         * Undo every displacement. The last displaced fingerprint was never
         * stored, and every earlier one is restored to the slot it came from.
         */
        for (let index_ = history.length - 1; index_ >= 0; index_ -= 1) {
            const record = history[index_];
            if (record === undefined) {
                continue;
            }
            this.buckets[record.bucket][record.slot] = record.displaced;
        }
        return false;
    }

    /**
     * Test whether a key may be present.
     */
    has(key: FilterKey): boolean {
        assertFilterKey(key);
        const { index, fingerprint } = this.locate(key);
        if (this.buckets[index].includes(fingerprint)) {
            return true;
        }
        const alternate = this.alternate(index, fingerprint);
        return alternate !== index && this.buckets[alternate].includes(fingerprint);
    }

    /**
     * Remove one occurrence of a key.
     *
     * @returns `true` if a matching fingerprint was removed, `false` otherwise.
     * A `false` result is exact only for a key that was never inserted; a
     * different key can share the same fingerprint, so deletion is best-effort
     * with respect to collisions.
     */
    delete(key: FilterKey): boolean {
        assertFilterKey(key);
        const { index, fingerprint } = this.locate(key);
        const first = this.removeFingerprint(index, fingerprint);
        if (first) {
            this.count -= 1;
            return true;
        }
        const alternate = this.alternate(index, fingerprint);
        if (alternate !== index && this.removeFingerprint(alternate, fingerprint)) {
            this.count -= 1;
            return true;
        }
        return false;
    }

    /**
     * Remove every key and reset the random kick state.
     */
    clear(): void {
        for (const bucket of this.buckets) {
            bucket.length = 0;
        }
        this.count = 0;
        this.rngState = this.initialRng;
    }

    /**
     * Number of stored fingerprints.
     */
    get size(): number {
        return this.count;
    }

    /**
     * Fraction of fingerprint slots occupied.
     */
    get loadFactor(): number {
        return this.count / this.capacity;
    }

    /**
     * True when every fingerprint slot is occupied.
     */
    get isFull(): boolean {
        return this.count === this.capacity;
    }

    /**
     * Approximate false-positive probability for a non-full filter:
     * `2 * bucketSize / 2^fingerprintBits`.
     */
    get falsePositiveRate(): number {
        return Math.min(1, (2 * this.bucketSize) / 2 ** this.fingerprintBits);
    }

    /**
     * Hash a key once, yielding its first bucket and compact fingerprint.
     */
    private locate(key: FilterKey): { index: number; fingerprint: number } {
        const hash = hashBytes(filterKeyBytes(key), this.seed);
        const index = Number(hash & BigInt(this.indexMask));
        let fingerprint = Number((hash >> 32n) & this.fingerprintMask);
        if (fingerprint === 0) {
            fingerprint = 1;
        }
        return { index, fingerprint };
    }

    /**
     * The other candidate bucket for a fingerprint in `index`.
     */
    private alternate(index: number, fingerprint: number): number {
        const bytes = Uint8Array.of(fingerprint & 0xff, (fingerprint >>> 8) & 0xff, (fingerprint >>> 16) & 0xff, (fingerprint >>> 24) & 0xff);
        const hashed = Number(hashBytes(bytes, this.seed ^ FINGERPRINT_SEED) & BigInt(this.indexMask));
        return (index ^ hashed) & this.indexMask;
    }

    /**
     * Choose an initial bucket, preferring one with room.
     */
    private pickBucket(first: number, second: number): number {
        if (this.buckets[first].length < this.bucketSize) {
            return first;
        }
        if (this.buckets[second].length < this.bucketSize) {
            return second;
        }
        return this.randomInt(2) === 0 ? first : second;
    }

    /**
     * Remove the first matching fingerprint from one bucket.
     */
    private removeFingerprint(index: number, fingerprint: number): boolean {
        const bucket = this.buckets[index];
        const slot = bucket.indexOf(fingerprint);
        if (slot < 0) {
            return false;
        }
        const last = bucket.pop();
        if (slot < bucket.length && last !== undefined) {
            bucket[slot] = last;
        }
        return true;
    }

    /**
     * Xorshift32 in [0, bound); deterministic for a given seed and insertion order.
     */
    private randomInt(bound: number): number {
        let value = this.rngState;
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        this.rngState = value >>> 0;
        return this.rngState % bound;
    }
}
