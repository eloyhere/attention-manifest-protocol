#!/usr/bin/env node
/**
 * Vue single-file component outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; fixture source is never executed. Assertions go through the public
 * `buildOutline` entry point, so sandbox resolution, the byte ceiling, charset
 * detection, strategy selection, line-to-byte mapping and truncation are
 * exercised together with `parseVue`.
 *
 * The file has three parts:
 *
 * 1. contract checks for the documented Vue behavior;
 * 2. a range/invariant sweep over every fixture that also asserts each node
 *    carries a `sha256:` fingerprint;
 * 3. regression checks for previously reported Vue boundary defects.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { ByteLineIndex } from "../src/syntax/byteIndex.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline, OutlineStrategies, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";
import { rawTextDigest } from "../src/fingerprint/raw.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-vue-outline-"));
const RootSpec: SessionRoot = { id: "root.vue", path: Root, writable: true, exclude: [] };
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
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] => nodes.map((node: OutlineNode): string => node.label);

/**
 * Block labels under the file anchor.
 */
const blockLabels: (result: OutlineResult) => string[] = (result: OutlineResult): string[] => labels(result.nodes[0].children);

/**
 * Block nodes under the file anchor.
 */
const blocksOf: (result: OutlineResult) => readonly OutlineNode[] = (result: OutlineResult): readonly OutlineNode[] => result.nodes[0].children;

/**
 * Start offset of each logical line, using `\n` as the only separator.
 */
const lineStartsOf: (text: string) => number[] = (text: string): number[] => {
    const starts: number[] = [];
    if (text.length > 0) {
        starts.push(0);
        for (let index: number = 0; index < text.length; index += 1) {
            if (text.charCodeAt(index) === 10 && index + 1 < text.length) {
                starts.push(index + 1);
            }
        }
    }
    return starts;
};

/**
 * UTF-8 byte offset where a 1-based line begins; past EOF it is the file end.
 */
const startByteOfLine: (text: string, line: number) => bigint = (text: string, line: number): bigint => {
    if (line <= 1) {
        return 0n;
    }
    const starts: number[] = lineStartsOf(text);
    const offset: number = line > starts.length ? text.length : starts[line - 1];
    return BigInt(Buffer.byteLength(text.slice(0, offset), "utf8"));
};

/**
 * Expected byte/line range for an inclusive line span over decoded text.
 */
const expectedBytes: (text: string, startLine: number, endLine: number) => { readonly startByte: bigint; readonly endByte: bigint; } = (
    text: string, startLine: number, endLine: number,
): { readonly startByte: bigint; readonly endByte: bigint; } => ({
    startByte: startByteOfLine(text, startLine),
    endByte: startByteOfLine(text, endLine + 1),
});

/**
 * Assert one node's line and byte range against the decoded fixture text.
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
 * Walk a tree asserting bigint range fields and their ordering.
 *
 * Parent containment is deliberately not asserted here: an outline parent is a
 * semantic container. A template heading such as `<h1>` owns only its own line,
 * so an `h2` nested under it by rank sits after the parent's byte range.
 */
const assertRanges: (nodes: readonly OutlineNode[]) => void = (nodes: readonly OutlineNode[]): void => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: OutlineNode = nodes[index];
        assert.equal(typeof(node.range.startByte), "bigint", `${node.label}: startByte type`);
        assert.equal(typeof(node.range.endByte), "bigint", `${node.label}: endByte type`);
        assert.equal(typeof(node.range.startLine), "bigint", `${node.label}: startLine type`);
        assert.equal(typeof(node.range.endLine), "bigint", `${node.label}: endLine type`);
        assert.ok(node.range.startByte >= 0n, `${node.label}: negative startByte`);
        assert.ok(node.range.endByte >= node.range.startByte, `${node.label}: endByte before startByte`);
        assert.ok(node.range.startLine >= 1n, `${node.label}: startLine below 1`);
        assert.ok(node.range.endLine >= node.range.startLine, `${node.label}: endLine before startLine`);
        assertRanges(node.children);
    }
};

/**
 * Assert that a block-like parent byte/line range contains one child range.
 */
