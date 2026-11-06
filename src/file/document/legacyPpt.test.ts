import assert from "node:assert/strict";
import test from "node:test";
import { parsePpt } from "./legacyPpt.ts";
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

const SLIDE = 0x03ee;
const NOTES = 0x03f0;
const MAIN_MASTER = 0x03f8;
const DOCUMENT = 0x03e8;
const SLIDE_LIST_WITH_TEXT = 0x0ff0;
const SLIDE_PERSIST_ATOM = 0x03f3;
const TEXT_CHARS_ATOM = 0x0fa0;
const TEXT_BYTES_ATOM = 0x0fa8;

const pptRecord = (type: number, data: Uint8Array, container: boolean = false): Uint8Array => {
    const bytes = new Uint8Array(8 + data.length);
    writeUint16(bytes, 0, container ? 0x000f : 0x0000);
    writeUint16(bytes, 2, type);
    writeUint32(bytes, 4, data.length);
    bytes.set(data, 8);
    return bytes;
};

const pptContainer = (type: number, ...children: readonly Uint8Array[]): Uint8Array =>
    pptRecord(type, concat(...children), true);

const textChars = (text: string): Uint8Array => {
    const data = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) writeUint16(data, index * 2, text.charCodeAt(index));
    return pptRecord(TEXT_CHARS_ATOM, data);
};

/** Encodes a string as CP1252 bytes by truncating each UTF-16 unit; used for the 8-bit text atom. */
const textBytes = (text: string): Uint8Array => {
    const data = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) data[index] = text.charCodeAt(index) & 0xff;
    return pptRecord(TEXT_BYTES_ATOM, data);
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

const deckStream = (): Uint8Array => pptContainer(
    DOCUMENT,
    pptContainer(
        SLIDE_LIST_WITH_TEXT,
        pptRecord(SLIDE_PERSIST_ATOM, new Uint8Array(12)),
        textChars("Outline cache text"),
    ),
    pptContainer(
        SLIDE,
        textChars("Quarterly\rRevenue grew\r"),
        pptContainer(0x7ffe, textChars("Nested unknown container text")),
        textBytes("Café"),
    ),
    pptContainer(SLIDE, pptRecord(0x1234, new Uint8Array(4))),
    pptContainer(NOTES, textChars("Speaker notes must not appear")),
    pptContainer(MAIN_MASTER, textChars("Master text must not appear")),
    // Text may be several drawing/OfficeArt containers deep inside a slide.
    pptContainer(
        SLIDE,
        pptContainer(
            0x040c,
            pptContainer(
                0xf002,
                pptContainer(0xf003, pptContainer(0xf004, pptContainer(0xf00d, textBytes("Closing")))),
            ),
        ),
    ),
    pptContainer(0x7fff, textChars("Unknown container text")),
    // An embedded OLE/control storage is an unknown container with opaque bytes, not child records.
    pptContainer(0x0428, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00])),
);

const singleSlideDeck = (body: Uint8Array): Uint8Array => pptContainer(DOCUMENT, pptContainer(SLIDE, body));

const entryNames = (outline: ReturnType<typeof parsePpt>): readonly string[] =>
    outline.entries.map(entry => entry.name);

test("slides project in stream order with text atoms, while notes, masters and outline caches stay out", () => {
    const outline = parsePpt(buildCompoundFile("PowerPoint Document", deckStream()));
    assert.equal(outline.language, "powerpoint");
    assert.equal(outline.truncated, false);
    assert.deepEqual(entryNames(outline), ["Quarterly", "Closing"]);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["ppt:slide:1", "ppt:slide:3"]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "ppt:PowerPoint Document", slide: 1 },
        { part: "ppt:PowerPoint Document", slide: 3 },
    ]);
    assert.equal(outline.entries[0]!.kind, "slide");
    assert.equal(outline.entries[0]!.summary, "Quarterly\nRevenue grew\nCafé");
    assert.equal(outline.entries[1]!.summary, "Closing");
    assert.equal(outline.text, "Quarterly\nRevenue grew\nCafé\nClosing");
    assert.equal(outline.text.includes("Speaker notes"), false);
    assert.equal(outline.text.includes("Master text"), false);
    assert.equal(outline.text.includes("Outline cache"), false);
    assert.equal(outline.text.includes("Unknown container"), false);
    assert.equal(outline.text.includes("Nested unknown"), false);
    assert.equal(Object.hasOwn(outline.entries[0]!, "parentId"), false);
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
});

