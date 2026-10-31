#!/usr/bin/env node
/**
 * HTML outline boundary checks.
 *
 * The fixtures are written to a private temporary directory and removed after
 * the run; no fixture code is executed. Every assertion goes through the public
 * `buildOutline` entry point so the sandbox, charset gate, byte ranges and
 * strategy selection are exercised together with `parseHtml`.
 *
 * The suite covers document skeleton and title/heading levels, labelled
 * landmarks, nested and skipped heading levels, pseudo-tags in comments,
 * scripts and styles, quoted attributes containing `>`, self-closing elements,
 * entities, Unicode, empty/doctype-only/CRLF/BOM inputs, node and depth bounds,
 * binary and oversize refusals, the 3000-line scan ceiling, symbol paths and
 * bigint range ordering.
 *
 * The suite also locks four regressions found by the boundary pass and fixed in
 * the parser: UTF-8 BOM byte offsets, unclosed headings at EOF, nested
 * same-name landmark ranges, and the silent 20000-tag cap. A labelled landmark
 * now nests its headings, and `<textarea>` plus common HTML entities are
 * handled; the report in `docs/testing/languages/htmlReport.md` records the
 * before/after evidence.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-html-outline-"));
const RootSpec: SessionRoot = { id: "root.html.outline", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

after((): void => {
    rmSync(Root, { recursive: true, force: true });
});

/**
 * Write one UTF-8 fixture, creating intermediate directories.
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
        result.push(nodes[index]);
        const children: OutlineNode[] = flatten(nodes[index].children);
        for (let childIndex: number = 0; childIndex < children.length; childIndex += 1) {
            result.push(children[childIndex]);
        }
    }
    return result;
};

/**
 * Labels of one node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

/**
 * First node with one label, depth first.
 */
const findNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined = (
    nodes: readonly OutlineNode[], label: string,
): OutlineNode | undefined => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        if (nodes[index].label === label) {
            return nodes[index];
        }
        const nested: OutlineNode | undefined = findNode(nodes[index].children, label);
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
 * 1-based start byte offset of one decoded line, treating `\n` as the only
 * separator (so a preceding `\r` is part of the previous line).
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
 * Half-open byte range for an inclusive line span of decoded text.
 */
const expectedBytes: (text: string, startLine: number, endLine: number) => { readonly startByte: bigint; readonly endByte: bigint; } = (
    text: string, startLine: number, endLine: number,
): { readonly startByte: bigint; readonly endByte: bigint; } => {
    const lines: string[] = text.split("\n");
    const endsWithNewline: boolean = text.endsWith("\n");
    const startByte: bigint = startByteOf(text, startLine);
    const endByte: bigint = endLine >= lines.length && !endsWithNewline ? BigInt(Buffer.byteLength(text, "utf8")) : startByteOf(text, endLine + 1);
    return { startByte, endByte };
};

/**
 * Assert one node's line and byte range against decoded source text. `byteBase`
 * shifts the expected bytes when a BOM prefix is part of the raw file range.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number, byteBase?: bigint) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number, byteBase: bigint = 0n,
): void => {
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte + byteBase);
    assert.equal(node.range.endByte, expected.endByte + byteBase);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Document skeleton: doctype, html/head/body wrappers and title are not
 * symbols; `<title>` is a depth-1 root and `h1`..`h6` map to depths 1..6.
 */
const SkeletonText: string = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    "  <title>Docs &amp; Spec</title>",
    "</head>",
    "<body>",
    "  <h1>One</h1>",
    "  <h2>Two</h2>",
    "  <h3>Three</h3>",
    "  <h4>Four</h4>",
    "  <h5>Five</h5>",
    "  <h6>Six</h6>",
    "</body>",
    "</html>",
    "",
].join("\n");
fixture("skeleton.html", SkeletonText);

/**
 * Labelled landmarks: main/section/article/nav all become sections, id beats
 * aria-label, and an aria-label is decoded and used when id is absent.
 */
const LandmarksText: string = [
    '<main id="top">',
    "  <h1>Top</h1>",
    "</main>",
    '<section aria-label="A &amp; B">',
    '  <article id="card">',
    '    <nav aria-label="Breadcrumb">x</nav>',
    "  </article>",
    "</section>",
    "",
].join("\n");
fixture("landmarks.html", LandmarksText);

