#!/usr/bin/env node
/**
 * Outline coverage checks.
 *
 * One fixture per object in the outline catalog: nine code families, eight
 * project manifest kinds, prose (Markdown, TeX and plain text with and without
 * an extension), the nine Office container extensions and the four data
 * formats. Every fixture is written to a private temporary directory and goes
 * through the public `buildOutline` entry point, so sandbox resolution, charset
 * detection, strategy selection, anchor construction, UTF-8 ranges and node
 * finalization are all exercised together.
 *
 * The file has four layers:
 *
 * 1. a `matches` matrix that pins the strategy id for every extension and
 *    exact file name in the catalog, independent of a parse;
 * 2. a fixture matrix that asserts strategy/category/language/charset, at least
 *    one symbol, the `<file>#` path prefix, bigint line and byte ranges with
 *    `start <= end`, a non-empty label, and at least one parser-level node
 *    (class/function/heading/module/dependency/target/...);
 * 3. dedicated structure tests for the indented Sass syntax, extensionless
 *    plain text and `.cmake` include modules;
 * 4. Office tests that prove `OfficeOutlineStrategy` is selected for all nine
 *    extensions and that `officeOutlineParser` only yields sections after
 *    `installOfficeOutlineParser()` has run (the registry calls it from
 *    `buildOffice`, so a plain `buildOutline` call is enough).
 *
 * The Office fixtures are real containers: stored-entry ZIP packages for the
 * OOXML formats, a one-stream CFB mini-stream container for the legacy formats
 * and a Jet/ACE header page for the Access formats. Nothing is executed and no
 * fixture is left behind; the temporary root is removed after the run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { buildOutline, OutlineStrategies } from "../src/outline/outline.ts";
import type { OutlineStrategy } from "../src/outline/outline.ts";
import { parseOffice as parseOfficeDocument } from "../src/outline/office.ts";
import { parseOffice as parseOfficeStrategy, parseSass } from "../src/outline/outlineStrategies.ts";
import { PathSandbox } from "../src/file/path.ts";
import { LineIndex } from "../src/syntax/charset.ts";
import type { Charset } from "../src/syntax/types.ts";
import type { OutlineCategory, OutlineKind, OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { OfficeDocument, OfficeSection } from "../src/outline/office.ts";
import type { SessionRoot } from "../src/session/types.ts";

/**
 * Private fixture root for this run.
 */
const Root: string = mkdtempSync(join(tmpdir(), "amp-outline-coverage-"));
const RootSpec: SessionRoot = { id: "root.outline.coverage", path: Root, writable: true, exclude: [] };
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
        const node: OutlineNode = nodes[index];
        result.push(node);
        const children: OutlineNode[] = flatten(node.children);
        for (let childIndex: number = 0; childIndex < children.length; childIndex += 1) {
            result.push(children[childIndex]);
        }
    }
    return result;
};

/**
 * Lookup signature for a labelled node inside an outline tree.
 */
type OutlineNodeLookup = (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined;

/**
 * First node with one label, depth first.
 */
const findNode: OutlineNodeLookup = (nodes: readonly OutlineNode[], label: string): OutlineNode | undefined => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: OutlineNode = nodes[index];
        if (node.label === label) {
            return node;
        }
        const nested: OutlineNode | undefined = findNode(node.children, label);
        if (nested !== (void 0)) {
            return nested;
        }
    }
    return undefined;
};

/**
 * First node with one label; fails the test when it is absent.
 */
const requireNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode = (nodes: readonly OutlineNode[], label: string): OutlineNode => {
    const node: OutlineNode | undefined = findNode(nodes, label);
    assert.ok(node !== (void 0), `missing outline node: ${label}`);
    return node!;
};

/**
 * Labels of a node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

/**
 * Little-endian 16-bit write into a mutable byte buffer.
 */
const writeU16: (target: Uint8Array, offset: number, value: number) => void = (target: Uint8Array, offset: number, value: number): void => {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
};

/**
 * Little-endian 32-bit write into a mutable byte buffer.
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
 * UTF-16LE encode a string without depending on a host buffer type.
 */
const utf16le: (value: string) => Uint8Array = (value: string): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(value.length * 2);
    for (let index: number = 0; index < value.length; index += 1) {
        writeU16(bytes, index * 2, value.charCodeAt(index));
    }
    return bytes;
};

/**
 * Concatenate byte slices in order.
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
 * One stored-entry ZIP member.
 */
interface ZipMember {
    readonly name: string;
    readonly text: string;
}

/**
 * Build a ZIP archive with stored (method 0) entries.
 *
 * OOXML packages are ZIP archives, so this is enough to exercise the real
 * `zip.ts` reader: local headers, central directory, end-of-central-directory
 * record and UTF-8 names. CRCs are not written because the reader deliberately
 * does not verify them; the sizes and names are authoritative.
 *
 * @param members - File name and text content of each member.
 * @returns Complete archive bytes.
 */
