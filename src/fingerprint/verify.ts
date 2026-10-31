/**
 * Reference comparison and verification.
 *
 * Comparing digests alone is the bug this module exists to avoid: the same
 * payload bytes hashed under two policies produce two different digests, so a
 * verifier that only sees hex cannot know which rules to apply. `matches`
 * therefore compares the identity quadruple — algorithm, kind, policy and
 * digest — following RFC 6920 §2 (identity is algorithm + value; presentation
 * fields are ignored) extended with the two fields that decide how the value was
 * computed.
 *
 * `verify` is one step stricter and also compares the declared payload length,
 * mirroring OCI's "compare size before digest" rule: a reference that claims a
 * different length is a different descriptor even when the hash agrees. The
 * length is cheap to compare and shrinks the space an attacker has to search.
 *
 * The hex comparison is length-checked first and then scans the whole string
 * without an early exit, so a mismatch does not reveal the position of the first
 * differing digit through timing. This is not a substitute for a MAC, but it
 * costs nothing and avoids being the weakest link in an otherwise
 * constant-time comparison chain.
 */
import { FingerprintMismatch } from "./error.ts";
import type { FingerprintRef } from "./preimage.ts";

/**
 * Compare two equal-length strings without returning early.
 *
 * Different lengths fail immediately: the length is public (it is the algorithm
 * identity), so no secret leaks, and scanning would need padding to be
 * meaningful anyway.
 */
const constantTimeEquals: (left: string, right: string) => boolean = (left: string, right: string): boolean => {
    if (left.length !== right.length) {
        return false;
    }
    let difference: number = 0;
    for (let index: number = 0; index < left.length; index += 1) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
};

/**
 * Describe a reference for a human reader without re-validating it.
 *
 * `formatRef` cannot be used in the mismatch message: it validates the fields
 * and throws, which would replace the `FingerprintMismatch` the caller is
 * supposed to catch with an unrelated `invalid_ref`.
 */
const describe: (ref: FingerprintRef) => string = (ref: FingerprintRef): string =>
    `${ref.algorithm}:${ref.kind}:${ref.policy}:${ref.bytes}:${ref.digest}`;

/**
 * True when both references name the same value under the same rules.
 *
 * Kind and policy are compared as strings because they are frozen vocabulary;
 * digest comparison is constant-time-ish. `bytes` is deliberately not part of
 * the identity here (RFC 6920 identity is algorithm + value), but `verify`
 * compares it as well.
 */
export const matches: (expected: FingerprintRef, actual: FingerprintRef) => boolean = (expected: FingerprintRef, actual: FingerprintRef): boolean => {
    if (expected.algorithm !== actual.algorithm) {
        return false;
    }
    if (expected.kind !== actual.kind) {
        return false;
    }
    if (expected.policy !== actual.policy) {
        return false;
    }
    return constantTimeEquals(expected.digest, actual.digest);
};

/**
 * Assert that `actual` is the value `expected` names; throw `FingerprintMismatch`
 * otherwise.
 *
 * The message contains both references (algorithm, kind, policy, bytes and hex)
 * plus one line per differing field. A log line that only says "mismatch" cannot
 * be acted on: the reader needs to know whether the policy changed or the bytes
 * did.
 */
export const verify: (expected: FingerprintRef, actual: FingerprintRef) => void = (expected: FingerprintRef, actual: FingerprintRef): void => {
    const problems: string[] = [];
    if (expected.algorithm !== actual.algorithm) {
        problems.push(`algorithm differs: expected ${expected.algorithm}, received ${actual.algorithm}`);
    }
    if (expected.kind !== actual.kind) {
        problems.push(`kind differs: expected ${expected.kind}, received ${actual.kind}`);
    }
    if (expected.policy !== actual.policy) {
        problems.push(`policy differs: expected ${expected.policy}, received ${actual.policy}`);
    }
    if (!constantTimeEquals(expected.digest, actual.digest)) {
        problems.push("digest differs");
    }
    if (expected.bytes !== actual.bytes) {
        problems.push(`bytes differs: expected ${expected.bytes}, received ${actual.bytes}`);
    }
    if (problems.length === 0) {
        return;
    }
    throw new FingerprintMismatch([`expected ${describe(expected)} but received ${describe(actual)}`, ...problems]);
};
