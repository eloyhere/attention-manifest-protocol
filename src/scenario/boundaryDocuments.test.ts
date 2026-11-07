/**
 * Boundary and fuzz tests for the binary document/archive outline readers.
 *
 * Scope: malformed containers, every truncation prefix we can afford (the total
 * number of prefix parses is asserted to stay near 300), deterministic random
 * bytes, container-limit flags, resource budgets, the 32-language capability
 * matrix, immutability of the returned outlines and argument validation.
 *
 * These are correctness tests only. Nothing here measures throughput, memory or
 * any other performance property; the test-level timeouts exist solely to turn a
 * hypothetical non-terminating parser into a test failure instead of a hang.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { builtinLanguages } from "../file/language/builtins.ts";
import { parseDocx } from "../file/document/docx.ts";
import { parseMax3d } from "../file/document/max3d.ts";
import { createDocumentOutline } from "../file/document/outline.ts";
import { parsePsd } from "../file/document/photoshop.ts";
import { parsePptx } from "../file/document/pptx.ts";
import { parseSolidworks } from "../file/document/solidworks.ts";
import { createZip } from "../file/document/testZip.ts";
import {
    DocumentError, type DocumentErrorCode, type DocumentOutline,
} from "../file/document/types.ts";

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Small byte writers used to hand-build binary fixtures without dependencies.
// ---------------------------------------------------------------------------

function concat(...parts: readonly Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64(target: Uint8Array, offset: number, value: number): void {
    writeU32(target, offset, value % 0x1_0000_0000);
    writeU32(target, offset + 4, Math.floor(value / 0x1_0000_0000));
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
    target.set(encoder.encode(value), offset);
}

class ByteWriter {
    private readonly bytes: number[] = [];

    get length(): number {
        return this.bytes.length;
    }

    u8(value: number): this {
        this.bytes.push(value & 0xff);
        return this;
    }

    u16(value: number): this {
        this.bytes.push((value >>> 8) & 0xff, value & 0xff);
        return this;
    }

    i16(value: number): this {
        return this.u16(value < 0 ? value + 0x10000 : value);
    }

    u32(value: number): this {
        const normalized = value >>> 0;
        this.bytes.push(
            (normalized >>> 24) & 0xff, (normalized >>> 16) & 0xff, (normalized >>> 8) & 0xff, normalized & 0xff,
        );
        return this;
    }

    i32(value: number): this {
        return this.u32(value);
    }

    u64(value: number): this {
        const high = Math.floor(value / 0x1_0000_0000);
        return this.u32(high).u32(value - high * 0x1_0000_0000);
    }

    ascii(value: string): this {
        for (let index = 0; index < value.length; index += 1) this.bytes.push(value.charCodeAt(index) & 0xff);
        return this;
    }

    raw(values: readonly number[] | Uint8Array): this {
        for (const value of values) this.bytes.push(value & 0xff);
        return this;
    }

    toBytes(): Uint8Array {
        return Uint8Array.from(this.bytes);
    }
}

// ---------------------------------------------------------------------------
// Valid fixtures: one per container family exercised by the truncation fuzzer.
// ---------------------------------------------------------------------------

const WORD_NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCUMENT_XML = `<?xml version="1.0"?><w:document ${WORD_NAMESPACE}><w:body>`
    + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t>Body text</w:t></w:r></w:p>`
    + `</w:body></w:document>`;

const DOCX = createZip({ "word/document.xml": DOCUMENT_XML });

const XLSX = createZip({
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Budget" sheetId="1" r:id="s1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="s1" Target="worksheets/data.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si></sst>`,
    "xl/worksheets/data.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
});

const PPTX = createZip({
    "ppt/presentation.xml": `<p:presentation xmlns:r="r"><p:sldIdLst>`
        + `<p:sldId id="1" r:id="r1"/><p:sldId id="2" r:id="r2"/>`
        + `</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships>`
        + `<Relationship Id="r1" Target="slides/slide1.xml"/>`
        + `<Relationship Id="r2" Target="slides/slide2.xml"/>`
        + `</Relationships>`,
    "ppt/slides/slide1.xml": `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>`
        + `<a:p><a:r><a:t>Quarterly</a:t></a:r></a:p>`
        + `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    "ppt/slides/slide2.xml": `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>`
        + `<a:p><a:r><a:t>Second slide</a:t></a:r></a:p>`
        + `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
});

/** Pascal layer name: one length byte, the bytes, then zero padding to a four-byte boundary. */
function pascal(value: string): readonly number[] {
    const encoded = [...encoder.encode(value)];
    const output = [encoded.length, ...encoded];
    while (output.length % 4 !== 0) output.push(0);
    return output;
}

function psdLayerRecord(version: 1 | 2): Uint8Array {
    const extra = new ByteWriter().u32(0).u32(0).raw(pascal("Layer"));
    const record = new ByteWriter()
        .i32(0).i32(0).i32(10).i32(20)
        .u16(1).i16(0);
    if (version === 2) record.u64(0);
    else record.u32(0);
    record.ascii("8BIM").ascii("norm").u8(255).u8(0).u8(0).u8(0);
    record.u32(extra.length).raw(extra.toBytes());
    return record.toBytes();
}

/** One-layer PSD (v1) or PSB (v2) fixture; the layer/mask section length differs by version. */
function makePsd(version: 1 | 2): Uint8Array {
    const layerInfo = new ByteWriter().i16(-1).raw(psdLayerRecord(version));
    const section = new ByteWriter();
    if (version === 2) section.u64(layerInfo.length);
    else section.u32(layerInfo.length);
    section.raw(layerInfo.toBytes()).u32(0); // global layer mask info
    const file = new ByteWriter()
        .ascii("8BPS").u16(version).raw([0, 0, 0, 0, 0, 0])
        .u16(1).u32(64).u32(64).u16(8).u16(3)
        .u32(0).u32(0); // color mode data, image resources
    if (version === 2) file.u64(section.length);
    else file.u32(section.length);
    file.raw(section.toBytes());
    return file.toBytes();
}

const PSD = makePsd(1);
const PSB = makePsd(2);