const zipOf: (members: readonly ZipMember[]) => Uint8Array = (members: readonly ZipMember[]): Uint8Array => {
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset: number = 0;
    for (let index: number = 0; index < members.length; index += 1) {
        const name: Uint8Array = utf8(members[index].name);
        const payload: Uint8Array = utf8(members[index].text);
        const local: Uint8Array = new Uint8Array(30 + name.length + payload.length);
        writeU32(local, 0, 0x04034b50);
        writeU16(local, 4, 20);
        writeU16(local, 6, 0x0800);
        writeU16(local, 8, 0);
        writeU16(local, 10, 0);
        writeU16(local, 12, 0);
        writeU32(local, 14, 0);
        writeU32(local, 18, payload.length);
        writeU32(local, 22, payload.length);
        writeU16(local, 26, name.length);
        writeU16(local, 28, 0);
        local.set(name, 30);
        local.set(payload, 30 + name.length);
        const central: Uint8Array = new Uint8Array(46 + name.length);
        writeU32(central, 0, 0x02014b50);
        writeU16(central, 4, 20);
        writeU16(central, 6, 20);
        writeU16(central, 8, 0x0800);
        writeU16(central, 10, 0);
        writeU16(central, 12, 0);
        writeU16(central, 14, 0);
        writeU32(central, 16, 0);
        writeU32(central, 20, payload.length);
        writeU32(central, 24, payload.length);
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
    const centralSize: number = centrals.reduce((total: number, part: Uint8Array): number => total + part.length, 0);
    const eocd: Uint8Array = new Uint8Array(22);
    writeU32(eocd, 0, 0x06054b50);
    writeU16(eocd, 4, 0);
    writeU16(eocd, 6, 0);
    writeU16(eocd, 8, members.length);
    writeU16(eocd, 10, members.length);
    writeU32(eocd, 12, centralSize);
    writeU32(eocd, 16, offset);
    writeU16(eocd, 20, 0);
    return concatBytes([...locals, ...centrals, eocd]);
};

/**
 * Directory-entry writer signature for the CFB fixture.
 */
type CfbEntryWriter = (offset: number, name: string, type: number, start: number, size: number, child: number) => void;

/**
 * Build a minimal valid CFB container with one stream stored through the mini
 * stream. Layout: sector 0 FAT, sector 1 directory, sector 2 mini FAT, sector 3
 * mini-stream container, so the stream itself must stay within one 64-byte
 * mini sector.
 *
 * @param streamName - Directory entry name of the single stream.
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
    const writeEntry: CfbEntryWriter = (offset: number, name: string, type: number, start: number, size: number, child: number): void => {
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
        writeU32(buffer, offset + 124, 0);
    };
    writeEntry(directoryBase, "Root Entry", 5, 3, 64, 1);
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
 * Build the BIFF `BOUNDSHEET` record that names one legacy Excel sheet.
 *
 * @param sheetName - Sheet name (at most 31 characters).
 * @returns A one-record workbook stream.
 */
const biffWorkbook: (sheetName: string) => Uint8Array = (sheetName: string): Uint8Array => {
    const name: Uint8Array = utf16le(sheetName);
    const record: Uint8Array = new Uint8Array(12 + name.length);
    writeU16(record, 0, 0x0085);
    writeU16(record, 2, 8 + name.length);
    writeU32(record, 4, 0);
    writeU16(record, 8, 0);
    record[10] = sheetName.length;
    record[11] = 0x01;
    record.set(name, 12);
    return record;
};

/**
 * Build a Jet/ACE database image whose catalog names are recoverable.
 *
 * `office.ts` recognizes Access by the four-byte header plus `Standard ACE DB`
 * or `Standard Jet DB` at offset 4, then scans UTF-16LE runs after the first
 * database page. Two catalog names are enough to prove the mapping.
 *
 * @param engine - `Standard ACE DB` or `Standard Jet DB`.
 * @returns Complete database bytes.
 */
const accessBytes: (engine: string) => Uint8Array = (engine: string): Uint8Array => {
    const bytes: Uint8Array = new Uint8Array(16384);
    bytes[0] = 0x00;
    bytes[1] = 0x01;
    bytes[2] = 0x00;
    bytes[3] = 0x00;
    bytes.set(utf8(engine), 4);
    bytes.set(utf16le("Customers"), 8192);
    bytes.set(utf16le("qryActive"), 8288);
    return bytes;
};

/**
 * WordprocessingML body with one heading and one paragraph.
 */
const WordBodyXml: string = [
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    "<w:body>",
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>',
    "<w:p><w:r><w:t>Revenue grew.</w:t></w:r></w:p>",
    "</w:body>",
    "</w:document>",
].join("");

/**
 * SpreadsheetML workbook with one sheet. The worksheet part is absent on
 * purpose: the sheet node comes from `workbook.xml`, which is the structure
 * the outline models.
 */
const WorkbookXml: string = [
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    "<sheets>",
    '<sheet name="Budget" sheetId="1" r:id="rId1"/>',
    "</sheets>",
    "</workbook>",
].join("");

/**
 * PresentationML slide with a title placeholder.
 */
const SlideXml: string = [
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    "<p:cSld><p:spTree><p:sp>",
    '<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>',
    "<p:txBody><a:p><a:r><a:t>Kickoff</a:t></a:r></a:p></p:txBody>",
    "</p:sp></p:spTree></p:cSld>",
    "</p:sld>",
].join("");

/**
 * OOXML and legacy Office fixtures, one per container extension.
 */
const DocxBytes: Uint8Array = zipOf([{ name: "word/document.xml", text: WordBodyXml }]);
const XlsxBytes: Uint8Array = zipOf([{ name: "xl/workbook.xml", text: WorkbookXml }]);
const PptxBytes: Uint8Array = zipOf([{ name: "ppt/slides/slide1.xml", text: SlideXml }]);
const DocBytes: Uint8Array = cfbOf("WordDocument", utf16le("Legacy Word document body."));
const XlsBytes: Uint8Array = cfbOf("Workbook", biffWorkbook("Sheet1"));
const PptBytes: Uint8Array = cfbOf("PowerPoint Document", utf16le("Slide one content."));
const PubBytes: Uint8Array = cfbOf("Contents", utf16le("Publisher story text."));
const AccdbBytes: Uint8Array = accessBytes("Standard ACE DB");
const MdbBytes: Uint8Array = accessBytes("Standard Jet DB");

/**
 * Probe taken before any test runs: the Office extractor has not been installed
 * yet at module load time, so a direct `parseOffice` strategy call yields no
 * sections. `buildOutline` installs it from `buildOffice`.
 */
const OfficeSectionsBeforeInstall: readonly OutlineNode[] = parseOfficeStrategy({ path: "office/report.docx", bytes: DocxBytes });

/**
 * Verbatim Sass fixture used by both the matrix and the indented-syntax test.
 */
const SassText: string = [
    "$brand: #111",
    "",
    ".button",
    "  color: $brand",
    "  &:hover",
    "    color: red",
    "",
    "@mixin flex-center",
    "  display: flex",
].join("\n");

/**
 * SCSS fixture with the brace syntax, shared by the matrix and the SCSS test.
 */
const ScssText: string = ["$brand: #111;", "", ".button {", "    color: $brand;", "}"].join("\n");

/**
 * CMake include-module fixture shared by the matrix and the `.cmake` test.
 */
const CmakeModuleText: string = ["add_library(helpers INTERFACE)", "add_subdirectory(tools)"].join("\n");

/**
 * HTML page fixture: title, six heading levels, two labelled landmarks, an
 * entity, a self-closing image and pseudo-tags hidden in script, style and a
 * comment. Line numbers are part of the assertions, so the layout is fixed.
 */
const HtmlPageText: string = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    "    <title>Coverage Page</title>",
    "    <style>",
    "        .hero { color: red; }",
    "    </style>",
    "    <script>",
    '        const fake = "<h1>Not a heading</h1>";',
    "    </script>",
    "</head>",
    "<body>",
    "    <main>",
    "        <h1>Welcome &amp; Overview</h1>",
    '        <section id="pricing">',
    "            <h2>Pricing</h2>",
    "            <p>Plans &amp; tiers.</p>",
    "        </section>",
    '        <article id="release-notes">',
    "            <h3>2026 &#8212; Notes</h3>",
    "        </article>",
    "        <h4>Deep</h4>",
    "        <h5>Deeper</h5>",
    "        <h6>Deepest</h6>",
    '        <img src="x.png" alt="shot" />',
    "        <!-- <h2>Comment heading</h2> -->",
    "    </main>",
    "</body>",
    "</html>",
].join("\n");

/**
 * Minimal `.htm` fixture without a title or landmark wrappers.
 */
const HtmlInlineText: string = ["<!DOCTYPE html>", "<html><body><h1>Inline Page</h1><h2>Details</h2></body></html>"].join("\n");

const VueText: string = [
    "<template>",
    "  <h1>Vue Page</h1>",
    '  <section id="intro"><h2>Intro</h2></section>',
    "</template>",
    '<script setup lang="ts">',
    "const count = 1;",
    "function increment() {}",
    "</script>",
    "<style scoped>",
    ".a { color: red; }",
    "</style>",
].join("\n");

/**
 * One parser-level expectation inside a fixture case.
 */
interface ExpectedNode {
    readonly label: string;
    readonly type: OutlineKind;
    readonly detail?: string;
}

/**
 * One object in the coverage matrix.
 */
interface CoverageCase {
    readonly group: "code" | "project" | "prose" | "office" | "data";
    readonly path: string;
    readonly content: string | Uint8Array;
    readonly strategy: string;
    readonly category: OutlineCategory;
    readonly language: string;
    readonly charset: Charset;
    readonly expect: readonly ExpectedNode[];
}

/**
 * The full coverage matrix. Every entry is a real file written under `Root`.
 */
