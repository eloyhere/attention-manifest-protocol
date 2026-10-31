#!/usr/bin/env node
/**
 * Plain-text outline boundary checks.
 *
 * The fixtures are written to a private temporary directory and removed after
 * the run; no fixture code is executed and no third-party parser is involved.
 * Every assertion uses the public `buildOutline` entry point, so the sandbox
 * resolution, charset gate, anchor construction, UTF-8 ranges, truncation and
 * strategy selection are all exercised together.
 *
 * The suite covers extension selection (`.txt`, `.text`, `.log`, no extension,
 * uppercase extension), 卷/Part/Volume, 章/Chapter, 节/Section and `回` ranks,
 * `=`/`-`/`~` underlines, short all-uppercase titles, numbered `1.`/`1.1`
 * headings, ordinary paragraphs, lists, punctuation, long lines and indented
 * code samples, empty/whitespace-only/no-EOL/CRLF/BOM/Unicode inputs, the
 * maxNodes/maxDepth bounds, binary and oversize refusals, the 3000-line scan
 * ceiling, duplicate labels, symbol-path escaping and bigint range ordering.
 *
 * Two regression guards cover the false positives fixed in `parsePlainText`:
 * a tab or four-space indented code line must not become a heading, and an
 * ordinary prose sentence beginning with a Part/Book/Chapter/Section word must
 * not become a structural node while title-like lines still do. The report in
 * `docs/testing/languages/textReport.md` records the matrix and the remaining
 * design limitations.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-text-outline-"));
const RootSpec: SessionRoot = { id: "root.text.outline", path: Root, writable: true, exclude: [] };
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
 * Run the public builder against the fixture sandbox.
 */
const outline: (path: string, options?: OutlineOptions) => OutlineResult = (path: string, options: OutlineOptions = {}): OutlineResult =>
    buildOutline(Sandbox, path, options);

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
 * Labels of a node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] => nodes.map((node: OutlineNode): string => node.label);

/**
 * First node with one label, depth first.
 */
const findNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined = (
    nodes: readonly OutlineNode[],
    label: string,
): OutlineNode | undefined => {
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
 * First node with one label; fails the test when absent.
 */
const requireNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode = (nodes: readonly OutlineNode[], label: string): OutlineNode => {
    const node: OutlineNode | undefined = findNode(nodes, label);
    assert.ok(node !== (void 0), `missing outline node: ${label}`);
    return node!;
};

/**
 * 1-based start byte offset of one line, treating `\n` as the only separator so
 * a preceding `\r` belongs to the previous line.
 */
const startByteOf: (text: string, line: number) => bigint = (text: string, line: number): bigint => {
    const lines: string[] = text.split("\n");
    let total: number = 0;
    for (let index: number = 0; index < Math.min(line - 1, lines.length); index += 1) {
        total += Buffer.byteLength(lines[index], "utf8") + 1;
    }
    return BigInt(total);
};

/**
 * Half-open byte range for an inclusive line span.
 */
const expectedBytes: (text: string, startLine: number, endLine: number) => { readonly startByte: bigint; readonly endByte: bigint } = (
    text: string,
    startLine: number,
    endLine: number,
): { readonly startByte: bigint; readonly endByte: bigint } => {
    const lines: string[] = text.split("\n");
    const endsWithNewline: boolean = text.endsWith("\n");
    const startByte: bigint = startByteOf(text, startLine);
    const endByte: bigint = endLine >= lines.length && !endsWithNewline ? BigInt(Buffer.byteLength(text, "utf8")) : startByteOf(text, endLine + 1);
    return { startByte, endByte };
};

/**
 * Assert one node's line and byte range against decoded source text.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (
    node: OutlineNode,
    text: string,
    startLine: number,
    endLine: number,
): void => {
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    const expected: { readonly startByte: bigint; readonly endByte: bigint } = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte);
    assert.equal(node.range.endByte, expected.endByte);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Minimal body shared by the extension fixtures: one chapter and one paragraph.
 */
const PlainBookText: string = ["第一章 开始", "正文。", ""].join("\n");
fixture("ext/book.txt", PlainBookText);
fixture("ext/notes.text", PlainBookText);
fixture("ext/run.log", PlainBookText);
fixture("ext/MANUAL", PlainBookText);
fixture("ext/UPPER.TXT", PlainBookText);

/**
 * English volume/chapter/section markers: a second Part closes the first
 * subtree, so the two blocks are separate roots.
 */
const EnglishLevelsText: string = ["PART ONE", "CHAPTER 1", "Section 1.1", "Ordinary body.", "BOOK TWO", "Chapter Two", "SECTION TWO"].join("\n");
fixture("levels/english.txt", EnglishLevelsText);

/**
 * CJK volume/chapter/section markers, including `回` and a spaced `第 N 节`.
 */
const CjkLevelsText: string = ["第一卷 风起", "第1章 少年", "第 2 节 相遇", "第3回 转折"].join("\n");
fixture("levels/cjk.txt", CjkLevelsText);

/**
 * Underline titles: `=` is level 0, `-` and `~` are level 1, and the underline
 * line belongs to the heading range.
 */
const UnderlineText: string = ["MAIN TITLE", "==========", "Sub Title", "---------", "Third", "~~~~~~", "Body text.", "THE ENDING"].join("\n");
fixture("levels/underline.txt", UnderlineText);

/**
 * Word-boundary decoys: PARTIAL is not Part, while PART/Part/VOLUME/Book are.
 */
const UppercaseText: string = ["PART A", "PARTIAL THOUGHT", "Part B", "VOLUME 1", "Book C"].join("\n");
fixture("levels/uppercase.txt", UppercaseText);

/**
 * Ordinary prose, a continuation line, bullet/star/numbered list items, a
 * punctuation-led line, a Markdown-looking line and a lone `---` separator.
 * None of them is a heading.
 */
const OrdinaryText: string = [
    "A normal paragraph starts here.",
    "Another sentence, with punctuation.",
    "    indented continuation line",
    "- bullet item without heading",
    "* star item",
    "1. numbered list item",
    "1.1 nested list item",
    "!!! Warning at the start",
    "# Markdown style heading in a txt file",
    "",
    "---",
].join("\n");
fixture("prose/ordinary.txt", OrdinaryText);

/**
 * One very long paragraph line between two chapters: it must stay body text and
 * still be covered by the first chapter's byte range.
 */
const LongLine: string = "A long paragraph line " + "word ".repeat(200);
const LongLineText: string = ["第一章 开始", LongLine, "第二章 结束"].join("\n");
fixture("prose/longline.txt", LongLineText);

/**
 * Numbered headings are not recognized on their own; only an underline makes
 * the numbered line a heading.
 */
const NumberedText: string = ["1. Introduction", "1.1 Background", "2. Methods"].join("\n");
fixture("prose/numbered.txt", NumberedText);
const NumberedUnderlineText: string = ["1. Introduction", "==============="].join("\n");
fixture("prose/numbered-underline.txt", NumberedUnderlineText);

/**
 * Indented sample code whose trimmed lines look like chapter/uppercase titles.
 */
const CodeIndentText: string = ["Setup:", "    CHAPTER 1: INSTALL", "    npm install demo", "    THE QUICK START", "\tCHAPTER 2: CONFIG", "Done."].join("\n");
fixture("prose/code.txt", CodeIndentText);

/**
 * Two leading spaces are layout, not code: the heading must still parse. Only
 * a tab or four spaces mark a code sample.
 */
fixture("prose/indent-heading.txt", "  第一章 开始\n正文。\n");

/**
 * Ordinary sentences whose first word is a volume/chapter/section marker.
 */
const ProseMarkersText: string = [
    "Part of the reason is simple.",
    "Book a table before noon.",
    "Chapter one was the hardest.",
    "Section 3 describes the test.",
].join("\n");
fixture("prose/markers.txt", ProseMarkersText);

/**
 * Legitimate marker titles that must survive the prose-sentence guard: a
 * connector (`of`, `a`), a spelled-out number (`one`) and title case.
 */
const MarkerTitleText: string = ["Part of Speech", "Book a Table", "Chapter one", "Section Two"].join("\n");
fixture("prose/markers-title.txt", MarkerTitleText);

fixture("edge/empty.txt", "");
fixture("edge/blank.txt", "   \n\n\t\n");
fixture("edge/noeol.txt", "第一章 开始");

/**
 * CRLF input: labels must not keep `\r`, but byte ranges must include both CRLF
 * bytes.
 */
const CrlfText: string = ["第一章 开始", "正文。", "第一节 结束", ""].join("\r\n");
fixture("edge/crlf.txt", CrlfText);

/**
 * CJK body with two chapters; the first chapter ends before the second one.
 */
const UnicodeText: string = ["第一章 相遇", "正文第二段落。", "第二章 重逢"].join("\n");
fixture("edge/unicode.txt", UnicodeText);

/**
 * Duplicate labels at the root level and inside one volume.
 */
const DuplicateText: string = ["第一章 同一章", "正文。", "第一章 同一章", "第一卷 卷", "第一章 章", "第一章 章"].join("\n");
fixture("edge/dup.txt", DuplicateText);

/**
 * Labels containing the three symbol-path separators.
 */
const EscapeText: string = ["第一章 C# 与 100%", "第一节 a/b 路径"].join("\n");
fixture("edge/escape.txt", EscapeText);

/**
 * UTF-8 BOM followed by a normal chapter.
 */
const BomBody: string = "第一章 开始\n正文。\n";
const BomBytes: Buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomBody, "utf8")]);
fixture("edge/bom.txt", BomBytes);

