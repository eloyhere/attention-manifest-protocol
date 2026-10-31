#!/usr/bin/env node
/**
 * TeX/LaTeX outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; no fixture is typeset, executed or fetched. All assertions use the
 * public `buildOutline` entry point, so sandbox resolution, the charset gate,
 * anchor construction, UTF-8 byte ranges, the node/depth budget and strategy
 * selection are exercised together with `parseTex`.
 *
 * Two layers are reported:
 *
 * - conformance tests assert the behavior the strategy documents;
 * - `[known defect D<n> ...]` tests pin the current behavior of a boundary the
 *   parser handles incorrectly, so every gap is executable and visible. Those
 *   assertions describe the measured behavior, not the desired contract; the
 *   expected behavior and suggested fix are in `docs/testing/languages/texReport.md`.
 *
 * Run with: node tools/texOutlineCheck.ts
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

const Root: string = mkdtempSync(join(tmpdir(), "amp-tex-outline-"));
const RootSpec: SessionRoot = { id: "root.texOutline", path: Root, writable: true, exclude: [] };
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
 * Preorder flattening of an outline tree, anchor included.
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
 * 1-based start byte offset of one line, matching ByteLineIndex semantics.
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
 * Assert one node's line and byte range against a decoded text.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number,
): void => {
    assert.equal(Number(node.range.startLine), startLine, `${node.label}: startLine`);
    assert.equal(Number(node.range.endLine), endLine, `${node.label}: endLine`);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte, `${node.label}: startByte`);
    assert.equal(node.range.endByte, expected.endByte, `${node.label}: endByte`);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Assert that every range is a bigint, is internally ordered, and stays inside
 * its parent. Used only for a pure-heading fixture where the parser's declared
 * ranges are expected to be true subtree ranges.
 */
const assertOrderedTree: (node: OutlineNode, parent?: OutlineNode) => void = (node: OutlineNode, parent?: OutlineNode): void => {
    assert.equal(typeof(node.range.startByte), "bigint", `${node.label}: startByte is bigint`);
    assert.equal(typeof(node.range.endByte), "bigint", `${node.label}: endByte is bigint`);
    assert.equal(typeof(node.range.startLine), "bigint", `${node.label}: startLine is bigint`);
    assert.equal(typeof(node.range.endLine), "bigint", `${node.label}: endLine is bigint`);
    assert.ok(node.range.startByte >= 0n, `${node.label}: non-negative startByte`);
    assert.ok(node.range.startByte <= node.range.endByte, `${node.label}: byte range ordered`);
    assert.ok(node.range.startLine >= 1n, `${node.label}: startLine is 1-based`);
    assert.ok(node.range.startLine <= node.range.endLine, `${node.label}: line range ordered`);
    assert.ok(node.path.length > 0, `${node.label}: path is present`);
    if (parent !== undefined) {
        if (parent.isFile) {
            assert.ok(node.path.startsWith(`${parent.path}#`), `${node.label}: anchor path prefix`);
        } else {
            assert.ok(node.path.startsWith(`${parent.path}.`), `${node.label}: symbol path prefix`);
        }
        assert.equal(node.depth, parent.depth + 1, `${node.label}: depth is parent + 1`);
        assert.ok(node.range.startLine >= parent.range.startLine, `${node.label}: line starts inside parent`);
        assert.ok(node.range.endLine <= parent.range.endLine, `${node.label}: line ends inside parent`);
        assert.ok(node.range.startByte >= parent.range.startByte, `${node.label}: byte starts inside parent`);
        assert.ok(node.range.endByte <= parent.range.endByte, `${node.label}: byte ends inside parent`);
    }
    for (let index: number = 1; index < node.children.length; index += 1) {
        assert.ok(node.children[index - 1].range.startLine <= node.children[index].range.startLine, `${node.label}: sibling lines ordered`);
        assert.ok(node.children[index - 1].range.startByte <= node.children[index].range.startByte, `${node.label}: sibling bytes ordered`);
    }
    for (let index: number = 0; index < node.children.length; index += 1) {
        assertOrderedTree(node.children[index], node);
    }
};

/**
 * Six sectioning commands, in order, including the star/optional forms used
 * elsewhere: part -> chapter -> section -> subsection -> subsubsection ->
 * paragraph. `\subparagraph` is kept for D4.
 */