const MAIN3DS = 0x4d4d;
const EDIT3DS = 0x3d3d;
const VERSION_CHUNK = 0x0002;
const NAMED_OBJECT = 0x4000;

/** Builds a chunk whose declared length equals the emitted byte length. */
function chunk(chunkId: number, payload: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(6 + payload.length);
    writeU16(bytes, 0, chunkId);
    writeU32(bytes, 2, bytes.length);
    bytes.set(payload, 6);
    return bytes;
}

/** Builds a chunk with an explicit (possibly malformed) declared length. */
function chunkWithDeclaredLength(chunkId: number, payload: Uint8Array, declaredLength: number): Uint8Array {
    const bytes = new Uint8Array(6 + payload.length);
    writeU16(bytes, 0, chunkId);
    writeU32(bytes, 2, declaredLength);
    bytes.set(payload, 6);
    return bytes;
}

function make3ds(): Uint8Array {
    const namedObject = (name: string): Uint8Array =>
        chunk(NAMED_OBJECT, concat(encoder.encode(name), Uint8Array.of(0)));
    return chunk(MAIN3DS, concat(
        chunk(VERSION_CHUNK, Uint8Array.of(3, 0, 0, 0)),
        chunk(EDIT3DS, concat(namedObject("Box"), namedObject("Sphere"))),
    ));
}

const THREE_DS = make3ds();

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

function writeCfbDirectoryEntry(
    directory: Uint8Array, index: number, name: string, type: number, child: number, start: number, size: number,
): void {
    const offset = index * 128;
    for (let position = 0; position < name.length; position += 1) {
        writeU16(directory, offset + position * 2, name.charCodeAt(position));
    }
    writeU16(directory, offset + 0x40, (name.length + 1) * 2);
    directory[offset + 0x42] = type;
    directory[offset + 0x43] = 1;
    writeU32(directory, offset + 0x44, NOSTREAM);
    writeU32(directory, offset + 0x48, NOSTREAM);
    writeU32(directory, offset + 0x4c, child);
    writeU32(directory, offset + 0x74, start);
    writeU64(directory, offset + 0x78, size);
}

/**
 * Minimal spec-shaped v3 CFB container: root -> `Data` storage -> one 4096-byte
 * `Big` stream, so both section and note entries plus storage nesting exist.
 * The stream sits exactly at the mini-stream cutoff, avoiding a mini FAT.
 */
function makeCfb(): Uint8Array {
    const bytes = new Uint8Array(512 + 10 * 512);
    bytes.set(CFB_SIGNATURE, 0);
    writeU16(bytes, 0x18, 0x003e);
    writeU16(bytes, 0x1a, 3);
    writeU16(bytes, 0x1c, 0xfffe);
    writeU16(bytes, 0x1e, 9);
    writeU16(bytes, 0x20, 6);
    writeU32(bytes, 0x28, 0);
    writeU32(bytes, 0x2c, 1);
    writeU32(bytes, 0x30, 1);
    writeU32(bytes, 0x34, 0);
    writeU32(bytes, 0x38, 4096);
    writeU32(bytes, 0x3c, ENDOFCHAIN);
    writeU32(bytes, 0x40, 0);
    writeU32(bytes, 0x44, ENDOFCHAIN);
    writeU32(bytes, 0x48, 0);
    for (let index = 0; index < 109; index += 1) writeU32(bytes, 0x4c + index * 4, FREESECT);
    writeU32(bytes, 0x4c, 0); // FAT is sector 0

    const fat = new Uint8Array(512);
    for (let index = 0; index < 128; index += 1) writeU32(fat, index * 4, FREESECT);
    writeU32(fat, 0, FATSECT);
    writeU32(fat, 4, ENDOFCHAIN);
    for (let sector = 2; sector <= 9; sector += 1) {
        writeU32(fat, sector * 4, sector === 9 ? ENDOFCHAIN : sector + 1);
    }
    bytes.set(fat, 512);

    const directory = new Uint8Array(512);
    writeCfbDirectoryEntry(directory, 0, "Root Entry", 5, 1, ENDOFCHAIN, 0);
    writeCfbDirectoryEntry(directory, 1, "Data", 1, 2, 0, 0);
    writeCfbDirectoryEntry(directory, 2, "Big", 2, NOSTREAM, 2, 4096);
    bytes.set(directory, 1024);

    const stream = new Uint8Array(4096);
    for (let index = 0; index < stream.length; index += 1) stream[index] = (index * 31 + 7) & 0xff;
    bytes.set(stream, 1536);
    return bytes;
}

const CFB = makeCfb();

/** Contract-shaped DWG: big-endian count at 0x15 and 8-byte `{ seeker, size }` records. */
function makeDwg(version: string, payload?: Uint8Array): Uint8Array {
    const sections = payload === undefined ? [] : [payload];
    const headerSize = Math.max(0x20, 0x19 + sections.length * 8);
    let fileSize = headerSize;
    for (const section of sections) fileSize += section.length;
    const bytes = new Uint8Array(fileSize);
    for (let index = 0; index < version.length; index += 1) bytes[index] = version.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    view.setInt32(0x15, sections.length, false);
    let cursor = headerSize;
    for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index]!;
        view.setInt32(0x19 + index * 8, cursor, false);
        view.setInt32(0x19 + index * 8 + 4, section.length, false);
        bytes.set(section, cursor);
        cursor += section.length;
    }
    return bytes;
}

const DWG_R13 = makeDwg("AC1012", Uint8Array.of(1, 2, 3));

const DXF = encoder.encode([
    "0", "SECTION", "2", "TABLES",
    "0", "TABLE", "2", "LAYER",
    "0", "LAYER", "2", "Walls", "62", "1",
    "0", "ENDTAB", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE",
    "0", "ENDSEC", "0", "EOF",
].join("\r\n") + "\r\n");

const ZIP = createZip({ "a.txt": "alpha" });

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
    const text = value.toString(8);
    assert.ok(text.length <= length - 1, "octal value fits its TAR field");
    writeAscii(target, offset, text.padStart(length - 1, "0"));
    target[offset + length - 1] = 0;
}

