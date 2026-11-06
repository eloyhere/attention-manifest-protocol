import assert from "node:assert/strict";
import test from "node:test";
import { parseXls } from "./legacyXls.ts";
import { DocumentError } from "./types.ts";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const DIRECTORY_ENTRY_BYTES = 128;
const MINI_STREAM_CUTOFF = 4096;

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

interface DirectoryEntryFixture {
    readonly name: string;
    readonly type: number;
    readonly left: number;
    readonly right: number;
    readonly child: number;
    readonly start: number;
    readonly size: number;
}

const writeDirectoryEntry = (directory: Uint8Array, index: number, entry: DirectoryEntryFixture): void => {
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
    writeUint32(directory, offset + 0x74, entry.start);
    writeUint32(directory, offset + 0x78, entry.size);
};

/**
 * Minimal CFB v3 writer used only by these tests: a root entry plus one stream.
 * Streams of 4096 bytes or more live in regular FAT sectors; smaller streams are
 * stored in the root mini stream with a one-sector mini FAT.
 */
const buildCompoundFile = (streamName: string, stream: Uint8Array): Uint8Array => {
    const useMini = stream.length < MINI_STREAM_CUTOFF;
    const miniStream = useMini ? padTo(stream, MINI_SECTOR_BYTES) : new Uint8Array(0);
    const miniSectorCount = miniStream.length / MINI_SECTOR_BYTES;
    const miniFat = new Uint8Array(SECTOR_BYTES);
    miniFat.fill(0xff);
    if (useMini) {
        for (let index = 0; index < miniSectorCount; index += 1) {
            writeUint32(miniFat, index * 4, index + 1 < miniSectorCount ? index + 1 : ENDOFCHAIN);
        }
    }

    let nextSector = 0;
    const allocate = (byteLength: number): number => {
        const start = nextSector;
        nextSector += Math.ceil(byteLength / SECTOR_BYTES);
        return start;
    };
    const streamSector = useMini ? 0 : allocate(stream.length);
    const miniStreamSector = useMini ? allocate(miniStream.length) : ENDOFCHAIN;
    const miniFatSector = useMini ? allocate(SECTOR_BYTES) : ENDOFCHAIN;
    const directorySector = allocate(SECTOR_BYTES);
    const fatSector = allocate(SECTOR_BYTES);
    const totalSectors = nextSector;
    assert.ok(totalSectors <= SECTOR_BYTES / 4, "fixture FAT sector is too small");

    const fat = new Uint32Array(SECTOR_BYTES / 4);
    fat.fill(FREESECT);
    const writeChain = (start: number, count: number): void => {
        for (let index = 0; index < count; index += 1) {
            fat[start + index] = index + 1 < count ? start + index + 1 : ENDOFCHAIN;
        }
    };
    if (useMini) {
        writeChain(miniStreamSector, Math.ceil(miniStream.length / SECTOR_BYTES));
        writeChain(miniFatSector, 1);
    } else {
        writeChain(streamSector, Math.ceil(stream.length / SECTOR_BYTES));
    }
    writeChain(directorySector, 1);
    fat[fatSector] = FATSECT;

    const directory = new Uint8Array(SECTOR_BYTES);
    writeDirectoryEntry(directory, 0, {
        name: "Root Entry", type: 5, left: NOSTREAM, right: NOSTREAM, child: 1,
        start: useMini ? miniStreamSector : ENDOFCHAIN, size: useMini ? miniStream.length : 0,
    });
    writeDirectoryEntry(directory, 1, {
        name: streamName, type: 2, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM,
        start: streamSector, size: stream.length,
    });

    const bytes = new Uint8Array(SECTOR_BYTES + totalSectors * SECTOR_BYTES);
    bytes.set(SIGNATURE, 0);
    writeUint16(bytes, 0x18, 0x003e);
    writeUint16(bytes, 0x1a, 3);
    writeUint16(bytes, 0x1c, 0xfffe);
    writeUint16(bytes, 0x1e, 9);
    writeUint16(bytes, 0x20, 6);
    writeUint32(bytes, 0x2c, 1);
    writeUint32(bytes, 0x30, directorySector);
    writeUint32(bytes, 0x38, MINI_STREAM_CUTOFF);
    writeUint32(bytes, 0x3c, useMini ? miniFatSector : ENDOFCHAIN);
    writeUint32(bytes, 0x40, useMini ? 1 : 0);
    writeUint32(bytes, 0x44, ENDOFCHAIN);
    writeUint32(bytes, 0x48, 0);
    for (let index = 0; index < 109; index += 1) writeUint32(bytes, 0x4c + index * 4, FREESECT);
    writeUint32(bytes, 0x4c, fatSector);

    const writeSectors = (start: number, data: Uint8Array): void => {
        for (let offset = 0; offset < data.length; offset += SECTOR_BYTES) {
            const sector = start + offset / SECTOR_BYTES;
            const chunk = data.subarray(offset, Math.min(offset + SECTOR_BYTES, data.length));
            bytes.set(chunk, (sector + 1) * SECTOR_BYTES);
        }
    };
    if (useMini) {
        writeSectors(miniStreamSector, miniStream);
        writeSectors(miniFatSector, miniFat);
    } else {
        writeSectors(streamSector, stream);
    }
    writeSectors(directorySector, directory);
    const fatBytes = new Uint8Array(SECTOR_BYTES);
    for (let index = 0; index < fat.length; index += 1) writeUint32(fatBytes, index * 4, fat[index]!);
    writeSectors(fatSector, fatBytes);
    return bytes;
};