const CoverageCases: readonly CoverageCase[] = [
    {
        group: "code",
        path: "src/widget.ts",
        content: [
            "export interface Widget {",
            "    area(): number;",
            "}",
            "",
            "export class Panel implements Widget {",
            "    private width: number;",
            "",
            "    constructor(width: number) {",
            "        this.width = width;",
            "    }",
            "",
            "    area(): number {",
            "        return this.width;",
            "    }",
            "}",
            "",
            "export const boot = (name: string): string => name;",
        ].join("\n"),
        strategy: "typescript",
        category: "code",
        language: "typescript",
        charset: "utf-8",
        expect: [
            { label: "Widget", type: "interface" },
            { label: "Panel", type: "class" },
            { label: "area", type: "method" },
            { label: "boot", type: "function" },
        ],
    },
    {
        group: "code",
        path: "src/widget.tsx",
        content: [
            "export interface Props {",
            "    title: string;",
            "}",
            "",
            "export function Header(props: Props): string {",
            '    const fallback = "Untitled";',
            "    return props.title.length > 0 ? props.title : fallback;",
            "}",
        ].join("\n"),
        strategy: "typescript",
        category: "code",
        language: "typescript",
        charset: "utf-8",
        expect: [
            { label: "Props", type: "interface" },
            { label: "Header", type: "function" },
        ],
    },
    {
        group: "code",
        path: "src/entry.mts",
        content: ["export function boot(name: string): string {", "    return name;", "}"].join("\n"),
        strategy: "typescript",
        category: "code",
        language: "typescript",
        charset: "utf-8",
        expect: [{ label: "boot", type: "function" }],
    },
    {
        group: "code",
        path: "src/entry.cts",
        content: ["export const boot = (name: string): string => name;"].join("\n"),
        strategy: "typescript",
        category: "code",
        language: "typescript",
        charset: "utf-8",
        expect: [{ label: "boot", type: "function" }],
    },
    {
        group: "code",
        path: "src/greet.js",
        content: ["export function greet(name) {", '    return "hi " + name;', "}"].join("\n"),
        strategy: "javascript",
        category: "code",
        language: "javascript",
        charset: "utf-8",
        expect: [{ label: "greet", type: "function" }],
    },
    {
        group: "code",
        path: "src/view.jsx",
        content: ["export function Card(props) {", '    const title = props.title || "untitled";', "    return title;", "}"].join("\n"),
        strategy: "javascript",
        category: "code",
        language: "javascript",
        charset: "utf-8",
        expect: [{ label: "Card", type: "function" }],
    },
    {
        group: "code",
        path: "src/job.mjs",
        content: ["export async function run(queue) {", "    return queue.length;", "}"].join("\n"),
        strategy: "javascript",
        category: "code",
        language: "javascript",
        charset: "utf-8",
        expect: [{ label: "run", type: "function" }],
    },
    {
        group: "code",
        path: "src/job.cjs",
        content: ['const path = require("node:path");', "", "const resolve = (name) => path.join(name);"].join("\n"),
        strategy: "javascript",
        category: "code",
        language: "javascript",
        charset: "utf-8",
        expect: [{ label: "resolve", type: "function" }],
    },
    {
        group: "code",
        path: "src/calc.py",
        content: [
            "class Calculator:",
            '    """A calculator."""',
            "",
            "    def add(self, other):",
            "        return self.value + other",
            "",
            "",
            "def helper():",
            "    return 1",
        ].join("\n"),
        strategy: "python",
        category: "code",
        language: "python",
        charset: "utf-8",
        expect: [
            { label: "Calculator", type: "class" },
            { label: "add", type: "method" },
            { label: "helper", type: "function" },
        ],
    },
    {
        group: "code",
        path: "types/calc.pyi",
        content: ["class Calculator:", "    def add(self, other: int) -> int: ...", "", "def helper() -> int: ..."].join("\n"),
        strategy: "python",
        category: "code",
        language: "python",
        charset: "utf-8",
        expect: [
            { label: "Calculator", type: "class" },
            { label: "add", type: "method" },
            { label: "helper", type: "function" },
        ],
    },
    {
        group: "code",
        path: "src/App.java",
        content: [
            "package com.example.app;",
            "",
            "public class Greeter {",
            "    private final String name;",
            "",
            "    public Greeter(String name) {",
            "        this.name = name;",
            "    }",
            "",
            "    public String greet() {",
            '        return "hi " + name;',
            "    }",
            "}",
        ].join("\n"),
        strategy: "java",
        category: "code",
        language: "java",
        charset: "utf-8",
        expect: [
            { label: "com.example.app", type: "package" },
            { label: "Greeter", type: "class" },
            { label: "greet", type: "method" },
        ],
    },
    {
        group: "code",
        path: "src/add.c",
        content: ["#include <stdio.h>", "", "int add(int left, int right) {", "    return left + right;", "}"].join("\n"),
        strategy: "c",
        category: "code",
        language: "c",
        charset: "utf-8",
        expect: [{ label: "add", type: "function" }],
    },
    {
        group: "code",
        path: "src/add.h",
        content: ["#ifndef ADD_H", "#define ADD_H", "", "int add(int left, int right);", "", "#endif"].join("\n"),
        strategy: "c",
        category: "code",
        language: "c",
        charset: "utf-8",
        expect: [
            { label: "ADD_H", type: "macro" },
            { label: "add", type: "function" },
        ],
    },
    {
        group: "code",
        path: "src/add.cc",
        content: [
            "#include <string>",
            "",
            "namespace math {",
            "",
            "class Adder {",
            "public:",
            "    int add(int left, int right);",
            "};",
            "",
            "}",
        ].join("\n"),
        strategy: "cpp",
        category: "code",
        language: "cpp",
        charset: "utf-8",
        expect: [
            { label: "math", type: "namespace" },
            { label: "Adder", type: "class" },
            { label: "add", type: "method" },
        ],
    },
    {
        group: "code",
        path: "src/add.cpp",
        content: ["#include <string>", "", "int add(int left, int right) {", "    return left + right;", "}"].join("\n"),
        strategy: "cpp",
        category: "code",
        language: "cpp",
        charset: "utf-8",
        expect: [{ label: "add", type: "function" }],
    },
    {
        group: "code",
        path: "src/add.cxx",
        content: ["struct Point {", "    int x;", "    int y;", "};"].join("\n"),
        strategy: "cpp",
        category: "code",
        language: "cpp",
        charset: "utf-8",
        expect: [{ label: "Point", type: "struct" }],
    },
    {
        group: "code",
        path: "include/adder.hpp",
        content: ["#pragma once", "", "class Adder {", "public:", "    int add(int left, int right);", "};"].join("\n"),
        strategy: "cpp",
        category: "code",
        language: "cpp",
        charset: "utf-8",
        expect: [
            { label: "Adder", type: "class" },
            { label: "add", type: "method" },
        ],
    },
    {
        group: "code",
        path: "include/adder.hh",
        content: ["namespace math {", "", "struct Adder {", "    int add(int left, int right);", "};", "", "}"].join("\n"),
        strategy: "cpp",
        category: "code",
        language: "cpp",
        charset: "utf-8",
        expect: [
            { label: "math", type: "namespace" },
            { label: "Adder", type: "struct" },
        ],
    },
    {
        group: "code",
        path: "src/Greeter.cs",
        content: [
            "namespace Demo.App {",
            "    public class Greeter {",
            "        public string Name { get; set; }",
            "",
            "        public string Greet() {",
            '            return "hi " + Name;',
            "        }",
            "    }",
            "}",
        ].join("\n"),
        strategy: "csharp",
        category: "code",
        language: "csharp",
        charset: "utf-8",
        expect: [
            { label: "Demo.App", type: "namespace" },
            { label: "Greeter", type: "class" },
            { label: "Greet", type: "method" },
        ],
    },
    {
        group: "code",
        path: "src/server.go",
        content: [
            "package server",
            "",
            "type Config struct {",
            "    Port int",
            "}",
            "",
            "func Start(config Config) error {",
            "    return nil",
            "}",
        ].join("\n"),
        strategy: "go",
        category: "code",
        language: "go",
        charset: "utf-8",
        expect: [
            { label: "server", type: "package" },
            { label: "Config", type: "struct" },
            { label: "Start", type: "function" },
        ],
    },
    {
        group: "code",
        path: "src/lib.rs",
        content: [
            "pub struct Config {",
            "    pub port: u16,",
            "}",
            "",
            "pub fn start(config: Config) -> u16 {",
            "    config.port",
            "}",
        ].join("\n"),
        strategy: "rust",
        category: "code",
        language: "rust",
        charset: "utf-8",
        expect: [
            { label: "Config", type: "struct" },
            { label: "start", type: "function" },
        ],
    },
    {
        group: "code",
        path: "docs/page.html",
        content: HtmlPageText,
        strategy: "html",
        category: "code",
        language: "html",
        charset: "utf-8",
        expect: [
            { label: "Coverage Page", type: "heading" },
            { label: "Welcome & Overview", type: "heading" },
            { label: "pricing", type: "section", detail: "section" },
            { label: "Pricing", type: "heading" },
            { label: "release-notes", type: "section", detail: "article" },
            { label: "2026 — Notes", type: "heading" },
            { label: "Deep", type: "heading" },
            { label: "Deeper", type: "heading" },
            { label: "Deepest", type: "heading" },
        ],
    },
    {
        group: "code",
        path: "docs/legacy.htm",
        content: HtmlInlineText,
        strategy: "html",
        category: "code",
        language: "html",
        charset: "utf-8",
        expect: [
            { label: "Inline Page", type: "heading" },
            { label: "Details", type: "heading" },
        ],
    },
    {
        group: "code",
        path: "src/App.vue",
        content: VueText,
        strategy: "vue",
        category: "code",
        language: "vue",
        charset: "utf-8",
        expect: [
            { label: "template", type: "section" },
            { label: "Vue Page", type: "heading" },
            { label: "script (setup, ts)", type: "section" },
            { label: "count", type: "constant" },
        ],
    },
    {
        group: "project",
        path: "package.json",
        content: [
            "{",
            '  "name": "coverage-app",',
            '  "version": "1.0.0",',
            '  "scripts": {',
            '    "build": "tsc -p ."',
            "  },",
            '  "dependencies": {',
            '    "left-pad": "^1.0.0"',
            "  }",
            "}",
        ].join("\n"),
        strategy: "npm",
        category: "project",
        language: "json",
        charset: "utf-8",
        expect: [
            { label: "coverage-app", type: "package", detail: "coverage-app@1.0.0" },
            { label: "build", type: "script", detail: "tsc -p ." },
            { label: "left-pad", type: "dependency", detail: "^1.0.0" },
        ],
    },
    {
        group: "project",
        path: "pom.xml",
        content: [
            "<project>",
            "    <groupId>com.example</groupId>",
            "    <artifactId>coverage</artifactId>",
            "    <version>1.0.0</version>",
            "    <dependencies>",
            "        <dependency>",
            "            <groupId>org.example</groupId>",
            "            <artifactId>lib</artifactId>",
            "            <version>2.0.0</version>",
            "        </dependency>",
            "    </dependencies>",
            "</project>",
        ].join("\n"),
        strategy: "maven",
        category: "project",
        language: "xml",
        charset: "utf-8",
        expect: [
            { label: "coverage", type: "workspace", detail: "com.example:coverage:1.0.0" },
            { label: "lib", type: "dependency", detail: "org.example:lib:2.0.0" },
        ],
    },
    {
        group: "project",
        path: "build.gradle",
        content: [
            "plugins {",
            '    id("java")',
            "}",
            "",
            "dependencies {",
            '    implementation("org.slf4j:slf4j-api:2.0.0")',
            "}",
            "",
            "tasks {",
            '    register("integrationTest")',
            "}",
            "",
            'rootProject.name = "gradle-coverage"',
        ].join("\n"),
        strategy: "gradle",
        category: "project",
        language: "groovy",
        charset: "utf-8",
        expect: [
            { label: "gradle-coverage", type: "workspace", detail: "gradle" },
            { label: "java", type: "plugin" },
            { label: "slf4j-api", type: "dependency", detail: "org.slf4j:slf4j-api:2.0.0" },
            { label: "integrationTest", type: "task" },
        ],
    },
    {
        group: "project",
        path: "build.gradle.kts",
        content: ["plugins {", '    kotlin("jvm") version "2.0.0"', "}", "", 'rootProject.name = "kotlin-coverage"'].join("\n"),
        strategy: "gradle",
        category: "project",
        language: "groovy",
        charset: "utf-8",
        expect: [
            { label: "kotlin-coverage", type: "workspace" },
            { label: "jvm", type: "plugin", detail: "plugin:2.0.0" },
        ],
    },
    {
        group: "project",
        path: "settings.gradle",
        content: ['rootProject.name = "settings-coverage"', "", 'include("core", "app")'].join("\n"),
        strategy: "gradle",
        category: "project",
        language: "groovy",
        charset: "utf-8",
        expect: [
            { label: "settings-coverage", type: "workspace" },
            { label: "core", type: "module", detail: "include" },
            { label: "app", type: "module", detail: "include" },
        ],
    },
    {
        group: "project",
        path: "settings.gradle.kts",
        content: ['rootProject.name = "kts-settings"', "", 'include(":app")'].join("\n"),
        strategy: "gradle",
        category: "project",
        language: "groovy",
        charset: "utf-8",
        expect: [
            { label: "kts-settings", type: "workspace" },
            { label: ":app", type: "module" },
        ],
    },
    {
        group: "project",
        path: "CMakeLists.txt",
        content: [
            "cmake_minimum_required(VERSION 3.20)",
            "project(Coverage VERSION 1.0)",
            "",
            "add_library(core STATIC src/core.cpp)",
            "add_executable(app src/main.cpp)",
            "target_link_libraries(app PRIVATE core)",
        ].join("\n"),
        strategy: "cmake",
        category: "project",
        language: "cmake",
        charset: "utf-8",
        expect: [
            { label: "Coverage", type: "workspace", detail: "project" },
            { label: "core", type: "target", detail: "library:STATIC" },
            { label: "app", type: "target", detail: "executable" },
        ],
    },
    {
        group: "project",
        path: "cmake/Helpers.cmake",
        content: CmakeModuleText,
        strategy: "cmake",
        category: "project",
        language: "cmake",
        charset: "utf-8",
        expect: [
            { label: "Helpers.cmake", type: "workspace" },
            { label: "helpers", type: "target", detail: "library:INTERFACE" },
            { label: "tools", type: "module", detail: "subdirectory" },
        ],
    },
    {
        group: "project",
        path: "Cargo.toml",
        content: ["[package]", 'name = "coverage-core"', 'version = "0.1.0"', "", "[dependencies]", 'serde = "1.0"'].join("\n"),
        strategy: "cargo",
        category: "project",
        language: "toml",
        charset: "utf-8",
        expect: [
            { label: "coverage-core", type: "package", detail: "coverage-core 0.1.0" },
            { label: "serde", type: "dependency", detail: "1.0" },
        ],
    },
    {
        group: "project",
        path: "go.mod",
        content: ["module example.com/coverage", "", "go 1.22", "", "require (", "    github.com/stretchr/testify v1.9.0", ")"].join("\n"),
        strategy: "gomod",
        category: "project",
        language: "gomod",
        charset: "utf-8",
        expect: [
            { label: "example.com/coverage", type: "module", detail: "module" },
            { label: "github.com/stretchr/testify", type: "dependency", detail: "v1.9.0" },
        ],
    },
    {
        group: "project",
        path: "pyproject.toml",
        content: [
            "[project]",
            'name = "coverage-py"',
            'version = "0.1.0"',
            "dependencies = [",
            '    "requests>=2.31",',
            "]",
            "",
            "[project.scripts]",
            'coverage = "coverage.cli:main"',
        ].join("\n"),
        strategy: "pyproject",
        category: "project",
        language: "toml",
        charset: "utf-8",
        expect: [
            { label: "coverage-py", type: "package", detail: "coverage-py 0.1.0" },
            { label: "requests>=2.31", type: "dependency", detail: "runtime" },
            { label: "coverage", type: "script", detail: "coverage.cli:main" },
        ],
    },
    {
        group: "project",
        path: "Makefile",
        content: ["CC = gcc", "", "build: main.o", "\t$(CC) -o app main.o", "", "clean:", "\trm -f app"].join("\n"),
        strategy: "makefile",
        category: "project",
        language: "make",
        charset: "utf-8",
        expect: [
            { label: "CC", type: "variable", detail: "gcc" },
            { label: "build", type: "target", detail: "main.o" },
            { label: "clean", type: "target" },
        ],
    },
    {
        group: "project",
        path: "GNUmakefile",
        content: ["PREFIX = /usr/local", "", "install: build", "\tcp app $(PREFIX)/bin/app"].join("\n"),
        strategy: "makefile",
        category: "project",
        language: "make",
        charset: "utf-8",
        expect: [
            { label: "PREFIX", type: "variable", detail: "/usr/local" },
            { label: "install", type: "target", detail: "build" },
        ],
    },
    {
        group: "prose",
        path: "docs/guide.md",
        content: ["# Guide", "", "## Install", "", "Run it.", "", "### Options", "", "Text."].join("\n"),
        strategy: "markdown",
        category: "prose",
        language: "markdown",
        charset: "utf-8",
        expect: [
            { label: "Guide", type: "heading" },
            { label: "Install", type: "heading" },
            { label: "Options", type: "heading" },
        ],
    },
    {
        group: "prose",
        path: "docs/guide.mdx",
        content: ["# MDX Guide", "", "## Usage", "", "Component reference follows."].join("\n"),
        strategy: "markdown",
        category: "prose",
        language: "markdown",
        charset: "utf-8",
        expect: [
            { label: "MDX Guide", type: "heading" },
            { label: "Usage", type: "heading" },
        ],
    },
    {
        group: "prose",
        path: "docs/notes.markdown",
        content: ["Notes", "=====", "", "## Detail", "", "Body."].join("\n"),
        strategy: "markdown",
        category: "prose",
        language: "markdown",
        charset: "utf-8",
        expect: [
            { label: "Notes", type: "heading" },
            { label: "Detail", type: "heading" },
        ],
    },
    {
        group: "prose",
        path: "docs/paper.tex",
        content: [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\section{Introduction}",
            "\\subsection{Motivation}",
            "\\begin{figure}",
            "\\caption{A}",
            "\\end{figure}",
            "\\end{document}",
        ].join("\n"),
        strategy: "tex",
        category: "prose",
        language: "tex",
        charset: "utf-8",
        expect: [
            { label: "Introduction", type: "section" },
            { label: "Motivation", type: "subsection" },
            { label: "figure", type: "environment" },
        ],
    },
    {
        group: "prose",
        path: "docs/slides.ltx",
        content: ["\\documentclass{beamer}", "\\begin{document}", "\\section{Agenda}", "\\end{document}"].join("\n"),
        strategy: "tex",
        category: "prose",
        language: "tex",
        charset: "utf-8",
        expect: [{ label: "Agenda", type: "section" }],
    },
    {
        group: "prose",
        path: "styles/theme.sty",
        content: ["\\NeedsTeXFormat{LaTeX2e}", "\\ProvidesPackage{theme}", "\\section{Theme Options}"].join("\n"),
        strategy: "tex",
        category: "prose",
        language: "tex",
        charset: "utf-8",
        expect: [{ label: "Theme Options", type: "section" }],
    },
    {
        group: "prose",
        path: "styles/theme.cls",
        content: ["\\NeedsTeXFormat{LaTeX2e}", "\\ProvidesClass{theme}", "\\section{Class Options}"].join("\n"),
        strategy: "tex",
        category: "prose",
        language: "tex",
        charset: "utf-8",
        expect: [{ label: "Class Options", type: "section" }],
    },
    {
        group: "prose",
        path: "book/notes.txt",
        content: ["卷一 起始", "第一章 相遇", "第一节 初见", "正文段落。"].join("\n"),
        strategy: "plainText",
        category: "prose",
        language: "txt",
        charset: "utf-8",
        expect: [
            { label: "卷一 起始", type: "part" },
            { label: "第一章 相遇", type: "chapter" },
            { label: "第一节 初见", type: "section" },
        ],
    },
    {
        group: "prose",
        path: "docs/NOTES",
        content: ["CHAPTER ONE", "===========", "", "Body text."].join("\n"),
        strategy: "plainText",
        category: "prose",
        language: "text",
        charset: "utf-8",
        expect: [{ label: "CHAPTER ONE", type: "chapter" }],
    },
    {
        group: "office",
        path: "office/report.docx",
        content: DocxBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [
            { label: "Quarterly Report", type: "heading" },
            { label: "Revenue grew.", type: "paragraph" },
        ],
    },
    {
        group: "office",
        path: "office/legacy.doc",
        content: DocBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [{ label: "Word document", type: "section" }],
    },
    {
        group: "office",
        path: "office/budget.xlsx",
        content: XlsxBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [{ label: "Budget", type: "section" }],
    },
    {
        group: "office",
        path: "office/legacy.xls",
        content: XlsBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [
            { label: "Sheet1", type: "section" },
            { label: "Workbook text", type: "section" },
        ],
    },
    {
        group: "office",
        path: "office/deck.pptx",
        content: PptxBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [{ label: "Kickoff", type: "section" }],
    },
    {
        group: "office",
        path: "office/legacy.ppt",
        content: PptBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [{ label: "PowerPoint presentation", type: "section" }],
    },
    {
        group: "office",
        path: "office/legacy.pub",
        content: PubBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [{ label: "Publisher document", type: "section" }],
    },
    {
        group: "office",
        path: "office/contacts.accdb",
        content: AccdbBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [
            { label: "Access catalog (best effort)", type: "section" },
            { label: "Customers", type: "section" },
        ],
    },
    {
        group: "office",
        path: "office/contacts.mdb",
        content: MdbBytes,
        strategy: "office",
        category: "data",
        language: "office",
        charset: "binary",
        expect: [
            { label: "Access catalog (best effort)", type: "section" },
            { label: "qryActive", type: "section" },
        ],
    },
    {
        group: "data",
        path: "data/config.json",
        content: ["{", '  "name": "coverage",', '  "nested": {', '    "enabled": true', "  }", "}"].join("\n"),
        strategy: "json",
        category: "data",
        language: "json",
        charset: "utf-8",
        expect: [
            { label: "name", type: "key" },
            { label: "nested", type: "key" },
        ],
    },
    {
        group: "data",
        path: "data/config.jsonc",
        content: ["{", "  // a comment", '  "alpha": 1,', '  "beta": 2,', "}"].join("\n"),
        strategy: "json",
        category: "data",
        language: "json",
        charset: "utf-8",
        expect: [
            { label: "alpha", type: "key" },
            { label: "beta", type: "key" },
        ],
    },
    {
        group: "data",
        path: "data/style.css",
        content: [":root {", "    --brand: #ff0000;", "}", "", "body, .card {", "    color: var(--brand);", "}"].join("\n"),
        strategy: "css",
        category: "code",
        language: "css",
        charset: "utf-8",
        expect: [
            { label: ":root", type: "section" },
            { label: "--brand", type: "property", detail: "#ff0000" },
            { label: "body, .card", type: "section" },
        ],
    },
    {
        group: "data",
        path: "data/theme.scss",
        content: ScssText,
        strategy: "scss",
        category: "code",
        language: "scss",
        charset: "utf-8",
        expect: [
            { label: "$brand", type: "property", detail: "#111" },
            { label: ".button", type: "section" },
        ],
    },
    {
        group: "data",
        path: "styles/app.sass",
        content: SassText,
        strategy: "scss",
        category: "code",
        language: "scss",
        charset: "utf-8",
        expect: [
            { label: "$brand", type: "property", detail: "#111" },
            { label: ".button", type: "section" },
            { label: "color", type: "property" },
            { label: "&:hover", type: "section" },
            { label: "flex-center", type: "macro", detail: "@mixin flex-center" },
        ],
    },
    {
        group: "code",
        path: "src/Coverage.tsx",
        content: [
            'import React, { useState } from "react";',
            "",
            "interface AppProps { title: string; }",
            "",
            "export function App(props: AppProps) {",
            "    const [count, setCount] = useState(0);",
            "    return <main><h1>{props.title}</h1><span>{count}</span></main>;",
            "}",
        ].join("\n"),
        strategy: "react",
        category: "code",
        language: "react",
        charset: "utf-8",
        expect: [
            { label: "AppProps", type: "props" },
            { label: "App", type: "component" },
            { label: "useState", type: "hook" },
        ],
    },
    {
        group: "code",
        path: "src/Greeter.vb",
        content: [
            "Public Class Greeter",
            "    Private _name As String",
            "    Public Shared Function Hello() As String",
            '        Return "hello"',
            "    End Function",
            "End Class",
        ].join("\n"),
        strategy: "visualBasic",
        category: "code",
        language: "visualbasic",
        charset: "utf-8",
        expect: [
            { label: "Greeter", type: "class" },
            { label: "Hello", type: "function" },
        ],
    },
    {
        group: "code",
        path: "scripts/deploy.sh",
        content: ["#!/usr/bin/env bash", "set -euo pipefail", "", "deploy() {", '    echo "deploy"', "}", ""].join("\n"),
        strategy: "shell",
        category: "code",
        language: "shell",
        charset: "utf-8",
        expect: [{ label: "deploy", type: "function" }],
    },
    {
        group: "data",
        path: "db/schema.sql",
        content: ["CREATE TABLE users (", "    id INTEGER PRIMARY KEY,", "    name TEXT NOT NULL", ");"].join("\n"),
        strategy: "sql",
        category: "data",
        language: "sql",
        charset: "utf-8",
        expect: [
            { label: "users", type: "class" },
            { label: "id", type: "property" },
        ],
    },
    {
        group: "data",
        path: "data/feed.xml",
        content: ['<feed version="2"><entry id="a">one</entry></feed>'].join("\n"),
        strategy: "xml",
        category: "data",
        language: "xml",
        charset: "utf-8",
        expect: [
            { label: "feed", type: "key" },
            { label: "entry", type: "key", detail: "entry:a" },
        ],
    },
    {
        group: "data",
        path: "data/outline.opml",
        content: ['<opml version="2.0"><body><outline text="Chapter A"><outline text="Section A1"/></outline></body></opml>'].join("\n"),
        strategy: "opml",
        category: "prose",
        language: "opml",
        charset: "utf-8",
        expect: [
            { label: "body", type: "heading" },
            { label: "Chapter A", type: "heading" },
            { label: "Section A1", type: "heading" },
        ],
    },
];

