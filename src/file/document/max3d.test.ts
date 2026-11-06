import assert from "node:assert/strict";
import test from "node:test";
import { definition } from "../language/max3d.ts";
import { LanguageRegistry } from "../language/registry.ts";
import { parseMax3d } from "./max3d.ts";
import { DocumentError } from "./types.ts";

const MAIN3DS = 0x4d4d;
const EDIT3DS = 0x3d3d;
const VERSION = 0x0002;
const NAMED_OBJECT = 0x4000;
const N_TRI_OBJECT = 0x4100;
const POINT_ARRAY = 0x4110;

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
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
};

/** Builds a chunk with an explicit declared length; the header is always 6 bytes long. */
const buildChunk = (chunkId: number, payload: Uint8Array, declaredLength: number): Uint8Array => {
    const bytes = new Uint8Array(6 + payload.length);
    writeUint16(bytes, 0, chunkId);
    writeUint32(bytes, 2, declaredLength);
    bytes.set(payload, 6);
    return bytes;
};

const chunkOf = (chunkId: number, ...parts: readonly Uint8Array[]): Uint8Array => {
    const payload = concat(...parts);
    return buildChunk(chunkId, payload, 6 + payload.length);
};

const asciiZ = (value: string): Uint8Array => {
    const encoded = new TextEncoder().encode(value);
    const bytes = new Uint8Array(encoded.length + 1);
    bytes.set(encoded);
    return bytes;
};

const namedObject = (name: string, ...children: readonly Uint8Array[]): Uint8Array =>
    chunkOf(NAMED_OBJECT, asciiZ(name), ...children);

/** Vertex count plus float data; a chunk walker must never treat this payload as chunks. */
const triangleObject = (): Uint8Array => chunkOf(N_TRI_OBJECT, chunkOf(POINT_ARRAY, Uint8Array.from([
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x80, 0x3f,
])));

/** Minimal well-formed file: MAIN3DS > VERSION leaf + EDIT3DS > objects. */
const threeDs = (...objects: readonly Uint8Array[]): Uint8Array =>
    chunkOf(MAIN3DS, chunkOf(VERSION, Uint8Array.from([0x03, 0x00, 0x00, 0x00])), chunkOf(EDIT3DS, ...objects));

const oleBytes = (size = 512): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    return bytes;
};

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

const writeUint64 = (bytes: Uint8Array, offset: number, value: bigint): void => {
    writeUint32(bytes, offset, Number(value & 0xffffffffn));
    writeUint32(bytes, offset + 4, Number((value >> 32n) & 0xffffffffn));
};

const uint32Bytes = (value: number): Uint8Array => {
    const bytes = new Uint8Array(4);
    writeUint32(bytes, 0, value);
    return bytes;
};

const padTo = (bytes: Uint8Array, multiple: number): Uint8Array => {
    const remainder = bytes.length % multiple;
    if (remainder === 0) return bytes;
    const padded = new Uint8Array(bytes.length + multiple - remainder);
    padded.set(bytes);
    return padded;
};

const textValue = (text: string): Uint8Array => {
    const characters = new TextEncoder().encode(text);
    const bytes = new Uint8Array(8 + characters.length + 1);
    writeUint16(bytes, 0, 30);
    writeUint32(bytes, 4, characters.length + 1);
    bytes.set(characters, 8);
    return bytes;
};

const codePageValue = (): Uint8Array => {
    const bytes = new Uint8Array(8);
    writeUint16(bytes, 0, 2);
    writeUint16(bytes, 4, 65001);
    return bytes;
};

/** Minimal MS-OLEPS SummaryInformation stream with Title, Author and Company. */
const summaryInformation = (): Uint8Array => {
    const values = [
        { id: 1, data: codePageValue() },
        { id: 2, data: textValue("Fixture Title") },
        { id: 4, data: textValue("Ada Lovelace") },
        { id: 15, data: textValue("Analytical Engines") },
    ];
    const descriptors = new Uint8Array(values.length * 8);
    const region: Uint8Array[] = [];
    let relative = 8 + values.length * 8;
    for (let index = 0; index < values.length; index += 1) {
        writeUint32(descriptors, index * 8, values[index]!.id);
        writeUint32(descriptors, index * 8 + 4, relative);
        const padded = padTo(values[index]!.data, 4);
        region.push(padded);
        relative += padded.length;
    }
    const valueBytes = concat(...region);
    const section = concat(
        uint32Bytes(8 + descriptors.length + valueBytes.length),
        uint32Bytes(values.length), descriptors, valueBytes,
    );
    const header = new Uint8Array(48);
    writeUint16(header, 0, 0xfffe);
    writeUint32(header, 24, 1);
    writeUint32(header, 44, 48);
    return concat(header, section);
};

