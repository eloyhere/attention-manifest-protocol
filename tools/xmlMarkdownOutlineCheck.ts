#!/usr/bin/env node
/**
 * XML/OPML and Markdown outline boundary checks.
 *
 * Every fixture is written to a private temporary directory, removed after the
 * run, and read back through the public `buildOutline` entry point, so sandbox
 * resolution, charset detection, strategy selection, anchor construction,
 * bigint ranges, node finalization and truncation are exercised together.
 *
 * The file covers four layers:
 *
 * 1. generic XML: multiple roots, nested elements, attributes and entities,
 *    comments, processing instructions, CDATA, DOCTYPE, self-closing tags,
 *    namespaces, tolerance of malformed input and the extension/content-sniff
 *    matrix;
 * 2. OPML: `text`/`title` labels, exact nesting and heading kinds;
 * 3. Markdown: ATX/setext headings, skipped levels, fenced code, front matter,
 *    links/images/inline HTML, CRLF/BOM/UTF-16/Unicode, empty inputs, limits,
 *    binary and oversize errors and the extension matrix;
 * 4. TeX/plain-text cross cases: sectioning commands, environments, comments,
 *    volume/chapter/section markers, underline and all-caps titles.
 *
 * Two tests are deliberate `[defect]` probes: they assert the contract that the
 * parser does not currently meet and therefore fail. The remaining tests pass
 * and assert observed behavior, including a few documented limitations. A
 * third probe (UTF-8 BOM byte offsets) became a passing regression test after
 * `outline.ts` was fixed on the concurrent HTML track.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { encodeText } from "../src/syntax/charset.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

/**
 * Private fixture root for this run.
 */
const Root: string = mkdtempSync(join(tmpdir(), "amp-xml-md-outline-"));
const RootSpec: SessionRoot = { id: "root.xml.md", path: Root, writable: true, exclude: [] };
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
 * First node with one label, depth first.
 */
const findNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined = (
    nodes: readonly OutlineNode[], label: string,
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
 * Labels of a node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

/**
 * 1-based start byte offset of one line, matching `ByteLineIndex` semantics.
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
 * Assert one node's line and byte range.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number,
): void => {
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(text, startLine, endLine);
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
 * Assert the range contract of every node in one outline.
 */
const assertRangeContract: (result: OutlineResult, filePath: string) => void = (result: OutlineResult, filePath: string): void => {
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.path, filePath);
    assert.equal(anchor.range.startByte, 0n);
    const all: OutlineNode[] = flatten(result.nodes);
    assert.ok(all.length > 1);
    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assert.equal(typeof(node.range.startByte), "bigint");
        assert.equal(typeof(node.range.endByte), "bigint");
        assert.equal(typeof(node.range.startLine), "bigint");
        assert.equal(typeof(node.range.endLine), "bigint");
        assert.ok(node.range.startByte >= 0n);
        assert.ok(node.range.endByte >= node.range.startByte);
        assert.ok(node.range.startLine >= 1n);
        assert.ok(node.range.endLine >= node.range.startLine);
        assert.ok(node.range.startByte >= anchor.range.startByte);
        assert.ok(node.range.endByte <= anchor.range.endByte);
        if (!node.isFile) {
            assert.match(node.path, new RegExp(`^${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:#|\\.)`));
        }
    }
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
};

/**
 * Fixtures: XML / OPML.
 */

/**
 * XML fixture: declaration, nested elements, attributes, a self-closing child
 * and an empty element.
 */
const NestedXml: string = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<root id="r1">',
    '    <group name="g1">',
    '        <leaf id="l1" />',
    "    </group>",
    "    <empty></empty>",
    "</root>",
].join("\n");
fixture("xml/nested.xml", NestedXml);

/**
 * XML fixture with two top-level elements (a fragment, not a document).
 */
const MultiRootXml: string = ['<a id="1"/>', "<b>", "  <c/>", "</b>"].join("\n");
fixture("xml/fragment.xml", MultiRootXml);

/**
 * XML fixture with quoted attributes, predefined/numeric/unknown entities and a
 * `text` attribute that must not drive a generic XML label.
 */
const AttributeXml: string = [
    '<root id="a&amp;b&#65;&#x42;&unknown;" name="ignored" text="ignored">',
    "    <child name='single' title=\"t\" />",
    '    <blank id="" />',
    "    <plain />",
    "</root>",
].join("\n");
fixture("xml/attributes.xml", AttributeXml);

/**
 * XML fixture whose fake tags live in a DOCTYPE, comments, a processing
 * instruction and CDATA.
 */
const MarkupXml: string = [
    '<?xml version="1.0"?>',
    "<!DOCTYPE note [",
    '<!ENTITY fake "x">',
    "]>",
    '<!-- <comment-fake id="no"/> -->',
    "<root>",
    "  <!-- <inner-fake/> -->",
    "  <?target <pi-fake/> ?>",
    "  <![CDATA[<cdata-fake/>]]>",
    "  <real />",
    "</root>",
].join("\n");
fixture("xml/markup.xml", MarkupXml);
fixture("xml/comment-only.xml", "<!-- only a comment -->\n");
fixture("xml/empty.xml", "");

/**
 * XML fixture with default and prefixed namespaces.
 */
const NamespaceXml: string = [
    '<root xmlns="urn:default" xmlns:p="urn:p" id="r1">',
    '  <p:child p:name="c" id="c1"/>',
    "  <local-element/>",
    "</root>",
].join("\n");
fixture("xml/namespaces.xml", NamespaceXml);

/**
 * XML fixtures with unbalanced and mismatched tags.
 */
const UnclosedXml: string = ["<root>", "  <child>"].join("\n");
fixture("xml/unclosed.xml", UnclosedXml);
const MismatchedXml: string = ["<outer>", "  <inner>", "</outer>"].join("\n");
fixture("xml/mismatched.xml", MismatchedXml);

/**
 * XML fixture that keeps a quoted `>` inside an attribute value.
 */
const AttributeGreaterXml: string = ["<root>", '  <node title="a > b" id="one"/>', "</root>"].join("\n");
fixture("xml/attr-gt.xml", AttributeGreaterXml);

/**
 * One XML extension in the strategy matrix.
 */
interface XmlExtensionCase {
    readonly path: string;
    readonly root: string;
}

const XmlExtensionCases: readonly XmlExtensionCase[] = [
    { path: "ext/schema.xsd", root: "schema" },
    { path: "ext/style.xsl", root: "stylesheet" },
    { path: "ext/transform.xslt", root: "stylesheet" },
    { path: "ext/image.svg", root: "svg" },
    { path: "ext/app.csproj", root: "Project" },
    { path: "ext/build.props", root: "Project" },
    { path: "ext/build.targets", root: "Project" },
    { path: "ext/up.XML", root: "root" },
];
for (let index: number = 0; index < XmlExtensionCases.length; index += 1) {
    fixture(XmlExtensionCases[index].path, `<${XmlExtensionCases[index].root}/>\n`);
}