class ByteSink {
    private readonly values: number[] = [];

    u8(value: number): void {
        this.values.push(value & 0xff);
    }

    u16(value: number): void {
        this.u8(value);
        this.u8(value >>> 8);
    }

    u32(value: number): void {
        this.u16(value & 0xffff);
        this.u16((value >>> 16) & 0xffff);
    }

    bytes(values: Uint8Array | readonly number[]): void {
        for (const value of values) this.u8(value);
    }

    utf16(text: string): void {
        for (let index = 0; index < text.length; index += 1) this.u16(text.charCodeAt(index));
    }

    finish(): Uint8Array {
        return Uint8Array.from(this.values);
    }
}

const record = (id: number, data: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(4 + data.length);
    writeUint16(bytes, 0, id);
    writeUint16(bytes, 2, data.length);
    bytes.set(data, 4);
    return bytes;
};

const bof = (substream: number): Uint8Array => {
    const data = new Uint8Array(16);
    writeUint16(data, 0, 0x0600);
    writeUint16(data, 2, substream);
    return record(0x0809, data);
};

const eof = (): Uint8Array => record(0x000a, new Uint8Array(0));

const labelSst = (row: number, column: number, index: number): Uint8Array => {
    const data = new Uint8Array(10);
    writeUint16(data, 0, row);
    writeUint16(data, 2, column);
    writeUint32(data, 6, index);
    return record(0x00fd, data);
};

const label = (row: number, column: number, text: string, wide: boolean = true): Uint8Array => {
    const width = wide ? 2 : 1;
    const data = new Uint8Array(6 + 3 + text.length * width);
    writeUint16(data, 0, row);
    writeUint16(data, 2, column);
    writeUint16(data, 6, text.length);
    data[8] = wide ? 0x01 : 0x00;
    for (let index = 0; index < text.length; index += 1) {
        if (wide) writeUint16(data, 9 + index * 2, text.charCodeAt(index));
        else data[9 + index] = text.charCodeAt(index) & 0xff;
    }
    return record(0x0204, data);
};

const numberCell = (row: number, column: number, value: number): Uint8Array => {
    const data = new Uint8Array(14);
    writeUint16(data, 0, row);
    writeUint16(data, 2, column);
    new DataView(data.buffer).setFloat64(6, value, true);
    return record(0x0203, data);
};