interface DirectoryFixture {
    readonly name: string;
    readonly type: number;
    readonly left: number;
    readonly right: number;
    readonly child: number;
    readonly start: number;
    readonly size: number;
}

const writeDirectoryEntry = (directory: Uint8Array, index: number, entry: DirectoryFixture): void => {
    const offset = index * 128;
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
    writeUint64(directory, offset + 0x78, BigInt(entry.size));
};

/**
 * A spec-shaped v3 CFB container used only by these tests: one `Data` storage
 * with a 4096-byte `Geometry` stream plus a root-level SummaryInformation
 * stream. Both streams are at the mini-stream cutoff, so no mini FAT is needed.
 */
const compoundDocument = (): Uint8Array => {
    const geometry = new Uint8Array(4096);
    for (let index = 0; index < geometry.length; index += 1) geometry[index] = (index * 13 + 7) & 0xff;
    const summary = padTo(summaryInformation(), 4096);
    const directory = new Uint8Array(512);
    const fat = new Uint32Array(128);
    fat.fill(FREESECT);
    for (let index = 0; index < 8; index += 1) {
        fat[index] = index < 7 ? index + 1 : ENDOFCHAIN;
        fat[8 + index] = index < 7 ? 9 + index : ENDOFCHAIN;
    }
    fat[16] = ENDOFCHAIN;
    fat[17] = FATSECT;
    writeDirectoryEntry(directory, 0, {
        name: "Root Entry", type: 5, left: NOSTREAM, right: NOSTREAM, child: 1, start: ENDOFCHAIN, size: 0,
    });
    writeDirectoryEntry(directory, 1, {
        name: "Data", type: 1, left: NOSTREAM, right: 3, child: 2, start: 0, size: 0,
    });
    writeDirectoryEntry(directory, 2, {
        name: "Geometry", type: 2, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: 0, size: geometry.length,
    });
    writeDirectoryEntry(directory, 3, {
        name: "\u0005SummaryInformation", type: 2, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM,
        start: 8, size: summary.length,
    });

    const bytes = new Uint8Array(512 + 18 * 512);
    bytes.set(CFB_SIGNATURE, 0);
    writeUint16(bytes, 0x18, 0x003e);
    writeUint16(bytes, 0x1a, 3);
    writeUint16(bytes, 0x1c, 0xfffe);
    writeUint16(bytes, 0x1e, 9);
    writeUint16(bytes, 0x20, 6);
    writeUint32(bytes, 0x2c, 1);
    writeUint32(bytes, 0x30, 16);
    writeUint32(bytes, 0x38, 4096);
    writeUint32(bytes, 0x3c, ENDOFCHAIN);
    writeUint32(bytes, 0x40, 0);
    writeUint32(bytes, 0x44, ENDOFCHAIN);
    writeUint32(bytes, 0x48, 0);
    for (let index = 0; index < 109; index += 1) writeUint32(bytes, 0x4c + index * 4, FREESECT);
    writeUint32(bytes, 0x4c, 17);
    bytes.set(geometry, 512);
    bytes.set(summary, 9 * 512);
    bytes.set(directory, 17 * 512);
    const fatBytes = new Uint8Array(512);
    for (let index = 0; index < fat.length; index += 1) writeUint32(fatBytes, index * 4, fat[index]!);
    bytes.set(fatBytes, 18 * 512);
    return bytes;
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

test("3ds named objects become section entries in chunk order", () => {
    const outline = parseMax3d(threeDs(namedObject("Box", triangleObject()), namedObject("Sphere")));
    assert.equal(outline.language, "max3d");
    assert.equal(outline.truncated, false);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Box", "Sphere"]);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["max3d:object:1", "max3d:object:2"]);
    assert.deepEqual(outline.entries.map(entry => entry.kind), ["section", "section"]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), ["object Box", "object Sphere"]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "3ds:objects", paragraph: 1 },
        { part: "3ds:objects", paragraph: 2 },
    ]);
    assert.equal(outline.text, "object Box\nobject Sphere");
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
});

