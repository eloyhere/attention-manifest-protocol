/**
 * Bounded, read-only ZIP container reader.
 *
 * Office Open XML documents are ZIP archives. Parsing them does not require a
 * general-purpose unzip implementation, but it does require the same resource
 * discipline as the rest of the filesystem domain: every offset is checked
 * against the buffer, every chain is bounded, unsupported features are rejected
 * instead of guessed, and expansion is capped per entry and in aggregate.
 *
 * The reader deliberately implements only what OOXML packages use:
 *
 * - the end-of-central-directory record (EOCD), including the archive comment;
 * - the central directory and its local file headers;
 * - method `0` (stored) and method `8` (deflate, through `node:zlib`);
 * - entry names as UTF-8 (or Latin-1 when the UTF-8 flag is absent).
 *
 * Encrypted entries, ZIP64 archives, multi-disk archives and out-of-bounds
 * offsets are rejected with the closed `parse_failed` / `quota_exceeded` error
 * codes. Central-directory CRCs are not verified because Office readers rely on
 * the XML parser and the per-entry size checks instead; a caller that needs CRC
 * verification should do it on the extracted bytes.
 *
 * Expansion limits are 64 MiB for one entry and 256 MiB in total. Both are
 * enforced against the declared size *and* the actual inflate output so a lying
 * header cannot exhaust memory.
 */
import { inflateRawSync } from "node:zlib";

import { fail } from "./errors.ts";

/**
 * One central-directory entry.
 *
 * `offset` is the local file header offset in the archive, not the payload
 * offset; `compressedSize` and `uncompressedSize` are the central-directory
 * values, which are authoritative even when a data descriptor follows the
 * payload.
 */
export interface ZipEntry {
    readonly name: string;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly method: number;
    readonly offset: number;
}

const EocdSignature: number = 0x06054b50;
const CentralSignature: number = 0x02014b50;
const LocalSignature: number = 0x04034b50;
const EocdLength: number = 22;
const CentralLength: number = 46;
const LocalLength: number = 30;
const MaxCommentLength: number = 0xffff;
const MaxEntries: number = 16384;
const MaxCentralBytes: number = 64 * 1024 * 1024;
const MaxEntryBytes: number = 64 * 1024 * 1024;
const MaxTotalBytes: number = 256 * 1024 * 1024;
const Zip64ExtraId: number = 0x0001;
const Utf8Flag: number = 0x0800;
const EncryptedFlag: number = 0x0001;
const StrongEncryptionFlag: number = 0x0040;
const MaskedHeaderFlag: number = 0x2000;
const Zip64Sentinel16: number = 0xffff;
const Zip64Sentinel32: number = 0xffffffff;

/**
 * Create a little-endian view over the exact bytes the caller supplied.
 * A Node `Buffer` is a `Uint8Array` with its own `byteOffset`, so the view must
 * not assume that the backing array starts at zero.
 *
 * @param bytes - Archive bytes.
 * @returns A view sharing the caller's memory.
 */
const viewOf: (bytes: Uint8Array) => DataView = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const uint16: (view: DataView, offset: number) => number = (view: DataView, offset: number): number => view.getUint16(offset, true);

const uint32: (view: DataView, offset: number) => number = (view: DataView, offset: number): number => view.getUint32(offset, true);

/**
 * Decode an entry name. The UTF-8 flag is optional for ASCII-only archives,
 * where Latin-1 and UTF-8 agree; a genuinely non-ASCII name without the flag is
 * decoded as Latin-1 rather than rejected, matching common ZIP writers.
 *
 * @param bytes - Archive bytes.
 * @param offset - Name start.
 * @param length - Name byte length.
 * @param utf8 - Whether the UTF-8 name flag was set.
 * @returns Decoded name.
 */
const decodeName: (bytes: Uint8Array, offset: number, length: number, utf8: boolean) => string = (
    bytes: Uint8Array,
    offset: number,
    length: number,
    utf8: boolean,
): string => {
    const slice: Uint8Array = bytes.subarray(offset, offset + length);
    if (utf8) {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(slice);
        } catch {
            return fail("parse_failed");
        }
    }
    let name: string = "";
    for (let index: number = 0; index < slice.length; index += 1) {
        name += String.fromCharCode(slice[index]);
    }
    return name;
};

/**
 * Reject an entry name that could escape the conceptual archive root.
 *
 * The returned map is keyed by the entry name, not extracted to disk, so this
 * is defence in depth rather than the only barrier: an OOXML parser that joins
 * a relationship target with a part name must never see `..` in a part name.
 * Absolute names, backslashes, drive letters and NUL/control characters are
 * rejected for the same reason.
 *
 * @param name - Decoded entry name.
 * @returns The same name when safe.
 */
const assertSafeName: (name: string) => string = (name: string): string => {
    if (name.length === 0 || name.length > 4096) {
        return fail("parse_failed");
    }
    if (name.startsWith("/") || name.startsWith("\\") || name.startsWith("//") || /^[A-Za-z]:/.test(name)) {
        return fail("parse_failed");
    }
    if (name.includes("\\")) {
        return fail("parse_failed");
    }
    for (let index: number = 0; index < name.length; index += 1) {
        const code: number = name.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) {
            return fail("parse_failed");
        }
    }
    const segments: string[] = name.split("/");
    for (let index: number = 0; index < segments.length; index += 1) {
        if (segments[index] === "..") {
            return fail("parse_failed");
        }
    }
    return name;
};