/**
 * Assert the shared invariants of one fixture and its parser-level nodes.
 *
 * The invariants are the contract an outline consumer relies on: the anchor is
 * a file anchor, every symbol path is anchored at the file, line and byte
 * ranges are bigint and ordered, and every label is non-empty.
 *
 * @param spec - Coverage case to write and verify.
 */
const verifyCase: (spec: CoverageCase) => void = (spec: CoverageCase): void => {
    fixture(spec.path, spec.content);
    const result: OutlineResult = outline(spec.path);
    assert.equal(result.path, spec.path, `${spec.path}: result path`);
    assert.equal(result.target, "file", `${spec.path}: target`);
    assert.equal(result.strategy, spec.strategy, `${spec.path}: strategy`);
    assert.equal(result.category, spec.category, `${spec.path}: category`);
    assert.equal(result.language, spec.language, `${spec.path}: language`);
    assert.equal(result.charset, spec.charset, `${spec.path}: charset`);
    assert.equal(result.truncated, false, `${spec.path}: truncated`);
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/, `${spec.path}: fingerprint`);
    assert.equal(result.nodes.length, 1, `${spec.path}: one anchor`);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true, `${spec.path}: anchor isFile`);
    assert.equal(anchor.isDirectory, false, `${spec.path}: anchor isDirectory`);
    assert.equal(anchor.type, "File", `${spec.path}: anchor type`);
    assert.equal(anchor.path, spec.path, `${spec.path}: anchor path`);
    assert.ok(anchor.label.length > 0, `${spec.path}: anchor label`);
    const symbols: OutlineNode[] = flatten(result.nodes).filter((node: OutlineNode): boolean => !node.isFile && !node.isDirectory);
    assert.ok(symbols.length >= 1, `${spec.path}: at least one symbol`);
    for (let index: number = 0; index < symbols.length; index += 1) {
        const node: OutlineNode = symbols[index];
        assert.ok(node.label.length > 0, `${spec.path}: label`);
        assert.ok(node.path.startsWith(`${spec.path}#`), `${spec.path}: symbol path ${node.path}`);
        assert.equal(typeof(node.range.startLine), "bigint", `${spec.path}: bigint startLine`);
        assert.equal(typeof(node.range.endLine), "bigint", `${spec.path}: bigint endLine`);
        assert.equal(typeof(node.range.startByte), "bigint", `${spec.path}: bigint startByte`);
        assert.equal(typeof(node.range.endByte), "bigint", `${spec.path}: bigint endByte`);
        assert.ok(node.range.startLine <= node.range.endLine, `${spec.path}: line order at ${node.label}`);
        assert.ok(node.range.startByte <= node.range.endByte, `${spec.path}: byte order at ${node.label}`);
        assert.ok(node.range.startLine >= 1n, `${spec.path}: 1-based line at ${node.label}`);
        assert.ok(Number.isSafeInteger(node.depth) && node.depth >= 1, `${spec.path}: depth at ${node.label}`);
    }
    for (let index: number = 0; index < spec.expect.length; index += 1) {
        const expected: ExpectedNode = spec.expect[index];
        const node: OutlineNode = requireNode(anchor.children, expected.label);
        assert.equal(node.type, expected.type, `${spec.path}: ${expected.label} type`);
        if (expected.detail !== (void 0)) {
            assert.equal(node.detail, expected.detail, `${spec.path}: ${expected.label} detail`);
        }
    }
};

