/**
 * The preimage format: the security core of the module.
 *
 * Every digest except the tree root is
 *
 *     sha256( utf8("amp.fp/1\n" + kind + "\n" + policy + "\n" + bytes + "\n") || payload )
 *
 * and nothing else in the module is allowed to build one, so a call site cannot
 * forget a field. The design has four load-bearing properties:
 *
 * 1. Domain separation. `amp.fp/1` plus the kind is the first thing hashed, the
 *    same idea as git's `"<type> <len>\0"` prefix: a digest of one kind cannot
 *    be replayed as another kind, and a `bytes` digest of a file cannot pass as
 *    a `text` digest of the same octets.
 * 2. Length prefix. `bytes` is written twice, once in the header for the
 *    verifier to read and once implicitly by the payload itself, so `("ab","c")`
 *    and `("a","bc")` cannot collide.
 * 3. Closed vocabularies. Kind and policy are checked against frozen sets before
 *    the header is assembled. A free-form string could contain `\n` and inject a
 *    second field, which would let two different inputs share a preimage; a
 *    closed set makes that impossible without needing an escaping rule.
 * 4. Printable header. When a digest does not reproduce, the header tells a
 *    human which policy produced it. That diagnostic value is worth the few
 *    bytes.
 */
import { bytesToHex, createHasher, isAlgorithmId } from "./algorithm.ts";
import type { AlgorithmId, ByteHasher } from "./algorithm.ts";
import { FingerprintError, UnsupportedAlgorithm, UnsupportedKind } from "./error.ts";
import { isKnownPolicy } from "./policy.ts";

/**
 * Frozen input kinds. A kind is part of the preimage, not a label: changing the
 * set changes every digest that names the changed member.
 */
export type FingerprintKind = "bytes" | "text" | "string" | "number" | "boolean" | "null" | "json" | "file" | "tree";

/**
 * A comparable, storable, serialisable reference.
 *
 * `bytes` is the length of the payload that was hashed (not necessarily the
 * on-disk size: a `file/text+nfc` fingerprint counts the normalised payload,
 * while the file's own size is reported separately). `digest` is lowercase hex;
 * uppercase is rejected by every parser because a different string would be a
 * different reference.
 */
export interface FingerprintRef {
    readonly scheme: "amp.fp/1";
    readonly algorithm: AlgorithmId;
    readonly kind: FingerprintKind;
    readonly policy: string;
    readonly bytes: number;
    readonly digest: string;
}

/**
 * A reference plus the CAS-compatible short form of the same digest.
 *
 * `digest` stays `"<algorithm>:<hex>"` so existing stores that expect
 * `sha256:<hex>` keep working unchanged while the reference carries the extra
 * information a verifier needs.
 */
export interface Fingerprint {
    readonly ref: FingerprintRef;
    readonly digest: string;
}

/**
 * Scheme name of the reference object. The textual form uses the `ampfp1:`
 * prefix instead, because a `.` and `/` would make the token harder to embed in
 * URIs and registry keys.
 */
type SchemeNameLiteral = "amp.fp/1";
export const SchemeName: SchemeNameLiteral = "amp.fp/1";

const HeaderDomain: string = "amp.fp/1";
const KindList: readonly FingerprintKind[] = ["bytes", "text", "string", "number", "boolean", "null", "json", "file", "tree"];
const KnownKinds: ReadonlySet<string> = new Set<string>(KindList);

/**
 * True for one of the frozen kind names.
 */
export const isFingerprintKind: (value: string) => value is FingerprintKind = (value: string): value is FingerprintKind => KnownKinds.has(value);

/**
 * Reject a kind that could not have been produced by this module. Used by the
 * reference parser as well as by the preimage builder, so a hand-written ref
 * cannot smuggle an unknown kind into a comparison.
 */
export const assertKind: (value: string) => FingerprintKind = (value: string): FingerprintKind => {
    if (!isFingerprintKind(value)) {
        throw new UnsupportedKind([`unknown fingerprint kind "${value}"; known: ${KindList.join(", ")}`]);
    }
    return value;
};

