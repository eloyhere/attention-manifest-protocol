/**
 * Read-only outline reader for compressed archive containers.
 *
 * Scope: the central-directory metadata of ZIP archives, the 512-byte header stream of TAR
 * archives (ustar, GNU long names and pax extended headers), and the single member of a GZIP
 * stream. A gzip stream whose decompressed payload is a TAR archive is reported as `tar.gz`.
 * Listing never extracts members to disk: ZIP data and TAR data are skipped by their declared
 * lengths, and only the gzip payload that must be inspected to recognise a `tar.gz` container
 * is decompressed (inside the `maxTotalBytes` budget).
 *
 * Explicitly not interpreted: ZIP member contents (stored, deflated or any other method),
 * ZIP local headers, encryption schemes, TAR member contents beyond GNU/pax metadata, and the
 * 7z, RAR, XZ, bzip2 and zstd streams, which need dedicated decoders and raise
 * `unsupported_format`. A listing is a preview projection, never a claim that members can be
 * extracted or edited by this module.
 *
 * Limits come from `defaultDocumentLimits` and may be narrowed through `limits`:
 * `maxEntriesInOutline` caps the reported entries and sets `truncated`, `maxNodes` caps the
 * scanned records (raising `limit_exceeded`), and `maxTotalBytes` bounds gzip decompression.
 * Unsafe member paths (absolute, drive-qualified, containing `..` or NUL) are reported through
 * `skipped` instead of as entries. Malformed input raises `DocumentError`.
 */
import { gunzipSync } from "node:zlib";
import {
    DocumentError, defaultDocumentLimits, type DocumentEntry, type DocumentEntryKind, type DocumentLimits,
    type DocumentLocator, type DocumentOutline,
} from "./types.ts";

export type ArchiveFormat = "zip" | "tar" | "tar.gz" | "gzip" | "7z" | "rar" | "xz" | "bzip2" | "zstd" | "unknown";

export interface ArchiveEntryInfo {
    /** Canonical relative POSIX path inside the archive: no leading `/` and no `..` segment. */
    readonly path: string;
    readonly directory: boolean;
    /** Uncompressed byte count, or -1 when the archive does not record a usable size. */
    readonly size: number;
    readonly compressedSize?: number;
    /** ISO-8601 timestamp when the archive records a parsable one. */
    readonly modifiedAt?: string;
    readonly encrypted?: boolean;
}