/**
 * Heading ranks: an h3 after an h1 and an h4 after another h1 both keep their
 * declared depth while nesting under the nearest shallower heading.
 */
const LevelsText: string = [
    "<h1>Root</h1>",
    "<h3>Skipped</h3>",
    "<h4>Deep</h4>",
    "<h2>Back</h2>",
    "<h6>Lowest</h6>",
    "<h1>Second</h1>",
    "<h4>Jump</h4>",
    "",
].join("\n");
fixture("levels.html", LevelsText);

/**
 * Raw-text and comment contexts: every pseudo-tag below must stay invisible.
 */
const PseudoText: string = [
    "<!-- <title>Fake</title><h1>Fake comment</h1> -->",
    "<script>",
    'const template = "<h1>Fake script</h1>";',
    'const landmark = "<section id=\'fake\'>";',
    "</script>",
    "<style>",
    '.x::before { content: "<h2>Fake style</h2>"; }',
    "</style>",
    "<textarea><h1>Fake textarea</h1></textarea>",
    "<![CDATA[<h4>Fake cdata</h4>]]>",
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<h1>Real</h1>",
    '<section id="real-section"><h2>Real sub</h2></section>',
    "",
].join("\n");
fixture("pseudo.html", PseudoText);

/**
 * Quoted attributes containing `>` and quote characters, entity decoding in
 * both text and attributes, and nested inline markup in a heading label.
 */
const AttributesText: string = [
    '<section id="a>b" data-note="x > y"><h2>Inside</h2></section>',
    "<h1 title=\"a 'b' > c\">Attr &amp; &#x2014; &mdash; &copy; Title</h1>",
    '<section aria-label=\'x"y\'><h2>Quote child</h2></section>',
    '<section id="Q&amp;A"></section>',
    "",
].join("\n");
fixture("attrs.html", AttributesText);

/**
 * Self-closing and void elements: `<section id="ghost" />` and `<h3 />` emit
 * no node; a void `<br>` and an `<img />` only exercise the scanner.
 */
const SelfClosingText: string = [
    '<section id="ghost" />',
    '<img src="pic.png" alt="a > b" />',
    "<br>",
    "<h1>Visible</h1>",
    "<h3 />",
    "<h2>After</h2>",
    "",
].join("\n");
fixture("selfclosing.html", SelfClosingText);

/**
 * Unicode labels and byte ranges: CJK and an astral emoji must survive parsing
 * while UTF-8 offsets count their encoded bytes.
 */
const UnicodeText: string = [
    "<title>标题 — 🚀</title>",
    "<h1>章节 &amp; 标题 &#x2014; 🚀</h1>",
    "<h2>第二层 ünïcode</h2>",
    "",
].join("\n");
fixture("unicode.html", UnicodeText);

fixture("empty.html", "");
fixture("doctype.html", "<!doctype html>\n");
fixture("comment.html", "<!-- nothing but a comment -->\n");

/**
 * CRLF input: line numbers stay 1-based and each range includes its CRLF bytes.
 */
const CrlfText: string = [
    "<!doctype html>",
    "<title>CRLF Doc</title>",
    "<h1>Line Three</h1>",
    "<h2>Line Four</h2>",
    "",
].join("\r\n");
fixture("crlf.html", CrlfText);

/**
 * UTF-8 BOM input. `BomBody` is exactly what `decodeText` yields after the BOM
 * is stripped; the raw file is three bytes longer.
 */
const BomBody: string = [
    "<!doctype html>",
    "<title>BOM Doc</title>",
    "<h1>B</h1>",
    "",
].join("\n");
const BomText: string = `\uFEFF${BomBody}`;
fixture("bom.html", BomText);

/**
 * Symbol paths: `%`, `#` and `/` must be escaped per segment so the anchor
 * boundary stays parseable; ranges must be ordered bigints.
 */
const PathsText: string = ["<h1>100% #done / a</h1>", "<h2>Sub #1</h2>", ""].join("\n");
fixture("paths.html", PathsText);
fixture("page.html", ["<title>Title</title>", "<h1>Heading</h1>", ""].join("\n"));

