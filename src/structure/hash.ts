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
export const HashBits: number = 64;

/**
 * Mask selecting the low 64 bits of a bigint.
 */
export const HashMask: Hash = (1n << 64n) - 1n;

const FnvOffsetBasis: Hash = 0xcbf29ce484222325n;
const FnvPrime: Hash = 0x100000001b3n;
const GoldenGamma: Hash = 0x9e3779b97f4a7c15n;
const MixMultiplier1: Hash = 0xbf58476d1ce4e5b9n;
const MixMultiplier2: Hash = 0x94d049bb133111ebn;

/**
 * Canonical quiet NaN, so all NaN keys hash identically.
 */
const CanonicalNanBits: Hash = 0x7ff8000000000000n;

const Encoder: TextEncoder = new TextEncoder();
const NumberBuffer: ArrayBuffer = new ArrayBuffer(8);
const NumberView: DataView = new DataView(NumberBuffer);

/**
 * SplitMix64 finalizer: a bijective 64-bit avalanche with excellent low-bit
 * distribution.
 */
const finalize64: (value: bigint) => Hash = (value: bigint): Hash => {
    let mixed: Hash = value & HashMask;
    mixed = ((mixed ^ (mixed >> 30n)) * MixMultiplier1) & HashMask;
    mixed = ((mixed ^ (mixed >> 27n)) * MixMultiplier2) & HashMask;
    return (mixed ^ (mixed >> 31n)) & HashMask;
};

/**
 * Random-looking domain tags keep the hash families of distinct key types apart.
 */
const TagUndefined: Hash = finalize64(0x01n);
const TagNull: Hash = finalize64(0x02n);
const TagBoolean: Hash = finalize64(0x03n);
const TagNumber: Hash = finalize64(0x04n);
const TagBigint: Hash = finalize64(0x05n);
const TagString: Hash = finalize64(0x06n);
const TagGlobalSymbol: Hash = finalize64(0x07n);
const TagLocalSymbol: Hash = finalize64(0x08n);
const TagReference: Hash = finalize64(0x09n);

/**
 * Identity ids for reference keys; process-local by design.
 */
const ReferenceIds: WeakMap<object, bigint> = new WeakMap<object, bigint>();
let NextReferenceId: Hash = 1n;

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
export const hashBytes: (bytes: Uint8Array, seed?: bigint) => Hash = (bytes: Uint8Array, seed: bigint = 0n): Hash => {
    let hash: Hash = (FnvOffsetBasis ^ (seed & HashMask)) & HashMask;
    for (let index: number = 0; index < bytes.length; index += 1) {
        hash = ((hash ^ BigInt(bytes[index])) * FnvPrime) & HashMask;
    }
    return finalize64(hash);
};

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
export const hashString: (value: string, seed?: bigint) => Hash = (value: string, seed: bigint = 0n): Hash => {
    return hashBytes(Encoder.encode(value), seed);
};

/**
 * Number bits under SameValueZero: `-0` becomes `+0`, `NaN` is canonical.
 */
const numberBits: (value: number) => Hash = (value: number): Hash => {
    if (Number.isNaN(value)) {
        return CanonicalNanBits;
    }
    NumberView.setFloat64(0, value === 0 ? 0 : value, false);
    return NumberView.getBigUint64(0, false);
};

/**
 * Hash a symbol by its global registry key or, failing that, its description.
 */
const hashSymbol: (value: symbol) => Hash = (value: symbol): Hash => {
    const globalKey: string | undefined = Symbol.keyFor(value);
    if (globalKey !== (void 0)) {
        return mixHash(TagGlobalSymbol, hashString(globalKey));
    }
    const description: string | undefined = value.description;
    if (description === (void 0)) {
        return mixHash(TagLocalSymbol, 0n);
    }
    return mixHash(TagLocalSymbol, hashString(description));
};

/**
 * Hash an object or function by stable, process-local identity.
 */
const hashReference: (value: object) => Hash = (value: object): Hash => {
    let id: Hash | undefined = ReferenceIds.get(value);
    if (id === (void 0)) {
        id = NextReferenceId;
        NextReferenceId += 1n;
        ReferenceIds.set(value, id);
    }
    return mixHash(TagReference, finalize64(id));
};

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
export const hashKey: (value: unknown) => Hash = (value: unknown): Hash => {
    if (value === null) {
        return mixHash(TagNull, 0n);
    }
    switch (typeof(value)) {
        case "undefined":
            return mixHash(TagUndefined, 0n);
        case "boolean":
            return mixHash(TagBoolean, value ? 1n : 0n);
        case "number":
            return mixHash(TagNumber, numberBits(value));
        case "bigint":
            return mixHash(TagBigint, hashString(value.toString(10)));
        case "string":
            return mixHash(TagString, hashString(value));
        case "symbol":
            return hashSymbol(value);
        case "object":
        case "function":
            return hashReference(value);
        default:
            throw new TypeError(`cannot hash a key of type ${typeof(value)}`);
    }
};

/**
 * SameValueZero key equality: `-0` equals `+0`, and `NaN` equals `NaN`.
 * This is the default equality used by all containers in this module family.
 */
export const sameKey: (a: unknown, b: unknown) => boolean = (a: unknown, b: unknown): boolean => {
    return a === b || Object.is(a, b);
};

/**
 * Combine two 64-bit values into one hash.
 *
 * Both inputs are masked to 64 bits first. For a fixed first argument the
 * combination is injective in the second (and vice versa), so mixing domain
 * tags with payload hashes does not itself introduce avoidable collisions.
 * The result is avalanche-finalized.
 */
export const mixHash: (a: bigint, b: bigint) => Hash = (a: bigint, b: bigint): Hash => {
    const left: Hash = a & HashMask;
    const right: Hash = b & HashMask;
    return finalize64((left + GoldenGamma) ^ right);
};

/**
 * Format a hash as lowercase hexadecimal.
 *
 * The output is at least `width` characters, zero-padded on the left. `width`
 * is a minimum, never a truncation: a 64-bit value always needs at most 16
 * digits, and narrower widths cannot make the representation round-trip
 * incompletely. `hashFromHex(hashToHex(value, width))` equals
 * `value & HashMask` for every valid width.
 *
 * @param value - Hash value; masked to 64 bits.
 * @param width - Minimum number of hex digits, a non-negative safe integer.
 * Defaults to `16`.
 * @throws RangeError if `width` is not a non-negative safe integer.
 */
export const hashToHex: (value: Hash, width?: number) => string = (value: Hash, width: number = 16): string => {
    if (!Number.isSafeInteger(width) || width < 0) {
        throw new RangeError(`width must be a non-negative safe integer, received ${`${width}`}`);
    }
    return (value & HashMask).toString(16).padStart(width, "0");
};

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
export const hashFromHex: (hex: string) => Hash = (hex: string): Hash => {
    if (typeof(hex) !== "string") {
        throw new TypeError("hashFromHex expects a string");
    }
    const match: RegExpExecArray | null = /^(?:0[xX])?([0-9a-fA-F]+)$/.exec(hex);
    if (match === null) {
        throw new TypeError(`invalid 64-bit hex hash: ${JSON.stringify(hex)}`);
    }
    const digits: string = match[1].replace(/^0+/, "");
    if (digits.length > 16) {
        throw new TypeError(`hash exceeds 64 bits: ${JSON.stringify(hex)}`);
    }
    return digits.length === 0 ? 0n : BigInt(`0x${digits}`);
};

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
