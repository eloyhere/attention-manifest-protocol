/**
 * Bounded text paging over one workspace file.
 *
 * A read resolves the caller path through the sandbox, verifies that the target
 * is a regular file, refuses binary content and decodes only text. The decoded
 * text is then cut by line count and by a UTF-8 byte budget, so a caller can
 * page a large file instead of paying for the whole content in one tool result.
 *
 * The returned fingerprint hashes the whole file, not the page: a write that
 * echoes it back is a real compare-and-swap, because the same page bytes under
 * a new fingerprint mean the file changed. Host paths never appear in the page
 * or in an error string.
 */
import { lstatSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";

import { rawDigest } from "../fingerprint/raw.ts";
import { LRUUnorderedMap } from "../structure/lru.ts";
import { countLines, decodeText, detectCharset, LineIndex } from "../syntax/charset.ts";
import type { DetectedCharset } from "../syntax/charset.ts";
import { fail, isFilesystemError } from "./errors.ts";
import type { PathSandbox } from "./path.ts";
import type { Charset } from "../syntax/types.ts";
import type { ReadPage, ReadRequest, RootedPath } from "./types.ts";

/**
 * Largest file a single read will load, in bytes. The whole file has to be
 * decoded to count lines and to fingerprint it, so the ceiling is the point
 * where paging stops being cheaper than a targeted tool.
 */
const DefaultFileBytes: number = 8 * 1024 * 1024;

/**
 * Default page size in lines.
 */
const DefaultPageLines: number = 200;

/**
 * Hard upper bound on a page's line count, regardless of the request.
 */
const MaxPageLines: number = 2000;

/**
 * Default page budget in UTF-8 bytes.
 */
const DefaultPageBytes: number = 32 * 1024;

/**
 * Hard upper bound on a page's byte budget, regardless of the request.
 */
const MaxPageBytes: number = 256 * 1024;

/**
 * Default capacity of {@link ReadCache}.
 */
const DefaultCacheEntries: number = 256;

/**
 * Options for {@link readPage}. `maxBytes` bounds the *file*, not the page; the
 * page budget travels in {@link ReadRequest.maxBytes}.
 */
export interface ReadOptions {
    readonly maxBytes?: number;
    readonly timeZone?: "local" | "utc";
}

/**
 * One page after the byte budget has been applied. `overflow` is true when the
 * page still exceeds the budget because a single line is larger than it.
 */
interface BoundedPage {
    readonly text: string;
    readonly lines: number;
    readonly overflow: boolean;
}

/**
 * Extract an `errno` code from an unknown thrown value without trusting it.
 */
const errorCode: (error: unknown) => string = (error: unknown): string => {
    if (typeof(error) !== "object" || error === null) {
        return "";
    }
    const code: unknown = (error as { code?: unknown; }).code;
    return typeof(code) === "string" ? code : "";
};

/**
 * Translate a host filesystem failure into the closed domain taxonomy. The
 * original message is dropped on purpose: it embeds absolute paths.
 */
const mapFsError: (error: unknown) => never = (error: unknown): never => {
    if (isFilesystemError(error)) {
        throw error;
    }
    switch (errorCode(error)) {
        case "ENOENT": {
            return fail("not_found");
        }
        case "EACCES":
        case "EPERM": {
            return fail("permission_denied");
        }
        case "EISDIR": {
            return fail("not_file");
        }
        case "ENOTDIR": {
            return fail("not_directory");
        }
        case "ENAMETOOLONG": {
            return fail("invalid_path");
        }
        case "ELOOP": {
            return fail("symlink_denied");
        }
        case "ENOSPC":
        case "EDQUOT": {
            return fail("quota_exceeded");
        }
        default: {
            return fail("internal_error");
        }
    }
};

/**
 * Resolve a positive safe integer option, clamping it to `maximum`.
 *
 * @param value - Caller value, or `undefined` for the default.
 * @param fallback - Default when the value is absent.
 * @param maximum - Inclusive upper bound.
 * @returns The effective value.
 */
const positiveInteger: (value: number | undefined, fallback: number, maximum: number) => number = (value: number | undefined, fallback: number, maximum: number): number => {
    if (value === (void 0)) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return Math.min(value, maximum);
};

/**
 * `lstat` a path, translating a failure instead of leaking it.
 */
const statOrFail: (absolute: string) => Stats = (absolute: string): Stats => {
    try {
        return lstatSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Read the whole file as bytes.
 */
const readBytes: (absolute: string) => Uint8Array = (absolute: string): Uint8Array => {
    try {
        return readFileSync(absolute);
    } catch (error: unknown) {
        return mapFsError(error);
    }
};

/**
 * Decode with a detected charset. A decoder failure is reported as
 * `charset_unsupported`; a classified domain error passes through unchanged.
 */
const decodePageText: (bytes: Uint8Array, charset: Charset) => string = (bytes: Uint8Array, charset: Charset): string => {
    try {
        return decodeText(bytes, charset);
    } catch (error: unknown) {
        if (isFilesystemError(error)) {
            throw error;
        }
        return fail("charset_unsupported");
    }
};

/**
 * Trim a line run to the UTF-8 byte budget, keeping whole lines. At least one
 * line is always returned; one line larger than the budget is returned alone
 * and flagged, because silently dropping it would hide the file's content.
 *
 * @param text - Text already sliced by line range, without a trailing newline.
 * @param maxBytes - Budget for the UTF-8 encoding of the result.
 * @returns The bounded text, its line count and the single-line overflow flag.
 */
const cutPage: (text: string, maxBytes: number) => BoundedPage = (text: string, maxBytes: number): BoundedPage => {
    const lines: string[] = text.split("\n");
    let bytes: number = 0;
    let kept: number = 0;
    for (let index: number = 0; index < lines.length; index += 1) {
        const lineBytes: number = Buffer.byteLength(lines[index], "utf8");
        const total: number = bytes + lineBytes + (kept === 0 ? 0 : 1);
        if (kept > 0 && total > maxBytes) {
            break;
        }
        bytes = total;
        kept += 1;
    }
    const pageText: string = lines.slice(0, kept).join("\n");
    return { text: pageText, lines: kept, overflow: kept === 1 && Buffer.byteLength(lines[0], "utf8") > maxBytes };
};

/**
 * Prefix every line with its 1-based number and a tab, matching the
 * `includeLineNumbers` contract.
 */
const numberLines: (text: string, startLine: number) => string = (text: string, startLine: number): string =>
    text
        .split("\n")
        .map((line: string, index: number): string => `${startLine + index}\t${line}`)
        .join("\n");

/**
 * Per-session page cache.
 *
 * The value is the page text *without* line-number prefixes, so the same page
 * can serve a numbered and an unnumbered request. Keys are built by the caller
 * and must contain the root-relative path, the whole-file fingerprint, the
 * 1-based start line and the effective line and byte budgets; the fingerprint
 * is what makes a cached page impossible to serve against changed bytes.
 */
export class ReadCache {
    private readonly pages: LRUUnorderedMap<string, string>;

    constructor(options: { entries?: number; } = {}) {
        this.pages = new LRUUnorderedMap<string, string>(options.entries ?? DefaultCacheEntries);
    }

    /**
     * Read a cached page and mark it most recently used.
     */
    get(key: string): string | undefined {
        return this.pages.get(key);
    }

    /**
     * Insert or replace a page; the entry becomes most recently used.
     */
    set(key: string, value: string): void {
        this.pages.set(key, value);
    }

    /**
     * Number of cached pages.
     */
    get size(): number {
        return this.pages.size;
    }
}

/**
 * Read one bounded page of a workspace file.
 *
 * The flow is deliberately strict: sandbox resolution, regular-file check,
 * file-size ceiling, a second sandbox revalidation before the read, charset
 * sniffing, decode, line-index paging and finally the UTF-8 byte budget. A
 * `startLine` past EOF returns an empty page with `nextStartLine: null` rather
 * than an error, which lets a client keep paging without a special case.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param request - Path, 1-based start line and page budgets.
 * @param options - File-size ceiling and timestamp mode.
 * @returns The decoded page plus its fingerprint and total sizes.
 */
export const readPage: (sandbox: PathSandbox, request: ReadRequest, options?: ReadOptions) => ReadPage = (sandbox: PathSandbox, request: ReadRequest, options: ReadOptions = {}): ReadPage => {
    if (typeof(request) !== "object" || request === null) {
        return fail("invalid_arguments");
    }
    const settings: ReadOptions = options === (void 0) || options === null ? {} : options;
    const fileLimit: number = positiveInteger(settings.maxBytes, DefaultFileBytes, Number.MAX_SAFE_INTEGER);
    const startLine: number = positiveInteger(request.startLine, 1, Number.MAX_SAFE_INTEGER);
    const maxLines: number = positiveInteger(request.maxLines, DefaultPageLines, MaxPageLines);
    const maxBytes: number = positiveInteger(request.maxBytes, DefaultPageBytes, MaxPageBytes);
    const includeLineNumbers: boolean = request.includeLineNumbers === true;
    const rooted: RootedPath = sandbox.resolve(request.path, "read");
    sandbox.revalidate(rooted);
    const stat: Stats = statOrFail(rooted.absolute);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    if (stat.size > fileLimit) {
        return fail("quota_exceeded");
    }
    sandbox.revalidate(rooted);
    const bytes: Uint8Array = readBytes(rooted.absolute);
    if (bytes.byteLength > fileLimit) {
        return fail("quota_exceeded");
    }
    const detected: DetectedCharset = detectCharset(bytes);
    if (detected.binary) {
        return fail("binary_file");
    }
    const decoded: string = decodePageText(bytes, detected.charset);
    const index: LineIndex = new LineIndex(decoded);
    const totalLines: bigint = countLines(decoded);
    const fingerprint: string = rawDigest(bytes);
    const totalBytes: bigint = BigInt(stat.size);
    if (BigInt(startLine) > totalLines) {
        return {
            path: rooted.relative,
            fingerprint,
            charset: detected.charset,
            offset: index.start(startLine),
            startLine,
            endLine: startLine - 1,
            totalLines,
            bytesRead: 0,
            totalBytes,
            text: "",
            nextStartLine: null,
            truncated: false,
            binary: false,
        };
    }
    const sliced: { text: string; startLine: number; endLine: number; } = index.slice(startLine, maxLines);
    const page: BoundedPage = cutPage(sliced.text, maxBytes);
    const endLine: number = sliced.startLine + page.lines - 1;
    const nextStartLine: number | null = BigInt(endLine) < totalLines ? endLine + 1 : null;
    const text: string = includeLineNumbers ? numberLines(page.text, sliced.startLine) : page.text;
    return {
        path: rooted.relative,
        fingerprint,
        charset: detected.charset,
        offset: index.start(sliced.startLine),
        startLine: sliced.startLine,
        endLine,
        totalLines,
        bytesRead: Buffer.byteLength(text, "utf8"),
        totalBytes,
        text,
        nextStartLine,
        truncated: nextStartLine !== null || page.overflow,
        binary: false,
    };
};

/**
 * Canonical fingerprint of one raw byte range.
 *
 * The preimage binds the absolute offsets, so the same bytes at a different
 * place do not share a fingerprint. Line spans are hashed through this same
 * function after they are mapped to raw bytes, which is what lets the read and
 * write helpers agree on a single range identity.
 *
 * @param startByte - 0-based inclusive start offset in the raw file.
 * @param endByte - 0-based exclusive end offset in the raw file.
 * @param bytes - Raw bytes of the range.
 * @returns `sha256:<hex>` of the domain-separated range preimage.
 */
export const byteRangeFingerprint: (startByte: number, endByte: number, bytes: Uint8Array) => string = (startByte: number, endByte: number, bytes: Uint8Array): string => {
    const header: Uint8Array = new TextEncoder().encode(`amp.fs.range/1\n${startByte}\n${endByte}\n${bytes.byteLength}\n`);
    const preimage: Uint8Array = new Uint8Array(header.byteLength + bytes.byteLength);
    preimage.set(header, 0);
    preimage.set(bytes, header.byteLength);
    return rawDigest(preimage);
};

/**
 * Dominant line terminator seen in a decoded text, or `none` when the text has
 * no newline at all.
 */
export type LineEnding = "\n" | "\r\n" | "none";

/**
 * Request for {@link useByte}. Offsets are 0-based and half-open over the raw
 * file bytes, including any BOM.
 */
export interface ByteUseRequest {
    readonly path: string;
    readonly startByte: number;
    readonly endByte: number;
}

/**
 * Raw byte range plus the fingerprints needed to patch it safely.
 */
export interface ByteUse {
    readonly path: string;
    readonly fingerprint: string;
    readonly rangeFingerprint: string;
    readonly charset: Charset;
    readonly startByte: number;
    readonly endByte: number;
    readonly totalBytes: bigint;
    readonly bytes: Uint8Array;
    readonly text: string;
    readonly binary: boolean;
}

/**
 * Request for {@link useLine}. Line numbers are 1-based and inclusive;
 * `endLine = startLine - 1` describes the empty insertion point before
 * `startLine`.
 */
export interface LineUseRequest {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
}

/**
 * Byte span of one line range. `startByte`/`endByte` cover the raw bytes of the
 * first character through the terminator of the last line, so a line write and
 * a byte write address exactly the same region.
 */
export interface LineSpan {
    readonly charset: Charset;
    readonly startLine: number;
    readonly endLine: number;
    readonly startChar: number;
    readonly endChar: number;
    readonly startByte: number;
    readonly endByte: number;
    readonly totalLines: bigint;
    readonly totalBytes: bigint;
    readonly bomLength: number;
    readonly lineEnding: LineEnding;
    readonly finalNewline: boolean;
    readonly text: string;
    readonly rangeFingerprint: string;
}

/**
 * Line range plus the whole-file fingerprint of the read.
 */
export interface LineUse extends LineSpan {
    readonly path: string;
    readonly fingerprint: string;
}

/**
 * One file read as raw bytes together with its detected charset.
 */
interface ByteSource {
    readonly rooted: RootedPath;
    readonly bytes: Uint8Array;
    readonly detected: DetectedCharset;
}

/**
 * One file read as decoded text plus the indices a line span needs.
 */
interface LineSource {
    readonly bytes: Uint8Array;
    readonly charset: Charset;
    readonly bomLength: number;
    readonly decoded: string;
    readonly index: LineIndex;
    readonly totalLines: bigint;
    readonly lineEnding: LineEnding;
    readonly finalNewline: boolean;
}

/**
 * Validate a raw byte offset.
 */
const byteOffsetValue: (value: number) => number = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
        return fail("invalid_arguments");
    }
    return value;
};

/**
 * Validate a 1-based start line.
 */
const lineStartValue: (value: number) => number = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 1) {
        return fail("invalid_arguments");
    }
    return value;
};

