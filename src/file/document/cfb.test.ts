import assert from "node:assert/strict";
import test from "node:test";
import { cfbStream, readCfb } from "./cfb.ts";
import { DocumentError } from "./types.ts";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const MINI_SECTOR_BYTES = 64;
const DIRECTORY_ENTRY_BYTES = 128;
const SUMMARY_FMTID = Uint8Array.from([
    0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9,
]);

const writeUint16 = (bytes: Uint8Array, offset: number, value: number): void => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
};

const writeUint32 = (bytes: Uint8Array, offset: number, value: number): void => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
};

const writeUint64 = (bytes: Uint8Array, offset: number, value: bigint): void => {
    writeUint32(bytes, offset, Number(value & 0xffffffffn));
    writeUint32(bytes, offset + 4, Number((value >> 32n) & 0xffffffffn));
};

const uint32Bytes = (value: number): Uint8Array => {
    const bytes = new Uint8Array(4);
    writeUint32(bytes, 0, value);
    return bytes;
};

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
    let total = 0;
    for (const part of parts) total += part.length;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
};

const padTo = (bytes: Uint8Array, multiple: number): Uint8Array => {
    const remainder = bytes.length % multiple;
    if (remainder === 0) return bytes;
    const padded = new Uint8Array(bytes.length + multiple - remainder);
    padded.set(bytes);
    return padded;
};

const makeBytes = (length: number, seed: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + seed) & 0xff;
    return bytes;
};

const filetimeOf = (iso: string): bigint => {
    const milliseconds = Date.parse(iso);
    assert.equal(Number.isNaN(milliseconds), false, `invalid fixture date ${iso}`);
    return (BigInt(milliseconds) + 11_644_473_600_000n) * 10_000n;
};

interface PropertyValue {
    readonly id: number;
    readonly data: Uint8Array;
}

/** VT_LPSTR: 2-byte type, 2-byte padding, u32 byte length (including NUL), characters, NUL. */
const textProperty = (id: number, text: string): PropertyValue => {
    const characters = new TextEncoder().encode(text);
    const data = new Uint8Array(8 + characters.length + 1);
    writeUint16(data, 0, 30);
    writeUint32(data, 4, characters.length + 1);
    data.set(characters, 8);
    return { id, data };
};

/** VT_LPWSTR: 2-byte type, 2-byte padding, u32 character count (including NUL), UTF-16LE units. */
const wideTextProperty = (id: number, text: string): PropertyValue => {
    const data = new Uint8Array(8 + (text.length + 1) * 2);
    writeUint16(data, 0, 31);
    writeUint32(data, 4, text.length + 1);
    for (let index = 0; index < text.length; index += 1) {
        writeUint16(data, 8 + index * 2, text.charCodeAt(index));
    }
    return { id, data };
};

/** VT_FILETIME: 2-byte type, 2-byte padding, u64 FILETIME. */
const filetimeProperty = (id: number, iso: string): PropertyValue => {
    const data = new Uint8Array(12);
    writeUint16(data, 0, 64);
    writeUint64(data, 4, filetimeOf(iso));
    return { id, data };
};

/** VT_I4: 2-byte type, 2-byte padding, i32. */
const integerProperty = (id: number, value: number): PropertyValue => {
    const data = new Uint8Array(8);
    writeUint16(data, 0, 3);
    writeUint32(data, 4, value);
    return { id, data };
};

/** Minimal MS-OLEPS property-set stream with a single SummaryInformation section. */
const buildPropertyStream = (properties: readonly PropertyValue[]): Uint8Array => {
    const values: readonly PropertyValue[] = Object.freeze([
        { id: 1, data: (() => {
            const codePage = new Uint8Array(8);
            writeUint16(codePage, 0, 2);
            writeUint16(codePage, 4, 65001);
            return codePage;
        })() },
        ...properties,
    ]);
    const descriptors = new Uint8Array(values.length * 8);
    const region: Uint8Array[] = [];
    let relative = 8 + values.length * 8;
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index]!;
        writeUint32(descriptors, index * 8, value.id);
        writeUint32(descriptors, index * 8 + 4, relative);
        const padded = padTo(value.data, 4);
        region.push(padded);
        relative += padded.length;
    }
    const valuesBytes = concat(...region);
    const section = concat(
        uint32Bytes(8 + descriptors.length + valuesBytes.length),
        uint32Bytes(values.length),
        descriptors,
        valuesBytes,
    );
    const header = new Uint8Array(48);
    writeUint16(header, 0, 0xfffe);
    writeUint16(header, 2, 0);
    writeUint32(header, 4, 0);
    header.set(SUMMARY_FMTID, 8);
    writeUint32(header, 24, 1);
    header.set(SUMMARY_FMTID, 28);
    writeUint32(header, 44, 48);
    return concat(header, section);
};

