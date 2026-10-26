/**
 * 64-bit hashing substrate for the structure containers.
 *
 * Two flavours of hashing live here:
 *
 * - {@link hashBytes} and {@link hashString} are deterministic content hashes:
 *   the same bytes (and seed) always produce the same value, in every process
 *   and on every platform.
 * - {@link hashKey} maps arbitrary keys onto 64 bits. Primitive keys are
 *   hashed by value (with a distinct domain tag per type), while objects and
 *   functions are hashed by identity through a module-level `WeakMap`. Identity
 *   hashes are process-local: the same object hashes the same within one
 *   process, but the value is not a content address and is not stable across
 *   runs. Do not persist or transmit identity hashes.
 *
 * Every public result is an unsigned 64-bit bigint in `[0, 2^64)`. The final
 * step is the SplitMix64 avalanche, whose low bits are well distributed; the
 * containers build bucket indices from those low bits.
 */

/**
 * A 64-bit hash value, represented as an unsigned bigint.
 */
export type Hash = bigint;

/**
 * Bit width of every {@link Hash}.
 */
export const HASH_BITS = 64;

/**
 * Mask selecting the low 64 bits of a bigint.
 */
export const HASH_MASK: Hash = (1n << 64n) - 1n;

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MIX_MULTIPLIER_1 = 0xbf58476d1ce4e5b9n;
const MIX_MULTIPLIER_2 = 0x94d049bb133111ebn;

/**
 * Canonical quiet NaN, so all NaN keys hash identically.
 */
const CANONICAL_NAN_BITS = 0x7ff8000000000000n;

const encoder = new TextEncoder();
const numberBuffer = new ArrayBuffer(8);
const numberView = new DataView(numberBuffer);

/**
 * SplitMix64 finalizer: a bijective 64-bit avalanche with excellent low-bit
 * distribution.
 */
function finalize64(value: bigint): Hash {
    let mixed = value & HASH_MASK;
    mixed = ((mixed ^ (mixed >> 30n)) * MIX_MULTIPLIER_1) & HASH_MASK;
    mixed = ((mixed ^ (mixed >> 27n)) * MIX_MULTIPLIER_2) & HASH_MASK;
    return (mixed ^ (mixed >> 31n)) & HASH_MASK;
}

/**
 * Random-looking domain tags keep the hash families of distinct key types apart.
 */
const TAG_UNDEFINED = finalize64(0x01n);
const TAG_NULL = finalize64(0x02n);
const TAG_BOOLEAN = finalize64(0x03n);
const TAG_NUMBER = finalize64(0x04n);
const TAG_BIGINT = finalize64(0x05n);
const TAG_STRING = finalize64(0x06n);
const TAG_GLOBAL_SYMBOL = finalize64(0x07n);
const TAG_LOCAL_SYMBOL = finalize64(0x08n);
const TAG_REFERENCE = finalize64(0x09n);

/**
 * Identity ids for reference keys; process-local by design.
 */
const referenceIds = new WeakMap<object, bigint>();
let nextReferenceId = 1n;

/**
 * FNV-1a 64-bit over raw bytes, followed by a SplitMix64 avalanche.
 *
 * The optional seed is folded into the FNV offset basis (and masked to 64
 * bits), which gives callers independent hash families. The function is a
 * deterministic content hash: equal byte sequences and seeds always produce
 * equal results, and it never depends on process state.
 *
 * @param bytes - Bytes to hash.
 * @param seed - Domain/seed value, masked to unsigned 64 bits. Defaults to `0n`.
 * @returns An unsigned 64-bit hash in `[0, 2^64)`.
 */
export function hashBytes(bytes: Uint8Array, seed: bigint = 0n): Hash {
    let hash = (FNV_OFFSET_BASIS ^ (seed & HASH_MASK)) & HASH_MASK;
    for (let index = 0; index < bytes.length; index += 1) {
        hash = ((hash ^ BigInt(bytes[index])) * FNV_PRIME) & HASH_MASK;
    }
    return finalize64(hash);
}

/**
 * Deterministic UTF-8 hash of a string.
 *
 * Equivalent to encoding `value` with `TextEncoder` and calling
 * {@link hashBytes}. Lone surrogates follow the usual `TextEncoder` replacement
 * behaviour, so distinct strings that encode to the same bytes hash alike.
 *
 * @param value - String to hash.
 * @param seed - Domain/seed value, masked to unsigned 64 bits. Defaults to `0n`.
 * @returns An unsigned 64-bit hash in `[0, 2^64)`.
 */
export function hashString(value: string, seed: bigint = 0n): Hash {
    return hashBytes(encoder.encode(value), seed);
}

/**
 * Number bits under SameValueZero: `-0` becomes `+0`, `NaN` is canonical.
 */
function numberBits(value: number): Hash {
    if (Number.isNaN(value)) {
        return CANONICAL_NAN_BITS;
    }
    numberView.setFloat64(0, value === 0 ? 0 : value, false);
    return numberView.getBigUint64(0, false);
}

/**
 * Hash a symbol by its global registry key or, failing that, its description.
 */
function hashSymbol(value: symbol): Hash {
    const globalKey = Symbol.keyFor(value);
    if (globalKey !== undefined) {
        return mixHash(TAG_GLOBAL_SYMBOL, hashString(globalKey));
    }
    const description = value.description;
    if (description === undefined) {
        return mixHash(TAG_LOCAL_SYMBOL, 0n);
    }
    return mixHash(TAG_LOCAL_SYMBOL, hashString(description));
}

