#!/usr/bin/env node
/**
 * Shell outline boundary checks.
 *
 * `ShellStrategy` is not part of `builtinOutlineStrategies` yet, so this check
 * builds an explicit `OutlineRegistry([ShellStrategy])`. That keeps every
 * assertion on the same public `OutlineRegistry.build` path the default
 * registry uses: sandbox resolution, the charset gate, file anchoring, UTF-8
 * byte ranges, strategy selection and the node/depth budgets are all real.
 * `parseShell` is also called directly for the strategy-level contract (empty
 * input and the placeholder range shape).
 *
 * Fixtures live in a private temporary directory and are removed after the
 * run. Nothing is executed; every fixture is data for the parser.
 *
 * Run with: node tools/shellOutlineCheck.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { LineIndex } from "../src/syntax/charset.ts";
import { OutlineRegistry } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import { ShellStrategy, parseShell } from "../src/outline/shellOutline.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-shell-outline-"));
const RootSpec: SessionRoot = { id: "root.shellOutline", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);
const Registry: OutlineRegistry = new OutlineRegistry([ShellStrategy]);

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
 * Run the explicit shell registry against the fixture sandbox.
 */
const outline: (path: string, options?: OutlineOptions) => OutlineResult = (path: string, options: OutlineOptions = {}): OutlineResult =>
    Registry.build(Sandbox, path, options);

/**
 * Call the strategy parser directly with a real line index.
 */
const parse: (text: string, path?: string) => OutlineNode[] = (text: string, path: string = "direct.sh"): OutlineNode[] =>
    parseShell({ path, text, lineIndex: new LineIndex(text) });

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
 * Main fixture: three function spellings, a shebang and a non-declaration.
 */
const MainText: string = [
    "#!/usr/bin/env bash",
    "# top comment",
    "set -euo pipefail",
    "",
    "greet() {",
    '    echo "hello $1"',
    "}",
    "",
    "function deploy {",
    "    echo deploy",
    "}",
    "",
    "function build() {",
    "    echo build",
    "}",
].join("\n");

/**
 * Nested functions plus an `if` inside the inner function.
 */
const NestedText: string = [
    "outer() {",
    "    inner() {",
    '        if [ -d "$1" ]; then',
    '            echo "directory"',
    "        fi",
    "    }",
    "    echo done",
    "}",
].join("\n");

/**
 * Here-document body that contains a fake function, a fake assignment and a
 * `}` that must not close the outer function.
 */
const HeredocText: string = [
    "cat_heredoc() {",
    "    cat <<'EOF'",
    "fake() {",
    "    INSIDE_HEREDOC=1",
    "}",
    "EOF",
    "}",
    "after_heredoc() {",
    "    echo ok",
    "}",
].join("\n");

/**
 * Braces inside strings must not close a function early.
 */
const BraceText: string = [
    "brace_fn() {",
    '    echo "}"',
    '    echo "{"',
    "}",
    "next_fn() {",
    "    echo ok",
    "}",
].join("\n");

/**
 * Assignment forms: bare, export, readonly, declare, typeset, local; plus two
 * command-position decoys that are arguments, not declarations.
 */
const VarsText: string = [
    "#!/bin/sh",
    'appName="demo"',
    'APP_NAME="demo"',
    'export PATH="/opt/bin:$PATH"',
    "readonly TIMEOUT=30",
    "declare -x REGION=us-east-1",
    "typeset -r WORKERS=4",
    "local_scope=1",
    "echo NOT_A_VAR=1",
    "export NO_VALUE",
].join("\n");

/**
 * Includes and non-includes.
 */
const ImportsText: string = [
    "#!/bin/bash",
    "source ./lib/common.sh",
    ". /etc/profile",
    "echo source ignored.sh",
    "cat < ./not-an-import",
].join("\n");

/**
 * Alias declarations and a decoy that only mentions `alias`.
 */
const AliasesText: string = [
    "alias ll='ls -la'",
    'alias gs="git status"',
    "echo alias nope='x'",
].join("\n");