fixture("sniff/feed", '<?xml version="1.0"?>\n<feed><entry/></feed>');
fixture("sniff/fragment", "<!-- lead -->\n<root><a/></root>");
fixture("sniff/doctype", "<!DOCTYPE note>\n<note/>");
fixture("sniff/plain", "hello <world> and # markdown\n");
fixture("sniff/late", `${" ".repeat(4200)}<root/>`);
fixture("sniff/empty", "");

/**
 * XML fixture whose nesting is four elements deep, used by the bound tests.
 */
const DeepXml: string = ["<a>", "  <b>", "    <c>", "      <d/>", "    </c>", "  </b>", "</a>"].join("\n");
fixture("deep/deep.xml", DeepXml);

/**
 * 3003-line XML fixture: `<mid/>` is inside the 3000-line scan window,
 * `<late/>` and the closing tag are outside it.
 */
const ScanXmlLines: string[] = new Array<string>(3003).fill("");
ScanXmlLines[0] = "<root>";
ScanXmlLines[2999] = "  <mid/>";
ScanXmlLines[3000] = "  <late/>";
ScanXmlLines[3002] = "</root>";
fixture("scan/large.xml", ScanXmlLines.join("\n"));

/**
 * OPML fixture with head/body, escaped `text`, `title`-only and hash labels.
 */
const OpmlFull: string = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    "  <head>",
    "    <title>Reading List</title>",
    "  </head>",
    "  <body>",
    '    <outline text="A &amp; B" type="rss">',
    '      <outline title="Title Only" />',
    "      <outline text='C# &amp; D' />",
    "    </outline>",
    "  </body>",
    "</opml>",
].join("\n");
fixture("opml/full.opml", OpmlFull);
fixture("opml/attrs.opml", '<opml><body><outline text="" title="Ignored"/><outline title="Only"/></body></opml>');

/**
 * Fixtures: Markdown.
 */

/**
 * Markdown fixture with ATX headings and a skipped level.
 */
const AtxMarkdown: string = ["# One", "### Three", "## Two", "#### Four"].join("\n");
fixture("md/atx.md", AtxMarkdown);

/**
 * Markdown fixture with setext headings and ATX closing hashes.
 */
const SetextMarkdown: string = ["Setext One", "==========", "", "Setext Two", "----------", "", "## Closing ##", "### C#"].join("\n");
fixture("md/setext.md", SetextMarkdown);

/**
 * Markdown fixture with backtick/tilde fences, a longer closing fence, a
 * non-closing line with trailing text and `#` lines inside the fences.
 */
const FenceMarkdown: string = [
    "# Before",
    "```sh",
    "# inside",
    "```",
    "~~~~",
    "# tilde inside",
    "~~~~",
    "```",
    "# not heading",
    "``` trailing",
    "# still fenced",
    "```",
    "# After",
].join("\n");
fixture("md/fences.md", FenceMarkdown);

/**
 * Markdown fixture whose opening fence is indented four spaces.
 */
const IndentedFenceMarkdown: string = ["    ```", "# inside indented fence", "    ```"].join("\n");
fixture("md/indented-fence.md", IndentedFenceMarkdown);

/**
 * Front matter variants: quoted title with `#` and a YAML comment, `...`
 * closing; unquoted title with a trailing comment; unclosed front matter.
 */
const FrontQuotedMarkdown: string = ["---", 'title: "C# Guide" # note', "...", "", "# Body"].join("\n");
fixture("md/front-quoted.md", FrontQuotedMarkdown);
const FrontUnquotedMarkdown: string = ["---", "title: C# Guide # note", "---", "# Body"].join("\n");
fixture("md/front-unquoted.md", FrontUnquotedMarkdown);
const FrontUnclosedMarkdown: string = ["---", "title: Lost", "# Body"].join("\n");
fixture("md/front-unclosed.md", FrontUnclosedMarkdown);

/**
 * Markdown fixture with link/image/inline-HTML lines and a blockquote/list `#`.
 */
const LinksMarkdown: string = [
    "[#anchor](https://example.com/#y)",
    "![#image](image.png)",
    '<span id="x"># inline html</span>',
    "",
    "# Real",
    "",
    "> # quoted",
    "- # list item",
].join("\n");
fixture("md/links.md", LinksMarkdown);

/**
 * Markdown fixture with a type-6 HTML block containing a `#` line.
 */
const HtmlBlockMarkdown: string = ["<div>", "# block line", "</div>", "", "# real"].join("\n");
fixture("md/html-block.md", HtmlBlockMarkdown);

/**
 * Markdown fixture with CRLF line endings.
 */
const CrlfMarkdown: string = "# Top\r\n\r\n## Child\r\n\r\ntext\r\n";
fixture("md/crlf.md", CrlfMarkdown);

/**
 * BOM and UTF-16 encoded Markdown fixtures.
 */
fixture("md/bom.md", encodeText("# BOM Heading\n\n## Child\n", "utf-8-bom"));
fixture("md/utf16.md", encodeText("# UTF16 Heading\n", "utf-16le"));

/**
 * Markdown fixture with non-ASCII labels.
 */
const UnicodeMarkdown: string = "# 概览 🚀\n\n## 细节";
fixture("md/unicode.md", UnicodeMarkdown);

/**
 * Empty, front-matter-only and fence-only Markdown fixtures.
 */
fixture("md/empty.md", "");
fixture("md/front-only.md", "---\ntitle: Only\n---\n");
fixture("md/fence-only.md", "```\n# hidden\n```\n");

/**
 * Markdown fixture used by the node/depth bound tests.
 */
const LimitsMarkdown: string = ["# A", "## B", "### C", "# D"].join("\n");
fixture("md/limits.md", LimitsMarkdown);

/**
 * Markdown extension matrix. `.mdx` adds an inline JSX line that must not
 * become a heading.
 */
const MatrixMarkdown: string = ["# Title", "", "<Component value={1} />", "", "## Sub"].join("\n");
fixture("matrix/readme.md", MatrixMarkdown);
fixture("matrix/readme.mdx", MatrixMarkdown);
fixture("matrix/readme.markdown", MatrixMarkdown);
fixture("matrix/readme.MD", MatrixMarkdown);

/**
 * 3005-line Markdown fixture: the late heading is past the 3000-line scan.
 */
const LongMarkdownLines: string[] = new Array<string>(3005).fill("text");
LongMarkdownLines[0] = "# First";
LongMarkdownLines[3004] = "## Late";
fixture("scan/long.md", LongMarkdownLines.join("\n"));

/**
 * Markdown fixture whose labels need `%`, `#` and `/` escaping.
 */