interface FixtureEntry {
    readonly name: string;
    readonly type: number;
    readonly left: number;
    readonly right: number;
    readonly child: number;
    readonly clsid: Uint8Array;
    readonly start: number;
    readonly size: number;
    readonly created?: bigint;
    readonly modified?: bigint;
}

const writeDirectoryEntry = (directory: Uint8Array, index: number, entry: FixtureEntry): void => {
    const offset = index * DIRECTORY_ENTRY_BYTES;
    for (let position = 0; position < entry.name.length; position += 1) {
        writeUint16(directory, offset + position * 2, entry.name.charCodeAt(position));
    }
    writeUint16(directory, offset + 0x40, (entry.name.length + 1) * 2);
    directory[offset + 0x42] = entry.type;
    directory[offset + 0x43] = 1;
    writeUint32(directory, offset + 0x44, entry.left);
    writeUint32(directory, offset + 0x48, entry.right);
    writeUint32(directory, offset + 0x4c, entry.child);
    directory.set(entry.clsid, offset + 0x50);
    writeUint32(directory, offset + 0x60, 0);
    writeUint64(directory, offset + 0x64, entry.created ?? 0n);
    writeUint64(directory, offset + 0x6c, entry.modified ?? 0n);
    writeUint32(directory, offset + 0x74, entry.start);
    writeUint64(directory, offset + 0x78, BigInt(entry.size));
};

interface Fixture {
    readonly bytes: Uint8Array;
    readonly sectorSize: number;
    readonly fatSector: number;
    readonly directoryStart: number;
    readonly miniFatStart: number;
    readonly bigStart: number;
    readonly big: Uint8Array;
    readonly small: Uint8Array;
    readonly summary: Uint8Array;
}

interface FixtureOptions {
    readonly majorVersion?: 3 | 4;
    readonly summary?: Uint8Array;
    readonly summaryName?: string;
}

/**
 * Minimal CFB v3/v4 writer used only by these tests.
 *
 * The container holds one storage (`Data`) with two streams (`Big` at or above
 * the mini-stream cutoff, `Small` below it) plus a root-level
 * `\u0005SummaryInformation` property stream. The root entry points at a mini
 * stream whose chains live in a one-sector mini FAT; the directory itself is an
 * ordinary FAT chain and the FAT is listed entirely in the header DIFAT.
 *
 * The sibling trees are deliberately simple right-leaning binary search trees
 * (small fixture, valid ordering, reader never inspects red-black colors).
 */