const assertContains: (parent: OutlineNode, child: OutlineNode) => void = (parent: OutlineNode, child: OutlineNode): void => {
    assert.ok(child.range.startLine >= parent.range.startLine, `${child.label}: line start outside ${parent.label}`);
    assert.ok(child.range.endLine <= parent.range.endLine, `${child.label}: line end outside ${parent.label}`);
    assert.ok(child.range.startByte >= parent.range.startByte, `${child.label}: byte start outside ${parent.label}`);
    assert.ok(child.range.endByte <= parent.range.endByte, `${child.label}: byte end outside ${parent.label}`);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Full three-block SFC: template heading and section, `script setup lang="ts"`
 * declarations and one scoped style rule.
 */
const BasicText: string = [
    "<template>",
    "  <h1>Hello</h1>",
    '  <section id="intro">',
    "    <h2>Intro</h2>",
    "  </section>",
    "</template>",
    '<script setup lang="ts">',
    "const count = 1;",
    "function increment() {}",
    "</script>",
    "<style scoped>",
    ".a { color: red; }",
    "</style>",
    "",
].join("\n");

/**
 * Template containing every heading level, an `id` section and an
 * `aria-label` article; `h3` under the article proves declared depth is kept.
 */
const HeadingsText: string = [
    "<template>",
    "  <h1>Level One</h1>",
    "  <h2>Level Two</h2>",
    "  <h3>Level Three</h3>",
    "  <h4>Level Four</h4>",
    "  <h5>Level Five</h5>",
    "  <h6>Level Six</h6>",
    '  <section id="sec">',
    "    <h2>Sec Child</h2>",
    "  </section>",
    '  <article aria-label="Panel">',
    "    <h3>Panel Child</h3>",
    "  </article>",
    '  <section id="empty"></section>',
    "</template>",
    "",
].join("\n");

/**
 * Options API script with a component `name`, a constant, an exported function
 * and a class.
 */
const NamedText: string = [
    "<script>",
    "export default {",
    '  name: "MyWidget",',
    "  components: {},",
    "};",
    'const VERSION = "1.0.0";',
    "export function helper(value) {",
    "  return value;",
    "}",
    "class Store {}",
    "</script>",
    "",
].join("\n");

/**
 * Seven top-level blocks, including duplicate templates and both style
 * attribute forms; the nested `.z` SCSS rule stays under `.y`.
 */
const MultiText: string = [
    "<template><h1>First</h1></template>",
    "<template>",
    "  <h2>Second</h2>",
    "</template>",
    "<script>",
    "const a = 1;",
    "</script>",
    "<script setup>",
    "const b = 2;",
    "</script>",
    "<style>",
    ".x { color: blue; }",
    "</style>",
    '<style lang="scss">',
    ".y { .z { color: red; } }",
    "</style>",
    "<style scoped>",
    ".w { color: green; }",
    "</style>",
    "",
].join("\n");

/**
 * Three single-line blocks; every block and its children share one line.
 */
const InlineText: string = [
    '<template><section id="inline"><h2>Solo</h2></section></template>',
    "<script setup>let active = true;</script>",
    "<style scoped>.on { color: green; }</style>",
    "",
].join("\n");

/**
 * Self-closing and void template elements around two headings; a self-closing
 * `<section />` must not be emitted.
 */
const SelfCloseText: string = [
    "<template>",
    "  <h2>Before</h2>",
    '  <img src="/logo.png" alt="logo" />',
    "  <br>",
    '  <input value="a" />',
    '  <section id="solo" />',
    "  <h2>After</h2>",
    "</template>",
    "",
].join("\n");

/**
 * A self-closing `<template />` followed by a real script block.
 */
const SelfCloseBlockText: string = ["<template />", "<script>const x = 1;</script>", ""].join("\n");

/**
 * Three empty blocks.
 */
const EmptyBlocksText: string = ["<template></template>", "<script></script>", "<style></style>", ""].join("\n");

/**
 * HTML comments inside the template; the hidden heading and section must not
 * be emitted and the script comment must not hide its declaration.
 */
const CommentsText: string = [
    "<template>",
    "  <!-- <h2>Hidden heading</h2> -->",
    "  <h2>Visible</h2>",
    '  <!-- <section id="hidden-section"></section> -->',
    "</template>",
    "<script>",
    "  // a comment mentioning <style> and <h1> tags",
    "  const real = 1;",
    "</script>",
    "",
].join("\n");

/**
 * Pseudo `<style>`/`<script>` text inside a template attribute, an escaped
 * `<pre>` sample and a raw `<script>` element; only the three real blocks and
 * one real heading may appear.
 */
const DecoyText: string = [
    "<template>",
    "  <div data-tip=\"<style lang='scss'>.fake { }</style>\">",
    "    <pre>&lt;script&gt;const fake = 1;&lt;/script&gt;</pre>",
    "    <code><script>const raw = 1;</script></code>",
    "  </div>",
    "  <h2>Real Heading</h2>",
    "</template>",
    '<script setup lang="ts">',
    "const real = 1;",
    "</script>",
    "<style scoped>",
    ".real { color: teal; }",
    "</style>",
    "",
].join("\n");

/**
 * A Vue file without a template block.
 */
const NoTemplateText: string = [
    '<script setup lang="ts">',
    'import { ref } from "vue";',
    "const count = ref(0);",
    "function bump() { count.value += 1; }",
    "</script>",
    "<style scoped>",
    ".count { font-weight: bold; }",
    "</style>",
    "",
].join("\n");

/**
 * CRLF fixture: every line ends with `\r\n`, including the last one.
 */
const CrlfText: string = ["<template>", "  <h1>CRLF</h1>", "</template>", "<script>", "const value = 1;", "</script>", ""].join("\r\n");

/**
 * BOM fixture body; the BOM bytes are prepended separately.
 */
const BomText: string = ["<template>", "  <h1>BOM</h1>", "</template>", ""].join("\n");

/**
 * UTF-8 fixture whose labels and string values are CJK/emoji; the script also
 * declares a Unicode-named function.
 */
const UnicodeText: string = [
    "<template>",
    "  <h1>标题 · 見出し</h1>",
    '  <section id="章节一">',
    "    <h2>子标题 🚀</h2>",
    "  </section>",
    "</template>",
    "<script setup>",
    'const greeting = "你好 🌏";',
    "function 问候() {}",
    "</script>",
    "",
].join("\n");

/**
 * Labels containing `%`, `#` and `/`, which the symbol path must escape.
 */
const EscapeText: string = ["<template>", "  <h1>100% #done</h1>", '  <section id="a/b">', "    <h2>C# Guide</h2>", "  </section>", "</template>", ""].join(
    "\n",
);

/**
 * Opening tags spread over several lines, which moves the inner text start line
 * away from the block start line.
 */
const MultiLineTagText: string = [
    "<template",
    '  lang="html"',
    ">",
    "  <h1>Shifted</h1>",
    "</template>",
    "<script",
    "  setup",
    '  lang="ts"',
    ">",
    "const shifted = 1;",
    "</script>",
    "",
].join("\n");

/**
 * An SFC-level HTML comment that mentions a script block before the real
 * template.
 */
const TopCommentText: string = ["<!-- <script>const fake = 1;</script> -->", "<template>", "  <h1>Real</h1>", "</template>", ""].join("\n");

/**
 * A script string that contains a literal `</script>`.
 */
const ScriptCloseText: string = [
    "<script>",
    'const marker = "</script>";',
    "const after = 1;",
    "</script>",
    "<style>",
    ".after { color: red; }",
    "</style>",
    "",
].join("\n");

/**
 * A nested function and constant inside a function body, plus a component name.
 */
const NestedText: string = [
    "<script>",
    "export default {",
    '  name: "Nested",',
    "};",
    "function outer() {",
    "  function inner() {}",
    "  const local = 1;",
    "}",
    "</script>",
    "",
].join("\n");

/**
 * Attribute values that merely contain the words `setup` and `scoped`.
 */
const ModifierAttrText: string = [
    '<script data-mode="setup">',
    "const value = 1;",
    "</script>",
    '<style data-note="scoped">',
    ".v { color: red; }",
    "</style>",
    "",
].join("\n");

fixture("components/Basic.vue", BasicText);
fixture("components/Headings.vue", HeadingsText);
fixture("components/Named.vue", NamedText);
fixture("components/Multi.vue", MultiText);
fixture("components/Inline.vue", InlineText);
fixture("components/SelfClose.vue", SelfCloseText);
fixture("components/SelfCloseBlock.vue", SelfCloseBlockText);
fixture("components/EmptyBlocks.vue", EmptyBlocksText);
fixture("components/Comments.vue", CommentsText);
fixture("components/Decoy.vue", DecoyText);
fixture("components/NoTemplate.vue", NoTemplateText);
fixture("components/Empty.vue", "");
fixture("components/Crlf.vue", CrlfText);
fixture("components/Unicode.vue", UnicodeText);
fixture("components/Escape.vue", EscapeText);
fixture("components/MultiLineTag.vue", MultiLineTagText);
fixture("components/TopComment.vue", TopCommentText);
fixture("components/ScriptClose.vue", ScriptCloseText);
fixture("components/Nested.vue", NestedText);
fixture("components/ModifierAttr.vue", ModifierAttrText);
const RegexAndNameText: string = [
    "<script>",
    '// name: "CommentDecoy"',
    'export default { name: "RealWidget" };',
    "const pattern = /{/;",
    "function afterRegex() {",
    "  return /}/.test('}');",
    "}",
    "const tail = 1;",
    "</script>",
    "",
].join("\n");
fixture("components/RegexAndName.vue", RegexAndNameText);
const BomBytes: Uint8Array = new Uint8Array(3 + Buffer.byteLength(BomText, "utf8"));
BomBytes.set([0xef, 0xbb, 0xbf], 0);
BomBytes.set(Buffer.from(BomText, "utf8"), 3);
fixture("components/Bom.vue", BomBytes);
const BinaryBytes: Uint8Array = new Uint8Array(24);
BinaryBytes.set([0x3c, 0x21, 0x2d, 0x2d], 0);
fixture("components/Binary.vue", BinaryBytes);
fixture("components/Huge.vue", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

/**
 * Every fixture that must resolve to a Vue outline; used by the range sweep.
 */
const VueFixtures: readonly string[] = [
    "components/Basic.vue",
    "components/Headings.vue",
    "components/Named.vue",
    "components/Multi.vue",
    "components/Inline.vue",
    "components/SelfClose.vue",
    "components/SelfCloseBlock.vue",
    "components/EmptyBlocks.vue",
    "components/Comments.vue",
    "components/Decoy.vue",
    "components/NoTemplate.vue",
    "components/Empty.vue",
    "components/Crlf.vue",
    "components/Bom.vue",
    "components/Unicode.vue",
    "components/Escape.vue",
    "components/MultiLineTag.vue",
    "components/TopComment.vue",
    "components/ScriptClose.vue",
    "components/Nested.vue",
    "components/ModifierAttr.vue",
    "components/RegexAndName.vue",
];

test("a three-block Vue SFC exposes template, script setup and scoped style blocks", (): void => {
    const result: OutlineResult = outline("components/Basic.vue");
    assert.equal(result.strategy, "vue");
    assert.equal(result.category, "code");
    assert.equal(result.language, "vue");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.path, "components/Basic.vue");
    const strategyIds: string[] = OutlineStrategies.map((strategy: { readonly id: string; }): string => strategy.id);
    assert.ok(strategyIds.includes("vue"));
    assert.ok(strategyIds.indexOf("vue") < strategyIds.indexOf("plainText"));
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(result.nodes.length, 1);
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "components/Basic.vue");
    assert.equal(anchor.label, "Basic.vue");
    assert.equal(anchor.depth, 0);
    assert.ok(anchor.file !== (void 0));
    assert.equal(anchor.file!.path, "components/Basic.vue");
    assert.equal(anchor.file!.fingerprint, result.fingerprint);
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(BasicText, "utf8")));
    assertRange(anchor, BasicText, 1, 13);
    assert.ok(Object.isFrozen(result.nodes));
    assert.ok(Object.isFrozen(anchor));
    assert.ok(Object.isFrozen(anchor.children));
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script (setup, ts)", "style (scoped)"]);
    const template: OutlineNode = blocks[0];
    assert.equal(template.type, "section");
    assert.equal(template.depth, 1);
    assert.equal(template.detail, "template");
    assert.equal(template.path, "components/Basic.vue#template");
    assertRange(template, BasicText, 1, 6);
    const script: OutlineNode = blocks[1];
    assert.equal(script.type, "section");
    assert.equal(script.depth, 1);
    assert.equal(script.detail, "script");
    assert.equal(script.path, "components/Basic.vue#script (setup, ts)");
    assertRange(script, BasicText, 7, 10);
    const style: OutlineNode = blocks[2];
    assert.equal(style.type, "section");
    assert.equal(style.depth, 1);
    assert.equal(style.detail, "style");
    assert.equal(style.path, "components/Basic.vue#style (scoped)");
    assertRange(style, BasicText, 11, 13);
    assert.deepEqual(labels(template.children), ["Hello", "intro"]);
    const hello: OutlineNode = template.children[0];
    assert.equal(hello.type, "heading");
    assert.equal(hello.depth, 2);
    assert.equal(hello.path, "components/Basic.vue#template.Hello");
    assertRange(hello, BasicText, 2, 2);
    const intro: OutlineNode = template.children[1];
    assert.equal(intro.type, "section");
    assert.equal(intro.depth, 2);
    assert.equal(intro.detail, "section");
    assert.equal(intro.path, "components/Basic.vue#template.intro");
    assertRange(intro, BasicText, 3, 5);
    assert.deepEqual(labels(intro.children), ["Intro"]);
    assert.equal(intro.children[0].type, "heading");
    assert.equal(intro.children[0].depth, 4);
    assertRange(intro.children[0], BasicText, 4, 4);
    assertContains(template, hello);
    assertContains(template, intro);
    assertContains(intro, intro.children[0]);
    assert.deepEqual(labels(script.children), ["count", "increment"]);
    assert.equal(script.children[0].type, "constant");
    assert.equal(script.children[0].detail, "script declaration");
    assert.equal(script.children[0].depth, 2);
    assert.equal(script.children[1].type, "function");
    assert.equal(script.children[1].detail, "script declaration");
    assert.equal(script.children[1].path, "components/Basic.vue#script (setup, ts).increment");
    assert.deepEqual(labels(style.children), [".a"]);
    const rule: OutlineNode = style.children[0];
    assert.equal(rule.type, "section");
    assert.equal(rule.depth, 2);
    assert.equal(rule.children.length, 0);
    assertRange(rule, BasicText, 12, 12);
    const basicIndex: ByteLineIndex = new ByteLineIndex(BasicText);
    assert.equal(outlineNodeFingerprint(template), rawTextDigest(basicIndex.slice(template.range)));
    assert.equal(outlineNodeFingerprint(hello), rawTextDigest(basicIndex.slice(hello.range)));
    assert.match(outlineNodeFingerprint(style), /^sha256:[0-9a-f]{64}$/);
    assertRanges(result.nodes);
});