/** One checksummed 512-byte ustar header. */
function makeTarHeader(name: string, size: number, type = "0"): Uint8Array {
    const block = new Uint8Array(512);
    writeAscii(block, 0, name);
    writeTarOctal(block, 100, 8, 0o644);
    writeTarOctal(block, 108, 8, 0);
    writeTarOctal(block, 116, 8, 0);
    writeTarOctal(block, 124, 12, size);
    writeTarOctal(block, 136, 12, 1_700_000_000);
    for (let index = 148; index < 156; index += 1) block[index] = 0x20;
    writeAscii(block, 156, type);
    writeAscii(block, 257, "ustar\0");
    writeAscii(block, 263, "00");
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

function makeTar(): Uint8Array {
    return concat(
        tarRecord(makeTarHeader("notes.txt", 5), encoder.encode("hello")),
        tarRecord(makeTarHeader("docs/", 0, "5")),
        new Uint8Array(1024),
    );
}

const TAR = makeTar();
const GZIP = new Uint8Array(gzipSync(encoder.encode("boundary documents")));
const TAR_GZ = new Uint8Array(gzipSync(TAR));

const OLE_BYTES = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

// ---------------------------------------------------------------------------
// Shared assertions and error helpers.
// ---------------------------------------------------------------------------

const ENTRY_KINDS: ReadonlySet<string> = new Set([
    "heading", "paragraph", "table", "sheet", "cell", "slide", "section", "note",
]);

/** Structural invariants every outline must satisfy, whatever parser produced it. */
function assertOutlineShape(outline: DocumentOutline): void {
    assert.equal(typeof outline.language, "string");
    assert.ok(outline.language.length > 0, "outline.language must not be empty");
    assert.equal(typeof outline.text, "string");
    assert.equal(typeof outline.truncated, "boolean");
    assert.ok(Array.isArray(outline.entries));
    assert.equal(Object.isFrozen(outline.entries), true, "entries array must be frozen");
    const ids = new Set<string>();
    for (const entry of outline.entries) {
        assert.equal(typeof entry.id, "string");
        assert.ok(entry.id.length > 0, "entry.id must not be empty");
        assert.equal(typeof entry.kind, "string");
        assert.ok(ENTRY_KINDS.has(entry.kind), `unexpected entry kind: ${entry.kind}`);
        assert.equal(typeof entry.name, "string");
        assert.equal(typeof entry.summary, "string");
        assert.equal(Object.isFrozen(entry), true, `entry ${entry.id} must be frozen`);
        assert.equal(Object.isFrozen(entry.locator), true, `locator of ${entry.id} must be frozen`);
        assert.equal(typeof entry.locator.part, "string");
        assert.ok(entry.locator.part.length > 0, `locator.part of ${entry.id} must not be empty`);
        assert.equal(ids.has(entry.id), false, `duplicate entry id: ${entry.id}`);
        ids.add(entry.id);
    }
    for (const entry of outline.entries) {
        if (entry.parentId === undefined) continue;
        assert.equal(typeof entry.parentId, "string");
        assert.ok(ids.has(entry.parentId), `parentId ${entry.parentId} of ${entry.id} does not reference an entry`);
    }
}

/** Runs an outline producer, returning a DocumentError instead of throwing it. */
function settle(operation: () => DocumentOutline): DocumentOutline | DocumentError {
    try {
        return operation();
    } catch (error) {
        if (error instanceof DocumentError) return error;
        throw error;
    }
}

/** Asserts that the operation fails with the exact DocumentError code. */
function expectDocumentError(
    operation: () => unknown, code: DocumentErrorCode, label?: string,
): DocumentError {
    try {
        operation();
    } catch (error) {
        if (error instanceof DocumentError) {
            assert.equal(error.code, code, `${label ?? "operation"}: expected ${code}, got ${error.code}`);
            return error;
        }
        throw error;
    }
    assert.fail(`${label ?? "operation"}: expected DocumentError(${code})`);
}

/** Rewrites the general-purpose flags of the first central-directory entry. */
function setCentralFlags(zip: Uint8Array, flags: number): Uint8Array {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    assert.equal(view.getUint32(eocd, true), 0x06054b50);
    const directoryOffset = view.getUint32(eocd + 16, true);
    const copy = zip.slice();
    new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint16(directoryOffset + 8, flags, true);
    return copy;
}

/** Sets the classic EOCD entry count to the Zip64 sentinel without adding a Zip64 record. */
function withZip64Sentinel(zip: Uint8Array): Uint8Array {
    const copy = zip.slice();
    new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint16(copy.length - 12, 0xffff, true);
    return copy;
}

// ---------------------------------------------------------------------------
// 1. Argument validation.
// ---------------------------------------------------------------------------

test("createDocumentOutline validates its path and bytes arguments", () => {
    const call = (path: unknown, bytes: unknown): unknown =>
        createDocumentOutline(path as string, bytes as Uint8Array);
    const empty = new Uint8Array(0);
    assert.throws(() => call("", empty), TypeError);
    assert.throws(() => call("   ", empty), TypeError);
    assert.throws(() => call(null, empty), TypeError);
    assert.throws(() => call(undefined, empty), TypeError);
    assert.throws(() => call(42, empty), TypeError);
    assert.throws(() => call("a.docx", null), TypeError);
    assert.throws(() => call("a.docx", undefined), TypeError);
    assert.throws(() => call("a.docx", [1, 2, 3]), TypeError);
    assert.throws(() => call("a.docx", new ArrayBuffer(8)), TypeError);
    assert.throws(() => call("a.docx", "bytes"), TypeError);
    // A syntactically valid but unregistered path is a DocumentError, not a TypeError.
    expectDocumentError(() => call("unknown.xyz", empty), "unsupported_format");
});

// ---------------------------------------------------------------------------
// 2. The full 32-language capability matrix.
// ---------------------------------------------------------------------------

const TEXT_LANGUAGE_IDS: readonly string[] = Object.freeze([
    "markdown", "text", "tex", "javascript", "typescript", "c", "cpp", "java", "python", "csharp",
    "mysql", "oracle", "sqlserver", "html", "vue", "css", "scss", "sass", "swift", "go", "xml", "json",
]);
const ADAPTER_ONLY_IDS: readonly string[] = Object.freeze(["access", "publisher"]);
const BINARY_LANGUAGE_IDS: readonly string[] = Object.freeze([
    "word", "excel", "powerpoint", "max3d", "solidworks", "photoshop", "cad", "compress",
]);
const EXPECTED_LANGUAGE_IDS: readonly string[] = Object.freeze([
    ...TEXT_LANGUAGE_IDS, ...ADAPTER_ONLY_IDS, ...BINARY_LANGUAGE_IDS,
]);

const BINARY_FIXTURES: Readonly<Record<string, Uint8Array>> = Object.freeze({
    word: DOCX,
    excel: XLSX,
    powerpoint: PPTX,
    max3d: CFB,
    solidworks: CFB,
    photoshop: PSD,
    cad: DXF,
    compress: ZIP,
});

test("all 32 built-in languages reach a documented outcome through createDocumentOutline", () => {
    assert.equal(builtinLanguages.length, 32);
    assert.deepEqual(
        builtinLanguages.map(definition => definition.id).sort(),
        [...EXPECTED_LANGUAGE_IDS].sort(),
    );
    const visited = new Set<string>();
    const produced = new Set<string>();
    for (const definition of builtinLanguages) {
        const path = `matrix${definition.extensions[0]!}`;
        const fixture = BINARY_FIXTURES[definition.id];
        if (fixture === undefined) {
            // Text languages and the Access/Publisher adapters advertise no binary parser.
            expectDocumentError(
                () => createDocumentOutline(path, Uint8Array.of(1, 2, 3)),
                "unsupported_format",
                `${definition.id} (${path})`,
            );
        } else {
            const outline = createDocumentOutline(path, fixture);
            assertOutlineShape(outline);
            assert.equal(outline.language, definition.id);
            assert.ok(outline.entries.length > 0, `${definition.id} (${path}) should produce entries`);
            produced.add(definition.id);
        }
        visited.add(definition.id);
    }
    assert.equal(visited.size, 32);
    assert.deepEqual([...produced].sort(), Object.keys(BINARY_FIXTURES).sort());
});

test("text languages and Access/Publisher never expose a binary outline", () => {
    assert.equal(TEXT_LANGUAGE_IDS.length, 22);
    for (const id of TEXT_LANGUAGE_IDS) {
        const definition = builtinLanguages.find(candidate => candidate.id === id);
        assert.ok(definition !== undefined, `missing text language ${id}`);
        assert.equal(definition.documentParser, undefined, `${id} must not register a binary parser`);
        expectDocumentError(
            () => createDocumentOutline(`text${definition.extensions[0]!}`, Uint8Array.of(0, 1, 2)),
            "unsupported_format",
            id,
        );
    }
    for (const id of ADAPTER_ONLY_IDS) {
        const definition = builtinLanguages.find(candidate => candidate.id === id);
        assert.ok(definition !== undefined, `missing adapter ${id}`);
        assert.equal(definition.support, "unsupported");
        assert.ok(definition.documentParser !== undefined, `${id} should expose an always-refusing adapter`);
        const error = expectDocumentError(
            () => createDocumentOutline(`adapter${definition.extensions[0]!}`, Uint8Array.of(0, 1, 2)),
            "unsupported_format",
            id,
        );
        assert.match(error.message, /host adapter/);
    }
});

// ---------------------------------------------------------------------------
// 3. Binary capability matrix: every container family must yield real entries.
// ---------------------------------------------------------------------------

test("DOCX, XLSX, PPTX, PSD/PSB, DXF/DWG, 3DS, MAX, SolidWorks, ZIP, TAR and GZ produce entries", () => {
    const cases: readonly (readonly [string, string, Uint8Array, number])[] = [
        ["DOCX", "capability.docx", DOCX, 2],
        ["XLSX", "capability.xlsx", XLSX, 2],
        ["PPTX", "capability.pptx", PPTX, 2],
        ["PSD", "capability.psd", PSD, 1],
        ["PSB", "capability.psb", PSB, 1],
        ["DXF", "capability.dxf", DXF, 2],
        ["DWG-R13", "capability.dwg", DWG_R13, 1],
        ["3DS", "capability.3ds", THREE_DS, 2],
        [".max", "capability.max", CFB, 2],
        ["SolidWorks", "capability.sldprt", CFB, 2],
        ["ZIP", "capability.zip", ZIP, 1],
        ["TAR", "capability.tar", TAR, 2],
        ["GZ", "capability.gz", GZIP, 1],
        ["TAR.GZ", "capability.tar.gz", TAR_GZ, 2],
    ];
    for (const [label, path, bytes, entryCount] of cases) {
        const outline = createDocumentOutline(path, bytes);
        assertOutlineShape(outline);
        assert.equal(outline.entries.length, entryCount, `${label} (${path}) entry count`);
    }
    const psd = createDocumentOutline("capability.psd", PSD);
    assert.equal(psd.language, "photoshop");
    assert.equal(psd.entries[0]!.name, "Layer");
    assert.deepEqual(psd.entries[0]!.locator, { part: "psd:layers", paragraph: 1 });
    const tar = createDocumentOutline("capability.tar", TAR);
    assert.deepEqual(tar.entries.map(entry => entry.kind), ["note", "section"]);
    assert.equal(tar.entries[0]!.locator.part, "compress:tar");
});

// ---------------------------------------------------------------------------
// 4. Empty input, magic-only input and legacy markers.
// ---------------------------------------------------------------------------

test("empty and magic-only containers fail with a DocumentError rather than a raw exception", () => {
    const empty = new Uint8Array(0);
    const emptyCases: readonly (readonly [string, DocumentErrorCode])[] = [
        ["empty.docx", "invalid_zip"],
        ["empty.xlsx", "invalid_zip"],
        ["empty.pptx", "invalid_zip"],
        ["empty.zip", "invalid_document"],
        ["empty.tar", "invalid_document"],
        ["empty.gz", "invalid_document"],
        ["empty.psd", "invalid_document"],
        ["empty.3ds", "invalid_document"],
        ["empty.max", "invalid_document"],
        ["empty.sldprt", "invalid_document"],
    ];
    for (const [path, code] of emptyCases) {
        expectDocumentError(() => createDocumentOutline(path, empty), code, path);
    }

    // Empty bytes on the .dwg path are dispatched to the tolerant DXF reader
    // (DWG is identified only by its AC stamp), so they are a legal empty CAD outline.
    const dwg = createDocumentOutline("empty.dwg", empty);
    assert.equal(dwg.language, "cad");
    assert.deepEqual(dwg.entries, []);

    const docxMagic = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    expectDocumentError(() => createDocumentOutline("magic.docx", docxMagic), "invalid_zip");
    expectDocumentError(() => createDocumentOutline("magic.zip", docxMagic), "invalid_document");
    expectDocumentError(() => createDocumentOutline("magic.psd", encoder.encode("8BPS")), "invalid_document");
    expectDocumentError(() => createDocumentOutline("magic.3ds", Uint8Array.of(0x4d, 0x4d)), "invalid_document");
    expectDocumentError(() => createDocumentOutline("magic.gz", Uint8Array.of(0x1f, 0x8b)), "invalid_document");
    expectDocumentError(() => createDocumentOutline("magic.max", OLE_BYTES), "invalid_document");
    expectDocumentError(() => createDocumentOutline("magic.sldprt", OLE_BYTES), "invalid_document");
    // Legacy OLE bytes under an OOXML extension are routed to the legacy Word reader
    // by the format dispatcher, so an 8-byte truncated header is a malformed document.
    expectDocumentError(() => createDocumentOutline("legacy.docx", OLE_BYTES), "invalid_document");
});

// ---------------------------------------------------------------------------
// 5. ZIP64, encryption and expansion-ratio boundaries.
// ---------------------------------------------------------------------------

test("ZIP64 sentinels and encryption flags are refused or surfaced without extraction", () => {
    const encryptedZip = setCentralFlags(createZip({ "secret.txt": "secret" }), 0x1);
    const listing = createDocumentOutline("encrypted.zip", encryptedZip);
    assertOutlineShape(listing);
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.entries[0]!.summary, "6 bytes encrypted");
    assert.equal(listing.entries[0]!.locator.part, "compress:zip");

    expectDocumentError(
        () => createDocumentOutline("encrypted.docx", setCentralFlags(DOCX, 0x1)),
        "unsupported_zip",
    );

    const zip64Zip = withZip64Sentinel(createZip({ "a.txt": "a" }));
    const archiveError = expectDocumentError(
        () => createDocumentOutline("zip64.zip", zip64Zip),
        "unsupported_format",
    );
    assert.match(archiveError.message, /zip64/);

    const zip64Docx = withZip64Sentinel(DOCX);
    const docxError = expectDocumentError(
        () => createDocumentOutline("zip64.docx", zip64Docx),
        "unsupported_zip",
    );
    assert.match(docxError.message, /zip64/);
});

