#!/usr/bin/env node
/**
 * Focused checks for Office container parsing and the Office outline bridge.
 *
 * Every OOXML fixture is a small ZIP built by this file; every CFB fixture is a
 * minimal header/FAT/directory/mini-stream image built by this file. No
 * third-party archive library is used, so the tests exercise the same parsing
 * path the runtime uses.
 *
 * The suite covers stored and deflated ZIP entries, Word headings/paragraphs,
 * Excel sheets/tables/named ranges/formulas/external links, PowerPoint slide
 * order and placeholders, the synthetic Office outline ranges, corrupt
 * containers, a minimal legacy CFB document and the `buildOutline` strategy
 * hand-off. Temporary fixtures are removed after the last test.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { readCfb } from "../src/file/cfb.ts";
import type { CfbEntry } from "../src/file/cfb.ts";
import { FilesystemError } from "../src/file/errors.ts";
import {
    installOfficeOutlineParser,
    isOfficeFile,
    OfficeMaxOutlineBytes,
    officeExports,
    officeImports,
    officeOutlineParser,
    parseOffice,
} from "../src/outline/office.ts";
import type { OfficeDocument, OfficeReference, OfficeSection } from "../src/outline/office.ts";
import { buildOutline } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import { FilesystemService } from "../src/file/service.ts";
import type { FilesystemSession } from "../src/file/service.ts";
import type { ExportReport, ExportSymbol, ImportReport } from "../src/file/types.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import { readZipEntries, zipText } from "../src/file/zip.ts";
import { rawDigest } from "../src/fingerprint/raw.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import type { SessionRoot } from "../src/session/types.ts";

const RootPath: string = mkdtempSync(join(tmpdir(), "amp-office-check-"));
const Root: SessionRoot = { id: "root", path: RootPath, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([Root]);

after((): void => {
    rmSync(RootPath, { recursive: true, force: true });
});

const writeFixture: (name: string, bytes: Uint8Array) => void = (name: string, bytes: Uint8Array): void => {
    writeFileSync(join(RootPath, name), bytes);
};

const text: (value: string) => Uint8Array = (value: string): Uint8Array => new TextEncoder().encode(value);

const writeU16: (buffer: Buffer, offset: number, value: number) => void = (buffer: Buffer, offset: number, value: number): void => {
    buffer.writeUInt16LE(value & 0xffff, offset);
};

const writeU32: (buffer: Buffer, offset: number, value: number) => void = (buffer: Buffer, offset: number, value: number): void => {
    buffer.writeUInt32LE(value >>> 0, offset);
};

const CrcTable: Uint32Array = ((): Uint32Array => {
    const table: Uint32Array = new Uint32Array(256);
    for (let index: number = 0; index < 256; index += 1) {
        let value: number = index;
        for (let bit: number = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

const crc32: (bytes: Uint8Array) => number = (bytes: Uint8Array): number => {
    let crc: number = 0xffffffff;
    for (let index: number = 0; index < bytes.length; index += 1) {
        crc = (crc >>> 8) ^ CrcTable[(crc ^ bytes[index]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
};

/**
 * One archive entry for the local builder. Overrides exist only so the test can
 * create deliberately invalid central-directory records.
 */
interface ZipSpec {
    readonly name: string;
    readonly data: string | Uint8Array;
    readonly method?: number;
    readonly flags?: number;
    readonly compressedOverride?: number;
    readonly uncompressedOverride?: number;
    readonly localOffsetOverride?: number;
}

/**
 * Build a valid ZIP archive with stored or deflated entries. The central
 * directory is the source of truth for sizes and offsets; a caller can corrupt
 * one field through the overrides.
 */