test("3ds object names are trimmed and clamped to 120 characters", () => {
    const longName = "N".repeat(150);
    const outline = parseMax3d(threeDs(namedObject("  Padded Object  "), namedObject(longName)));
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Padded Object", "N".repeat(120)]);
    assert.equal(outline.entries[1]!.summary, `object ${longName}`);
    assert.equal(outline.truncated, false);
});

test("an unnamed object is skipped but keeps the object ordinal", () => {
    const outline = parseMax3d(threeDs(namedObject(""), namedObject("Kept")));
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Kept"]);
    assert.equal(outline.entries[0]!.id, "max3d:object:2");
    assert.deepEqual(outline.entries[0]!.locator, { part: "3ds:objects", paragraph: 2 });
});

test("mesh payloads are skipped by chunk length instead of parsed as chunks", () => {
    // A N_TRI_OBJECT body that would be an invalid chunk header if it were traversed.
    const notAChunk = chunkOf(N_TRI_OBJECT, Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x00]));
    const outline = parseMax3d(threeDs(namedObject("Mesh", notAChunk)));
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Mesh"]);
    assert.equal(outline.text, "object Mesh");
});

test("a 3ds Max compound document projects its CFB storages, streams and properties", () => {
    const outline = parseMax3d(compoundDocument());
    assert.equal(outline.language, "max3d");
    assert.equal(outline.truncated, false);
    assert.deepEqual(outline.entries.map(entry => entry.id), ["cfb:1", "cfb:2", "cfb:3", "cfb:4", "cfb:5", "cfb:6"]);
    assert.deepEqual(outline.entries.map(entry => entry.kind), [
        "section", "note", "note", "note", "note", "note",
    ]);
    assert.deepEqual(outline.entries.map(entry => entry.name), [
        "Data", "Geometry (4096 bytes)", "\u0005SummaryInformation (4096 bytes)", "Title", "Author", "Company",
    ]);
    assert.deepEqual(outline.entries.map(entry => entry.parentId), [
        undefined, "cfb:1", undefined, undefined, undefined, undefined,
    ]);
    assert.deepEqual(outline.entries.map(entry => entry.summary), [
        "Root/Data 00000000-0000-0000-0000-000000000000",
        "stream 4096 bytes",
        "stream 4096 bytes",
        "Fixture Title",
        "Ada Lovelace",
        "Analytical Engines",
    ]);
    assert.deepEqual(outline.entries.map(entry => entry.locator), [
        { part: "cfb", paragraph: 1 },
        { part: "cfb", paragraph: 2 },
        { part: "cfb", paragraph: 3 },
        { part: "cfb:properties", paragraph: 1 },
        { part: "cfb:properties", paragraph: 2 },
        { part: "cfb:properties", paragraph: 3 },
    ]);
    assert.equal(outline.text, [
        "Root/Data 00000000-0000-0000-0000-000000000000",
        "stream 4096 bytes",
        "stream 4096 bytes",
        "Fixture Title",
        "Ada Lovelace",
        "Analytical Engines",
    ].join("\n"));
    assert.equal(Object.isFrozen(outline), true);
    assert.equal(Object.isFrozen(outline.entries), true);
    for (const entry of outline.entries) {
        assert.equal(Object.isFrozen(entry), true);
        assert.equal(Object.isFrozen(entry.locator), true);
    }
});

test("the outline budget truncates a .max projection instead of rejecting it", () => {
    const outline = parseMax3d(compoundDocument(), { maxEntriesInOutline: 2 });
    assert.deepEqual(outline.entries.map(entry => entry.name), ["Data", "Geometry (4096 bytes)"]);
    assert.equal(outline.text, [
        "Root/Data 00000000-0000-0000-0000-000000000000",
        "stream 4096 bytes",
    ].join("\n"));
    assert.equal(outline.truncated, true);
});

test("a corrupt compound document is invalid_document", () => {
    assert.equal(errorCode(() => parseMax3d(oleBytes())), "invalid_document");
});

