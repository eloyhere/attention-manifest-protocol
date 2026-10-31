/**
 * Algorithm registry and the portable SHA-256 core.
 *
 * Two rules shape this file. First, the algorithm is named in every reference,
 * so the registry is the only place that knows how long a digest is: parsing,
 * formatting and comparison ask it instead of hard-coding "64 hex characters".
 * Second, the module must stay dependency-free and behave identically in Node
 * and the browser, so `node:crypto` is never imported here; `sha256` is a
 * genuine incremental FIPS 180-4 implementation over raw bytes. `src/semantic/sha256.ts`
 * remains the string-oriented implementation used by `canonical()`; this one
 * hashes bytes so binary content cannot be rewritten by a UTF-8 encoder.
 *
 * The other identifiers are registered but carry no backend in this build. That
 * is deliberate: a reference that names `sha512` must still parse and round-trip
 * (its digest length is a property of the algorithm, not of this build), while
 * asking for a digest raises `UnsupportedAlgorithm` rather than silently
 * falling back to SHA-256.
 */
import { FingerprintError, UnsupportedAlgorithm } from "./error.ts";

/**
 * Frozen algorithm identifiers. Adding one is a wire-format change: it must ship
 * with known-answer vectors and a cross-check against `node:crypto`.
 */
export type AlgorithmId = "sha256" | "sha512" | "sha3-256" | "blake2b-512";

/**
 * Registry row. `digestBytes` is needed even for algorithms without a backend
 * because `parseShort`/`parseRef` must reject a hex string of the wrong length
 * for the algorithm it claims to be.
 */
export interface AlgorithmSpec {
    readonly id: AlgorithmId;
    readonly digestBytes: number;
    readonly backend: "portable" | "unavailable";
}

/**
 * Declaration order is the canonical listing order; nothing in the module
 * depends on iteration order, but diagnostics and future catalogues do.
 */
export const AlgorithmIds: readonly AlgorithmId[] = ["sha256", "sha512", "sha3-256", "blake2b-512"];

const Algorithms: ReadonlyMap<AlgorithmId, AlgorithmSpec> = new Map<AlgorithmId, AlgorithmSpec>([
    ["sha256", { id: "sha256", digestBytes: 32, backend: "portable" }],
    ["sha512", { id: "sha512", digestBytes: 64, backend: "unavailable" }],
    ["sha3-256", { id: "sha3-256", digestBytes: 32, backend: "unavailable" }],
    ["blake2b-512", { id: "blake2b-512", digestBytes: 64, backend: "unavailable" }],
]);

/**
 * True for a value that is one of the four registered identifiers. Used by the
 * parsers, which must reject an unknown algorithm instead of guessing.
 */
export const isAlgorithmId: (value: string) => value is AlgorithmId = (value: string): value is AlgorithmId => Algorithms.has(value as AlgorithmId);

/**
 * Look up a registered algorithm. A value that is syntactically fine but not
 * registered is an `UnsupportedAlgorithm`, because at this point a hasher is
 * required and there is nothing safe to substitute.
 */
export const algorithmSpec: (algorithm: AlgorithmId) => AlgorithmSpec = (algorithm: AlgorithmId): AlgorithmSpec => {
    const spec: AlgorithmSpec | undefined = Algorithms.get(algorithm);
    if (spec === (void 0)) {
        throw new UnsupportedAlgorithm([`unknown algorithm "${algorithm}"; known: ${AlgorithmIds.join(", ")}`]);
    }
    return spec;
};

/**
 * Expected lowercase-hex length of a digest for this algorithm. Both parsers
 * use it so "wrong length" and "wrong algorithm" cannot be confused.
 */
export const digestHexLength: (algorithm: AlgorithmId) => number = (algorithm: AlgorithmId): number => algorithmSpec(algorithm).digestBytes * 2;

const HexDigits: string = "0123456789abcdef";
const HexMask: number = 0x0f;
const HexShift: number = 4;

/**
 * Lowercase hex encoding. Lowercase is required by the OCI digest grammar and
 * by every existing `sha256:` reference in this repository; emitting uppercase
 * would create a second spelling of the same digest.
 */