test("template headings h1-h6 keep their declared rank and id/aria-label sections nest", (): void => {
    const result: OutlineResult = outline("components/Headings.vue");
    const template: OutlineNode = blocksOf(result)[0];
    assert.deepEqual(blockLabels(result), ["template"]);
    assert.equal(template.detail, "template");
    assertRange(template, HeadingsText, 1, 15);
    assert.deepEqual(labels(template.children), ["Level One", "sec", "Panel", "empty"]);
    const chain: readonly string[] = ["Level One", "Level Two", "Level Three", "Level Four", "Level Five", "Level Six"];
    let current: readonly OutlineNode[] = template.children;
    for (let index: number = 0; index < chain.length; index += 1) {
        const node: OutlineNode = requireNode(current, chain[index]);
        assert.equal(node.type, "heading", chain[index]);
        assert.equal(node.depth, 2 + index, chain[index]);
        assert.equal(Number(node.range.startLine), 2 + index, chain[index]);
        assert.equal(node.children.length, index === chain.length - 1 ? 0 : 1, chain[index]);
        current = node.children;
    }
    const levelSix: OutlineNode = requireNode(template.children, "Level Six");
    assert.equal(levelSix.path, "components/Headings.vue#template.Level One.Level Two.Level Three.Level Four.Level Five.Level Six");
    const section: OutlineNode = requireNode(template.children, "sec");
    assert.equal(section.type, "section");
    assert.equal(section.detail, "section");
    assert.equal(section.depth, 2);
    assertRange(section, HeadingsText, 8, 10);
    const secChild: OutlineNode = requireNode(section.children, "Sec Child");
    assert.equal(secChild.depth, 4);
    assertRange(secChild, HeadingsText, 9, 9);
    const panel: OutlineNode = requireNode(template.children, "Panel");
    assert.equal(panel.type, "section");
    assert.equal(panel.detail, "article");
    assert.equal(panel.depth, 2);
    assertRange(panel, HeadingsText, 11, 13);
    const panelChild: OutlineNode = requireNode(panel.children, "Panel Child");
    assert.equal(panelChild.type, "heading");
    assert.equal(panelChild.depth, 5);
    assertRange(panelChild, HeadingsText, 12, 12);
    const empty: OutlineNode = requireNode(template.children, "empty");
    assert.equal(empty.type, "section");
    assert.equal(empty.children.length, 0);
    assertRange(empty, HeadingsText, 14, 14);
    assertContains(template, section);
    assertContains(section, secChild);
    assertContains(panel, panelChild);
    assertContains(template, empty);
    assertRanges(result.nodes);
});