for (let index: number = 0; index < CoverageCases.length; index += 1) {
    const spec: CoverageCase = CoverageCases[index];
    test(`${spec.group} ${spec.path} -> ${spec.strategy}`, (): void => {
        verifyCase(spec);
    });
}

/**
 * One `matches` expectation: a base name and the strategy it must select.
 */
interface MatchCase {
    readonly name: string;
    readonly strategy: string;
}

/**
 * Every extension and exact file name in the catalog, mapped to the strategy
 * that must win selection. Exact names come first in the registry, so
 * `package.json` must not be selected as `json` and `pom.xml` not as `xml`.
 */
const MatchCases: readonly MatchCase[] = [
    { name: "app.ts", strategy: "typescript" },
    { name: "app.tsx", strategy: "typescript" },
    { name: "app.mts", strategy: "typescript" },
    { name: "app.cts", strategy: "typescript" },
    { name: "app.js", strategy: "javascript" },
    { name: "app.jsx", strategy: "javascript" },
    { name: "app.mjs", strategy: "javascript" },
    { name: "app.cjs", strategy: "javascript" },
    { name: "app.py", strategy: "python" },
    { name: "app.pyi", strategy: "python" },
    { name: "App.java", strategy: "java" },
    { name: "add.c", strategy: "c" },
    { name: "add.h", strategy: "c" },
    { name: "add.cc", strategy: "cpp" },
    { name: "add.cpp", strategy: "cpp" },
    { name: "add.cxx", strategy: "cpp" },
    { name: "adder.hpp", strategy: "cpp" },
    { name: "adder.hh", strategy: "cpp" },
    { name: "Greeter.cs", strategy: "csharp" },
    { name: "server.go", strategy: "go" },
    { name: "lib.rs", strategy: "rust" },
    { name: "package.json", strategy: "npm" },
    { name: "pom.xml", strategy: "maven" },
    { name: "build.gradle", strategy: "gradle" },
    { name: "build.gradle.kts", strategy: "gradle" },
    { name: "settings.gradle", strategy: "gradle" },
    { name: "settings.gradle.kts", strategy: "gradle" },
    { name: "CMakeLists.txt", strategy: "cmake" },
    { name: "Helpers.cmake", strategy: "cmake" },
    { name: "helpers.cmake", strategy: "cmake" },
    { name: "Cargo.toml", strategy: "cargo" },
    { name: "go.mod", strategy: "gomod" },
    { name: "pyproject.toml", strategy: "pyproject" },
    { name: "Makefile", strategy: "makefile" },
    { name: "GNUmakefile", strategy: "makefile" },
    { name: "guide.md", strategy: "markdown" },
    { name: "guide.mdx", strategy: "markdown" },
    { name: "guide.markdown", strategy: "markdown" },
    { name: "paper.tex", strategy: "tex" },
    { name: "slides.ltx", strategy: "tex" },
    { name: "theme.sty", strategy: "tex" },
    { name: "theme.cls", strategy: "tex" },
    { name: "book.txt", strategy: "plainText" },
    { name: "NOTES", strategy: "plainText" },
    { name: "README", strategy: "plainText" },
    { name: "report.docx", strategy: "office" },
    { name: "legacy.doc", strategy: "office" },
    { name: "budget.xlsx", strategy: "office" },
    { name: "legacy.xls", strategy: "office" },
    { name: "deck.pptx", strategy: "office" },
    { name: "legacy.ppt", strategy: "office" },
    { name: "legacy.pub", strategy: "office" },
    { name: "contacts.accdb", strategy: "office" },
    { name: "contacts.mdb", strategy: "office" },
    { name: "config.json", strategy: "json" },
    { name: "config.jsonc", strategy: "json" },
    { name: "style.css", strategy: "css" },
    { name: "theme.scss", strategy: "scss" },
    { name: "app.sass", strategy: "scss" },
    { name: "feed.xml", strategy: "xml" },
    { name: "page.html", strategy: "html" },
    { name: "legacy.htm", strategy: "html" },
    { name: "App.vue", strategy: "vue" },
    { name: "outline.opml", strategy: "opml" },
];

