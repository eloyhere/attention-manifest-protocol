/**
 * Strict UTF-8 plus the `text` and `string` policies.
 *
 * `TextEncoder` replaces an unpaired surrogate with U+FFFD, so `"\uD800"` and
 * `"\uFFFD"` would hash identically 鈥?the exact collision this module exists to
 * prevent (the design audit measured it). `encodeUtf8Strict` therefore validates
 * surrogate pairing before it writes a byte and is the only string-to-bytes
 * path in the module; `json.ts`, `file.ts` and `tree.ts` all use it for that
 * reason.
 *
 * The two policies answer two different questions and both are needed:
 *
 * - `text/utf8+nfc+lf` removes presentation differences that carry no content
 *   (one leading BOM, CRLF versus LF) and applies NFC, so `"茅"` and `"e\u0301"`
 *   are one value. NFC and not NFKC: compatibility decomposition is lossy
 *   (`铿乣 becomes `fi`), which would make distinct texts collide on purpose.
 * - `string/utf16-strict` preserves the code units exactly. Sometimes the byte
 *   identity is what the caller wants to pin, and a generic `fingerprintOf`
 *   dispatcher must not silently normalise what it was given.
 */
import { NormalizationRejected } from "./error.ts";
import { Policy } from "./policy.ts";
import { fingerprintPayload } from "./preimage.ts";
import type { Fingerprint } from "./preimage.ts";

/**
 * Option shape for `fingerprintText`. `nfc` is the default because a newline or
 * BOM difference is almost never the content the caller meant to pin.
 */
export interface TextFingerprintOptions {
    readonly policy?: "nfc" | "raw";
}

const HexRadix: number = 16;
const SurrogateHighStart: number = 0xd800;
const SurrogateHighEnd: number = 0xdbff;
const SurrogateLowStart: number = 0xdc00;
const SurrogateLowEnd: number = 0xdfff;
const SurrogateBase: number = 0x10000;

const hex4: (value: number) => string = (value: number): string => value.toString(HexRadix).toUpperCase().padStart(4, "0");

/**
 * Compute the UTF-8 length of `text` while rejecting any unpaired surrogate.
 *
 * The validation and the measurement happen in one pass because both walk the
 * same code units: a separate validator would double the scans and could drift
 * out of sync with the encoder. The returned length lets the encoder allocate
 * once, so no intermediate array of code points is materialised.
 */
const utf8ByteLength: (text: string) => number = (text: string): number => {
    let length: number = 0;
    for (let index: number = 0; index < text.length; index += 1) {
        const unit: number = text.charCodeAt(index);
        if (unit < 0x80) {
            length += 1;
            continue;
        }
        if (unit < 0x800) {
            length += 2;
            continue;
        }
        if (unit >= SurrogateHighStart && unit <= SurrogateHighEnd) {
            const next: number = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
            if (next < SurrogateLowStart || next > SurrogateLowEnd) {
                throw new NormalizationRejected([`text contains a lone high surrogate U+${hex4(unit)} at index ${index}`]);
            }
            length += 4;
            index += 1;
            continue;
        }
        if (unit >= SurrogateLowStart && unit <= SurrogateLowEnd) {
            throw new NormalizationRejected([`text contains a lone low surrogate U+${hex4(unit)} at index ${index}`]);
        }
        length += 3;
    }
    return length;
};

/**
 * Encode a JavaScript string as UTF-8 without ever substituting U+FFFD.
 *
 * Two passes: the first measures and validates, the second writes. A paired
 * surrogate is written as one four-byte sequence and the loop skips its low
 * half, so the output is standard UTF-8 (the CESU-8 spelling of a pair would be
 * six bytes and would collide with different text).
 */
export const encodeUtf8Strict: (text: string) => Uint8Array = (text: string): Uint8Array => {
    if (typeof(text) !== "string") {
        throw new TypeError(`encodeUtf8Strict expects a string, received ${typeof(text)}`);
    }
    const bytes: Uint8Array = new Uint8Array(utf8ByteLength(text));
    let offset: number = 0;
    for (let index: number = 0; index < text.length; index += 1) {
        const unit: number = text.charCodeAt(index);
        if (unit < 0x80) {
            bytes[offset] = unit;
            offset += 1;
            continue;
        }
        if (unit < 0x800) {
            bytes[offset] = 0xc0 | (unit >> 6);
            bytes[offset + 1] = 0x80 | (unit & 0x3f);
            offset += 2;
            continue;
        }
        if (unit >= SurrogateHighStart && unit <= SurrogateHighEnd) {
            const next: number = text.charCodeAt(index + 1);
            const codePoint: number = SurrogateBase + ((unit - SurrogateHighStart) << 10) + (next - SurrogateLowStart);
            bytes[offset] = 0xf0 | (codePoint >> 18);
            bytes[offset + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
            bytes[offset + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
            bytes[offset + 3] = 0x80 | (codePoint & 0x3f);
            offset += 4;
            index += 1;
            continue;
        }
        bytes[offset] = 0xe0 | (unit >> 12);
        bytes[offset + 1] = 0x80 | ((unit >> 6) & 0x3f);
        bytes[offset + 2] = 0x80 | (unit & 0x3f);
        offset += 3;
    }
    return bytes;
};

/**
 * Apply the `text/utf8+nfc+lf` normalisation, in the order the policy name
 * implies: exactly one leading BOM is dropped (interior BOMs are content), CRLF
 * and lone CR become LF, then NFC is applied.
 *
 * NUL is rejected rather than hashed: a NUL inside text truncates every C
 * consumer of the string, so two texts that are equal only up to a NUL would be
 * treated as identical downstream while this module would say they differ.
 * Rejecting keeps the two views aligned.
 */
export const normalizeTextNfc: (text: string) => string = (text: string): string => {
    const withoutBom: string = text.startsWith("\uFEFF") ? text.slice(1) : text;
    const lfOnly: string = withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const normalized: string = lfOnly.normalize("NFC");
    const nulIndex: number = normalized.indexOf("\u0000");
    if (nulIndex !== -1) {
        throw new NormalizationRejected([`text contains U+0000 at index ${nulIndex}; the text policy forbids NUL`]);
    }
    return normalized;
};

/**
 * Fingerprint text under the NFC policy (default) or the raw policy.
 *
 * `raw` still uses the strict encoder: "no normalisation" means no BOM, newline
 * or Unicode folding, not "let the platform substitute replacement characters".
 */
export const fingerprintText: (text: string, options?: TextFingerprintOptions) => Fingerprint = (text: string, options?: TextFingerprintOptions): Fingerprint => {
    const policy: string = options?.policy ?? "nfc";
    if (policy === "nfc") {
        const payload: Uint8Array = encodeUtf8Strict(normalizeTextNfc(text));
        return fingerprintPayload("sha256", "text", Policy.textNfc, payload);
    }
    if (policy === "raw") {
        return fingerprintPayload("sha256", "text", Policy.textRaw, encodeUtf8Strict(text));
    }
    throw new NormalizationRejected([`unknown text policy "${policy}"; expected "nfc" or "raw"`]);
};

/**
 * Fingerprint the exact code units of a string: no BOM stripping, no newline
 * folding, no NFC. `"茅"` (U+00E9) and `"e\u0301"` (e + U+0301) are different
 * strings and therefore different fingerprints, which is the point of having a
 * `string` kind next to `text`.
 */
export const fingerprintString: (text: string) => Fingerprint = (text: string): Fingerprint =>
    fingerprintPayload("sha256", "string", Policy.stringStrict, encodeUtf8Strict(text));