/**
 * Six top-level chapters for the node budget.
 */
const ManyText: string = ["第一章 一", "第二章 二", "第三章 三", "第四章 四", "第五章 五", "第六章 六"].join("\n");
fixture("limits/many.txt", ManyText);

/**
 * One part/chapter/section chain for the depth ceiling.
 */
const DepthText: string = ["第一卷 卷", "第一章 章", "第一节 节"].join("\n");
fixture("limits/depth.txt", DepthText);

/**
 * A 3001-line file: the chapter on line 3001 is outside the 3000-line scan.
 */
const ScanLateText: string = ["第一卷 开始", ...new Array<string>(2999).fill("正文段落。"), "第一章 迟到"].join("\n");
fixture("scan/late.txt", ScanLateText);

fixture("edge/blob.bin", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("edge/huge.txt", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

/**
 * A `.txt` whose head is XML: the XML content sniffer runs before the
 * plain-text fallback.
 */
fixture("ext/sniff.txt", "<note>plain text</note>\n");

test("txt, text, log and extensionless paths select plainText with their extension as language", (): void => {
    const cases: readonly (readonly [string, string])[] = [
        ["ext/book.txt", "txt"],
        ["ext/notes.text", "text"],
        ["ext/run.log", "log"],
        ["ext/MANUAL", "text"],
        ["ext/UPPER.TXT", "txt"],
    ];
    for (let index: number = 0; index < cases.length; index += 1) {
        const path: string = cases[index][0];
        const language: string = cases[index][1];
        const result: OutlineResult = outline(path);
        assert.equal(result.strategy, "plainText", `${path} strategy`);
        assert.equal(result.category, "prose", `${path} category`);
        assert.equal(result.language, language, `${path} language`);
        assert.equal(result.target, "file", `${path} target`);
        assert.equal(result.charset, "utf-8", `${path} charset`);
        assert.equal(result.truncated, false, `${path} truncation`);
        const anchor: OutlineNode = result.nodes[0];
        assert.equal(anchor.isFile, true);
        assert.equal(anchor.isDirectory, false);
        assert.equal(anchor.type, "File");
        assert.equal(anchor.path, path);
        assert.equal(anchor.label, path.slice(path.lastIndexOf("/") + 1));
        assert.equal(anchor.range.startByte, 0n);
        assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(PlainBookText, "utf8")));
        assert.equal(Number(anchor.range.endLine), 2);
        assert.equal(anchor.file!.fingerprint, result.fingerprint);
        const chapter: OutlineNode = requireNode(result.nodes, "第一章 开始");
        assert.equal(chapter.type, "chapter");
        assert.equal(chapter.depth, 2);
        assert.equal(chapter.path, `${path}#第一章 开始`);
        assertRange(chapter, PlainBookText, 1, 2);
    }
});