/**
 * Validate an inclusive end line. `0` is valid because it denotes the empty
 * insertion point before line 1.
 */
const lineEndValue: (value: number) => number = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
        return fail("invalid_arguments");
    }
    return value;
};

/**
 * Resolve, size-check, revalidate and read one file, then sniff its charset.
 */
const loadBytes: (sandbox: PathSandbox, path: string, fileLimit: number) => ByteSource = (sandbox: PathSandbox, path: string, fileLimit: number): ByteSource => {
    const rooted: RootedPath = sandbox.resolve(path, "read");
    sandbox.revalidate(rooted);
    const stat: Stats = statOrFail(rooted.absolute);
    if (!stat.isFile()) {
        return fail("not_file");
    }
    if (stat.size > fileLimit) {
        return fail("quota_exceeded");
    }
    sandbox.revalidate(rooted);
    const bytes: Uint8Array = readBytes(rooted.absolute);
    if (bytes.byteLength > fileLimit) {
        return fail("quota_exceeded");
    }
    return { rooted, bytes, detected: detectCharset(bytes) };
};

/**
 * Detect the dominant line ending of a decoded text.
 */
const detectLineEnding: (text: string) => LineEnding = (text: string): LineEnding => {
    const index: number = text.indexOf("\n");
    if (index === -1) {
        return "none";
    }
    return index > 0 && text[index - 1] === "\r" ? "\r\n" : "\n";
};