export interface ArchiveListing {
    readonly format: ArchiveFormat;
    readonly entries: readonly ArchiveEntryInfo[];
    /** Member names skipped because their path is unsafe or their record is unusable. */
    readonly skipped: readonly string[];
    readonly truncated: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const U16_SENTINEL = 0xffff;
const U32_SENTINEL = 0xffff_ffff;
const EOCD_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const MAX_EOCD_SEARCH = 65_557;
const ZIP64_EOCD_MIN_BYTES = 56;
const ZIP64_EOCD_FIXED_BYTES = 12;
const ZIP64_EOCD_BODY_BYTES = 44;
const U64_SAFE_HIGH = 0x1f_ffff;
const TAR_BLOCK_BYTES = 512;
const TAR_CHECKSUM_START = 148;
const TAR_CHECKSUM_END = 156;
const TAR_MAGIC_START = 257;
const TAR_MAGIC_END = 262;
const TAR_PREFIX_START = 345;
const TAR_PREFIX_END = 500;
const TAR_TYPE_OFFSET = 156;
const TAR_NAME_END = 100;
const GZIP_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const GZIP_FLAG_FHCRC = 0x02;
const GZIP_FLAG_FEXTRA = 0x04;
const GZIP_FLAG_FNAME = 0x08;
const GZIP_FLAG_FCOMMENT = 0x10;
const MAX_ZLIB_OUTPUT = 0x7fff_ffff;

const ZIP_LOCAL_MAGIC = Object.freeze([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_MAGIC = Object.freeze([0x50, 0x4b, 0x05, 0x06]);
const ZIP_SPANNED_MAGIC = Object.freeze([0x50, 0x4b, 0x07, 0x08]);
const GZIP_MAGIC = Object.freeze([0x1f, 0x8b]);
const SEVEN_ZIP_MAGIC = Object.freeze([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const RAR_MAGIC = Object.freeze([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]);
const XZ_MAGIC = Object.freeze([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const BZIP2_MAGIC = Object.freeze([0x42, 0x5a, 0x68]);
const ZSTD_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd]);
const TAR_MAGIC = Object.freeze([0x75, 0x73, 0x74, 0x61, 0x72]);

const UTF8_DECODER = new TextDecoder("utf-8");

/**
 * CP437 high half (bytes 0x80..0xff). WHATWG `TextDecoder` does not expose CP437, and ZIP
 * archives without general-purpose flag bit 11 store member names in this code page.
 */
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐"
    + "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function invalid(message: string): DocumentError {
    return new DocumentError("invalid_document", message);
}

function limitExceeded(message: string): DocumentError {
    return new DocumentError("limit_exceeded", message);
}

function unsupportedArchive(format: string): DocumentError {
    return new DocumentError("unsupported_format",
        `${format} headers/streams need a dedicated decoder; this reader only lists zip, tar and gzip members`);
}

function unsupportedZip64(): DocumentError {
    return new DocumentError("unsupported_format", "zip64 archive needs the extended central directory");
}

function matchesAt(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
    if (offset < 0 || offset + signature.length > bytes.length) return false;
    for (let index = 0; index < signature.length; index += 1) {
        if (bytes[offset + index] !== signature[index]) return false;
    }
    return true;
}

function ascii(bytes: Uint8Array): string {
    let value = "";
    for (const byte of bytes) value += String.fromCharCode(byte);
    return value;
}

function decodeUtf8(bytes: Uint8Array): string {
    return UTF8_DECODER.decode(bytes);
}

/** NUL-terminated UTF-8 name, as stored in TAR header fields and gzip name/comment fields. */
function decodeCString(bytes: Uint8Array): string {
    const terminator = bytes.indexOf(0);
    return decodeUtf8(terminator < 0 ? bytes : bytes.subarray(0, terminator));
}

function decodeCp437(bytes: Uint8Array): string {
    let value = "";
    for (const byte of bytes) {
        value += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!;
    }
    return value;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > bytes.length) throw invalid("archive is truncated before a 32-bit field");
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function timestampIso(seconds: number): string | undefined {
    if (!Number.isFinite(seconds)) return undefined;
    const milliseconds = seconds * 1000;
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return undefined;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Converts a DOS date/time pair into an ISO timestamp; impossible encodings are omitted. */
function dosTimestamp(date: number, time: number): string | undefined {
    const year = 1980 + ((date >>> 9) & 0x7f);
    const month = (date >>> 5) & 0x0f;
    const day = date & 0x1f;
    const hour = (time >>> 11) & 0x1f;
    const minute = (time >>> 5) & 0x3f;
    const second = (time & 0x1f) * 2;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
        return undefined;
    }
    const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (Number.isNaN(value.getTime()) || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
        return undefined;
    }
    return value.toISOString();
}

/**
 * Normalizes an archive member name to a relative POSIX path. Returns `undefined` for names
 * that would escape the archive root: absolute paths, Windows drive letters, `..` segments,
 * NUL bytes or an empty result. Backslashes become separators and leading `./` runs are
 * removed before validation.
 */
function normalizeArchivePath(raw: string): string | undefined {
    if (raw.includes("\0")) return undefined;
    let value = raw.replace(/\\/g, "/");
    while (value.startsWith("./")) value = value.slice(2);
    if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return undefined;
    if (value.split("/").includes("..")) return undefined;
    while (value.endsWith("/")) value = value.slice(0, -1);
    return value === "" ? undefined : value;
}

/** Accumulates listing rows while enforcing the outline entry and node budgets. */
class ListingBuilder {
    private readonly entries: ArchiveEntryInfo[] = [];
    private readonly skipped: string[] = [];
    private readonly maxEntries: number;
    private readonly maxNodes: number;
    private nodes = 0;
    private truncated = false;

    constructor(limits: Required<DocumentLimits>) {
        this.maxEntries = Math.max(0, Math.floor(limits.maxEntriesInOutline));
        this.maxNodes = Math.max(0, Math.floor(limits.maxNodes));
    }

    visit(label: string): void {
        this.nodes += 1;
        if (this.nodes > this.maxNodes) {
            throw limitExceeded(`archive outline scan stopped after ${this.maxNodes} nodes while reading ${label}`);
        }
    }

    atCapacity(): boolean {
        return this.entries.length >= this.maxEntries;
    }

    markTruncated(): void {
        this.truncated = true;
    }

    add(entry: ArchiveEntryInfo): void {
        if (this.atCapacity()) {
            this.truncated = true;
            return;
        }
        this.entries.push(Object.freeze(entry));
    }

    skip(name: string): void {
        this.skipped.push(name);
    }

    listing(format: ArchiveFormat): ArchiveListing {
        return Object.freeze({
            format,
            entries: Object.freeze([...this.entries]),
            skipped: Object.freeze([...this.skipped]),
            truncated: this.truncated,
        });
    }
}

function readZip64U64(view: DataView, offset: number, length: number): number {
    if (offset < 0 || offset + 8 > length) throw unsupportedZip64();
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    if (high > U64_SAFE_HIGH) throw unsupportedZip64();
    return high * 0x1_0000_0000 + low;
}

/** Locates the end-of-central-directory record in the last 65,557 bytes of the buffer. */
function findEocd(bytes: Uint8Array, view: DataView): number {
    if (bytes.length < EOCD_BYTES) throw invalid("zip is shorter than its end-of-central-directory record");
    const first = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
    let fallback = -1;
    for (let offset = bytes.length - EOCD_BYTES; offset >= first; offset -= 1) {
        if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
        const commentLength = view.getUint16(offset + 20, true);
        if (offset + EOCD_BYTES + commentLength === bytes.length) return offset;
        if (fallback < 0 && offset + EOCD_BYTES + commentLength <= bytes.length) fallback = offset;
    }
    if (fallback >= 0) return fallback;
    throw invalid("zip end-of-central-directory record not found");
}

interface ZipDirectory {
    readonly entryCount: number;
    readonly directorySize: number;
    readonly directoryOffset: number;
}

/** Reads the Zip64 EOCD record through the locator that precedes the classic EOCD. */
function readZip64Directory(bytes: Uint8Array, view: DataView, eocd: number): ZipDirectory {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) throw unsupportedZip64();
    const recordOffset = readZip64U64(view, locator + 8, bytes.length);
    if (recordOffset > bytes.length - ZIP64_EOCD_MIN_BYTES
        || view.getUint32(recordOffset, true) !== ZIP64_EOCD_SIGNATURE) {
        throw unsupportedZip64();
    }
    const recordSize = readZip64U64(view, recordOffset + 4, bytes.length);
    if (recordSize < ZIP64_EOCD_BODY_BYTES
        || recordSize > bytes.length - recordOffset - ZIP64_EOCD_FIXED_BYTES) {
        throw unsupportedZip64();
    }
    return {
        entryCount: readZip64U64(view, recordOffset + 32, bytes.length),
        directorySize: readZip64U64(view, recordOffset + 40, bytes.length),
        directoryOffset: readZip64U64(view, recordOffset + 48, bytes.length),
    };
}

interface Zip64Sizes {
    readonly compressedSize: number;
    readonly uncompressedSize: number;
}

/**
 * Resolves the sentinel size fields of a central-directory entry from its Zip64 extra field.
 * The values appear in a fixed order and only for the fields that carry 0xffffffff.
 */
function readZip64Sizes(extra: Uint8Array, needsCompressed: boolean, needsUncompressed: boolean): Zip64Sizes {
    let cursor = 0;
    while (cursor + 4 <= extra.length) {
        const headerId = extra[cursor]! | (extra[cursor + 1]! << 8);
        const size = extra[cursor + 2]! | (extra[cursor + 3]! << 8);
        cursor += 4;
        if (cursor + size > extra.length) throw unsupportedZip64();
        if (headerId === ZIP64_EXTRA_ID) {
            const data = extra.subarray(cursor, cursor + size);
            const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
            let at = 0;
            let uncompressedSize = 0;
            let compressedSize = 0;
            if (needsUncompressed) {
                uncompressedSize = readZip64U64(dataView, at, data.length);
                at += 8;
            }
            if (needsCompressed) {
                compressedSize = readZip64U64(dataView, at, data.length);
                at += 8;
            }
            if (at > data.length) throw unsupportedZip64();
            return { compressedSize, uncompressedSize };
        }
        cursor += size;
    }
    throw unsupportedZip64();
}

/** Lists ZIP entries from the central directory without reading or inflating any member. */
function readZipListing(bytes: Uint8Array, limits: Required<DocumentLimits>): ArchiveListing {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(bytes, view);
    let entryCount = view.getUint16(eocd + 10, true);
    let directorySize = view.getUint32(eocd + 12, true);
    let directoryOffset = view.getUint32(eocd + 16, true);
    const needsZip64 = entryCount === U16_SENTINEL
        || view.getUint16(eocd + 8, true) === U16_SENTINEL
        || directorySize === U32_SENTINEL
        || directoryOffset === U32_SENTINEL;
    if (needsZip64) {
        const wide = readZip64Directory(bytes, view, eocd);
        entryCount = wide.entryCount;
        directorySize = wide.directorySize;
        directoryOffset = wide.directoryOffset;
    }
    if (!Number.isSafeInteger(entryCount) || !Number.isSafeInteger(directorySize) || !Number.isSafeInteger(directoryOffset)) {
        throw unsupportedZip64();
    }
    if (directoryOffset > bytes.length || directorySize > bytes.length - directoryOffset) {
        throw invalid("zip central directory is out of bounds");
    }
    const directoryEnd = directoryOffset + directorySize;
    const builder = new ListingBuilder(limits);
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
        if (builder.atCapacity()) {
            builder.markTruncated();
            break;
        }
        builder.visit(`zip entry ${index + 1}`);
        if (cursor + CENTRAL_HEADER_BYTES > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
            throw invalid("corrupt zip central directory");
        }
        const flags = view.getUint16(cursor + 8, true);
        const modifiedAt = dosTimestamp(view.getUint16(cursor + 14, true), view.getUint16(cursor + 12, true));
        let compressedSize = view.getUint32(cursor + 20, true);
        let uncompressedSize = view.getUint32(cursor + 24, true);
        const nameLength = view.getUint16(cursor + 28, true);
        const extraLength = view.getUint16(cursor + 30, true);
        const commentLength = view.getUint16(cursor + 32, true);
        const externalAttributes = view.getUint32(cursor + 38, true);
        const localOffset = view.getUint32(cursor + 42, true);
        const nameStart = cursor + CENTRAL_HEADER_BYTES;
        const extraStart = nameStart + nameLength;
        const next = extraStart + extraLength + commentLength;
        if (next > bytes.length || next > directoryEnd) throw invalid("zip central directory entry is out of bounds");
        const needsCompressedZip64 = compressedSize === U32_SENTINEL;
        const needsUncompressedZip64 = uncompressedSize === U32_SENTINEL;
        if (needsCompressedZip64 || needsUncompressedZip64 || localOffset === U32_SENTINEL) {
            const sizes = readZip64Sizes(bytes.subarray(extraStart, extraStart + extraLength),
                needsCompressedZip64, needsUncompressedZip64);
            if (needsCompressedZip64) compressedSize = sizes.compressedSize;
            if (needsUncompressedZip64) uncompressedSize = sizes.uncompressedSize;
        }
        const rawName = (flags & 0x0800) !== 0
            ? decodeUtf8(bytes.subarray(nameStart, nameStart + nameLength))
            : decodeCp437(bytes.subarray(nameStart, nameStart + nameLength));
        const directory = (externalAttributes & 0x10) !== 0
            || ((externalAttributes >>> 16) & 0xf000) === 0x4000
            || rawName.endsWith("/");
        const path = normalizeArchivePath(rawName);
        cursor = next;
        if (path === undefined) {
            builder.skip(rawName);
            continue;
        }
        builder.add({
            path,
            directory,
            size: uncompressedSize,
            compressedSize,
            ...(modifiedAt === undefined ? {} : { modifiedAt }),
            ...((flags & 0x1) === 0 ? {} : { encrypted: true }),
        });
    }
    return builder.listing("zip");
}

function isZeroBlock(block: Uint8Array): boolean {
    for (const byte of block) {
        if (byte !== 0) return false;
    }
    return true;
}

/**
 * Parses a TAR numeric field: octal digits terminated by NUL or space, with optional leading
 * spaces. An empty field yields `undefined` so callers can apply the format's default.
 */
function parseTarOctal(field: Uint8Array, label: string): number | undefined {
    let end = field.indexOf(0);
    if (end < 0) end = field.length;
    let start = 0;
    while (start < end && field[start] === 0x20) start += 1;
    while (end > start && field[end - 1] === 0x20) end -= 1;
    if (start === end) return undefined;
    let text = "";
    for (let index = start; index < end; index += 1) {
        const byte = field[index]!;
        if (byte < 0x30 || byte > 0x37) throw invalid(`tar ${label} is not an octal number`);
        text += String.fromCharCode(byte);
    }
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value)) throw invalid(`tar ${label} exceeds the safe integer range`);
    return value;
}