test("a 1 MiB zero-filled deflate entry is listed by the archive reader but refused by OOXML", () => {
    const bomb = new Uint8Array(1024 * 1024);
    const archive = createDocumentOutline("bomb.zip", createZip({ "bomb.bin": bomb }));
    assertOutlineShape(archive);
    assert.equal(archive.entries.length, 1);
    assert.equal(archive.entries[0]!.name, "bomb.bin");
    assert.equal(archive.entries[0]!.summary, "1048576 bytes");

    const bombDocx = createZip({ "bomb.bin": bomb, "word/document.xml": DOCUMENT_XML });
    const error = expectDocumentError(
        () => createDocumentOutline("bomb.docx", bombDocx),
        "limit_exceeded",
    );
    assert.match(error.message, /expansion-ratio/);
});

test("unsafe ZIP member paths are skipped by the archive reader and rejected by the OOXML reader", () => {
    const zip = createZip({
        "../evil": "x",
        "/absolute.txt": "y",
        "C:\\drive.txt": "z",
        "dir\\file.txt": "ok",
        "safe.txt": "ok",
    });
    const outline = createDocumentOutline("traversal.zip", zip);
    assertOutlineShape(outline);
    assert.deepEqual(outline.entries.map(entry => entry.name), ["dir/file.txt", "safe.txt"]);
    assert.deepEqual(outline.entries.map(entry => entry.kind), ["note", "note"]);

    for (const name of ["../word/document.xml", "word/../document.xml", "/word/document.xml", "word\\document.xml"]) {
        const hostile = createZip({ [name]: DOCUMENT_XML });
        expectDocumentError(() => createDocumentOutline("hostile.docx", hostile), "invalid_zip", name);
    }
});

