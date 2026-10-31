#!/usr/bin/env node
/**
 * CSS / SCSS / Sass outline boundary checks.
 *
 * Fixtures are written to a private temporary directory and removed after the
 * run; no fixture is executed and no third-party parser is involved. Every
 * assertion goes through the public `buildOutline` entry point, so strategy
 * selection, the charset gate, anchor construction, UTF-8 byte ranges and the
 * bounded finalizer are exercised together.
 *
 * The suite separates three kinds of expectation:
 *
 * - guarantees: behavior the stylesheet strategies promise (green assertions);
 * - scope limits: behavior the parsers deliberately do not model, pinned so a
 *   future change must update this file and the report (green, marked
 *   `limitation:` in the description);
 * - known defects: behavior that contradicts CSS itself. A defect is asserted
 *   as the *intended* behavior under `todo`, so the run stays green while the
 *   gap remains visible in the summary and in
 *   `docs/testing/languages/styleReport.md`.
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

const Root: string = mkdtempSync(join(tmpdir(), "amp-style-outline-"));
const RootSpec: SessionRoot = { id: "root.style", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

after((): void => {
    rmSync(Root, { recursive: true, force: true });
});

/**
 * Write one fixture, creating intermediate directories.
 *
 * @param relative - Root-relative POSIX path.
 * @param content - UTF-8 text or raw bytes.
 */
