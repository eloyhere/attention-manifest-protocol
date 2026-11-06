import assert from "node:assert/strict";
import test from "node:test";
import { parseDoc } from "./legacyDoc.ts";
import { DocumentError } from "./types.ts";

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const SECTOR_SIZE = 512;
const DIRECTORY_ENTRY_BYTES = 128;
const MINI_STREAM_CUTOFF = 4096;
const WORD_IDENT = 0xa5ec;
const NFIB_WORD97 = 0x00c1;
const FC_CLX_PAIR_OFFSET = 0x01a2;
const COMPRESSED_FLAG = 0x40000000;
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

const uint16Bytes = (value: number): Uint8Array => {
    const bytes = new Uint8Array(2);
    writeUint16(bytes, 0, value);
    return bytes;
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

const padToMultiple = (bytes: Uint8Array, multiple: number): Uint8Array => {
    const remainder = bytes.length % multiple;
    if (remainder === 0) return bytes;
    const padded = new Uint8Array(bytes.length + multiple - remainder);
    padded.set(bytes);
    return padded;
};

/* -------------------------------------------------------------------------- */
/* Minimal CFB writer (one FAT sector, all streams kept above the mini cutoff) */
/* -------------------------------------------------------------------------- */

interface CfbStream {
    readonly name: string;
    readonly data: Uint8Array;
}

interface DirectoryEntrySpec {
    readonly name: string;
    readonly type: number;
    readonly left: number;
    readonly right: number;
    readonly child: number;
    readonly start: number;
    readonly size: number;
}

const writeDirectoryEntry = (directory: Uint8Array, index: number, entry: DirectoryEntrySpec): void => {
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
    writeUint32(directory, offset + 0x7c, 0);
};

/**
 * Writes a minimal version 3 compound file whose streams are all padded to at
 * least 4096 bytes, so every stream is read through a regular FAT chain and no
 * mini stream is needed. The directory is a right-leaning sibling chain.
 */
const buildCfb = (streams: readonly CfbStream[]): Uint8Array => {
    const padded = streams.map(stream => {
        const length = Math.max(MINI_STREAM_CUTOFF, Math.ceil(stream.data.length / SECTOR_SIZE) * SECTOR_SIZE);
        const bytes = new Uint8Array(length);
        bytes.set(stream.data);
        return bytes;
    });
    let nextSector = 0;
    const starts: number[] = [];
    for (const stream of padded) {
        starts.push(nextSector);
        nextSector += stream.length / SECTOR_SIZE;
    }
    const directorySectors = Math.ceil(((streams.length + 1) * DIRECTORY_ENTRY_BYTES) / SECTOR_SIZE);
    const directoryStart = nextSector;
    nextSector += directorySectors;
    const fatStart = nextSector;
    nextSector += 1;
    const totalSectors = nextSector;
    assert.ok(totalSectors <= SECTOR_SIZE / 4, "fixture must fit in a single FAT sector");

    const fat = new Uint32Array(SECTOR_SIZE / 4);
    fat.fill(FREESECT);
    const writeChain = (start: number, sectorCount: number): void => {
        for (let index = 0; index < sectorCount; index += 1) {
            fat[start + index] = index + 1 < sectorCount ? start + index + 1 : ENDOFCHAIN;
        }
    };
    for (let index = 0; index < padded.length; index += 1) {
        writeChain(starts[index]!, padded[index]!.length / SECTOR_SIZE);
    }
    writeChain(directoryStart, directorySectors);
    fat[fatStart] = FATSECT;

    const directory = new Uint8Array(directorySectors * SECTOR_SIZE);
    writeDirectoryEntry(directory, 0, {
        name: "Root Entry", type: 5, left: NOSTREAM, right: NOSTREAM,
        child: streams.length > 0 ? 1 : NOSTREAM, start: 0, size: 0,
    });
    for (let index = 0; index < streams.length; index += 1) {
        writeDirectoryEntry(directory, index + 1, {
            name: streams[index]!.name,
            type: 2,
            left: NOSTREAM,
            right: index + 1 < streams.length ? index + 2 : NOSTREAM,
            child: NOSTREAM,
            start: starts[index]!,
            size: padded[index]!.length,
        });
    }

    const bytes = new Uint8Array(SECTOR_SIZE + totalSectors * SECTOR_SIZE);
    bytes.set(SIGNATURE, 0);
    writeUint16(bytes, 0x18, 0x003e);
    writeUint16(bytes, 0x1a, 3);
    writeUint16(bytes, 0x1c, 0xfffe);
    writeUint16(bytes, 0x1e, 9);
    writeUint16(bytes, 0x20, 6);
    writeUint32(bytes, 0x28, 0);
    writeUint32(bytes, 0x2c, 1);
    writeUint32(bytes, 0x30, directoryStart);
    writeUint32(bytes, 0x38, MINI_STREAM_CUTOFF);
    writeUint32(bytes, 0x3c, ENDOFCHAIN);
    writeUint32(bytes, 0x40, 0);
    writeUint32(bytes, 0x44, ENDOFCHAIN);
    writeUint32(bytes, 0x48, 0);
    for (let index = 0; index < 109; index += 1) writeUint32(bytes, 0x4c + index * 4, FREESECT);
    writeUint32(bytes, 0x4c, fatStart);

    const writeSectors = (start: number, data: Uint8Array): void => {
        for (let offset = 0; offset < data.length; offset += SECTOR_SIZE) {
            bytes.set(data.subarray(offset, offset + SECTOR_SIZE), (start + offset / SECTOR_SIZE + 1) * SECTOR_SIZE);
        }
    };
    for (let index = 0; index < padded.length; index += 1) writeSectors(starts[index]!, padded[index]!);
    writeSectors(directoryStart, directory);
    const fatBytes = new Uint8Array(SECTOR_SIZE);
    for (let index = 0; index < fat.length; index += 1) writeUint32(fatBytes, index * 4, fat[index]!);
    writeSectors(fatStart, fatBytes);
    return bytes;
};

/* -------------------------------------------------------------------------- */
/* Property set writer (SummaryInformation with a Title)                       */
/* -------------------------------------------------------------------------- */

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

const buildTitlePropertyStream = (title: string): Uint8Array => {
    const codePage = new Uint8Array(8);
    writeUint16(codePage, 0, 2);
    writeUint16(codePage, 4, 65001);
    const values: readonly PropertyValue[] = [
        { id: 1, data: codePage },
        textProperty(2, title),
    ];
    const descriptors = new Uint8Array(values.length * 8);
    const chunks: Uint8Array[] = [];
    let relative = 8 + values.length * 8;
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index]!;
        writeUint32(descriptors, index * 8, value.id);
        writeUint32(descriptors, index * 8 + 4, relative);
        const padded = padToMultiple(value.data, 4);
        chunks.push(padded);
        relative += padded.length;
    }
    const valuesBytes = concat(...chunks);
    const section = concat(
        uint32Bytes(8 + descriptors.length + valuesBytes.length),
        uint32Bytes(values.length),
        descriptors,
        valuesBytes,
    );
    const header = new Uint8Array(48);
    writeUint16(header, 0, 0xfffe);
    writeUint16(header, 2, 0);
    header.set(SUMMARY_FMTID, 8);
    writeUint32(header, 24, 1);
    header.set(SUMMARY_FMTID, 28);
    writeUint32(header, 44, 48);
    return concat(header, section);
};

