/**
 * Raw byte fingerprints.
 *
 * This is the primitive every other content kind reduces to: text, JSON and
 * files all end up as a `Uint8Array` and then as a header plus payload. Its one
 * rule is that the bytes are hashed exactly as given 鈥?no decoding, no newline
 * folding, no charset guessing. That is what makes `0x80` and `0x81` different
 * fingerprints, which the legacy `readFile(path, "utf8")` path got wrong (both
 * decode to U+FFFD and collided).
 */
import { isAlgorithmId } from "./algorithm.ts";
import type { AlgorithmId } from "./algorithm.ts";
import { UnsupportedAlgorithm } from "./error.ts";
import { Policy } from "./policy.ts";
import { fingerprintPayload } from "./preimage.ts";
import type { Fingerprint } from "./preimage.ts";

/**
 * Option shape for `fingerprintBytes`. SHA-256 is the only backend in this
 * build; the other registered ids raise `UnsupportedAlgorithm` rather than
 * falling back silently.
 */
export interface BytesFingerprintOptions {
    readonly algorithm?: AlgorithmId;
}

/**
 * Fingerprint a byte sequence under the `bytes/raw` policy.
 *
 * The `bytes` field of the returned reference is the exact payload length, and
 * `digest` is the CAS-compatible `sha256:<hex>` spelling so callers can keep
 * storing it in the existing content stores unchanged.
 */
export const fingerprintBytes: (bytes: Uint8Array, options?: BytesFingerprintOptions) => Fingerprint = (bytes: Uint8Array, options?: BytesFingerprintOptions): Fingerprint => {
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError(`fingerprintBytes expects a Uint8Array, received ${typeof(bytes)}`);
    }
    const algorithm: AlgorithmId = options?.algorithm ?? "sha256";
    if (!isAlgorithmId(algorithm)) {
        throw new UnsupportedAlgorithm([`unknown algorithm "${algorithm}"; known: sha256, sha512, sha3-256, blake2b-512`]);
    }
    return fingerprintPayload(algorithm, "bytes", Policy.bytesRaw, bytes);
};