/**
 * Scan a ZIP extra field for the ZIP64 marker. The sizes in the central
 * directory are then usually `0xffffffff`, but the extra field alone is enough
 * to reject the archive: silently reading a ZIP64 entry as 4 GiB is worse than
 * a clear failure.
 *
 * @param bytes - Archive bytes.
 * @param offset - Extra field start.
 * @param length - Extra field byte length.
 * @returns Nothing; throws when a ZIP64 field is present.
 */
const rejectZip64Extra: (bytes: Uint8Array, offset: number, length: number) => void = (bytes: Uint8Array, offset: number, length: number): void => {
    const end: number = offset + length;
    let cursor: number = offset;
    while (cursor + 4 <= end) {
        const id: number = bytes[cursor] | (bytes[cursor + 1] << 8);
        const size: number = bytes[cursor + 2] | (bytes[cursor + 3] << 8);
        if (id === Zip64ExtraId) {
            return fail("parse_failed");
        }
        cursor += 4 + size;
    }
};

/**
 * Parse the EOCD and return its byte offset. The comment length is validated so
 * a `PK\x05\x06` byte sequence inside a comment is not mistaken for the record.
 *
 * @param view - Archive view.
 * @param length - Archive byte length.
 * @returns EOCD offset.
 */
const findEocd: (view: DataView, length: number) => number = (view: DataView, length: number): number => {
    if (length < EocdLength) {
        return fail("parse_failed");
    }
    const first: number = Math.max(0, length - EocdLength - MaxCommentLength);
    for (let offset: number = length - EocdLength; offset >= first; offset -= 1) {
        if (uint32(view, offset) !== EocdSignature) {
            continue;
        }
        const commentLength: number = uint16(view, offset + 20);
        if (offset + EocdLength + commentLength === length) {
            return offset;
        }
    }
    return fail("parse_failed");
};

/**
 * Read and expand one entry from its local file header.
 *
 * The local header is re-read rather than trusted from the central directory so
 * a payload offset is always derived from bytes this reader has validated. The
 * local name must match the central name; a mismatch means the archive is
 * malformed or deliberately ambiguous.
 *
 * @param view - Archive view.
 * @param bytes - Archive bytes.
 * @param entry - Parsed central-directory entry.
 * @param offset - Local header offset.
 * @param utf8 - Whether the central name used UTF-8.
 * @param remaining - Bytes still allowed by the aggregate expansion limit.
 * @returns Expanded entry bytes.
 */
const readPayload: (view: DataView, bytes: Uint8Array, entry: ZipEntry, offset: number, utf8: boolean, remaining: number) => Uint8Array = (
    view: DataView,
    bytes: Uint8Array,
    entry: ZipEntry,
    offset: number,
    utf8: boolean,
    remaining: number,
): Uint8Array => {
    if (offset < 0 || offset + LocalLength > bytes.byteLength) {
        return fail("parse_failed");
    }
    if (uint32(view, offset) !== LocalSignature) {
        return fail("parse_failed");
    }
    const localFlags: number = uint16(view, offset + 6);
    if ((localFlags & EncryptedFlag) !== 0 || (localFlags & StrongEncryptionFlag) !== 0 || (localFlags & MaskedHeaderFlag) !== 0) {
        return fail("parse_failed");
    }
    const localMethod: number = uint16(view, offset + 8);
    if (localMethod !== entry.method) {
        return fail("parse_failed");
    }
    const localNameLength: number = uint16(view, offset + 26);
    const localExtraLength: number = uint16(view, offset + 28);
    const nameStart: number = offset + LocalLength;
    const nameEnd: number = nameStart + localNameLength;
    if (nameEnd > bytes.byteLength) {
        return fail("parse_failed");
    }
    const localName: string = decodeName(bytes, nameStart, localNameLength, utf8);
    if (localName !== entry.name) {
        return fail("parse_failed");
    }
    rejectZip64Extra(bytes, nameEnd, localExtraLength);
    const payloadStart: number = nameEnd + localExtraLength;
    const payloadEnd: number = payloadStart + entry.compressedSize;
    if (payloadStart < 0 || payloadEnd > bytes.byteLength) {
        return fail("parse_failed");
    }
    if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) {
            return fail("parse_failed");
        }
        return bytes.slice(payloadStart, payloadEnd);
    }
    const allowance: number = Math.min(MaxEntryBytes, remaining);
    if (allowance <= 0 || entry.uncompressedSize > allowance) {
        return fail("quota_exceeded");
    }
    let output: Buffer;
    try {
        output = inflateRawSync(bytes.subarray(payloadStart, payloadEnd), { maxOutputLength: allowance });
    } catch {
        return fail("parse_failed");
    }
    if (output.byteLength !== entry.uncompressedSize) {
        return fail("parse_failed");
    }
    return output;
};

