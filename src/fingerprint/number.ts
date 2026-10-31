/**
 * Number and literal policies.
 *
 * The module rejects every number that a serialiser would rewrite into a
 * different value, because a digest over the rewritten form no longer binds what
 * the caller passed:
 *
 * - `NaN` and `卤Infinity` have no JSON spelling at all.
 * - `-0` is written as `0` by RFC 8785 (appendix B) and by `JSON.stringify`, so
 *   `-0` and `0` would silently share a digest. The default here is to reject;
 *   `json.ts` offers an explicit `negativeZero: "as-zero"` for callers that have
 *   decided the collision is the semantics they want.
 *
 * `number/integer` adds the I-JSON requirement (`Number.isSafeInteger`): beyond
 * 2^53-1 the decimal representation is ambiguous across implementations, so an
 * "integer" that large is not portable enough to fingerprint as one.
 */
import { NormalizationRejected } from "./error.ts";
import { Policy } from "./policy.ts";
import { fingerprintPayload } from "./preimage.ts";
import type { Fingerprint } from "./preimage.ts";

/**
 * Option shape for `fingerprintNumber`; `ieee754` is the default because it
 * accepts every finite number and records the shortest round-trip spelling.
 */
export interface NumberFingerprintOptions {
    readonly policy?: "ieee754" | "integer";
}

/**
 * Reject the values that have no faithful decimal spelling.
 */
const assertFiniteNumber: (value: number) => void = (value: number): void => {
    if (Number.isNaN(value)) {
        throw new NormalizationRejected(["number is NaN; NaN has no canonical decimal spelling"]);
    }
    if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
        throw new NormalizationRejected([`number is ${value}; Infinity has no canonical decimal spelling`]);
    }
};

/**
 * ASCII bytes for the decimal payload without importing `text.ts`.
 *
 * The payload is produced by `Number::toString` and therefore consists of
 * ASCII digits, `.`, `-`, `e` and `+`. Going through `encodeUtf8Strict` would
 * work but would add a dependency edge from the number layer to the text layer
 * for no benefit; the guard makes the assumption explicit and loud.
 */
const textToBytes: (text: string) => Uint8Array = (text: string): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(text.length);
    for (let index: number = 0; index < text.length; index += 1) {
        const code: number = text.charCodeAt(index);
        if (code > 0x7f) {
            throw new NormalizationRejected([`number payload "${text}" is not ASCII`]);
        }
        bytes[index] = code;
    }
    return bytes;
};

/**
 * Fingerprint a number.
 *
 * Payload is the ES `Number::toString` shortest round-trip form (the same
 * spelling `JSON.stringify` uses and RFC 8785 requires), so `1e21` becomes
 * `1e+21` and cannot be confused with the string `"1e21"` because the kind and
 * policy are bound into the header.
 */
export const fingerprintNumber: (value: number, options?: NumberFingerprintOptions) => Fingerprint = (value: number, options?: NumberFingerprintOptions): Fingerprint => {
    const policy: string = options?.policy ?? "ieee754";
    assertFiniteNumber(value);
    if (Object.is(value, -0)) {
        throw new NormalizationRejected(["-0 is rejected: RFC 8785 serialises it as 0, so it would share a digest with 0"]);
    }
    if (policy === "ieee754") {
        return fingerprintPayload("sha256", "number", Policy.numberIeee, textToBytes(`${value}`));
    }
    if (policy === "integer") {
        if (!Number.isSafeInteger(value)) {
            throw new NormalizationRejected([`${value} is not a safe integer; number/integer requires |n| <= 2^53-1`]);
        }
        return fingerprintPayload("sha256", "number", Policy.numberInteger, textToBytes(`${value}`));
    }
    throw new NormalizationRejected([`unknown number policy "${policy}"; expected "ieee754" or "integer"`]);
};

/**
 * Fingerprint a boolean as the literal `true` or `false`.
 *
 * The literal is hashed as text, but the kind and policy in the header keep it
 * distinct from the string `"true"` and from the JSON value `true`.
 */
export const fingerprintBoolean: (value: boolean) => Fingerprint = (value: boolean): Fingerprint => {
    if (typeof(value) !== "boolean") {
        throw new TypeError(`fingerprintBoolean expects a boolean, received ${typeof(value)}`);
    }
    return fingerprintPayload("sha256", "boolean", Policy.booleanLiteral, textToBytes(value ? "true" : "false"));
};

/**
 * Fingerprint `null` as the literal `null`.
 *
 * A dedicated constructor exists so `null` is not confused with an absent value:
 * `undefined` is rejected by the JSON policy, while `null` is a legitimate,
 * stable JSON value.
 */
export const fingerprintNull: () => Fingerprint = (): Fingerprint => fingerprintPayload("sha256", "null", Policy.nullLiteral, textToBytes("null"));
