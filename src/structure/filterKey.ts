/**
 * Key encoding shared by the probabilistic filters.
 *
 * Filters operate on bytes. Strings are encoded as UTF-8, and an existing
 * `Uint8Array` is used as-is (not copied), so callers must not mutate a key
 * buffer while it is being inserted or queried.
 */

/**
 * A key accepted by {@link BloomFilter} and {@link CuckooFilter}.
 */
export type FilterKey = string | Uint8Array;

const encoder = new TextEncoder();

/**
 * UTF-8 bytes for a string, or the original byte view for a `Uint8Array`.
 */
export function filterKeyBytes(key: FilterKey): Uint8Array {
    if (typeof key === "string") {
        return encoder.encode(key);
    }
    if (key instanceof Uint8Array) {
        return key;
    }
    throw new TypeError("filter keys must be strings or Uint8Array values");
}

/**
 * Reject non-string/non-byte values early with a useful error.
 */
export function assertFilterKey(key: unknown): asserts key is FilterKey {
    if (typeof key !== "string" && !(key instanceof Uint8Array)) {
        throw new TypeError("filter keys must be strings or Uint8Array values");
    }
}