/** Sums a TAR header with the checksum field replaced by spaces, as the format defines it. */
function tarChecksum(block: Uint8Array): number {
    let sum = 0;
    for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
        sum += index >= TAR_CHECKSUM_START && index < TAR_CHECKSUM_END ? 0x20 : block[index]!;
    }
    return sum;
}

interface TarHeader {
    readonly name: string;
    readonly size: number;
    readonly mtime?: number;
    readonly typeFlag: string;
}

/** Reads one 512-byte TAR header, including the ustar prefix and octal size/mtime fields. */
function parseTarHeader(block: Uint8Array): TarHeader {
    const storedChecksum = parseTarOctal(block.subarray(TAR_CHECKSUM_START, TAR_CHECKSUM_END), "checksum");
    if (storedChecksum === undefined) throw invalid("tar header has no checksum");
    const actualChecksum = tarChecksum(block);
    if (storedChecksum !== actualChecksum) {
        throw invalid(`tar header checksum ${storedChecksum} does not match the computed ${actualChecksum}`);
    }
    const shortName = decodeCString(block.subarray(0, TAR_NAME_END));
    const magic = ascii(block.subarray(TAR_MAGIC_START, TAR_MAGIC_END));
    const prefix = magic.startsWith("ustar") ? decodeCString(block.subarray(TAR_PREFIX_START, TAR_PREFIX_END)) : "";
    const name = prefix === "" ? shortName : `${prefix}/${shortName}`;
    const size = parseTarOctal(block.subarray(124, 136), "size") ?? 0;
    const mtime = parseTarOctal(block.subarray(136, TAR_CHECKSUM_START), "mtime");
    const typeByte = block[TAR_TYPE_OFFSET]!;
    return {
        name,
        size,
        ...(mtime === undefined ? {} : { mtime }),
        typeFlag: typeByte === 0 ? "\0" : String.fromCharCode(typeByte),
    };
}