const buildZip: (specs: readonly ZipSpec[]) => Uint8Array = (specs: readonly ZipSpec[]): Uint8Array => {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let localOffset: number = 0;
    for (let index: number = 0; index < specs.length; index += 1) {
        const spec: ZipSpec = specs[index];
        const data: Uint8Array = typeof(spec.data) === "string" ? text(spec.data) : spec.data;
        const method: number = spec.method ?? 0;
        const payload: Uint8Array = method === 8 ? deflateRawSync(data) : data;
        const name: Buffer = Buffer.from(spec.name, "utf8");
        const flags: number = spec.flags ?? 0;
        const crc: number = crc32(data);
        const local: Buffer = Buffer.alloc(30);
        writeU32(local, 0, 0x04034b50);
        writeU16(local, 4, 20);
        writeU16(local, 6, flags);
        writeU16(local, 8, method);
        writeU16(local, 10, 0);
        writeU16(local, 12, 0);
        writeU32(local, 14, crc);
        writeU32(local, 18, payload.length);
        writeU32(local, 22, data.length);
        writeU16(local, 26, name.length);
        writeU16(local, 28, 0);
        localParts.push(local, name, Buffer.from(payload));
        const central: Buffer = Buffer.alloc(46);
        writeU32(central, 0, 0x02014b50);
        writeU16(central, 4, 20);
        writeU16(central, 6, 20);
        writeU16(central, 8, flags);
        writeU16(central, 10, method);
        writeU16(central, 12, 0);
        writeU16(central, 14, 0);
        writeU32(central, 16, crc);
        writeU32(central, 20, spec.compressedOverride ?? payload.length);
        writeU32(central, 24, spec.uncompressedOverride ?? data.length);
        writeU16(central, 28, name.length);
        writeU16(central, 30, 0);
        writeU16(central, 32, 0);
        writeU16(central, 34, 0);
        writeU16(central, 36, 0);
        writeU32(central, 38, 0);
        writeU32(central, 42, spec.localOffsetOverride ?? localOffset);
        centralParts.push(central, name);
        localOffset += local.length + name.length + payload.length;
    }
    const centralSize: number = centralParts.reduce((total: number, part: Buffer): number => total + part.length, 0);
    const eocd: Buffer = Buffer.alloc(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, specs.length);
    writeU16(eocd, 10, specs.length);
    writeU32(eocd, 12, centralSize);
    writeU32(eocd, 16, localOffset);
    writeU16(eocd, 20, 0);
    return Buffer.concat([...localParts, ...centralParts, eocd]);
};

const WordDocumentXml: string = [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<w:body>",
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>',
    "<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>",
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>',
    "<w:p><w:r><w:t>Second paragraph &amp; more.</w:t></w:r></w:p>",
    '<w:p><w:bookmarkStart w:id="0" w:name="mark"/><w:r><w:t>See link</w:t></w:r></w:p>',
    "</w:body>",
    "</w:document>",
].join("");

const WordRelsXml: string = [
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docs" TargetMode="External"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
    "</Relationships>",
].join("");

const WordCoreXml: string = [
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<dc:title>Office Fixture</dc:title>",
    "<dc:creator>Fixture Author</dc:creator>",
    "</cp:coreProperties>",
].join("");

const buildDocx: () => Uint8Array = (): Uint8Array =>
    buildZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "word/document.xml", data: WordDocumentXml, method: 8 },
        { name: "word/_rels/document.xml.rels", data: WordRelsXml },
        { name: "docProps/core.xml", data: WordCoreXml },
    ]);

const WorkbookXml: string = [
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheets>",
    '<sheet name="Data" sheetId="1" r:id="rId1"/>',
    '<sheet name="Summary" sheetId="2" r:id="rId2"/>',
    "</sheets>",
    "<definedNames>",
    '<definedName name="Total">Summary!$B$2</definedName>',
    '<definedName name="LocalTotal" localSheetId="0">Data!$A$3</definedName>',
    "</definedNames>",
    "</workbook>",
].join("");

