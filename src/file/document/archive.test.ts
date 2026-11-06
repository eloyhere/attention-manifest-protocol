import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { definition } from "../language/compress.ts";
import { LanguageRegistry } from "../language/registry.ts";
import { detectArchiveFormat, parseArchiveOutline, readArchiveListing, type ArchiveFormat } from "./archive.ts";
import { createZip } from "./testZip.ts";
import { DocumentError } from "./types.ts";

const encoder = new TextEncoder();
/** 2023-11-14T22:13:20.000Z; a fixed TAR/PAX timestamp keeps assertions deterministic. */
const MTIME = 1_700_000_000;
const MTIME_ISO = "2023-11-14T22:13:20.000Z";

function documentError(operation: () => unknown): DocumentError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error;
        throw error;
    }
    assert.fail("expected a DocumentError");
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
    const length = parts.reduce((total, part) => total + part.length, 0);
    const output = new Uint8Array(length);
    let cursor = 0;
    for (const part of parts) {
        output.set(part, cursor);
        cursor += part.length;
    }
    return output;
}

function writeU16(view: DataView, offset: number, value: number): void {
    view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
    view.setUint32(offset, value >>> 0, true);
}

function writeU64(view: DataView, offset: number, value: number): void {
    writeU32(view, offset, value % 0x1_0000_0000);
    writeU32(view, offset + 4, Math.floor(value / 0x1_0000_0000));
}

interface ZipEocd {
    readonly count: number;
    readonly dirSize: number;
    readonly dirOffset: number;
}

function zipEocd(zip: Uint8Array): ZipEocd {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const offset = zip.length - 22;
    assert.equal(view.getUint32(offset, true), 0x06054b50);
    return {
        count: view.getUint16(offset + 10, true),
        dirSize: view.getUint32(offset + 12, true),
        dirOffset: view.getUint32(offset + 16, true),
    };
}

/**
 * Appends one stored directory record to a `createZip` archive: a local header, a central
 * directory entry with the requested external attributes, and a rewritten EOCD.
 */
function appendDirectoryEntry(zip: Uint8Array, name: string, externalAttributes: number): Uint8Array {
    const { count, dirSize, dirOffset } = zipEocd(zip);
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, 0);
    writeU32(localView, 18, 0);
    writeU32(localView, 22, 0);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, 0);
    writeU32(centralView, 20, 0);
    writeU32(centralView, 24, 0);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, externalAttributes);
    writeU32(centralView, 42, dirOffset);
    central.set(nameBytes, 46);

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    writeU32(eocdView, 0, 0x06054b50);
    writeU16(eocdView, 8, count + 1);
    writeU16(eocdView, 10, count + 1);
    writeU32(eocdView, 12, dirSize + central.length);
    writeU32(eocdView, 16, dirOffset + local.length);
    const centralOffset = dirOffset + local.length;
    const output = new Uint8Array(centralOffset + dirSize + central.length + eocd.length);
    output.set(zip.subarray(0, dirOffset), 0);
    output.set(local, dirOffset);
    output.set(zip.subarray(dirOffset, dirOffset + dirSize), centralOffset);
    output.set(central, centralOffset + dirSize);
    output.set(eocd, centralOffset + dirSize + central.length);
    return output;
}

/** Rewrites the general-purpose flags of one central-directory entry in place. */
function setCentralFlags(zip: Uint8Array, index: number, flags: number): Uint8Array {
    const { count, dirOffset } = zipEocd(zip);
    assert.ok(index < count, "central entry index is in range");
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let offset = dirOffset;
    for (let current = 0; current < index; current += 1) {
        assert.equal(view.getUint32(offset, true), 0x02014b50);
        offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true)
            + view.getUint16(offset + 32, true);
    }
    const copy = new Uint8Array(zip);
    new DataView(copy.buffer).setUint16(offset + 8, flags, true);
    return copy;
}

/**
 * Replaces a classic EOCD with a Zip64 EOCD record, its locator and sentinel-filled EOCD.
 * The central directory itself stays 32-bit, which the reader must accept.
 */