/** Bounds-check for an entry payload whose bytes stay inside the archive. */
function requireTarData(bytes: Uint8Array, start: number, size: number): number {
    if (!Number.isSafeInteger(size) || size < 0) throw invalid("tar entry size is not a safe non-negative integer");
    const padded = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (start + size > bytes.length || start + padded > bytes.length) {
        throw invalid("tar entry data crosses the end of the archive or a 512-byte block boundary");
    }
    return padded;
}

interface PaxFields {
    readonly path?: string;
    readonly size?: number;
    readonly mtime?: number;
}

/**
 * Parses pax extended-header records (`<length> <key>=<value>\n`) and keeps the fields this
 * reader projects: path, size and mtime. Unknown keywords are ignored.
 */
function parsePax(data: Uint8Array): PaxFields {
    let path: string | undefined;
    let size: number | undefined;
    let mtime: number | undefined;
    let cursor = 0;
    while (cursor < data.length) {
        let space = -1;
        for (let index = cursor; index < data.length && index < cursor + 20; index += 1) {
            if (data[index] === 0x20) {
                space = index;
                break;
            }
        }
        if (space < 0) throw invalid("pax extended header record has no length prefix");
        const lengthText = ascii(data.subarray(cursor, space));
        if (!/^[0-9]+$/.test(lengthText)) throw invalid("pax extended header record length is not decimal");
        const length = Number.parseInt(lengthText, 10);
        if (!Number.isSafeInteger(length) || length <= space - cursor + 2 || cursor + length > data.length) {
            throw invalid("pax extended header record length is out of bounds");
        }
        const record = data.subarray(space + 1, cursor + length);
        if (record.length === 0 || record[record.length - 1] !== 0x0a) {
            throw invalid("pax extended header record does not end with a newline");
        }
        const body = decodeUtf8(record.subarray(0, record.length - 1));
        const equals = body.indexOf("=");
        if (equals <= 0) throw invalid("pax extended header record has no key/value separator");
        const key = body.slice(0, equals);
        const value = body.slice(equals + 1);
        if (key === "path") path = value;
        else if (key === "size") {
            if (!/^[0-9]+$/.test(value)) throw invalid("pax size is not a decimal integer");
            const parsed = Number.parseInt(value, 10);
            if (!Number.isSafeInteger(parsed)) throw invalid("pax size exceeds the safe integer range");
            size = parsed;
        } else if (key === "mtime") {
            if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) throw invalid("pax mtime is not a decimal timestamp");
            const parsed = Number.parseFloat(value);
            if (!Number.isFinite(parsed)) throw invalid("pax mtime is not finite");
            mtime = parsed;
        }
        cursor += length;
    }
    return {
        ...(path === undefined ? {} : { path }),
        ...(size === undefined ? {} : { size }),
        ...(mtime === undefined ? {} : { mtime }),
    };
}