const fixture: (relative: string, content: string | Uint8Array) => void = (relative: string, content: string | Uint8Array): void => {
    const absolute: string = join(Root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
};

/**
 * Run the public builder against the fixture sandbox.
 *
 * @param path - Root-relative POSIX path.
 * @param options - Node/depth bounds.
 * @returns The outline result.
 */
const outline: (path: string, options?: OutlineOptions) => OutlineResult = (path: string, options: OutlineOptions = {}): OutlineResult =>
    buildOutline(Sandbox, path, options);

/**
 * Preorder flattening of an outline tree.
 *
 * @param nodes - Node list.
 * @returns Every node in document order.
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
 *
 * @param nodes - Node list.
 * @returns Labels in the same order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] => nodes.map((node: OutlineNode): string => node.label);

/**
 * First node with one label, depth first.
 *
 * @param nodes - Node list.
 * @param label - Exact label to find.
 * @returns The node, or `undefined`.
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
 *
 * @param nodes - Node list.
 * @param label - Exact label to find.
 * @returns The node.
 */
const requireNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode = (nodes: readonly OutlineNode[], label: string): OutlineNode => {
    const node: OutlineNode | undefined = findNode(nodes, label);
    assert.ok(node !== (void 0), `missing outline node: ${label}`);
    return node!;
};

/**
 * 1-based start byte offset of one line, matching ByteLineIndex semantics.
 *
 * @param text - Decoded source.
 * @param line - 1-based line number.
 * @returns UTF-8 byte offset.
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
 * Half-open byte offsets expected for one line span.
 */
interface ExpectedBytes {
    readonly startByte: bigint;
    readonly endByte: bigint;
}

/**
 * Half-open byte range for an inclusive line span.
 *
 * @param text - Decoded source.
 * @param startLine - 1-based inclusive start line.
 * @param endLine - 1-based inclusive end line.
 * @returns Expected byte offsets.
 */
const expectedBytes: (text: string, startLine: number, endLine: number) => ExpectedBytes = (
    text: string, startLine: number, endLine: number,
): ExpectedBytes => {
    const lines: string[] = text.split("\n");
    const endsWithNewline: boolean = text.endsWith("\n");
    const startByte: bigint = startByteOf(text, startLine);
    const endByte: bigint = endLine >= lines.length && !endsWithNewline ? BigInt(Buffer.byteLength(text, "utf8")) : startByteOf(text, endLine + 1);
    return { startByte, endByte };
};

/**
 * Assert one node's line and byte range.
 *
 * @param node - Node to check.
 * @param text - Fixture text the range refers to.
 * @param startLine - Expected 1-based start line.
 * @param endLine - Expected 1-based inclusive end line.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number,
): void => {
    assert.equal(Number(node.range.startLine), startLine, `startLine of ${node.path}`);
    assert.equal(Number(node.range.endLine), endLine, `endLine of ${node.path}`);
    const expected: ExpectedBytes = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte, `startByte of ${node.path}`);
    assert.equal(node.range.endByte, expected.endByte, `endByte of ${node.path}`);
};

/**
 * Assert one classified domain error.
 *
 * @param code - Expected `FilesystemError.code`.
 * @param action - Throwing call.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code, `expected filesystem error ${code}`);
};

/**
 * CSS fixture: leading block comment, custom properties, a multi-selector rule,
 * an @media block, an @supports block and a pseudo-class rule.
 */
const BaseCss: string = [
    "/* leading block comment with a fake rule {",
    "   .ghost { color: red; }",
    "} */",
    ":root {",
    "    --brand-color: #ff0000;",
    "    --space: 8px;",
    "}",
    "body, .card {",
    "    color: var(--brand-color);",
    '    background-image: url("https://cdn.example.test/a.svg");',
    "}",
    "@media (min-width: 40rem) {",
    "    .card { padding: 1rem; }",
    "}",
    "@supports (display: grid) {",
    "    .grid { display: grid; }",
    "}",
    ".card:hover, .card:focus-visible {",
    "    outline: 2px solid red;",
    "}",
    "",
].join("\n");

/**
 * CSS fixture: braces inside strings and data URLs, plus a nested-rule block.
 */
const GuardCss: string = [
    ".quote-guard {",
    '    content: "}{ } .decoy {";',
    '    background: url("data:image/svg+xml;utf8,<svg>{}</svg>");',
    "}",
    ".nested-guard {",
    "    &:hover { color: red; }",
    '    .inner { content: "}"; }',
    "}",
    ".after-guard {",
    "    color: teal;",
    "}",
    "",
].join("\n");

/**
 * SCSS fixture: `//` and block comments that contain braces and fake selectors.
 */
const CommentsScss: string = [
    "// line comment with { and .fake {",
    "/*",
    " block comment { }",
    "*/",
    ".real {",
    "    color: red; // trailing { comment",
    "}",
    ".decoy-in-string {",
    '    content: "{ not a rule }";',
    "}",
    "",
].join("\n");

/**
 * SCSS fixture: top-level variables, an @mixin, a nested-rule rule, a one-line
 * @include and a scoped variable.
 */
const ThemeScss: string = [
    "$brand: #111;",
    "$radius: 4px !default;",
    "",
    "@mixin button-base($pad: 4px) {",
    "    padding: $pad;",
    "    border-radius: $radius;",
    "}",
    "",
    ".button {",
    "    @include button-base(8px);",
    "    color: $brand;",
    "",
    "    &:hover {",
    "        color: darken($brand, 10%);",
    "    }",
    "",
    "    .icon {",
    "        width: 16px;",
    "    }",
    "}",
    "",
    "@include button-base(2px);",
    "",
    ".card {",
    "    $local: 2px;",
    "    margin: $local;",
    "}",
    "",
].join("\n");

/**
 * Sass fixture: indented syntax with a mixin, nested selectors, `&:hover` and
 * an @media block that keeps its nested rule.
 */
const ThemeSass: string = [
    "$brand: #222",
    "$pad: 8px",
    "",
    "@mixin card-base($radius: 2px)",
    "  border-radius: $radius",
    "  padding: $pad",
    "",
    ".card",
    "  color: $brand",
    "  @include card-base(4px)",
    "",
    "  &:hover",
    "    color: #000",
    "",
    "  .title",
    "    font-size: 1.25rem",
    "",
    "@media (min-width: 40rem)",
    "  .card",
    "    padding: 1rem",
    "",
].join("\n");

/**
 * Comment-only CSS fixture.
 */
const CommentOnlyCss: string = "/* only a comment */\n";

/**
 * CRLF CSS fixture.
 */
const CrlfCss: string = [".alpha {", "    color: red;", "}", ".beta {", "    color: blue;", "}", ""].join("\r\n");

/**
 * BOM-free body of the BOM fixture; the file on disk adds a UTF-8 BOM.
 */
const BomText: string = ".bom { color: red; }\n";

/**
 * CSS fixture with CJK selectors, an ASCII custom property and an emoji string
 * that contains a closing brace.
 */
const UnicodeCss: string = [
    "/* 假注释 { } */",
    ".按钮, .見出し {",
    "    --gap: 8px;",
    '    content: "你好 🚀 }";',
    "}",
    ".after-unicode {",
    "    color: #0f0;",
    "}",
    "",
].join("\n");

/**
 * Five one-line CSS rules, used for node budgeting.
 */
const ManyCss: string = [".a { color: red; }", ".b { color: green; }", ".c { color: blue; }", ".d { color: teal; }", ".e { color: gray; }", ""].join("\n");

/**
 * CSS fixture with a multi-line selector, a wrapped @media header, a top-level
 * @import and a comment inside a selector.
 */
const MultilineCss: string = [
    ".card,",
    ".panel {",
    "    color: red;",
    "}",
    "@media",
    "  (min-width: 40rem) {",
    "    .inside { color: blue; }",
    "}",
    '@import url("reset.css");',
    ".commented /* note */ {",
    "    color: green;",
    "}",
    "",
].join("\n");

/**
 * SCSS fixture: block-form @mixin with a scoped variable, one-line and
 * block-form @include, and a rule with a nested @media and `&` selector.
 */
const BlocksScss: string = [
    "@mixin padded {",
    "    $local: 2px;",
    "    padding: $local;",
    "}",
    "@include padded;",
    "@include padded {",
    "    margin: 0;",
    "}",
    ".host {",
    "    @media (min-width: 30rem) {",
    "        color: red;",
    "    }",
    "    &.is-open {",
    "        color: blue;",
    "    }",
    "}",
    "",
].join("\n");

/**
 * CSS fixture whose only block is never closed.
 */
const UnclosedCss: string = ".open {\n    color: red;\n";

/**
 * CSS fixture whose first rule carries a protocol-relative URL, which the
 * stylesheet strategy must not treat as a `//` comment.
 */
const HttpCss: string = ["a { background: url(//cdn.example.test/x.png); }", "b { color: red; }", "c { color: blue; }", ""].join("\n");

/**
 * CSS fixture with a custom property on the rule's own line.
 */
const OneLineCss: string = [".inline { --gap: 4px; color: red; }", ".after-inline { color: blue; }", ""].join("\n");

/**
 * CSS fixture with a data URL that contains braces and a semicolon.
 */
const DataUrlCss: string = [
    ".icon {",
    "    background: url(data:image/svg+xml;utf8,<svg>{}</svg>);",
    "    color: red;",
    "}",
    ".after-icon { color: blue; }",
    "",
].join("\n");

/**
 * SCSS fixture with a protocol-relative URL in an unquoted `url(...)`, which is
 * a value in Sass rather than a `//` comment.
 */
const UrlScss: string = [
    '$cdn: "https://cdn.example.test";',
    ".badge { background: url(//cdn.example.test/badge.png); }",
    ".after-badge { color: red; }",
    ".with-comment { color: blue; } // trailing { comment",
    "",
].join("\n");

/**
 * CSS fixture whose block comment mentions `url(` without a closing paren.
 */
const CommentUrlCss: string = ["/* url( helper without a closing paren", ".real { color: red; }", "*/", ".after-comment { color: blue; }", ""].join("\n");

/**
 * CSS fixture using CSS nesting, `@layer` and `@keyframes`.
 */
const ModernCss: string = [
    "@layer base {",
    "    .card {",
    "        & .title { color: red; }",
    "        &.is-open { color: blue; }",
    "        --inner: 2px;",
    "    }",
    "}",
    "@keyframes spin {",
    "    from { opacity: 0; }",
    "    to { opacity: 1; }",
    "}",
    "",
].join("\n");

/**
 * CSS fixture with two rules that share one selector.
 */
const DupCss: string = ".dup { color: red; }\n.dup { color: blue; }\n";

/**
 * `.less` fixture; the Sass family owns the Less extension.
 */
const LessText: string = ".less-rule {\n    color: red;\n}\n";

/**
 * Over-long selector used for the label bound.
 */
const LongCss: string = `.${"a".repeat(240)} { color: red; }\n`;

fixture("styles/base.css", BaseCss);
fixture("styles/guard.css", GuardCss);
fixture("styles/comments.scss", CommentsScss);
fixture("styles/theme.scss", ThemeScss);
fixture("styles/theme.sass", ThemeSass);
fixture("styles/empty.css", "");
fixture("styles/empty.scss", "");
fixture("styles/empty.sass", "");
fixture("styles/comment-only.css", CommentOnlyCss);
fixture("styles/crlf.css", CrlfCss);
fixture("styles/unicode.css", UnicodeCss);
fixture("styles/many.css", ManyCss);
fixture("styles/multiline.css", MultilineCss);
fixture("styles/blocks.scss", BlocksScss);
fixture("styles/unclosed.css", UnclosedCss);
fixture("styles/http.css", HttpCss);
fixture("styles/one-line.css", OneLineCss);
fixture("styles/data-url.css", DataUrlCss);
fixture("styles/url.scss", UrlScss);
fixture("styles/comment-url.css", CommentUrlCss);
fixture("styles/modern.css", ModernCss);
fixture("styles/dup.css", DupCss);
fixture("styles/less.less", LessText);
fixture("styles/long.css", LongCss);
const BomBytes: Uint8Array = new Uint8Array(3 + Buffer.byteLength(BomText, "utf8"));
BomBytes.set([0xef, 0xbb, 0xbf], 0);
BomBytes.set(Buffer.from(BomText, "utf8"), 3);
fixture("styles/bom.css", BomBytes);
fixture("styles/blob.css", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("styles/huge.css", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

test("css, scss, sass and less select the css/scss strategies with the code category", (): void => {
    const css: OutlineResult = outline("styles/base.css");
    assert.equal(css.strategy, "css");
    assert.equal(css.language, "css");
    assert.equal(css.category, "code");
    assert.equal(css.target, "file");
    assert.equal(css.charset, "utf-8");
    assert.equal(css.truncated, false);
    assert.match(css.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(css.nodes.length, 1);
    const anchor: OutlineNode = css.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "styles/base.css");
    assert.equal(anchor.label, "base.css");
    assert.equal(anchor.depth, 0);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(BaseCss, "utf8")));
    assert.ok(anchor.file !== (void 0));
    assert.equal(anchor.file!.path, "styles/base.css");
    assert.equal(anchor.file!.fingerprint, css.fingerprint);

    const scss: OutlineResult = outline("styles/theme.scss");
    assert.equal(scss.strategy, "scss");
    assert.equal(scss.language, "scss");
    assert.equal(scss.category, "code");

    const sass: OutlineResult = outline("styles/theme.sass");
    assert.equal(sass.strategy, "scss", "the Sass family keeps one strategy id");
    assert.equal(sass.language, "scss");
    assert.equal(sass.category, "code");

    const less: OutlineResult = outline("styles/less.less");
    assert.equal(less.strategy, "scss");
    assert.equal(less.language, "scss");
});

test("selectors become sections at their brace depth, including at-rule bodies", (): void => {
    const result: OutlineResult = outline("styles/base.css");
    assert.deepEqual(labels(result.nodes[0].children), [
        ":root",
        "body, .card",
        "@media (min-width: 40rem)",
        "@supports (display: grid)",
        ".card:hover, .card:focus-visible",
    ]);

    const root: OutlineNode = requireNode(result.nodes, ":root");
    assert.equal(root.type, "section");
    assert.equal(root.depth, 1);
    assert.equal(root.detail, (void 0));
    assertRange(root, BaseCss, 4, 7);

    const body: OutlineNode = requireNode(result.nodes, "body, .card");
    assert.equal(body.depth, 1);
    assert.deepEqual(body.children, []);
    assertRange(body, BaseCss, 8, 11);

    const media: OutlineNode = requireNode(result.nodes, "@media (min-width: 40rem)");
    assert.equal(media.type, "section");
    assert.equal(media.depth, 1);
    assertRange(media, BaseCss, 12, 14);
    assert.deepEqual(labels(media.children), [".card"]);
    const mediaRule: OutlineNode = requireNode(media.children, ".card");
    assert.equal(mediaRule.type, "section");
    assert.equal(mediaRule.depth, 2);
    assert.deepEqual(mediaRule.children, []);
    assertRange(mediaRule, BaseCss, 13, 13);

    const supports: OutlineNode = requireNode(result.nodes, "@supports (display: grid)");
    assert.equal(supports.depth, 1);
    assertRange(supports, BaseCss, 15, 17);
    assert.deepEqual(labels(supports.children), [".grid"]);
    assertRange(requireNode(supports.children, ".grid"), BaseCss, 16, 16);

    const pseudo: OutlineNode = requireNode(result.nodes, ".card:hover, .card:focus-visible");
    assert.equal(pseudo.depth, 1);
    assertRange(pseudo, BaseCss, 18, 20);

    /**
     * A nested selector is a child section: `&:hover` and `.inner` under
     * `.nested-guard` are outline nodes, not invisible brace depth.
     */
    const guard: OutlineResult = outline("styles/guard.css");
    assert.deepEqual(labels(guard.nodes[0].children), [".quote-guard", ".nested-guard", ".after-guard"]);
    const quote: OutlineNode = requireNode(guard.nodes, ".quote-guard");
    assert.deepEqual(quote.children, []);
    assertRange(quote, GuardCss, 1, 4);
    const nested: OutlineNode = requireNode(guard.nodes, ".nested-guard");
    assert.deepEqual(labels(nested.children), ["&:hover", ".inner"]);
    assertRange(nested, GuardCss, 5, 8);
    const hover: OutlineNode = requireNode(nested.children, "&:hover");
    assert.equal(hover.depth, 2);
    assertRange(hover, GuardCss, 6, 6);
    const inner: OutlineNode = requireNode(nested.children, ".inner");
    assert.equal(inner.depth, 2);
    assertRange(inner, GuardCss, 7, 7);
    const after: OutlineNode = requireNode(guard.nodes, ".after-guard");
    assertRange(after, GuardCss, 9, 11);
    assert.equal(findNode(guard.nodes, ".decoy"), (void 0));
});

test("css custom properties become property children of their rule", (): void => {
    const result: OutlineResult = outline("styles/base.css");
    const root: OutlineNode = requireNode(result.nodes, ":root");
    assert.deepEqual(labels(root.children), ["--brand-color", "--space"]);

    const brand: OutlineNode = requireNode(root.children, "--brand-color");
    assert.equal(brand.type, "property");
    assert.equal(brand.depth, 2);
    assert.equal(brand.detail, "#ff0000");
    assert.equal(brand.path, "styles/base.css#:root.--brand-color");
    assertRange(brand, BaseCss, 5, 5);

    const space: OutlineNode = requireNode(root.children, "--space");
    assert.equal(space.type, "property");
    assert.equal(space.depth, 2);
    assert.equal(space.detail, "8px");
    assert.equal(space.path, "styles/base.css#:root.--space");
    assertRange(space, BaseCss, 6, 6);

    /**
     * A `var(--x)` usage is not a declaration, so the rule that consumes a
     * custom property has no property children of its own.
     */
    const body: OutlineNode = requireNode(result.nodes, "body, .card");
    assert.deepEqual(body.children, []);
});

test("scss variables, @mixin and @include keep their depth and block form", (): void => {
    const result: OutlineResult = outline("styles/theme.scss");
    assert.deepEqual(labels(result.nodes[0].children), ["$brand", "$radius", "@mixin button-base($pad: 4px)", ".button", ".card"]);

    const brand: OutlineNode = requireNode(result.nodes, "$brand");
    assert.equal(brand.type, "property");
    assert.equal(brand.depth, 1);
    assert.equal(brand.detail, "#111");
    assertRange(brand, ThemeScss, 1, 1);

    const radius: OutlineNode = requireNode(result.nodes, "$radius");
    assert.equal(radius.type, "property");
    assert.equal(radius.detail, "4px !default");
    assertRange(radius, ThemeScss, 2, 2);

    const mixin: OutlineNode = requireNode(result.nodes, "@mixin button-base($pad: 4px)");
    assert.equal(mixin.type, "section");
    assert.equal(mixin.depth, 1);
    assert.deepEqual(mixin.children, []);
    assertRange(mixin, ThemeScss, 4, 7);

    /**
     * A one-line `@include` opens no block and is not a symbol, and a plain
     * declaration such as `color: $brand` is not a variable. Nested selectors
     * are children of their rule.
     */
    const button: OutlineNode = requireNode(result.nodes, ".button");
    assert.equal(button.depth, 1);
    assert.deepEqual(labels(button.children), ["&:hover", ".icon"]);
    assertRange(button, ThemeScss, 9, 20);
    const buttonHover: OutlineNode = requireNode(button.children, "&:hover");
    assert.equal(buttonHover.type, "section");
    assert.equal(buttonHover.depth, 2);
    assert.deepEqual(buttonHover.children, []);
    assertRange(buttonHover, ThemeScss, 13, 15);
    assertRange(requireNode(button.children, ".icon"), ThemeScss, 17, 19);
    assert.equal(findNode(result.nodes, "@include button-base(2px)"), (void 0));

    const card: OutlineNode = requireNode(result.nodes, ".card");
    assert.deepEqual(labels(card.children), ["$local"]);
    const local: OutlineNode = requireNode(card.children, "$local");
    assert.equal(local.type, "property");
    assert.equal(local.depth, 2);
    assert.equal(local.detail, "2px");
    assert.equal(local.path, "styles/theme.scss#.card.$local");
    assertRange(local, ThemeScss, 25, 25);

    const blocks: OutlineResult = outline("styles/blocks.scss");
    assert.deepEqual(labels(blocks.nodes[0].children), ["@mixin padded", "@include padded", ".host"]);
    const padded: OutlineNode = requireNode(blocks.nodes, "@mixin padded");
    assert.equal(padded.type, "section");
    assert.deepEqual(labels(padded.children), ["$local"]);
    assertRange(padded, BlocksScss, 1, 4);
    const included: OutlineNode = requireNode(blocks.nodes, "@include padded");
    assert.equal(included.type, "section");
    assert.deepEqual(included.children, []);
    assertRange(included, BlocksScss, 6, 8);
    const host: OutlineNode = requireNode(blocks.nodes, ".host");
    assert.equal(host.depth, 1);
    assert.deepEqual(labels(host.children), ["@media (min-width: 30rem)", "&.is-open"]);
    assertRange(host, BlocksScss, 9, 16);
    assertRange(requireNode(host.children, "@media (min-width: 30rem)"), BlocksScss, 10, 12);
    const nestedSelector: OutlineNode = requireNode(host.children, "&.is-open");
    assert.equal(nestedSelector.depth, 2);
    assert.deepEqual(nestedSelector.children, []);
    assertRange(nestedSelector, BlocksScss, 13, 15);
});

test("sass indented syntax nests selectors, &:hover, mixins and @media by indentation", (): void => {
    const result: OutlineResult = outline("styles/theme.sass");
    assert.deepEqual(labels(result.nodes[0].children), ["$brand", "$pad", "card-base", ".card", "@media (min-width: 40rem)"]);

    const brand: OutlineNode = requireNode(result.nodes, "$brand");
    assert.equal(brand.type, "property");
    assert.equal(brand.depth, 1);
    assert.equal(brand.detail, "#222");
    assertRange(brand, ThemeSass, 1, 1);

    const pad: OutlineNode = requireNode(result.nodes, "$pad");
    assert.equal(pad.detail, "8px");
    assertRange(pad, ThemeSass, 2, 2);

    const mixin: OutlineNode = requireNode(result.nodes, "card-base");
    assert.equal(mixin.type, "macro");
    assert.equal(mixin.depth, 1);
    assert.equal(mixin.detail, "@mixin card-base($radius: 2px)");
    assert.deepEqual(labels(mixin.children), ["border-radius", "padding"]);
    assertRange(mixin, ThemeSass, 4, 6);
    const border: OutlineNode = requireNode(mixin.children, "border-radius");
    assert.equal(border.type, "property");
    assert.equal(border.depth, 2);
    assert.equal(border.detail, "border-radius: $radius");
    assertRange(border, ThemeSass, 5, 5);

    const card: OutlineNode = requireNode(result.nodes, ".card");
    assert.equal(card.type, "section");
    assert.deepEqual(labels(card.children), ["color", "&:hover", ".title"]);
    assertRange(card, ThemeSass, 8, 16);

    const hover: OutlineNode = requireNode(card.children, "&:hover");
    assert.equal(hover.type, "section");
    assert.equal(hover.depth, 2);
    assert.deepEqual(labels(hover.children), ["color"]);
    assertRange(hover, ThemeSass, 12, 13);
    const hoverColor: OutlineNode = requireNode(hover.children, "color");
    assert.equal(hoverColor.depth, 3);
    assert.equal(hoverColor.detail, "color: #000");
    assertRange(hoverColor, ThemeSass, 13, 13);

    const title: OutlineNode = requireNode(card.children, ".title");
    assert.equal(title.depth, 2);
    assert.deepEqual(labels(title.children), ["font-size"]);
    assertRange(title, ThemeSass, 15, 16);

    /**
     * Indented Sass builds the tree from indentation; the nested rule inside
     * @media is a child, matching what the brace scanner now does for .scss.
     */
    const media: OutlineNode = requireNode(result.nodes, "@media (min-width: 40rem)");
    assert.equal(media.depth, 1);
    assert.deepEqual(labels(media.children), [".card"]);
    assertRange(media, ThemeSass, 18, 20);
    const nestedCard: OutlineNode = requireNode(media.children, ".card");
    assert.equal(nestedCard.depth, 2);
    assert.deepEqual(labels(nestedCard.children), ["padding"]);
    assertRange(nestedCard, ThemeSass, 19, 20);
    assert.equal(findNode(result.nodes, "@include card-base(4px)"), (void 0));
});

test("block and line comments never change the stylesheet tree", (): void => {
    const result: OutlineResult = outline("styles/comments.scss");
    assert.deepEqual(labels(result.nodes[0].children), [".real", ".decoy-in-string"]);
    const real: OutlineNode = requireNode(result.nodes, ".real");
    assert.equal(real.depth, 1);
    assertRange(real, CommentsScss, 5, 7);
    const decoy: OutlineNode = requireNode(result.nodes, ".decoy-in-string");
    assert.deepEqual(decoy.children, []);
    assertRange(decoy, CommentsScss, 8, 10);
    assert.equal(findNode(result.nodes, ".fake"), (void 0));
    assert.equal(findNode(result.nodes, ".decoy"), (void 0));

    /**
     * The leading block comment in base.css contains a `{` and a fake rule; it
     * is masked before brace scanning, so the first real selector starts at
     * line 4 and `.ghost` never becomes a node.
     */
    const base: OutlineResult = outline("styles/base.css");
    const root: OutlineNode = requireNode(base.nodes, ":root");
    assert.equal(Number(root.range.startLine), 4);
    assert.equal(findNode(base.nodes, ".ghost"), (void 0));
    assert.equal(labels(base.nodes[0].children).length, 5);
});

test("empty files, comment-only files, CRLF and BOM keep the anchor contract", (): void => {
    const emptyCss: OutlineResult = outline("styles/empty.css");
    assert.equal(emptyCss.strategy, "css");
    assert.equal(emptyCss.language, "css");
    assert.equal(emptyCss.charset, "utf-8");
    assert.equal(emptyCss.truncated, false);
    assert.equal(emptyCss.nodes.length, 1);
    assert.deepEqual(emptyCss.nodes[0].children, []);
    assert.equal(emptyCss.nodes[0].range.startByte, 0n);
    assert.equal(emptyCss.nodes[0].range.endByte, 0n);
    assert.equal(emptyCss.nodes[0].range.startLine, 1n);
    assert.equal(emptyCss.nodes[0].range.endLine, 1n);

    const emptyScss: OutlineResult = outline("styles/empty.scss");
    assert.equal(emptyScss.strategy, "scss");
    assert.equal(emptyScss.language, "scss");
    assert.deepEqual(emptyScss.nodes[0].children, []);

    const emptySass: OutlineResult = outline("styles/empty.sass");
    assert.equal(emptySass.strategy, "scss");
    assert.equal(emptySass.language, "scss");
    assert.deepEqual(emptySass.nodes[0].children, []);

    const commentOnly: OutlineResult = outline("styles/comment-only.css");
    assert.equal(commentOnly.strategy, "css");
    assert.deepEqual(commentOnly.nodes[0].children, []);
    assert.equal(commentOnly.nodes[0].range.endByte, BigInt(Buffer.byteLength(CommentOnlyCss, "utf8")));

    const crlf: OutlineResult = outline("styles/crlf.css");
    assert.equal(crlf.strategy, "css");
    assert.equal(crlf.charset, "utf-8");
    assert.deepEqual(labels(crlf.nodes[0].children), [".alpha", ".beta"]);
    const alpha: OutlineNode = requireNode(crlf.nodes, ".alpha");
    const beta: OutlineNode = requireNode(crlf.nodes, ".beta");
    assertRange(alpha, CrlfCss, 1, 3);
    assertRange(beta, CrlfCss, 4, 6);
    assert.equal(alpha.range.endByte, beta.range.startByte);
    assert.equal(crlf.nodes[0].range.endByte, BigInt(Buffer.byteLength(CrlfCss, "utf8")));

    const bom: OutlineResult = outline("styles/bom.css");
    assert.equal(bom.strategy, "css");
    assert.equal(bom.charset, "utf-8-bom");
    assert.deepEqual(labels(bom.nodes[0].children), [".bom"]);
    const bomRule: OutlineNode = requireNode(bom.nodes, ".bom");
    /**
     * Ranges are raw-file byte offsets: the three BOM bytes shift every symbol
     * by three, so `.bom` starts at byte 3 and the anchor still starts at 0.
     * The rule's line span comes from the decoded text and stays 1..1.
     */
    assert.equal(bomRule.range.startLine, 1n);
    assert.equal(bomRule.range.endLine, 1n);
    assert.equal(bomRule.range.startByte, 3n);
    assert.equal(bomRule.range.endByte, BigInt(BomBytes.length));
    assert.equal(bom.nodes[0].range.startByte, 0n);
    assert.equal(bom.nodes[0].range.endByte, BigInt(BomBytes.length));
    assert.ok(bom.nodes[0].file !== (void 0));
    assert.equal(bom.nodes[0].file!.bytes, BigInt(BomBytes.length));
    assert.equal(bom.nodes[0].range.endByte, bom.nodes[0].file!.bytes);
});

test("unicode selectors, values and emoji strings keep byte-accurate ranges", (): void => {
    const result: OutlineResult = outline("styles/unicode.css");
    assert.equal(result.charset, "utf-8");
    assert.deepEqual(labels(result.nodes[0].children), [".按钮, .見出し", ".after-unicode"]);

    const selector: OutlineNode = requireNode(result.nodes, ".按钮, .見出し");
    assert.equal(selector.type, "section");
    assert.equal(selector.depth, 1);
    assertRange(selector, UnicodeCss, 2, 5);
    assert.ok(selector.range.endByte - selector.range.startByte > BigInt(Buffer.byteLength(".按钮, .見出し {", "utf8")));

    const gap: OutlineNode = requireNode(selector.children, "--gap");
    assert.equal(gap.type, "property");
    assert.equal(gap.depth, 2);
    assert.equal(gap.detail, "8px");
    assertRange(gap, UnicodeCss, 3, 3);

    /**
     * The emoji string contains `}`; masking it keeps the rule open until its
     * real closing brace on line 5, so the next selector starts on line 6.
     */
    const after: OutlineNode = requireNode(result.nodes, ".after-unicode");
    assertRange(after, UnicodeCss, 6, 8);
    assert.equal(selector.range.endLine, 5n);
    assert.equal(findNode(result.nodes, "--gap: 8px"), (void 0));
});

test("multi-line selectors, wrapped at-rule headers and @import keep line numbers", (): void => {
    const result: OutlineResult = outline("styles/multiline.css");
    assert.deepEqual(labels(result.nodes[0].children), [".card, .panel", "@media (min-width: 40rem)", ".commented"]);

    const selector: OutlineNode = requireNode(result.nodes, ".card, .panel");
    assert.equal(selector.type, "section");
    assertRange(selector, MultilineCss, 1, 4);

    const media: OutlineNode = requireNode(result.nodes, "@media (min-width: 40rem)");
    assert.equal(media.type, "section");
    assert.deepEqual(labels(media.children), [".inside"]);
    assertRange(media, MultilineCss, 5, 8);
    const inside: OutlineNode = requireNode(media.children, ".inside");
    assert.equal(inside.depth, 2);
    assertRange(inside, MultilineCss, 7, 7);

    const commented: OutlineNode = requireNode(result.nodes, ".commented");
    assertRange(commented, MultilineCss, 10, 12);
    assert.deepEqual(commented.children, []);

    /**
     * A block-less at-rule ends at its semicolon and produces no symbol, and it
     * must not leak into the next selector label.
     */
    assert.equal(findNode(result.nodes, '@import url("reset.css")'), (void 0));
    const atRules: string[] = labels(result.nodes[0].children).filter((label: string): boolean => label.startsWith("@import"));
    assert.deepEqual(atRules, []);
});

test("an unterminated block keeps its selector and does not throw", (): void => {
    const result: OutlineResult = outline("styles/unclosed.css");
    assert.equal(result.strategy, "css");
    assert.equal(result.truncated, false);
    const open: OutlineNode = requireNode(result.nodes, ".open");
    assert.equal(open.type, "section");
    /**
     * An unterminated block still covers its content: the end line falls back
     * to the last line of the file instead of collapsing to the selector line.
     */
    assertRange(open, UnclosedCss, 1, 2);
    assert.equal(result.nodes[0].range.endLine, 2n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(UnclosedCss, "utf8")));
});