function withZip64Eocd(zip: Uint8Array): Uint8Array {
    const { count, dirSize, dirOffset } = zipEocd(zip);
    const prefix = zip.subarray(0, zip.length - 22);
    const record = new Uint8Array(56);
    const recordView = new DataView(record.buffer);
    writeU32(recordView, 0, 0x06064b50);
    writeU64(recordView, 4, 44);
    writeU16(recordView, 12, 45);
    writeU16(recordView, 14, 45);
    writeU32(recordView, 16, 0);
    writeU32(recordView, 20, 0);
    writeU64(recordView, 24, count);
    writeU64(recordView, 32, count);
    writeU64(recordView, 40, dirSize);
    writeU64(recordView, 48, dirOffset);
    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    writeU32(locatorView, 0, 0x07064b50);
    writeU32(locatorView, 4, 0);
    writeU64(locatorView, 8, prefix.length);
    writeU32(locatorView, 16, 1);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    writeU32(eocdView, 0, 0x06054b50);
    writeU16(eocdView, 8, 0xffff);
    writeU16(eocdView, 10, 0xffff);
    writeU32(eocdView, 12, 0xffff_ffff);
    writeU32(eocdView, 16, 0xffff_ffff);
    return concat(prefix, record, locator, eocd);
}

/** Builds a one-entry ZIP whose central sizes use 0xffffffff and a 0x0001 Zip64 extra. */
function makeZip64ExtraZip(): Uint8Array {
    const name = encoder.encode("a.txt");
    const content = encoder.encode("hello");
    const local = new Uint8Array(30 + name.length + content.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 45);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, 0);
    writeU16(localView, 12, 0);
    writeU32(localView, 14, 0);
    writeU32(localView, 18, content.length);
    writeU32(localView, 22, content.length);
    writeU16(localView, 26, name.length);
    writeU16(localView, 28, 0);
    local.set(name, 30);
    local.set(content, 30 + name.length);

    const extra = new Uint8Array(20);
    const extraView = new DataView(extra.buffer);
    writeU16(extraView, 0, 0x0001);
    writeU16(extraView, 2, 16);
    writeU64(extraView, 4, content.length);
    writeU64(extraView, 12, content.length);

    const central = new Uint8Array(46 + name.length + extra.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 45);
    writeU16(centralView, 6, 45);
    writeU16(centralView, 8, 0);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, 0);
    writeU16(centralView, 14, 0);
    writeU32(centralView, 16, 0);
    writeU32(centralView, 20, 0xffff_ffff);
    writeU32(centralView, 24, 0xffff_ffff);
    writeU16(centralView, 28, name.length);
    writeU16(centralView, 30, extra.length);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, 0);
    central.set(name, 46);
    central.set(extra, 46 + name.length);

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    writeU32(eocdView, 0, 0x06054b50);
    writeU16(eocdView, 8, 1);
    writeU16(eocdView, 10, 1);
    writeU32(eocdView, 12, central.length);
    writeU32(eocdView, 16, local.length);
    return concat(local, central, eocd);
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
    target.set(encoder.encode(value), offset);
}

/** Writes an 11-digit octal value plus a NUL terminator into a TAR header field. */
function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
    const text = value.toString(8);
    assert.ok(text.length <= length - 1, "octal value fits its TAR field");
    writeAscii(target, offset, text.padStart(length - 1, "0"));
    target[offset + length - 1] = 0;
}

interface TarHeaderOptions {
    readonly name: string;
    readonly size?: number;
    readonly mtime?: number;
    readonly type?: string;
    readonly magic?: string;
    readonly prefix?: string;
    /** Raw size field, used to exercise space-padded octal values. */
    readonly sizeField?: string;
}