const EscapeMarkdown: string = ["# 100% #done", "", "## a/b and c"].join("\n");
fixture("md/escape.md", EscapeMarkdown);
fixture("md/path-collision.md", "# Repeat\n# Repeat\n# Repeat~heading-1-1\n");
fixture("errors/blob.md", new Uint8Array(64));
fixture("errors/huge.md", Buffer.alloc(4 * 1024 * 1024 + 1, 97));
fixture("errors/blob.xml", new Uint8Array(64));
fixture("errors/huge.xml", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

/**
 * Fixtures: TeX / plain text.
 */

/**
 * TeX fixture with every sectioning rank, a short title, a command in the
 * label, a commented-out heading and an environment.
 */
const TexDocument: string = [
    "% comment: \\section{Hidden}",
    "\\documentclass{article}",
    "\\begin{document}",
    "\\part{Part One}",
    "\\chapter{Chapter One}",
    "\\section[Short]{Long \\textbf{Bold} Title}",
    "\\subsection*{Sub One}",
    "Text with 50\\% done.",
    "\\begin{figure}",
    "  \\caption{Fig}",
    "\\end{figure}",
    "\\part{Part Two}",
    "\\end{document}",
].join("\n");
fixture("tex/document.tex", TexDocument);

/**
 * TeX fixture with nested environments.
 */
const TexEnvironments: string = [
    "\\begin{enumerate}",
    "\\item one",
    "\\begin{itemize}",
    "\\item nested",
    "\\end{itemize}",
    "\\end{enumerate}",
    "\\begin{figure}",
    "\\end{figure}",
].join("\n");
fixture("tex/environments.tex", TexEnvironments);
fixture("tex/paper.ltx", "\\section{Ltx Section}\n");
fixture("tex/theme.sty", "\\section{Sty Section}\n");
fixture("tex/theme.cls", "\\section{Cls Section}\n");

/**
 * Plain-text fixture with Chinese volume/chapter/section markers, an all-caps
 * underline title and a Chinese chapter after it.
 */
const BookText: string = ["卷一 起始", "第一章 相遇", "第一节 初见", "正文段落。", "THE ENDING", "==========", "第 12 回 再来"].join("\n");
fixture("plain/book.txt", BookText);

/**
 * Plain-text fixture with an underline title and an all-caps short line.
 */
const UpperText: string = ["INTRODUCTION", "============", "Not All Caps", "SECOND PART"].join("\n");
fixture("plain/upper.txt", UpperText);

fixture("plain/README", "just prose\n");
fixture("plain/notes.log", "# not a heading\nChapter One\n");
fixture("plain/notes.unknown", "CHAPTER ONE\n");

/**
 * Tests: XML / OPML.
 */

test("XML nested elements become key nodes with anchor-relative depth, path and range", (): void => {
    const result: OutlineResult = outline("xml/nested.xml");
    assert.equal(result.strategy, "xml");
    assert.equal(result.category, "data");
    assert.equal(result.language, "xml");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.label, "nested.xml");
    assert.equal(anchor.file!.path, "xml/nested.xml");
    assert.equal(anchor.file!.fingerprint, result.fingerprint);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(NestedXml, "utf8")));
    assertRange(anchor, NestedXml, 1, 7);
    assert.deepEqual(labels(anchor.children), ["root"]);
    const root: OutlineNode = requireNode(result.nodes, "root");
    assert.equal(root.type, "key");
    assert.equal(root.depth, 1);
    assert.equal(root.path, "xml/nested.xml#root");
    assert.equal(root.detail, "root:r1");
    assertRange(root, NestedXml, 2, 7);
    const group: OutlineNode = requireNode(result.nodes, "group");
    assert.equal(group.depth, 2);
    assert.equal(group.path, "xml/nested.xml#root.group");
    assert.equal(group.detail, "group:g1");
    assertRange(group, NestedXml, 3, 5);
    const leaf: OutlineNode = requireNode(result.nodes, "leaf");
    assert.equal(leaf.depth, 3);
    assert.equal(leaf.path, "xml/nested.xml#root.group.leaf");
    assert.equal(leaf.detail, "leaf:l1");
    assertRange(leaf, NestedXml, 4, 4);
    const empty: OutlineNode = requireNode(result.nodes, "empty");
    assert.equal(empty.depth, 2);
    assert.equal(empty.detail, undefined);
    assert.deepEqual(labels(empty.children), []);
    assert.deepEqual(labels(group.children), ["leaf"]);
    assert.deepEqual(labels(root.children), ["group", "empty"]);
});

test("multiple XML roots are preserved as sibling key nodes", (): void => {
    const result: OutlineResult = outline("xml/fragment.xml");
    assert.equal(result.strategy, "xml");
    assert.equal(result.category, "data");
    assert.deepEqual(labels(result.nodes[0].children), ["a", "b"]);
    const first: OutlineNode = requireNode(result.nodes, "a");
    const second: OutlineNode = requireNode(result.nodes, "b");
    assert.equal(first.depth, 1);
    assert.equal(second.depth, 1);
    assert.equal(first.path, "xml/fragment.xml#a");
    assert.equal(second.path, "xml/fragment.xml#b");
    assertRange(first, MultiRootXml, 1, 1);
    assertRange(second, MultiRootXml, 2, 4);
    const nested: OutlineNode = requireNode(result.nodes, "c");
    assert.equal(nested.depth, 2);
    assert.equal(nested.path, "xml/fragment.xml#b.c");
    assertRange(nested, MultiRootXml, 3, 3);
    assert.equal(result.truncated, false);
});

test("XML attributes decode predefined, numeric and unknown entities and prefer id over name", (): void => {
    const result: OutlineResult = outline("xml/attributes.xml");
    const root: OutlineNode = requireNode(result.nodes, "root");
    assert.equal(root.label, "root");
    assert.equal(root.detail, "root:a&bAB&unknown;");
    const child: OutlineNode = requireNode(result.nodes, "child");
    assert.equal(child.detail, "child:single");
    const blank: OutlineNode = requireNode(result.nodes, "blank");
    assert.equal(blank.detail, undefined);
    const plain: OutlineNode = requireNode(result.nodes, "plain");
    assert.equal(plain.detail, undefined);
    assert.deepEqual(labels(root.children), ["child", "blank", "plain"]);
});

test("XML comments, PIs, CDATA, DOCTYPE and self-closing tags never fabricate nodes", (): void => {
    const result: OutlineResult = outline("xml/markup.xml");
    assert.equal(result.strategy, "xml");
    assert.deepEqual(labels(result.nodes[0].children), ["root"]);
    const root: OutlineNode = requireNode(result.nodes, "root");
    assert.deepEqual(labels(root.children), ["real"]);
    const fakeLabels: readonly string[] = ["comment-fake", "inner-fake", "pi-fake", "cdata-fake"];
    for (let index: number = 0; index < fakeLabels.length; index += 1) {
        assert.equal(findNode(result.nodes, fakeLabels[index]), undefined, `fake tag leaked: ${fakeLabels[index]}`);
    }
    const real: OutlineNode = requireNode(result.nodes, "real");
    assert.equal(real.type, "key");
    assertRange(real, MarkupXml, 10, 10);
    assertRange(root, MarkupXml, 6, 11);
    assert.equal(result.truncated, false);
    const commentOnly: OutlineResult = outline("xml/comment-only.xml");
    assert.equal(commentOnly.strategy, "xml");
    assert.deepEqual(labels(commentOnly.nodes[0].children), []);
    const empty: OutlineResult = outline("xml/empty.xml");
    assert.equal(empty.strategy, "xml");
    assert.deepEqual(labels(empty.nodes[0].children), []);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(Number(empty.nodes[0].range.endLine), 1);
});