const buildFixture = (options: FixtureOptions = {}): Fixture => {
    const majorVersion = options.majorVersion ?? 3;
    const sectorSize = majorVersion === 3 ? 512 : 4096;
    const big = makeBytes(5000, 11);
    const small = makeBytes(100, 7);
    const summary = options.summary ?? buildPropertyStream([
        textProperty(2, "  Fixture Title  "),
        textProperty(4, "Ada Lovelace"),
        textProperty(15, "Analytical Engines"),
        textProperty(5, "   "),
    ]);
    const summaryName = options.summaryName ?? "\u0005SummaryInformation";

    const smallPadded = padTo(small, MINI_SECTOR_BYTES);
    const summaryPadded = padTo(summary, MINI_SECTOR_BYTES);
    const miniStream = concat(smallPadded, summaryPadded);
    const smallMiniSectors = smallPadded.length / MINI_SECTOR_BYTES;
    const summaryMiniStart = smallMiniSectors;
    const summaryMiniSectors = summaryPadded.length / MINI_SECTOR_BYTES;
    const miniFatValues: number[] = [];
    for (let index = 0; index < smallMiniSectors; index += 1) {
        miniFatValues.push(index + 1 < smallMiniSectors ? index + 1 : ENDOFCHAIN);
    }
    for (let index = 0; index < summaryMiniSectors; index += 1) {
        const miniSector = summaryMiniStart + index;
        miniFatValues.push(index + 1 < summaryMiniSectors ? miniSector + 1 : ENDOFCHAIN);
    }
    const miniFatData = new Uint8Array(sectorSize);
    miniFatData.fill(0xff);
    for (let index = 0; index < miniFatValues.length; index += 1) {
        writeUint32(miniFatData, index * 4, miniFatValues[index]!);
    }

    const directorySectorCount = Math.ceil(5 / (sectorSize / DIRECTORY_ENTRY_BYTES));
    let nextSector = 0;
    const allocate = (byteLength: number): number => {
        const start = nextSector;
        nextSector += Math.ceil(byteLength / sectorSize);
        return start;
    };
    const bigStart = allocate(big.length);
    const rootMiniStart = allocate(miniStream.length);
    const miniFatStart = allocate(miniFatData.length);
    const directoryStart = allocate(directorySectorCount * sectorSize);
    const fatSector = allocate(sectorSize);
    const totalSectors = nextSector;
    assert.ok(totalSectors <= sectorSize / 4, "fixture FAT sector is too small");

    const fat = new Uint32Array(sectorSize / 4);
    fat.fill(FREESECT);
    const writeChain = (start: number, count: number): void => {
        for (let index = 0; index < count; index += 1) {
            fat[start + index] = index + 1 < count ? start + index + 1 : ENDOFCHAIN;
        }
    };
    writeChain(bigStart, Math.ceil(big.length / sectorSize));
    writeChain(rootMiniStart, Math.ceil(miniStream.length / sectorSize));
    writeChain(miniFatStart, 1);
    writeChain(directoryStart, directorySectorCount);
    fat[fatSector] = FATSECT;

    const directory = new Uint8Array(directorySectorCount * sectorSize);
    const zeroClsid = new Uint8Array(16);
    const dataTime = filetimeOf("2020-01-02T03:04:05.000Z");
    writeDirectoryEntry(directory, 0, {
        name: "Root Entry", type: 5, left: NOSTREAM, right: NOSTREAM, child: 4, clsid: zeroClsid,
        start: rootMiniStart, size: miniStream.length,
    });
    writeDirectoryEntry(directory, 1, {
        name: "Data", type: 1, left: NOSTREAM, right: NOSTREAM, child: 2, clsid: SUMMARY_FMTID,
        start: 0, size: 0, created: dataTime, modified: dataTime,
    });
    writeDirectoryEntry(directory, 2, {
        name: "Big", type: 2, left: NOSTREAM, right: 3, child: NOSTREAM, clsid: zeroClsid,
        start: bigStart, size: big.length,
    });
    writeDirectoryEntry(directory, 3, {
        name: "Small", type: 2, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, clsid: zeroClsid,
        start: 0, size: small.length,
    });
    writeDirectoryEntry(directory, 4, {
        name: summaryName, type: 2, left: NOSTREAM, right: 1, child: NOSTREAM,
        clsid: zeroClsid, start: summaryMiniStart, size: summary.length,
    });

    const bytes = new Uint8Array(sectorSize + totalSectors * sectorSize);
    bytes.set(SIGNATURE, 0);
    writeUint16(bytes, 0x18, 0x003e);
    writeUint16(bytes, 0x1a, majorVersion);
    writeUint16(bytes, 0x1c, 0xfffe);
    writeUint16(bytes, 0x1e, majorVersion === 3 ? 9 : 12);
    writeUint16(bytes, 0x20, 6);
    writeUint32(bytes, 0x28, majorVersion === 4 ? directorySectorCount : 0);
    writeUint32(bytes, 0x2c, 1);
    writeUint32(bytes, 0x30, directoryStart);
    writeUint32(bytes, 0x34, 0);
    writeUint32(bytes, 0x38, 4096);
    writeUint32(bytes, 0x3c, miniFatStart);
    writeUint32(bytes, 0x40, 1);
    writeUint32(bytes, 0x44, ENDOFCHAIN);
    writeUint32(bytes, 0x48, 0);
    for (let index = 0; index < 109; index += 1) writeUint32(bytes, 0x4c + index * 4, FREESECT);
    writeUint32(bytes, 0x4c, fatSector);

    const writeSectors = (start: number, data: Uint8Array): void => {
        for (let offset = 0; offset < data.length; offset += sectorSize) {
            const sector = start + offset / sectorSize;
            const chunk = data.subarray(offset, Math.min(offset + sectorSize, data.length));
            bytes.set(chunk, (sector + 1) * sectorSize);
        }
    };
    writeSectors(bigStart, big);
    writeSectors(rootMiniStart, miniStream);
    writeSectors(miniFatStart, miniFatData);
    writeSectors(directoryStart, directory);
    const fatBytes = new Uint8Array(sectorSize);
    for (let index = 0; index < fat.length; index += 1) writeUint32(fatBytes, index * 4, fat[index]!);
    writeSectors(fatSector, fatBytes);

    return { bytes, sectorSize, fatSector, directoryStart, miniFatStart, bigStart, big, small, summary };
};