/** Builds one checksummed 512-byte ustar header; the checksum field is summed as spaces. */
function tarHeader(options: TarHeaderOptions): Uint8Array {
    const block = new Uint8Array(512);
    writeAscii(block, 0, options.name);
    writeOctal(block, 100, 8, 0o644);
    writeOctal(block, 108, 8, 0);
    writeOctal(block, 116, 8, 0);
    if (options.sizeField === undefined) writeOctal(block, 124, 12, options.size ?? 0);
    else {
        assert.ok(options.sizeField.length <= 12, "raw size field fits");
        writeAscii(block, 124, options.sizeField);
    }
    writeOctal(block, 136, 12, options.mtime ?? MTIME);
    for (let index = 148; index < 156; index += 1) block[index] = 0x20;
    writeAscii(block, 156, options.type ?? "0");
    writeAscii(block, 257, options.magic ?? "ustar\0");
    writeAscii(block, 263, "00");
    if (options.prefix !== undefined) writeAscii(block, 345, options.prefix);
    let checksum = 0;
    for (const byte of block) checksum += byte;
    writeAscii(block, 148, checksum.toString(8).padStart(6, "0"));
    block[154] = 0;
    block[155] = 0x20;
    return block;
}

function tarRecord(header: Uint8Array, data: Uint8Array = new Uint8Array()): Uint8Array {
    const padded = Math.ceil(data.length / 512) * 512;
    const record = new Uint8Array(512 + padded);
    record.set(header);
    record.set(data, 512);
    return record;
}

/** PAX record whose decimal length prefix includes the prefix, the body and the newline. */
function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    let record = `${length}${body}`;
    while (record.length !== length) {
        length = record.length;
        record = `${length}${body}`;
    }
    return record;
}

function makeBasicTar(): Uint8Array {
    return concat(
        tarRecord(tarHeader({ name: "notes.txt", size: 5 }), encoder.encode("hello")),
        tarRecord(tarHeader({ name: "docs/", type: "5" })),
        new Uint8Array(1024),
    );
}

/** Inserts a gzip FNAME field into an existing single-member gzip stream. */
function withGzipName(gzip: Uint8Array, name: string): Uint8Array {
    const copy = new Uint8Array(gzip);
    copy[3] = copy[3]! | 0x08;
    return concat(copy.subarray(0, 10), encoder.encode(name), new Uint8Array([0]), copy.subarray(10));
}

test("zip lists createZip members plus a handwritten directory without inflating them", () => {
    const zip = appendDirectoryEntry(createZip({ "alpha.txt": "alpha", "beta.txt": "beta beta" }), "docs/", 0x10);
    const listing = readArchiveListing(zip);

    assert.equal(listing.format, "zip");
    assert.equal(listing.truncated, false);
    assert.deepEqual(listing.skipped, []);
    assert.deepEqual(listing.entries.map(entry => entry.path), ["alpha.txt", "beta.txt", "docs"]);
    assert.deepEqual(listing.entries.map(entry => entry.directory), [false, false, true]);
    assert.deepEqual(listing.entries.map(entry => entry.size), [5, 9, 0]);
    assert.equal(typeof listing.entries[0]!.compressedSize, "number");
    assert.equal(listing.entries[0]!.path, "alpha.txt");
    assert.equal(Object.isFrozen(listing), true);
    assert.equal(Object.isFrozen(listing.entries), true);
    for (const entry of listing.entries) assert.equal(Object.isFrozen(entry), true);
});

test("zip honours the encryption bit and the UTF-8 name flag", () => {
    const encrypted = setCentralFlags(createZip({ "secret.txt": "payload" }), 0, 0x1);
    const secret = readArchiveListing(encrypted);
    assert.equal(secret.entries[0]!.path, "secret.txt");
    assert.equal(secret.entries[0]!.encrypted, true);

    const utf8 = setCentralFlags(createZip({ "文档.txt": "hi" }), 0, 0x800);
    assert.equal(readArchiveListing(utf8).entries[0]!.path, "文档.txt");
});

test("zip skips parent-relative, absolute and drive-qualified names", () => {
    const zip = createZip({
        "../evil": "x",
        "/absolute.txt": "y",
        "C:\\drive.txt": "z",
        "dir\\file.txt": "ok",
        "safe.txt": "ok",
    });
    const listing = readArchiveListing(zip);

    assert.equal(listing.format, "zip");
    assert.deepEqual(listing.entries.map(entry => entry.path), ["dir/file.txt", "safe.txt"]);
    assert.deepEqual(listing.skipped, ["../evil", "/absolute.txt", "C:\\drive.txt"]);
});

