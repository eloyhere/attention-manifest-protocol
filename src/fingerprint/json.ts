/**
 * `json/jcs`: the fingerprint kind for structured values.
 *
 * The encoder itself lives in `src/semantic/canonical.ts`. There is exactly one
 * definition of "the bytes a digest covers" in this repository, because two
 * implementations drift: the signing layer would accept a value the fingerprint
 * layer rejects (or vice versa), and two digests of the same object would stop
 * agreeing. This file therefore owns only what is specific to fingerprinting 鈥? * the choice of kind and policy, and the mapping from a rejection reason to a
 * `NormalizationRejected` error.
 *
 * What the shared encoder rejects and why:
 *
 * - unpaired surrogates in keys and values (RFC 8785 搂3.2.2.2), which
 *   `JSON.stringify` escapes and `TextEncoder` silently replaces with U+FFFD,
 *   so two different strings would share one digest;
 * - `-0` (RFC 8785 appendix B writes it as `0`), unless the caller explicitly
 *   passes `negativeZero: "as-zero"`, which turns an accidental collision into a
 *   declared one.
 *
 * Duplicate member names cannot occur here: JavaScript objects have already
 * collapsed them before this function sees a value. Detecting duplicates is a
 * parsing-boundary duty (`JSON.parse` keeps the last one silently), documented
 * in the design as a known gap rather than something this layer can fix.
 */
import { canonicalJson, canonicalProblem } from "../semantic/canonical.ts";
import type { NegativeZeroPolicy } from "../semantic/canonical.ts";
import { jsonValueProblem } from "../semantic/jsonValue.ts";
import { fingerprintBytes } from "./bytes.ts";
import { FingerprintError, NormalizationRejected } from "./error.ts";
import { fingerprintBoolean, fingerprintNull, fingerprintNumber } from "./number.ts";
import { Policy } from "./policy.ts";
import { fingerprintPayload } from "./preimage.ts";
import type { Fingerprint } from "./preimage.ts";
import { encodeUtf8Strict, fingerprintString } from "./text.ts";

/**
 * Re-exported so callers of `fingerprintJson` do not have to reach into the
 * semantic base for one option type.
 */
export type { NegativeZeroPolicy };

/**
 * Option shape for `fingerprintJson`.
 */
export interface JsonFingerprintOptions {
    readonly negativeZero?: NegativeZeroPolicy;
}

/**
 * Fingerprint a JSON value under `json/jcs`.
 *
 * Rejections carry the offending path (for example `$.a[2]`) so a caller can
 * fix the value without bisecting it. `negativeZero: "as-zero"` is the only way
 * to hash `-0`, and it produces exactly the digest of `0`; that equality is
 * intentional and documented, not an accident.
 *
 * The structural check runs before the policy check so the reported reason names
 * the more fundamental problem: a `Date` is "not a plain object", not "an
 * unsupported number".
 */
export const fingerprintJson: (value: unknown, options?: JsonFingerprintOptions) => Fingerprint = (value: unknown, options?: JsonFingerprintOptions): Fingerprint => {
    const negativeZero: string = options?.negativeZero ?? "reject";
    if (negativeZero !== "reject" && negativeZero !== "as-zero") {
        throw new FingerprintError("unsupported_policy", [`unknown negativeZero policy "${negativeZero}"; expected "reject" or "as-zero"`]);
    }
    const structural: string | undefined = jsonValueProblem(value);
    if (structural !== (void 0)) {
        throw new NormalizationRejected([`json/jcs rejected ${structural}`]);
    }
    const policy: string | undefined = canonicalProblem(value, { negativeZero: negativeZero === "as-zero" ? "as-zero" : "reject" });
    if (policy !== (void 0)) {
        throw new NormalizationRejected([`json/jcs rejected ${policy}`]);
    }
    const canonical: string = canonicalJson(value, { negativeZero: negativeZero === "as-zero" ? "as-zero" : "reject" });
    const payload: Uint8Array = encodeUtf8Strict(canonical);
    return fingerprintPayload("sha256", "json", Policy.jsonJcs, payload);
};

/**
 * Fingerprint any supported value by dispatching on its runtime shape.
 *
 * The dispatch is deliberately conservative: a string becomes a `string`
 * fingerprint (exact code units) rather than a normalised `text` one, because a
 * generic entry point must not normalize silently 鈥?a caller that wants NFC
 * calls `fingerprintText`. Everything that is not a primitive or a byte array
 * goes through the JSON policy, which is also the catch-all that rejects
 * functions, symbols, `undefined`, `Date`, class instances, sparse arrays and
 * cycles.
 *
 * Living in `json.ts` is intentional: JSON is the residual branch, and the
 * dispatcher has to import the primitive constructors anyway.
 */
export const fingerprintOf: (value: unknown) => Fingerprint = (value: unknown): Fingerprint => {
    if (value === null) {
        return fingerprintNull();
    }
    const kind: string = typeof(value);
    if (kind === "string") {
        return fingerprintString(value as string);
    }
    if (kind === "number") {
        return fingerprintNumber(value as number);
    }
    if (kind === "boolean") {
        return fingerprintBoolean(value as boolean);
    }
    if (value instanceof Uint8Array) {
        return fingerprintBytes(value);
    }
    return fingerprintJson(value);
};