test("maxNodes truncates the shared budget across the anchor and nested nodes", (): void => {
    const complete: OutlineResult = outline("styles/many.css");
    assert.equal(flatten(complete.nodes).length, 6);
    assert.equal(complete.truncated, false);

    const limited: OutlineResult = outline("styles/many.css", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.deepEqual(labels(limited.nodes[0].children), [".a", ".b"]);

    const nested: OutlineResult = outline("styles/base.css", { maxNodes: 3 });
    assert.equal(nested.truncated, true);
    assert.equal(flatten(nested.nodes).length, 3);
    assert.deepEqual(labels(nested.nodes[0].children), [":root"]);
    assert.deepEqual(labels(requireNode(nested.nodes, ":root").children), ["--brand-color"]);

    const exact: OutlineResult = outline("styles/base.css", { maxNodes: 10 });
    assert.equal(exact.truncated, false);
    assert.equal(flatten(exact.nodes).length, 10);

    const oneShort: OutlineResult = outline("styles/base.css", { maxNodes: 9 });
    assert.equal(oneShort.truncated, true);
    assert.equal(flatten(oneShort.nodes).length, 9);
    assert.equal(findNode(oneShort.nodes, ".card:hover, .card:focus-visible"), (void 0));

    assert.equal(outline("styles/many.css", { maxNodes: 100000 }).truncated, false);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("styles/many.css", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("styles/many.css", { maxNodes: 1.5 });
    });
});

