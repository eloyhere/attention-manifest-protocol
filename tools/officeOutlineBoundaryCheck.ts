#!/usr/bin/env node
/**
 * Office outline boundary checks.
 *
 * The Office outline path has three layers: `office.ts` sniffs a container,
 * `officeOutlineParser` projects its sections onto outline nodes, and
 * `OutlineRegistry.buildOffice` installs that parser and anchors the result.
 * This file probes the edges of all three: empty, truncated, spanned,
 * encrypted, duplicated, ZIP64 and zip-bomb packages, CFB and Jet/ACE headers,
 * container magic that contradicts the extension, label/entity/path edges,
 * range nesting and coverage, node budgets, and the parser-slot lifecycle.
 *
 * Every fixture is a real container built in memory and written to a private
 * temporary directory; nothing is executed and the directory is removed after
 * the run. Assertions use the public `buildOutline` entry point unless a test
 * names the Office reader directly.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { buildDirectoryNode } from "../src/file/directory.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { buildFileNode } from "../src/file/file.ts";
import { buildOutline } from "../src/outline/outline.ts";
import { installOfficeOutlineParser, parseOffice as readOfficeDocument } from "../src/outline/office.ts";
import { parseOffice, registerOfficeOutlineParser } from "../src/outline/outlineStrategies.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OfficeDocument } from "../src/outline/office.ts";
import type { DirectoryNode } from "../src/file/types.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

/**
 * Private fixture root for this run.
 */
const Root: string = mkdtempSync(join(tmpdir(), "amp-office-boundary-"));
const RootSpec: SessionRoot = { id: "root.office.boundary", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

after((): void => {
    rmSync(Root, { recursive: true, force: true });
});

/**
 * Write one fixture, creating intermediate directories.
 */
const fixture: (relative: string, content: string | Uint8Array) => void = (relative: string, content: string | Uint8Array): void => {
    const absolute: string = join(Root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
};

/**
 * Build the outline of one fixture through the public entry point.
 */
const outline: (path: string) => OutlineResult = (path: string): OutlineResult => buildOutline(Sandbox, path);

/**
 * Preorder flattening of an outline tree.
 */
const flatten: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] => {
    const result: OutlineNode[] = [];
    for (let index: number = 0; index < nodes.length; index += 1) {
        result.push(nodes[index]);
        const children: OutlineNode[] = flatten(nodes[index].children);
        for (let childIndex: number = 0; childIndex < children.length; childIndex += 1) {
            result.push(children[childIndex]);
        }
    }
    return result;
};

/**
 * Labels of a node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

/**
 * Little-endian 16-bit write.
 */
const writeU16: (target: Uint8Array, offset: number, value: number) => void = (target: Uint8Array, offset: number, value: number): void => {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
};

/**
 * Little-endian 32-bit write.
 */
const writeU32: (target: Uint8Array, offset: number, value: number) => void = (target: Uint8Array, offset: number, value: number): void => {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
};

/**
 * UTF-8 encode a string.
 */
const utf8: (value: string) => Uint8Array = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * UTF-16LE encode a string.
 */
const utf16le: (value: string) => Uint8Array = (value: string): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(value.length * 2);
    for (let index: number = 0; index < value.length; index += 1) {
        writeU16(bytes, index * 2, value.charCodeAt(index));
    }
    return bytes;
};

/**
 * Concatenate byte slices.
 */
const concatBytes: (chunks: readonly Uint8Array[]) => Uint8Array = (chunks: readonly Uint8Array[]): Uint8Array => {
    let total: number = 0;
    for (let index: number = 0; index < chunks.length; index += 1) {
        total += chunks[index].length;
    }
    const output: Uint8Array = new Uint8Array(total);
    let offset: number = 0;
    for (let index: number = 0; index < chunks.length; index += 1) {
        output.set(chunks[index], offset);
        offset += chunks[index].length;
    }
    return output;
};