test("script blocks expose a component name and top-level const/function/class declarations", (): void => {
    const result: OutlineResult = outline("components/Named.vue");
    const script: OutlineNode = blocksOf(result)[0];
    assert.deepEqual(blockLabels(result), ["script"]);
    assert.equal(script.detail, "script");
    assertRange(script, NamedText, 1, 11);
    assert.deepEqual(labels(script.children), ["MyWidget", "VERSION", "helper", "Store"]);
    const componentName: OutlineNode = script.children[0];
    assert.equal(componentName.type, "class");
    assert.equal(componentName.detail, "component name");
    assert.equal(componentName.depth, 2);
    assert.equal(componentName.path, "components/Named.vue#script.MyWidget");
    const version: OutlineNode = script.children[1];
    assert.equal(version.type, "constant");
    assert.equal(version.detail, "script declaration");
    const helper: OutlineNode = script.children[2];
    assert.equal(helper.type, "function");
    assert.equal(helper.detail, "script declaration");
    assert.equal(helper.path, "components/Named.vue#script.helper");
    const store: OutlineNode = script.children[3];
    assert.equal(store.type, "class");
    assert.equal(store.detail, "script declaration");
    assertRanges(result.nodes);
});

test("multiple SFC blocks are emitted in source order with their own labels and line ranges", (): void => {
    const result: OutlineResult = outline("components/Multi.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "template", "script", "script (setup)", "style", "style (scss)", "style (scoped)"]);
    assert.equal(blocks.length, 7);
    assertRange(blocks[0], MultiText, 1, 1);
    assertRange(blocks[1], MultiText, 2, 4);
    assertRange(blocks[2], MultiText, 5, 7);
    assertRange(blocks[3], MultiText, 8, 10);
    assertRange(blocks[4], MultiText, 11, 13);
    assertRange(blocks[5], MultiText, 14, 16);
    assertRange(blocks[6], MultiText, 17, 19);
    assert.deepEqual(labels(blocks[0].children), ["First"]);
    assertRange(blocks[0].children[0], MultiText, 1, 1);
    assert.deepEqual(labels(blocks[1].children), ["Second"]);
    assert.equal(blocks[1].children[0].depth, 3);
    assertRange(blocks[1].children[0], MultiText, 3, 3);
    assert.deepEqual(labels(blocks[2].children), ["a"]);
    assert.deepEqual(labels(blocks[3].children), ["b"]);
    assert.deepEqual(labels(blocks[4].children), [".x"]);
    assertRange(blocks[4].children[0], MultiText, 12, 12);
    assert.deepEqual(labels(blocks[5].children), [".y"]);
    assertRange(blocks[5].children[0], MultiText, 15, 15);
    assert.equal(blocks[5].children[0].type, "section");
    assert.deepEqual(labels(blocks[5].children[0].children), [".z"]);
    assertRange(blocks[5].children[0].children[0], MultiText, 15, 15);
    assert.deepEqual(labels(blocks[6].children), [".w"]);
    assertRange(blocks[6].children[0], MultiText, 18, 18);
    assert.equal(blocks[0].depth, 1);
    assert.equal(blocks[3].detail, "script");
    assert.equal(blocks[5].detail, "style");
    assertRanges(result.nodes);
});

test("single-line blocks report one-line ranges and same-line children collapse onto the block range", (): void => {
    const result: OutlineResult = outline("components/Inline.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script (setup)", "style (scoped)"]);
    assertRange(blocks[0], InlineText, 1, 1);
    assertRange(blocks[1], InlineText, 2, 2);
    assertRange(blocks[2], InlineText, 3, 3);
    assert.deepEqual(labels(blocks[0].children), ["inline"]);
    const inlineSection: OutlineNode = blocks[0].children[0];
    assert.equal(inlineSection.type, "section");
    assert.equal(inlineSection.depth, 2);
    assertRange(inlineSection, InlineText, 1, 1);
    assert.deepEqual(labels(inlineSection.children), ["Solo"]);
    const solo: OutlineNode = inlineSection.children[0];
    assert.equal(solo.type, "heading");
    assert.equal(solo.depth, 4);
    assertRange(solo, InlineText, 1, 1);
    assert.equal(inlineSection.range.startByte, blocks[0].range.startByte);
    assert.equal(inlineSection.range.endByte, blocks[0].range.endByte);
    assert.equal(solo.range.startByte, blocks[0].range.startByte);
    assert.equal(solo.range.endByte, blocks[0].range.endByte);
    assert.deepEqual(labels(blocks[1].children), ["active"]);
    assert.equal(blocks[1].children[0].type, "variable");
    assertRange(blocks[1].children[0], InlineText, 2, 2);
    assert.deepEqual(labels(blocks[2].children), [".on"]);
    assertRange(blocks[2].children[0], InlineText, 3, 3);
    assertRanges(result.nodes);
});