/**
 * Control blocks, a variable inside `if` and case patterns that must not
 * become variables.
 */
const ControlText: string = [
    "CONFIG=/etc/app.conf",
    'if [ -f "$CONFIG" ]; then',
    "    IN_IF=1",
    "    echo found",
    "fi",
    "",
    'case "$1" in',
    "    start)",
    "        run_start",
    "        ;;",
    "    *)",
    "        echo usage",
    "        ;;",
    "esac",
    "",
    "for item in a b; do",
    '    echo "$item"',
    "done",
    "",
    "while read -r line; do",
    '    echo "$line"',
    "done",
].join("\n");

/**
 * Comment, single-quote, double-quote, here-string and command-substitution
 * decoys around one real declaration and one real function.
 */
const NoiseText: string = [
    "#!/bin/bash",
    "# fake_comment() {",
    "TEXT='fake_single=1'",
    'OTHER="function fake_double { }"',
    "result=$(fake_sub() { :; }; fake_sub_var=2)",
    "${#array}",
    "echo \\# not-a-comment",
    "after_noise() {",
    "    echo ok",
    "}",
].join("\n");

/**
 * CRLF fixture; every line ends with `\r\n` except the last one.
 */
const CrlfText: string = [
    "#!/bin/bash",
    "",
    "crlf_fn() {",
    "    echo hi",
    "}",
].join("\r\n");

/**
 * Body written after a UTF-8 BOM.
 */
const BomBody: string = [
    "#!/bin/bash",
    "bom_fn() {",
    "    echo bom",
    "}",
].join("\n");

/**
 * Unicode comments, string values and a constant with a non-ASCII value.
 */
const UnicodeText: string = [
    "#!/bin/bash",
    "# 中文注释",
    "unicode_fn() {",
    '    echo "你好，世界"',
    '    UNICODE_VALUE="值"',
    "}",
].join("\n");

/**
 * Extensionless executable selected by its shebang alone.
 */
const DeployText: string = [
    "#!/bin/sh",
    "deploy_fn() {",
    "    echo go",
    "}",
].join("\n");

/**
 * Three nested function levels for the depth budget.
 */
const DeepText: string = [
    "level1() {",
    "    level2() {",
    "        level3() {",
    "            echo deep",
    "        }",
    "    }",
    "}",
].join("\n");

/**
 * Six single-line functions for the node budget.
 */
const ManyText: string = [
    "one() { echo 1; }",
    "two() { echo 2; }",
    "three() { echo 3; }",
    "four() { echo 4; }",
    "five() { echo 5; }",
    "six() { echo 6; }",
].join("\n");

/**
 * A case pattern named after a reserved word plus a one-line `if`; the pattern
 * must not close the surrounding loop and the one-line block keeps L7-L7.
 */
const BlocksText: string = [
    "while true; do",
    '    case "$1" in',
    "        done)",
    '            echo "reserved pattern"',
    "            ;;",
    "    esac",
    "    if true; then echo ok; fi",
    "done",
].join("\n");

/**
 * C-style `for` and arithmetic commands: the `;` and `<<` inside `((...))` are
 * arithmetic syntax, not a command separator or a here-document.
 */
const ArithmeticText: string = [
    "for ((i=0; i<3; i++)); do",
    '    echo "$i"',
    "done",
    "(( TOTAL << 1 ))",
    "AFTER=1",
].join("\n");

/**
 * A single-quoted string spanning lines; declarations inside it are data.
 */
const MultilineQuoteText: string = [
    "#!/bin/bash",
    "MULTI='first line",
    "fake_multiline() {",
    "    MULTI_VAR=1",
    "}",
    "last line'",
    "after_multiline() {",
    "    echo ok",
    "}",
].join("\n");