export const bytesToHex: (bytes: Uint8Array) => string = (bytes: Uint8Array): string => {
    let out: string = "";
    for (let index: number = 0; index < bytes.length; index += 1) {
        const byte: number = bytes[index];
        out += `${HexDigits[byte >>> HexShift]}${HexDigits[byte & HexMask]}`;
    }
    return out;
};

const hexDigitValue: (code: number) => number = (code: number): number => {
    if (code >= 0x30 && code <= 0x39) {
        return code - 0x30;
    }
    return code - 0x61 + 10;
};

/**
 * Decode a hex digest back to bytes. Used by the tree leaf serialisation, which
 * has to embed a child digest as 32 raw bytes.
 */
export const hexToBytes: (hex: string) => Uint8Array = (hex: string): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(hex.length / 2);
    for (let index: number = 0; index < bytes.length; index += 1) {
        const offset: number = index * 2;
        bytes[index] = (hexDigitValue(hex.charCodeAt(offset)) << HexShift) | hexDigitValue(hex.charCodeAt(offset + 1));
    }
    return bytes;
};

/**
 * Strict lowercase-hex check. Uppercase is rejected rather than folded, because
 * `sha256:AB...` and `sha256:ab...` are different strings and a parser that
 * accepts both silently creates two names for one digest.
 */
export const isLowerHex: (text: string, length: number) => boolean = (text: string, length: number): boolean => {
    if (text.length !== length) {
        return false;
    }
    for (let index: number = 0; index < text.length; index += 1) {
        const code: number = text.charCodeAt(index);
        const digit: boolean = (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66);
        if (!digit) {
            return false;
        }
    }
    return true;
};

const Sha256InitialState: readonly number[] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const Sha256RoundConstants: Uint32Array = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
    0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
    0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
    0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const WordCount: number = 64;
const BlockBytes: number = 64;
const DigestBytes: number = 32;
const PaddingBoundary: number = 56;
const HighBitDivisor: number = 0x20000000;

const rotr: (value: number, shift: number) => number = (value: number, shift: number): number => ((value >>> shift) | (value << (32 - shift))) >>> 0;

/**
 * The FIPS 180-4 compression function for one 64-byte block.
 *
 * `words` is caller-provided scratch space so an incremental hasher does not
 * allocate 64 words per block; `src/semantic/sha256.ts` keeps the same loop but
 * reads from a padded copy of the whole input, which is exactly the 2x memory
 * cost this module cannot afford for streamed files.
 */