test("self-closing and void template elements do not emit nodes or hide later headings", (): void => {
    const result: OutlineResult = outline("components/SelfClose.vue");
    const template: OutlineNode = blocksOf(result)[0];
    assert.deepEqual(blockLabels(result), ["template"]);
    assertRange(template, SelfCloseText, 1, 8);
    assert.deepEqual(labels(template.children), ["Before", "After"]);
    assert.equal(template.children[0].depth, 3);
    assert.equal(template.children[1].depth, 3);
    assertRange(template.children[0], SelfCloseText, 2, 2);
    assertRange(template.children[1], SelfCloseText, 7, 7);
    assert.equal(findNode(result.nodes, "solo"), undefined);
    assert.equal(findNode(result.nodes, "img"), undefined);
    assert.equal(findNode(result.nodes, "br"), undefined);
    assertRanges(result.nodes);
});

test("a self-closing template tag produces no template block while the script block still parses", (): void => {
    const result: OutlineResult = outline("components/SelfCloseBlock.vue");
    assert.deepEqual(blockLabels(result), ["script"]);
    assert.equal(findNode(result.nodes, "template"), undefined);
    assertRange(blocksOf(result)[0], SelfCloseBlockText, 2, 2);
    assert.deepEqual(labels(blocksOf(result)[0].children), ["x"]);
    assertRanges(result.nodes);
});