/* -------------------------------------------------------------------------- */
/* WordDocument / CLX fixture builders                                        */
/* -------------------------------------------------------------------------- */

interface PieceSpec {
    /** Text of the piece, including its paragraph mark. */
    readonly text: string;
    /** Compressed pieces use one CP1252 byte per character. */
    readonly compressed: boolean;
    /** Byte offset of the piece data inside `WordDocument`. */
    readonly offset: number;
}

interface PlcPiece {
    readonly cpStart: number;
    readonly cpEnd: number;
    readonly fc: number;
}

interface WordDocumentOptions {
    readonly wIdent?: number;
    readonly nFib?: number;
    readonly flags?: number;
    readonly cbRgFcLcb?: number;
    readonly fcClx?: number;
    readonly lcbClx?: number;
}

const encodePiece = (text: string, compressed: boolean): Uint8Array => {
    if (compressed) {
        const bytes = new Uint8Array(text.length);
        for (let index = 0; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            assert.ok(code <= 0xff, "compressed fixture text must fit code page 1252");
            bytes[index] = code;
        }
        return bytes;
    }
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) writeUint16(bytes, index * 2, text.charCodeAt(index));
    return bytes;
};

/** Builds a Word 97 FIB (nFib 0x00C1) followed by the piece text at its fixed offsets. */
const buildWordDocument = (pieces: readonly PieceSpec[], options: WordDocumentOptions = {}): Uint8Array => {
    const bytes = new Uint8Array(MINI_STREAM_CUTOFF);
    writeUint16(bytes, 0, options.wIdent ?? WORD_IDENT);
    writeUint16(bytes, 2, options.nFib ?? NFIB_WORD97);
    writeUint16(bytes, 0x0a, options.flags ?? 0);
    // csw = 14, fibRgW = 28 bytes, cslw = 22, fibRgLw = 88 bytes, 93 fc/lcb pairs.
    writeUint16(bytes, 0x20, 14);
    writeUint16(bytes, 0x3e, 22);
    writeUint16(bytes, 0x98, options.cbRgFcLcb ?? 93);
    writeUint32(bytes, FC_CLX_PAIR_OFFSET, options.fcClx ?? 0);
    writeUint32(bytes, FC_CLX_PAIR_OFFSET + 4, options.lcbClx ?? 0);
    for (const piece of pieces) {
        const encoded = encodePiece(piece.text, piece.compressed);
        assert.ok(piece.offset + encoded.length <= bytes.length, "fixture piece must fit in WordDocument");
        bytes.set(encoded, piece.offset);
    }
    return bytes;
};