/**
 * Lists a TAR stream block by block. Member payloads are never interpreted: only GNU long-name
 * and pax metadata payloads are read, because they carry the next member's path and size.
 */
function readTarListing(bytes: Uint8Array, limits: Required<DocumentLimits>, format: ArchiveFormat): ArchiveListing {
    const builder = new ListingBuilder(limits);
    let cursor = 0;
    let pendingLongName: string | undefined;
    let pendingPax: PaxFields = {};
    while (cursor + TAR_BLOCK_BYTES <= bytes.length) {
        const block = bytes.subarray(cursor, cursor + TAR_BLOCK_BYTES);
        if (isZeroBlock(block)) return builder.listing(format);
        const header = parseTarHeader(block);
        builder.visit(`tar entry at byte ${cursor}`);
        const dataStart = cursor + TAR_BLOCK_BYTES;
        if (header.typeFlag === "L") {
            const padded = requireTarData(bytes, dataStart, header.size);
            pendingLongName = decodeCString(bytes.subarray(dataStart, dataStart + header.size));
            cursor = dataStart + padded;
            continue;
        }
        if (header.typeFlag === "x") {
            const padded = requireTarData(bytes, dataStart, header.size);
            pendingPax = parsePax(bytes.subarray(dataStart, dataStart + header.size));
            cursor = dataStart + padded;
            continue;
        }
        const size = pendingPax.size ?? header.size;
        const padded = requireTarData(bytes, dataStart, size);
        const name = pendingPax.path ?? pendingLongName ?? header.name;
        const mtime = pendingPax.mtime ?? header.mtime;
        const directory = header.typeFlag === "5" || name.endsWith("/");
        const supported = directory || header.typeFlag === "0" || header.typeFlag === "\0" || header.typeFlag === " ";
        pendingLongName = undefined;
        pendingPax = {};
        cursor = dataStart + padded;
        if (!supported) continue;
        if (builder.atCapacity()) {
            builder.markTruncated();
            return builder.listing(format);
        }
        const path = normalizeArchivePath(name);
        if (path === undefined) {
            builder.skip(name);
            continue;
        }
        const modifiedAt = mtime === undefined ? undefined : timestampIso(mtime);
        builder.add({
            path,
            directory,
            size,
            ...(modifiedAt === undefined ? {} : { modifiedAt }),
        });
    }
    if (cursor < bytes.length && !isZeroBlock(bytes.subarray(cursor))) {
        throw invalid("tar ends with a partial or non-zero block");
    }
    return builder.listing(format);
}