const HierarchyText: string = [
    "\\documentclass{book}",
    "\\begin{document}",
    "\\part{Part One}",
    "\\chapter{Chapter One}",
    "\\section{Section One}",
    "\\subsection{Subsection One}",
    "\\subsubsection{Subsubsection One}",
    "\\paragraph{Paragraph One}",
    "\\subparagraph{Subparagraph One}",
    "\\end{document}",
].join("\n");

/**
 * A skipped chapter and a skipped section. The declared TeX rank, rather than
 * the number of visible parents, is expected to survive.
 */
const SkipText: string = [
    "\\part{Top}",
    "\\subsection{Jump Three}",
    "\\paragraph{Jump Five}",
].join("\n");

/**
 * A document environment plus two nested environments.
 */
const EnvironmentsText: string = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{figure}",
    "\\caption{A}",
    "\\begin{center}",
    "text",
    "\\end{center}",
    "\\end{figure}",
    "\\end{document}",
].join("\n");

/**
 * A section, then an environment, then a subsection. The environment is a
 * sibling of the section in the current implementation (D1).
 */
const EnvMixText: string = [
    "\\section{S}",
    "\\begin{figure}",
    "\\caption{A}",
    "\\end{figure}",
    "\\subsection{T}",
].join("\n");

/**
 * A commented pseudo heading, an escaped percent followed by a real heading on
 * the same line, and a trailing comment containing another pseudo heading.
 */
const CommentsText: string = [
    "% \\section{Commented}",
    "\\section{Real}",
    "Text 50\\% done \\section{Escaped Survives} % \\section{Trailing Fake}",
    "\\section{After}",
].join("\n");

/**
 * `\verb` and `verbatim` bodies are not masked by parseTex (D2).
 */
const VerbatimText: string = [
    "\\section{Real}",
    "\\verb|\\section{InlineFake}|",
    "\\begin{verbatim}",
    "\\section{BlockFake}",
    "\\end{verbatim}",
    "\\begin{comment}",
    "\\section{CommentEnvFake}",
    "\\end{comment}",
    "\\iffalse",
    "\\section{IffalseFake}",
    "\\fi",
    "\\section{After}",
].join("\n");

/**
 * Macro definitions are hidden, including their heading-looking bodies.
 */
const MacroText: string = [
    "\\section{Real}",
    "\\newcommand{\\fake}{\\section{MacroFake}}",
    "\\renewcommand{\\other}[1]{\\section{MacroFakeTwo}}",
    "\\def\\deffake{\\section{DefFake}}",
].join("\n");

/**
 * `\input` and `\include` are not translated into reference/import nodes.
 */
const InputText: string = [
    "\\section{Before}",
    "\\input{chapters/one}",
    "\\include{chapters/two}",
    "\\section{After}",
].join("\n");

/**
 * Starred heading, optional short title and a nested command in the long title.
 */
const OptionalText: string = [
    "\\section*{Starred}",
    "\\section[Short]{Long Title}",
    "\\section[Short]{Long \\textbf{Bold} Title}",
    "\\section[{Short] Label}]{Long Label}",
].join("\n");

/**
 * A deliberately unclosed environment must end at EOF, not on its opener.
 */
const UnclosedText: string = [
    "\\section{Open}",
    "\\begin{figure}",
    "\\caption{Open}",
].join("\n");

const CrlfText: string = "\\section{CRLF A}\r\nText\r\n\\section{CRLF B}\r\n";
const BomBody: string = "\\section{BOM Title}\n";
const Bom: Uint8Array = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(BomBody, "utf8")]);
const UnicodeText: string = "\\section{绪论 🌱}\n\\subsection{Café}\n";

const BudgetText: string = [
    "\\part{P}",
    "\\chapter{C}",
    "\\section{S}",
    "\\subsection{SS}",
].join("\n");

const CommentsOnlyText: string = "% only comments\n% second line\n";