test("English part, chapter and section markers nest by rank and a second Part closes the first", (): void => {
    const result: OutlineResult = outline("levels/english.txt");
    assert.equal(result.strategy, "plainText");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["PART ONE", "BOOK TWO"]);
    const part: OutlineNode = requireNode(result.nodes, "PART ONE");
    assert.equal(part.type, "part");
    assert.equal(part.depth, 1);
    assertRange(part, EnglishLevelsText, 1, 4);
    const chapter: OutlineNode = requireNode(result.nodes, "CHAPTER 1");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assertRange(chapter, EnglishLevelsText, 2, 4);
    assert.deepEqual(labels(part.children), ["CHAPTER 1"]);
    const section: OutlineNode = requireNode(result.nodes, "Section 1.1");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assertRange(section, EnglishLevelsText, 3, 4);
    assert.deepEqual(labels(chapter.children), ["Section 1.1"]);
    const secondPart: OutlineNode = requireNode(result.nodes, "BOOK TWO");
    assert.equal(secondPart.type, "part");
    assert.equal(secondPart.depth, 1);
    assertRange(secondPart, EnglishLevelsText, 5, 7);
    const secondChapter: OutlineNode = requireNode(result.nodes, "Chapter Two");
    assert.equal(secondChapter.type, "chapter");
    assert.equal(secondChapter.depth, 2);
    assert.deepEqual(labels(secondPart.children), ["Chapter Two"]);
    const secondSection: OutlineNode = requireNode(result.nodes, "SECTION TWO");
    assert.equal(secondSection.type, "section");
    assert.equal(secondSection.depth, 3);
    assertRange(secondSection, EnglishLevelsText, 7, 7);
    assert.equal(findNode(result.nodes, "Ordinary body."), undefined);
});

test("CJK volume, chapter, section and 回 markers use the same three ranks", (): void => {
    const result: OutlineResult = outline("levels/cjk.txt");
    assert.equal(result.strategy, "plainText");
    const volume: OutlineNode = requireNode(result.nodes, "第一卷 风起");
    assert.equal(volume.type, "part");
    assert.equal(volume.depth, 1);
    assertRange(volume, CjkLevelsText, 1, 4);
    const chapter: OutlineNode = requireNode(result.nodes, "第1章 少年");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assertRange(chapter, CjkLevelsText, 2, 3);
    const section: OutlineNode = requireNode(chapter.children, "第 2 节 相遇");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assertRange(section, CjkLevelsText, 3, 3);
    const hui: OutlineNode = requireNode(result.nodes, "第3回 转折");
    assert.equal(hui.type, "chapter");
    assert.equal(hui.depth, 2);
    assertRange(hui, CjkLevelsText, 4, 4);
    assert.deepEqual(labels(volume.children), ["第1章 少年", "第3回 转折"]);
    assert.deepEqual(labels(chapter.children), ["第 2 节 相遇"]);
});

test("underline titles map = to level 0, - and ~ to level 1 and include the underline line", (): void => {
    const result: OutlineResult = outline("levels/underline.txt");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["MAIN TITLE", "THE ENDING"]);
    const main: OutlineNode = requireNode(result.nodes, "MAIN TITLE");
    assert.equal(main.type, "heading");
    assert.equal(main.depth, 1);
    assertRange(main, UnderlineText, 1, 7);
    assert.deepEqual(labels(main.children), ["Sub Title", "Third"]);
    const sub: OutlineNode = requireNode(result.nodes, "Sub Title");
    assert.equal(sub.type, "heading");
    assert.equal(sub.depth, 2);
    assertRange(sub, UnderlineText, 3, 4);
    assert.equal(Number(sub.range.endLine), 4, "the underline line belongs to the heading range");
    const third: OutlineNode = requireNode(result.nodes, "Third");
    assert.equal(third.type, "heading");
    assert.equal(third.depth, 2);
    assertRange(third, UnderlineText, 5, 7);
    const upper: OutlineNode = requireNode(result.nodes, "THE ENDING");
    assert.equal(upper.type, "heading");
    assert.equal(upper.depth, 1);
    assertRange(upper, UnderlineText, 8, 8);
    assert.equal(findNode(result.nodes, "Body text."), undefined);
});