test("the PowerPoint Document stream name is matched case-insensitively", () => {
    const outline = parsePpt(buildCompoundFile("POWERPOINT DOCUMENT", singleSlideDeck(textChars("Case"))));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Case");
});

test("vertical tabs become line breaks and CR/LF runs collapse into paragraph breaks", () => {
    const outline = parsePpt(buildCompoundFile("PowerPoint Document", singleSlideDeck(
        textChars("Line one\x0BLine two\r\nSecond paragraph"),
    )));
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name, "Line one\nLine two");
    assert.equal(outline.entries[0]!.summary, "Line one\nLine two\nSecond paragraph");
});

test("titles are capped at 120 characters without marking the outline truncated", () => {
    const title = "T".repeat(180);
    const outline = parsePpt(buildCompoundFile("PowerPoint Document", singleSlideDeck(textChars(title))));
    assert.equal(outline.entries[0]!.name.length, 120);
    assert.equal(outline.entries[0]!.summary, title);
    assert.equal(outline.truncated, false);
});

test("whitespace-only slide text produces no entry but keeps the ordinal", () => {
    const stream = pptContainer(
        DOCUMENT,
        pptContainer(SLIDE, textChars("   \r\r")),
        pptContainer(SLIDE, textChars("Real")),
    );
    const outline = parsePpt(buildCompoundFile("PowerPoint Document", stream));
    assert.deepEqual(outline.entries.map(entry => entry.id), ["ppt:slide:2"]);
    assert.equal(outline.entries[0]!.locator.slide, 2);
});

test("maxEntriesInOutline and maxTextCharacters truncate without throwing", () => {
    const bytes = buildCompoundFile("PowerPoint Document", deckStream());
    const limited = parsePpt(bytes, { maxEntriesInOutline: 1 });
    assert.deepEqual(limited.entries.map(entry => entry.name), ["Quarterly"]);
    assert.equal(limited.text, "Quarterly\nRevenue grew\nCafé");
    assert.equal(limited.truncated, true);

    const clipped = parsePpt(bytes, { maxTextCharacters: 10 });
    assert.equal(clipped.entries.length, 1);
    assert.equal(clipped.entries[0]!.summary, "Quarterly\n");
    assert.equal(clipped.text, "Quarterly\n");
    assert.equal(clipped.truncated, true);
});

test("malformed records, non-compound input and a missing stream are invalid documents", () => {
    const truncatedHeader = pptContainer(DOCUMENT, pptContainer(SLIDE, textChars("Kept"))).slice(0, 10);
    assert.equal(
        errorOf(() => parsePpt(buildCompoundFile("PowerPoint Document", truncatedHeader))).code,
        "invalid_document",
    );

    const overlongRecord = new Uint8Array(8);
    writeUint16(overlongRecord, 0, 0x000f);
    writeUint16(overlongRecord, 2, DOCUMENT);
    writeUint32(overlongRecord, 4, 0x1000);
    assert.equal(
        errorOf(() => parsePpt(buildCompoundFile("PowerPoint Document", overlongRecord))).code,
        "invalid_document",
    );

    assert.equal(errorOf(() => parsePpt(new Uint8Array(64))).code, "invalid_document");
    assert.throws(() => parsePpt("not bytes" as unknown as Uint8Array), TypeError);
    assert.equal(
        errorOf(() => parsePpt(buildCompoundFile("Contents", new Uint8Array(16)))).code,
        "invalid_document",
    );
});

test("record count and nesting budgets raise limit_exceeded", () => {
    const bytes = buildCompoundFile("PowerPoint Document", deckStream());
    assert.equal(errorOf(() => parsePpt(bytes, { maxNodes: 1 })).code, "limit_exceeded");
    assert.equal(errorOf(() => parsePpt(bytes, { maxDepth: 1 })).code, "limit_exceeded");
});