fixture("tex/extensions/sample.tex", "\\section{Extension}");
fixture("tex/extensions/sample.ltx", "\\section{Extension}");
fixture("tex/extensions/sample.sty", "\\section{Extension}");
fixture("tex/extensions/sample.cls", "\\section{Extension}");
fixture("tex/hierarchy.tex", HierarchyText);
fixture("tex/skip.tex", SkipText);
fixture("tex/environments.tex", EnvironmentsText);
fixture("tex/envmix.tex", EnvMixText);
fixture("tex/comments.tex", CommentsText);
fixture("tex/verbatim.tex", VerbatimText);
fixture("tex/macros.tex", MacroText);
fixture("tex/input.tex", InputText);
fixture("tex/optional.tex", OptionalText);
fixture("tex/unclosed.tex", UnclosedText);
fixture("tex/empty.tex", "");
fixture("tex/comments-only.tex", CommentsOnlyText);
fixture("tex/crlf.tex", CrlfText);
fixture("tex/bom.tex", Bom);
fixture("tex/unicode.tex", UnicodeText);
fixture("tex/budget.tex", BudgetText);
fixture("tex/blob.tex", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("tex/huge.tex", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

test("all four TeX-family extensions select the tex strategy with prose/tex metadata", (): void => {
    const extensions: readonly string[] = ["tex", "ltx", "sty", "cls"];
    for (let index: number = 0; index < extensions.length; index += 1) {
        const extension: string = extensions[index];
        const path: string = `tex/extensions/sample.${extension}`;
        const result: OutlineResult = outline(path);
        assert.equal(result.strategy, "tex", `${extension}: strategy`);
        assert.equal(result.language, "tex", `${extension}: language`);
        assert.equal(result.category, "prose", `${extension}: category`);
        assert.equal(result.target, "file", `${extension}: target`);
        assert.equal(result.charset, "utf-8", `${extension}: charset`);
        assert.equal(result.nodes.length, 1, `${extension}: one anchor`);
        assert.equal(result.nodes[0].isFile, true, `${extension}: file anchor`);
        assert.equal(result.nodes[0].type, "File", `${extension}: anchor type`);
        const section: OutlineNode = requireNode(result.nodes, "Extension");
        assert.equal(section.type, "section", `${extension}: section type`);
        assert.equal(section.depth, 3, `${extension}: section depth`);
        assert.equal(section.path, `${path}#Extension`, `${extension}: symbol path`);
    }
});

test("part/chapter/section/subsection/subsubsection/paragraph map to depths 1-7", (): void => {
    const result: OutlineResult = outline("tex/hierarchy.tex");
    assert.equal(result.strategy, "tex");
    assert.equal(result.nodes.length, 1);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.children.length, 1);
    assert.deepEqual(labels(anchor.children), ["Part One"]);
    assert.equal(findNode(result.nodes, "document"), undefined, "the document environment is omitted");
    assert.equal(flatten(result.nodes).some((node: OutlineNode): boolean => node.type === "environment"), false);

    const part: OutlineNode = requireNode(result.nodes, "Part One");
    assert.equal(part.type, "part");
    assert.equal(part.depth, 1);
    assert.equal(part.path, "tex/hierarchy.tex#Part One");
    assertRange(part, HierarchyText, 3, 10);

    const chapter: OutlineNode = requireNode(result.nodes, "Chapter One");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assert.equal(chapter.path, "tex/hierarchy.tex#Part One.Chapter One");
    assert.deepEqual(labels(part.children), ["Chapter One"]);

    const section: OutlineNode = requireNode(result.nodes, "Section One");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assertRange(section, HierarchyText, 5, 10);

    const subsection: OutlineNode = requireNode(result.nodes, "Subsection One");
    assert.equal(subsection.type, "subsection");
    assert.equal(subsection.depth, 4);

    const subsubsection: OutlineNode = requireNode(result.nodes, "Subsubsection One");
    assert.equal(subsubsection.type, "subsection");
    assert.equal(subsubsection.depth, 5);
    assert.equal(subsubsection.path, "tex/hierarchy.tex#Part One.Chapter One.Section One.Subsection One.Subsubsection One");

    const paragraph: OutlineNode = requireNode(result.nodes, "Paragraph One");
    assert.equal(paragraph.type, "paragraph");
    assert.equal(paragraph.depth, 6);
    assert.equal(paragraph.path, "tex/hierarchy.tex#Part One.Chapter One.Section One.Subsection One.Subsubsection One.Paragraph One");
    assertRange(paragraph, HierarchyText, 8, 10);
    const subparagraph: OutlineNode = requireNode(result.nodes, "Subparagraph One");
    assert.equal(subparagraph.type, "paragraph");
    assert.equal(subparagraph.depth, 7);
    assert.equal(subparagraph.path, "tex/hierarchy.tex#Part One.Chapter One.Section One.Subsection One.Subsubsection One.Paragraph One.Subparagraph One");
    assert.deepEqual(labels(paragraph.children), ["Subparagraph One"]);
    assertRange(subparagraph, HierarchyText, 9, 10);
});

test("skipped sectioning levels keep their declared depth under the nearest shallower heading", (): void => {
    const result: OutlineResult = outline("tex/skip.tex");
    const part: OutlineNode = requireNode(result.nodes, "Top");
    const jumpThree: OutlineNode = requireNode(result.nodes, "Jump Three");
    const jumpFive: OutlineNode = requireNode(result.nodes, "Jump Five");
    assert.equal(part.depth, 1);
    assert.equal(jumpThree.depth, 4, "\\subsection is TeX depth 3 plus the anchor level");
    assert.equal(jumpFive.depth, 6, "\\paragraph is TeX depth 5 plus the anchor level");
    assert.deepEqual(labels(part.children), ["Jump Three"]);
    assert.deepEqual(labels(jumpThree.children), ["Jump Five"]);
    assert.equal(jumpThree.type, "subsection");
    assert.equal(jumpFive.type, "paragraph");
    assert.equal(jumpFive.path, "tex/skip.tex#Top.Jump Three.Jump Five");
    assertRange(jumpThree, SkipText, 2, 3);
});

test("nested begin/end environments become environment nodes and document is omitted", (): void => {
    const result: OutlineResult = outline("tex/environments.tex");
    assert.equal(result.strategy, "tex");
    assert.equal(findNode(result.nodes, "document"), undefined);
    assert.deepEqual(labels(result.nodes[0].children), ["figure"]);
    const figure: OutlineNode = requireNode(result.nodes, "figure");
    assert.equal(figure.type, "environment");
    assert.equal(figure.depth, 1);
    assert.equal(figure.path, "tex/environments.tex#figure");
    assert.deepEqual(labels(figure.children), ["center"]);
    const center: OutlineNode = requireNode(figure.children, "center");
    assert.equal(center.type, "environment");
    assert.equal(center.depth, 2);
    assert.equal(center.path, "tex/environments.tex#figure.center");
    assert.equal(findNode(result.nodes, "caption"), undefined, "commands inside an environment are not environment nodes");
    assertRange(figure, EnvironmentsText, 3, 8);
    assertRange(center, EnvironmentsText, 5, 7);
    assert.equal(flatten(result.nodes).filter((node: OutlineNode): boolean => node.type === "environment").length, 2);
});

test("percent comments hide pseudo headings and an escaped percent keeps the rest of the line visible", (): void => {
    const result: OutlineResult = outline("tex/comments.tex");
    assert.equal(findNode(result.nodes, "Commented"), undefined, "comment-only heading must not be emitted");
    assert.equal(findNode(result.nodes, "Trailing Fake"), undefined, "trailing comment heading must not be emitted");
    assert.deepEqual(labels(result.nodes[0].children), ["Real", "Escaped Survives", "After"]);
    const real: OutlineNode = requireNode(result.nodes, "Real");
    const escaped: OutlineNode = requireNode(result.nodes, "Escaped Survives");
    assert.equal(real.type, "section");
    assert.equal(real.depth, 3);
    assert.equal(escaped.type, "section");
    assert.equal(escaped.depth, 3);
    assertRange(real, CommentsText, 2, 2);
    assertRange(escaped, CommentsText, 3, 3);
    assertRange(requireNode(result.nodes, "After"), CommentsText, 4, 4);
});

test("\\verb, verbatim and comment environments are masked from headings", (): void => {
    const result: OutlineResult = outline("tex/verbatim.tex");
    assert.equal(findNode(result.nodes, "InlineFake"), undefined, "\\verb body must not produce a heading");
    assert.equal(findNode(result.nodes, "BlockFake"), undefined, "verbatim body must not produce a heading");
    assert.equal(findNode(result.nodes, "CommentEnvFake"), undefined, "comment env body must not produce a heading");
    assert.equal(findNode(result.nodes, "comment"), undefined, "comment env is fully hidden");
    assert.equal(findNode(result.nodes, "IffalseFake"), undefined, "\\iffalse body must not produce a heading");
    const real: OutlineNode = requireNode(result.nodes, "Real");
    const environment: OutlineNode = requireNode(result.nodes, "verbatim");
    assert.equal(environment.type, "environment");
    assert.equal(environment.depth, 4);
    assert.equal(environment.path, "tex/verbatim.tex#Real.verbatim");
    assert.deepEqual(labels(environment.children), []);
    assert.deepEqual(labels(real.children), ["verbatim"]);
    assertRange(environment, VerbatimText, 3, 5);
    const after: OutlineNode = requireNode(result.nodes, "After");
    assert.equal(after.depth, 3);
    assert.equal(after.path, "tex/verbatim.tex#After");
    assert.deepEqual(labels(result.nodes[0].children), ["Real", "After"]);
});

test("macro definition bodies are hidden and no macro node is fabricated", (): void => {
    const result: OutlineResult = outline("tex/macros.tex");
    assert.equal(findNode(result.nodes, "MacroFake"), undefined, "newcommand body must not produce a heading");
    assert.equal(findNode(result.nodes, "MacroFakeTwo"), undefined, "renewcommand body must not produce a heading");
    assert.equal(findNode(result.nodes, "DefFake"), undefined, "\\def body must not produce a heading");
    assert.equal(findNode(result.nodes, "fake"), undefined, "the macro name is not a node");
    assert.equal(flatten(result.nodes).some((node: OutlineNode): boolean => node.type === "macro"), false);
    assert.deepEqual(labels(result.nodes[0].children), ["Real"]);
});

test("input and include become reference nodes without resolving targets", (): void => {
    const result: OutlineResult = outline("tex/input.tex");
    assert.deepEqual(labels(result.nodes[0].children), ["Before", "After"]);
    const before: OutlineNode = requireNode(result.nodes, "Before");
    assert.deepEqual(labels(before.children), ["chapters/one", "chapters/two"]);
    const input: OutlineNode = requireNode(before.children, "chapters/one");
    const include: OutlineNode = requireNode(before.children, "chapters/two");
    assert.equal(input.type, "reference");
    assert.equal(include.type, "reference");
    assert.equal(input.depth, 4);
    assert.equal(input.path, "tex/input.tex#Before.chapters%2Fone");
    assert.equal(input.detail, "\\input{chapters/one}");
    assert.equal(include.detail, "\\include{chapters/two}");
    assertRange(input, InputText, 2, 2);
    assertRange(include, InputText, 3, 3);
    assert.equal(requireNode(result.nodes, "After").depth, 3);
});

test("starred headings and optional short titles use the long label", (): void => {
    const result: OutlineResult = outline("tex/optional.tex");
    assert.deepEqual(labels(result.nodes[0].children), ["Starred", "Long Title", "Long Bold Title", "Long Label"]);
    assert.equal(findNode(result.nodes, "Short"), undefined, "optional short title must not become the label");
    const starred: OutlineNode = requireNode(result.nodes, "Starred");
    const long: OutlineNode = requireNode(result.nodes, "Long Title");
    const nested: OutlineNode = requireNode(result.nodes, "Long Bold Title");
    const bracketed: OutlineNode = requireNode(result.nodes, "Long Label");
    assert.equal(starred.type, "section");
    assert.equal(starred.depth, 3);
    assert.equal(long.type, "section");
    assert.equal(long.depth, 3);
    assert.equal(nested.type, "section");
    assert.equal(nested.depth, 3);
    assert.equal(bracketed.type, "section");
    assert.equal(bracketed.depth, 3);
    assertRange(starred, OptionalText, 1, 1);
    assertRange(long, OptionalText, 2, 2);
    assertRange(nested, OptionalText, 3, 3);
    assertRange(bracketed, OptionalText, 4, 4);
});

test("empty and comment-only files yield one file anchor with no symbols", (): void => {
    const empty: OutlineResult = outline("tex/empty.tex");
    assert.equal(empty.strategy, "tex");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes.length, 1);
    const emptyAnchor: OutlineNode = empty.nodes[0];
    assert.equal(emptyAnchor.isFile, true);
    assert.equal(emptyAnchor.type, "File");
    assert.equal(emptyAnchor.children.length, 0);
    assert.equal(emptyAnchor.range.startByte, 0n);
    assert.equal(emptyAnchor.range.endByte, 0n);
    assert.equal(emptyAnchor.range.startLine, 1n);
    assert.equal(emptyAnchor.range.endLine, 1n);

    const commented: OutlineResult = outline("tex/comments-only.tex");
    assert.equal(commented.strategy, "tex");
    assert.equal(commented.truncated, false);
    assert.equal(commented.nodes.length, 1);
    const commentedAnchor: OutlineNode = commented.nodes[0];
    assert.equal(commentedAnchor.children.length, 0);
    assert.equal(commentedAnchor.range.startLine, 1n);
    assert.equal(commentedAnchor.range.endLine, 2n);
    assert.equal(commentedAnchor.range.endByte, BigInt(Buffer.byteLength(CommentsOnlyText, "utf8")));
});