test("short all-uppercase titles are level-0 headings while PARTIAL stays a full title", (): void => {
    const result: OutlineResult = outline("levels/uppercase.txt");
    const children: readonly OutlineNode[] = result.nodes[0].children;
    assert.deepEqual(labels(children), ["PART A", "PARTIAL THOUGHT", "Part B", "VOLUME 1", "Book C"]);
    assert.deepEqual(
        children.map((node: OutlineNode): string => node.type),
        ["part", "heading", "part", "part", "part"],
    );
    for (let index: number = 0; index < children.length; index += 1) {
        assert.equal(children[index].depth, 1);
        assert.equal(children[index].path, `levels/uppercase.txt#${children[index].label}`);
    }
    assert.equal(requireNode(result.nodes, "PARTIAL THOUGHT").type, "heading");
    assert.equal(findNode(result.nodes, "PARTIAL"), undefined);
});

test("ordinary paragraphs, lists, punctuation, Markdown syntax and a lone rule produce no symbols", (): void => {
    const result: OutlineResult = outline("prose/ordinary.txt");
    assert.equal(result.strategy, "plainText");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), []);
    assert.equal(findNode(result.nodes, "# Markdown style heading in a txt file"), undefined);
    assert.equal(findNode(result.nodes, "1. numbered list item"), undefined);
});

test("a very long paragraph line stays body text but is covered by the chapter byte range", (): void => {
    const result: OutlineResult = outline("prose/longline.txt");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(flatten(result.nodes).length, 3);
    const first: OutlineNode = requireNode(result.nodes, "第一章 开始");
    const second: OutlineNode = requireNode(result.nodes, "第二章 结束");
    assertRange(first, LongLineText, 1, 2);
    assertRange(second, LongLineText, 3, 3);
    assert.ok(first.range.endByte - first.range.startByte > 1000n);
    assert.equal(findNode(result.nodes, LongLine), undefined);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(LongLineText, "utf8")));
});

test("numbered 1. and 1.1 headings are not recognized without an underline", (): void => {
    const result: OutlineResult = outline("prose/numbered.txt");
    assert.equal(result.strategy, "plainText");
    assert.deepEqual(labels(result.nodes[0].children), []);
    const underlined: OutlineResult = outline("prose/numbered-underline.txt");
    const heading: OutlineNode = requireNode(underlined.nodes, "1. Introduction");
    assert.equal(heading.type, "heading");
    assert.equal(heading.depth, 1);
    assertRange(heading, NumberedUnderlineText, 1, 2);
});

test("indented code samples are not promoted to headings", (): void => {
    const result: OutlineResult = outline("prose/code.txt");
    assert.deepEqual(labels(result.nodes[0].children), [], "indented code lines must not become headings");
    const shallow: OutlineResult = outline("prose/indent-heading.txt");
    const chapter: OutlineNode = requireNode(shallow.nodes, "第一章 开始");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
});

test("ordinary prose sentences beginning with Part, Book, Chapter or Section are not headings", (): void => {
    const result: OutlineResult = outline("prose/markers.txt");
    assert.deepEqual(labels(result.nodes[0].children), [], "ordinary sentences must not become part/chapter/section nodes");
    const titled: OutlineResult = outline("prose/markers-title.txt");
    assert.deepEqual(labels(titled.nodes[0].children), ["Part of Speech", "Book a Table"]);
    const partTitle: OutlineNode = requireNode(titled.nodes, "Part of Speech");
    assert.equal(partTitle.type, "part");
    assert.equal(partTitle.depth, 1);
    const chapterTitle: OutlineNode = requireNode(titled.nodes, "Chapter one");
    assert.equal(chapterTitle.type, "chapter");
    assert.equal(chapterTitle.depth, 2);
    const sectionTitle: OutlineNode = requireNode(titled.nodes, "Section Two");
    assert.equal(sectionTitle.type, "section");
    assert.equal(sectionTitle.depth, 3);
});