/**
 * Empty labels are skipped, while a multi-line heading label is collapsed.
 */
const LabelText: string = [
    "<h1>   </h1>",
    "<h2><span> </span></h2>",
    '<section id="  "></section>',
    "<h3>  A",
    "   B  </h3>",
    "",
].join("\n");
fixture("labels.html", LabelText);

/**
 * An unclosed heading ends on its last content line, and an unclosed landmark
 * ends at EOF because it has no closing tag.
 */
fixture("unclosed-heading.html", "<h1>Unclosed heading");
fixture("unclosed-section.html", '<section id="open">\n<h1>X</h1>\n');

/**
 * Same-name landmark nesting: the outer close tag is on line 4, so the outer
 * range must not stop on line 2 where the inner section closes.
 */
const NestedText: string = [
    '<section id="outer">',
    '  <section id="inner">x</section>',
    "  <h2>Tail</h2>",
    "</section>",
    "",
].join("\n");
fixture("nested.html", NestedText);

fixture("blob.html", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("huge.html", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

/**
 * A 3002-line document with a heading on the last line: the 3000-line scan
 * ceiling hides the late heading and flags truncation.
 */
const ScanLines: string[] = ["<h1>First</h1>"];
for (let index: number = 0; index < 3000; index += 1) {
    ScanLines.push("<p>line</p>");
}
ScanLines.push("<h1>Late</h1>");
fixture("scan.html", `${ScanLines.join("\n")}\n`);
fixture("tagcap.html", `${"<br>".repeat(20000)}<h1>Late</h1>`);

test("doctype is ignored, title is a depth-1 root and h1-h6 map to depths 1-6", (): void => {
    const result: OutlineResult = outline("skeleton.html");
    assert.equal(result.strategy, "html");
    assert.equal(result.language, "html");
    assert.equal(result.category, "code");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.label, "skeleton.html");
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(SkeletonText, "utf8")));
    assert.deepEqual(labels(anchor.children), ["Docs & Spec", "One"]);
    const title: OutlineNode = requireNode(result.nodes, "Docs & Spec");
    assert.equal(title.type, "heading");
    assert.equal(title.depth, 1);
    assert.equal(title.path, "skeleton.html#Docs & Spec");
    assertRange(title, SkeletonText, 4, 4);
    const one: OutlineNode = requireNode(result.nodes, "One");
    assert.equal(one.depth, 1);
    assertRange(one, SkeletonText, 7, 7);
    const two: OutlineNode = requireNode(result.nodes, "Two");
    assert.equal(two.depth, 2);
    assert.equal(two.path, "skeleton.html#One.Two");
    const six: OutlineNode = requireNode(result.nodes, "Six");
    assert.equal(six.depth, 6);
    assert.equal(six.path, "skeleton.html#One.Two.Three.Four.Five.Six");
    assertRange(six, SkeletonText, 12, 12);
    assert.equal(findNode(result.nodes, "html"), undefined);
    assert.equal(findNode(result.nodes, "head"), undefined);
    assert.equal(findNode(result.nodes, "body"), undefined);
});

test("main, section, article and nav become sections with id or aria-label labels", (): void => {
    const result: OutlineResult = outline("landmarks.html");
    assert.deepEqual(labels(result.nodes[0].children), ["top", "A & B"]);
    const main: OutlineNode = requireNode(result.nodes, "top");
    assert.equal(main.type, "section");
    assert.equal(main.depth, 1);
    assert.equal(main.detail, "main");
    assert.equal(main.path, "landmarks.html#top");
    assertRange(main, LandmarksText, 1, 3);
    assert.deepEqual(labels(main.children), ["Top"]);
    const top: OutlineNode = requireNode(result.nodes, "Top");
    assert.equal(top.depth, 2);
    assert.equal(top.path, "landmarks.html#top.Top");
    assert.equal(top.isFile, false);
    const section: OutlineNode = requireNode(result.nodes, "A & B");
    assert.equal(section.type, "section");
    assert.equal(section.detail, "section");
    assertRange(section, LandmarksText, 4, 8);
    const article: OutlineNode = requireNode(result.nodes, "card");
    assert.equal(article.type, "section");
    assert.equal(article.depth, 2);
    assert.equal(article.detail, "article");
    assert.equal(article.path, "landmarks.html#A & B.card");
    assertRange(article, LandmarksText, 5, 7);
    const nav: OutlineNode = requireNode(result.nodes, "Breadcrumb");
    assert.equal(nav.type, "section");
    assert.equal(nav.depth, 3);
    assert.equal(nav.detail, "nav");
    assert.equal(nav.path, "landmarks.html#A & B.card.Breadcrumb");
    assertRange(nav, LandmarksText, 6, 6);
    assert.deepEqual(labels(article.children), ["Breadcrumb"]);
});