const errorCode = (operation: () => unknown): string => {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error.code;
        throw error;
    }
    assert.fail("expected a DocumentError");
};

const copyFixture = (fixture: Fixture): Uint8Array => fixture.bytes.slice();

test("entries follow DFS order with paths, parent paths, kinds, sizes and CLSIDs", () => {
    const fixture = buildFixture();
    const file = readCfb(fixture.bytes);
    assert.equal(file.majorVersion, 3);
    assert.equal(file.sectorSize, 512);
    assert.deepEqual(file.entries.map(entry => entry.path), [
        "Root",
        "Root/\u0005SummaryInformation",
        "Root/Data",
        "Root/Data/Big",
        "Root/Data/Small",
    ]);
    assert.deepEqual(file.entries.map(entry => entry.kind), ["root", "stream", "storage", "stream", "stream"]);
    assert.deepEqual(file.entries.map(entry => entry.parentPath), [
        undefined, "Root", "Root", "Root/Data", "Root/Data",
    ]);
    assert.deepEqual(file.entries.map(entry => entry.size), [0, fixture.summary.length, 0, 5000, 100]);
    assert.equal(file.entries[0]!.name, "Root Entry");
    assert.equal(file.entries[2]!.name, "Data");
    assert.equal(file.entries[3]!.name, "Big");
    assert.equal(file.entries[4]!.name, "Small");
    assert.equal(file.entries[0]!.clsid, "00000000-0000-0000-0000-000000000000");
    assert.equal(file.entries[2]!.clsid, "f29f85e0-4ff9-1068-ab91-08002b27b3d9");
    assert.equal(file.entries[1]!.createdAt, undefined);
    assert.equal(file.entries[2]!.createdAt, "2020-01-02T03:04:05.000Z");
    assert.equal(file.entries[2]!.modifiedAt, "2020-01-02T03:04:05.000Z");
    assert.equal(Object.hasOwn(file.entries[0]!, "createdAt"), false);
    assert.equal(Object.hasOwn(file.entries[3]!, "createdAt"), false);
});

test("cfbStream returns the complete bytes of large and mini streams", () => {
    const fixture = buildFixture();
    const file = readCfb(fixture.bytes);
    const big = cfbStream(file, "Root/Data/Big");
    assert.equal(big.isPresent(), true);
    assert.deepEqual(big.get(), fixture.big);
    const small = cfbStream(file, "Root/Data/Small");
    assert.equal(small.isPresent(), true);
    assert.deepEqual(small.get(), fixture.small);
    const summary = cfbStream(file, "Root/\u0005SummaryInformation");
    assert.equal(summary.isPresent(), true);
    assert.deepEqual(summary.get(), fixture.summary);
    assert.equal(cfbStream(file, "Root/Data").isEmpty(), true);
    assert.equal(cfbStream(file, "Root/Data/Missing").isEmpty(), true);
    assert.equal(cfbStream(file, "Data/Big").isEmpty(), true);
});

test("summary properties are decoded, trimmed, string-only and frozen", () => {
    const fixture = buildFixture();
    const file = readCfb(fixture.bytes);
    assert.deepEqual(Object.keys(file.properties).sort(), ["Author", "Company", "Title"]);
    assert.equal(file.properties.Title, "Fixture Title");
    assert.equal(file.properties.Author, "Ada Lovelace");
    assert.equal(file.properties.Company, "Analytical Engines");
    assert.equal("Keywords" in file.properties, false);
    assert.equal(Object.isFrozen(file), true);
    assert.equal(Object.isFrozen(file.entries), true);
    assert.equal(Object.isFrozen(file.properties), true);
    for (const entry of file.entries) assert.equal(Object.isFrozen(entry), true);
});