/** Assigns CP ranges in piece order and maps each offset to its `fc` encoding. */
const plcPiecesOf = (pieces: readonly PieceSpec[]): readonly PlcPiece[] => {
    let cp = 0;
    return pieces.map(piece => {
        const cpStart = cp;
        cp += piece.text.length;
        const fc = piece.compressed ? ((piece.offset * 2) | COMPRESSED_FLAG) : piece.offset;
        return { cpStart, cpEnd: cp, fc };
    });
};

/** Builds a CLX containing one PRC record followed by a Pcdt/PlcPcd. */
const buildClx = (pieces: readonly PlcPiece[]): Uint8Array => {
    const plc = new Uint8Array((pieces.length + 1) * 4 + pieces.length * 8);
    let cpEnd = 0;
    for (let index = 0; index < pieces.length; index += 1) {
        writeUint32(plc, index * 4, pieces[index]!.cpStart);
        cpEnd = pieces[index]!.cpEnd;
    }
    writeUint32(plc, pieces.length * 4, cpEnd);
    const pcdStart = (pieces.length + 1) * 4;
    for (let index = 0; index < pieces.length; index += 1) {
        writeUint16(plc, pcdStart + index * 8, 0);
        writeUint32(plc, pcdStart + index * 8 + 2, pieces[index]!.fc);
        writeUint16(plc, pcdStart + index * 8 + 6, 0);
    }
    const prcData = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
    const prc = concat(Uint8Array.of(0x01), uint16Bytes(prcData.length), prcData);
    const pcdt = concat(Uint8Array.of(0x02), uint32Bytes(plc.length), plc);
    return concat(prc, pcdt);
};

interface DocFixtureOptions {
    readonly title?: string;
    readonly flags?: number;
    readonly nFib?: number;
    readonly wIdent?: number;
    readonly cbRgFcLcb?: number;
    readonly tableName?: string;
    readonly tableData?: Uint8Array;
    readonly fcClx?: number;
    readonly lcbClx?: number;
    readonly wordDocument?: Uint8Array;
    readonly omitTable?: boolean;
    readonly omitWordDocument?: boolean;
}

interface DocFixture {
    readonly bytes: Uint8Array;
    readonly clx: Uint8Array;
}