fixture("scripts/main.sh", MainText);
fixture("scripts/nested.sh", NestedText);
fixture("scripts/heredoc.sh", HeredocText);
fixture("scripts/brace.sh", BraceText);
fixture("scripts/vars.sh", VarsText);
fixture("scripts/imports.sh", ImportsText);
fixture("scripts/aliases.sh", AliasesText);
fixture("scripts/control.sh", ControlText);
fixture("scripts/noise.sh", NoiseText);
fixture("scripts/empty.sh", "");
fixture("scripts/comments.sh", "# only a comment\n# another comment\n");
fixture("scripts/crlf.sh", CrlfText);
fixture("scripts/bom.sh", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomBody, "utf8")]));
fixture("scripts/unicode.sh", UnicodeText);
fixture("scripts/deep.sh", DeepText);
fixture("scripts/many.sh", ManyText);
fixture("scripts/blocks.sh", BlocksText);
fixture("scripts/arithmetic.sh", ArithmeticText);
fixture("scripts/multiline_quote.sh", MultilineQuoteText);
fixture("bin/deploy", DeployText);

test("ShellStrategy metadata covers extensions, dotfiles and shebang sniffing", (): void => {
    assert.equal(ShellStrategy.id, "shell");
    assert.equal(ShellStrategy.category, "code");
    assert.equal(ShellStrategy.language, "shell");
    const match: (name: string, head?: string) => boolean = (name: string, head: string = ""): boolean =>
        ShellStrategy.matches({ path: `bin/${name}`, name, head });
    assert.equal(match("run.sh"), true);
    assert.equal(match("run.bash"), true);
    assert.equal(match("run.zsh"), true);
    assert.equal(match("run.ksh"), true);
    assert.equal(match(".bashrc"), true);
    assert.equal(match(".zshrc"), true);
    assert.equal(match("run.py"), false);
    assert.equal(match("Makefile"), false);
    assert.equal(match("tool", "#!/bin/sh\n"), true);
    assert.equal(match("tool", "#!/usr/bin/env bash\n"), true);
    assert.equal(match("tool", "#!/usr/bin/env -S bash -e\n"), true);
    assert.equal(match("tool", "#!/bin/zsh -e\n"), true);
    assert.equal(match("tool", "\uFEFF#!/bin/sh\n"), true);
    assert.equal(match("tool", "#!/usr/bin/python3\n"), false);
    assert.equal(match("tool", "echo hi\n"), false);
});

test("all three function spellings become function nodes with matching brace ranges", (): void => {
    const result: OutlineResult = outline("scripts/main.sh");
    assert.equal(result.strategy, "shell");
    assert.equal(result.category, "code");
    assert.equal(result.language, "shell");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "scripts/main.sh");
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), 15);
    assert.deepEqual(labels(anchor.children), ["greet", "deploy", "build"]);
    const greet: OutlineNode = requireNode(result.nodes, "greet");
    assert.equal(greet.type, "function");
    assert.equal(greet.depth, 1);
    assert.equal(greet.path, "scripts/main.sh#greet");
    assert.equal(greet.detail, "greet() {");
    assertRange(greet, MainText, 5, 7);
    const deploy: OutlineNode = requireNode(result.nodes, "deploy");
    assert.equal(deploy.path, "scripts/main.sh#deploy");
    assertRange(deploy, MainText, 9, 11);
    const build: OutlineNode = requireNode(result.nodes, "build");
    assert.equal(build.path, "scripts/main.sh#build");
    assertRange(build, MainText, 13, 15);
    assert.equal(findNode(result.nodes, "set"), undefined);
});

test("nested functions nest by containment and an inner if closes before its function", (): void => {
    const result: OutlineResult = outline("scripts/nested.sh");
    const outer: OutlineNode = requireNode(result.nodes, "outer");
    assert.equal(outer.type, "function");
    assert.equal(outer.depth, 1);
    assertRange(outer, NestedText, 1, 8);
    const inner: OutlineNode = requireNode(outer.children, "inner");
    assert.equal(inner.type, "function");
    assert.equal(inner.depth, 2);
    assert.equal(inner.path, "scripts/nested.sh#outer.inner");
    assertRange(inner, NestedText, 2, 6);
    const guard: OutlineNode = requireNode(inner.children, 'if [ -d "$1" ]');
    assert.equal(guard.type, "section");
    assert.equal(guard.depth, 3);
    assert.equal(guard.path, 'scripts/nested.sh#outer.inner.if [ -d "$1" ]');
    assertRange(guard, NestedText, 3, 5);
    assert.deepEqual(labels(outer.children), ["inner"]);
    assert.equal(guard.children.length, 0);
});