const buildXlsx: () => Uint8Array = (): Uint8Array =>
    buildZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "xl/workbook.xml", data: WorkbookXml, method: 8 },
        {
            name: "xl/_rels/workbook.xml.rels",
            data: [
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>',
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>',
                "</Relationships>",
            ].join(""),
        },
        {
            name: "xl/sharedStrings.xml",
            data: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Revenue</t></si></sst>',
        },
        {
            name: "xl/worksheets/sheet1.xml",
            data: [
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
                '<sheetData><row r="1">',
                '<c r="A1" t="s"><v>0</v></c>',
                '<c r="B1"><f>Summary!A1+Data!$A$2</f><v>0</v></c>',
                '<c r="C1"><f>[1]Sheet1!A1</f><v>0</v></c>',
                '<c r="D1"><f>A1+SUM(B1:B3)</f><v>0</v></c>',
                "</row></sheetData>",
                '<hyperlinks><hyperlink ref="A1" r:id="rId9"/></hyperlinks>',
                "</worksheet>",
            ].join(""),
        },
        {
            name: "xl/worksheets/_rels/sheet1.xml.rels",
            data: [
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>',
                '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/sales" TargetMode="External"/>',
                "</Relationships>",
            ].join(""),
        },
        {
            name: "xl/worksheets/sheet2.xml",
            data: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
        },
        {
            name: "xl/tables/table1.xml",
            data: '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="SalesTable" ref="A1:B3"/>',
        },
        {
            name: "xl/externalLinks/externalLink1.xml",
            data: '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></externalLink>',
        },
        {
            name: "xl/externalLinks/_rels/externalLink1.xml.rels",
            data: [
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="budget.xlsx" TargetMode="External"/>',
                "</Relationships>",
            ].join(""),
        },
    ]);

const slideXml: (title: string, bullets: readonly string[]) => string = (title: string, bullets: readonly string[]): string =>
    [
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        "<p:cSld><p:spTree>",
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>',
        `<p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>`,
        "<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody>",
        ...bullets.map((bullet: string): string => `<a:p><a:r><a:t>${bullet}</a:t></a:r></a:p>`),
        "</p:txBody></p:sp>",
        "</p:spTree></p:cSld>",
        "</p:sld>",
    ].join("");

const buildPptx: () => Uint8Array = (): Uint8Array =>
    buildZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        {
            name: "ppt/presentation.xml",
            data: [
                '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
                "<p:sldIdLst>",
                '<p:sldId id="256" r:id="rId3"/>',
                '<p:sldId id="257" r:id="rId2"/>',
                "</p:sldIdLst>",
                "</p:presentation>",
            ].join(""),
        },
        {
            name: "ppt/_rels/presentation.xml.rels",
            data: [
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
                '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
                "</Relationships>",
            ].join(""),
        },
        { name: "ppt/slides/slide1.xml", data: slideXml("First Slide", ["Bullet one", "Bullet two"]) },
        {
            name: "ppt/slides/slide2.xml",
            data: slideXml("Second Slide", ["Closing remark"]),
        },
        {
            name: "ppt/slides/_rels/slide1.xml.rels",
            data: [
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/slide" TargetMode="External"/>',
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/oleObject1.bin"/>',
                "</Relationships>",
            ].join(""),
        },
    ]);