test("LPWSTR and FILETIME properties decode while numeric values are skipped", () => {
    const summary = buildPropertyStream([
        textProperty(2, "Unicode Title"),
        wideTextProperty(3, "Grüße ✓"),
        filetimeProperty(12, "2021-05-06T07:08:09.000Z"),
        integerProperty(4, 42),
    ]);
    const file = readCfb(buildFixture({ summary }).bytes);
    assert.equal(file.properties.Title, "Unicode Title");
    assert.equal(file.properties.Subject, "Grüße ✓");
    assert.equal(file.properties.CreateTime, "2021-05-06T07:08:09.000Z");
    assert.equal("Author" in file.properties, false);
});

test("DocumentSummaryInformation properties use their own id map", () => {
    const summary = buildPropertyStream([
        textProperty(2, "Parts"),
        textProperty(14, "Grace Hopper"),
        textProperty(15, "Compilers Inc"),
        integerProperty(4, 1234),
    ]);
    const file = readCfb(buildFixture({ summaryName: "\u0005DocumentSummaryInformation", summary }).bytes);
    assert.equal(file.properties.Category, "Parts");
    assert.equal(file.properties.Manager, "Grace Hopper");
    assert.equal(file.properties.Company, "Compilers Inc");
    assert.equal("ByteCount" in file.properties, false);
    assert.equal("Title" in file.properties, false);
});

test("a version 4 container uses 4096-byte sectors and the same hierarchy", () => {
    const fixture = buildFixture({ majorVersion: 4 });
    const file = readCfb(fixture.bytes);
    assert.equal(file.majorVersion, 4);
    assert.equal(file.sectorSize, 4096);
    assert.deepEqual(file.entries.map(entry => entry.path), [
        "Root",
        "Root/\u0005SummaryInformation",
        "Root/Data",
        "Root/Data/Big",
        "Root/Data/Small",
    ]);
    assert.deepEqual(cfbStream(file, "Root/Data/Big").get(), fixture.big);
    assert.deepEqual(cfbStream(file, "Root/Data/Small").get(), fixture.small);
    assert.equal(file.properties.Title, "Fixture Title");
    assert.equal(Object.isFrozen(file), true);
});

test("a header with no directory sectors is an empty container", () => {
    const bytes = new Uint8Array(512);
    bytes.set(SIGNATURE);
    writeUint16(bytes, 0x18, 0x003e);
    writeUint16(bytes, 0x1a, 3);
    writeUint16(bytes, 0x1c, 0xfffe);
    writeUint16(bytes, 0x1e, 9);
    writeUint16(bytes, 0x20, 6);
    writeUint32(bytes, 0x2c, 0);
    writeUint32(bytes, 0x30, ENDOFCHAIN);
    writeUint32(bytes, 0x38, 4096);
    writeUint32(bytes, 0x3c, ENDOFCHAIN);
    writeUint32(bytes, 0x40, 0);
    writeUint32(bytes, 0x44, ENDOFCHAIN);
    writeUint32(bytes, 0x48, 0);
    for (let index = 0; index < 109; index += 1) writeUint32(bytes, 0x4c + index * 4, FREESECT);
    const file = readCfb(bytes);
    assert.deepEqual(file.entries, []);
    assert.deepEqual(file.properties, {});
    assert.equal(cfbStream(file, "Root/Anything").isEmpty(), true);
});

test("advisory header fields and zero-filled DIFAT padding are tolerated", () => {
    const fixture = buildFixture();
    const bytes = copyFixture(fixture);
    // v3 producers sometimes fill numDirectorySectors even though v3 defines it as zero.
    writeUint32(bytes, 0x28, 2);
    // Unused DIFAT slots should be FREESECT; accept zero-filled padding instead.
    for (let index = 1; index < 109; index += 1) writeUint32(bytes, 0x4c + index * 4, 0);
    const file = readCfb(bytes);
    assert.deepEqual(file.entries.map(entry => entry.name), [
        "Root Entry", "\u0005SummaryInformation", "Data", "Big", "Small",
    ]);
    assert.equal(file.properties.Title, "Fixture Title");
});

test("zero-filled directory links behave like NOSTREAM for the root sentinel", () => {
    const fixture = buildFixture();
    const bytes = copyFixture(fixture);
    const entryOffset = (index: number): number =>
        (fixture.directoryStart + 1) * fixture.sectorSize + index * DIRECTORY_ENTRY_BYTES;
    writeUint32(bytes, entryOffset(1) + 0x44, 0);
    writeUint32(bytes, entryOffset(1) + 0x48, 0);
    writeUint32(bytes, entryOffset(2) + 0x44, 0);
    writeUint32(bytes, entryOffset(3) + 0x44, 0);
    writeUint32(bytes, entryOffset(3) + 0x48, 0);
    writeUint32(bytes, entryOffset(4) + 0x44, 0);
    const file = readCfb(bytes);
    assert.deepEqual(file.entries.map(entry => entry.name), [
        "Root Entry", "\u0005SummaryInformation", "Data", "Big", "Small",
    ]);
    assert.deepEqual(cfbStream(file, "Root/Data/Big").get(), fixture.big);
});