// ---------------------------------------------------------------------------
// 6. TAR / GZIP trailer boundaries.
// ---------------------------------------------------------------------------

test("TAR checksum mismatches and truncated GZIP streams are DocumentErrors", () => {
    const tar = createDocumentOutline("valid.tar", TAR);
    assertOutlineShape(tar);
    assert.equal(tar.entries.length, 2);
    assert.deepEqual(tar.entries.map(entry => entry.kind), ["note", "section"]);

    const corruptChecksum = TAR.slice(0, 512);
    corruptChecksum[0] = 0x42; // mutate the name, leaving the stored checksum stale
    const checksumError = expectDocumentError(
        () => createDocumentOutline("corrupt.tar", corruptChecksum),
        "invalid_document",
    );
    assert.match(checksumError.message, /checksum/);

    expectDocumentError(
        () => createDocumentOutline("header-only.gz", GZIP.slice(0, 8)),
        "invalid_document",
    );
    expectDocumentError(
        () => createDocumentOutline("missing-trailer.gz", GZIP.slice(0, GZIP.length - 8)),
        "invalid_document",
    );
    // Dropping only the ISIZE field makes the reader inspect the last four bytes of the
    // deflate payload as if they were ISIZE; such a truncated stream may therefore be
    // reported as limit_exceeded (budget) or invalid_document (inflate failure).
    const missingIsize = settle(() => createDocumentOutline("missing-isize.gz", GZIP.slice(0, GZIP.length - 4)));
    if (missingIsize instanceof DocumentError) {
        assert.ok(
            missingIsize.code === "invalid_document" || missingIsize.code === "limit_exceeded",
            `missing-isize: unexpected ${missingIsize.code}`,
        );
    } else {
        assert.fail("missing-isize: truncated gzip must not produce an outline");
    }
});