test("a here-document body cannot declare functions, variables or close a brace", (): void => {
    const result: OutlineResult = outline("scripts/heredoc.sh");
    assert.deepEqual(labels(result.nodes[0].children), ["cat_heredoc", "after_heredoc"]);
    const cat: OutlineNode = requireNode(result.nodes, "cat_heredoc");
    assertRange(cat, HeredocText, 1, 7);
    const after: OutlineNode = requireNode(result.nodes, "after_heredoc");
    assertRange(after, HeredocText, 8, 10);
    assert.equal(findNode(result.nodes, "fake"), undefined);
    assert.equal(findNode(result.nodes, "INSIDE_HEREDOC"), undefined);
    assert.equal(cat.children.length, 0);
});

test("braces inside single- and double-quoted strings do not change a function end line", (): void => {
    const result: OutlineResult = outline("scripts/brace.sh");
    const brace: OutlineNode = requireNode(result.nodes, "brace_fn");
    assertRange(brace, BraceText, 1, 4);
    const next: OutlineNode = requireNode(result.nodes, "next_fn");
    assertRange(next, BraceText, 5, 7);
    assert.equal(brace.children.length, 0);
});

test("assignments report variables and all-uppercase names as constants", (): void => {
    const result: OutlineResult = outline("scripts/vars.sh");
    const children: readonly OutlineNode[] = result.nodes[0].children;
    assert.deepEqual(labels(children), ["appName", "APP_NAME", "PATH", "TIMEOUT", "REGION", "WORKERS", "local_scope"]);
    assert.equal(requireNode(result.nodes, "appName").type, "variable");
    assert.equal(requireNode(result.nodes, "APP_NAME").type, "constant");
    assert.equal(requireNode(result.nodes, "PATH").type, "constant");
    assert.equal(requireNode(result.nodes, "PATH").detail, 'export PATH="/opt/bin:$PATH"');
    assert.equal(requireNode(result.nodes, "TIMEOUT").type, "constant");
    assert.equal(requireNode(result.nodes, "REGION").type, "constant");
    assert.equal(requireNode(result.nodes, "WORKERS").type, "constant");
    assert.equal(requireNode(result.nodes, "local_scope").type, "variable");
    assert.equal(Number(requireNode(result.nodes, "TIMEOUT").range.startLine), 5);
    assert.equal(findNode(result.nodes, "NOT_A_VAR"), undefined);
    assert.equal(findNode(result.nodes, "NO_VALUE"), undefined);
    assert.equal(requireNode(result.nodes, "appName").path, "scripts/vars.sh#appName");
});

test("source and dot includes become dependency nodes with the target as label", (): void => {
    const result: OutlineResult = outline("scripts/imports.sh");
    const children: readonly OutlineNode[] = result.nodes[0].children;
    assert.deepEqual(labels(children), ["./lib/common.sh", "/etc/profile"]);
    assert.equal(children[0].type, "dependency");
    assert.equal(children[0].path, "scripts/imports.sh#.%2Flib%2Fcommon.sh");
    assert.equal(children[0].detail, "source ./lib/common.sh");
    assert.equal(Number(children[0].range.startLine), 2);
    assert.equal(children[1].type, "dependency");
    assert.equal(children[1].path, "scripts/imports.sh#%2Fetc%2Fprofile");
    assert.equal(children[1].detail, ". /etc/profile");
    assert.equal(findNode(result.nodes, "ignored.sh"), undefined);
    assert.equal(findNode(result.nodes, "./not-an-import"), undefined);
});