test("chunks that extend past their container are invalid_document", () => {
    const overflowingChild = chunkOf(MAIN3DS, buildChunk(NAMED_OBJECT, asciiZ("Box"), 64));
    assert.equal(errorCode(() => parseMax3d(overflowingChild)), "invalid_document");
    const overflowingMain = buildChunk(MAIN3DS, asciiZ("Box"), 100);
    assert.equal(errorCode(() => parseMax3d(overflowingMain)), "invalid_document");
});

test("chunk lengths smaller than the 6-byte header are invalid_document", () => {
    const bytes = chunkOf(MAIN3DS, buildChunk(NAMED_OBJECT, asciiZ("Box"), 5));
    assert.equal(errorCode(() => parseMax3d(bytes)), "invalid_document");
});

test("a file that does not start with MAIN3DS is invalid_document", () => {
    assert.equal(errorCode(() => parseMax3d(new Uint8Array(0))), "invalid_document");
    assert.equal(errorCode(() => parseMax3d(new Uint8Array(3))), "invalid_document");
    assert.equal(errorCode(() => parseMax3d(chunkOf(EDIT3DS, asciiZ("Box")))), "invalid_document");
});

test("maxEntriesInOutline truncates the outline without throwing", () => {
    const outline = parseMax3d(threeDs(namedObject("One"), namedObject("Two"), namedObject("Three")), {
        maxEntriesInOutline: 1,
    });
    assert.deepEqual(outline.entries.map(entry => entry.name), ["One"]);
    assert.equal(outline.text, "object One");
    assert.equal(outline.truncated, true);
});

test("maxTextCharacters clips summaries without throwing", () => {
    const outline = parseMax3d(threeDs(namedObject("Alpha")), { maxTextCharacters: 10 });
    assert.equal(outline.entries[0]!.name, "Alpha");
    assert.equal(outline.entries[0]!.summary, "object Alp");
    assert.equal(outline.text, "object Alp");
    assert.equal(outline.truncated, true);
});

test("the chunk-count budget is enforced", () => {
    const bytes = threeDs(namedObject("Box"));
    // MAIN3DS, VERSION, EDIT3DS and NAMED_OBJECT are four chunks.
    assert.equal(errorCode(() => parseMax3d(bytes, { maxNodes: 3 })), "limit_exceeded");
    assert.equal(parseMax3d(bytes, { maxNodes: 4 }).entries.length, 1);
});

test("deep chunk nesting exceeds the depth budget", () => {
    let nested: Uint8Array = namedObject("Deep");
    for (let index = 0; index < 200; index += 1) nested = chunkOf(EDIT3DS, nested);
    assert.equal(errorCode(() => parseMax3d(chunkOf(MAIN3DS, nested))), "limit_exceeded");
});

test("a caller-supplied depth budget rejects the fourth nesting level", () => {
    const bytes = threeDs(namedObject("Box", triangleObject()));
    assert.equal(parseMax3d(bytes, { maxDepth: 4 }).entries.length, 1);
    assert.equal(errorCode(() => parseMax3d(bytes, { maxDepth: 3 })), "limit_exceeded");
});

test("non-byte input is a TypeError", () => {
    assert.throws(() => parseMax3d("not bytes" as unknown as Uint8Array), TypeError);
});

test("the max3d definition is valid and resolves .max and .3ds files", () => {
    assert.equal(definition.id, "max3d");
    assert.equal(definition.displayName, "3ds Max");
    assert.equal(definition.support, "document");
    assert.deepEqual(definition.extensions, [".max", ".3ds"]);
    assert.deepEqual(definition.mimeTypes, ["application/x-3dsmax", "application/x-3ds"]);
    assert.equal(definition.documentParser?.language, "max3d");
    assert.equal(definition.documentParser!.parse(threeDs(namedObject("Box"))).language, "max3d");

    const registry = new LanguageRegistry({ definitions: [definition] });
    for (const [path, extension] of [["scene.max", ".max"], ["scene.3ds", ".3ds"]] as const) {
        const match = registry.resolve(path).get();
        assert.equal(match.language.id, "max3d");
        assert.equal(match.extension, extension);
        assert.equal(match.confidence, "exact");
    }
    assert.equal(registry.resolve("scene.3ds", "application/x-3ds").get().language.id, "max3d");
});