test("XML namespace prefixes are stripped from labels and xmlns declarations emit no nodes", (): void => {
    const result: OutlineResult = outline("xml/namespaces.xml");
    assert.deepEqual(labels(result.nodes[0].children), ["root"]);
    const root: OutlineNode = requireNode(result.nodes, "root");
    assert.equal(root.label, "root");
    assert.equal(root.detail, "root:r1");
    assert.deepEqual(labels(root.children), ["child", "local-element"]);
    const child: OutlineNode = requireNode(result.nodes, "child");
    assert.equal(child.detail, "child:c1");
    const local: OutlineNode = requireNode(result.nodes, "local-element");
    assert.equal(local.detail, undefined);
    const all: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        assert.equal(all[index].label.includes(":"), false, `namespace prefix leaked into label: ${all[index].label}`);
    }
});

test("malformed XML is tolerated and unclosed elements extend to the scanned EOF", (): void => {
    /**
     * Unclosed elements extend to the end of the text passed to the scanner;
     * a mismatched close ends the matching element and any implicitly popped
     * descendants on that closing line.
     */
    const unclosed: OutlineResult = outline("xml/unclosed.xml");
    assert.equal(unclosed.strategy, "xml");
    assert.equal(unclosed.truncated, false);
    const root: OutlineNode = requireNode(unclosed.nodes, "root");
    const child: OutlineNode = requireNode(unclosed.nodes, "child");
    assert.equal(Number(root.range.startLine), 1);
    assert.equal(Number(root.range.endLine), 2);
    assert.equal(Number(child.range.startLine), 2);
    assert.equal(Number(child.range.endLine), 2);
    const mismatched: OutlineResult = outline("xml/mismatched.xml");
    assert.equal(mismatched.truncated, false);
    const outer: OutlineNode = requireNode(mismatched.nodes, "outer");
    const inner: OutlineNode = requireNode(mismatched.nodes, "inner");
    assert.equal(Number(outer.range.startLine), 1);
    assert.equal(Number(outer.range.endLine), 3);
    assert.equal(Number(inner.range.startLine), 2);
    assert.equal(Number(inner.range.endLine), 3);
});

test("the XML extension matrix selects the xml strategy for every documented suffix", (): void => {
    for (let index: number = 0; index < XmlExtensionCases.length; index += 1) {
        const item: XmlExtensionCase = XmlExtensionCases[index];
        const result: OutlineResult = outline(item.path);
        assert.equal(result.strategy, "xml", item.path);
        assert.equal(result.category, "data", item.path);
        assert.equal(result.language, "xml", item.path);
        assert.equal(result.charset, "utf-8", item.path);
        assert.deepEqual(labels(result.nodes[0].children), [item.root], item.path);
        assert.equal(requireNode(result.nodes, item.root).type, "key", item.path);
        assert.equal(result.truncated, false, item.path);
    }
});

test("extensionless XML is selected by content sniffing while plain text stays plainText", (): void => {
    const feed: OutlineResult = outline("sniff/feed");
    assert.equal(feed.strategy, "xml");
    assert.equal(feed.language, "xml");
    assert.deepEqual(labels(feed.nodes[0].children), ["feed"]);
    const fragment: OutlineResult = outline("sniff/fragment");
    assert.equal(fragment.strategy, "xml");
    assert.deepEqual(labels(fragment.nodes[0].children), ["root"]);
    const doctype: OutlineResult = outline("sniff/doctype");
    assert.equal(doctype.strategy, "xml");
    assert.deepEqual(labels(doctype.nodes[0].children), ["note"]);
    const plain: OutlineResult = outline("sniff/plain");
    assert.equal(plain.strategy, "plainText");
    assert.equal(plain.category, "prose");
    assert.equal(plain.language, "text");
    assert.deepEqual(labels(plain.nodes[0].children), []);
    const empty: OutlineResult = outline("sniff/empty");
    assert.equal(empty.strategy, "plainText");
    /**
     * Limitation: only the first 4096 decoded characters are sniffed, so a
     * whitespace-prefixed fragment after that window falls back to plainText.
     */
    const late: OutlineResult = outline("sniff/late");
    assert.equal(late.strategy, "plainText");
    assert.deepEqual(labels(late.nodes[0].children), []);
});

test("XML and OPML ranges are ordered bigints and symbol paths extend the file anchor", (): void => {
    const nested: OutlineResult = outline("xml/nested.xml");
    assertRangeContract(nested, "xml/nested.xml");
    const group: OutlineNode = requireNode(nested.nodes, "group");
    const leaf: OutlineNode = requireNode(nested.nodes, "leaf");
    assert.ok(group.range.startLine <= leaf.range.startLine);
    assert.ok(group.range.endLine >= leaf.range.endLine);
    assert.ok(group.range.startByte <= leaf.range.startByte);
    assert.ok(group.range.endByte >= leaf.range.endByte);
    const opml: OutlineResult = outline("opml/full.opml");
    assertRangeContract(opml, "opml/full.opml");
});

test("XML maxDepth keeps the boundary level, drops deeper elements and flags truncation", (): void => {
    const two: OutlineResult = outline("deep/deep.xml", { maxDepth: 2 });
    assert.equal(two.truncated, true);
    assert.deepEqual(flatten(two.nodes).map((node: OutlineNode): string => node.label), ["deep.xml", "a", "b"]);
    assert.equal(findNode(two.nodes, "c"), undefined);
    assert.equal(findNode(two.nodes, "d"), undefined);
    const three: OutlineResult = outline("deep/deep.xml", { maxDepth: 3 });
    assert.equal(three.truncated, true);
    assert.equal(requireNode(three.nodes, "c").depth, 3);
    assert.equal(findNode(three.nodes, "d"), undefined);
    const four: OutlineResult = outline("deep/deep.xml", { maxDepth: 4 });
    assert.equal(four.truncated, false);
    assert.equal(requireNode(four.nodes, "d").depth, 4);
    const full: OutlineResult = outline("deep/deep.xml");
    assert.equal(full.truncated, false);
    assert.equal(flatten(full.nodes).length, 5);
});

test("XML maxNodes counts the anchor, truncates in preorder and leaves no dangling children", (): void => {
    const three: OutlineResult = outline("deep/deep.xml", { maxNodes: 3 });
    assert.equal(three.truncated, true);
    assert.deepEqual(flatten(three.nodes).map((node: OutlineNode): string => node.label), ["deep.xml", "a", "b"]);
    assert.deepEqual(requireNode(three.nodes, "b").children, []);
    const one: OutlineResult = outline("deep/deep.xml", { maxNodes: 1 });
    assert.equal(one.truncated, true);
    assert.deepEqual(labels(one.nodes[0].children), []);
    const five: OutlineResult = outline("deep/deep.xml", { maxNodes: 5 });
    assert.equal(five.truncated, false);
    assert.equal(flatten(five.nodes).length, 5);
    const spare: OutlineResult = outline("deep/deep.xml", { maxNodes: 50 });
    assert.equal(spare.truncated, false);
    assert.equal(flatten(spare.nodes).length, 5);
});