test("an empty plain-text file yields a zero-range anchor and no symbols", (): void => {
    const result: OutlineResult = outline("edge/empty.txt");
    assert.equal(result.strategy, "plainText");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "txt");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, 0n);
    assert.equal(anchor.range.startLine, 1n);
    assert.equal(anchor.range.endLine, 1n);
    assert.deepEqual(labels(anchor.children), []);
    assert.equal(anchor.file!.lines, 0n);
    assert.equal(anchor.file!.bytes, 0n);
    assert.equal(anchor.file!.fingerprint, result.fingerprint);
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("whitespace-only files keep their line count and a file without EOL ends on line 1", (): void => {
    const blank: OutlineResult = outline("edge/blank.txt");
    const blankAnchor: OutlineNode = blank.nodes[0];
    assert.deepEqual(labels(blankAnchor.children), []);
    assert.equal(Number(blankAnchor.range.endLine), 3);
    assert.equal(blankAnchor.range.endByte, BigInt(Buffer.byteLength("   \n\n\t\n", "utf8")));
    assert.equal(blankAnchor.file!.lines, 3n);
    const noEol: OutlineResult = outline("edge/noeol.txt");
    const noEolAnchor: OutlineNode = noEol.nodes[0];
    assert.equal(Number(noEolAnchor.range.endLine), 1);
    assert.equal(noEolAnchor.range.endByte, BigInt(Buffer.byteLength("第一章 开始", "utf8")));
    const chapter: OutlineNode = requireNode(noEol.nodes, "第一章 开始");
    assertRange(chapter, "第一章 开始", 1, 1);
});

test("CRLF input keeps line numbers and includes both terminator bytes in ranges", (): void => {
    const result: OutlineResult = outline("edge/crlf.txt");
    assert.equal(result.charset, "utf-8");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(Number(anchor.range.endLine), 3);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(CrlfText, "utf8")));
    assert.equal(anchor.file!.lines, 3n);
    const chapter: OutlineNode = requireNode(result.nodes, "第一章 开始");
    assert.equal(chapter.label, "第一章 开始");
    assert.ok(!chapter.label.includes("\r"));
    assertRange(chapter, CrlfText, 1, 3);
    const section: OutlineNode = requireNode(result.nodes, "第一节 结束");
    assertRange(section, CrlfText, 3, 3);
    assert.equal(section.range.endByte, anchor.range.endByte);
});

test("UTF-8 BOM is detected, stripped for parsing and still yields chapter labels", (): void => {
    const result: OutlineResult = outline("edge/bom.txt");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.strategy, "plainText");
    assert.equal(result.language, "txt");
    assert.equal(result.nodes[0].file!.bytes, BigInt(BomBytes.length));
    const chapter: OutlineNode = requireNode(result.nodes, "第一章 开始");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assert.equal(chapter.label, "第一章 开始");
});

test("a UTF-8 BOM keeps the file anchor byte range aligned with the raw file", (): void => {
    const result: OutlineResult = outline("edge/bom.txt");
    assert.equal(result.nodes[0].range.endByte, BigInt(BomBytes.length), "the anchor endByte must cover the 3 BOM bytes");
});

test("a UTF-8 BOM does not shift symbol byte offsets", (): void => {
    const result: OutlineResult = outline("edge/bom.txt");
    const chapter: OutlineNode = requireNode(result.nodes, "第一章 开始");
    assert.equal(chapter.range.startByte, 3n, "the first symbol must start after the BOM");
    assert.equal(chapter.range.endByte, BigInt(BomBytes.length), "the symbol endByte must be a raw-file offset");
});