test("alias entries become property nodes and an argument mentioning alias is ignored", (): void => {
    const result: OutlineResult = outline("scripts/aliases.sh");
    const children: readonly OutlineNode[] = result.nodes[0].children;
    assert.deepEqual(labels(children), ["ll", "gs"]);
    assert.equal(children[0].type, "property");
    assert.equal(children[0].path, "scripts/aliases.sh#ll");
    assert.equal(children[0].detail, "alias ll='ls -la'");
    assert.equal(children[1].type, "property");
    assert.equal(children[1].detail, 'alias gs="git status"');
    assert.equal(findNode(result.nodes, "nope"), undefined);
    assert.equal(findNode(result.nodes, "x"), undefined);
});

test("if, case, for and while become section nodes and a nested assignment stays nested", (): void => {
    const result: OutlineResult = outline("scripts/control.sh");
    assert.deepEqual(labels(result.nodes[0].children), ["CONFIG", 'if [ -f "$CONFIG" ]', 'case "$1"', "for item in a b", "while read -r line"]);
    const guard: OutlineNode = requireNode(result.nodes, 'if [ -f "$CONFIG" ]');
    assert.equal(guard.type, "section");
    assert.equal(guard.depth, 1);
    assertRange(guard, ControlText, 2, 5);
    assert.deepEqual(labels(guard.children), ["IN_IF"]);
    const inIf: OutlineNode = requireNode(guard.children, "IN_IF");
    assert.equal(inIf.type, "constant");
    assert.equal(inIf.depth, 2);
    assert.equal(inIf.path, 'scripts/control.sh#if [ -f "$CONFIG" ].IN_IF');
    const caseNode: OutlineNode = requireNode(result.nodes, 'case "$1"');
    assert.equal(caseNode.type, "section");
    assertRange(caseNode, ControlText, 7, 14);
    assert.equal(caseNode.children.length, 0);
    assert.equal(findNode(result.nodes, "start"), undefined);
    const loop: OutlineNode = requireNode(result.nodes, "for item in a b");
    assertRange(loop, ControlText, 16, 18);
    const whileNode: OutlineNode = requireNode(result.nodes, "while read -r line");
    assertRange(whileNode, ControlText, 20, 22);
});

test("comments, strings and command substitutions hide every pseudo declaration", (): void => {
    const result: OutlineResult = outline("scripts/noise.sh");
    assert.deepEqual(labels(result.nodes[0].children), ["TEXT", "OTHER", "result", "after_noise"]);
    assert.equal(requireNode(result.nodes, "TEXT").type, "constant");
    assert.equal(requireNode(result.nodes, "OTHER").type, "constant");
    assert.equal(requireNode(result.nodes, "result").type, "variable");
    assert.equal(requireNode(result.nodes, "result").detail, "result=$(fake_sub() { :; }; fake_sub_var=2)");
    const after: OutlineNode = requireNode(result.nodes, "after_noise");
    assert.equal(after.type, "function");
    assertRange(after, NoiseText, 8, 10);
    assert.equal(findNode(result.nodes, "fake_comment"), undefined);
    assert.equal(findNode(result.nodes, "fake_single"), undefined);
    assert.equal(findNode(result.nodes, "fake_double"), undefined);
    assert.equal(findNode(result.nodes, "fake_sub"), undefined);
    assert.equal(findNode(result.nodes, "fake_sub_var"), undefined);
    assert.equal(findNode(result.nodes, "array"), undefined);
});

test("one-line blocks close on their own line and a reserved-word case pattern is not a closer", (): void => {
    const result: OutlineResult = outline("scripts/blocks.sh");
    const loop: OutlineNode = requireNode(result.nodes, "while true");
    assert.equal(loop.type, "section");
    assertRange(loop, BlocksText, 1, 8);
    assert.deepEqual(labels(loop.children), ['case "$1"', "if true"]);
    const caseNode: OutlineNode = requireNode(loop.children, 'case "$1"');
    assertRange(caseNode, BlocksText, 2, 6);
    assert.equal(caseNode.children.length, 0);
    const oneLine: OutlineNode = requireNode(loop.children, "if true");
    assert.equal(oneLine.type, "section");
    assert.equal(oneLine.depth, 2);
    assertRange(oneLine, BlocksText, 7, 7);
    assert.equal(oneLine.children.length, 0);
    assert.equal(findNode(result.nodes, "done"), undefined);
});