test("maxDepth drops symbols past the ceiling and reports truncation", (): void => {
    const shallow: OutlineResult = outline("styles/base.css", { maxDepth: 1 });
    assert.equal(shallow.truncated, true);
    assert.equal(flatten(shallow.nodes).length, 6);
    assert.deepEqual(requireNode(shallow.nodes, ":root").children, []);
    assert.deepEqual(requireNode(shallow.nodes, "@media (min-width: 40rem)").children, []);

    const two: OutlineResult = outline("styles/base.css", { maxDepth: 2 });
    assert.equal(two.truncated, false);
    assert.equal(flatten(two.nodes).length, 10);
    assert.deepEqual(labels(requireNode(two.nodes, ":root").children), ["--brand-color", "--space"]);
    assert.deepEqual(labels(requireNode(two.nodes, "@supports (display: grid)").children), [".grid"]);

    const three: OutlineResult = outline("styles/base.css", { maxDepth: 3 });
    assert.equal(three.truncated, false);
    assert.equal(flatten(three.nodes).length, 10);

    const sassTwo: OutlineResult = outline("styles/theme.sass", { maxDepth: 2 });
    assert.equal(sassTwo.truncated, true);
    assert.equal(flatten(sassTwo.nodes).length, 12);
    assert.deepEqual(requireNode(sassTwo.nodes, "&:hover").children, []);
    const media: OutlineNode = requireNode(sassTwo.nodes, "@media (min-width: 40rem)");
    assert.deepEqual(requireNode(media.children, ".card").children, []);
    assert.deepEqual(labels(requireNode(sassTwo.nodes, "card-base").children), ["border-radius", "padding"]);

    const sassThree: OutlineResult = outline("styles/theme.sass", { maxDepth: 3 });
    assert.equal(sassThree.truncated, false);
    assert.equal(flatten(sassThree.nodes).length, 15);
    const hoverColor: OutlineNode = requireNode(requireNode(sassThree.nodes, "&:hover").children, "color");
    assert.equal(hoverColor.type, "property");
    assert.equal(hoverColor.depth, 3);
    assert.deepEqual(hoverColor.children, []);

    expectFilesystemError("invalid_arguments", (): void => {
        outline("styles/theme.sass", { maxDepth: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("styles/theme.sass", { maxDepth: -3 });
    });
});

test("symbol paths and bigint ranges stay ordered, nested and non-overlapping", (): void => {
    const result: OutlineResult = outline("styles/base.css");
    const all: OutlineNode[] = flatten(result.nodes);
    assert.equal(all.length, 10);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.path, "styles/base.css");
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(BaseCss, "utf8")));
    assert.equal(anchor.range.startLine, 1n);
    assert.equal(anchor.range.endLine, 20n);

    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assert.equal(typeof(node.range.startByte), "bigint", `startByte type of ${node.path}`);
        assert.equal(typeof(node.range.endByte), "bigint", `endByte type of ${node.path}`);
        assert.equal(typeof(node.range.startLine), "bigint", `startLine type of ${node.path}`);
        assert.equal(typeof(node.range.endLine), "bigint", `endLine type of ${node.path}`);
        assert.ok(node.range.startByte <= node.range.endByte, `ordered bytes of ${node.path}`);
        assert.ok(node.range.startLine <= node.range.endLine, `ordered lines of ${node.path}`);
        assert.equal(typeof(node.path), "string");
        assert.ok(node.path.startsWith("styles/base.css"), `anchored path of ${node.path}`);
    }

    const root: OutlineNode = requireNode(result.nodes, ":root");
    const brand: OutlineNode = requireNode(root.children, "--brand-color");
    assert.equal(root.path, "styles/base.css#:root");
    assert.equal(brand.path, "styles/base.css#:root.--brand-color");

    const top: readonly OutlineNode[] = result.nodes[0].children;
    for (let index: number = 1; index < top.length; index += 1) {
        assert.equal(top[index - 1].range.endByte, top[index].range.startByte, "top-level ranges must tile the file");
        assert.ok(top[index - 1].range.startLine <= top[index].range.startLine);
    }

    for (let index: number = 0; index < root.children.length; index += 1) {
        const child: OutlineNode = root.children[index];
        assert.ok(child.range.startByte >= root.range.startByte && child.range.endByte <= root.range.endByte, "child inside parent bytes");
        assert.ok(child.range.startLine >= root.range.startLine && child.range.endLine <= root.range.endLine, "child inside parent lines");
        assert.ok(child.depth > root.depth, "child deeper than parent");
        if (index > 0) {
            assert.equal(root.children[index - 1].range.endByte, child.range.startByte, "child ranges must tile");
        }
    }

    let previousLine: bigint = 0n;
    for (let index: number = 0; index < all.length; index += 1) {
        assert.ok(all[index].range.startLine >= previousLine, `preorder line order at ${all[index].path}`);
        previousLine = all[index].range.startLine;
    }

    const pseudo: OutlineNode = requireNode(result.nodes, ".card:hover, .card:focus-visible");
    assert.equal(pseudo.path, "styles/base.css#.card:hover, .card:focus-visible");
    const media: OutlineNode = requireNode(result.nodes, "@media (min-width: 40rem)");
    const mediaRule: OutlineNode = requireNode(media.children, ".card");
    assert.equal(mediaRule.path, "styles/base.css#@media (min-width: 40rem)..card");

    const sass: OutlineResult = outline("styles/theme.sass");
    const sassCard: OutlineNode = requireNode(sass.nodes, ".card");
    const sassTitle: OutlineNode = requireNode(sassCard.children, ".title");
    const sassHover: OutlineNode = requireNode(sassCard.children, "&:hover");
    assert.equal(sassTitle.path, "styles/theme.sass#.card..title");
    assert.equal(sassHover.path, "styles/theme.sass#.card.&:hover");

    /**
     * Duplicate sibling labels receive stable path disambiguators while their
     * source ranges remain independently addressable.
     */
    const dup: OutlineResult = outline("styles/dup.css");
    const duplicates: readonly OutlineNode[] = dup.nodes[0].children;
    assert.equal(duplicates.length, 2);
    assert.deepEqual(labels(duplicates), [".dup", ".dup"]);
    assert.notEqual(duplicates[0].path, duplicates[1].path);
    assert.notEqual(duplicates[0].range.startByte, duplicates[1].range.startByte);
});