test("CRLF line endings keep line numbers and include their terminator bytes", (): void => {
    const result: OutlineResult = outline("tex/crlf.tex");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.nodes[0].range.startLine, 1n);
    assert.equal(result.nodes[0].range.endLine, 3n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(CrlfText, "utf8")));
    const first: OutlineNode = requireNode(result.nodes, "CRLF A");
    const second: OutlineNode = requireNode(result.nodes, "CRLF B");
    assert.equal(first.label, "CRLF A");
    assert.equal(second.label, "CRLF B");
    assert.equal(first.label.includes("\r"), false);
    assertRange(first, CrlfText, 1, 2);
    assertRange(second, CrlfText, 3, 3);
    assert.equal(first.range.endByte - first.range.startByte, 24n);
});

test("UTF-8 BOM is tagged and all byte ranges use raw-file offsets", (): void => {
    const result: OutlineResult = outline("tex/bom.tex");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.strategy, "tex");
    const title: OutlineNode = requireNode(result.nodes, "BOM Title");
    assert.equal(title.depth, 3);
    assert.equal(result.nodes[0].file!.bytes, BigInt(Bom.length));
    assert.equal(result.nodes[0].range.endByte, BigInt(Bom.length));
    assert.equal(title.range.startByte, 3n);
    assert.equal(title.range.endByte, BigInt(Bom.length));
    assert.equal(title.range.endByte - title.range.startByte, BigInt(Buffer.byteLength(BomBody, "utf8")));
});