const rkCell = (row: number, column: number, rk: number): Uint8Array => {
    const data = new Uint8Array(10);
    writeUint16(data, 0, row);
    writeUint16(data, 2, column);
    writeUint32(data, 6, rk);
    return record(0x027e, data);
};

const mulRk = (row: number, firstColumn: number, values: readonly number[]): Uint8Array => {
    const data = new Uint8Array(6 + values.length * 6);
    writeUint16(data, 0, row);
    writeUint16(data, 2, firstColumn);
    for (let index = 0; index < values.length; index += 1) {
        writeUint32(data, 6 + index * 6, values[index]!);
    }
    writeUint16(data, data.length - 2, firstColumn + values.length - 1);
    return record(0x00bd, data);
};

const formulaNumber = (row: number, column: number, value: number): Uint8Array => {
    const data = new Uint8Array(14);
    writeUint16(data, 0, row);
    writeUint16(data, 2, column);
    new DataView(data.buffer).setFloat64(6, value, true);
    return record(0x0006, data);
};

/** A FORMULA record whose cached result uses the 0xFFFF special-value marker. */
const formulaSpecial = (row: number, column: number, type: number, payload: number = 0): Uint8Array => {
    const data = new Uint8Array(14);
    writeUint16(data, 0, row);
    writeUint16(data, 2, column);
    data[6] = type;
    data[8] = payload;
    data[12] = 0xff;
    data[13] = 0xff;
    return record(0x0006, data);
};

const rkInteger = (value: number): number => ((value << 2) | 0x02) >>> 0;
const rkIntegerDiv100 = (value: number): number => ((value << 2) | 0x03) >>> 0;

const rkFloat = (value: number): number => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return ((bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24)) >>> 0);
};

const boundsheet = (offset: number, name: string, wide: boolean = true): Uint8Array => {
    const width = wide ? 2 : 1;
    const data = new Uint8Array(8 + name.length * width);
    writeUint32(data, 0, offset);
    writeUint16(data, 4, 0);
    data[6] = name.length;
    data[7] = wide ? 0x01 : 0x00;
    for (let index = 0; index < name.length; index += 1) {
        if (wide) writeUint16(data, 8 + index * 2, name.charCodeAt(index));
        else data[8 + index] = name.charCodeAt(index) & 0xff;
    }
    return record(0x0085, data);
};

const biff5Boundsheet = (name: string): Uint8Array => {
    const data = new Uint8Array(7 + name.length);
    writeUint16(data, 4, 0);
    data[6] = name.length;
    for (let index = 0; index < name.length; index += 1) data[7 + index] = name.charCodeAt(index);
    return record(0x0085, data);
};

interface SheetFixture {
    readonly name: string;
    readonly cells: readonly Uint8Array[];
    /** Encode the BOUNDSHEET name as 8-bit compressed text instead of UTF-16LE. */
    readonly wideName?: boolean;
}

const buildWorkbook = (sheets: readonly SheetFixture[], globals: readonly Uint8Array[]): Uint8Array => {
    const bodies = sheets.map(sheet => concat(bof(0x0010), ...sheet.cells, eof()));
    const globalsBof = bof(0x0005);
    const boundsheetBytes = sheets.reduce((total, sheet) => {
        const width = sheet.wideName === false ? 1 : 2;
        return total + 12 + sheet.name.length * width;
    }, 0);
    const globalsBytes = globals.reduce((total, part) => total + part.length, 0);
    let offset = globalsBof.length + boundsheetBytes + globalsBytes;
    const boundsheets: Uint8Array[] = [];
    for (let index = 0; index < sheets.length; index += 1) {
        const sheet = sheets[index]!;
        boundsheets.push(boundsheet(offset, sheet.name, sheet.wideName !== false));
        offset += bodies[index]!.length;
    }
    return concat(globalsBof, ...boundsheets, ...globals, ...bodies);
};

