import assert from "node:assert/strict";
import test from "node:test";
import { definition } from "../language/solidworks.ts";
import { LanguageRegistry } from "../language/registry.ts";
import { parseSolidworks } from "./solidworks.ts";
import { DocumentError } from "./types.ts";

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

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
 * Spec-shaped v3 CFB fixture: a `Data` storage with a 4096-byte stream plus a
 * root-level SummaryInformation stream. Both streams sit at the mini-stream
 * cutoff, so the directory and FAT chains are all the reader needs.
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

test("SolidWorks compound documents expose their CFB hierarchy and properties", () => {
    const outline = parseSolidworks(compoundDocument());
    assert.equal(outline.language, "solidworks");
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

test("non-compound input is invalid_document with the documented message", () => {
    const stepText = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n");
    assert.equal(errorCode(() => parseSolidworks(stepText)), "invalid_document");
    assert.equal(errorCode(() => parseSolidworks(new Uint8Array(0))), "invalid_document");
    assert.equal(errorCode(() => parseSolidworks(new Uint8Array(512))), "invalid_document");
    assert.throws(() => parseSolidworks(stepText), (error: unknown) => error instanceof DocumentError
        && error.code === "invalid_document"
        && error.message === "not a compounds document");
    const corruptCompound = new Uint8Array(512);
    corruptCompound.set(CFB_SIGNATURE);
    assert.equal(errorCode(() => parseSolidworks(corruptCompound)), "invalid_document");
});

test("non-byte input is a TypeError", () => {
    assert.throws(() => parseSolidworks("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseSolidworks(new ArrayBuffer(8) as unknown as Uint8Array), TypeError);
});

test("the solidworks definition is valid and resolves all three extensions", () => {
    assert.equal(definition.id, "solidworks");
    assert.equal(definition.displayName, "SolidWorks");
    assert.equal(definition.support, "document");
    assert.deepEqual(definition.extensions, [".sldprt", ".sldasm", ".slddrw"]);
    assert.deepEqual(definition.mimeTypes, ["application/x-solidworks", "application/x-sldprt"]);
    assert.equal(definition.documentParser?.language, "solidworks");
    const outline = definition.documentParser!.parse(compoundDocument());
    assert.equal(outline.language, "solidworks");
    assert.equal(outline.entries[0]!.name, "Data");
    assert.equal(outline.entries.length, 6);

    const registry = new LanguageRegistry({ definitions: [definition] });
    for (const extension of [".sldprt", ".sldasm", ".slddrw"]) {
        const match = registry.resolve(`part${extension}`).get();
        assert.equal(match.language.id, "solidworks");
        assert.equal(match.extension, extension);
        assert.equal(match.confidence, "exact");
    }
    assert.equal(registry.resolve("part.sldprt", "application/x-sldprt").get().language.id, "solidworks");
});