test("zip rejects corrupt or truncated end-of-central-directory records", () => {
    const zip = createZip({ "a.txt": "a" });
    assert.equal(documentError(() => readArchiveListing(zip.slice(0, zip.length - 5))).code, "invalid_document");

    const noSignature = new Uint8Array(zip);
    noSignature[zip.length - 22] = 0;
    assert.equal(documentError(() => readArchiveListing(noSignature)).code, "invalid_document");

    const { dirOffset } = zipEocd(zip);
    const brokenDirectory = new Uint8Array(zip);
    brokenDirectory[dirOffset] = 0;
    assert.equal(documentError(() => readArchiveListing(brokenDirectory)).code, "invalid_document");
});

test("zip64 sentinels without an extended central directory are unsupported_format", () => {
    const zip = createZip({ "a.txt": "a" });
    const sentinel = new Uint8Array(zip);
    new DataView(sentinel.buffer).setUint16(zip.length - 12, 0xffff, true);
    const error = documentError(() => readArchiveListing(sentinel));
    assert.equal(error.code, "unsupported_format");
    assert.match(error.message, /zip64 archive needs the extended central directory/);
});

test("zip64 end-of-central-directory records and size extras are followed", () => {
    const wide = withZip64Eocd(createZip({ "a.txt": "hello", "b.txt": "world" }));
    const listing = readArchiveListing(wide);
    assert.equal(listing.format, "zip");
    assert.deepEqual(listing.entries.map(entry => entry.path), ["a.txt", "b.txt"]);
    assert.deepEqual(listing.entries.map(entry => entry.size), [5, 5]);

    const extra = readArchiveListing(makeZip64ExtraZip());
    assert.equal(extra.entries.length, 1);
    assert.equal(extra.entries[0]!.path, "a.txt");
    assert.equal(extra.entries[0]!.size, 5);
    assert.equal(extra.entries[0]!.compressedSize, 5);
});

test("zip decodes CP437 names when the UTF-8 flag is clear and reads Unix directory modes", () => {
    const zip = new Uint8Array(createZip({ "cafX.txt": "x" }));
    const needle = encoder.encode("cafX.txt");
    let replacements = 0;
    for (let index = 0; index + needle.length <= zip.length; index += 1) {
        let matches = true;
        for (let offset = 0; offset < needle.length; offset += 1) {
            if (zip[index + offset] !== needle[offset]) {
                matches = false;
                break;
            }
        }
        if (!matches) continue;
        zip[index + 3] = 0x82;
        replacements += 1;
    }
    assert.equal(replacements, 2);
    assert.equal(readArchiveListing(zip).entries[0]!.path, "café.txt");

    const unixDirectory = appendDirectoryEntry(createZip({ "x.txt": "x" }), "unix/", (0o040755 << 16) >>> 0);
    assert.equal(readArchiveListing(unixDirectory).entries[1]!.directory, true);
});

test("tar reads ustar files, directories, prefixes and GNU long names", () => {
    const longName = `deep/${"n".repeat(120)}.txt`;
    const longBytes = encoder.encode(`${longName}\0`);
    const tar = concat(
        tarRecord(tarHeader({ name: "notes.txt", size: 5 }), encoder.encode("hello")),
        tarRecord(tarHeader({ name: "docs/", type: "5" })),
        tarRecord(tarHeader({ name: "inner.txt", size: 2, prefix: "nested/dir" }), encoder.encode("in")),
        tarRecord(tarHeader({ name: "././@LongLink", size: longBytes.length, type: "L" }), longBytes),
        tarRecord(tarHeader({ name: "short.txt", size: 1 }), encoder.encode("x")),
        new Uint8Array(1024),
    );
    const listing = readArchiveListing(tar);

    assert.equal(listing.format, "tar");
    assert.equal(listing.truncated, false);
    assert.deepEqual(listing.skipped, []);
    assert.deepEqual(listing.entries.map(entry => entry.path),
        ["notes.txt", "docs", "nested/dir/inner.txt", longName]);
    assert.deepEqual(listing.entries.map(entry => entry.directory), [false, true, false, false]);
    assert.deepEqual(listing.entries.map(entry => entry.size), [5, 0, 2, 1]);
    assert.deepEqual(listing.entries.map(entry => entry.modifiedAt), [MTIME_ISO, MTIME_ISO, MTIME_ISO, MTIME_ISO]);
});