interface GzipHeader {
    readonly name?: string;
    readonly modifiedAt?: string;
}

/** Parses a gzip member header, skipping its optional fields and rejecting truncated headers. */
function readGzipHeader(bytes: Uint8Array): GzipHeader {
    if (bytes.length < GZIP_HEADER_BYTES + GZIP_TRAILER_BYTES) throw invalid("gzip stream is truncated");
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw invalid("gzip signature is missing");
    if (bytes[2] !== 8) throw invalid(`gzip compression method ${bytes[2]} is not deflate`);
    const flags = bytes[3]!;
    const mtime = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    let cursor = GZIP_HEADER_BYTES;
    if ((flags & GZIP_FLAG_FEXTRA) !== 0) {
        if (cursor + 2 > bytes.length) throw invalid("gzip extra-field length is out of bounds");
        const length = bytes[cursor]! | (bytes[cursor + 1]! << 8);
        cursor += 2;
        if (cursor + length > bytes.length) throw invalid("gzip extra field is out of bounds");
        cursor += length;
    }
    let name: string | undefined;
    if ((flags & GZIP_FLAG_FNAME) !== 0) {
        const terminator = bytes.indexOf(0, cursor);
        if (terminator < 0) throw invalid("gzip file name is not NUL-terminated");
        name = decodeUtf8(bytes.subarray(cursor, terminator));
        cursor = terminator + 1;
    }
    if ((flags & GZIP_FLAG_FCOMMENT) !== 0) {
        const terminator = bytes.indexOf(0, cursor);
        if (terminator < 0) throw invalid("gzip comment is not NUL-terminated");
        cursor = terminator + 1;
    }
    if ((flags & GZIP_FLAG_FHCRC) !== 0) {
        if (cursor + 2 > bytes.length) throw invalid("gzip header CRC is out of bounds");
        cursor += 2;
    }
    if (cursor > bytes.length - GZIP_TRAILER_BYTES) throw invalid("gzip header overlaps its trailer");
    const modifiedAt = mtime === 0 ? undefined : timestampIso(mtime);
    return {
        ...(name === undefined || name === "" ? {} : { name }),
        ...(modifiedAt === undefined ? {} : { modifiedAt }),
    };
}

