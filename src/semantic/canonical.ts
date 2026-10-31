import { jsonValueProblem } from "./jsonValue.ts";
import { sha256Hex } from "./sha256.ts";

/**
 * Canonical JSON (RFC 8785 spirit: sorted keys, no whitespace).
 * Everything that gets signed or digested must go through this first.
 *
 * Only strict I-JSON values are accepted. `undefined`, non-finite numbers,
 * functions, `Date`/`Map`/`Set`, sparse arrays, cycles and accessors are
 * rejected with a `TypeError` naming the offending path, because
 * `JSON.stringify` would otherwise silently rewrite them and a digest would no
 * longer bind the value the caller passed.
 *
 * Two further cases are rejected because RFC 8785 rejects them, even though
 * `JSON.stringify` happily rewrites both:
 *
 * - an unpaired surrogate (§3.2.2.2). `JSON.stringify` escapes it and
 *   `TextEncoder` replaces it with U+FFFD, so two different strings can hash to
 *   the same digest while a compliant verifier re-derives a different byte
 *   string. A signature over such a value cannot be re-checked.
 * - `-0` (appendix B). JCS serialises `-0` as `0`, so `-0` and `0` are one
 *   digest. That is legal JCS but it is a silent rewrite of the caller's value,
 *   which is exactly what this module refuses elsewhere. Callers that really
 *   mean "treat -0 as 0" must say so with `negativeZero: "as-zero"`, which turns
 *   an accidental collision into a declared policy.
 *
 * Unicode normalization is deliberately **not** applied: RFC 8785 §3.1 requires
 * string data to be preserved as-is, and a digest that normalises would no
 * longer be a digest of the bytes the caller supplied. Text-level normalisation
 * belongs to a caller that records the policy, which is what `src/fingerprint`
 * does for its `text` kind.
 */

/**
 * How `-0` is treated when canonicalising.
 *
 * `"reject"` is the default and matches this module's contract that a digest
 * must never cover a value `JSON.stringify` silently rewrote. `"as-zero"` is
 * the explicit opt-in for a caller that has to interoperate with a plain JCS
 * implementation, which maps `-0` to `0`.
 */
export type NegativeZeroPolicy = "reject" | "as-zero";

/**
 * Options for {@link canonicalJson} and {@link canonical} may only affect the
 * documented policy, never the shape of the output.
 */
export interface CanonicalOptions {
    negativeZero?: NegativeZeroPolicy;
}

const SurrogateHighStart: number = 0xd800;
const SurrogateHighEnd: number = 0xdbff;
const SurrogateLowStart: number = 0xdc00;
const SurrogateLowEnd: number = 0xdfff;

/**
 * Report the first unpaired surrogate in one string.
 *
 * JS strings are UTF-16 code units, so a string can hold half of a surrogate
 * pair. JSON can represent it with an escape, but UTF-8 cannot encode it, and
 * `TextEncoder` silently substitutes U+FFFD —which is why this is an error
 * rather than a normalisation.
 */
const surrogateProblem: (text: string, at: string) => string | undefined = (text: string, at: string): string | undefined => {
    for (let index: number = 0; index < text.length; index += 1) {
        const unit: number = text.charCodeAt(index);
        if (unit >= SurrogateHighStart && unit <= SurrogateHighEnd) {
            const next: number = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
            if (next < SurrogateLowStart || next > SurrogateLowEnd) {
                return `${at} contains an unpaired high surrogate at index ${index}`;
            }
            index += 1;
            continue;
        }
        if (unit >= SurrogateLowStart && unit <= SurrogateLowEnd) {
            return `${at} contains an unpaired low surrogate at index ${index}`;
        }
    }
    return (void 0);
};

/**
 * Report the first value the strict policy cannot bind, or `undefined`.
 *
 * Structural problems are already covered by `jsonValueProblem`; this pass adds
 * the two policy rules that depend on the caller's options. Keeping it as a
 * pure function instead of a thrower lets `src/fingerprint` translate the same
 * decision into its own error type rather than re-implementing RFC 8785.
 */