/**
 * Convert a decoded-text character offset to a raw byte offset. The mapping is
 * exact for the charsets the read page can produce: UTF-8 counts encoded prefix
 * bytes, UTF-16 uses two bytes per code unit and Latin-1 one byte per unit.
 */
const charToByteOffset: (text: string, charset: Charset, bomLength: number, index: number) => number = (text: string, charset: Charset, bomLength: number, index: number): number => {
    switch (charset) {
        case "utf-8":
        case "utf-8-bom": {
            return bomLength + new TextEncoder().encode(text.slice(0, index)).byteLength;
        }
        case "utf-16le":
        case "utf-16be": {
            return bomLength + index * 2;
        }
        case "latin1": {
            return bomLength + index;
        }
        default: {
            return fail("charset_unsupported");
        }
    }
};

/**
 * Decode a byte source into the text and indices line spans need. Binary files
 * are refused because a line is a text concept.
 */
const lineSourceOf: (bytes: Uint8Array, detected: DetectedCharset) => LineSource = (bytes: Uint8Array, detected: DetectedCharset): LineSource => {
    if (detected.binary) {
        return fail("binary_file");
    }
    const charset: Charset = detected.charset;
    const decoded: string = decodePageText(bytes, charset);
    return {
        bytes,
        charset,
        bomLength: detected.bomLength,
        decoded,
        index: new LineIndex(decoded),
        totalLines: countLines(decoded),
        lineEnding: detectLineEnding(decoded),
        finalNewline: decoded.endsWith("\n"),
    };
};