interface SstFixture {
    readonly records: readonly Uint8Array[];
    readonly strings: readonly string[];
}

/** SST whose long second string is split across a CONTINUE record, plus rich and extended strings. */
const buildSplitSst = (): SstFixture => {
    const longText = "L" + "Ω".repeat(1999);
    const prefixCharacters = 40;
    const sst = new ByteSink();
    sst.u32(4);
    sst.u32(4);
    // 8-bit compressed string.
    sst.u16(5);
    sst.u8(0x00);
    for (const character of "Alpha") sst.u8(character.charCodeAt(0));
    // UTF-16 string: header and the first 40 characters stay in the SST record.
    sst.u16(longText.length);
    sst.u8(0x01);
    for (let index = 0; index < prefixCharacters; index += 1) sst.u16(longText.charCodeAt(index));

    const continuation = new ByteSink();
    continuation.u8(0x01);
    for (let index = prefixCharacters; index < longText.length; index += 1) {
        continuation.u16(longText.charCodeAt(index));
    }
    // Rich string: one 4-byte run, skipped by the reader.
    continuation.u16(9);
    continuation.u8(0x08);
    continuation.u16(1);
    for (const character of "Rich Text") continuation.u8(character.charCodeAt(0));
    continuation.u32(0x00010002);
    // Extended string: six bytes of phonetic data, skipped by the reader.
    continuation.u16(8);
    continuation.u8(0x04);
    continuation.u32(6);
    for (const character of "Ext Text") continuation.u8(character.charCodeAt(0));
    continuation.bytes([1, 2, 3, 4, 5, 6]);

    return {
        records: [record(0x00fc, sst.finish()), record(0x003c, continuation.finish())],
        strings: ["Alpha", longText, "Rich Text", "Ext Text"],
    };
};

/** One SST record with 8-bit strings, no CONTINUE. */
const simpleSst = (values: readonly string[]): Uint8Array => {
    const sink = new ByteSink();
    sink.u32(values.length);
    sink.u32(values.length);
    for (const value of values) {
        sink.u16(value.length);
        sink.u8(0x00);
        for (const character of value) sink.u8(character.charCodeAt(0));
    }
    return record(0x00fc, sink.finish());
};

/** A single string whose first three characters are 8-bit and whose continuation switches to UTF-16. */
const mixedEncodingSst = (): readonly Uint8Array[] => {
    const sst = new ByteSink();
    sst.u32(1);
    sst.u32(1);
    sst.u16(6);
    sst.u8(0x00);
    for (const character of "abc") sst.u8(character.charCodeAt(0));
    const continuation = new ByteSink();
    continuation.u8(0x01);
    continuation.utf16("déf");
    return [record(0x00fc, sst.finish()), record(0x003c, continuation.finish())];
};

/** A rich string whose runs start in a CONTINUE, followed by the next string in that same CONTINUE. */
const richRunContinuationSst = (): readonly Uint8Array[] => {
    const sst = new ByteSink();
    sst.u32(2);
    sst.u32(2);
    sst.u16(4);
    sst.u8(0x08);
    sst.u16(2);
    for (const character of "Rich") sst.u8(character.charCodeAt(0));
    const continuation = new ByteSink();
    // The run array is a variable field, so the CONTINUE starts with fHighByte and then the runs.
    continuation.u8(0x00);
    continuation.u32(0x00000000);
    continuation.u32(0x00010002);
    continuation.u16(4);
    continuation.u8(0x00);
    for (const character of "Tail") continuation.u8(character.charCodeAt(0));
    return [record(0x00fc, sst.finish()), record(0x003c, continuation.finish())];
};

