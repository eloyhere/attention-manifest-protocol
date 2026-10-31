/**
 * Textual references.
 *
 * Two forms exist for two different jobs. `sha256:<hex>` is the CAS-compatible
 * short form that every existing content store, ledger checkpoint and audit
 * record in this repository already uses; keeping it byte-identical means the
 * fingerprint module can be adopted without migrating storage. The full
 * `ampfp1:<algorithm>:<kind>:<policy>:<bytes>:<hex>` form is what a verifier
 * needs to recompute the value: without kind and policy the hex is not
 * reproducible even in principle.
 *
 * The full form percent-encodes `/` inside the policy so a reference is one
 * opaque token with a fixed number of colon-separated fields (OCI uses the same
 * `algorithm ":" encoded` idea). The parser accepts the escaped and the plain
 * spelling, because a `/` cannot be confused with a field separator anyway;
 * being liberal on input here costs nothing and avoids a second syntax during
 * migration. Both spellings decode to the same frozen policy string, and a
 * policy outside that vocabulary is rejected rather than carried around.
 *
 * Both parsers are strict for the parts that identify a value: lowercase hex
 * only, an exact length for the algorithm that is named, and a registered
 * algorithm. A parser that folded case or accepted any hex length would make
 * "the algorithm is part of the name" decorative.
 */
import { algorithmSpec, digestHexLength, isAlgorithmId, isLowerHex } from "./algorithm.ts";
import type { AlgorithmId, AlgorithmSpec } from "./algorithm.ts";
import { FingerprintError } from "./error.ts";
import { isKnownPolicy } from "./policy.ts";
import { SchemeName, assertKind, assertPolicy, isFingerprintKind, shortForm } from "./preimage.ts";
import type { FingerprintRef } from "./preimage.ts";

/**
 * Prefix of the full textual form. Short enough to be embedded in a registry
 * key and distinct enough that a `sha256:` string cannot be mistaken for it.
 */
const RefPrefix: string = "ampfp1";

const ShortFieldCount: number = 2;
const RefFieldCount: number = 6;
const RefPrefixIndex: number = 0;
const RefAlgorithmIndex: number = 1;
const RefKindIndex: number = 2;
const RefPolicyIndex: number = 3;
const RefBytesIndex: number = 4;
const RefDigestIndex: number = 5;

/**
 * `%` first, then `/`, so the escape introduced by the second replacement is not
 * escaped again. The emitted form uses uppercase hex digits inside the escape,
 * matching the `json%2Fjcs` spelling in the design document.
 */
const encodePolicyToken: (policy: string) => string = (policy: string): string => policy.replace(/%/g, "%25").replace(/\//g, "%2F");

/**
 * Decode a policy token, or `undefined` when it is not valid percent-encoding.
 * `decodeURIComponent` also leaves a plain `/` untouched, which is what makes
 * the unescaped spelling parse.
 */
const decodePolicyToken: (token: string) => string | undefined = (token: string): string | undefined => {
    try {
        return decodeURIComponent(token);
    } catch {
        return (void 0);
    }
};

/**
 * Decimal grammar for the payload length: no sign, no leading zeros, no
 * exponent. `007` and `7` would otherwise be two spellings of one reference.
 */
const isDecimal: (text: string) => boolean = (text: string): boolean => /^(?:0|[1-9][0-9]*)$/.test(text);

/**
 * Validate the parts of a reference that identify a value.
 *
 * Formatting uses it so this module cannot emit a malformed reference that its
 * own parser would reject; the error code is `invalid_ref` because the caller
 * passed a reference, not because a policy refused an input.
 */
const assertFormattable: (ref: FingerprintRef) => number = (ref: FingerprintRef): number => {
    const spec: AlgorithmSpec = algorithmSpec(ref.algorithm);
    assertKind(ref.kind);
    assertPolicy(ref.policy);
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
        throw new FingerprintError("invalid_ref", [`bytes must be a non-negative safe integer, received ${ref.bytes}`]);
    }
    const expectedLength: number = spec.digestBytes * 2;
    if (!isLowerHex(ref.digest, expectedLength)) {
        throw new FingerprintError("invalid_ref", [`digest must be ${expectedLength} lowercase hex characters for ${ref.algorithm}`]);
    }
    return expectedLength;
};