export const canonicalProblem: (value: unknown, options?: CanonicalOptions) => string | undefined = (value: unknown, options: CanonicalOptions = {}): string | undefined => {
    const negativeZero: NegativeZeroPolicy = options.negativeZero ?? "reject";
    if (negativeZero !== "reject" && negativeZero !== "as-zero") {
        throw new TypeError(`unknown negativeZero policy "${negativeZero}"; expected "reject" or "as-zero"`);
    }
    const walk: (item: unknown, at: string) => string | undefined = (item: unknown, at: string): string | undefined => {
        if (item === null) {
            return (void 0);
        }
        const kind: string = typeof(item);
        if (kind === "string") {
            return surrogateProblem(item as string, at);
        }
        if (kind === "number") {
            return negativeZero === "reject" && Object.is(item, -0) ? `${at} is -0; pass { negativeZero: "as-zero" } to accept it explicitly` : (void 0);
        }
        if (kind !== "object") {
            return (void 0);
        }
        if (Array.isArray(item)) {
            for (let index: number = 0; index < item.length; index += 1) {
                const problem: string | undefined = walk(item[index], `${at}[${index}]`);
                if (problem !== (void 0)) {
                    return problem;
                }
            }
            return (void 0);
        }
        const record: Record<string, unknown> = item as Record<string, unknown>;
        const keys: string[] = Object.keys(record);
        for (let index: number = 0; index < keys.length; index += 1) {
            const key: string = keys[index];
            const keyProblem: string | undefined = surrogateProblem(key, `${at} key`);
            if (keyProblem !== (void 0)) {
                return keyProblem;
            }
            const problem: string | undefined = walk(record[key], `${at}.${key}`);
            if (problem !== (void 0)) {
                return problem;
            }
        }
        return (void 0);
    };
    return walk(value, "$");
};

/**
 * Throw a `TypeError` naming the first reason the value cannot be canonicalised.
 *
 * Structural and policy problems share one error type because the caller's only
 * useful response is the same: fix the value. The message names the path.
 */
const assertStrictCanonical: (value: unknown, options: CanonicalOptions) => void = (value: unknown, options: CanonicalOptions): void => {
    const structural: string | undefined = jsonValueProblem(value);
    if (structural !== (void 0)) {
        throw new TypeError(structural);
    }
    const policy: string | undefined = canonicalProblem(value, options);
    if (policy !== (void 0)) {
        throw new TypeError(policy);
    }
};

/**
 * Encode a value already proven canonicalisable by `assertStrictCanonical`.
 */
const encodeCanonical: (value: unknown) => string = (value: unknown): string => {
    if (value === null) {
        return "null";
    }
    const kind: string = typeof(value);
    if (kind === "boolean") {
        return value === true ? "true" : "false";
    }
    if (kind === "string" || kind === "number") {
        return JSON.stringify(value) as string;
    }
    if (Array.isArray(value)) {
        const elements: string[] = [];
        for (let index: number = 0; index < value.length; index += 1) {
            elements.push(encodeCanonical(value[index]));
        }
        return `[${elements.join(",")}]`;
    }
    const record: Record<string, unknown> = value as Record<string, unknown>;
    const keys: string[] = Object.keys(record).sort();
    const members: string[] = [];
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: string = keys[index];
        members.push(`${JSON.stringify(key)}:${encodeCanonical(record[key])}`);
    }
    return `{${members.join(",")}}`;
};

/**
 * Canonical JSON with the documented policy options.
 *
 * One definition of "the bytes a digest covers" is the whole point: signing,
 * pinning, ledger chaining and fingerprints all call this instead of each
 * re-deriving the rules.
 */
export const canonicalJson: (value: unknown, options?: CanonicalOptions) => string = (value: unknown, options: CanonicalOptions = {}): string => {
    assertStrictCanonical(value, options);
    return encodeCanonical(value);
};

/**
 * Canonical JSON with the default policy (`-0` rejected).
 */
export const canonical: (value: unknown) => string = (value: unknown): string => canonicalJson(value);

export const digestOf: (value: unknown) => string = (value: unknown): string => {
    const text: string = canonicalJson(value);
    return `sha256:${sha256Hex(text)}`;
};