const dataSheet = (): SheetFixture => ({
    name: "Data",
    cells: [
        labelSst(0, 0, 0),
        label(0, 1, "Grüße"),
        numberCell(0, 2, 42.5),
        label(0, 26, "Column AA"),
        rkCell(1, 0, rkInteger(123)),
        rkCell(1, 1, rkIntegerDiv100(1234)),
        rkCell(1, 2, rkFloat(3.75)),
        mulRk(2, 0, [rkInteger(1), rkIntegerDiv100(250)]),
        formulaNumber(3, 0, 99.5),
        formulaSpecial(3, 1, 0),
        formulaSpecial(3, 2, 1, 1),
    ],
});

const secondSheet = (): SheetFixture => ({
    name: "Second",
    cells: [labelSst(0, 0, 1), labelSst(0, 1, 2), labelSst(0, 2, 3), label(1, 0, "Second")],
});

const mainWorkbook = (): { readonly bytes: Uint8Array; readonly sst: SstFixture } => {
    const sst = buildSplitSst();
    return { sst, bytes: buildWorkbook([dataSheet(), secondSheet()], sst.records) };
};

const errorOf = (operation: () => unknown): DocumentError => {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) return error;
        throw error;
    }
    assert.fail("expected a DocumentError");
};

const entryNamed = (outline: ReturnType<typeof parseXls>, name: string) => {
    const entry = outline.entries.find(candidate => candidate.name === name);
    assert.ok(entry !== undefined, `missing outline entry ${name}`);
    return entry;
};

test("BIFF8 sheets, shared strings, RK numbers and formula caches project in order", () => {
    const { bytes, sst } = mainWorkbook();
    assert.ok(bytes.length > MINI_STREAM_CUTOFF, "fixture Workbook must use regular FAT sectors");
    const outline = parseXls(buildCompoundFile("Workbook", bytes));
    assert.equal(outline.language, "excel");
    assert.equal(outline.truncated, false);

    const sheets = outline.entries.filter(entry => entry.kind === "sheet");
    assert.deepEqual(sheets.map(entry => entry.name), ["Data", "Second"]);
    assert.deepEqual(sheets.map(entry => entry.id), ["xls:sheet:1", "xls:sheet:2"]);
    assert.deepEqual(sheets.map(entry => entry.summary), ["4 rows, 11 cells", "2 rows, 4 cells"]);
    assert.deepEqual(sheets.map(entry => entry.locator), [
        { part: "xls:Workbook", sheet: "Data" },
        { part: "xls:Workbook", sheet: "Second" },
    ]);
    assert.equal(Object.hasOwn(sheets[0]!, "parentId"), false);

    // The first sheet is immediately followed by its cells.
    assert.deepEqual(outline.entries.slice(0, 5).map(entry => entry.name), [
        "Data", "Data!A1", "Data!B1", "Data!C1", "Data!AA1",
    ]);
    assert.deepEqual(outline.entries.slice(0, 5).map(entry => entry.kind), ["sheet", "cell", "cell", "cell", "cell"]);
    for (const cell of outline.entries.filter(entry => entry.kind === "cell")) {
        const sheet = entryNamed(outline, cell.locator.sheet!);
        assert.equal(cell.parentId, sheet.id);
        assert.equal(cell.locator.part, "xls:Workbook");
    }

    assert.equal(entryNamed(outline, "Data!A1").summary, "Alpha");
    assert.equal(entryNamed(outline, "Data!B1").summary, "Grüße");
    assert.equal(entryNamed(outline, "Data!C1").summary, "42.5");
    assert.equal(entryNamed(outline, "Data!AA1").summary, "Column AA");
    assert.equal(entryNamed(outline, "Data!A2").summary, "123");
    assert.equal(entryNamed(outline, "Data!B2").summary, "12.34");
    assert.equal(entryNamed(outline, "Data!C2").summary, "3.75");
    assert.equal(entryNamed(outline, "Data!A3").summary, "1");
    assert.equal(entryNamed(outline, "Data!B3").summary, "2.5");
    assert.equal(entryNamed(outline, "Data!A4").summary, "99.5");
    assert.equal(entryNamed(outline, "Data!C4").summary, "TRUE");
    assert.equal(outline.entries.some(entry => entry.name === "Data!B4"), false);

    assert.deepEqual(entryNamed(outline, "Data!AA1").locator, {
        part: "xls:Workbook", sheet: "Data", cell: "AA1",
    });
    assert.equal(entryNamed(outline, "Data!AA1").id, "xls:cell:1:AA1");

    // The SST long string crossed a CONTINUE and still decodes completely.
    const longText = sst.strings[1]!;
    assert.equal(longText.length, 2000);
    assert.equal(entryNamed(outline, "Second!A1").summary, longText);
    assert.equal(entryNamed(outline, "Second!B1").summary, "Rich Text");
    assert.equal(entryNamed(outline, "Second!C1").summary, "Ext Text");
    assert.equal(entryNamed(outline, "Second!A2").summary, "Second");

    assert.equal(outline.text, outline.entries.map(entry => entry.summary).join("\n"));
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
});