/**
 * One ZIP member. `stored` members carry their bytes verbatim; a `deflated`
 * member compresses them and may declare a different uncompressed size.
 */
interface ZipMember {
    readonly name: string;
    readonly text: string;
    readonly deflated?: boolean;
    readonly declaredUncompressed?: number;
}

/**
 * ZIP container options that model a malformed or hostile package.
 */
interface ZipOptions {
    readonly encrypted?: boolean;
    readonly zip64EntryCount?: boolean;
    readonly trailingBytes?: number;
}

/**
 * Build a ZIP archive, optionally with the defects the reader must survive.
 *
 * Stored entries use method 0; `deflated` entries use method 8 through
 * `node:zlib`, which is how a zip-bomb fixture declares a huge uncompressed
 * size behind a tiny payload. The central directory is authoritative, so a
 * size mismatch between local and central headers is deliberate in the
 * malformed cases.
 *
 * @param members - Archive members.
 * @param options - Malformed-container switches.
 * @returns Complete archive bytes.
 */
const zipOf: (members: readonly ZipMember[], options?: ZipOptions) => Uint8Array = (
    members: readonly ZipMember[],
    options: ZipOptions = {},
): Uint8Array => {
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset: number = 0;
    const flags: number = 0x0800 | (options.encrypted === true ? 0x0001 : 0);
    for (let index: number = 0; index < members.length; index += 1) {
        const member: ZipMember = members[index];
        const name: Uint8Array = utf8(member.name);
        const raw: Uint8Array = utf8(member.text);
        const payload: Uint8Array = member.deflated === true ? new Uint8Array(deflateRawSync(raw)) : raw;
        const method: number = member.deflated === true ? 8 : 0;
        const declared: number = member.declaredUncompressed ?? raw.length;
        const local: Uint8Array = new Uint8Array(30 + name.length + payload.length);
        writeU32(local, 0, 0x04034b50);
        writeU16(local, 4, 20);
        writeU16(local, 6, flags);
        writeU16(local, 8, method);
        writeU16(local, 10, 0);
        writeU16(local, 12, 0);
        writeU32(local, 14, 0);
        writeU32(local, 18, payload.length);
        writeU32(local, 22, declared);
        writeU16(local, 26, name.length);
        writeU16(local, 28, 0);
        local.set(name, 30);
        local.set(payload, 30 + name.length);
        const central: Uint8Array = new Uint8Array(46 + name.length);
        writeU32(central, 0, 0x02014b50);
        writeU16(central, 4, 20);
        writeU16(central, 6, 20);
        writeU16(central, 8, flags);
        writeU16(central, 10, method);
        writeU16(central, 12, 0);
        writeU16(central, 14, 0);
        writeU32(central, 16, 0);
        writeU32(central, 20, payload.length);
        writeU32(central, 24, declared);
        writeU16(central, 28, name.length);
        writeU16(central, 30, 0);
        writeU16(central, 32, 0);
        writeU16(central, 34, 0);
        writeU16(central, 36, 0);
        writeU32(central, 38, 0);
        writeU32(central, 42, offset);
        central.set(name, 46);
        locals.push(local);
        centrals.push(central);
        offset += local.length;
    }
    const centralBytes: Uint8Array = concatBytes(centrals);
    const eocd: Uint8Array = new Uint8Array(22 + (options.trailingBytes ?? 0));
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, options.zip64EntryCount === true ? 0xffff : members.length);
    writeU16(eocd, 10, options.zip64EntryCount === true ? 0xffff : members.length);
    writeU32(eocd, 12, centralBytes.length);
    writeU32(eocd, 16, offset);
    writeU16(eocd, 20, options.trailingBytes ?? 0);
    return concatBytes([...locals, centralBytes, eocd]);
};

/**
 * Build a minimal CFB container with one stream in the mini stream.
 *
 * @param streamName - Directory entry name.
 * @param payload - Stream bytes (at most 64).
 * @returns Complete container bytes.
 */
