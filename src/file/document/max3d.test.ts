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

test("a 3ds Max compound document is unsupported_format", () => {
    assert.throws(() => parseMax3d(oleBytes()), (error: unknown) => error instanceof DocumentError
        && error.code === "unsupported_format"
        && error.message.includes("proprietary container")
        && error.message.includes(".3ds"));
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