const buildDoc = (pieces: readonly PieceSpec[], options: DocFixtureOptions = {}): DocFixture => {
    const clx = buildClx(plcPiecesOf(pieces));
    const tableData = options.tableData ?? clx;
    const wordDocument = options.wordDocument ?? buildWordDocument(pieces, {
        wIdent: options.wIdent,
        nFib: options.nFib,
        flags: options.flags,
        cbRgFcLcb: options.cbRgFcLcb,
        fcClx: options.fcClx ?? 0,
        lcbClx: options.lcbClx ?? tableData.length,
    });
    const tableName = options.tableName ?? (((options.flags ?? 0) & 0x0200) !== 0 ? "1Table" : "0Table");
    const streams: CfbStream[] = [];
    if (options.omitWordDocument !== true) streams.push({ name: "WordDocument", data: wordDocument });
    if (options.omitTable !== true) streams.push({ name: tableName, data: tableData });
    if (options.title !== undefined) {
        streams.push({ name: "\u0005SummaryInformation", data: buildTitlePropertyStream(options.title) });
    }
    return { bytes: buildCfb(streams), clx };
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

const basePieces: readonly PieceSpec[] = [
    { text: "First paragraph\r", compressed: false, offset: 0x600 },
    { text: "Second café\r", compressed: true, offset: 0x400 },
    { text: "Third 段落 ✓\r", compressed: false, offset: 0x500 },
];

/* -------------------------------------------------------------------------- */
/* Happy path                                                                  */
/* -------------------------------------------------------------------------- */

test("parses compressed and UTF-16 pieces into ordered paragraph entries", () => {
    const outline = parseDoc(buildDoc(basePieces).bytes);
    assert.equal(outline.language, "word");
    assert.deepEqual(outline.entries.map(entry => entry.id), ["doc:paragraph:1", "doc:paragraph:2", "doc:paragraph:3"]);
    assert.deepEqual(outline.entries.map(entry => entry.kind), ["paragraph", "paragraph", "paragraph"]);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["First paragraph", "Second café", "Third 段落 ✓"]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), ["First paragraph", "Second café", "Third 段落 ✓"]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "doc:WordDocument", paragraph: 1 },
        { part: "doc:WordDocument", paragraph: 2 },
        { part: "doc:WordDocument", paragraph: 3 },
    ]);
    assert.equal(outline.text, "First paragraph\nSecond café\nThird 段落 ✓");
    assert.equal(outline.truncated, false);
});

test("outline, entries, entry objects and locators are frozen", () => {
    const outline = parseDoc(buildDoc(basePieces, { title: "Frozen Title" }).bytes);
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
});

test("a Title property emits a heading before every paragraph", () => {
    const outline = parseDoc(buildDoc(basePieces, { title: "Quarterly Report" }).bytes);
    assert.equal(outline.entries.length, 4);
    const title = outline.entries[0]!;
    assert.equal(title.id, "doc:title");
    assert.equal(title.kind, "heading");
    assert.equal(title.name, "Quarterly Report");
    assert.equal(title.summary, "Quarterly Report");
    assert.deepEqual(title.locator, { part: "doc:properties" });
    assert.equal(Object.hasOwn(title, "parentId"), false);
    assert.equal(outline.text, "Quarterly Report\nFirst paragraph\nSecond café\nThird 段落 ✓");
    assert.deepEqual(outline.entries.slice(1).map(entry => entry.id), [
        "doc:paragraph:1", "doc:paragraph:2", "doc:paragraph:3",
    ]);
});

test("all documented Word nFib versions are accepted", () => {
    for (const nFib of [0x00c1, 0x00d9, 0x0101, 0x0112]) {
        const outline = parseDoc(buildDoc(basePieces, { nFib }).bytes);
        assert.equal(outline.entries.length, 3, `nFib 0x${nFib.toString(16)}`);
    }
});

test("fWhichTblStm selects the 1Table stream", () => {
    const outline = parseDoc(buildDoc(basePieces, { flags: 0x0200 }).bytes);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["First paragraph", "Second café", "Third 段落 ✓"]);
});

test("falls back to the fixed fcClx offset when the FIB array omits pair 33", () => {
    const outline = parseDoc(buildDoc(basePieces, { cbRgFcLcb: 33 }).bytes);
    assert.equal(outline.entries.length, 3);
    assert.equal(outline.text, "First paragraph\nSecond café\nThird 段落 ✓");
});

test("compressed pieces decode code page 1252 rather than Latin-1", () => {
    // Byte 0x80 is U+20AC in code page 1252 and U+0080 in ISO-8859-1.
    const pieces: readonly PieceSpec[] = [{ text: `Cost \u0080\r`, compressed: true, offset: 0x400 }];
    const outline = parseDoc(buildDoc(pieces).bytes);
    assert.equal(outline.entries[0]!.summary, "Cost €");
});

test("control characters are mapped to separators and field markers are dropped", () => {
    const pieces: readonly PieceSpec[] = [{
        text: "One\u0007Two\u000BThree\u000CNext\u0013x\u0014y\u0001z\r",
        compressed: false,
        offset: 0x400,
    }];
    const outline = parseDoc(buildDoc(pieces).bytes);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["One Two", "Nextxyz"]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), ["One Two\nThree", "Nextxyz"]);
    assert.equal(outline.text, "One Two\nThree\nNextxyz");
    assert.deepEqual(outline.entries.map(entry => entry.locator.paragraph), [1, 2]);
});