const cfbOf: (streamName: string, payload: Uint8Array) => Uint8Array = (streamName: string, payload: Uint8Array): Uint8Array => {
    const sectorSize: number = 512;
    const buffer: Uint8Array = new Uint8Array(sectorSize * 5);
    const signature: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (let index: number = 0; index < signature.length; index += 1) {
        buffer[index] = signature[index];
    }
    writeU16(buffer, 24, 0x003e);
    writeU16(buffer, 26, 3);
    writeU16(buffer, 28, 0xfffe);
    writeU16(buffer, 30, 9);
    writeU16(buffer, 32, 6);
    writeU32(buffer, 44, 1);
    writeU32(buffer, 48, 1);
    writeU32(buffer, 56, 4096);
    writeU32(buffer, 60, 2);
    writeU32(buffer, 64, 1);
    writeU32(buffer, 68, 0xfffffffe);
    for (let index: number = 0; index < 109; index += 1) {
        writeU32(buffer, 76 + index * 4, index === 0 ? 0 : 0xffffffff);
    }
    const fatBase: number = sectorSize;
    for (let index: number = 0; index < sectorSize / 4; index += 1) {
        writeU32(buffer, fatBase + index * 4, 0xffffffff);
    }
    writeU32(buffer, fatBase + 0, 0xfffffffd);
    writeU32(buffer, fatBase + 4, 0xfffffffe);
    writeU32(buffer, fatBase + 8, 0xfffffffe);
    writeU32(buffer, fatBase + 12, 0xfffffffe);
    const directoryBase: number = sectorSize * 2;
    const writeEntry: (offset: number, name: string, type: number, start: number, size: number, child: number) => void = (
        offset: number,
        name: string,
        type: number,
        start: number,
        size: number,
        child: number,
    ): void => {
        const nameBytes: Uint8Array = utf16le(name);
        buffer.set(nameBytes, offset);
        writeU16(buffer, offset + 64, nameBytes.length + 2);
        buffer[offset + 66] = type;
        buffer[offset + 67] = 1;
        writeU32(buffer, offset + 68, 0xffffffff);
        writeU32(buffer, offset + 72, 0xffffffff);
        writeU32(buffer, offset + 76, child);
        writeU32(buffer, offset + 116, start);
        writeU32(buffer, offset + 120, size);
    };
    writeEntry(directoryBase, "Root Entry", 5, 3, Math.max(64, payload.length), 1);
    writeEntry(directoryBase + 128, streamName, 2, 0, payload.length, 0xffffffff);
    const miniFatBase: number = sectorSize * 3;
    for (let index: number = 0; index < sectorSize / 4; index += 1) {
        writeU32(buffer, miniFatBase + index * 4, 0xffffffff);
    }
    writeU32(buffer, miniFatBase, 0xfffffffe);
    buffer.set(payload, sectorSize * 4);
    return buffer;
};

/**
 * Build a Jet/ACE database image with optional catalog names.
 *
 * @param engine - `Standard ACE DB` or `Standard Jet DB`.
 * @param names - Catalog names written as UTF-16LE runs after the first page.
 * @returns Complete database bytes.
 */
const accessBytes: (engine: string, names: readonly string[]) => Uint8Array = (engine: string, names: readonly string[]): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(16384);
    bytes[0] = 0x00;
    bytes[1] = 0x01;
    bytes[2] = 0x00;
    bytes[3] = 0x00;
    bytes.set(utf8(engine), 4);
    for (let index: number = 0; index < names.length; index += 1) {
        bytes.set(utf16le(names[index]), 8192 + index * 96);
    }
    return bytes;
};

/**
 * WordprocessingML heading paragraph.
 */
const heading: (text: string, level: number) => string = (text: string, level: number): string =>
    `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

/**
 * WordprocessingML body paragraph.
 */
const paragraph: (text: string) => string = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

/**
 * Complete WordprocessingML document from paragraph fragments.
 */
const wordDocument: (fragments: readonly string[]) => string = (fragments: readonly string[]): string =>
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${fragments.join("")}</w:body></w:document>`;