test("empty template, script and style blocks still become nodes with no children", (): void => {
    const result: OutlineResult = outline("components/EmptyBlocks.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script", "style"]);
    assertRange(blocks[0], EmptyBlocksText, 1, 1);
    assertRange(blocks[1], EmptyBlocksText, 2, 2);
    assertRange(blocks[2], EmptyBlocksText, 3, 3);
    for (let index: number = 0; index < blocks.length; index += 1) {
        assert.equal(blocks[index].children.length, 0, blocks[index].label);
        assert.equal(blocks[index].depth, 1);
    }
    assertRanges(result.nodes);
});

test("HTML comments inside the template are skipped and commented headings never appear", (): void => {
    const result: OutlineResult = outline("components/Comments.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script"]);
    assert.deepEqual(labels(blocks[0].children), ["Visible"]);
    assertRange(blocks[0], CommentsText, 1, 5);
    assertRange(blocks[0].children[0], CommentsText, 3, 3);
    assert.equal(findNode(result.nodes, "Hidden heading"), undefined);
    assert.equal(findNode(result.nodes, "hidden-section"), undefined);
    assert.deepEqual(labels(blocks[1].children), ["real"]);
    assertRanges(result.nodes);
});

test("pseudo script/style text in template attributes, escapes and raw elements does not create blocks", (): void => {
    const result: OutlineResult = outline("components/Decoy.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script (setup, ts)", "style (scoped)"]);
    assertRange(blocks[0], DecoyText, 1, 7);
    assert.deepEqual(labels(blocks[0].children), ["Real Heading"]);
    assertRange(blocks[0].children[0], DecoyText, 6, 6);
    assert.equal(findNode(result.nodes, "fake"), undefined);
    assert.equal(findNode(result.nodes, "raw"), undefined);
    assert.equal(findNode(result.nodes, ".fake"), undefined);
    assert.deepEqual(labels(blocks[1].children), ["real"]);
    assert.deepEqual(labels(blocks[2].children), [".real"]);
    assertRanges(result.nodes);
});

test("a Vue file without a template keeps script and style blocks", (): void => {
    const result: OutlineResult = outline("components/NoTemplate.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["script (setup, ts)", "style (scoped)"]);
    assert.equal(findNode(result.nodes, "template"), undefined);
    assert.deepEqual(labels(blocks[0].children), ["count", "bump"]);
    assert.equal(blocks[0].children[0].type, "constant");
    assert.equal(blocks[0].children[1].type, "function");
    assert.deepEqual(labels(blocks[1].children), [".count"]);
    assertRange(blocks[1], NoTemplateText, 6, 8);
    assertRange(blocks[1].children[0], NoTemplateText, 7, 7);
    assertRanges(result.nodes);
});

test("an empty Vue file yields the file anchor only", (): void => {
    const result: OutlineResult = outline("components/Empty.vue");
    assert.equal(result.strategy, "vue");
    assert.equal(result.language, "vue");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.nodes.length, 1);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.children.length, 0);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, 0n);
    assert.equal(anchor.range.startLine, 1n);
    assert.equal(anchor.range.endLine, 1n);
    assert.match(outlineNodeFingerprint(anchor), /^sha256:[0-9a-f]{64}$/);
    assertRanges(result.nodes);
});

test("CRLF line endings keep block line numbers and byte ranges include the carriage return", (): void => {
    const result: OutlineResult = outline("components/Crlf.vue");
    assert.equal(result.charset, "utf-8");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script"]);
    assertRange(blocks[0], CrlfText, 1, 3);
    assertRange(blocks[1], CrlfText, 4, 6);
    assert.equal(blocks[0].range.endByte - blocks[0].range.startByte, BigInt(Buffer.byteLength("<template>\r\n  <h1>CRLF</h1>\r\n</template>\r\n", "utf8")));
    const heading: OutlineNode = requireNode(result.nodes, "CRLF");
    assert.equal(heading.label.includes("\r"), false);
    assertRange(heading, CrlfText, 2, 2);
    assert.equal(heading.range.endByte - heading.range.startByte, BigInt(Buffer.byteLength("  <h1>CRLF</h1>\r\n", "utf8")));
    assertRanges(result.nodes);
});

test("a UTF-8 BOM keeps raw-file byte coordinates and decoded line coordinates", (): void => {
    const result: OutlineResult = outline("components/Bom.vue");
    assert.equal(result.charset, "utf-8-bom");
    const anchor: OutlineNode = result.nodes[0];
    const decodedBytes: bigint = BigInt(Buffer.byteLength(BomText, "utf8"));
    assert.equal(anchor.range.endByte, BigInt(BomBytes.length));
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(BigInt(BomBytes.length), decodedBytes + 3n);
    assert.deepEqual(blockLabels(result), ["template"]);
    for (const node of [blocksOf(result)[0], requireNode(result.nodes, "BOM")]) {
        const expected = expectedBytes(BomText, Number(node.range.startLine), Number(node.range.endLine));
        assert.equal(node.range.startByte, expected.startByte + 3n);
        assert.equal(node.range.endByte, expected.endByte + 3n);
        assert.equal(outlineNodeFingerprint(node), rawTextDigest(BomText.slice(Number(expected.startByte), Number(expected.endByte))));
    }
    assert.equal(requireNode(result.nodes, "BOM").range.startLine, 2n);
    assertRanges(result.nodes);
});