test("CJK labels survive and their byte ranges count every UTF-8 byte", (): void => {
    const result: OutlineResult = outline("edge/unicode.txt");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(UnicodeText, "utf8")));
    assert.equal(Number(anchor.range.endLine), 3);
    const first: OutlineNode = requireNode(result.nodes, "第一章 相遇");
    assert.equal(first.type, "chapter");
    assert.equal(first.depth, 2);
    assert.equal(first.path, "edge/unicode.txt#第一章 相遇");
    assertRange(first, UnicodeText, 1, 2);
    assert.equal(first.range.endByte - first.range.startByte, BigInt(Buffer.byteLength("第一章 相遇\n正文第二段落。\n", "utf8")));
    const second: OutlineNode = requireNode(result.nodes, "第二章 重逢");
    assertRange(second, UnicodeText, 3, 3);
    assert.ok(second.range.startByte > first.range.startByte);
});

test("maxNodes counts the anchor, truncates in preorder and rejects invalid values", (): void => {
    const complete: OutlineResult = outline("limits/many.txt");
    assert.equal(complete.nodes[0].children.length, 6);
    assert.equal(complete.truncated, false);
    const one: OutlineResult = outline("limits/many.txt", { maxNodes: 1 });
    assert.equal(one.truncated, true);
    assert.deepEqual(labels(one.nodes[0].children), []);
    assert.equal(flatten(one.nodes).length, 1);
    const three: OutlineResult = outline("limits/many.txt", { maxNodes: 3 });
    assert.equal(three.truncated, true);
    assert.deepEqual(labels(three.nodes[0].children), ["第一章 一", "第二章 二"]);
    assert.equal(flatten(three.nodes).length, 3);
    const hundred: OutlineResult = outline("limits/many.txt", { maxNodes: 100 });
    assert.equal(hundred.truncated, false);
    assert.equal(hundred.nodes[0].children.length, 6);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/many.txt", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/many.txt", { maxNodes: 2.5 });
    });
});

test("maxDepth drops deeper ranks with their subtree and rejects zero", (): void => {
    const complete: OutlineResult = outline("limits/depth.txt");
    const part: OutlineNode = requireNode(complete.nodes, "第一卷 卷");
    const chapter: OutlineNode = requireNode(complete.nodes, "第一章 章");
    const section: OutlineNode = requireNode(complete.nodes, "第一节 节");
    assert.equal(part.type, "part");
    assert.equal(part.depth, 1);
    assert.equal(chapter.depth, 2);
    assert.equal(section.depth, 3);
    assert.equal(complete.truncated, false);
    const two: OutlineResult = outline("limits/depth.txt", { maxDepth: 2 });
    assert.equal(two.truncated, true);
    assert.deepEqual(labels(two.nodes[0].children), ["第一卷 卷"]);
    assert.deepEqual(labels(requireNode(two.nodes, "第一卷 卷").children), ["第一章 章"]);
    assert.equal(findNode(two.nodes, "第一节 节"), undefined);
    const one: OutlineResult = outline("limits/depth.txt", { maxDepth: 1 });
    assert.equal(one.truncated, true);
    assert.deepEqual(labels(one.nodes[0].children), ["第一卷 卷"]);
    assert.deepEqual(labels(requireNode(one.nodes, "第一卷 卷").children), []);
    const high: OutlineResult = outline("limits/depth.txt", { maxDepth: 99 });
    assert.equal(high.truncated, false);
    assert.equal(requireNode(high.nodes, "第一节 节").depth, 3);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/depth.txt", { maxDepth: 0 });
    });
});

test("binary, oversize, missing and escaping paths are refused with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("edge/blob.bin");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("edge/huge.txt");
    });
    expectFilesystemError("not_found", (): void => {
        outline("edge/missing.txt");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.txt");
    });
});

test("the structure scan stops after 3000 lines and flags truncation", (): void => {
    const result: OutlineResult = outline("scan/late.txt");
    assert.equal(result.truncated, true);
    assert.deepEqual(labels(result.nodes[0].children), ["第一卷 开始"]);
    assert.equal(findNode(result.nodes, "第一章 迟到"), undefined);
    const volume: OutlineNode = requireNode(result.nodes, "第一卷 开始");
    assert.equal(Number(volume.range.endLine), 3000);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(Number(anchor.range.endLine), 3001);
    assert.equal(anchor.file!.lines, 3001n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(ScanLateText, "utf8")));
});