/**
 * One `.docx` package around a WordprocessingML body.
 */
const docxOf: (body: string) => Uint8Array = (body: string): Uint8Array => zipOf([{ name: "word/document.xml", text: body }]);

/**
 * A six-section Word document: two top-level headings, a nested heading, and a
 * paragraph under each top-level heading.
 */
const HierarchyBody: string = wordDocument([
    heading("Top", 1),
    paragraph("intro"),
    heading("Middle", 2),
    heading("Leaf", 3),
    heading("Second Top", 1),
    paragraph("end"),
]);

/**
 * SpreadsheetML workbook from a `sheets`/`definedNames` fragment.
 */
const workbookOf: (inner: string) => Uint8Array = (inner: string): Uint8Array =>
    zipOf([
        {
            name: "xl/workbook.xml",
            text: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${inner}</workbook>`,
        },
    ]);

/**
 * Assert that a fixture yields an office-strategy anchor with no symbols and
 * does not throw.
 */
const assertEmptyOfficeOutline: (path: string, content: string | Uint8Array) => OutlineResult = (
    path: string,
    content: string | Uint8Array,
): OutlineResult => {
    fixture(path, content);
    const result: OutlineResult = outline(path);
    assert.equal(result.strategy, "office", `${path}: strategy`);
    assert.equal(result.category, "data", `${path}: category`);
    assert.equal(result.language, "office", `${path}: language`);
    assert.equal(result.target, "file", `${path}: target`);
    assert.equal(result.nodes.length, 1, `${path}: one anchor`);
    assert.equal(result.nodes[0].isFile, true, `${path}: anchor is a file`);
    assert.equal(result.nodes[0].children.length, 0, `${path}: no symbols`);
    return result;
};

test("an empty ZIP package is recognized as OOXML and yields an empty word document", (): void => {
    const emptyZip: Uint8Array = new Uint8Array(22);
    writeU32(emptyZip, 0, 0x06054b50);
    fixture("edge/empty.docx", emptyZip);
    const document: OfficeDocument = readOfficeDocument(Sandbox, "edge/empty.docx");
    assert.equal(document.format, "ooxml");
    assert.equal(document.kind, "word");
    assert.equal(document.sections.length, 0);
    assert.equal(document.warnings.some((warning: string): boolean => warning.includes("word/document.xml")), true);
    assertEmptyOfficeOutline("edge/empty.docx", emptyZip);
});

test("a spanned-archive start marker is treated as a ZIP package rather than an unknown container", (): void => {
    const spanned: Uint8Array = new Uint8Array(64);
    spanned[0] = 0x50;
    spanned[1] = 0x4b;
    spanned[2] = 0x07;
    spanned[3] = 0x08;
    fixture("edge/spanned.docx", spanned);
    const document: OfficeDocument = readOfficeDocument(Sandbox, "edge/spanned.docx");
    assert.equal(document.format, "ooxml");
    assert.equal(document.kind, "word");
    assert.equal(document.sections.length, 0);
    assertEmptyOfficeOutline("edge/spanned.docx", spanned);
});

test("zero-byte, textual and tiny Office files yield an anchor without throwing", (): void => {
    const tinyMdb: Uint8Array = new Uint8Array(20);
    tinyMdb[0] = 0x00;
    tinyMdb[1] = 0x01;
    tinyMdb[2] = 0x00;
    tinyMdb[3] = 0x00;
    tinyMdb.set(utf8("Standard Jet DB"), 4);
    const cases: readonly { readonly path: string; readonly content: string | Uint8Array; readonly kind: string; }[] = [
        { path: "edge/zero.docx", content: new Uint8Array(0), kind: "unknown" },
        { path: "edge/text.docx", content: "not a container", kind: "unknown" },
        { path: "edge/tiny.doc", content: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), kind: "unknown" },
        { path: "edge/tiny.mdb", content: tinyMdb, kind: "unknown" },
    ];
    for (let index: number = 0; index < cases.length; index += 1) {
        const spec: { readonly path: string; readonly content: string | Uint8Array; readonly kind: string; } = cases[index];
        fixture(spec.path, spec.content);
        const document: OfficeDocument = readOfficeDocument(Sandbox, spec.path);
        assert.equal(document.format, "unknown", `${spec.path}: format`);
        assert.equal(document.kind, spec.kind, `${spec.path}: kind`);
        assert.equal(document.sections.length, 0, `${spec.path}: sections`);
        assertEmptyOfficeOutline(spec.path, spec.content);
    }
});

test("container magic wins over the extension in both directions", (): void => {
    const zipInDoc: Uint8Array = docxOf(wordDocument([heading("Zip In Doc", 1)]));
    fixture("edge/zip-in-doc.doc", zipInDoc);
    const zipDocument: OfficeDocument = readOfficeDocument(Sandbox, "edge/zip-in-doc.doc");
    assert.equal(zipDocument.format, "ooxml");
    assert.equal(zipDocument.kind, "word");
    assert.equal(zipDocument.sections[0].label, "Zip In Doc");
    assert.equal(outline("edge/zip-in-doc.doc").nodes[0].children[0].label, "Zip In Doc");
    const cfbInDocx: Uint8Array = cfbOf("WordDocument", utf16le("Cfb In Docx"));
    fixture("edge/cfb-in-docx.docx", cfbInDocx);
    const cfbDocument: OfficeDocument = readOfficeDocument(Sandbox, "edge/cfb-in-docx.docx");
    assert.equal(cfbDocument.format, "ole");
    assert.equal(cfbDocument.kind, "word");
    assert.equal(cfbDocument.sections[0].label, "Word document");
    assert.equal(outline("edge/cfb-in-docx.docx").nodes[0].children[0].label, "Word document");
});

test("broken ZIP packages degrade to a warning plus an anchor", (): void => {
    const document: string = wordDocument([heading("Broken", 1)]);
    const truncated: Uint8Array = zipOf([{ name: "word/document.xml", text: document }]).slice(0, -5);
    const duplicate: Uint8Array = zipOf([
        { name: "word/document.xml", text: document },
        { name: "word/document.xml", text: document },
    ]);
    const encrypted: Uint8Array = zipOf([{ name: "word/document.xml", text: document }], { encrypted: true });
    const zip64: Uint8Array = zipOf([{ name: "word/document.xml", text: document }], { zip64EntryCount: true });
    const cases: readonly { readonly path: string; readonly content: Uint8Array; }[] = [
        { path: "edge/truncated.docx", content: truncated },
        { path: "edge/duplicate.docx", content: duplicate },
        { path: "edge/encrypted.docx", content: encrypted },
        { path: "edge/zip64.docx", content: zip64 },
    ];
    for (let index: number = 0; index < cases.length; index += 1) {
        const spec: { readonly path: string; readonly content: Uint8Array; } = cases[index];
        fixture(spec.path, spec.content);
        const parsed: OfficeDocument = readOfficeDocument(Sandbox, spec.path);
        assert.equal(parsed.format, "ooxml", `${spec.path}: magic`);
        assert.equal(parsed.sections.length, 0, `${spec.path}: sections`);
        assert.equal(parsed.warnings.length > 0, true, `${spec.path}: warnings`);
        assertEmptyOfficeOutline(spec.path, spec.content);
    }
});

test("broken CFB and Access headers degrade to a warning plus an anchor", (): void => {
    const cfbHeaderOnly: Uint8Array = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    fixture("edge/header.doc", cfbHeaderOnly);
    const word: OfficeDocument = readOfficeDocument(Sandbox, "edge/header.doc");
    assert.equal(word.format, "ole");
    assert.equal(word.kind, "word");
    assert.equal(word.sections.length, 0);
    assert.equal(word.warnings.length > 0, true);
    assertEmptyOfficeOutline("edge/header.doc", cfbHeaderOnly);
    const tinyAccess: Uint8Array = new Uint8Array(20);
    tinyAccess[0] = 0x00;
    tinyAccess[1] = 0x01;
    tinyAccess[2] = 0x00;
    tinyAccess[3] = 0x00;
    tinyAccess.set(utf8("Standard ACE DB"), 4);
    fixture("edge/tiny.accdb", tinyAccess);
    assert.equal(readOfficeDocument(Sandbox, "edge/tiny.accdb").kind, "unknown");
    assertEmptyOfficeOutline("edge/tiny.accdb", tinyAccess);
});

test("a zip bomb is refused with quota_exceeded instead of expanding", (): void => {
    const bomb: Uint8Array = zipOf([{ name: "word/document.xml", text: "x", deflated: true, declaredUncompressed: 0x7fffffff }]);
    fixture("edge/bomb.docx", bomb);
    assert.throws(
        (): OutlineResult => outline("edge/bomb.docx"),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "quota_exceeded",
    );
});

test("office results keep their metadata and anchor contract", (): void => {
    const bytes: Uint8Array = docxOf(wordDocument([heading("Quarterly Report", 1), paragraph("Revenue grew.")]));
    fixture("edge/report.docx", bytes);
    const result: OutlineResult = outline("edge/report.docx");
    assert.equal(result.strategy, "office");
    assert.equal(result.category, "data");
    assert.equal(result.language, "office");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "binary");
    assert.equal(result.truncated, false);
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "edge/report.docx");
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(bytes.length));
    assert.deepEqual(labels(anchor.children), ["Quarterly Report"]);
    const all: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assert.ok(node.label.length > 0, "label");
        assert.equal(typeof(node.range.startLine), "bigint", "bigint startLine");
        assert.equal(typeof(node.range.endByte), "bigint", "bigint endByte");
        assert.ok(node.range.startLine <= node.range.endLine, "line order");
        assert.ok(node.range.startByte <= node.range.endByte, "byte order");
        assert.ok(node.range.endByte <= BigInt(bytes.length), "byte ceiling");
        if (node.isFile !== true) {
            assert.ok(node.path.startsWith("edge/report.docx#"), "symbol path");
        }
    }
});

test("office hierarchy ranges nest, stay monotonic and cover the container", (): void => {
    const bytes: Uint8Array = docxOf(HierarchyBody);
    fixture("edge/hierarchy.docx", bytes);
    const result: OutlineResult = outline("edge/hierarchy.docx");
    const top: OutlineNode = result.nodes[0].children[0];
    const second: OutlineNode = result.nodes[0].children[1];
    assert.deepEqual(labels(result.nodes[0].children), ["Top", "Second Top"]);
    assert.deepEqual(labels(top.children), ["intro", "Middle"]);
    assert.deepEqual(labels(top.children[1].children), ["Leaf"]);
    assert.equal(top.range.startLine, 1n);
    assert.equal(top.range.endLine, 4n);
    assert.equal(second.range.startLine, 5n);
    assert.equal(second.range.endLine, 6n);
    assert.equal(second.children[0].range.startLine, 6n);
    assert.equal(top.range.startByte, 0n);
    assert.equal(second.range.endByte, BigInt(bytes.length));
    const flat: OutlineNode[] = flatten(result.nodes[0].children);
    let previousStart: bigint = 0n;
    for (let index: number = 0; index < flat.length; index += 1) {
        const node: OutlineNode = flat[index];
        assert.ok(node.range.startByte >= previousStart, `${node.label}: monotonic start`);
        previousStart = node.range.startByte;
        for (let childIndex: number = 0; childIndex < node.children.length; childIndex += 1) {
            const child: OutlineNode = node.children[childIndex];
            assert.ok(child.range.startLine >= node.range.startLine, `${child.label}: line start inside parent`);
            assert.ok(child.range.endLine <= node.range.endLine, `${child.label}: line end inside parent`);
            assert.ok(child.range.startByte >= node.range.startByte, `${child.label}: byte start inside parent`);
            assert.ok(child.range.endByte <= node.range.endByte, `${child.label}: byte end inside parent`);
        }
    }
});

test("docx labels decode entities, join runs and stay within the label bound", (): void => {
    const long: string = "x".repeat(250);
    const body: string = wordDocument([
        heading("A &amp; B &#8212; C", 1),
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Split</w:t></w:r><w:r><w:tab/><w:t>Label</w:t></w:r></w:p>',
        heading(long, 1),
    ]);
    fixture("edge/labels.docx", docxOf(body));
    const result: OutlineResult = outline("edge/labels.docx");
    assert.deepEqual(labels(flatten(result.nodes[0].children)), ["A & B — C", "SplitLabel", "x".repeat(200)]);
    assert.equal(result.nodes[0].children[0].children[0].label, "SplitLabel");
});

test("office symbol paths escape the anchor separators", (): void => {
    fixture("edge/paths.docx", docxOf(wordDocument([heading("A &amp; B #1 100% a/b", 1)])));
    const result: OutlineResult = outline("edge/paths.docx");
    const node: OutlineNode = result.nodes[0].children[0];
    assert.equal(node.label, "A & B #1 100% a/b");
    assert.equal(node.path, "edge/paths.docx#A & B %231 100%25 a%2Fb");
});

test("office node budgets truncate explicitly and duplicate labels receive distinct paths", (): void => {
    const many: string[] = [];
    for (let index: number = 0; index < 2100; index += 1) {
        many.push(heading(`Heading ${index}`, 1));
    }
    fixture("edge/many.docx", docxOf(wordDocument(many)));
    const capped: OutlineResult = outline("edge/many.docx");
    assert.equal(capped.truncated, true);
    assert.equal(capped.nodes[0].children.length, 1999);
    const small: OutlineResult = buildOutline(Sandbox, "edge/many.docx", { maxNodes: 3 });
    assert.equal(small.truncated, true);
    assert.equal(flatten(small.nodes).length, 3);
    fixture("edge/duplicate.docx", docxOf(wordDocument([heading("Same", 1), heading("Same", 1)])));
    const duplicate: OutlineResult = outline("edge/duplicate.docx");
    assert.deepEqual(labels(duplicate.nodes[0].children), ["Same", "Same"]);
    assert.notEqual(duplicate.nodes[0].children[0].path, duplicate.nodes[0].children[1].path);
});

test("xlsx sheets fall back to a synthetic name and a sheetless workbook stays empty", (): void => {
    fixture("edge/noname.xlsx", workbookOf("<sheets><sheet sheetId=\"1\"/></sheets>"));
    const unnamed: OutlineResult = outline("edge/noname.xlsx");
    assert.deepEqual(labels(unnamed.nodes[0].children), ["Sheet 1"]);
    fixture("edge/nosheet.xlsx", workbookOf("<sheets/>"));
    const sheetless: OutlineResult = outline("edge/nosheet.xlsx");
    assert.equal(sheetless.nodes[0].children.length, 0);
});

test("pptx slides stay numbered when a slide part is missing and keep numeric order", (): void => {
    const missing: Uint8Array = zipOf([{ name: "ppt/slides/slide1.xml", text: "" }]);
    fixture("edge/missing.pptx", missing);
    assert.deepEqual(labels(outline("edge/missing.pptx").nodes[0].children), ["Slide 1"]);
    const ordered: Uint8Array = zipOf([
        { name: "ppt/slides/slide10.xml", text: "" },
        { name: "ppt/slides/slide2.xml", text: "" },
    ]);
    fixture("edge/ordered.pptx", ordered);
    assert.deepEqual(labels(outline("edge/ordered.pptx").nodes[0].children), ["Slide 2", "Slide 10"]);
});

test("legacy .doc with an empty WordDocument stream yields no sections", (): void => {
    const emptyStream: Uint8Array = cfbOf("WordDocument", new Uint8Array(0));
    fixture("edge/empty.doc", emptyStream);
    const document: OfficeDocument = readOfficeDocument(Sandbox, "edge/empty.doc");
    assert.equal(document.format, "ole");
    assert.equal(document.kind, "word");
    assert.equal(document.sections.length, 0);
    assertEmptyOfficeOutline("edge/empty.doc", emptyStream);
});

test("legacy .xls BIFF sheet names become sheet sections", (): void => {
    const sheetName: string = "Budget";
    const record: Uint8Array = new Uint8Array(12 + sheetName.length * 2);
    writeU16(record, 0, 0x0085);
    writeU16(record, 2, 8 + sheetName.length * 2);
    record[10] = sheetName.length;
    record[11] = 0x01;
    record.set(utf16le(sheetName), 12);
    fixture("edge/legacy.xls", cfbOf("Workbook", record));
    const result: OutlineResult = outline("edge/legacy.xls");
    assert.deepEqual(labels(result.nodes[0].children), ["Budget", "Workbook text"]);
});

test("office files over the outline byte ceiling are refused with quota_exceeded", (): void => {
    fixture("edge/huge.docx", new Uint8Array(4 * 1024 * 1024 + 1));
    assert.throws(
        (): OutlineResult => outline("edge/huge.docx"),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "quota_exceeded",
    );
});

test("the office parser slot can be reinstalled after a host clears it", (): void => {
    const bytes: Uint8Array = docxOf(wordDocument([heading("Reinstall Probe", 1)]));
    fixture("edge/slot.docx", bytes);
    assert.equal(outline("edge/slot.docx").nodes[0].children.length, 1);
    registerOfficeOutlineParser(undefined);
    assert.deepEqual(parseOffice({ path: "edge/slot.docx", bytes }), []);
    const restored: OutlineResult = outline("edge/slot.docx");
    assert.equal(restored.nodes[0].children.length, 1);
    assert.equal(restored.nodes[0].children[0].label, "Reinstall Probe");
    assert.equal(parseOffice({ path: "edge/slot.docx", bytes }).length, 1);
    installOfficeOutlineParser();
});

test("a host parser registered before the first office build is not overwritten", (): void => {
    const bytes: Uint8Array = docxOf(wordDocument([heading("Built In", 1)]));
    const host: OutlineNode = {
        isFile: false,
        isDirectory: false,
        path: "",
        type: "section",
        range: { startByte: 0n, endByte: 0n, startLine: 1n, endLine: 1n },
        label: "Host Section",
        depth: 0,
        children: [],
    };
    registerOfficeOutlineParser((): OutlineNode[] => [host]);
    try {
        const result: OutlineResult = outline("edge/slot.docx");
        assert.deepEqual(labels(result.nodes[0].children), ["Host Section"]);
        assert.equal(result.strategy, "office");
    } finally {
        registerOfficeOutlineParser(undefined);
    }
    const restored: OutlineResult = outline("edge/slot.docx");
    assert.deepEqual(labels(restored.nodes[0].children), ["Reinstall Probe"]);
});

test("directory symbol expansion skips binary Office children instead of failing", (): void => {
    const directory: DirectoryNode = buildDirectoryNode("edge", [buildFileNode(RootSpec, "edge/report.docx")]);
    const result: OutlineResult = buildOutline(Sandbox, "edge", { anchor: { directory }, symbols: true });
    assert.equal(result.target, "directory");
    assert.deepEqual(labels(result.nodes[0].children), ["report.docx"]);
    assert.equal(result.nodes[0].children[0].children.length, 0);
});
