/**
 * Charset detection, decoding and line indexing.
 *
 * Detection is deliberately conservative. A file that does not decode as
 * UTF-8/UTF-16 is only treated as Latin-1 when it looks like text; anything
 * with NUL bytes or a high control-character ratio is `binary`, because
 * guessing an encoding is how a tool silently corrupts a file on write.
 */
import type { Charset } from "./types.ts";
import { fail } from "../file/errors.ts";

const Utf8Bom: readonly number[] = [0xef, 0xbb, 0xbf];
const Utf16LeBom: readonly number[] = [0xff, 0xfe];
const Utf16BeBom: readonly number[] = [0xfe, 0xff];

/**
 * Result of sniffing a byte sequence. `bomLength` is the number of leading
 * bytes that are part of the encoding marker and must not appear in the text.
 */
export interface DetectedCharset {
    readonly charset: Charset;
    readonly bomLength: number;
    readonly binary: boolean;
}

const startsWith: (bytes: Uint8Array, prefix: readonly number[]) => boolean = (bytes: Uint8Array, prefix: readonly number[]): boolean => {
    if (bytes.length < prefix.length) {
        return false;
    }
    for (let index: number = 0; index < prefix.length; index += 1) {
        if (bytes[index] !== prefix[index]) {
            return false;
        }
    }
    return true;
};

const isUtf8: (bytes: Uint8Array) => boolean = (bytes: Uint8Array): boolean => {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
};

/**
 * Heuristic for BOM-less UTF-16: sample ASCII code units and count NULs on
 * each byte lane. A binary file with many NULs usually fails both lanes.
 */
const detectUtf16WithoutBom: (bytes: Uint8Array) => "utf-16le" | "utf-16be" | undefined = (bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined => {
    if (bytes.length < 8 || bytes.length % 2 !== 0) {
        return undefined;
    }
    const sample: number = Math.min(bytes.length, 512);
    let evenNul: number = 0;
    let oddNul: number = 0;
    let evenTotal: number = 0;
    let oddTotal: number = 0;
    for (let index: number = 0; index + 1 < sample; index += 2) {
        evenTotal += 1;
        oddTotal += 1;
        if (bytes[index] === 0) {
            evenNul += 1;
        }
        if (bytes[index + 1] === 0) {
            oddNul += 1;
        }
    }
    if (oddNul / oddTotal > 0.6 && evenNul / evenTotal < 0.1) {
        return "utf-16le";
    }
    if (evenNul / evenTotal > 0.6 && oddNul / oddTotal < 0.1) {
        return "utf-16be";
    }
    return undefined;
};

/**
 * Control-character ratio over the first 8 KiB. Tab/newline/carriage return are
 * text; other C0 controls usually mean a container format.
 */
const controlRatio: (bytes: Uint8Array) => number = (bytes: Uint8Array): number => {
    const sample: number = Math.min(bytes.length, 8192);
    let controls: number = 0;
    for (let index: number = 0; index < sample; index += 1) {
        const byte: number = bytes[index];
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            controls += 1;
        }
    }
    return sample === 0 ? 0 : controls / sample;
};

/**
 * Sniff a byte sequence.
 *
 * @param bytes - Raw file bytes.
 * @returns Charset, BOM length and whether the content is binary.
 */
export const detectCharset: (bytes: Uint8Array) => DetectedCharset = (bytes: Uint8Array): DetectedCharset => {
    if (bytes.length === 0) {
        return { charset: "utf-8", bomLength: 0, binary: false };
    }
    if (startsWith(bytes, Utf8Bom)) {
        return { charset: "utf-8-bom", bomLength: Utf8Bom.length, binary: false };
    }
    if (startsWith(bytes, Utf16LeBom)) {
        return { charset: "utf-16le", bomLength: Utf16LeBom.length, binary: false };
    }
    if (startsWith(bytes, Utf16BeBom)) {
        return { charset: "utf-16be", bomLength: Utf16BeBom.length, binary: false };
    }
    const utf16: "utf-16le" | "utf-16be" | undefined = detectUtf16WithoutBom(bytes);
    if (utf16 !== undefined) {
        return { charset: utf16, bomLength: 0, binary: false };
    }
    if (isUtf8(bytes)) {
        return { charset: "utf-8", bomLength: 0, binary: controlRatio(bytes) > 0.05 };
    }
    return { charset: "latin1", bomLength: 0, binary: controlRatio(bytes) > 0.05 };
};

/**
 * Decode bytes with a declared charset. `binary` and `none` are refused: a
 * caller must decide whether base64 is the right transport.
 *
 * @param bytes - Raw bytes.
 * @param charset - Charset from detection or node metadata.
 * @returns Decoded text without a BOM.
 */