test("tar accepts space-padded octal size fields and pax metadata", () => {
    const spaced = readArchiveListing(
        concat(tarRecord(tarHeader({ name: "spaced.txt", sizeField: " 00000000005" }), encoder.encode("12345")),
            new Uint8Array(1024)));
    assert.equal(spaced.entries[0]!.path, "spaced.txt");
    assert.equal(spaced.entries[0]!.size, 5);

    const body = encoder.encode("pax body");
    const pax = encoder.encode([
        paxRecord("path", "pax/real.txt"),
        paxRecord("size", String(body.length)),
        paxRecord("mtime", "1700000000.5"),
    ].join(""));
    const tar = concat(
        tarRecord(tarHeader({ name: "PaxHeaders/real", size: pax.length, type: "x" }), pax),
        tarRecord(tarHeader({ name: "placeholder.txt", size: body.length }), body),
        new Uint8Array(1024),
    );
    const entry = readArchiveListing(tar).entries[0]!;
    assert.equal(entry.path, "pax/real.txt");
    assert.equal(entry.size, body.length);
    assert.equal(entry.modifiedAt, "2023-11-14T22:13:20.500Z");
});

test("tar rejects a bad header checksum and a partial data block", () => {
    const bad = tarHeader({ name: "bad.txt" });
    bad[0] = 0x42;
    assert.equal(documentError(() => readArchiveListing(bad)).code, "invalid_document");

    const data = encoder.encode("x".repeat(1024));
    const tar = concat(tarHeader({ name: "big.bin", size: data.length }), data, new Uint8Array(1024));
    assert.equal(documentError(() => readArchiveListing(tar.slice(0, 512 + 100))).code, "invalid_document");
});

test("gzip of a tar is reported as tar.gz with the same entries", () => {
    const tar = makeBasicTar();
    const gzip = gzipSync(tar);
    const listing = readArchiveListing(gzip);

    assert.equal(listing.format, "tar.gz");
    assert.deepEqual(listing.entries, readArchiveListing(tar).entries);
    assert.equal(parseArchiveOutline(gzip).entries[0]!.locator.part, "compress:tar.gz");
});

test("plain gzip is one member sized from ISIZE and named by FNAME when present", () => {
    const content = encoder.encode("plain text");
    const gzip = gzipSync(content);
    const listing = readArchiveListing(gzip);

    assert.equal(listing.format, "gzip");
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.entries[0]!.path, "content");
    assert.equal(listing.entries[0]!.size, content.length);
    assert.equal(listing.entries[0]!.compressedSize, gzip.length);
    assert.equal(listing.entries[0]!.directory, false);

    assert.equal(readArchiveListing(withGzipName(gzip, "original.txt")).entries[0]!.path, "original.txt");
});