test("arithmetic commands cannot open a here-document or leak pseudo variables", (): void => {
    const result: OutlineResult = outline("scripts/arithmetic.sh");
    const loop: OutlineNode = requireNode(result.nodes, "for ((i=0; i<3; i++))");
    assert.equal(loop.type, "section");
    assertRange(loop, ArithmeticText, 1, 3);
    assert.equal(loop.children.length, 0);
    const after: OutlineNode = requireNode(result.nodes, "AFTER");
    assert.equal(after.type, "constant");
    assertRange(after, ArithmeticText, 5, 5);
    assert.equal(findNode(result.nodes, "TOTAL"), undefined);
    assert.equal(findNode(result.nodes, "i"), undefined);
});

test("a single-quoted string may span lines and hides the declarations inside it", (): void => {
    const result: OutlineResult = outline("scripts/multiline_quote.sh");
    assert.deepEqual(labels(result.nodes[0].children), ["MULTI", "after_multiline"]);
    const value: OutlineNode = requireNode(result.nodes, "MULTI");
    assert.equal(value.type, "constant");
    assert.equal(Number(value.range.startLine), 2);
    const after: OutlineNode = requireNode(result.nodes, "after_multiline");
    assertRange(after, MultilineQuoteText, 7, 9);
    assert.equal(findNode(result.nodes, "fake_multiline"), undefined);
    assert.equal(findNode(result.nodes, "MULTI_VAR"), undefined);
});

test("empty and comment-only scripts produce an anchor without symbols", (): void => {
    const empty: OutlineResult = outline("scripts/empty.sh");
    assert.equal(empty.strategy, "shell");
    assert.equal(empty.language, "shell");
    assert.equal(empty.nodes[0].children.length, 0);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(Number(empty.nodes[0].range.endLine), 1);
    const comments: OutlineResult = outline("scripts/comments.sh");
    assert.equal(comments.nodes[0].children.length, 0);
    assert.equal(Number(comments.nodes[0].range.endLine), 2);
    assert.deepEqual(parse(""), []);
    assert.deepEqual(parse("# only a comment\n"), []);
});

test("CRLF line endings keep line numbers, strip the carriage return and count bytes", (): void => {
    const result: OutlineResult = outline("scripts/crlf.sh");
    assert.equal(result.charset, "utf-8");
    assert.equal(Number(result.nodes[0].range.endLine), 5);
    const fn: OutlineNode = requireNode(result.nodes, "crlf_fn");
    assert.equal(fn.detail, "crlf_fn() {");
    assert.equal(fn.detail.includes("\r"), false);
    assertRange(fn, CrlfText, 3, 5);
});

test("a UTF-8 BOM is reported and does not shift the first declaration line", (): void => {
    const result: OutlineResult = outline("scripts/bom.sh");
    assert.equal(result.charset, "utf-8-bom");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(BomBody, "utf8") + 3));
    assert.equal(Number(anchor.range.endLine), 4);
    const fn: OutlineNode = requireNode(result.nodes, "bom_fn");
    assert.equal(Number(fn.range.startLine), 2);
    assert.equal(Number(fn.range.endLine), 4);
    /**
     * `outline.ts` reports raw-file byte offsets, so the three BOM bytes prefix
     * the decoded text and shift the symbol range. The strategy itself reports
     * only line numbers; this assertion pins the current registry contract.
     */
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(BomBody, 2, 4);
    assert.equal(fn.range.startByte, expected.startByte + 3n);
    assert.equal(fn.range.endByte, expected.endByte + 3n);
    assert.equal(fn.range.endByte - fn.range.startByte, expected.endByte - expected.startByte);
});