/**
 * Build the canonical byte span for one validated line range.
 */
const lineSpanFrom: (source: LineSource, startLine: number, endLine: number) => LineSpan = (source: LineSource, startLine: number, endLine: number): LineSpan => {
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(endLine) || endLine < startLine - 1) {
        return fail("invalid_arguments");
    }
    if (BigInt(startLine) > source.totalLines + 1n || BigInt(endLine) > source.totalLines) {
        return fail("invalid_arguments");
    }
    const startChar: number = source.index.start(startLine);
    const endChar: number = source.index.end(endLine);
    const startByte: number = charToByteOffset(source.decoded, source.charset, source.bomLength, startChar);
    const endByte: number = charToByteOffset(source.decoded, source.charset, source.bomLength, endChar);
    const rangeBytes: Uint8Array = source.bytes.subarray(startByte, endByte);
    const text: string = endLine >= startLine ? source.index.slice(startLine, endLine - startLine + 1).text : "";
    return {
        charset: source.charset,
        startLine,
        endLine,
        startChar,
        endChar,
        startByte,
        endByte,
        totalLines: source.totalLines,
        totalBytes: BigInt(source.bytes.byteLength),
        bomLength: source.bomLength,
        lineEnding: source.lineEnding,
        finalNewline: source.finalNewline,
        text,
        rangeFingerprint: byteRangeFingerprint(startByte, endByte, rangeBytes),
    };
};