test("labels are cut at 200 characters without flipping truncated", (): void => {
    const result: OutlineResult = outline("styles/long.css");
    assert.equal(result.truncated, false);
    const rule: OutlineNode = result.nodes[0].children[0];
    assert.equal(rule.label.length, 200);
    assert.ok(rule.label.startsWith(".aaaa"));
    assert.ok(rule.path.length < 220);
});

test("binary, oversized, missing and escaping paths are refused with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("styles/blob.css");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("styles/huge.css");
    });
    expectFilesystemError("not_found", (): void => {
        outline("styles/missing.css");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.css");
    });
});

/**
 * Regression: `.css` has no `//` comment. An unquoted protocol-relative URL is
 * value text, so the rule's closing brace and every rule after it must survive.
 */
test("an unquoted url(//host) does not hide later css rules", (): void => {
    const result: OutlineResult = outline("styles/http.css");
    assert.equal(result.strategy, "css");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["a", "b", "c"]);
    assertRange(requireNode(result.nodes, "a"), HttpCss, 1, 1);
    assertRange(requireNode(result.nodes, "b"), HttpCss, 2, 2);
    assertRange(requireNode(result.nodes, "c"), HttpCss, 3, 3);
});

test("a url(...) token is data for both flavours", (): void => {
    const css: OutlineResult = outline("styles/data-url.css");
    assert.deepEqual(labels(css.nodes[0].children), [".icon", ".after-icon"]);
    const icon: OutlineNode = requireNode(css.nodes, ".icon");
    assert.deepEqual(icon.children, []);
    assertRange(icon, DataUrlCss, 1, 4);
    assertRange(requireNode(css.nodes, ".after-icon"), DataUrlCss, 5, 5);

    const scss: OutlineResult = outline("styles/url.scss");
    assert.equal(scss.strategy, "scss");
    assert.deepEqual(labels(scss.nodes[0].children), ["$cdn", ".badge", ".after-badge", ".with-comment"]);
    const cdn: OutlineNode = requireNode(scss.nodes, "$cdn");
    assert.equal(cdn.type, "property");
    assert.equal(cdn.detail, '"https://cdn.example.test"');
    assertRange(cdn, UrlScss, 1, 1);
    assertRange(requireNode(scss.nodes, ".badge"), UrlScss, 2, 2);
    assertRange(requireNode(scss.nodes, ".after-badge"), UrlScss, 3, 3);
    assertRange(requireNode(scss.nodes, ".with-comment"), UrlScss, 4, 4);

    /**
     * A block comment may mention `url(` without a closing paren. The comment
     * is masked as a comment, so it must not swallow the rule after it.
     */
    const commented: OutlineResult = outline("styles/comment-url.css");
    assert.deepEqual(labels(commented.nodes[0].children), [".after-comment"]);
    assertRange(requireNode(commented.nodes, ".after-comment"), CommentUrlCss, 4, 4);
    assert.equal(findNode(commented.nodes, ".real"), (void 0));
});