/**
 * Reject a policy outside the frozen vocabulary. The allow-list is membership
 * in `policy.ts`, not a regex, so the accepted set is exactly the set this
 * module can emit.
 */
export const assertPolicy: (policy: string) => string = (policy: string): string => {
    if (!isKnownPolicy(policy)) {
        throw new FingerprintError("unsupported_policy", [`unknown fingerprint policy "${policy}"; use a constant from Policy`]);
    }
    return policy;
};

/**
 * Render the short form used by CAS and by the ledger chain.
 *
 * Kept here (rather than in `ref.ts`) so `preimage.ts` can produce a complete
 * `Fingerprint` without importing the parser layer, which would be a cycle.
 */
export const shortForm: (algorithm: AlgorithmId, digest: string) => string = (algorithm: AlgorithmId, digest: string): string => `${algorithm}:${digest}`;

/**
 * ASCII encoder for the header. The header is built from frozen ASCII tokens and
 * a decimal length, so a byte-per-code-unit copy is exact and avoids a
 * dependency from `preimage.ts` back to `text.ts` (which imports this file).
 *
 * The guard is not decoration: if a future policy constant ever contains a
 * non-ASCII character this throws instead of silently UTF-8-encoding it, which
 * would make the header length disagree with the byte count.
 */
const asciiBytes: (text: string) => Uint8Array = (text: string): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(text.length);
    for (let index: number = 0; index < text.length; index += 1) {
        const code: number = text.charCodeAt(index);
        if (code > 0x7f) {
            throw new FingerprintError("invalid_ref", [`header token "${text}" is not ASCII at index ${index}`]);
        }
        bytes[index] = code;
    }
    return bytes;
};

/**
 * Create a hasher that already contains the preimage header and therefore only
 * needs the payload.
 *
 * Streaming callers (`file.ts`, `tree.ts`) use this instead of
 * `fingerprintPayload`, because they know the payload length from `fstat`
 * before the first byte arrives and must not buffer the file to learn it. The
 * caller is responsible for feeding exactly `byteLength` bytes; the file layer
 * checks its read count against the same number.
 */
export const createPayloadHasher: (algorithm: AlgorithmId, kind: FingerprintKind, policy: string, byteLength: number) => ByteHasher = (algorithm: AlgorithmId, kind: FingerprintKind, policy: string, byteLength: number): ByteHasher => {
    if (!isAlgorithmId(algorithm)) {
        throw new UnsupportedAlgorithm([`unknown algorithm "${algorithm}"; known: sha256, sha512, sha3-256, blake2b-512`]);
    }
    assertKind(kind);
    assertPolicy(policy);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new FingerprintError("invalid_ref", [`payload length must be a non-negative safe integer, received ${byteLength}`]);
    }
    const header: string = `${HeaderDomain}\n${kind}\n${policy}\n${byteLength}\n`;
    const hasher: ByteHasher = createHasher(algorithm);
    hasher.update(asciiBytes(header));
    return hasher;
};

/**
 * The only in-memory digest constructor in the module.
 *
 * Returns both the reference (which records what was hashed and how) and the
 * short form (which the CAS layers already understand). Both come from the same
 * hex string, so they cannot disagree.
 */
export const fingerprintPayload: (algorithm: AlgorithmId, kind: FingerprintKind, policy: string, payload: Uint8Array) => Fingerprint = (algorithm: AlgorithmId, kind: FingerprintKind, policy: string, payload: Uint8Array): Fingerprint => {
    if (!(payload instanceof Uint8Array)) {
        throw new TypeError(`fingerprint payload must be a Uint8Array, received ${typeof(payload)}`);
    }
    const hasher: ByteHasher = createPayloadHasher(algorithm, kind, policy, payload.byteLength);
    hasher.update(payload);
    const digest: string = bytesToHex(hasher.digest());
    const ref: FingerprintRef = {
        scheme: SchemeName,
        algorithm,
        kind,
        policy,
        bytes: payload.byteLength,
        digest,
    };
    return { ref, digest: shortForm(algorithm, digest) };
};