// ---------------------------------------------------------------------------
// 7. CFB header truncation for .max and SolidWorks.
// ---------------------------------------------------------------------------

test("truncated CFB headers are invalid_document for .max and .sldprt", () => {
    for (const length of [8, 64, 200, 511]) {
        const bytes = new Uint8Array(length);
        bytes.set(CFB_SIGNATURE, 0);
        for (const path of ["broken.max", "broken.sldprt"]) {
            expectDocumentError(() => createDocumentOutline(path, bytes), "invalid_document", `${path}@${length}`);
        }
    }
    const signatureOnlyHeader = new Uint8Array(512);
    signatureOnlyHeader.set(CFB_SIGNATURE, 0);
    expectDocumentError(() => createDocumentOutline("broken.max", signatureOnlyHeader), "invalid_document");
});

// ---------------------------------------------------------------------------
// 8. 3DS chunk-length boundaries.
// ---------------------------------------------------------------------------

test("3DS chunk lengths below six bytes or outside their parent are invalid_document", () => {
    const shortMain = chunkWithDeclaredLength(MAIN3DS, new Uint8Array(0), 5);
    expectDocumentError(() => createDocumentOutline("short.3ds", shortMain), "invalid_document");

    const shortChild = chunk(MAIN3DS, chunkWithDeclaredLength(NAMED_OBJECT, Uint8Array.of(0), 5));
    expectDocumentError(() => createDocumentOutline("short-child.3ds", shortChild), "invalid_document");

    const overflowingChild = chunk(MAIN3DS, chunkWithDeclaredLength(NAMED_OBJECT, Uint8Array.of(0), 64));
    expectDocumentError(() => createDocumentOutline("overflow.3ds", overflowingChild), "invalid_document");

    const overflowingMain = chunkWithDeclaredLength(MAIN3DS, Uint8Array.of(0x3d, 0x3d), 100);
    expectDocumentError(() => createDocumentOutline("overflow-main.3ds", overflowingMain), "invalid_document");

    expectDocumentError(
        () => createDocumentOutline("truncated.3ds", THREE_DS.slice(0, THREE_DS.length - 1)),
        "invalid_document",
    );
});

// ---------------------------------------------------------------------------
// 9. DWG version matrix.
// ---------------------------------------------------------------------------

test("DWG version stamps map to section entries, compressed refusals or invalid documents", () => {
    for (const version of ["AC1012", "AC1014", "AC1015"]) {
        const outline = createDocumentOutline("version.dwg", makeDwg(version, Uint8Array.of(1, 2, 3)));
        assertOutlineShape(outline);
        assert.equal(outline.language, "cad");
        assert.equal(outline.entries.length, 1);
        assert.equal(outline.entries[0]!.locator.part, "dwg:sections");
        assert.equal(outline.entries[0]!.locator.paragraph, 1);
    }
    for (const [version, name] of [
        ["AC1018", "R2004"], ["AC1021", "R2007"], ["AC1024", "R2010"],
        ["AC1027", "R2013"], ["AC1032", "R2018"],
    ] as const) {
        const error = expectDocumentError(
            () => createDocumentOutline("compressed.dwg", makeDwg(version)),
            "unsupported_format",
            version,
        );
        assert.match(error.message, new RegExp(name));
        assert.match(error.message, /compressed\/encrypted/);
    }
    for (const version of ["AC9999", "ABCDEF"]) {
        expectDocumentError(
            () => createDocumentOutline("unknown.dwg", makeDwg(version)),
            "invalid_document",
            version,
        );
    }
    expectDocumentError(() => createDocumentOutline("short.dwg", encoder.encode("AC1015")), "invalid_document");
    expectDocumentError(() => createDocumentOutline("short.dwg", encoder.encode("AC")), "invalid_document");
    // A six-byte stamp with the AC15 header but zero sections is a legal empty outline.
    const emptyDwg = createDocumentOutline("empty.dwg", makeDwg("AC1015"));
    assert.deepEqual(emptyDwg.entries, []);
    assert.equal(emptyDwg.truncated, false);
});

// ---------------------------------------------------------------------------
// 10. Supported archive formats and unsupported archive magic.
// ---------------------------------------------------------------------------

test("7z, RAR, XZ, BZ2 and ZST raise unsupported_format through the unified entry", () => {
    const cases: readonly (readonly [string, readonly number[], RegExp])[] = [
        ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], /7z/],
        ["rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], /rar/],
        ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], /xz/],
        ["bz2", [0x42, 0x5a, 0x68], /bzip2/],
        ["zst", [0x28, 0xb5, 0x2f, 0xfd], /zstd/],
    ];
    for (const [extension, magic, label] of cases) {
        const bytes = new Uint8Array(64);
        bytes.set(magic);
        const error = expectDocumentError(
            () => createDocumentOutline(`unsupported.${extension}`, bytes),
            "unsupported_format",
            extension,
        );
        assert.match(error.message, label);
    }
});

// ---------------------------------------------------------------------------
// 11. Truncation fuzzing: every prefix of a valid fixture at the planned strides.
// ---------------------------------------------------------------------------

interface TruncationCase {
    readonly name: string;
    readonly path: string;
    readonly bytes: Uint8Array;
    /** Strides chosen per fixture so the total prefix count stays near 300. */
    readonly strides: readonly number[];
}

/**
 * The requested stride set (1, 7, 16, 64) is covered across the matrix. A fixture
 * only enumerates the strides that fit the ~300-iteration budget, because
 * enumerating every prefix at all four strides for a ZIP package alone would
 * exceed it. Every selected stride walks *all* of its prefixes.
 */