test("a custom property on the rule's own line is a child", (): void => {
    const result: OutlineResult = outline("styles/one-line.css");
    assert.deepEqual(labels(result.nodes[0].children), [".inline", ".after-inline"]);
    const inline: OutlineNode = requireNode(result.nodes, ".inline");
    assert.deepEqual(labels(inline.children), ["--gap"]);
    const gap: OutlineNode = requireNode(inline.children, "--gap");
    assert.equal(gap.type, "property");
    assert.equal(gap.depth, 2);
    assert.equal(gap.detail, "4px");
    assertRange(gap, OneLineCss, 1, 1);
    assertRange(inline, OneLineCss, 1, 1);
    assertRange(requireNode(result.nodes, ".after-inline"), OneLineCss, 2, 2);
});

test("css nesting, @layer and @keyframes nest by brace depth", (): void => {
    const result: OutlineResult = outline("styles/modern.css");
    assert.deepEqual(labels(result.nodes[0].children), ["@layer base", "@keyframes spin"]);
    const layer: OutlineNode = requireNode(result.nodes, "@layer base");
    assert.equal(layer.depth, 1);
    assert.deepEqual(labels(layer.children), [".card"]);
    assertRange(layer, ModernCss, 1, 7);
    const card: OutlineNode = requireNode(layer.children, ".card");
    assert.equal(card.depth, 2);
    assert.deepEqual(labels(card.children), ["& .title", "&.is-open", "--inner"]);
    assertRange(card, ModernCss, 2, 6);
    const nestedTitle: OutlineNode = requireNode(card.children, "& .title");
    assert.equal(nestedTitle.type, "section");
    assert.equal(nestedTitle.depth, 3);
    assertRange(nestedTitle, ModernCss, 3, 3);
    const inner: OutlineNode = requireNode(card.children, "--inner");
    assert.equal(inner.type, "property");
    assert.equal(inner.depth, 3);
    assert.equal(inner.detail, "2px");
    assertRange(inner, ModernCss, 5, 5);
    const keyframes: OutlineNode = requireNode(result.nodes, "@keyframes spin");
    assert.equal(keyframes.type, "section");
    assert.deepEqual(labels(keyframes.children), ["from", "to"]);
    assertRange(keyframes, ModernCss, 8, 11);
    assertRange(requireNode(keyframes.children, "from"), ModernCss, 9, 9);
    assertRange(requireNode(keyframes.children, "to"), ModernCss, 10, 10);
});