test("XML invalid bounds, binary content, oversize files and escaping paths raise closed codes", (): void => {
    expectFilesystemError("invalid_arguments", (): void => {
        outline("xml/nested.xml", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("xml/nested.xml", { maxDepth: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("xml/nested.xml", { maxNodes: 2.5 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("xml/nested.xml", { maxDepth: -1 });
    });
    expectFilesystemError("binary_file", (): void => {
        outline("errors/blob.xml");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("errors/huge.xml");
    });
    expectFilesystemError("not_found", (): void => {
        outline("xml/missing.xml");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.xml");
    });
});

test("the XML structure scan stops after 3000 lines and flags truncation", (): void => {
    const result: OutlineResult = outline("scan/large.xml");
    assert.equal(result.strategy, "xml");
    assert.equal(result.truncated, true);
    assert.ok(findNode(result.nodes, "mid") !== (void 0));
    assert.equal(findNode(result.nodes, "late"), undefined);
    assert.equal(Number(result.nodes[0].range.endLine), 3003);
    /**
     * Limitation: because the closing tag is outside the scan window, the
     * scanned root extends to the end of the scanned prefix, not full-file EOF.
     */
    assert.equal(Number(requireNode(result.nodes, "root").range.endLine), 3000);
});

test("OPML text/title attributes become heading nodes nested exactly as in the source", (): void => {
    const result: OutlineResult = outline("opml/full.opml");
    assert.equal(result.strategy, "opml");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "opml");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["opml"]);
    const document: OutlineNode = requireNode(result.nodes, "opml");
    assert.equal(document.type, "heading");
    assert.equal(document.depth, 1);
    assert.equal(document.path, "opml/full.opml#opml");
    assertRange(document, OpmlFull, 2, 12);
    const head: OutlineNode = requireNode(result.nodes, "head");
    const body: OutlineNode = requireNode(result.nodes, "body");
    assert.equal(head.depth, 2);
    assert.equal(body.depth, 2);
    assertRange(head, OpmlFull, 3, 5);
    assertRange(body, OpmlFull, 6, 11);
    assert.deepEqual(labels(head.children), ["title"]);
    const chapter: OutlineNode = requireNode(result.nodes, "A & B");
    assert.equal(chapter.type, "heading");
    assert.equal(chapter.depth, 3);
    assert.equal(chapter.path, "opml/full.opml#opml.body.A & B");
    assertRange(chapter, OpmlFull, 7, 10);
    const titleOnly: OutlineNode = requireNode(result.nodes, "Title Only");
    assert.equal(titleOnly.depth, 4);
    assertRange(titleOnly, OpmlFull, 8, 8);
    const hashLabel: OutlineNode = requireNode(result.nodes, "C# & D");
    assert.equal(hashLabel.path, "opml/full.opml#opml.body.A & B.C%23 & D");
    assertRange(hashLabel, OpmlFull, 9, 9);
    /**
     * An empty `text` is treated as absent, so OPML falls back to `title`.
     */
    const attrs: OutlineResult = outline("opml/attrs.opml");
    assert.deepEqual(labels(requireNode(attrs.nodes, "body").children), ["Ignored", "Only"]);
    assert.equal(requireNode(attrs.nodes, "Ignored").depth, 3);
});

test("[defect] a quoted > inside an XML attribute must not swallow the attribute list", (): void => {
    const result: OutlineResult = outline("xml/attr-gt.xml");
    const node: OutlineNode = requireNode(result.nodes, "node");
    assert.equal(node.depth, 2);
    assert.equal(node.detail, "node:one", "quoted > in an attribute value must stay inside the tag");
});

/**
 * Tests: Markdown.
 */

test("ATX headings keep their declared rank and skipped levels nest under the nearest shallower heading", (): void => {
    const result: OutlineResult = outline("md/atx.md");
    assert.equal(result.strategy, "markdown");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "markdown");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "md/atx.md");
    assert.equal(anchor.label, "atx.md");
    assertRange(anchor, AtxMarkdown, 1, 4);
    assert.deepEqual(labels(anchor.children), ["One"]);
    const one: OutlineNode = requireNode(result.nodes, "One");
    const three: OutlineNode = requireNode(result.nodes, "Three");
    const two: OutlineNode = requireNode(result.nodes, "Two");
    const four: OutlineNode = requireNode(result.nodes, "Four");
    assert.equal(one.depth, 1);
    assert.equal(three.depth, 3);
    assert.equal(two.depth, 2);
    assert.equal(four.depth, 4);
    assert.equal(one.path, "md/atx.md#One");
    assert.equal(three.path, "md/atx.md#One.Three");
    assert.equal(two.path, "md/atx.md#One.Two");
    assert.equal(four.path, "md/atx.md#One.Two.Four");
    assertRange(one, AtxMarkdown, 1, 4);
    assertRange(three, AtxMarkdown, 2, 2);
    assertRange(two, AtxMarkdown, 3, 4);
    assertRange(four, AtxMarkdown, 4, 4);
    assert.deepEqual(labels(one.children), ["Three", "Two"]);
    assert.deepEqual(labels(two.children), ["Four"]);
    for (let index: number = 0; index < 4; index += 1) {
        assert.equal(requireNode(result.nodes, ["One", "Three", "Two", "Four"][index]).type, "heading");
    }
});

test("setext headings map = to depth 1 and - to depth 2 while closing ATX hashes are stripped", (): void => {
    const result: OutlineResult = outline("md/setext.md");
    assert.equal(result.strategy, "markdown");
    assert.deepEqual(labels(result.nodes[0].children), ["Setext One"]);
    const one: OutlineNode = requireNode(result.nodes, "Setext One");
    const two: OutlineNode = requireNode(result.nodes, "Setext Two");
    const closing: OutlineNode = requireNode(result.nodes, "Closing");
    const sharp: OutlineNode = requireNode(result.nodes, "C#");
    assert.equal(one.depth, 1);
    assert.equal(two.depth, 2);
    assert.equal(closing.depth, 2);
    assert.equal(sharp.depth, 3);
    assert.equal(one.type, "heading");
    assertRange(one, SetextMarkdown, 1, 8);
    assertRange(two, SetextMarkdown, 4, 6);
    assertRange(closing, SetextMarkdown, 7, 8);
    assertRange(sharp, SetextMarkdown, 8, 8);
    assert.deepEqual(labels(one.children), ["Setext Two", "Closing"]);
    assert.deepEqual(labels(closing.children), ["C#"]);
    assert.equal(sharp.path, "md/setext.md#Setext One.Closing.C%23");
    assert.equal(findNode(result.nodes, "## Closing ##"), undefined);
});

test("fenced code blocks hide # lines and only a matching fence closes them", (): void => {
    const result: OutlineResult = outline("md/fences.md");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["Before", "After"]);
    const before: OutlineNode = requireNode(result.nodes, "Before");
    const after: OutlineNode = requireNode(result.nodes, "After");
    assert.equal(before.depth, 1);
    assert.equal(after.depth, 1);
    assertRange(before, FenceMarkdown, 1, 12);
    assertRange(after, FenceMarkdown, 13, 13);
    const hidden: readonly string[] = ["inside", "tilde inside", "not heading", "still fenced"];
    for (let index: number = 0; index < hidden.length; index += 1) {
        assert.equal(findNode(result.nodes, hidden[index]), undefined, `fenced # leaked: ${hidden[index]}`);
    }
});