test("Unicode labels survive while byte ranges count UTF-8 bytes rather than UTF-16 code units", (): void => {
    const result: OutlineResult = outline("components/Unicode.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template", "script (setup)"]);
    const heading: OutlineNode = requireNode(blocks[0].children, "标题 · 見出し");
    assertRange(heading, UnicodeText, 2, 2);
    const headingBytes: bigint = heading.range.endByte - heading.range.startByte;
    assert.equal(headingBytes, BigInt(Buffer.byteLength("  <h1>标题 · 見出し</h1>\n", "utf8")));
    assert.ok(headingBytes > BigInt("  <h1>标题 · 見出し</h1>\n".length), "multi-byte text must exceed its code-unit length");
    const section: OutlineNode = requireNode(blocks[0].children, "章节一");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 2);
    assertRange(section, UnicodeText, 3, 5);
    const nested: OutlineNode = requireNode(section.children, "子标题 🚀");
    assert.equal(nested.type, "heading");
    assert.equal(nested.depth, 4);
    assertRange(nested, UnicodeText, 4, 4);
    assert.equal(nested.path, "components/Unicode.vue#template.章节一.子标题 🚀");
    assert.deepEqual(labels(blocks[1].children), ["greeting", "问候"]);
    assert.equal(blocks[1].children[0].type, "constant");
    assertRange(requireNode(result.nodes, "问候"), UnicodeText, 9, 9);
    assertRanges(result.nodes);
});

test("symbol paths escape % # and / below the template block path", (): void => {
    const result: OutlineResult = outline("components/Escape.vue");
    const blocks: readonly OutlineNode[] = blocksOf(result);
    assert.deepEqual(blockLabels(result), ["template"]);
    assert.equal(blocks[0].path, "components/Escape.vue#template");
    const heading: OutlineNode = requireNode(blocks[0].children, "100% #done");
    assert.equal(heading.path, "components/Escape.vue#template.100%25 %23done");
    const section: OutlineNode = requireNode(blocks[0].children, "a/b");
    assert.equal(section.path, "components/Escape.vue#template.a%2Fb");
    const nested: OutlineNode = requireNode(section.children, "C# Guide");
    assert.equal(nested.path, "components/Escape.vue#template.a%2Fb.C%23 Guide");
    assertRanges(result.nodes);
});