test("empty strings and out-of-range SST indexes produce no cell but still occupy a row", () => {
    const sst = simpleSst(["Only"]);
    const workbook = buildWorkbook([{
        name: "Data",
        cells: [
            labelSst(0, 0, 0),
            labelSst(1, 0, 5),
            label(2, 0, ""),
            label(3, 0, "   "),
            labelSst(4, 0, 0),
        ],
    }], [sst]);
    const outline = parseXls(buildCompoundFile("Workbook", workbook));
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Data", "Data!A1", "Data!A5"]);
    assert.equal(outline.entries[0]!.summary, "5 rows, 2 cells");
    assert.equal(outline.truncated, false);
});

test("the Workbook stream name is matched case-insensitively", () => {
    const workbook = buildWorkbook([{ name: "Data", cells: [labelSst(0, 0, 0)] }], [simpleSst(["Case"])]);
    const outline = parseXls(buildCompoundFile("WORKBOOK", workbook));
    assert.equal(entryNamed(outline, "Data!A1").summary, "Case");
});

test("8-bit compressed BOUNDSHEET names and LABEL strings decode as single-byte text", () => {
    const workbook = buildWorkbook(
        [{ name: "Old", wideName: false, cells: [label(0, 0, "Café", false)] }],
        [],
    );
    const outline = parseXls(buildCompoundFile("Workbook", workbook));
    assert.equal(outline.entries[0]!.name, "Old");
    assert.deepEqual(outline.entries[0]!.locator, { part: "xls:Workbook", sheet: "Old" });
    assert.equal(outline.entries[1]!.name, "Old!A1");
    assert.equal(outline.entries[1]!.summary, "Café");
});

test("SST CONTINUE may switch a string from 8-bit to UTF-16 characters", () => {
    const workbook = buildWorkbook([{ name: "Data", cells: [labelSst(0, 0, 0)] }], mixedEncodingSst());
    const outline = parseXls(buildCompoundFile("Workbook", workbook));
    assert.equal(entryNamed(outline, "Data!A1").summary, "abcdéf");
});

test("SST rich-text runs continued by a CONTINUE consume its option byte before the next string", () => {
    const workbook = buildWorkbook(
        [{ name: "Data", cells: [labelSst(0, 0, 0), labelSst(1, 0, 1)] }],
        richRunContinuationSst(),
    );
    const outline = parseXls(buildCompoundFile("Workbook", workbook));
    assert.equal(entryNamed(outline, "Data!A1").summary, "Rich");
    assert.equal(entryNamed(outline, "Data!A2").summary, "Tail");
    assert.equal(outline.truncated, false);
});

test("FILEPASS marks an encrypted or protected workbook as unsupported", () => {
    const workbook = buildWorkbook([], [record(0x002f, new Uint8Array(2))]);
    const error = errorOf(() => parseXls(buildCompoundFile("Workbook", workbook)));
    assert.equal(error.code, "unsupported_format");
});