test("duplicate labels keep distinct symbol paths at root and nested levels without deduplication", (): void => {
    const result: OutlineResult = outline("edge/dup.txt");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["第一章 同一章", "第一章 同一章", "第一卷 卷"]);
    const first: OutlineNode = anchor.children[0];
    const second: OutlineNode = anchor.children[1];
    const volume: OutlineNode = anchor.children[2];
    assert.equal(first.path, "edge/dup.txt#第一章 同一章~chapter-1-1");
    assert.equal(second.path, "edge/dup.txt#第一章 同一章~chapter-3-2");
    assert.notEqual(outlineNodeFingerprint(first), outlineNodeFingerprint(second));
    assert.equal(Number(first.range.startLine), 1);
    assert.equal(Number(second.range.startLine), 3);
    assert.deepEqual(labels(volume.children), ["第一章 章", "第一章 章"]);
    assert.equal(volume.children[0].path, "edge/dup.txt#第一卷 卷.第一章 章~chapter-5-1");
    assert.equal(volume.children[1].path, "edge/dup.txt#第一卷 卷.第一章 章~chapter-6-2");
    assert.notEqual(outlineNodeFingerprint(volume.children[0]), outlineNodeFingerprint(volume.children[1]));
    assert.equal(Number(requireNode(result.nodes, "第一章 同一章").range.startLine), 1);
});

test("symbol paths escape %, # and / for root and nested nodes", (): void => {
    const result: OutlineResult = outline("edge/escape.txt");
    const chapter: OutlineNode = requireNode(result.nodes, "第一章 C# 与 100%");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assert.equal(chapter.path, "edge/escape.txt#第一章 C%23 与 100%25");
    const section: OutlineNode = requireNode(chapter.children, "第一节 a/b 路径");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assert.equal(section.path, "edge/escape.txt#第一章 C%23 与 100%25.第一节 a%2Fb 路径");
});

test("every range is an ordered bigint inside the file anchor", (): void => {
    const result: OutlineResult = outline("levels/english.txt");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.path, "levels/english.txt");
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(EnglishLevelsText, "utf8")));
    const all: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assert.equal(typeof(node.range.startByte), "bigint");
        assert.equal(typeof(node.range.endByte), "bigint");
        assert.equal(typeof(node.range.startLine), "bigint");
        assert.equal(typeof(node.range.endLine), "bigint");
        assert.ok(node.range.startByte >= 0n);
        assert.ok(node.range.startByte <= node.range.endByte);
        assert.ok(node.range.startLine >= 1n);
        assert.ok(node.range.startLine <= node.range.endLine);
        assert.ok(node.range.endByte <= anchor.range.endByte);
        assert.ok(node.range.endLine <= anchor.range.endLine);
        if (!node.isFile) {
            assert.ok(node.path.startsWith("levels/english.txt#"));
        }
    }
    const part: OutlineNode = requireNode(result.nodes, "PART ONE");
    const chapter: OutlineNode = requireNode(result.nodes, "CHAPTER 1");
    const section: OutlineNode = requireNode(result.nodes, "Section 1.1");
    assert.ok(part.range.startByte <= chapter.range.startByte);
    assert.ok(chapter.range.endByte <= part.range.endByte);
    assert.ok(chapter.range.startByte <= section.range.startByte);
    assert.ok(section.range.endByte <= chapter.range.endByte);
    assert.ok(part.range.startLine < chapter.range.startLine);
    assert.ok(chapter.range.startLine < section.range.startLine);
});

test("a .txt whose head looks like XML is claimed by the XML strategy", (): void => {
    const result: OutlineResult = outline("ext/sniff.txt");
    assert.equal(result.strategy, "xml");
    assert.equal(result.category, "data");
    assert.equal(result.language, "xml");
    assert.equal(result.nodes[0].path, "ext/sniff.txt");
    assert.ok(findNode(result.nodes, "note") !== undefined);
});