test("nested and skipped headings keep their declared rank under the nearest shallower heading", (): void => {
    const result: OutlineResult = outline("levels.html");
    assert.deepEqual(labels(result.nodes[0].children), ["Root", "Second"]);
    const root: OutlineNode = requireNode(result.nodes, "Root");
    assert.equal(root.depth, 1);
    assert.deepEqual(labels(root.children), ["Skipped", "Back"]);
    const skipped: OutlineNode = requireNode(result.nodes, "Skipped");
    assert.equal(skipped.depth, 3);
    assert.equal(skipped.path, "levels.html#Root.Skipped");
    assert.deepEqual(labels(skipped.children), ["Deep"]);
    assert.equal(requireNode(result.nodes, "Deep").depth, 4);
    const back: OutlineNode = requireNode(result.nodes, "Back");
    assert.equal(back.depth, 2);
    assert.equal(back.path, "levels.html#Root.Back");
    assert.deepEqual(labels(back.children), ["Lowest"]);
    const lowest: OutlineNode = requireNode(result.nodes, "Lowest");
    assert.equal(lowest.depth, 6);
    assert.equal(lowest.path, "levels.html#Root.Back.Lowest");
    const second: OutlineNode = requireNode(result.nodes, "Second");
    assert.equal(second.depth, 1);
    const jump: OutlineNode = requireNode(result.nodes, "Jump");
    assert.equal(jump.depth, 4);
    assert.equal(jump.path, "levels.html#Second.Jump");
    assert.deepEqual(labels(second.children), ["Jump"]);
});

test("comments, script, style, CDATA and processing instructions hide pseudo tags", (): void => {
    const result: OutlineResult = outline("pseudo.html");
    assert.deepEqual(labels(result.nodes[0].children), ["Real", "real-section"]);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
    assert.equal(findNode(result.nodes, "Fake comment"), undefined);
    assert.equal(findNode(result.nodes, "Fake script"), undefined);
    assert.equal(findNode(result.nodes, "fake"), undefined);
    assert.equal(findNode(result.nodes, "Fake style"), undefined);
    assert.equal(findNode(result.nodes, "Fake textarea"), undefined);
    assert.equal(findNode(result.nodes, "Fake cdata"), undefined);
    const real: OutlineNode = requireNode(result.nodes, "Real");
    assert.equal(real.depth, 1);
    assertRange(real, PseudoText, 12, 12);
    const section: OutlineNode = requireNode(result.nodes, "real-section");
    assert.equal(section.type, "section");
    assert.deepEqual(labels(section.children), ["Real sub"]);
    const sub: OutlineNode = requireNode(result.nodes, "Real sub");
    assert.equal(sub.depth, 3);
});

test("quoted attributes containing > and both quote styles stay one tag; entities decode", (): void => {
    const result: OutlineResult = outline("attrs.html");
    assert.deepEqual(labels(result.nodes[0].children), ["a>b", "Attr & — — © Title", 'x"y', "Q&A"]);
    const section: OutlineNode = requireNode(result.nodes, "a>b");
    assert.equal(section.type, "section");
    assert.equal(section.path, "attrs.html#a>b");
    assert.deepEqual(labels(section.children), ["Inside"]);
    const inside: OutlineNode = requireNode(result.nodes, "Inside");
    assert.equal(inside.depth, 3);
    assert.equal(inside.path, "attrs.html#a>b.Inside");
    assert.equal(requireNode(result.nodes, "Attr & — — © Title").depth, 1);
    const quoted: OutlineNode = requireNode(result.nodes, 'x"y');
    assert.equal(quoted.type, "section");
    assert.deepEqual(labels(quoted.children), ["Quote child"]);
    const entity: OutlineNode = requireNode(result.nodes, "Q&A");
    assert.equal(entity.type, "section");
    assert.equal(entity.detail, "section");
});