test("Unicode labels survive and byte ranges are UTF-8 offsets", (): void => {
    const result: OutlineResult = outline("tex/unicode.tex");
    const section: OutlineNode = requireNode(result.nodes, "绪论 🌱");
    const subsection: OutlineNode = requireNode(result.nodes, "Café");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assert.equal(subsection.type, "subsection");
    assert.equal(subsection.depth, 4);
    assert.equal(subsection.path, "tex/unicode.tex#绪论 🌱.Café");
    assertRange(section, UnicodeText, 1, 2);
    assertRange(subsection, UnicodeText, 2, 2);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(UnicodeText, "utf8")));
    assert.equal(result.nodes[0].range.endByte, 41n);
    assert.ok(Buffer.byteLength(UnicodeText, "utf8") > UnicodeText.length);
});

test("maxNodes and maxDepth count the anchor, truncate explicitly and reject zero", (): void => {
    const complete: OutlineResult = outline("tex/budget.tex", { maxNodes: 100, maxDepth: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 5);
    assert.deepEqual(labels(complete.nodes[0].children), ["P"]);

    const two: OutlineResult = outline("tex/budget.tex", { maxNodes: 2 });
    assert.equal(two.truncated, true);
    assert.equal(flatten(two.nodes).length, 2);
    assert.deepEqual(labels(two.nodes[0].children), ["P"]);
    assert.equal(requireNode(two.nodes, "P").children.length, 0);
    assert.equal(findNode(two.nodes, "C"), undefined);

    const one: OutlineResult = outline("tex/budget.tex", { maxNodes: 1 });
    assert.equal(one.truncated, true);
    assert.equal(flatten(one.nodes).length, 1);
    assert.equal(one.nodes[0].children.length, 0);

    const depthTwo: OutlineResult = outline("tex/budget.tex", { maxDepth: 2 });
    assert.equal(depthTwo.truncated, true);
    assert.deepEqual(labels(depthTwo.nodes[0].children), ["P"]);
    assert.deepEqual(labels(requireNode(depthTwo.nodes, "P").children), ["C"]);
    assert.equal(findNode(depthTwo.nodes, "S"), undefined);

    const depthOne: OutlineResult = outline("tex/budget.tex", { maxDepth: 1 });
    assert.equal(depthOne.truncated, true);
    assert.deepEqual(labels(depthOne.nodes[0].children), ["P"]);
    assert.equal(requireNode(depthOne.nodes, "P").children.length, 0);

    expectFilesystemError("invalid_arguments", (): void => {
        outline("tex/budget.tex", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("tex/budget.tex", { maxDepth: 2.5 });
    });
});

test("binary, oversize, missing and escaping TeX paths are refused with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("tex/blob.tex");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("tex/huge.tex");
    });
    expectFilesystemError("not_found", (): void => {
        outline("tex/missing.tex");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.tex");
    });
});