/**
 * Render the CAS-compatible short form. Throws when the reference is malformed
 * instead of returning a string that no parser would accept.
 */
export const formatShort: (ref: FingerprintRef) => string = (ref: FingerprintRef): string => {
    assertFormattable(ref);
    return shortForm(ref.algorithm, ref.digest);
};

/**
 * Parse the short form.
 *
 * Returns `undefined` for anything that is not exactly `<known-algorithm>:<hex>`
 * with the digest length that algorithm defines. Uppercase is rejected rather
 * than lowercased: `SHA256:` and `sha256:` would otherwise name the same digest
 * with two strings, which is the ambiguity this module removes.
 */
export const parseShort: (text: string) => { algorithm: AlgorithmId; digest: string; } | undefined = (text: string): { algorithm: AlgorithmId; digest: string; } | undefined => {
    if (typeof(text) !== "string") {
        return (void 0);
    }
    const parts: string[] = text.split(":");
    if (parts.length !== ShortFieldCount) {
        return (void 0);
    }
    const algorithmName: string = parts[0];
    if (!isAlgorithmId(algorithmName)) {
        return (void 0);
    }
    const digest: string = parts[1];
    if (!isLowerHex(digest, digestHexLength(algorithmName))) {
        return (void 0);
    }
    return { algorithm: algorithmName, digest };
};

/**
 * Render the full reference, with the policy percent-encoded.
 *
 * The output is the canonical spelling: lowercase hex, decimal length without
 * padding, `ampfp1` prefix. Everything a verifier needs to recompute the digest
 * is in the string, and `parseRef` round-trips it exactly.
 */
export const formatRef: (ref: FingerprintRef) => string = (ref: FingerprintRef): string => {
    assertFormattable(ref);
    return `${RefPrefix}:${ref.algorithm}:${ref.kind}:${encodePolicyToken(ref.policy)}:${ref.bytes}:${ref.digest}`;
};

/**
 * Parse the full reference, or return `undefined` when any field is unknown or
 * malformed.
 *
 * Unknown algorithms and policies yield `undefined` here 鈥?a parse result is not
 * yet a value that must be hashed 鈥?while formatting a reference that names an
 * unknown algorithm raises `UnsupportedAlgorithm`, because at that point a digest
 * name is being produced. The scheme is rebuilt from the constant rather than
 * echoed, so the returned object cannot carry a hand-written `scheme` that
 * disagrees with the parsed prefix.
 */
export const parseRef: (text: string) => FingerprintRef | undefined = (text: string): FingerprintRef | undefined => {
    if (typeof(text) !== "string") {
        return (void 0);
    }
    const parts: string[] = text.split(":");
    if (parts.length !== RefFieldCount) {
        return (void 0);
    }
    if (parts[RefPrefixIndex] !== RefPrefix) {
        return (void 0);
    }
    const algorithmName: string = parts[RefAlgorithmIndex];
    if (!isAlgorithmId(algorithmName)) {
        return (void 0);
    }
    const kindName: string = parts[RefKindIndex];
    if (!isFingerprintKind(kindName)) {
        return (void 0);
    }
    const policy: string | undefined = decodePolicyToken(parts[RefPolicyIndex]);
    if (policy === (void 0) || !isKnownPolicy(policy)) {
        return (void 0);
    }
    const bytesText: string = parts[RefBytesIndex];
    if (!isDecimal(bytesText)) {
        return (void 0);
    }
    const bytes: number = Number.parseInt(bytesText, 10);
    if (!Number.isSafeInteger(bytes)) {
        return (void 0);
    }
    const digest: string = parts[RefDigestIndex];
    if (!isLowerHex(digest, digestHexLength(algorithmName))) {
        return (void 0);
    }
    return { scheme: SchemeName, algorithm: algorithmName, kind: kindName, policy, bytes, digest };
};