test("self-closing sections and empty self-closing headings emit no nodes", (): void => {
    const result: OutlineResult = outline("selfclosing.html");
    assert.deepEqual(labels(result.nodes[0].children), ["Visible"]);
    assert.equal(findNode(result.nodes, "ghost"), undefined);
    assert.equal(findNode(result.nodes, "After").depth, 2);
    const visible: OutlineNode = requireNode(result.nodes, "Visible");
    assert.deepEqual(labels(visible.children), ["After"]);
    assert.equal(findNode(result.nodes, "pic.png"), undefined);
    assert.equal(findNode(result.nodes, ""), undefined);
});

test("Unicode labels survive and UTF-8 byte ranges count multibyte characters", (): void => {
    const result: OutlineResult = outline("unicode.html");
    assert.deepEqual(labels(result.nodes[0].children), ["标题 — 🚀", "章节 & 标题 — 🚀"]);
    const title: OutlineNode = requireNode(result.nodes, "标题 — 🚀");
    assert.equal(title.depth, 1);
    assert.equal(title.path, "unicode.html#标题 — 🚀");
    assertRange(title, UnicodeText, 1, 1);
    const heading: OutlineNode = requireNode(result.nodes, "章节 & 标题 — 🚀");
    assert.equal(heading.depth, 1);
    assertRange(heading, UnicodeText, 2, 2);
    assert.ok(heading.range.endByte - heading.range.startByte > BigInt(Buffer.byteLength("章节", "utf8")));
    const nested: OutlineNode = requireNode(result.nodes, "第二层 ünïcode");
    assert.equal(nested.depth, 2);
    assertRange(nested, UnicodeText, 3, 3);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(UnicodeText, "utf8")));
});

test("empty, doctype-only and comment-only files yield an anchor with no symbols", (): void => {
    const empty: OutlineResult = outline("empty.html");
    assert.equal(empty.strategy, "html");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.nodes.length, 1);
    assert.equal(empty.nodes[0].children.length, 0);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(empty.nodes[0].range.startLine, 1n);
    assert.equal(empty.nodes[0].range.endLine, 1n);
    const doctype: OutlineResult = outline("doctype.html");
    assert.equal(doctype.nodes[0].children.length, 0);
    assert.equal(doctype.nodes[0].range.endByte, 16n);
    assert.equal(doctype.nodes[0].range.endLine, 1n);
    const comment: OutlineResult = outline("comment.html");
    assert.equal(comment.nodes[0].children.length, 0);
    assert.equal(comment.truncated, false);
});

test("CRLF line endings keep line numbers and include their terminator bytes in ranges", (): void => {
    const result: OutlineResult = outline("crlf.html");
    assert.equal(result.charset, "utf-8");
    assert.deepEqual(labels(result.nodes[0].children), ["CRLF Doc", "Line Three"]);
    assert.equal(result.nodes[0].range.endLine, 4n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(CrlfText, "utf8")));
    const title: OutlineNode = requireNode(result.nodes, "CRLF Doc");
    assert.equal(title.depth, 1);
    assert.ok(!title.label.includes("\r"));
    assertRange(title, CrlfText, 2, 2);
    const heading: OutlineNode = requireNode(result.nodes, "Line Three");
    assertRange(heading, CrlfText, 3, 3);
    assert.equal(heading.range.endByte - heading.range.startByte, BigInt(Buffer.byteLength("<h1>Line Three</h1>\r\n", "utf8")));
    const nested: OutlineNode = requireNode(result.nodes, "Line Four");
    assert.equal(nested.depth, 2);
    assertRange(nested, CrlfText, 4, 4);
});