test("a four-space indented fence is read as text and its # line becomes a heading", (): void => {
    /**
     * Limitation: `FenceLine` accepts at most three leading spaces, so a fence
     * indented by four spaces is not a fence and the `#` line below it is an
     * ATX heading, unlike CommonMark's indented code block.
     */
    const result: OutlineResult = outline("md/indented-fence.md");
    const heading: OutlineNode = requireNode(result.nodes, "inside indented fence");
    assert.equal(heading.depth, 1);
    assert.equal(heading.type, "heading");
    assertRange(heading, IndentedFenceMarkdown, 2, 3);
    assert.equal(result.truncated, false);
});

test("front matter titles honor quotes, comments, ... closing and an unclosed block falls back to the body", (): void => {
    const quoted: OutlineResult = outline("md/front-quoted.md");
    const title: OutlineNode = requireNode(quoted.nodes, "C# Guide");
    assert.equal(title.type, "heading");
    assert.equal(title.detail, "front matter");
    assert.equal(title.depth, 1);
    assert.equal(title.path, "md/front-quoted.md#C%23 Guide");
    assertRange(title, FrontQuotedMarkdown, 2, 4);
    assert.deepEqual(labels(quoted.nodes[0].children), ["C# Guide", "Body"]);
    const unquoted: OutlineResult = outline("md/front-unquoted.md");
    const unquotedTitle: OutlineNode = requireNode(unquoted.nodes, "C# Guide");
    assert.equal(unquotedTitle.detail, "front matter");
    assertRange(unquotedTitle, FrontUnquotedMarkdown, 2, 3);
    const unclosed: OutlineResult = outline("md/front-unclosed.md");
    assert.equal(findNode(unclosed.nodes, "Lost"), undefined);
    assert.deepEqual(labels(unclosed.nodes[0].children), ["Body"]);
    assertRange(requireNode(unclosed.nodes, "Body"), FrontUnclosedMarkdown, 3, 3);
});

test("links, images, inline HTML, blockquotes and list items never become headings", (): void => {
    const result: OutlineResult = outline("md/links.md");
    assert.deepEqual(labels(result.nodes[0].children), ["Real"]);
    assert.equal(result.nodes[0].children.length, 1);
    const real: OutlineNode = requireNode(result.nodes, "Real");
    assert.equal(real.depth, 1);
    assertRange(real, LinksMarkdown, 5, 8);
    const pseudo: readonly string[] = ["#anchor", "#image", "inline html", "quoted", "list item"];
    for (let index: number = 0; index < pseudo.length; index += 1) {
        assert.equal(findNode(result.nodes, pseudo[index]), undefined, `inline markup leaked: ${pseudo[index]}`);
    }
});

test("[defect] a type-6 HTML block must not let its # line become an ATX heading", (): void => {
    const result: OutlineResult = outline("md/html-block.md");
    assert.ok(findNode(result.nodes, "real") !== (void 0));
    assert.equal(findNode(result.nodes, "block line"), undefined, "an HTML block must not emit an ATX heading");
});

test("CRLF line endings keep line numbers and include the carriage return in UTF-8 byte ranges", (): void => {
    const result: OutlineResult = outline("md/crlf.md");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(CrlfMarkdown, "utf8")));
    assertRange(result.nodes[0], CrlfMarkdown, 1, 5);
    const top: OutlineNode = requireNode(result.nodes, "Top");
    const child: OutlineNode = requireNode(result.nodes, "Child");
    assert.equal(top.depth, 1);
    assert.equal(child.depth, 2);
    assert.equal(child.path, "md/crlf.md#Top.Child");
    assertRange(top, CrlfMarkdown, 1, 5);
    assertRange(child, CrlfMarkdown, 3, 5);
    assert.equal(child.range.startByte, top.range.startByte + 9n);
});

test("a UTF-8 BOM is bridged so the anchor and symbols cover raw-file bytes", (): void => {
    /**
     * `outline.ts` gained a `byteOffsetBase` for a UTF-8 BOM during this test
     * campaign (reported by the HTML track). The fixture now asserts the fixed
     * contract: the anchor ends at the raw file size and every symbol range is
     * shifted by the three BOM bytes.
     */
    const result: OutlineResult = outline("md/bom.md");
    assert.equal(result.charset, "utf-8-bom");
    assert.deepEqual(labels(result.nodes[0].children), ["BOM Heading"]);
    const overview: OutlineNode = requireNode(result.nodes, "BOM Heading");
    const child: OutlineNode = requireNode(result.nodes, "Child");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(overview.depth, 1);
    assert.equal(anchor.file!.bytes, 27n);
    assert.equal(anchor.range.endByte, 27n);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(overview.range.startByte, 3n);
    assert.equal(overview.range.endByte, 27n);
    assert.equal(child.range.startByte, 18n);
    assert.equal(child.range.endByte, 27n);
    assert.equal(Number(overview.range.startLine), 1);
    assert.equal(Number(overview.range.endLine), 3);
    assert.equal(Number(child.range.startLine), 3);
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
});

test("UTF-16LE markdown decodes by BOM and reports ranges relative to the decoded text", (): void => {
    /**
     * Limitation: decoded text is indexed as UTF-8, so byte offsets are offsets
     * into the decoded text, not into the raw UTF-16 file. The file anchor is
     * therefore shorter than `file.bytes`.
     */
    const result: OutlineResult = outline("md/utf16.md");
    assert.equal(result.charset, "utf-16le");
    assert.deepEqual(labels(result.nodes[0].children), ["UTF16 Heading"]);
    const heading: OutlineNode = requireNode(result.nodes, "UTF16 Heading");
    assert.equal(heading.depth, 1);
    assert.equal(heading.range.startByte, 0n);
    assert.equal(heading.range.endByte, BigInt(Buffer.byteLength("# UTF16 Heading\n", "utf8")));
    assert.equal(result.nodes[0].range.endByte, heading.range.endByte);
    assert.equal(result.nodes[0].file!.bytes, 34n);
    assert.equal(result.truncated, false);
});

