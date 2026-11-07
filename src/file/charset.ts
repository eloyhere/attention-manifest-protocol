import { isString } from "semantic-typescript";

/**
 * Encoding and line-ending facts of a file. The decoded buffer is always kept with
 * `\n` line endings; `encodeText` restores `eol`/BOM on commit.
 */
export type FileEncoding = "utf-8" | "utf-16le" | "utf-16be";
export type LineEnding = "\n" | "\r\n";

export interface CharsetInfo {
    readonly encoding: FileEncoding;
    readonly bom: boolean;
    readonly eol: LineEnding;
    readonly mixedEol: boolean;
    readonly finalNewline: boolean;
    /** True when the bytes cannot be treated as editable text (binary or unsupported encoding). */
    readonly binary: boolean;
}

export const defaultCharset: CharsetInfo = Object.freeze({
    encoding: "utf-8", bom: false, eol: "\n", mixedEol: false, finalNewline: false, binary: false,
});

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
const UTF32LE_BOM = [0xff, 0xfe, 0x00, 0x00] as const;
const UTF32BE_BOM = [0x00, 0x00, 0xfe, 0xff] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    if (bytes.length < prefix.length) return false;
    return prefix.every((value, index) => bytes[index] === value);
}

function decodeWith(bytes: Uint8Array, label: string): string {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
}

function decodeUtf16(bytes: Uint8Array, little: boolean): string {
    if (bytes.length % 2 !== 0) throw new TypeError("truncated UTF-16 input");
    const units = new Uint16Array(bytes.length / 2);
    for (let index = 0; index < units.length; index += 1) {
        const low = bytes[index * 2] ?? 0;
        const high = bytes[index * 2 + 1] ?? 0;
        units[index] = little ? (low | (high << 8)) : ((low << 8) | high);
    }
    return String.fromCharCode(...units);
}

function encodeUtf16(text: string, little: boolean): Uint8Array {
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        bytes[index * 2] = little ? code & 0xff : (code >> 8) & 0xff;
        bytes[index * 2 + 1] = little ? (code >> 8) & 0xff : code & 0xff;
    }
    return bytes;
}

/** Number of NUL bytes at even/odd positions, used to guess BOM-less UTF-16. */
function utf16Guess(bytes: Uint8Array): FileEncoding | undefined {
    const limit = Math.min(bytes.length, 1024);
    if (limit < 4) return undefined;
    let evenZeros = 0;
    let oddZeros = 0;
    let asciiEven = 0;
    let asciiOdd = 0;
    for (let index = 0; index + 1 < limit; index += 2) {
        if (bytes[index] === 0) evenZeros += 1;
        else if ((bytes[index] ?? 0) < 0x80) asciiEven += 1;
        if (bytes[index + 1] === 0) oddZeros += 1;
        else if ((bytes[index + 1] ?? 0) < 0x80) asciiOdd += 1;
    }
    const pairs = Math.floor(limit / 2);
    if (pairs === 0) return undefined;
    if (oddZeros / pairs > 0.4 && asciiEven / pairs > 0.4) return "utf-16le";
    if (evenZeros / pairs > 0.4 && asciiOdd / pairs > 0.4) return "utf-16be";
    return undefined;
}

export function detectLineEnding(text: string): { readonly eol: LineEnding; readonly mixed: boolean; readonly finalNewline: boolean } {
    let crlf = 0;
    let cr = 0;
    let lf = 0;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code === 13) {
            if (text.charCodeAt(index + 1) === 10) { crlf += 1; index += 1; }
            else cr += 1;
        } else if (code === 10) lf += 1;
    }
    const mixed = (crlf > 0 && lf > 0) || cr > 0;
    // A text without any newline (including "" and a BOM-only file) has no CR evidence,
    // so it must default to LF rather than let the 0 >= 0 tie pick CRLF.
    const eol: LineEnding = (crlf > 0 || cr > 0) && crlf >= lf ? "\r\n" : "\n";
    return { eol, mixed, finalNewline: /\r?\n$/.test(text) };
}