test("path and range are ordered bigints with parent/child containment", (): void => {
    const result: OutlineResult = outline("tex/hierarchy.tex");
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].path, "tex/hierarchy.tex");
    assert.equal(result.nodes[0].range.startByte, 0n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(HierarchyText, "utf8")));
    assertOrderedTree(result.nodes[0]);
    const all: OutlineNode[] = flatten(result.nodes);
    const paths: string[] = all.map((node: OutlineNode): string => node.path);
    assert.equal(new Set<string>(paths).size, paths.length, "symbol paths are unique");
    assert.deepEqual(labels(requireNode(result.nodes, "Subsubsection One").children), ["Paragraph One"]);
    assert.deepEqual(labels(requireNode(result.nodes, "Paragraph One").children), ["Subparagraph One"]);
});

test("environments attach to the enclosing section and do not reparent later headings", (): void => {
    const result: OutlineResult = outline("tex/envmix.tex");
    const section: OutlineNode = requireNode(result.nodes, "S");
    const figure: OutlineNode = requireNode(result.nodes, "figure");
    const subsection: OutlineNode = requireNode(result.nodes, "T");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    assert.deepEqual(labels(section.children), ["figure", "T"]);
    assert.deepEqual(labels(result.nodes[0].children), ["S"]);
    assert.equal(figure.type, "environment");
    assert.equal(figure.depth, 4);
    assert.equal(figure.path, "tex/envmix.tex#S.figure");
    assert.deepEqual(labels(figure.children), []);
    assert.equal(subsection.depth, 4);
    assert.equal(subsection.path, "tex/envmix.tex#S.T");
    assertRange(section, EnvMixText, 1, 5);
    assertRange(figure, EnvMixText, 2, 4);
    assertRange(subsection, EnvMixText, 5, 5);
});

test("subparagraph nests under paragraph at depth 7", (): void => {
    const result: OutlineResult = outline("tex/hierarchy.tex");
    const paragraph: OutlineNode = requireNode(result.nodes, "Paragraph One");
    const subparagraph: OutlineNode = requireNode(result.nodes, "Subparagraph One");
    assert.equal(paragraph.depth, 6);
    assert.equal(subparagraph.depth, 7);
    assert.deepEqual(labels(paragraph.children), ["Subparagraph One"]);
    assert.equal(subparagraph.type, "paragraph");
    assertRange(paragraph, HierarchyText, 8, 10);
    assertRange(subparagraph, HierarchyText, 9, 10);
});

test("an unclosed environment ends at EOF instead of its opener", (): void => {
    const result: OutlineResult = outline("tex/unclosed.tex");
    const figure: OutlineNode = requireNode(result.nodes, "figure");
    assert.equal(figure.type, "environment");
    assert.equal(figure.depth, 4);
    assert.equal(figure.path, "tex/unclosed.tex#Open.figure");
    assertRange(figure, UnclosedText, 2, 3);
});