test("UTF-8 BOM is stripped for parsing but included in raw-file byte ranges", (): void => {
    const result: OutlineResult = outline("bom.html");
    assert.equal(result.charset, "utf-8-bom");
    assert.deepEqual(labels(result.nodes[0].children), ["BOM Doc", "B"]);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.file!.bytes, BigInt(Buffer.byteLength(BomText, "utf8")));
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, anchor.file!.bytes);
    assert.equal(requireNode(result.nodes, "BOM Doc").depth, 1);
    /**
     * The decoded text loses the three BOM bytes; the registry adds them back
     * so every symbol range is a raw-file offset.
     */
    assertRange(requireNode(result.nodes, "BOM Doc"), BomBody, 2, 2, 3n);
    assertRange(requireNode(result.nodes, "B"), BomBody, 3, 3, 3n);
    assert.equal(requireNode(result.nodes, "BOM Doc").range.startByte, 3n + expectedBytes(BomBody, 2, 2).startByte);
});

test("maxNodes counts the anchor, truncates in preorder and rejects zero", (): void => {
    const tiny: OutlineResult = outline("levels.html", { maxNodes: 3 });
    assert.equal(tiny.truncated, true);
    assert.equal(flatten(tiny.nodes).length, 3);
    assert.equal(tiny.nodes[0].isFile, true);
    assert.deepEqual(labels(tiny.nodes[0].children), ["Root"]);
    assert.deepEqual(labels(requireNode(tiny.nodes, "Root").children), ["Skipped"]);
    const anchorOnly: OutlineResult = outline("levels.html", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.deepEqual(labels(anchorOnly.nodes[0].children), []);
    const complete: OutlineResult = outline("levels.html", { maxNodes: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 8);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("levels.html", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("levels.html", { maxNodes: 2.5 });
    });
});

test("maxDepth drops deeper symbols, keeps the boundary level and rejects zero", (): void => {
    const two: OutlineResult = outline("levels.html", { maxDepth: 2 });
    assert.equal(two.truncated, true);
    assert.deepEqual(flatten(two.nodes).map((node: OutlineNode): string => node.label), ["levels.html", "Root", "Back", "Second"]);
    assert.equal(findNode(two.nodes, "Skipped"), undefined);
    assert.equal(findNode(two.nodes, "Deep"), undefined);
    const boundary: OutlineResult = outline("levels.html", { maxDepth: 3 });
    assert.equal(boundary.truncated, true);
    assert.equal(requireNode(boundary.nodes, "Skipped").depth, 3);
    assert.equal(findNode(boundary.nodes, "Deep"), undefined);
    const exact: OutlineResult = outline("levels.html", { maxDepth: 6 });
    assert.equal(exact.truncated, false);
    assert.equal(requireNode(exact.nodes, "Lowest").depth, 6);
    const clamped: OutlineResult = outline("levels.html", { maxDepth: 99 });
    assert.equal(clamped.truncated, false);
    assert.equal(flatten(clamped.nodes).length, 8);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("levels.html", { maxDepth: 0 });
    });
});

test("binary, oversize, missing and escaping paths are refused with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("blob.html");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("huge.html");
    });
    expectFilesystemError("not_found", (): void => {
        outline("missing.html");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.html");
    });
});

test("the structure scan stops after 3000 lines and flags truncation", (): void => {
    const result: OutlineResult = outline("scan.html");
    assert.equal(result.truncated, true);
    assert.equal(requireNode(result.nodes, "First").depth, 1);
    assert.equal(findNode(result.nodes, "Late"), undefined);
    assert.equal(result.nodes[0].range.endLine, 3002n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(`${ScanLines.join("\n")}\n`, "utf8")));
});

test("the 20000-tag scanner cap is reported as truncation", (): void => {
    const result: OutlineResult = outline("tagcap.html");
    /**
     * Regression: the scanner stops at 20000 tags, marks the scan truncated and
     * the registry folds that into `OutlineResult.truncated`.
     */
    assert.equal(result.nodes[0].children.length, 0);
    assert.equal(result.truncated, true, "silently dropping tags past the scanner cap must set truncated");
});