test("maxNodes counts the anchor and the Vue block tree, and reports truncation", (): void => {
    const limited: OutlineResult = outline("components/Headings.vue", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.equal(limited.nodes[0].children.length, 1);
    assert.deepEqual(labels(limited.nodes[0].children[0].children), ["Level One"]);
    const five: OutlineResult = outline("components/Headings.vue", { maxNodes: 5 });
    assert.equal(five.truncated, true);
    assert.equal(flatten(five.nodes).length, 5);
    assert.deepEqual(labels(requireNode(five.nodes, "Level One").children), ["Level Two"]);
    assert.deepEqual(labels(requireNode(five.nodes, "Level Two").children), ["Level Three"]);
    const anchorOnly: OutlineResult = outline("components/Headings.vue", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.equal(anchorOnly.nodes[0].children.length, 0);
    const complete: OutlineResult = outline("components/Headings.vue", { maxNodes: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 13);
    assert.equal(requireNode(complete.nodes, "Level Six").depth, 7);
});

test("maxDepth drops whole sub-trees and reports truncation", (): void => {
    const two: OutlineResult = outline("components/Headings.vue", { maxDepth: 2 });
    assert.equal(two.truncated, true);
    assert.deepEqual(labels(blocksOf(two)), ["template"]);
    assert.deepEqual(labels(requireNode(two.nodes, "template").children), ["Level One", "sec", "Panel", "empty"]);
    assert.equal(requireNode(two.nodes, "Level One").children.length, 0);
    assert.equal(requireNode(two.nodes, "sec").children.length, 0);
    assert.equal(requireNode(two.nodes, "Panel").children.length, 0);
    assert.equal(findNode(two.nodes, "Level Two"), undefined);
    assert.equal(findNode(two.nodes, "Sec Child"), undefined);
    const three: OutlineResult = outline("components/Headings.vue", { maxDepth: 3 });
    assert.equal(three.truncated, true);
    assert.deepEqual(labels(requireNode(three.nodes, "template").children), ["Level One", "sec", "Panel", "empty"]);
    assert.deepEqual(labels(requireNode(three.nodes, "Level One").children), ["Level Two"]);
    assert.equal(requireNode(three.nodes, "Level Two").children.length, 0);
    assert.equal(findNode(three.nodes, "Level Three"), undefined);
    assert.equal(findNode(three.nodes, "Sec Child"), undefined);
    const four: OutlineResult = outline("components/Headings.vue", { maxDepth: 4 });
    assert.equal(requireNode(four.nodes, "Sec Child").depth, 4);
    assert.equal(findNode(four.nodes, "Panel Child"), undefined);
    assert.equal(findNode(three.nodes, "Panel Child"), undefined);
    assert.equal(findNode(three.nodes, "Level Six"), undefined);
});

test("Vue script regex braces do not hide declarations and commented names do not shadow the real name", (): void => {
    const result: OutlineResult = outline("components/RegexAndName.vue");
    assert.deepEqual(labels(blocksOf(result)[0].children), ["RealWidget", "pattern", "afterRegex", "tail"]);
    assertRange(requireNode(result.nodes, "RealWidget"), RegexAndNameText, 3, 3);
    assertRange(requireNode(result.nodes, "afterRegex"), RegexAndNameText, 5, 7);
    assertRange(requireNode(result.nodes, "tail"), RegexAndNameText, 8, 8);
    assert.equal(findNode(result.nodes, "CommentDecoy"), undefined);
});

test("invalid node/depth bounds are rejected before any Vue parsing happens", (): void => {
    expectFilesystemError("invalid_arguments", (): void => {
        outline("components/Basic.vue", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("components/Basic.vue", { maxDepth: -1 });
    });
});

test("binary, oversized and missing Vue files are refused with closed error codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("components/Binary.vue");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("components/Huge.vue");
    });
    expectFilesystemError("not_found", (): void => {
        outline("components/Missing.vue");
    });
});

test("every Vue fixture keeps bigint ordered ranges and per-node fingerprints", (): void => {
    for (let index: number = 0; index < VueFixtures.length; index += 1) {
        const result: OutlineResult = outline(VueFixtures[index]);
        assert.equal(result.strategy, "vue", VueFixtures[index]);
        assert.equal(result.target, "file", VueFixtures[index]);
        assert.equal(result.nodes.length, 1, VueFixtures[index]);
        const anchor: OutlineNode = result.nodes[0];
        assert.equal(anchor.type, "File", VueFixtures[index]);
        assert.equal(anchor.range.startByte, 0n, VueFixtures[index]);
        assert.equal(anchor.range.startLine, 1n, VueFixtures[index]);
        assertRanges(result.nodes);
        const flat: OutlineNode[] = flatten(result.nodes);
        for (let nodeIndex: number = 0; nodeIndex < flat.length; nodeIndex += 1) {
            assert.match(outlineNodeFingerprint(flat[nodeIndex]), /^sha256:[0-9a-f]{64}$/, flat[nodeIndex].label);
        }
    }
});

test("Vue blocks retain unique paths and parser contracts stay explicit", (): void => {
    const multi: OutlineResult = outline("components/Multi.vue");
    assert.deepEqual(blockLabels(multi), ["template", "template", "script", "script (setup)", "style", "style (scss)", "style (scoped)"]);
    assert.notEqual(blocksOf(multi)[0].path, blocksOf(multi)[1].path);
    const basic: OutlineResult = outline("components/Basic.vue");
    assert.equal(requireNode(basic.nodes, ".a").path, "components/Basic.vue#style (scoped)..a");
    const named: OutlineResult = outline("components/Named.vue");
    assert.equal(Number(requireNode(named.nodes, "MyWidget").range.startLine), 3);
    const headings: OutlineResult = outline("components/Headings.vue");
    const levelTwo: OutlineNode = requireNode(headings.nodes, "Level Two");
    assert.equal(Number(levelTwo.range.startLine), 3);
    assert.equal(levelTwo.depth, 3);
    const panel: OutlineNode = requireNode(headings.nodes, "Panel");
    assert.equal(panel.depth, 2);
    assert.equal(requireNode(panel.children, "Panel Child").depth, 5);
    const inline: OutlineResult = outline("components/Inline.vue");
    assert.equal(requireNode(inline.nodes, "active").type, "variable");
    const selfClose: OutlineResult = outline("components/SelfCloseBlock.vue");
    assert.equal(findNode(selfClose.nodes, "template"), undefined);
    const inlineBlock: OutlineNode = blocksOf(inline)[0];
    const inlineSection: OutlineNode = inlineBlock.children[0];
    assert.equal(inlineSection.range.endByte, inlineBlock.range.endByte);
    assert.equal(inlineSection.children[0].range.startByte, inlineBlock.range.startByte);
});

test(
    "[BUG-01] an SFC-level comment must not become a phantom script block",
    (): void => {
        const result: OutlineResult = outline("components/TopComment.vue");
        assert.deepEqual(blockLabels(result), ["template"]);
        assert.equal(findNode(result.nodes, "fake"), undefined);
    },
);

test(
    "[BUG-02] script declarations must report their real source line",
    (): void => {
        const basic: OutlineResult = outline("components/Basic.vue");
        assertRange(requireNode(basic.nodes, "count"), BasicText, 8, 8);
        assertRange(requireNode(basic.nodes, "increment"), BasicText, 9, 9);
        const named: OutlineResult = outline("components/Named.vue");
        assertRange(requireNode(named.nodes, "VERSION"), NamedText, 6, 6);
    },
);

test(
    "[BUG-03] a multi-line opening tag must not shift template and script child lines upward",
    (): void => {
        const result: OutlineResult = outline("components/MultiLineTag.vue");
        assertRange(requireNode(result.nodes, "Shifted"), MultiLineTagText, 4, 4);
        assertRange(requireNode(result.nodes, "shifted"), MultiLineTagText, 10, 10);
    },
);

test(
    "[BUG-04] a </script> inside a script string must not close the block",
    (): void => {
        const result: OutlineResult = outline("components/ScriptClose.vue");
        assert.deepEqual(blockLabels(result), ["script", "style"]);
        assertRange(blocksOf(result)[0], ScriptCloseText, 1, 4);
        assertRange(requireNode(result.nodes, "after"), ScriptCloseText, 3, 3);
    },
);

test(
    "[BUG-05] the component name and declaration end lines must follow the source",
    (): void => {
        const result: OutlineResult = outline("components/Named.vue");
        assertRange(requireNode(result.nodes, "MyWidget"), NamedText, 3, 3);
        assertRange(requireNode(result.nodes, "helper"), NamedText, 7, 9);
    },
);

test(
    "[BUG-06] declarations nested inside a function body must not be reported as top-level",
    (): void => {
        const result: OutlineResult = outline("components/Nested.vue");
        assert.deepEqual(labels(blocksOf(result)[0].children), ["Nested", "outer"]);
        assert.equal(findNode(result.nodes, "inner"), undefined);
        assert.equal(findNode(result.nodes, "local"), undefined);
    },
);

test(
    "[BUG-07] attribute values containing setup/scoped must not add modifiers",
    (): void => {
        const result: OutlineResult = outline("components/ModifierAttr.vue");
        assert.deepEqual(blockLabels(result), ["script", "style"]);
        assert.equal(blocksOf(result)[0].detail, "script");
        assert.equal(blocksOf(result)[1].detail, "style");
    },
);