/**
 * Read one raw byte range and return exact bytes, the whole-file fingerprint
 * and the canonical range fingerprint. Binary content is allowed here: this is
 * the byte-oriented companion to {@link readPage}, not a text tool.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param request - Path and half-open raw byte offsets.
 * @param options - File-size ceiling.
 * @returns Range bytes, text, charset and both fingerprints.
 */
export const useByte: (sandbox: PathSandbox, request: ByteUseRequest, options?: ReadOptions) => ByteUse = (sandbox: PathSandbox, request: ByteUseRequest, options: ReadOptions = {}): ByteUse => {
    if (typeof(request) !== "object" || request === null) {
        return fail("invalid_arguments");
    }
    const settings: ReadOptions = options === (void 0) || options === null ? {} : options;
    const fileLimit: number = positiveInteger(settings.maxBytes, DefaultFileBytes, Number.MAX_SAFE_INTEGER);
    const startByte: number = byteOffsetValue(request.startByte);
    const endByte: number = byteOffsetValue(request.endByte);
    if (endByte < startByte) {
        return fail("invalid_arguments");
    }
    const source: ByteSource = loadBytes(sandbox, request.path, fileLimit);
    if (endByte > source.bytes.byteLength) {
        return fail("invalid_arguments");
    }
    const rangeBytes: Uint8Array = new Uint8Array(source.bytes.subarray(startByte, endByte));
    const binary: boolean = source.detected.binary;
    let text: string = "";
    if (!binary) {
        try {
            text = decodeText(rangeBytes, source.detected.charset);
        } catch {
            text = "";
        }
    }
    return {
        path: source.rooted.relative,
        fingerprint: rawDigest(source.bytes),
        rangeFingerprint: byteRangeFingerprint(startByte, endByte, rangeBytes),
        charset: binary ? "binary" : source.detected.charset,
        startByte,
        endByte,
        totalBytes: BigInt(source.bytes.byteLength),
        bytes: rangeBytes,
        text,
        binary,
    };
};