test("Unicode Markdown labels survive and UTF-8 byte ranges count multibyte characters", (): void => {
    const result: OutlineResult = outline("md/unicode.md");
    assert.deepEqual(labels(result.nodes[0].children), ["概览 🚀"]);
    const overview: OutlineNode = requireNode(result.nodes, "概览 🚀");
    const detail: OutlineNode = requireNode(result.nodes, "细节");
    assert.equal(overview.depth, 1);
    assert.equal(detail.depth, 2);
    assert.equal(overview.path, "md/unicode.md#概览 🚀");
    assert.equal(detail.path, "md/unicode.md#概览 🚀.细节");
    assertRange(overview, UnicodeMarkdown, 1, 3);
    assertRange(detail, UnicodeMarkdown, 3, 3);
    assert.ok(Buffer.byteLength(UnicodeMarkdown, "utf8") > UnicodeMarkdown.length);
});

test("empty, front-matter-only and fence-only Markdown files yield well-formed anchors", (): void => {
    const empty: OutlineResult = outline("md/empty.md");
    assert.equal(empty.strategy, "markdown");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes[0].isFile, true);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(Number(empty.nodes[0].range.endLine), 1);
    assert.deepEqual(labels(empty.nodes[0].children), []);
    const front: OutlineResult = outline("md/front-only.md");
    const title: OutlineNode = requireNode(front.nodes, "Only");
    assert.equal(title.detail, "front matter");
    assertRange(title, "---\ntitle: Only\n---\n", 2, 3);
    assertRange(front.nodes[0], "---\ntitle: Only\n---\n", 1, 3);
    const fence: OutlineResult = outline("md/fence-only.md");
    assert.deepEqual(labels(fence.nodes[0].children), []);
    assert.equal(fence.truncated, false);
    assert.equal(Number(fence.nodes[0].range.endLine), 3);
});

test("maxNodes and maxDepth bound Markdown trees and invalid bounds are refused", (): void => {
    const nodesThree: OutlineResult = outline("md/limits.md", { maxNodes: 3 });
    assert.equal(nodesThree.truncated, true);
    assert.deepEqual(flatten(nodesThree.nodes).map((node: OutlineNode): string => node.label), ["limits.md", "A", "B"]);
    assert.equal(findNode(nodesThree.nodes, "C"), undefined);
    assert.equal(findNode(nodesThree.nodes, "D"), undefined);
    const anchorOnly: OutlineResult = outline("md/limits.md", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.deepEqual(labels(anchorOnly.nodes[0].children), []);
    const depthTwo: OutlineResult = outline("md/limits.md", { maxDepth: 2 });
    assert.equal(depthTwo.truncated, true);
    assert.deepEqual(flatten(depthTwo.nodes).map((node: OutlineNode): string => node.label), ["limits.md", "A", "B", "D"]);
    assert.equal(findNode(depthTwo.nodes, "C"), undefined);
    const depthOne: OutlineResult = outline("md/limits.md", { maxDepth: 1 });
    assert.equal(depthOne.truncated, true);
    assert.deepEqual(flatten(depthOne.nodes).map((node: OutlineNode): string => node.label), ["limits.md", "A", "D"]);
    const depthThree: OutlineResult = outline("md/limits.md", { maxDepth: 3 });
    assert.equal(depthThree.truncated, false);
    assert.equal(requireNode(depthThree.nodes, "C").depth, 3);
    const complete: OutlineResult = outline("md/limits.md", { maxNodes: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 5);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("md/limits.md", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("md/limits.md", { maxDepth: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("md/limits.md", { maxNodes: 1.5 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("md/limits.md", { maxDepth: Number.NaN });
    });
});

test("binary, oversize, missing and escaping Markdown paths raise closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("errors/blob.md");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("errors/huge.md");
    });
    expectFilesystemError("not_found", (): void => {
        outline("md/missing.md");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.md");
    });
});

test("the Markdown extension matrix selects markdown for md/mdx/markdown and uppercase MD", (): void => {
    const paths: readonly string[] = ["matrix/readme.md", "matrix/readme.mdx", "matrix/readme.markdown", "matrix/readme.MD"];
    for (let index: number = 0; index < paths.length; index += 1) {
        const result: OutlineResult = outline(paths[index]);
        assert.equal(result.strategy, "markdown", paths[index]);
        assert.equal(result.category, "prose", paths[index]);
        assert.equal(result.language, "markdown", paths[index]);
        assert.deepEqual(labels(result.nodes[0].children), ["Title"], paths[index]);
        const title: OutlineNode = requireNode(result.nodes, "Title");
        const sub: OutlineNode = requireNode(result.nodes, "Sub");
        assert.equal(title.depth, 1, paths[index]);
        assert.equal(sub.depth, 2, paths[index]);
        assert.equal(findNode(result.nodes, "Component"), undefined, paths[index]);
        assert.equal(result.truncated, false, paths[index]);
    }
});

test("the Markdown structure scan stops after 3000 lines and flags truncation", (): void => {
    const result: OutlineResult = outline("scan/long.md");
    assert.equal(result.strategy, "markdown");
    assert.equal(result.truncated, true);
    assert.deepEqual(labels(result.nodes[0].children), ["First"]);
    const first: OutlineNode = requireNode(result.nodes, "First");
    assert.equal(first.depth, 1);
    assertRange(first, LongMarkdownLines.join("\n"), 1, 3000);
    assert.equal(findNode(result.nodes, "Late"), undefined);
    assert.equal(Number(result.nodes[0].range.endLine), 3005);
    assert.equal(Number(result.nodes[0].range.endByte), Buffer.byteLength(LongMarkdownLines.join("\n"), "utf8"));
});

test("duplicate symbol paths are disambiguated without colliding with literal labels", (): void => {
    const result: OutlineResult = outline("md/path-collision.md");
    const nodes: OutlineNode[] = result.nodes[0].children as OutlineNode[];
    assert.deepEqual(labels(nodes), ["Repeat", "Repeat", "Repeat~heading-1-1"]);
    assert.equal(new Set(nodes.map((node: OutlineNode): string => node.path)).size, nodes.length);
    assert.equal(nodes[2].path, "md/path-collision.md#Repeat~heading-1-1");
    assert.equal(nodes[0].path, "md/path-collision.md#Repeat~heading-1-1-2");
    assert.equal(nodes[1].path, "md/path-collision.md#Repeat~heading-2-2");
});

test("Markdown symbol paths escape %, # and / while ranges stay ordered", (): void => {
    const result: OutlineResult = outline("md/escape.md");
    assertRangeContract(result, "md/escape.md");
    const parent: OutlineNode = requireNode(result.nodes, "100% #done");
    const nested: OutlineNode = requireNode(result.nodes, "a/b and c");
    assert.equal(parent.path, "md/escape.md#100%25 %23done");
    assert.equal(nested.path, "md/escape.md#100%25 %23done.a%2Fb and c");
    assert.equal(nested.depth, 2);
    assertRange(parent, EscapeMarkdown, 1, 3);
    assertRange(nested, EscapeMarkdown, 3, 3);
});

/**
 * Tests: TeX / plain text.
 */

test("TeX sectioning commands map to declared depths and labels are cleaned", (): void => {
    const result: OutlineResult = outline("tex/document.tex");
    assert.equal(result.strategy, "tex");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "tex");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["Part One", "Part Two"]);
    const part: OutlineNode = requireNode(result.nodes, "Part One");
    const chapter: OutlineNode = requireNode(result.nodes, "Chapter One");
    const section: OutlineNode = requireNode(result.nodes, "Long Bold Title");
    const subsection: OutlineNode = requireNode(result.nodes, "Sub One");
    const figure: OutlineNode = requireNode(result.nodes, "figure");
    const second: OutlineNode = requireNode(result.nodes, "Part Two");
    assert.equal(part.type, "part");
    assert.equal(chapter.type, "chapter");
    assert.equal(section.type, "section");
    assert.equal(subsection.type, "subsection");
    assert.equal(figure.type, "environment");
    assert.equal(part.depth, 1);
    assert.equal(chapter.depth, 2);
    assert.equal(section.depth, 3);
    assert.equal(subsection.depth, 4);
    assert.equal(figure.depth, 5);
    assert.equal(second.depth, 1);
    assert.equal(section.label, "Long Bold Title");
    assert.equal(section.path, "tex/document.tex#Part One.Chapter One.Long Bold Title");
    assert.equal(subsection.path, "tex/document.tex#Part One.Chapter One.Long Bold Title.Sub One");
    assertRange(part, TexDocument, 4, 11);
    assertRange(chapter, TexDocument, 5, 11);
    assertRange(section, TexDocument, 6, 11);
    assertRange(subsection, TexDocument, 7, 11);
    assertRange(figure, TexDocument, 9, 11);
    assert.equal(requireNode(subsection.children, "figure").path, figure.path);
    assertRange(second, TexDocument, 12, 13);
    assert.equal(findNode(result.nodes, "Hidden"), undefined);
    assert.equal(findNode(result.nodes, "document"), undefined);
    assert.equal(findNode(result.nodes, "Short"), undefined);
});