test("symbol paths escape %, # and / while every range is an ordered bigint", (): void => {
    const result: OutlineResult = outline("paths.html");
    const heading: OutlineNode = requireNode(result.nodes, "100% #done / a");
    assert.equal(heading.path, "paths.html#100%25 %23done %2F a");
    assertRange(heading, PathsText, 1, 1);
    const nested: OutlineNode = requireNode(result.nodes, "Sub #1");
    assert.equal(nested.depth, 2);
    assert.equal(nested.path, "paths.html#100%25 %23done %2F a.Sub %231");
    assertRange(nested, PathsText, 2, 2);
    const all: OutlineNode[] = flatten(result.nodes);
    const anchor: OutlineNode = all[0];
    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assert.equal(typeof (node.range.startByte), "bigint");
        assert.equal(typeof (node.range.endByte), "bigint");
        assert.equal(typeof (node.range.startLine), "bigint");
        assert.equal(typeof (node.range.endLine), "bigint");
        assert.ok(node.range.startByte >= 0n);
        assert.ok(node.range.endByte >= node.range.startByte);
        assert.ok(node.range.startLine >= 1n);
        assert.ok(node.range.endLine >= node.range.startLine);
        assert.ok(node.range.startByte >= anchor.range.startByte);
        assert.ok(node.range.endByte <= anchor.range.endByte);
    }
    assert.ok(heading.range.startByte <= nested.range.startByte);
    /**
     * A heading range covers its own element, not its descendants: the h2
     * starts where the h1's closing line ends.
     */
    assert.equal(heading.range.endByte, nested.range.startByte);
    const page: OutlineResult = outline("page.html");
    assert.equal(requireNode(page.nodes, "Title").path, "page.html#Title");
    assert.equal(requireNode(page.nodes, "Heading").path, "page.html#Heading");
});

test("empty labels are skipped and multi-line labels collapse", (): void => {
    const result: OutlineResult = outline("labels.html");
    assert.deepEqual(labels(result.nodes[0].children), ["A B"]);
    const heading: OutlineNode = requireNode(result.nodes, "A B");
    assert.equal(heading.depth, 3);
    assertRange(heading, LabelText, 4, 5);
    assert.equal(findNode(result.nodes, "   "), undefined);
    assert.equal(findNode(result.nodes, ""), undefined);
});

test("an unclosed heading at EOF still yields a node", (): void => {
    const result: OutlineResult = outline("unclosed-heading.html");
    /**
     * Regression: an unclosed heading now spans to the next structural tag or
     * EOF, so its label is no longer an empty slice.
     */
    const unclosed: OutlineNode | undefined = findNode(result.nodes, "Unclosed heading");
    assert.ok(unclosed !== (void 0), "an unclosed heading at EOF must still produce a node");
    assert.equal(unclosed!.depth, 1);
    assert.equal(unclosed!.range.startLine, 1n);
    assert.equal(unclosed!.range.endLine, 1n);
});

test("an unclosed landmark ends at EOF and nests the headings it still contains", (): void => {
    const result: OutlineResult = outline("unclosed-section.html");
    const open: OutlineNode = requireNode(result.nodes, "open");
    assert.equal(open.type, "section");
    assert.equal(open.range.startLine, 1n);
    assert.equal(open.range.endLine, 2n);
    assert.deepEqual(labels(open.children), ["X"]);
    assert.equal(requireNode(result.nodes, "X").depth, 2);
});

test("nested same-name landmarks keep their own closing tag and later headings", (): void => {
    const result: OutlineResult = outline("nested.html");
    const outer: OutlineNode = requireNode(result.nodes, "outer");
    const inner: OutlineNode = requireNode(result.nodes, "inner");
    assert.equal(outer.depth, 1);
    assert.equal(inner.depth, 2);
    assert.equal(outer.path, "nested.html#outer");
    assert.equal(inner.path, "nested.html#outer.inner");
    assert.equal(inner.range.endLine, 2n);
    assert.deepEqual(labels(outer.children), ["inner", "Tail"]);
    assert.deepEqual(labels(inner.children), []);
    /**
     * `Tail` follows the closed inner section, so it belongs to `outer`; the
     * outer close tag on line 4 must also be the outer range end.
     */
    const tail: OutlineNode = requireNode(result.nodes, "Tail");
    assert.equal(tail.depth, 3);
    assert.equal(outer.range.endLine, 4n);
});