function isZlibLimit(error: unknown): boolean {
    return typeof error === "object" && error !== null
        && ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
            || (error instanceof RangeError && /larger than|output length/i.test(error.message)));
}

/**
 * Lists a gzip stream. The payload is decompressed only inside the `maxTotalBytes` budget:
 * a payload that begins with a ustar header is parsed as `tar.gz`, everything else is one
 * `gzip` member whose size comes from the ISIZE trailer field.
 */
function readGzipListing(bytes: Uint8Array, limits: Required<DocumentLimits>): ArchiveListing {
    const header = readGzipHeader(bytes);
    const isize = readUint32LE(bytes, bytes.length - 4);
    if (isize > limits.maxTotalBytes) {
        throw limitExceeded(`gzip stream expands to ${isize} bytes; the total budget is ${limits.maxTotalBytes}`);
    }
    const cap = Math.max(1, Math.min(limits.maxTotalBytes, MAX_ZLIB_OUTPUT));
    let content: Uint8Array;
    try {
        content = new Uint8Array(gunzipSync(bytes, { maxOutputLength: cap }));
    } catch (error) {
        if (isZlibLimit(error)) {
            throw limitExceeded(`gzip stream expands beyond the total budget of ${limits.maxTotalBytes} bytes`);
        }
        throw invalid(`cannot decompress gzip stream: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (content.length > limits.maxTotalBytes) {
        throw limitExceeded(`gzip stream expands to ${content.length} bytes; the total budget is ${limits.maxTotalBytes}`);
    }
    if (content.length >= TAR_MAGIC_END && ascii(content.subarray(TAR_MAGIC_START, TAR_MAGIC_END)) === "ustar") {
        return readTarListing(content, limits, "tar.gz");
    }
    const builder = new ListingBuilder(limits);
    builder.visit("gzip member");
    if (builder.atCapacity()) {
        builder.markTruncated();
        return builder.listing("gzip");
    }
    let path = header.name === undefined ? "content" : normalizeArchivePath(header.name);
    if (path === undefined) {
        if (header.name !== undefined) builder.skip(header.name);
        path = "content";
    }
    builder.add({
        path,
        directory: false,
        size: isize,
        compressedSize: bytes.length,
        ...(header.modifiedAt === undefined ? {} : { modifiedAt: header.modifiedAt }),
    });
    return builder.listing("gzip");
}

/**
 * Detects the archive container from its magic bytes. GZIP payloads are not decompressed here,
 * so `tar.gz` members are only promoted by `readArchiveListing`.
 */
export function detectArchiveFormat(bytes: Uint8Array): ArchiveFormat {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("archive input must be a Uint8Array");
    if (matchesAt(bytes, 0, ZIP_LOCAL_MAGIC) || matchesAt(bytes, 0, ZIP_EMPTY_MAGIC)
        || matchesAt(bytes, 0, ZIP_SPANNED_MAGIC)) {
        return "zip";
    }
    if (matchesAt(bytes, 0, GZIP_MAGIC)) return "gzip";
    if (matchesAt(bytes, TAR_MAGIC_START, TAR_MAGIC)) return "tar";
    if (matchesAt(bytes, 0, SEVEN_ZIP_MAGIC)) return "7z";
    if (matchesAt(bytes, 0, RAR_MAGIC)) return "rar";
    if (matchesAt(bytes, 0, XZ_MAGIC)) return "xz";
    if (matchesAt(bytes, 0, BZIP2_MAGIC)) return "bzip2";
    if (matchesAt(bytes, 0, ZSTD_MAGIC)) return "zstd";
    return "unknown";
}

/** Lists the metadata rows of an archive without extracting its members to disk. */
export function readArchiveListing(bytes: Uint8Array, limits: DocumentLimits = {}): ArchiveListing {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("archive input must be a Uint8Array");
    const merged: Required<DocumentLimits> = { ...defaultDocumentLimits, ...limits };
    const format = detectArchiveFormat(bytes);
    switch (format) {
        case "zip":
            return readZipListing(bytes, merged);
        case "tar":
            return readTarListing(bytes, merged, "tar");
        case "tar.gz":
            return readTarListing(bytes, merged, "tar.gz");
        case "gzip":
            return readGzipListing(bytes, merged);
        case "7z":
        case "rar":
        case "xz":
        case "bzip2":
        case "zstd":
            throw unsupportedArchive(format);
        case "unknown":
            throw invalid("unrecognized archive format");
        default:
            throw invalid("unrecognized archive format");
    }
}

/**
 * Projects an archive listing into the common document-outline shape. Directories become
 * `"section"` entries and files become `"note"` entries; `locator.part` names the container
 * format and `locator.paragraph` is the 1-based listing ordinal.
 */
export function parseArchiveOutline(bytes: Uint8Array, limits: DocumentLimits = {}): DocumentOutline {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("archive input must be a Uint8Array");
    const listing = readArchiveListing(bytes, limits);
    const entries: DocumentEntry[] = [];
    const summaries: string[] = [];
    for (let index = 0; index < listing.entries.length; index += 1) {
        const item = listing.entries[index]!;
        const kind: DocumentEntryKind = item.directory ? "section" : "note";
        const sizeText = item.size < 0 ? "unknown size" : `${item.size} bytes`;
        const summary = item.directory ? "directory" : item.encrypted === true ? `${sizeText} encrypted` : sizeText;
        const locator: DocumentLocator = Object.freeze({ part: `compress:${listing.format}`, paragraph: index + 1 });
        entries.push(Object.freeze({
            id: `compress:${index + 1}`,
            kind,
            name: item.path,
            summary,
            locator,
        }));
        summaries.push(summary);
    }
    return Object.freeze({
        language: "compress",
        entries: Object.freeze(entries),
        text: summaries.join("\n"),
        truncated: listing.truncated,
    });
}