test("matches pins the strategy for every catalog extension and exact file name", (): void => {
    for (let index: number = 0; index < MatchCases.length; index += 1) {
        const spec: MatchCase = MatchCases[index];
        const selected: OutlineStrategy | undefined = OutlineStrategies.find(
            (strategy: OutlineStrategy): boolean => strategy.matches({ path: `probe/${spec.name}`, name: spec.name, head: "" }),
        );
        assert.ok(selected !== (void 0), `${spec.name}: no strategy matched`);
        assert.equal(selected!.id, spec.strategy, `${spec.name}: strategy`);
    }
    assert.equal(MatchCases.length, 64);
});

test("every registered strategy id appears in the fixture matrix", (): void => {
    const covered: ReadonlySet<string> = new Set<string>(CoverageCases.map((spec: CoverageCase): string => spec.strategy));
    const missing: string[] = OutlineStrategies.map((strategy: OutlineStrategy): string => strategy.id).filter(
        (id: string): boolean => !covered.has(id),
    );
    assert.deepEqual(missing, []);
    assert.equal(OutlineStrategies.length >= 27, true);
});

test(".sass uses the indented scanner: selectors nest, variables and mixins become nodes", (): void => {
    fixture("styles/app.sass", SassText);
    const result: OutlineResult = outline("styles/app.sass");
    assert.equal(result.strategy, "scss");
    assert.equal(result.category, "code");
    assert.equal(result.language, "scss");
    const brand: OutlineNode = requireNode(result.nodes, "$brand");
    assert.equal(brand.type, "property");
    assert.equal(brand.depth, 1);
    assert.equal(brand.detail, "#111");
    assert.equal(brand.path, "styles/app.sass#$brand");
    assert.equal(Number(brand.range.startLine), 1);
    assert.equal(Number(brand.range.endLine), 1);
    assert.equal(brand.range.startByte, 0n);
    const button: OutlineNode = requireNode(result.nodes, ".button");
    assert.equal(button.type, "section");
    assert.equal(button.depth, 1);
    assert.equal(button.path, "styles/app.sass#.button");
    assert.equal(Number(button.range.startLine), 3);
    assert.equal(Number(button.range.endLine), 6);
    assert.deepEqual(labels(button.children), ["color", "&:hover"]);
    const color: OutlineNode = requireNode(button.children, "color");
    assert.equal(color.type, "property");
    assert.equal(color.depth, 2);
    assert.equal(color.detail, "color: $brand");
    assert.equal(color.path, "styles/app.sass#.button.color");
    assert.equal(Number(color.range.startLine), 4);
    const hover: OutlineNode = requireNode(button.children, "&:hover");
    assert.equal(hover.type, "section");
    assert.equal(hover.depth, 2);
    assert.deepEqual(labels(hover.children), ["color"]);
    assert.equal(hover.children[0].depth, 3);
    assert.equal(hover.children[0].path, "styles/app.sass#.button.&:hover.color");
    assert.equal(Number(hover.children[0].range.startLine), 6);
    const mixin: OutlineNode = requireNode(result.nodes, "flex-center");
    assert.equal(mixin.type, "macro");
    assert.equal(mixin.depth, 1);
    assert.equal(mixin.detail, "@mixin flex-center");
    assert.equal(Number(mixin.range.startLine), 8);
    assert.equal(Number(mixin.range.endLine), 9);
    assert.deepEqual(labels(mixin.children), ["display"]);
});