export const decodeText: (bytes: Uint8Array, charset: Charset) => string = (bytes: Uint8Array, charset: Charset): string => {
    switch (charset) {
        case "utf-8": {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        }
        case "utf-8-bom": {
            const bom: DetectedCharset = detectCharset(bytes);
            const body: Uint8Array = bom.bomLength === 0 ? bytes : bytes.subarray(bom.bomLength);
            return new TextDecoder("utf-8", { fatal: true }).decode(body);
        }
        case "utf-16le": {
            const body: Uint8Array = startsWith(bytes, Utf16LeBom) ? bytes.subarray(2) : bytes;
            return new TextDecoder("utf-16le", { fatal: true }).decode(body);
        }
        case "utf-16be": {
            const body: Uint8Array = startsWith(bytes, Utf16BeBom) ? bytes.subarray(2) : bytes;
            return new TextDecoder("utf-16be", { fatal: true }).decode(body);
        }
        case "latin1": {
            return Buffer.from(bytes).toString("latin1");
        }
        case "binary":
        case "none": {
            return fail("binary_file");
        }
        default: {
            return fail("charset_unsupported");
        }
    }
};

/**
 * Encode text for a write. The returned bytes include the BOM for
 * `utf-8-bom`/UTF-16 encodings, so a caller can write them verbatim.
 *
 * @param text - Text to encode.
 * @param encoding - Target encoding; defaults to strict UTF-8.
 * @returns Encoded bytes.
 */
export const encodeText: (text: string, encoding?: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1") => Uint8Array = (
    text: string,
    encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1" = "utf-8",
): Uint8Array => {
    switch (encoding) {
        case "utf-8": {
            return new TextEncoder().encode(text);
        }
        case "utf-8-bom": {
            const body: Uint8Array = new TextEncoder().encode(text);
            const result: Uint8Array = new Uint8Array(body.length + 3);
            result.set(Utf8Bom);
            result.set(body, 3);
            return result;
        }
        case "utf-16le": {
            const body: Buffer = Buffer.from(text, "utf16le");
            return new Uint8Array(Buffer.concat([Buffer.from(Utf16LeBom), body]));
        }
        case "utf-16be": {
            const body: Buffer = Buffer.from(text, "utf16le");
            body.swap16();
            return new Uint8Array(Buffer.concat([Buffer.from(Utf16BeBom), body]));
        }
        case "latin1": {
            if ([...text].some((character: string): boolean => character.codePointAt(0)! > 0xff)) {
                return fail("charset_unsupported");
            }
            return new Uint8Array(Buffer.from(text, "latin1"));
        }
        default: {
            return fail("charset_unsupported");
        }
    }
};

/**
 * Count logical lines. The empty file has zero lines; a trailing newline does
 * not add a phantom empty line, matching how editors number a file.
 *
 * @param text - Decoded text.
 * @returns Line count as a bigint.
 */
export const countLines: (text: string) => bigint = (text: string): bigint => {
    if (text.length === 0) {
        return 0n;
    }
    let count: bigint = 0n;
    for (let index: number = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
            count += 1n;
        }
    }
    if (text.charCodeAt(text.length - 1) !== 10) {
        count += 1n;
    }
    return count;
};

/**
 * Lazily-built newline index over one decoded text.
 *
 * Offsets are JavaScript string indices (UTF-16 code units), which is exactly
 * what `String.prototype.slice` consumes. Byte offsets are intentionally not
 * stored: a caller that needs bytes uses `Buffer.byteLength` on the slice.
 */
export class LineIndex {
    private readonly text: string;
    private offsets: number[] | undefined;

    constructor(text: string) {
        this.text = text;
    }

    /**
     * Number of lines in the text.
     */
    get count(): number {
        return this.starts().length;
    }

    private starts(): number[] {
        if (this.offsets !== undefined) {
            return this.offsets;
        }
        const starts: number[] = [];
        if (this.text.length > 0) {
            starts.push(0);
            for (let index: number = 0; index < this.text.length; index += 1) {
                if (this.text.charCodeAt(index) === 10 && index + 1 < this.text.length) {
                    starts.push(index + 1);
                }
            }
        }
        this.offsets = starts;
        return starts;
    }

    /**
     * Start offset of a 1-based line; lines past the end clamp to EOF.
     */
    start(line: number): number {
        const starts: number[] = this.starts();
        if (line <= 1) {
            return 0;
        }
        return starts[Math.min(line - 1, starts.length)] ?? this.text.length;
    }

    /**
     * End offset (exclusive) of a 1-based line, including its newline.
     */
    end(line: number): number {
        return this.start(line + 1);
    }

    /**
     * Slice a bounded run of lines.
     *
     * @param startLine - 1-based inclusive start.
     * @param maxLines - Maximum number of lines.
     * @returns Text without a trailing newline plus the inclusive range.
     */
    slice(startLine: number, maxLines: number): { text: string; startLine: number; endLine: number; } {
        const starts: number[] = this.starts();
        const total: number = starts.length;
        if (total === 0 || startLine > total) {
            return { text: "", startLine, endLine: startLine - 1 };
        }
        const first: number = Math.max(1, startLine);
        const last: number = Math.min(total, first + Math.max(1, maxLines) - 1);
        const from: number = starts[first - 1];
        const to: number = last < total ? starts[last] : this.text.length;
        let text: string = this.text.slice(from, to);
        if (text.endsWith("\n")) {
            text = text.slice(0, -1);
        }
        if (text.endsWith("\r")) {
            text = text.slice(0, -1);
        }
        return { text, startLine: first, endLine: last };
    }
}