const flattenOutline: (nodes: readonly OutlineNode[]) => OutlineNode[] = (nodes: readonly OutlineNode[]): OutlineNode[] => {
    const result: OutlineNode[] = [];
    const stack: OutlineNode[] = [...nodes].reverse();
    while (stack.length > 0) {
        const node: OutlineNode = stack.pop()!;
        result.push(node);
        for (let index: number = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return result;
};

const findSection: (sections: readonly OfficeSection[], label: string) => OfficeSection | undefined = (
    sections: readonly OfficeSection[],
    label: string,
): OfficeSection | undefined => {
    const stack: OfficeSection[] = [...sections].reverse();
    while (stack.length > 0) {
        const section: OfficeSection = stack.pop()!;
        if (section.label === label) {
            return section;
        }
        for (let index: number = section.children.length - 1; index >= 0; index -= 1) {
            stack.push(section.children[index]);
        }
    }
    return undefined;
};

/**
 * Build a minimal valid CFB container with one small stream stored through the
 * mini stream. Layout: sector 0 FAT, sector 1 directory, sector 2 mini FAT,
 * sector 3 mini-stream container.
 */
const buildCfb: (streamName: string, streamText: string) => Uint8Array = (streamName: string, streamText: string): Uint8Array => {
    const sectorSize: number = 512;
    const buffer: Buffer = Buffer.alloc(sectorSize * 5);
    const signature: readonly number[] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (let index: number = 0; index < signature.length; index += 1) {
        buffer[index] = signature[index];
    }
    writeU16(buffer, 24, 0x003e);
    writeU16(buffer, 26, 3);
    writeU16(buffer, 28, 0xfffe);
    writeU16(buffer, 30, 9);
    writeU16(buffer, 32, 6);
    writeU32(buffer, 40, 0);
    writeU32(buffer, 44, 1);
    writeU32(buffer, 48, 1);
    writeU32(buffer, 52, 0);
    writeU32(buffer, 56, 4096);
    writeU32(buffer, 60, 2);
    writeU32(buffer, 64, 1);
    writeU32(buffer, 68, 0xfffffffe);
    writeU32(buffer, 72, 0);
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
        const nameBytes: Buffer = Buffer.from(name, "utf16le");
        nameBytes.copy(buffer, offset);
        writeU16(buffer, offset + 64, nameBytes.length + 2);
        buffer[offset + 66] = type;
        buffer[offset + 67] = 1;
        writeU32(buffer, offset + 68, 0xffffffff);
        writeU32(buffer, offset + 72, 0xffffffff);
        writeU32(buffer, offset + 76, child);
        writeU32(buffer, offset + 116, start);
        writeU32(buffer, offset + 120, size);
        writeU32(buffer, offset + 124, 0);
    };
    writeEntry(directoryBase, "Root Entry", 5, 3, 64, 1);
    writeEntry(directoryBase + 128, streamName, 2, 0, Buffer.byteLength(streamText, "utf16le"), 0xffffffff);
    const miniFatBase: number = sectorSize * 3;
    for (let index: number = 0; index < sectorSize / 4; index += 1) {
        writeU32(buffer, miniFatBase + index * 4, 0xffffffff);
    }
    writeU32(buffer, miniFatBase, 0xfffffffe);
    const miniStreamBase: number = sectorSize * 4;
    Buffer.from(streamText, "utf16le").copy(buffer, miniStreamBase);
    return buffer;
};

test("zip reader expands stored and deflated entries, strips BOM and rejects unsafe archives", (): void => {
    const archive: Uint8Array = buildZip([
        { name: "word/document.xml", data: "<document/>" },
        { name: "xl/sharedStrings.xml", data: "\ufeff<strings/>", method: 8 },
    ]);
    const entries: Map<string, Uint8Array> = readZipEntries(archive);
    assert.equal(entries.size, 2);
    assert.equal(zipText(entries, "word/document.xml"), "<document/>");
    assert.equal(zipText(entries, "xl/sharedStrings.xml"), "<strings/>");
    assert.equal(zipText(entries, "missing.xml"), undefined);
    assert.throws(
        (): Map<string, Uint8Array> => readZipEntries(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
    assert.throws(
        (): Map<string, Uint8Array> => readZipEntries(buildZip([{ name: "../evil.xml", data: "<evil/>" }])),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
    assert.throws(
        (): Map<string, Uint8Array> => readZipEntries(buildZip([{ name: "encrypted.xml", data: "<x/>", flags: 1 }])),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
    assert.throws(
        (): Map<string, Uint8Array> => readZipEntries(buildZip([{ name: "zip64.xml", data: "<x/>", uncompressedOverride: 0xffffffff }])),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
    assert.throws(
        (): Map<string, Uint8Array> => readZipEntries(buildZip([{ name: "offset.xml", data: "<x/>", localOffsetOverride: 0x7fffffff }])),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
    assert.throws(
        (): Map<string, Uint8Array> =>
            readZipEntries(
                buildZip([
                    { name: "dup.xml", data: "<one/>" },
                    { name: "dup.xml", data: "<two/>" },
                ]),
            ),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
    const multiDisk: Buffer = Buffer.from(buildZip([{ name: "single.xml", data: "<x/>" }]));
    writeU16(multiDisk, multiDisk.length - 22 + 4, 1);
    assert.throws(
        (): Map<string, Uint8Array> => readZipEntries(multiDisk),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "parse_failed",
    );
});

test("word OOXML yields headings, paragraphs, hyperlinks, imports, bookmarks and properties", (): void => {
    const docxBytes: Uint8Array = buildDocx();
    writeFixture("sample.docx", docxBytes);
    const document: OfficeDocument = parseOffice(Sandbox, "sample.docx");
    assert.equal(document.path, "sample.docx");
    assert.equal(document.kind, "word");
    assert.equal(document.format, "ooxml");
    assert.equal(document.bytes, BigInt(docxBytes.length));
    assert.equal(document.fingerprint, rawDigest(docxBytes));
    assert.match(document.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(document.sections.length, 1);
    const introduction: OfficeSection = document.sections[0];
    assert.equal(introduction.kind, "heading");
    assert.equal(introduction.label, "Introduction");
    assert.equal(introduction.depth, 0);
    assert.equal(introduction.index, 0);
    assert.deepEqual(
        introduction.children.map((child: OfficeSection): string => child.label),
        ["First paragraph.", "Details"],
    );
    const details: OfficeSection = introduction.children[1];
    assert.equal(details.kind, "heading");
    assert.equal(details.depth, 1);
    assert.deepEqual(
        details.children.map((child: OfficeSection): string => child.label),
        ["Second paragraph & more.", "See link"],
    );
    assert.equal(
        document.references.some((reference: OfficeReference): boolean => reference.kind === "hyperlink" && reference.target === "https://example.com/docs"),
        true,
    );
    assert.equal(
        document.references.some((reference: OfficeReference): boolean => reference.kind === "embedded" && reference.target === "word/media/image1.png"),
        true,
    );
    assert.deepEqual(officeImports(document), ["https://example.com/docs"]);
    assert.deepEqual(officeExports(document), ["mark"]);
    assert.equal(document.exports.includes("mark"), true);
    assert.equal(document.metadata.title, "Office Fixture");
    assert.equal(document.metadata.creator, "Fixture Author");
    assert.equal(document.warnings.length > 0, true);
});

test("excel OOXML yields sheet sections, table and named-range children, formulas and external links", (): void => {
    writeFixture("sample.xlsx", buildXlsx());
    const document: OfficeDocument = parseOffice(Sandbox, "sample.xlsx");
    assert.equal(document.kind, "excel");
    assert.equal(document.format, "ooxml");
    assert.deepEqual(
        document.sections.map((section: OfficeSection): string => section.label),
        ["Data", "Summary", "Named ranges"],
    );
    const data: OfficeSection = document.sections[0];
    assert.equal(data.kind, "sheet");
    assert.deepEqual(
        data.children.map((child: OfficeSection): string => `${child.kind}:${child.label}`),
        ["table:SalesTable", "section:LocalTotal"],
    );
    assert.equal(document.exports.includes("SalesTable"), true);
    assert.equal(document.exports.includes("Total"), true);
    assert.equal(document.exports.includes("LocalTotal"), true);
    const formula: OfficeReference | undefined = document.references.find(
        (reference: OfficeReference): boolean => reference.kind === "formula" && reference.from === "Data!B1" && reference.target === "Summary!A1",
    );
    assert.ok(formula);
    assert.equal(
        document.references.some((reference: OfficeReference): boolean => reference.kind === "formula" && reference.target === "[1]Sheet1!A1"),
        true,
    );
    assert.equal(document.imports.includes("budget.xlsx"), true);
    assert.equal(document.imports.includes("https://example.com/sales"), true);
    assert.equal(document.metadata["excel.sheets"], "2");
});

test("powerpoint OOXML follows presentation order and projects title/body placeholders", (): void => {
    writeFixture("sample.pptx", buildPptx());
    const document: OfficeDocument = parseOffice(Sandbox, "sample.pptx");
    assert.equal(document.kind, "powerpoint");
    assert.equal(document.format, "ooxml");
    assert.deepEqual(
        document.sections.map((section: OfficeSection): string => section.label),
        ["Second Slide", "First Slide"],
    );
    const first: OfficeSection = document.sections[1];
    assert.equal(first.kind, "slide");
    assert.deepEqual(
        first.children.map((child: OfficeSection): string => `${child.kind}:${child.label}`),
        ["heading:First Slide", "paragraph:Bullet one", "paragraph:Bullet two"],
    );
    assert.equal(
        document.references.some((reference: OfficeReference): boolean => reference.kind === "hyperlink" && reference.target === "https://example.com/slide"),
        true,
    );
    assert.equal(
        document.references.some(
            (reference: OfficeReference): boolean => reference.kind === "embedded" && reference.target === "ppt/embeddings/oleObject1.bin",
        ),
        true,
    );
    assert.equal(document.imports.includes("https://example.com/slide"), true);
});

test("office outline parser exposes synthetic paths, kinds, depths and monotonic bigint ranges", (): void => {
    const bytes: Uint8Array = buildDocx();
    const nodes: OutlineNode[] = officeOutlineParser({ path: "docs/sample.docx", bytes });
    assert.equal(nodes.length, 1);
    const root: OutlineNode = nodes[0];
    assert.equal(root.isFile, false);
    assert.equal(root.isDirectory, false);
    assert.equal(root.path, "docs/sample.docx#heading-0");
    assert.equal(root.type, "heading");
    assert.equal(root.label, "Introduction");
    assert.equal(root.depth, 0);
    assert.equal(root.range.startLine, 1n);
    /**
     * The root covers its own subtree: ordinals 1..5, so a parent's line range
     * ends at the last descendant ordinal instead of its own.
     */
    assert.equal(root.range.endLine, 5n);
    assert.equal(root.range.startByte, 0n);
    assert.equal(root.range.endByte > 0n, true);
    assert.equal(root.range.endByte <= BigInt(bytes.length), true);
    const child: OutlineNode = root.children[0];
    assert.equal(child.path, "docs/sample.docx#paragraph-1");
    assert.equal(child.type, "paragraph");
    assert.equal(child.depth, 1);
    assert.equal(child.range.startLine, 2n);
    assert.equal(child.range.startByte > 0n, true);
    const flat: OutlineNode[] = flattenOutline(nodes);
    const paths: Set<string> = new Set<string>();
    let previousStart: bigint = 0n;
    for (let index: number = 0; index < flat.length; index += 1) {
        const node: OutlineNode = flat[index];
        assert.equal(paths.has(node.path), false);
        paths.add(node.path);
        assert.equal(node.range.startByte <= node.range.endByte, true);
        assert.equal(node.range.endByte <= BigInt(bytes.length), true);
        assert.equal(node.range.startByte >= previousStart, true);
        previousStart = node.range.startByte;
    }
    assert.equal(flat.length, 5);
});

test("office outline bridge enforces its own 4 MiB quota before container sniffing", (): void => {
    const oversized: Uint8Array = new Uint8Array(OfficeMaxOutlineBytes + 1);
    assert.throws(
        (): OutlineNode[] => officeOutlineParser({ path: "oversized.docx", bytes: oversized }),
        (error: unknown): boolean => error instanceof FilesystemError && error.code === "quota_exceeded",
    );
});

test("publisher and empty access containers return warnings without fabricating sections", (): void => {
    writeFixture("story.pub", buildCfb("Contents", "Publisher story text."));
    const story: OfficeDocument = parseOffice(Sandbox, "story.pub");
    assert.equal(story.kind, "publisher");
    assert.equal(story.sections.length, 1);
    assert.equal(story.sections[0].label, "Publisher document");
    assert.equal(story.sections[0].children.length > 0, true);
    assert.equal(
        story.warnings.some((warning: string): boolean => warning.includes("Publisher support is best-effort")),
        true,
    );
    writeFixture("empty.pub", buildCfb("Contents", ""));
    const emptyPublisher: OfficeDocument = parseOffice(Sandbox, "empty.pub");
    assert.equal(emptyPublisher.kind, "publisher");
    assert.equal(emptyPublisher.sections.length, 0);
    assert.equal(
        emptyPublisher.warnings.some((warning: string): boolean => warning.includes("no printable text recovered")),
        true,
    );
    const emptyDatabase: Buffer = Buffer.alloc(2048);
    emptyDatabase[0] = 0x00;
    emptyDatabase[1] = 0x01;
    emptyDatabase[2] = 0x00;
    emptyDatabase[3] = 0x00;
    Buffer.from("Standard Jet DB", "ascii").copy(emptyDatabase, 4);
    writeFixture("empty.mdb", emptyDatabase);
    const emptyAccess: OfficeDocument = parseOffice(Sandbox, "empty.mdb");
    assert.equal(emptyAccess.kind, "access");
    assert.equal(emptyAccess.sections.length, 0);
    assert.equal(
        emptyAccess.warnings.some((warning: string): boolean => warning.includes("no catalog names could be recovered")),
        true,
    );
});

test("corrupt zip, cfb and unknown containers return warnings instead of throwing", (): void => {
    writeFixture("broken.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]));
    const brokenZip: OfficeDocument = parseOffice(Sandbox, "broken.docx");
    assert.equal(brokenZip.format, "ooxml");
    assert.equal(brokenZip.sections.length, 0);
    assert.equal(brokenZip.warnings.length > 0, true);
    const corruptCfbBytes: Uint8Array = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array<number>(520).fill(0)]);
    writeFixture("broken.doc", corruptCfbBytes);
    const brokenCfb: OfficeDocument = parseOffice(Sandbox, "broken.doc");
    assert.equal(brokenCfb.format, "ole");
    assert.equal(brokenCfb.kind, "word");
    assert.equal(brokenCfb.sections.length, 0);
    assert.equal(brokenCfb.warnings.length > 0, true);
    writeFixture("broken.pub", corruptCfbBytes);
    const brokenPublisher: OfficeDocument = parseOffice(Sandbox, "broken.pub");
    assert.equal(brokenPublisher.kind, "publisher");
    assert.equal(brokenPublisher.sections.length, 0);
    assert.equal(brokenPublisher.warnings.length > 0, true);
    const corruptAccess: Buffer = Buffer.alloc(100);
    corruptAccess[0] = 0x00;
    corruptAccess[1] = 0x01;
    corruptAccess[2] = 0x00;
    corruptAccess[3] = 0x00;
    Buffer.from("Standard ACE DB", "ascii").copy(corruptAccess, 4);
    writeFixture("broken.accdb", corruptAccess);
    const brokenAccess: OfficeDocument = parseOffice(Sandbox, "broken.accdb");
    assert.equal(brokenAccess.kind, "access");
    assert.equal(brokenAccess.sections.length, 0);
    assert.equal(brokenAccess.warnings.length > 0, true);
    const corrupt: { entries: CfbEntry[]; streams: Map<string, Uint8Array>; warnings: string[] } = readCfb(
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
    assert.equal(corrupt.entries.length, 0);
    assert.equal(corrupt.streams.size, 0);
    assert.equal(corrupt.warnings.length > 0, true);
    writeFixture("mystery.docx", text("this is not a container"));
    const unknown: OfficeDocument = parseOffice(Sandbox, "mystery.docx");
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.format, "unknown");
    assert.equal(unknown.sections.length, 0);
    assert.equal(unknown.warnings.length > 0, true);
});

test("minimal CFB mini-stream is readable and legacy word paragraphs are recovered", (): void => {
    const legacyText: string = "Legacy WordDocument sample text.";
    const container: Uint8Array = buildCfb("WordDocument", legacyText);
    const cfb: { entries: CfbEntry[]; streams: Map<string, Uint8Array>; warnings: string[] } = readCfb(container);
    assert.deepEqual(cfb.warnings, []);
    assert.equal(cfb.entries.length, 2);
    assert.deepEqual(
        cfb.entries.map((entry: CfbEntry): string => `${entry.type}:${entry.name}`),
        ["root:Root Entry", "stream:WordDocument"],
    );
    const stream: Uint8Array | undefined = cfb.streams.get("WordDocument");
    assert.ok(stream);
    assert.equal(new TextDecoder("utf-16le").decode(stream), legacyText);
    writeFixture("legacy.doc", container);
    const document: OfficeDocument = parseOffice(Sandbox, "legacy.doc");
    assert.equal(document.kind, "word");
    assert.equal(document.format, "ole");
    assert.equal(document.sections.length, 1);
    assert.equal(document.sections[0].label, "Word document");
    assert.equal(document.sections[0].children.length > 0, true);
    assert.equal(
        document.sections[0].children.some((child: OfficeSection): boolean => child.label === legacyText),
        true,
    );
    const nodes: OutlineNode[] = officeOutlineParser({ path: "legacy.doc", bytes: container });
    assert.equal(nodes[0].type, "section");
    assert.equal(nodes[0].children[0].type, "paragraph");
});

test("access header is recognized best-effort with catalog candidates and warnings", (): void => {
    const database: Buffer = Buffer.alloc(16384);
    database[0] = 0x00;
    database[1] = 0x01;
    database[2] = 0x00;
    database[3] = 0x00;
    Buffer.from("Standard ACE DB", "ascii").copy(database, 4);
    Buffer.from("Customers", "utf16le").copy(database, 8192);
    Buffer.from("qryActive", "utf16le").copy(database, 8288);
    writeFixture("sample.accdb", database);
    const document: OfficeDocument = parseOffice(Sandbox, "sample.accdb");
    assert.equal(document.kind, "access");
    assert.equal(document.format, "ole");
    assert.equal(
        document.warnings.some((warning: string): boolean => warning.includes("access catalog best-effort")),
        true,
    );
    const catalog: OfficeSection | undefined = findSection(document.sections, "Access catalog (best effort)");
    assert.ok(catalog);
    assert.equal(
        catalog.children.some((child: OfficeSection): boolean => child.label === "Customers" && child.kind === "table"),
        true,
    );
    assert.equal(
        catalog.children.some((child: OfficeSection): boolean => child.label === "qryActive" && child.kind === "query"),
        true,
    );
});

test("installOfficeOutlineParser is idempotent and buildOutline selects the office strategy", (): void => {
    writeFixture("outline.docx", buildDocx());
    installOfficeOutlineParser();
    installOfficeOutlineParser();
    const result: OutlineResult = buildOutline(Sandbox, "outline.docx");
    assert.equal(result.strategy, "office");
    assert.equal(result.category, "data");
    assert.equal(result.language, "office");
    assert.equal(result.target, "file");
    assert.equal(result.truncated, false);
    assert.equal(result.nodes.length, 1);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.type, "File");
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.file?.name, "outline.docx");
    assert.equal(anchor.children.length, 1);
    assert.equal(anchor.children[0].label, "Introduction");
    assert.equal(anchor.children[0].type, "heading");
    assert.equal(anchor.children[0].depth, 1);
    assert.equal(anchor.children[0].path, "outline.docx#Introduction");
    assert.equal(isOfficeFile("A.DOCX"), true);
    assert.equal(isOfficeFile("notes.md"), false);
});

test("service import and export reuse the Office fingerprint and recovered facts", (): void => {
    const docxBytes: Uint8Array = buildDocx();
    writeFixture("service.docx", docxBytes);
    const registry: SessionRegistry = new SessionRegistry();
    const opened: ReturnType<SessionRegistry["open"]> = registry.open({
        agentId: "agent.office-test",
        label: "office service",
        roots: [{ id: "root", path: RootPath, writable: false, exclude: [] }],
    });
    const service: FilesystemService = new FilesystemService({ registry, timeZone: "utc" });
    const session: FilesystemSession = service.bind(opened.descriptor.id, opened.credential.token);
    const imports: ImportReport = session.imports({ path: "service.docx" });
    assert.equal(imports.fingerprint, rawDigest(docxBytes));
    assert.equal(imports.external.includes("https://example.com/docs"), true);
    const exports: ExportReport = session.exports({ path: "service.docx" });
    assert.equal(exports.fingerprint, rawDigest(docxBytes));
    assert.equal(
        exports.exports.some((symbol: ExportSymbol): boolean => symbol.name === "mark"),
        true,
    );
});