test("a BIFF5 Book stream is refused with the sheet names in the message", () => {
    const book = concat(bof(0x0005), biff5Boundsheet("OldSheet"), eof());
    const error = errorOf(() => parseXls(buildCompoundFile("Book", book)));
    assert.equal(error.code, "unsupported_format");
    assert.match(error.message, /BIFF5/);
    assert.match(error.message, /OldSheet/);
});

test("a compound file without Workbook or Book is an invalid document", () => {
    assert.equal(
        errorOf(() => parseXls(buildCompoundFile("Contents", new Uint8Array(16)))).code,
        "invalid_document",
    );
});

test("non-compound bytes and broken record framing are invalid documents", () => {
    assert.equal(errorOf(() => parseXls(new Uint8Array(64))).code, "invalid_document");
    assert.throws(() => parseXls("not bytes" as unknown as Uint8Array), TypeError);

    const truncatedHeader = concat(bof(0x0005), Uint8Array.from([0x85, 0x08, 0x00]));
    assert.equal(
        errorOf(() => parseXls(buildCompoundFile("Workbook", truncatedHeader))).code,
        "invalid_document",
    );

    const overlongRecord = concat(bof(0x0005), Uint8Array.from([0x85, 0x08, 0x00, 0x10, 0x00, 0x00]));
    assert.equal(
        errorOf(() => parseXls(buildCompoundFile("Workbook", overlongRecord))).code,
        "invalid_document",
    );
});

test("zero padding after the last BIFF record is ignored", () => {
    const { bytes } = mainWorkbook();
    const padded = concat(bytes, Uint8Array.from([0, 0, 0]));
    const outline = parseXls(buildCompoundFile("Workbook", padded));
    const reference = parseXls(buildCompoundFile("Workbook", bytes));
    assert.deepEqual(outline.entries.map(entry => entry.id), reference.entries.map(entry => entry.id));
    assert.equal(outline.text, reference.text);
});

test("maxEntriesInOutline truncates the entry list without throwing", () => {
    const { bytes } = mainWorkbook();
    const outline = parseXls(buildCompoundFile("Workbook", bytes), { maxEntriesInOutline: 3 });
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Data", "Data!A1", "Data!B1"]);
    assert.equal(outline.text, "4 rows, 11 cells\nAlpha\nGrüße");
    assert.equal(outline.truncated, true);
});

test("maxTextCharacters clips summaries without throwing", () => {
    const { bytes } = mainWorkbook();
    const outline = parseXls(buildCompoundFile("Workbook", bytes), { maxTextCharacters: 10 });
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.summary, "4 rows, 11");
    assert.equal(outline.text, "4 rows, 11");
    assert.equal(outline.truncated, true);
});

test("at most 2000 cells per sheet are projected and the overflow truncates the outline", () => {
    const sst = simpleSst(["Only"]);
    const cells: Uint8Array[] = [];
    for (let row = 0; row < 2005; row += 1) cells.push(labelSst(row, 0, 0));
    const workbook = buildWorkbook([{ name: "Data", cells }], [sst]);
    const outline = parseXls(buildCompoundFile("Workbook", workbook));
    assert.equal(outline.entries.length, 2001);
    assert.equal(outline.entries[0]!.summary, "2005 rows, 2000 cells");
    assert.equal(outline.entries.at(-1)!.name, "Data!A2000");
    assert.equal(outline.truncated, true);
});

test("a cell value longer than 2000 characters is clamped", () => {
    const longText = "x".repeat(2500);
    const workbook = buildWorkbook([{ name: "Data", cells: [labelSst(0, 0, 0)] }], [simpleSst([longText])]);
    const outline = parseXls(buildCompoundFile("Workbook", workbook));
    assert.equal(outline.entries[1]!.summary.length, 2000);
    assert.equal(outline.entries[1]!.summary, longText.slice(0, 2000));
    assert.equal(outline.truncated, true);
});