/** Normalizes every newline form to `\n`; the edit buffer always uses this form. */
export function normalizeToLf(text: string): string {
    if (!isString(text)) throw new TypeError("text must be a string");
    return text.replace(/\r\n?/g, "\n");
}

export function normalizeToEol(text: string, eol: LineEnding): string {
    return normalizeToLf(text).replace(/\n/g, eol);
}

export function detectCharset(bytes: Uint8Array): CharsetInfo {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
    if (bytes.length === 0) return defaultCharset;

    const utf32 = startsWith(bytes, UTF32LE_BOM) || startsWith(bytes, UTF32BE_BOM);
    if (utf32) return Object.freeze({ ...defaultCharset, binary: true });

    if (startsWith(bytes, UTF8_BOM)) {
        const body = bytes.subarray(UTF8_BOM.length);
        try {
            const text = decodeWith(body, "utf-8");
            return charsetOf("utf-8", true, text);
        } catch {
            return Object.freeze({ ...defaultCharset, bom: true, binary: true });
        }
    }
    if (startsWith(bytes, UTF16LE_BOM) || startsWith(bytes, UTF16BE_BOM)) {
        const encoding: FileEncoding = startsWith(bytes, UTF16LE_BOM) ? "utf-16le" : "utf-16be";
        const offset = encoding === "utf-16le" ? UTF16LE_BOM.length : UTF16BE_BOM.length;
        try {
            const text = decodeUtf16(bytes.subarray(offset), encoding === "utf-16le");
            return charsetOf(encoding, true, text);
        } catch {
            return Object.freeze({ ...defaultCharset, encoding, bom: true, binary: true });
        }
    }
    const guessed = utf16Guess(bytes);
    if (guessed) {
        try {
            const text = decodeUtf16(bytes, guessed === "utf-16le");
            if (!text.includes("\u0000")) return charsetOf(guessed, false, text);
        } catch {
            /* fall through to UTF-8 */
        }
    }
    try {
        const text = decodeWith(bytes, "utf-8");
        if (text.includes("\u0000")) return Object.freeze({ ...defaultCharset, binary: true });
        return charsetOf("utf-8", false, text);
    } catch {
        return Object.freeze({ ...defaultCharset, binary: true });
    }
}

function charsetOf(encoding: FileEncoding, bom: boolean, text: string): CharsetInfo {
    const { eol, mixed, finalNewline } = detectLineEnding(text);
    return Object.freeze({ encoding, bom, eol, mixedEol: mixed, finalNewline, binary: false });
}

export function decodeText(bytes: Uint8Array, charset: CharsetInfo): string {
    if (charset.binary) throw new TypeError("binary content cannot be decoded as text");
    let body = bytes;
    if (charset.bom) {
        if (charset.encoding === "utf-8" && startsWith(bytes, UTF8_BOM)) body = bytes.subarray(UTF8_BOM.length);
        else if (charset.encoding === "utf-16le" && startsWith(bytes, UTF16LE_BOM)) body = bytes.subarray(2);
        else if (charset.encoding === "utf-16be" && startsWith(bytes, UTF16BE_BOM)) body = bytes.subarray(2);
    }
    const text = charset.encoding === "utf-8" ? decodeWith(body, "utf-8") : decodeUtf16(body, charset.encoding === "utf-16le");
    return normalizeToLf(text);
}

/** Encodes an edit buffer back to disk bytes, restoring line endings and BOM. */
export function encodeText(text: string, charset: CharsetInfo): Uint8Array {
    if (charset.binary) throw new TypeError("binary content cannot be encoded from text");
    const normalized = normalizeToEol(text, charset.eol);
    const body = charset.encoding === "utf-8" ? new TextEncoder().encode(normalized) : encodeUtf16(normalized, charset.encoding === "utf-16le");
    if (!charset.bom) return body;
    const prefix = charset.encoding === "utf-8" ? UTF8_BOM : charset.encoding === "utf-16le" ? UTF16LE_BOM : UTF16BE_BOM;
    const output = new Uint8Array(prefix.length + body.length);
    output.set(prefix, 0);
    output.set(body, prefix.length);
    return output;
}