/**
 * Read one line range and return its decoded text plus the exact byte span and
 * range fingerprint a matching write needs. An empty range (`endLine =
 * startLine - 1`) describes an insertion point; EOF and empty files are
 * supported because `startLine = totalLines + 1` is a valid insertion point.
 *
 * @param sandbox - Session sandbox that owns path resolution.
 * @param request - Path and 1-based inclusive line range.
 * @param options - File-size ceiling.
 * @returns Line span, text, EOL metadata and both fingerprints.
 */
export const useLine: (sandbox: PathSandbox, request: LineUseRequest, options?: ReadOptions) => LineUse = (sandbox: PathSandbox, request: LineUseRequest, options: ReadOptions = {}): LineUse => {
    if (typeof(request) !== "object" || request === null) {
        return fail("invalid_arguments");
    }
    const settings: ReadOptions = options === (void 0) || options === null ? {} : options;
    const fileLimit: number = positiveInteger(settings.maxBytes, DefaultFileBytes, Number.MAX_SAFE_INTEGER);
    const startLine: number = lineStartValue(request.startLine);
    const endLine: number = lineEndValue(request.endLine);
    if (endLine < startLine - 1) {
        return fail("invalid_arguments");
    }
    const source: ByteSource = loadBytes(sandbox, request.path, fileLimit);
    const lineSource: LineSource = lineSourceOf(source.bytes, source.detected);
    if (BigInt(startLine) > lineSource.totalLines + 1n || BigInt(endLine) > lineSource.totalLines) {
        return fail("invalid_arguments");
    }
    const span: LineSpan = lineSpanFrom(lineSource, startLine, endLine);
    return { path: source.rooted.relative, fingerprint: rawDigest(source.bytes), ...span };
};

/**
 * Locate a line range directly from raw bytes. This is the shared mapping used
 * by {@link useLine} and by the write-side line patch, so both sides compute the
 * same byte span and range fingerprint.
 *
 * @param bytes - Raw file bytes.
 * @param startLine - 1-based inclusive start line.
 * @param endLine - 1-based inclusive end line, or `startLine - 1` for insertion.
 * @returns The canonical line span.
 */
export const locateLineSpan: (bytes: Uint8Array, startLine: number, endLine: number) => LineSpan = (bytes: Uint8Array, startLine: number, endLine: number): LineSpan => lineSpanFrom(lineSourceOf(bytes, detectCharset(bytes)), startLine, endLine);