test("bad signatures, byte order and headers are invalid_document", () => {
    const fixture = buildFixture();
    const badSignature = copyFixture(fixture);
    badSignature[0] = 0;
    assert.equal(errorCode(() => readCfb(badSignature)), "invalid_document");
    const badByteOrder = copyFixture(fixture);
    writeUint16(badByteOrder, 0x1c, 0xfeff);
    assert.equal(errorCode(() => readCfb(badByteOrder)), "invalid_document");
    assert.equal(errorCode(() => readCfb(new Uint8Array(0))), "invalid_document");
    assert.equal(errorCode(() => readCfb(fixture.bytes.slice(0, 256))), "invalid_document");
    assert.throws(() => readCfb("not bytes" as unknown as Uint8Array), TypeError);
});

test("sectors outside the container are invalid_document", () => {
    const fixture = buildFixture();
    const badDirectory = copyFixture(fixture);
    writeUint32(badDirectory, 0x30, 0x7ffffff0);
    assert.equal(errorCode(() => readCfb(badDirectory)), "invalid_document");
    const badStream = copyFixture(fixture);
    const fatEntry = (fixture.fatSector + 1) * fixture.sectorSize + fixture.bigStart * 4;
    writeUint32(badStream, fatEntry, 0x7ffffff0);
    assert.equal(errorCode(() => readCfb(badStream)), "invalid_document");
});

test("cyclic FAT, directory and mini-FAT chains are rejected", () => {
    const fixture = buildFixture();
    const cyclicStream = copyFixture(fixture);
    const streamFatEntry = (fixture.fatSector + 1) * fixture.sectorSize + fixture.bigStart * 4;
    writeUint32(cyclicStream, streamFatEntry, fixture.bigStart);
    assert.equal(errorCode(() => readCfb(cyclicStream)), "invalid_document");

    const cyclicDirectory = copyFixture(fixture);
    const directoryFatEntry = (fixture.fatSector + 1) * fixture.sectorSize + fixture.directoryStart * 4;
    writeUint32(cyclicDirectory, directoryFatEntry, fixture.directoryStart);
    assert.equal(errorCode(() => readCfb(cyclicDirectory)), "invalid_document");

    const cyclicMiniFat = copyFixture(fixture);
    const miniFatEntry = (fixture.miniFatStart + 1) * fixture.sectorSize;
    writeUint32(cyclicMiniFat, miniFatEntry, 0);
    assert.equal(errorCode(() => readCfb(cyclicMiniFat)), "invalid_document");
});

test("out-of-range mini sectors are invalid_document", () => {
    const fixture = buildFixture();
    const bytes = copyFixture(fixture);
    const smallEntryOffset = (fixture.directoryStart + 1) * fixture.sectorSize + 3 * DIRECTORY_ENTRY_BYTES;
    writeUint32(bytes, smallEntryOffset + 0x74, 1000);
    assert.equal(errorCode(() => readCfb(bytes)), "invalid_document");
});

test("entry, stream, total and chain budgets raise limit_exceeded", () => {
    const fixture = buildFixture();
    assert.equal(errorCode(() => readCfb(fixture.bytes, { maxEntryBytes: 256 })), "limit_exceeded");
    assert.equal(errorCode(() => readCfb(fixture.bytes, { maxTotalBytes: 5000 })), "limit_exceeded");
    assert.equal(errorCode(() => readCfb(fixture.bytes, { maxNodes: 1 })), "limit_exceeded");
    assert.equal(errorCode(() => readCfb(fixture.bytes, { maxDepth: 1 })), "limit_exceeded");
    assert.equal(readCfb(fixture.bytes, { maxEntryBytes: 5000 }).entries.length, 5);
});

test("the directory-entry budget is enforced", () => {
    const fixture = buildFixture();
    assert.equal(errorCode(() => readCfb(fixture.bytes, { maxEntriesInOutline: 4 })), "limit_exceeded");
    assert.equal(readCfb(fixture.bytes, { maxEntriesInOutline: 5 }).entries.length, 5);
});