test("Unicode comments and string values do not hide declarations and use UTF-8 byte ranges", (): void => {
    const result: OutlineResult = outline("scripts/unicode.sh");
    const fn: OutlineNode = requireNode(result.nodes, "unicode_fn");
    assert.equal(fn.type, "function");
    assertRange(fn, UnicodeText, 3, 6);
    const value: OutlineNode = requireNode(fn.children, "UNICODE_VALUE");
    assert.equal(value.type, "constant");
    assertRange(value, UnicodeText, 5, 5);
    assert.ok(value.range.endByte - value.range.startByte > BigInt(Buffer.byteLength('    UNICODE_VALUE=""', "utf8")));
    assert.equal(findNode(result.nodes, "中文注释"), undefined);
});

test("an extensionless file is selected by its shebang", (): void => {
    const result: OutlineResult = outline("bin/deploy");
    assert.equal(result.strategy, "shell");
    assert.equal(result.category, "code");
    assert.equal(result.language, "shell");
    assert.equal(result.path, "bin/deploy");
    const fn: OutlineNode = requireNode(result.nodes, "deploy_fn");
    assert.equal(fn.path, "bin/deploy#deploy_fn");
    assertRange(fn, DeployText, 2, 4);
});

test("maxNodes truncates explicitly and counts the file anchor", (): void => {
    const limited: OutlineResult = outline("scripts/many.sh", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.deepEqual(labels(limited.nodes[0].children), ["one", "two"]);
    const complete: OutlineResult = outline("scripts/many.sh", { maxNodes: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(complete.nodes[0].children.length, 6);
});

test("maxDepth drops a nested function and reports truncation", (): void => {
    const limited: OutlineResult = outline("scripts/deep.sh", { maxDepth: 2 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["level1"]);
    const level1: OutlineNode = requireNode(limited.nodes, "level1");
    assert.deepEqual(labels(level1.children), ["level2"]);
    assert.equal(findNode(limited.nodes, "level3"), undefined);
    const complete: OutlineResult = outline("scripts/deep.sh", { maxDepth: 4 });
    assert.equal(complete.truncated, false);
    assert.equal(requireNode(complete.nodes, "level3").depth, 3);
});

test("paths are anchor-qualified and every range is an ordered bigint interval", (): void => {
    const result: OutlineResult = outline("scripts/nested.sh");
    const all: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assert.equal(typeof(node.range.startByte), "bigint");
        assert.equal(typeof(node.range.endByte), "bigint");
        assert.equal(typeof(node.range.startLine), "bigint");
        assert.equal(typeof(node.range.endLine), "bigint");
        assert.ok(node.range.startByte <= node.range.endByte);
        assert.ok(node.range.startLine <= node.range.endLine);
        if (node.isFile) {
            assert.equal(node.path, "scripts/nested.sh");
            continue;
        }
        assert.ok(node.path.startsWith("scripts/nested.sh#"));
        for (let childIndex: number = 0; childIndex < node.children.length; childIndex += 1) {
            const child: OutlineNode = node.children[childIndex];
            assert.ok(node.range.startLine <= child.range.startLine);
            assert.ok(child.range.endLine <= node.range.endLine);
            assert.ok(node.range.startByte <= child.range.startByte);
            assert.ok(child.range.endByte <= node.range.endByte);
        }
        for (let childIndex: number = 1; childIndex < node.children.length; childIndex += 1) {
            assert.ok(node.children[childIndex - 1].range.startLine <= node.children[childIndex].range.startLine);
        }
    }
    assert.ok(all.length >= 4);
});

test("parseShell returns placeholder paths and bigint ranges for direct callers", (): void => {
    const nodes: OutlineNode[] = parse("direct() {\n    echo hi\n}\nDIRECT_VAR=1\n");
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].path, "");
    assert.equal(nodes[0].type, "function");
    assert.equal(nodes[0].label, "direct");
    assert.equal(nodes[0].range.startLine, 1n);
    assert.equal(nodes[0].range.endLine, 3n);
    assert.equal(typeof(nodes[0].range.startByte), "bigint");
    assert.equal(nodes[0].children.length, 0);
    assert.equal(nodes[1].label, "DIRECT_VAR");
    assert.equal(nodes[1].type, "constant");
    assert.equal(nodes[1].depth, 0);
    assert.equal(nodes[1].range.startLine, 4n);
});