test("7z, rar, xz, bzip2 and zstd raise unsupported_format with the format name", () => {
    const cases: readonly (readonly [ArchiveFormat, readonly number[]])[] = [
        ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
        ["rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
        ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
        ["bzip2", [0x42, 0x5a, 0x68]],
        ["zstd", [0x28, 0xb5, 0x2f, 0xfd]],
    ];
    for (const [format, magic] of cases) {
        const bytes = new Uint8Array(600);
        bytes.set(magic);
        assert.equal(detectArchiveFormat(bytes), format);
        const error = documentError(() => readArchiveListing(bytes));
        assert.equal(error.code, "unsupported_format");
        assert.match(error.message, new RegExp(format));
    }
});

test("entry, node and gzip total budgets are enforced", () => {
    const zip = appendDirectoryEntry(createZip({ "a.txt": "a", "b.txt": "b" }), "dir/", 0x10);
    const capped = readArchiveListing(zip, { maxEntriesInOutline: 1 });
    assert.equal(capped.entries.length, 1);
    assert.equal(capped.truncated, true);

    assert.equal(documentError(() => readArchiveListing(zip, { maxNodes: 1 })).code, "limit_exceeded");

    const large = gzipSync(Buffer.alloc(4096, 0x61));
    assert.equal(documentError(() => readArchiveListing(large, { maxTotalBytes: 1024 })).code, "limit_exceeded");

    // ISIZE only covers the last gzip member, so the decompressor itself must stop over budget.
    const twoMembers = concat(gzipSync(Buffer.alloc(2048, 0x61)), gzipSync(Buffer.alloc(2048, 0x62)));
    assert.equal(documentError(() => readArchiveListing(twoMembers, { maxTotalBytes: 3000 })).code, "limit_exceeded");
});

test("unknown bytes are invalid_document and non-bytes are a TypeError", () => {
    const unknown = new Uint8Array([1, 2, 3, 4]);
    assert.equal(detectArchiveFormat(unknown), "unknown");
    assert.equal(documentError(() => readArchiveListing(unknown)).code, "invalid_document");
    assert.throws(() => detectArchiveFormat("nope" as unknown as Uint8Array), TypeError);
    assert.throws(() => readArchiveListing("nope" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseArchiveOutline(null as unknown as Uint8Array), TypeError);
});

test("detectArchiveFormat recognises zip, tar and gzip magic bytes", () => {
    assert.equal(detectArchiveFormat(createZip({})), "zip");
    assert.equal(detectArchiveFormat(tarHeader({ name: "a.txt" })), "tar");
    assert.equal(detectArchiveFormat(gzipSync(encoder.encode("x"))), "gzip");
});

test("parseArchiveOutline maps directories and files with stable ids, locators and freezing", () => {
    const zip = appendDirectoryEntry(createZip({ "alpha.txt": "alpha", "beta.txt": "beta beta" }), "docs/", 0x10);
    const outline = parseArchiveOutline(zip);

    assert.equal(outline.language, "compress");
    assert.equal(outline.truncated, false);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["compress:1", "compress:2", "compress:3"]);
    assert.deepEqual(outline.entries.map(entry => entry.kind), ["note", "note", "section"]);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["alpha.txt", "beta.txt", "docs"]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), ["5 bytes", "9 bytes", "directory"]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "compress:zip", paragraph: 1 },
        { part: "compress:zip", paragraph: 2 },
        { part: "compress:zip", paragraph: 3 },
    ]);
    assert.equal(outline.text, "5 bytes\n9 bytes\ndirectory");
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }

    const secret = parseArchiveOutline(setCentralFlags(createZip({ "secret.txt": "x" }), 0, 0x1));
    assert.equal(secret.entries[0]!.summary, "1 bytes encrypted");
    assert.equal(parseArchiveOutline(zip, { maxEntriesInOutline: 1 }).truncated, true);
});

test("compress definition registers as a document language and resolves archive paths", () => {
    assert.equal(definition.id, "compress");
    assert.equal(definition.support, "document");
    assert.equal(definition.documentParser?.language, "compress");
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.extensions), true);
    assert.equal(Object.isFrozen(definition.mimeTypes), true);

    const registry = new LanguageRegistry({ definitions: [definition] });
    for (const path of ["a.zip", "a.tar", "a.tar.gz", "x.tgz", "a.gz", "data.7z", "a.rar", "a.xz", "a.bz2", "a.zst"]) {
        const match = registry.resolve(path);
        assert.equal(match.isPresent(), true, path);
        assert.equal(match.get().language.id, "compress", path);
    }
    assert.equal(registry.resolve("a.tar.gz").get().extension, ".tar.gz");
    const byMime = registry.resolve("blob.bin", "application/zip");
    assert.equal(byMime.isPresent(), true);
    assert.equal(byMime.get().language.id, "compress");
});
