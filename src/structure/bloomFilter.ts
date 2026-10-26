import { hashBytes } from "./hash.ts";
import { assertFilterKey, filterKeyBytes } from "./filterKey.ts";
import type { FilterKey } from "./filterKey.ts";

/**
 * A classic Bloom filter.
 *
 * The filter stores a bit array and uses `k` double-hashed bit positions per
 * key. It has no false negatives: if `add(key)` completed, `has(key)` remains
 * true. False positives are possible and are bounded by the configured rate.
 * Standard Bloom filters cannot delete individual keys; rebuild the filter or
 * use {@link CuckooFilter} when deletion is required.
 *
 * The default hash count and bit count are derived from `expectedItems` and
 * `falsePositiveRate` using the usual `m = -n ln p / (ln 2)^2` and
 * `k = (m/n) ln 2` formulas. Values for unsupported sizes fail before any
 * allocation.
 */

/**
 * Construction options for {@link BloomFilter}.
 */
export interface BloomFilterOptions {
    /**
     * Expected number of distinct keys; a positive safe integer.
     */
    expectedItems: number;
    /**
     * Target false-positive rate in `(0, 1)`. Defaults to `0.01`.
     */
    falsePositiveRate?: number;
    /**
     * Domain seed for both hash families. Defaults to `0n`.
     */
    seed?: bigint;
    /**
     * Hard cap on bit-array size; defaults to 2^31 bits (256 MiB).
     */
    maxBits?: number;
}

const DEFAULT_FALSE_POSITIVE_RATE = 0.01;
const DEFAULT_MAX_BITS = 2 ** 31;
const SECOND_HASH_SEED = 0x9e3779b97f4a7c15n;
const LN2 = Math.LN2;

/**
 * A Bloom filter over string or `Uint8Array` keys.
 *
 * `size` counts calls to {@link add}, not distinct keys: a Bloom filter cannot
 * know whether a key was already present. `setBits` and `fillRatio` expose the
 * actual bit occupancy, which is the useful signal for saturation.
 */
export class BloomFilter {
    /**
     * Requested expected key count.
     */
    readonly expectedItems: number;
    /**
     * Requested target false-positive rate.
     */
    readonly falsePositiveRate: number;
    /**
     * Number of bits in the filter.
     */
    readonly bitSize: number;
    /**
     * Number of double-hashed probes per key.
     */
    readonly hashCount: number;
    /**
     * Number of bytes allocated for the bit array.
     */
    readonly byteSize: number;

    private readonly bits: Uint8Array;
    private readonly seed: bigint;
    private insertions = 0;
    private bitsSet = 0;

    /**
     * Build a filter sized for `expectedItems` at `falsePositiveRate`.
     *
     * @throws RangeError for non-positive/non-integer item counts, rates outside
     * `(0, 1)`, or a computed bit count above `maxBits`.
     */
    constructor(options: BloomFilterOptions) {
        if (options === null || typeof options !== "object") {
            throw new TypeError("options must be an object");
        }
        if (!Number.isSafeInteger(options.expectedItems) || options.expectedItems <= 0) {
            throw new RangeError("expectedItems must be a positive safe integer");
        }
        const rate = options.falsePositiveRate ?? DEFAULT_FALSE_POSITIVE_RATE;
        if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) {
            throw new RangeError("falsePositiveRate must be a finite number in (0, 1)");
        }
        const maxBits = options.maxBits ?? DEFAULT_MAX_BITS;
        if (!Number.isSafeInteger(maxBits) || maxBits <= 0) {
            throw new RangeError("maxBits must be a positive safe integer");
        }

        const idealBits = Math.ceil((-options.expectedItems * Math.log(rate)) / (LN2 * LN2));
        if (!Number.isSafeInteger(idealBits) || idealBits > maxBits) {
            throw new RangeError(`filter would need ${String(idealBits)} bits, exceeding maxBits ${maxBits}`);
        }

        this.expectedItems = options.expectedItems;
        this.falsePositiveRate = rate;
        this.bitSize = Math.max(1, idealBits);
        this.hashCount = Math.max(1, Math.min(32, Math.round((this.bitSize / options.expectedItems) * LN2)));
        this.byteSize = Math.ceil(this.bitSize / 8);
        this.bits = new Uint8Array(this.byteSize);
        this.seed = options.seed ?? 0n;
    }

    /**
     * Insert a key.
     *
     * Duplicate insertion is harmless and increments {@link size}; the bit
     * occupancy only changes for bits that were previously unset.
     *
     * @param key - String or byte key.
     * @returns This filter, for chaining.
     */
    add(key: FilterKey): this {
        assertFilterKey(key);
        const bytes = filterKeyBytes(key);
        const primary = hashBytes(bytes, this.seed) % BigInt(this.bitSize);
        const step = (hashBytes(bytes, this.seed ^ SECOND_HASH_SEED) | 1n) % BigInt(this.bitSize);
        let position = primary;
        for (let probe = 0; probe < this.hashCount; probe += 1) {
            this.setBit(Number(position));
            position = (position + step) % BigInt(this.bitSize);
        }
        this.insertions += 1;
        return this;
    }

    /**
     * Test a key.
     *
     * `false` means the key was definitely not inserted (or the filter was
     * cleared). `true` may be a false positive.
     */
    has(key: FilterKey): boolean {
        assertFilterKey(key);
        const bytes = filterKeyBytes(key);
        const primary = hashBytes(bytes, this.seed) % BigInt(this.bitSize);
        const step = (hashBytes(bytes, this.seed ^ SECOND_HASH_SEED) | 1n) % BigInt(this.bitSize);
        let position = primary;
        for (let probe = 0; probe < this.hashCount; probe += 1) {
            if (!this.getBit(Number(position))) {
                return false;
            }
            position = (position + step) % BigInt(this.bitSize);
        }
        return true;
    }

    /**
     * Remove every key and reset all counters.
     */
    clear(): void {
        this.bits.fill(0);
        this.insertions = 0;
        this.bitsSet = 0;
    }

    /**
     * Number of `add` calls, including duplicates.
     */
    get size(): number {
        return this.insertions;
    }

    /**
     * Number of bits currently set to one.
     */
    get setBits(): number {
        return this.bitsSet;
    }

    /**
     * Fraction of bits set to one.
     */
    get fillRatio(): number {
        return this.bitsSet / this.bitSize;
    }

    /**
     * True when every bit is set and the filter is fully saturated.
     */
    get isSaturated(): boolean {
        return this.bitsSet === this.bitSize;
    }

    /**
     * Estimated current false-positive probability from the number of inserted
     * keys: `(1 - e^(-k*n/m))^k`.
     */
    get estimatedFalsePositiveRate(): number {
        if (this.insertions === 0) {
            return 0;
        }
        const exponent = (-this.hashCount * this.insertions) / this.bitSize;
        return (1 - Math.exp(exponent)) ** this.hashCount;
    }

    /**
     * Set one bit, updating the occupancy counter only on a 0 -> 1 change.
     */
    private setBit(index: number): void {
        const byteIndex = index >>> 3;
        const mask = 1 << (index & 7);
        const current = this.bits[byteIndex] ?? 0;
        if ((current & mask) === 0) {
            this.bits[byteIndex] = current | mask;
            this.bitsSet += 1;
        }
    }

    /**
     * Read one bit.
     */
    private getBit(index: number): boolean {
        const byteIndex = index >>> 3;
        const mask = 1 << (index & 7);
        return ((this.bits[byteIndex] ?? 0) & mask) !== 0;
    }
}