test("TeX comments are masked and begin/end pairs become nested environment nodes", (): void => {
    const result: OutlineResult = outline("tex/environments.tex");
    assert.equal(result.strategy, "tex");
    assert.deepEqual(labels(result.nodes[0].children), ["enumerate", "figure"]);
    const outer: OutlineNode = requireNode(result.nodes, "enumerate");
    const inner: OutlineNode = requireNode(result.nodes, "itemize");
    const figure: OutlineNode = requireNode(result.nodes, "figure");
    assert.equal(outer.type, "environment");
    assert.equal(outer.depth, 1);
    assert.equal(inner.depth, 2);
    assert.equal(figure.depth, 1);
    assert.equal(outer.path, "tex/environments.tex#enumerate");
    assert.equal(inner.path, "tex/environments.tex#enumerate.itemize");
    assertRange(outer, TexEnvironments, 1, 6);
    assertRange(inner, TexEnvironments, 3, 5);
    assertRange(figure, TexEnvironments, 7, 8);
    const latex: OutlineResult = outline("tex/paper.ltx");
    const style: OutlineResult = outline("tex/theme.sty");
    const classFile: OutlineResult = outline("tex/theme.cls");
    assert.deepEqual([latex.strategy, style.strategy, classFile.strategy], ["tex", "tex", "tex"]);
    assert.deepEqual([latex.language, style.language, classFile.language], ["tex", "tex", "tex"]);
    assert.deepEqual(labels(latex.nodes[0].children), ["Ltx Section"]);
    assert.deepEqual(labels(style.nodes[0].children), ["Sty Section"]);
    assert.deepEqual(labels(classFile.nodes[0].children), ["Cls Section"]);
    assert.equal(requireNode(latex.nodes, "Ltx Section").depth, 3);
});

test("plain text recognizes volume, chapter and section markers with stable depth", (): void => {
    const result: OutlineResult = outline("plain/book.txt");
    assert.equal(result.strategy, "plainText");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "txt");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["卷一 起始", "THE ENDING"]);
    const volume: OutlineNode = requireNode(result.nodes, "卷一 起始");
    const chapter: OutlineNode = requireNode(result.nodes, "第一章 相遇");
    const section: OutlineNode = requireNode(result.nodes, "第一节 初见");
    const ending: OutlineNode = requireNode(result.nodes, "THE ENDING");
    const later: OutlineNode = requireNode(result.nodes, "第 12 回 再来");
    assert.equal(volume.type, "part");
    assert.equal(volume.depth, 1);
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assert.equal(ending.type, "heading");
    assert.equal(ending.depth, 1);
    assert.equal(later.type, "chapter");
    assert.equal(later.depth, 2);
    assert.equal(section.path, "plain/book.txt#卷一 起始.第一章 相遇.第一节 初见");
    assert.equal(later.path, "plain/book.txt#THE ENDING.第 12 回 再来");
    assertRange(volume, BookText, 1, 4);
    assertRange(chapter, BookText, 2, 4);
    assertRange(section, BookText, 3, 4);
    assertRange(ending, BookText, 5, 7);
    assertRange(later, BookText, 7, 7);
});

test("plain text underline titles and short all-caps lines become depth-0 headings", (): void => {
    const result: OutlineResult = outline("plain/upper.txt");
    assert.deepEqual(labels(result.nodes[0].children), ["INTRODUCTION", "SECOND PART"]);
    const intro: OutlineNode = requireNode(result.nodes, "INTRODUCTION");
    const second: OutlineNode = requireNode(result.nodes, "SECOND PART");
    assert.equal(intro.type, "heading");
    assert.equal(intro.depth, 1);
    assert.equal(second.type, "heading");
    assert.equal(second.depth, 1);
    assertRange(intro, UpperText, 1, 3);
    assertRange(second, UpperText, 4, 4);
    assert.equal(findNode(result.nodes, "Not All Caps"), undefined);
});

test("extensionless and unknown-extension plain text keep their language tag and declared chapter depth", (): void => {
    const readme: OutlineResult = outline("plain/README");
    assert.equal(readme.strategy, "plainText");
    assert.equal(readme.category, "prose");
    assert.equal(readme.language, "text");
    assert.deepEqual(labels(readme.nodes[0].children), []);
    assert.equal(readme.truncated, false);
    const notes: OutlineResult = outline("plain/notes.log");
    assert.equal(notes.strategy, "plainText");
    assert.equal(notes.language, "log");
    const chapter: OutlineNode = requireNode(notes.nodes, "Chapter One");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assertRange(chapter, "# not a heading\nChapter One\n", 2, 2);
    assert.equal(findNode(notes.nodes, "# not a heading"), undefined);
    const unknown: OutlineResult = outline("plain/notes.unknown");
    assert.equal(unknown.strategy, "plainText");
    assert.equal(unknown.language, "unknown");
    assert.equal(requireNode(unknown.nodes, "CHAPTER ONE").depth, 2);
});