const TRUNCATION_CASES: readonly TruncationCase[] = [
    { name: "DOCX", path: "trunc.docx", bytes: DOCX, strides: [16, 64] },
    { name: "XLSX", path: "trunc.xlsx", bytes: XLSX, strides: [64] },
    { name: "PPTX", path: "trunc.pptx", bytes: PPTX, strides: [64] },
    { name: "PSD", path: "trunc.psd", bytes: PSD, strides: [7, 16] },
    { name: "3DS", path: "trunc.3ds", bytes: THREE_DS, strides: [1, 7] },
    { name: "ZIP", path: "trunc.zip", bytes: ZIP, strides: [1, 7] },
];

test("every truncated prefix yields either a valid outline or a DocumentError", { timeout: 30_000 }, (t) => {
    let cases = 0;
    const coveredStrides = new Set<number>();
    for (const fixture of TRUNCATION_CASES) {
        for (const stride of fixture.strides) {
            coveredStrides.add(stride);
            const lengths: number[] = [];
            for (let length = 0; length <= fixture.bytes.length; length += stride) lengths.push(length);
            if (lengths.at(-1) !== fixture.bytes.length) lengths.push(fixture.bytes.length);
            for (const length of lengths) {
                cases += 1;
                const prefix = fixture.bytes.slice(0, length);
                const result = settle(() => createDocumentOutline(fixture.path, prefix));
                const label = `${fixture.name} prefix ${length}/${fixture.bytes.length}`;
                if (result instanceof DocumentError) {
                    assert.equal(typeof result.code, "string", `${label}: DocumentError needs a code`);
                } else {
                    assertOutlineShape(result);
                }
                if (length === fixture.bytes.length) {
                    assert.equal(result instanceof DocumentError, false, `${label}: the full fixture must parse`);
                }
            }
        }
    }
    assert.ok(cases >= 150, `expected a broad prefix matrix, got ${cases} cases`);
    assert.ok(cases <= 300, `truncation matrix must stay near 300 cases, got ${cases}`);
    assert.deepEqual([...coveredStrides].sort((left, right) => left - right), [1, 7, 16, 64]);
    t.diagnostic(`truncation prefix cases: ${cases}`);
});

// ---------------------------------------------------------------------------
// 12. Deterministic random-byte fuzzing.
// ---------------------------------------------------------------------------

const RANDOM_PATHS: readonly string[] = Object.freeze([
    "a.docx", "a.xlsx", "a.pptx", "a.psd", "a.3ds", "a.zip", "a.doc", "a.xls", "a.ppt", "a.dwg",
]);

/** Fixed-seed linear congruential generator; no ambient randomness is involved. */
function seededSegments(count: number, maxLength: number): readonly Uint8Array[] {
    let state = 0x1357_9bdf;
    const next = (): number => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state;
    };
    const segments: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1) {
        const length = next() % (maxLength + 1);
        const bytes = new Uint8Array(length);
        for (let offset = 0; offset < length; offset += 1) bytes[offset] = next() >>> 24;
        segments.push(bytes);
    }
    return segments;
}

test("200 seeded random byte segments only ever produce outlines or DocumentErrors", { timeout: 60_000 }, (t) => {
    const segments = seededSegments(200, 512);
    assert.equal(segments.length, 200);
    let calls = 0;
    for (const bytes of segments) {
        for (const path of RANDOM_PATHS) {
            calls += 1;
            const result = settle(() => createDocumentOutline(path, bytes));
            if (!(result instanceof DocumentError)) assertOutlineShape(result);
        }
    }
    assert.equal(calls, 200 * RANDOM_PATHS.length);
    t.diagnostic(`random byte outline calls: ${calls}`);
});

// ---------------------------------------------------------------------------
// 13. Budget boundaries.
// ---------------------------------------------------------------------------