/**
 * Hash an object or function by stable, process-local identity.
 */
function hashReference(value: object): Hash {
    let id = referenceIds.get(value);
    if (id === undefined) {
        id = nextReferenceId;
        nextReferenceId += 1n;
        referenceIds.set(value, id);
    }
    return mixHash(TAG_REFERENCE, finalize64(id));
}

/**
 * Hash an arbitrary key for the hash containers.
 *
 * Each `typeof` category gets its own domain tag, so values such as `1`, `1n`,
 * `'1'`, and `true` do not share a hash. Number keys follow SameValueZero:
 * `-0` hashes like `+0`, and every `NaN` hashes alike.
 *
 * Symbols use their global registry key when registered, otherwise their
 * description. Distinct local symbols with the same description (or with no
 * description) therefore hash the same; that is only a collision, and the
 * containers resolve it with {@link sameKey}. Objects and functions are hashed
 * by identity through a module-level `WeakMap` with monotonically increasing
 * ids, so two distinct references (almost) never collide. Identity hashes are
 * process-local and must not be used as content addresses.
 *
 * @param value - Any ECMAScript value.
 * @returns An unsigned 64-bit hash in `[0, 2^64)`.
 */
export function hashKey(value: unknown): Hash {
    if (value === null) {
        return mixHash(TAG_NULL, 0n);
    }
    switch (typeof value) {
        case "undefined":
            return mixHash(TAG_UNDEFINED, 0n);
        case "boolean":
            return mixHash(TAG_BOOLEAN, value ? 1n : 0n);
        case "number":
            return mixHash(TAG_NUMBER, numberBits(value));
        case "bigint":
            return mixHash(TAG_BIGINT, hashString(value.toString(10)));
        case "string":
            return mixHash(TAG_STRING, hashString(value));
        case "symbol":
            return hashSymbol(value);
        case "object":
        case "function":
            return hashReference(value);
        default:
            throw new TypeError(`cannot hash a key of type ${typeof value}`);
    }
}

/**
 * SameValueZero key equality: `-0` equals `+0`, and `NaN` equals `NaN`.
 * This is the default equality used by all containers in this module family.
 */
export function sameKey(a: unknown, b: unknown): boolean {
    return a === b || Object.is(a, b);
}

/**
 * Combine two 64-bit values into one hash.
 *
 * Both inputs are masked to 64 bits first. For a fixed first argument the
 * combination is injective in the second (and vice versa), so mixing domain
 * tags with payload hashes does not itself introduce avoidable collisions.
 * The result is avalanche-finalized.
 */
export function mixHash(a: bigint, b: bigint): Hash {
    const left = a & HASH_MASK;
    const right = b & HASH_MASK;
    return finalize64((left + GOLDEN_GAMMA) ^ right);
}

/**
 * Format a hash as lowercase hexadecimal.
 *
 * The output is at least `width` characters, zero-padded on the left. `width`
 * is a minimum, never a truncation: a 64-bit value always needs at most 16
 * digits, and narrower widths cannot make the representation round-trip
 * incompletely. `hashFromHex(hashToHex(value, width))` equals
 * `value & HASH_MASK` for every valid width.
 *
 * @param value - Hash value; masked to 64 bits.
 * @param width - Minimum number of hex digits, a non-negative safe integer.
 * Defaults to `16`.
 * @throws RangeError if `width` is not a non-negative safe integer.
 */
export function hashToHex(value: Hash, width = 16): string {
    if (!Number.isSafeInteger(width) || width < 0) {
        throw new RangeError(`width must be a non-negative safe integer, received ${String(width)}`);
    }
    return (value & HASH_MASK).toString(16).padStart(width, "0");
}

/**
 * Parse a 64-bit hash from hexadecimal.
 *
 * Accepts lowercase or uppercase digits and an optional `0x`/`0X` prefix.
 * Leading zeros are allowed; values above `2^64 - 1` are rejected rather than
 * silently truncated.
 *
 * @throws TypeError if `hex` is not a string, is not valid hexadecimal, or
 * denotes a value that does not fit in 64 bits.
 */
export function hashFromHex(hex: string): Hash {
    if (typeof hex !== "string") {
        throw new TypeError("hashFromHex expects a string");
    }
    const match = /^(?:0[xX])?([0-9a-fA-F]+)$/.exec(hex);
    if (match === null) {
        throw new TypeError(`invalid 64-bit hex hash: ${JSON.stringify(hex)}`);
    }
    const digits = match[1].replace(/^0+/, "");
    if (digits.length > 16) {
        throw new TypeError(`hash exceeds 64 bits: ${JSON.stringify(hex)}`);
    }
    return digits.length === 0 ? 0n : BigInt(`0x${digits}`);
}

/**
 * Optional hashing/equality strategy for the hash containers.
 *
 * Both members are optional; omitted members fall back to {@link hashKey} and
 * {@link sameKey}. A custom `equals` must be consistent with a custom `hash`:
 * whenever `equals(a, b)` is true, `hash(a)` and `hash(b)` must be equal,
 * otherwise a lookup can miss an equal key. `equals` should also be reflexive,
 * symmetric, and transitive for useful results. A custom `hash` is masked to
 * 64 bits by the containers.
 */
export interface KeyStrategy<K> {
    readonly hash?: (key: K) => Hash;
    readonly equals?: (a: K, b: K) => boolean;
}