test("parseSass is a pure parser: the same text yields the same tree without the registry", (): void => {
    const nodes: readonly OutlineNode[] = parseSass({ path: "styles/app.sass", text: SassText, lineIndex: new LineIndex(SassText) });
    assert.deepEqual(
        nodes.map((node: OutlineNode): string => `${node.type}:${node.label}:${node.depth}`),
        ["property:$brand:0", "section:.button:0", "macro:flex-center:0"],
    );
    assert.deepEqual(labels(nodes[1].children), ["color", "&:hover"]);
    assert.equal(nodes[2].range.startLine, 8n);
    assert.equal(nodes[2].range.endLine, 9n);
});

test(".scss keeps the brace scanner while sharing the scss strategy id", (): void => {
    fixture("data/theme.scss", ScssText);
    const result: OutlineResult = outline("data/theme.scss");
    assert.equal(result.strategy, "scss");
    const variable: OutlineNode = requireNode(result.nodes, "$brand");
    assert.equal(variable.type, "property");
    assert.equal(variable.detail, "#111");
    const rule: OutlineNode = requireNode(result.nodes, ".button");
    assert.equal(rule.type, "section");
    assert.equal(Number(rule.range.startLine), 3);
    assert.equal(Number(rule.range.endLine), 5);
    assert.equal(rule.children.length, 0);
});

test("extensionless plain text is matched explicitly and headingless text stays an empty anchor", (): void => {
    fixture("docs/README", "readme prose only\n");
    const readme: OutlineResult = outline("docs/README");
    assert.equal(readme.strategy, "plainText");
    assert.equal(readme.category, "prose");
    assert.equal(readme.language, "text");
    assert.equal(readme.nodes[0].isFile, true);
    assert.equal(readme.nodes[0].children.length, 0);
    const notes: OutlineResult = outline("docs/NOTES");
    assert.equal(notes.strategy, "plainText");
    assert.equal(Number(requireNode(notes.nodes, "CHAPTER ONE").range.startLine), 1);
});