/* -------------------------------------------------------------------------- */
/* Budgets                                                                     */
/* -------------------------------------------------------------------------- */

test("maxEntriesInOutline clips the outline and sets truncated", () => {
    const outline = parseDoc(buildDoc(basePieces).bytes, { maxEntriesInOutline: 1 });
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.id, "doc:paragraph:1");
    assert.equal(outline.text, "First paragraph");
    assert.equal(outline.truncated, true);
});

test("maxTextCharacters clips summaries and sets truncated", () => {
    const outline = parseDoc(buildDoc(basePieces).bytes, { maxTextCharacters: 10 });
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.summary.length, 10);
    assert.equal(outline.text.length, 10);
    assert.equal(outline.truncated, true);
});

test("a long paragraph is clipped to 2000 characters and sets truncated", () => {
    const pieces: readonly PieceSpec[] = [{ text: `${"a".repeat(2500)}\r`, compressed: true, offset: 0x400 }];
    const outline = parseDoc(buildDoc(pieces).bytes);
    assert.equal(outline.entries.length, 1);
    assert.equal(outline.entries[0]!.name.length, 80);
    assert.equal(outline.entries[0]!.summary.length, 2000);
    assert.equal(outline.text.length, 2000);
    assert.equal(outline.truncated, true);
});

test("maxNodes caps paragraph processing and raises limit_exceeded", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces).bytes, { maxNodes: 2 })), "limit_exceeded");
    const outline = parseDoc(buildDoc(basePieces).bytes, { maxNodes: 3 });
    assert.equal(outline.entries.length, 3);
    assert.equal(outline.truncated, false);
});

/* -------------------------------------------------------------------------- */
/* Structural errors                                                          */
/* -------------------------------------------------------------------------- */

test("non-compound input is invalid_document", () => {
    assert.equal(errorCode(() => parseDoc(new Uint8Array(600))), "invalid_document");
    assert.equal(errorCode(() => parseDoc(new TextEncoder().encode("<html>not a doc</html>"))), "invalid_document");
});

test("an encrypted document is unsupported_format", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces, { flags: 0x0100 }).bytes)), "unsupported_format");
});

test("a wrong wIdent is invalid_document", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces, { wIdent: 0x1234 }).bytes)), "invalid_document");
});

test("an unsupported nFib is invalid_document", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces, { nFib: 0x00ff }).bytes)), "invalid_document");
});

test("a missing WordDocument stream is invalid_document", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces, { omitWordDocument: true }).bytes)), "invalid_document");
});

test("a missing table stream is invalid_document", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces, { omitTable: true }).bytes)), "invalid_document");
});

test("a Clx outside the table stream is invalid_document", () => {
    assert.equal(errorCode(() => parseDoc(buildDoc(basePieces, { lcbClx: 100_000 }).bytes)), "invalid_document");
});

test("a PlcPcd whose length is not a whole number of pieces is invalid_document", () => {
    const badClx = concat(Uint8Array.of(0x02), uint32Bytes(39), new Uint8Array(39));
    const wordDocument = buildWordDocument([], { lcbClx: badClx.length });
    const bytes = buildCfb([
        { name: "WordDocument", data: wordDocument },
        { name: "0Table", data: badClx },
    ]);
    assert.equal(errorCode(() => parseDoc(bytes)), "invalid_document");
});

test("a Clx without a Pcdt is invalid_document", () => {
    const badClx = concat(Uint8Array.of(0x01), uint16Bytes(0));
    const wordDocument = buildWordDocument([], { lcbClx: badClx.length });
    const bytes = buildCfb([
        { name: "WordDocument", data: wordDocument },
        { name: "0Table", data: badClx },
    ]);
    assert.equal(errorCode(() => parseDoc(bytes)), "invalid_document");
});

test("a piece whose text lies outside WordDocument is invalid_document", () => {
    const badClx = buildClx([{ cpStart: 0, cpEnd: 4, fc: 0x2000 }]);
    const wordDocument = buildWordDocument([], { lcbClx: badClx.length });
    const bytes = buildCfb([
        { name: "WordDocument", data: wordDocument },
        { name: "0Table", data: badClx },
    ]);
    assert.equal(errorCode(() => parseDoc(bytes)), "invalid_document");
});

test("non-Uint8Array input is a TypeError", () => {
    assert.throws(() => parseDoc("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseDoc(null as unknown as Uint8Array), TypeError);
});