test("outline budgets truncate DOCX, PPTX, 3DS and CFB projections without throwing", () => {
    const docxEntriesNone = parseDocx(DOCX, { maxEntriesInOutline: 0 });
    assertOutlineShape(docxEntriesNone);
    assert.deepEqual(docxEntriesNone.entries, []);
    assert.equal(docxEntriesNone.truncated, true);

    const docxEntriesOne = parseDocx(DOCX, { maxEntriesInOutline: 1 });
    assertOutlineShape(docxEntriesOne);
    assert.equal(docxEntriesOne.entries.length, 1);
    assert.equal(docxEntriesOne.entries[0]!.id, "word:paragraph:1");
    assert.equal(docxEntriesOne.truncated, true);

    const docxTextNone = parseDocx(DOCX, { maxTextCharacters: 0 });
    assertOutlineShape(docxTextNone);
    assert.deepEqual(docxTextNone.entries, []);
    assert.equal(docxTextNone.text, "");
    assert.equal(docxTextNone.truncated, true);

    const docxTextOne = parseDocx(DOCX, { maxTextCharacters: 1 });
    assertOutlineShape(docxTextOne);
    assert.equal(docxTextOne.entries.length, 1);
    assert.equal(docxTextOne.entries[0]!.summary, "T");
    assert.equal(docxTextOne.text, "T");
    assert.equal(docxTextOne.truncated, true);

    const pptxEntriesNone = parsePptx(PPTX, { maxEntriesInOutline: 0 });
    assertOutlineShape(pptxEntriesNone);
    assert.deepEqual(pptxEntriesNone.entries, []);
    assert.equal(pptxEntriesNone.truncated, true);

    const pptxEntriesOne = parsePptx(PPTX, { maxEntriesInOutline: 1 });
    assertOutlineShape(pptxEntriesOne);
    assert.equal(pptxEntriesOne.entries.length, 1);
    assert.equal(pptxEntriesOne.entries[0]!.id, "pptx:slide:1");
    assert.equal(pptxEntriesOne.truncated, true);

    const pptxTextNone = parsePptx(PPTX, { maxTextCharacters: 0 });
    assertOutlineShape(pptxTextNone);
    assert.deepEqual(pptxTextNone.entries, []);
    assert.equal(pptxTextNone.truncated, true);

    const pptxTextOne = parsePptx(PPTX, { maxTextCharacters: 1 });
    assertOutlineShape(pptxTextOne);
    assert.equal(pptxTextOne.entries.length, 1);
    assert.equal(pptxTextOne.entries[0]!.summary, "Q");
    assert.equal(pptxTextOne.entries[0]!.name, "Quarterly");
    assert.equal(pptxTextOne.truncated, true);

    const threeDsEntriesNone = parseMax3d(THREE_DS, { maxEntriesInOutline: 0 });
    assertOutlineShape(threeDsEntriesNone);
    assert.deepEqual(threeDsEntriesNone.entries, []);
    assert.equal(threeDsEntriesNone.truncated, true);

    const threeDsEntriesOne = parseMax3d(THREE_DS, { maxEntriesInOutline: 1 });
    assertOutlineShape(threeDsEntriesOne);
    assert.equal(threeDsEntriesOne.entries.length, 1);
    assert.equal(threeDsEntriesOne.entries[0]!.name, "Box");
    assert.equal(threeDsEntriesOne.truncated, true);

    const threeDsTextNone = parseMax3d(THREE_DS, { maxTextCharacters: 0 });
    assertOutlineShape(threeDsTextNone);
    assert.deepEqual(threeDsTextNone.entries, []);
    assert.equal(threeDsTextNone.truncated, true);

    const threeDsTextOne = parseMax3d(THREE_DS, { maxTextCharacters: 1 });
    assertOutlineShape(threeDsTextOne);
    assert.equal(threeDsTextOne.entries.length, 1);
    assert.equal(threeDsTextOne.entries[0]!.summary, "o");
    assert.equal(threeDsTextOne.entries[0]!.name, "Box");
    assert.equal(threeDsTextOne.truncated, true);

    const cfbEntriesNone = parseSolidworks(CFB, { maxEntriesInOutline: 0 });
    assertOutlineShape(cfbEntriesNone);
    assert.deepEqual(cfbEntriesNone.entries, []);
    assert.equal(cfbEntriesNone.truncated, true);

    const cfbEntriesOne = parseSolidworks(CFB, { maxEntriesInOutline: 1 });
    assertOutlineShape(cfbEntriesOne);
    assert.equal(cfbEntriesOne.entries.length, 1);
    assert.equal(cfbEntriesOne.entries[0]!.name, "Data");
    assert.equal(cfbEntriesOne.truncated, true);

    const cfbTextNone = parseSolidworks(CFB, { maxTextCharacters: 0 });
    assertOutlineShape(cfbTextNone);
    assert.deepEqual(cfbTextNone.entries, []);
    assert.equal(cfbTextNone.text, "");
    assert.equal(cfbTextNone.truncated, true);

    const cfbTextOne = parseSolidworks(CFB, { maxTextCharacters: 1 });
    assertOutlineShape(cfbTextOne);
    assert.equal(cfbTextOne.entries.length, 1);
    assert.equal(cfbTextOne.entries[0]!.summary, "R");
    assert.equal(cfbTextOne.text, "R");
    assert.equal(cfbTextOne.truncated, true);
});

test("node and depth budgets raise limit_exceeded for DOCX, PPTX, 3DS and CFB", () => {
    const cases: readonly (readonly [string, () => DocumentOutline])[] = [
        ["docx maxNodes", () => parseDocx(DOCX, { maxNodes: 1 })],
        ["docx maxDepth", () => parseDocx(DOCX, { maxDepth: 1 })],
        ["pptx maxNodes", () => parsePptx(PPTX, { maxNodes: 1 })],
        ["pptx maxDepth", () => parsePptx(PPTX, { maxDepth: 1 })],
        ["3ds maxNodes", () => parseMax3d(THREE_DS, { maxNodes: 1 })],
        ["3ds maxDepth", () => parseMax3d(THREE_DS, { maxDepth: 1 })],
        ["cfb maxNodes", () => parseSolidworks(CFB, { maxNodes: 1 })],
        ["cfb maxDepth", () => parseSolidworks(CFB, { maxDepth: 1 })],
    ];
    for (const [label, operation] of cases) {
        expectDocumentError(operation, "limit_exceeded", label);
    }
});

// ---------------------------------------------------------------------------
// 14. Immutability of every supported outline.
// ---------------------------------------------------------------------------

test("entries, each entry and each locator are frozen for every supported container", () => {
    const outlines: readonly DocumentOutline[] = [
        createDocumentOutline("frozen.docx", DOCX),
        createDocumentOutline("frozen.xlsx", XLSX),
        createDocumentOutline("frozen.pptx", PPTX),
        createDocumentOutline("frozen.psd", PSD),
        createDocumentOutline("frozen.psb", PSB),
        createDocumentOutline("frozen.dxf", DXF),
        createDocumentOutline("frozen.dwg", DWG_R13),
        createDocumentOutline("frozen.3ds", THREE_DS),
        createDocumentOutline("frozen.max", CFB),
        createDocumentOutline("frozen.sldprt", CFB),
        createDocumentOutline("frozen.zip", ZIP),
        createDocumentOutline("frozen.tar", TAR),
        createDocumentOutline("frozen.gz", GZIP),
        createDocumentOutline("frozen.tar.gz", TAR_GZ),
    ];
    for (const outline of outlines) {
        assert.equal(Object.isFrozen(outline), true);
        assert.equal(Object.isFrozen(outline.entries), true);
        for (const entry of outline.entries) {
            assert.equal(Object.isFrozen(entry), true, `entry ${entry.id} must be frozen`);
            assert.equal(Object.isFrozen(entry.locator), true, `locator of ${entry.id} must be frozen`);
        }
    }
});

// Keep the PSD parser import exercised directly as well: parsePsd has its own
// TypeError guard, and the truncation matrix relies on parse* forwarding limits.
test("direct parser entry points reject non-byte input with TypeError", () => {
    assert.throws(() => parsePsd("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseMax3d("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseSolidworks("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parseDocx("not bytes" as unknown as Uint8Array), TypeError);
    assert.throws(() => parsePptx("not bytes" as unknown as Uint8Array), TypeError);
});