test("a .cmake include module is a project outline named after the file", (): void => {
    fixture("cmake/Helpers.cmake", CmakeModuleText);
    const result: OutlineResult = outline("cmake/Helpers.cmake");
    assert.equal(result.strategy, "cmake");
    assert.equal(result.category, "project");
    assert.equal(result.language, "cmake");
    const root: OutlineNode = requireNode(result.nodes[0].children, "Helpers.cmake");
    assert.equal(root.type, "workspace");
    assert.equal(root.depth, 1);
    assert.equal(root.path, "cmake/Helpers.cmake#Helpers.cmake");
    assert.equal(Number(root.range.startLine), 1);
    const helpers: OutlineNode = requireNode(result.nodes[0].children, "helpers");
    assert.equal(helpers.type, "target");
    assert.equal(helpers.detail, "library:INTERFACE");
    assert.equal(Number(helpers.range.startLine), 1);
    const tools: OutlineNode = requireNode(result.nodes[0].children, "tools");
    assert.equal(tools.type, "module");
    assert.equal(tools.detail, "subdirectory");
    assert.equal(Number(tools.range.startLine), 2);
    assert.equal(findNode(result.nodes[0].children, "project"), undefined);
});

test("HTML maps h1..h6 to depths 1..6, the title to depth 1 and labelled landmarks to sections", (): void => {
    fixture("docs/page.html", HtmlPageText);
    const result: OutlineResult = outline("docs/page.html");
    assert.equal(result.strategy, "html");
    assert.equal(result.category, "code");
    assert.equal(result.language, "html");
    const title: OutlineNode = requireNode(result.nodes[0].children, "Coverage Page");
    assert.equal(title.type, "heading");
    assert.equal(title.depth, 1);
    assert.equal(title.path, "docs/page.html#Coverage Page");
    assert.equal(Number(title.range.startLine), 4);
    assert.equal(Number(title.range.endLine), 4);
    const h1: OutlineNode = requireNode(result.nodes[0].children, "Welcome & Overview");
    assert.equal(h1.depth, 1);
    assert.equal(Number(h1.range.startLine), 14);
    const section: OutlineNode = requireNode(result.nodes[0].children, "pricing");
    assert.equal(section.type, "section");
    assert.equal(section.detail, "section");
    assert.equal(section.depth, 1);
    assert.equal(Number(section.range.startLine), 15);
    assert.equal(Number(section.range.endLine), 18);
    const h2: OutlineNode = requireNode(section.children, "Pricing");
    assert.equal(h2.depth, 3);
    assert.equal(h2.path, "docs/page.html#pricing.Pricing");
    assert.equal(Number(h2.range.startLine), 16);
    const article: OutlineNode = requireNode(result.nodes[0].children, "release-notes");
    assert.equal(article.detail, "article");
    assert.equal(article.depth, 1);
    assert.equal(Number(article.range.startLine), 19);
    assert.equal(Number(article.range.endLine), 21);
    const h3: OutlineNode = requireNode(article.children, "2026 — Notes");
    assert.equal(h3.depth, 4);
    assert.equal(Number(h3.range.startLine), 20);
    assert.equal(requireNode(result.nodes[0].children, "Deep").depth, 4);
    assert.equal(requireNode(result.nodes[0].children, "Deeper").depth, 5);
    assert.equal(requireNode(result.nodes[0].children, "Deepest").depth, 6);
    assert.equal(findNode(result.nodes[0].children, "Not a heading"), undefined);
    assert.equal(findNode(result.nodes[0].children, "Comment heading"), undefined);
    assert.equal(findNode(result.nodes[0].children, "fake"), undefined);
    const inline: OutlineResult = outline("docs/legacy.htm");
    assert.equal(inline.strategy, "html");
    const inlineTitle: OutlineNode = requireNode(inline.nodes[0].children, "Inline Page");
    assert.equal(inlineTitle.depth, 1);
    const details: OutlineNode = requireNode(inline.nodes[0].children, "Details");
    assert.equal(details.depth, 2);
    assert.equal(details.path, "docs/legacy.htm#Inline Page.Details");
});

test("HTML is selected before XML content sniffing for a document with a DOCTYPE head", (): void => {
    const xml: OutlineStrategy | undefined = OutlineStrategies.find((strategy: OutlineStrategy): boolean => strategy.id === "xml");
    assert.ok(xml !== (void 0));
    assert.equal(xml!.matches({ path: "docs/page.html", name: "page.html", head: HtmlPageText }), true);
    const selected: OutlineStrategy | undefined = OutlineStrategies.find(
        (strategy: OutlineStrategy): boolean => strategy.matches({ path: "docs/page.html", name: "page.html", head: HtmlPageText }),
    );
    assert.ok(selected !== (void 0));
    assert.equal(selected!.id, "html");
});

test("Office sections are empty until installOfficeOutlineParser runs; buildOutline installs it", (): void => {
    assert.deepEqual(OfficeSectionsBeforeInstall, []);
    assert.equal(buildOutline(Sandbox, "office/report.docx").strategy, "office");
    const afterInstall: readonly OutlineNode[] = parseOfficeStrategy({ path: "office/report.docx", bytes: DocxBytes });
    assert.ok(afterInstall.length >= 1);
    assert.equal(afterInstall[0].label, "Quarterly Report");
    /**
     * The raw extractor anchors a section with its Office id
     * (`heading-0`); `buildOutline` rewrites the path from the label, which is
     * why the same section is `#Quarterly Report` in an outline result.
     */
    assert.equal(afterInstall[0].path, "office/report.docx#heading-0");
    assert.equal(Number(afterInstall[0].range.startLine), 1);
    assert.equal(typeof(afterInstall[0].range.startLine), "bigint");
});

test("Office parsers expose the container kinds behind the outline section mapping", (): void => {
    fixture("office/report.docx", DocxBytes);
    fixture("office/budget.xlsx", XlsxBytes);
    fixture("office/deck.pptx", PptxBytes);
    fixture("office/legacy.xls", XlsBytes);
    fixture("office/contacts.accdb", AccdbBytes);
    const report: OfficeDocument = parseOfficeDocument(Sandbox, "office/report.docx");
    assert.equal(report.kind, "word");
    assert.equal(report.sections[0].kind, "heading");
    assert.equal(report.sections[0].label, "Quarterly Report");
    assert.equal(report.sections[0].children[0].kind, "paragraph");
    const workbook: OfficeDocument = parseOfficeDocument(Sandbox, "office/budget.xlsx");
    assert.equal(workbook.kind, "excel");
    assert.equal(workbook.sections[0].kind, "sheet");
    assert.equal(workbook.sections[0].label, "Budget");
    const deck: OfficeDocument = parseOfficeDocument(Sandbox, "office/deck.pptx");
    assert.equal(deck.kind, "powerpoint");
    assert.equal(deck.sections[0].kind, "slide");
    assert.equal(deck.sections[0].label, "Kickoff");
    const legacySheet: OfficeDocument = parseOfficeDocument(Sandbox, "office/legacy.xls");
    assert.equal(legacySheet.sections[0].kind, "sheet");
    assert.equal(legacySheet.sections[0].label, "Sheet1");
    const database: OfficeDocument = parseOfficeDocument(Sandbox, "office/contacts.accdb");
    assert.equal(database.kind, "access");
    assert.equal(database.sections[0].label, "Access catalog (best effort)");
    assert.deepEqual(
        database.sections[0].children.map((section: OfficeSection): string => `${section.kind}:${section.label}`),
        ["table:Customers", "query:qryActive"],
    );
});

test("Office outline nodes use synthetic document-order lines and proportional bytes", (): void => {
    const result: OutlineResult = outline("office/deck.pptx");
    const slide: OutlineNode = requireNode(result.nodes, "Kickoff");
    assert.equal(slide.type, "section");
    assert.equal(slide.path, "office/deck.pptx#Kickoff");
    assert.equal(slide.range.startLine, 1n);
    assert.equal(slide.range.startByte, 0n);
    assert.ok(slide.range.endByte > slide.range.startByte);
    assert.ok(slide.range.endByte <= BigInt(PptxBytes.length));
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(PptxBytes.length));
    assert.equal(result.charset, "binary");
});