/**
 * Read every ZIP entry into an in-memory map.
 *
 * The archive is never extracted to disk. Names are validated before the map is
 * built, so a caller cannot receive a key that would be unsafe to join against
 * a path. Duplicate names are rejected because the map would otherwise silently
 * let the last entry win, which is a classic archive-confusion bug.
 *
 * @param bytes - Archive bytes.
 * @returns Entry name to expanded bytes.
 */
export const readZipEntries: (bytes: Uint8Array) => Map<string, Uint8Array> = (bytes: Uint8Array): Map<string, Uint8Array> => {
    const view: DataView = viewOf(bytes);
    const eocd: number = findEocd(view, bytes.byteLength);
    const diskNumber: number = uint16(view, eocd + 4);
    const centralDisk: number = uint16(view, eocd + 6);
    const entriesOnDisk: number = uint16(view, eocd + 8);
    const entryCount: number = uint16(view, eocd + 10);
    const centralSize: number = uint32(view, eocd + 12);
    const centralOffset: number = uint32(view, eocd + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
        return fail("parse_failed");
    }
    if (entryCount === Zip64Sentinel16 || centralSize === Zip64Sentinel32 || centralOffset === Zip64Sentinel32) {
        return fail("parse_failed");
    }
    if (entryCount > MaxEntries) {
        return fail("quota_exceeded");
    }
    if (centralSize > MaxCentralBytes) {
        return fail("quota_exceeded");
    }
    if (centralOffset < 0 || centralOffset + centralSize > eocd) {
        return fail("parse_failed");
    }
    const centralEnd: number = centralOffset + centralSize;
    const entries: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    let cursor: number = centralOffset;
    let expanded: number = 0;
    for (let index: number = 0; index < entryCount; index += 1) {
        if (cursor < 0 || cursor + CentralLength > centralEnd) {
            return fail("parse_failed");
        }
        if (uint32(view, cursor) !== CentralSignature) {
            return fail("parse_failed");
        }
        const flags: number = uint16(view, cursor + 8);
        const method: number = uint16(view, cursor + 10);
        const compressedSize: number = uint32(view, cursor + 20);
        const uncompressedSize: number = uint32(view, cursor + 24);
        const nameLength: number = uint16(view, cursor + 28);
        const extraLength: number = uint16(view, cursor + 30);
        const commentLength: number = uint16(view, cursor + 32);
        const diskStart: number = uint16(view, cursor + 34);
        const localOffset: number = uint32(view, cursor + 42);
        if ((flags & EncryptedFlag) !== 0 || (flags & StrongEncryptionFlag) !== 0 || (flags & MaskedHeaderFlag) !== 0) {
            return fail("parse_failed");
        }
        if (method !== 0 && method !== 8) {
            return fail("parse_failed");
        }
        if (compressedSize === Zip64Sentinel32 || uncompressedSize === Zip64Sentinel32 || localOffset === Zip64Sentinel32 || diskStart === Zip64Sentinel16) {
            return fail("parse_failed");
        }
        if (diskStart !== 0) {
            return fail("parse_failed");
        }
        if (uncompressedSize > MaxEntryBytes || expanded + uncompressedSize > MaxTotalBytes) {
            return fail("quota_exceeded");
        }
        const nameStart: number = cursor + CentralLength;
        const nameEnd: number = nameStart + nameLength;
        const extraStart: number = nameEnd;
        const extraEnd: number = extraStart + extraLength;
        const next: number = extraEnd + commentLength;
        if (nameLength === 0 || nameEnd > centralEnd || extraEnd > centralEnd || next > centralEnd) {
            return fail("parse_failed");
        }
        rejectZip64Extra(bytes, extraStart, extraLength);
        const name: string = assertSafeName(decodeName(bytes, nameStart, nameLength, (flags & Utf8Flag) !== 0));
        if (entries.has(name)) {
            return fail("parse_failed");
        }
        const entry: ZipEntry = { name, compressedSize, uncompressedSize, method, offset: localOffset };
        const payload: Uint8Array = readPayload(view, bytes, entry, localOffset, (flags & Utf8Flag) !== 0, MaxTotalBytes - expanded);
        expanded += payload.byteLength;
        if (expanded > MaxTotalBytes || payload.byteLength !== uncompressedSize) {
            return fail("quota_exceeded");
        }
        entries.set(name, payload);
        cursor = next;
    }
    return entries;
};

/**
 * Decode a UTF-8 text part and remove a leading byte-order mark.
 *
 * @param entries - Entry map from `readZipEntries`.
 * @param name - Part name, for example `word/document.xml`.
 * @returns Decoded text, or `undefined` when the part is absent.
 */
export const zipText: (entries: ReadonlyMap<string, Uint8Array>, name: string) => string | undefined = (
    entries: ReadonlyMap<string, Uint8Array>,
    name: string,
): string | undefined => {
    const bytes: Uint8Array | undefined = entries.get(name);
    if (bytes === (void 0)) {
        return undefined;
    }
    let start: number = 0;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        start = 3;
    }
    return new TextDecoder("utf-8").decode(bytes.subarray(start));
};