const compressBlock: (state: Uint32Array, block: Uint8Array, words: Uint32Array) => void = (state: Uint32Array, block: Uint8Array, words: Uint32Array): void => {
    for (let index: number = 0; index < 16; index += 1) {
        const offset: number = index * 4;
        words[index] = ((block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3]) >>> 0;
    }
    for (let index: number = 16; index < WordCount; index += 1) {
        const s0: number = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1: number = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a: number = state[0];
    let b: number = state[1];
    let c: number = state[2];
    let d: number = state[3];
    let e: number = state[4];
    let f: number = state[5];
    let g: number = state[6];
    let h: number = state[7];

    for (let index: number = 0; index < WordCount; index += 1) {
        const sigma1: number = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const choose: number = (e & f) ^ (~e & g);
        const temp1: number = (h + sigma1 + choose + Sha256RoundConstants[index] + words[index]) >>> 0;
        const sigma0: number = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const majority: number = (a & b) ^ (a & c) ^ (b & c);
        const temp2: number = (sigma0 + majority) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
};

/**
 * A streaming digest sink.
 *
 * `update` accepts arbitrary chunk boundaries and buffers a partial block
 * internally, so a file can be read in 1 MiB slices without the caller tracking
 * alignment. `digest` finalises the hash and is single-shot: a second call would
 * need a second padding pass over state that is already mutated, so it throws
 * instead of returning a silently wrong value.
 */
export interface ByteHasher {
    update(bytes: Uint8Array): ByteHasher;
    digest(): Uint8Array;
}

/**
 * Portable incremental SHA-256 over raw bytes.
 *
 * The implementation tracks the total byte count separately from the buffered
 * block because the FIPS padding needs the input length in bits; computing the
 * final eight bytes from `totalBytes` (high = bits >> 32, low = low 32 bits)
 * avoids the overflow a 32-bit byte counter would hit at 512 MiB.
 */
export const createSha256: () => ByteHasher = (): ByteHasher => {
    const state: Uint32Array = new Uint32Array(Sha256InitialState);
    const block: Uint8Array = new Uint8Array(BlockBytes);
    const words: Uint32Array = new Uint32Array(WordCount);
    let blockLength: number = 0;
    let totalBytes: number = 0;
    let finished: boolean = false;

    const hasher: ByteHasher = {
        update: (bytes: Uint8Array): ByteHasher => {
            if (finished) {
                throw new FingerprintError("hasher_finished", ["sha256 hasher already finalised; digest() is single-shot"]);
            }
            if (!(bytes instanceof Uint8Array)) {
                throw new TypeError(`sha256 hasher accepts Uint8Array, received ${typeof(bytes)}`);
            }
            totalBytes += bytes.length;
            let offset: number = 0;
            if (blockLength > 0) {
                const taken: number = Math.min(BlockBytes - blockLength, bytes.length);
                block.set(bytes.subarray(0, taken), blockLength);
                blockLength += taken;
                offset += taken;
                if (blockLength === BlockBytes) {
                    compressBlock(state, block, words);
                    blockLength = 0;
                }
            }
            while (offset + BlockBytes <= bytes.length) {
                compressBlock(state, bytes.subarray(offset, offset + BlockBytes), words);
                offset += BlockBytes;
            }
            if (offset < bytes.length) {
                block.set(bytes.subarray(offset), 0);
                blockLength = bytes.length - offset;
            }
            return hasher;
        },
        digest: (): Uint8Array => {
            if (finished) {
                throw new FingerprintError("hasher_finished", ["sha256 hasher already finalised; digest() is single-shot"]);
            }
            finished = true;
            const tail: Uint8Array = new Uint8Array(blockLength < PaddingBoundary ? BlockBytes : BlockBytes * 2);
            tail.set(block.subarray(0, blockLength));
            tail[blockLength] = 0x80;
            const highBits: number = Math.floor(totalBytes / HighBitDivisor);
            const lowBits: number = (totalBytes % HighBitDivisor) * 8;
            const view: DataView = new DataView(tail.buffer);
            view.setUint32(tail.length - 8, highBits);
            view.setUint32(tail.length - 4, lowBits);
            for (let offset: number = 0; offset < tail.length; offset += BlockBytes) {
                compressBlock(state, tail.subarray(offset, offset + BlockBytes), words);
            }
            const digest: Uint8Array = new Uint8Array(DigestBytes);
            const digestView: DataView = new DataView(digest.buffer);
            for (let index: number = 0; index < DigestBytes / 4; index += 1) {
                digestView.setUint32(index * 4, state[index]);
            }
            return digest;
        },
    };
    return hasher;
};

/**
 * One-shot SHA-256 over raw bytes. Thin wrapper so call sites do not repeat the
 * create/update/digest sequence and cannot forget the update.
 */
export const sha256Bytes: (bytes: Uint8Array) => Uint8Array = (bytes: Uint8Array): Uint8Array => createSha256().update(bytes).digest();

/**
 * Fail closed unless this build can actually compute the named algorithm.
 *
 * The registry must answer before any payload is touched: a caller that gets a
 * hasher is entitled to assume the algorithm in the reference is the algorithm
 * that ran. The same guard is called by the file layer before it opens a file,
 * so an unsupported algorithm fails without a pointless read instead of after
 * the work has already been done.
 */
export const assertBackend: (algorithm: AlgorithmId) => AlgorithmSpec = (algorithm: AlgorithmId): AlgorithmSpec => {
    const spec: AlgorithmSpec = algorithmSpec(algorithm);
    if (spec.backend !== "portable" || spec.id !== "sha256") {
        throw new UnsupportedAlgorithm([`algorithm "${algorithm}" has no backend in this dependency-free build; only sha256 is available`]);
    }
    return spec;
};

/**
 * Construct a hasher for any registered algorithm, or fail closed.
 *
 * Kept as a thin wrapper over `assertBackend` so the availability rule lives in
 * exactly one place.
 */
export const createHasher: (algorithm: AlgorithmId) => ByteHasher = (algorithm: AlgorithmId): ByteHasher => {
    assertBackend(algorithm);
    return createSha256();
};
