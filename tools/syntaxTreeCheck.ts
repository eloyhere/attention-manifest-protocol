#!/usr/bin/env node
/**
 * Lossless syntax-tree checks.
 *
 * Every fixture is parsed as data; none is imported, evaluated or executed. The
 * `process.exit(1)` fixture is the proof: the test process only survives when
 * the parser really treats the file as text.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PathSandbox } from "../src/file/path.ts";
import { buildSyntaxTree } from "../src/file/syntaxTree.ts";
import { buildSyntaxTreeFromText } from "../src/syntax/syntaxTree.ts";
import { createSyntaxRegistry, DefaultSyntaxRegistry } from "../src/syntax/syntaxRegistry.ts";
import { filesystemToolDefinitions } from "../src/protocol/filesystem.ts";
import { globalFilesystemToolDefinitions } from "../src/protocol/globalFilesystem.ts";
import { ToolIds } from "../src/naming/index.ts";
import type { SyntaxNode } from "../src/syntax/syntaxTree.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-syntax-"));
const Sandbox: PathSandbox = new PathSandbox([{ id: "root.syntax", path: Root, writable: true, exclude: [] }]);

after((): void => {
    rmSync(Root, { recursive: true, force: true });
});

const fixture: (path: string, text: string) => string = (path: string, text: string): string => {
    const absolute: string = join(Root, path);
    writeFileSync(absolute, text);
    return absolute;
};

const walk: (node: SyntaxNode) => SyntaxNode[] = (node: SyntaxNode): SyntaxNode[] => [
    node,
    ...node.children.flatMap((child: SyntaxNode): SyntaxNode[] => walk(child)),
];

test("a TypeScript file becomes a declaration tree with exact ranges", (): void => {
    fixture(
        "a.ts",
        `import { x } from "./x";
export class A {
  method(value: string): number {
    if (value) { return 1; }
    return 0;
  }
}
export function f(input: number): number { return input + 1; }
`,
    );
    const tree = buildSyntaxTree(Sandbox, "a.ts");
    assert.equal(tree.language, "typescript");
    assert.ok(tree.tokenCount > 20);
    assert.ok(tree.nodeCount >= 5);
    const nodes: SyntaxNode[] = walk(tree.root);
    const names: string[] = nodes.map((node: SyntaxNode): string => node.name ?? "").filter((name: string): boolean => name.length > 0);
    assert.ok(names.includes("A"));
    assert.ok(names.includes("method"));
    assert.ok(names.includes("f"));
    for (let index: number = 0; index < tree.tokens.length; index += 1) {
        const token = tree.tokens[index];
        assert.ok(token.range.startByte <= token.range.endByte);
        assert.ok(token.range.startLine <= token.range.endLine);
        if (index > 0) {
            assert.ok(token.range.startByte >= tree.tokens[index - 1].range.startByte);
        }
    }
    assert.match(tree.fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("Python indentation nests class methods and keeps imports separate", (): void => {
    fixture(
        "b.py",
        `import os

class B:
    def method(self, value):
        if value:
            return 1
        return 0

def f(value):
    return value + 1
`,
    );
    const tree = buildSyntaxTree(Sandbox, "b.py");
    assert.equal(tree.language, "python");
    assert.equal(tree.root.children[0].kind, "Import");
    assert.equal(tree.root.children[1].kind, "Class");
    assert.equal(tree.root.children[1].name, "B");
    assert.equal(tree.root.children[1].children[0].kind, "Function");
    assert.equal(tree.root.children[1].children[0].name, "method");
    assert.equal(tree.root.children[2].kind, "Function");
    assert.equal(tree.root.children[2].name, "f");
});

test("markup becomes a balanced tag tree and JSON keeps all tokens", (): void => {
    fixture("c.html", "<!doctype html><html><body><h1>Hello</h1><p>Text</p></body></html>");
    fixture("d.json", '{"a": 1, "b": [true, null]}');
    fixture("e.md", "# Title\n\nParagraph\n");
    const html = buildSyntaxTree(Sandbox, "c.html");
    assert.equal(html.language, "html");
    assert.ok(walk(html.root).some((node: SyntaxNode): boolean => node.kind === "Tag" && node.name === "h1"));
    assert.ok(walk(html.root).some((node: SyntaxNode): boolean => node.kind === "Tag" && node.name === "body"));
    const json = buildSyntaxTree(Sandbox, "d.json");
    assert.equal(json.language, "json");
    assert.ok(json.tokenCount >= 10);
    const markdown = buildSyntaxTree(Sandbox, "e.md");
    assert.equal(markdown.language, "markdown");
    assert.equal(markdown.root.children[0].kind, "Heading");
    assert.equal(markdown.root.children[0].name, "Title");
});

test("a hostile file is parsed as data, never executed", (): void => {
    fixture("evil.ts", 'process.exit(1);\nthrow new Error("executed");\n');
    const before: number = statSync(join(Root, "evil.ts")).mtimeMs;
    const tree = buildSyntaxTree(Sandbox, "evil.ts");
    const after: number = statSync(join(Root, "evil.ts")).mtimeMs;
    assert.equal(tree.language, "typescript");
    assert.ok(tree.tokens.some((token): boolean => token.text === "process"));
    assert.equal(before, after);
});

test("bounds and sandbox errors are explicit", (): void => {
    fixture("big.txt", "a\n".repeat(2048));
    assert.throws((): unknown => buildSyntaxTree(Sandbox, "big.txt", { maxBytes: 1024 }), /quota_exceeded/);
    assert.throws((): unknown => buildSyntaxTree(Sandbox, "../escape.ts"), /path_escape|invalid_path/);
    fixture("blob.bin", "\u0000\u0001\u0002");
    assert.throws((): unknown => buildSyntaxTree(Sandbox, "blob.bin"), /binary_file/);
    const tree = buildSyntaxTree(Sandbox, "big.txt", { maxTokens: 3 });
    assert.equal(tree.truncated, true);
});

test("registry validates ids, extensions and custom languages", (): void => {
    assert.throws((): unknown => DefaultSyntaxRegistry.registerLanguage({ id: "Bad", family: "code", extensions: ["x"] }), /invalid syntax language/);
    assert.throws((): unknown => DefaultSyntaxRegistry.registerNodeKind({ id: "bad", category: "token" }), /invalid syntax node kind/);
    const custom = createSyntaxRegistry();
    custom.registerTokenKind({ id: "word", description: "word" });
    custom.registerNodeKind({ id: "SourceFile", category: "container" });
    custom.registerLanguage({ id: "lisp", family: "code", extensions: ["lisp"], keywords: ["def", "let"] });
    assert.equal(custom.languageOf("a.lisp"), "lisp");
    assert.equal(custom.keywordsOf("lisp").has("def"), true);
    const tree = buildSyntaxTreeFromText("a.lisp", "(def x 1)", "lisp", { registry: custom });
    assert.equal(tree.language, "lisp");
    assert.ok(tree.tokenCount > 0);
});

test("the AST tool is advertised locally and globally", (): void => {
    const local = filesystemToolDefinitions().find((tool): boolean => tool.name === ToolIds.filesystemAst);
    const global = globalFilesystemToolDefinitions().find((tool): boolean => tool.name === ToolIds.globalfsAst);
    assert.ok(local !== (void 0));
    assert.ok(global !== (void 0));
    assert.equal(local.risk, "read");
    assert.equal(global.risk, "read");
    assert.equal(local.inputSchema.properties !== (void 0), true);
});

test("Unicode scalar tokens keep exact UTF-8 byte offsets", (): void => {
    const tree = buildSyntaxTreeFromText("emoji.ts", "😀 class A {}", "typescript");
    assert.equal(tree.tokens[0].text, "😀");
    assert.equal(tree.tokens[0].range.startByte, 0n);
    assert.equal(tree.tokens[0].range.endByte, 4n);
    assert.equal(tree.tokens[1].range.startByte, 5n);
    assert.equal(tree.tokens[1].range.endByte, 10n);
    const unmatched = buildSyntaxTreeFromText("unmatched.ts", "\ud800 x", "typescript");
    assert.equal(unmatched.tokens[0].text, "\ud800");
    assert.equal(unmatched.tokens[1].range.startByte, 4n);
});

test("malformed and deep syntax stays bounded without losing scanned tokens", (): void => {
    const empty = buildSyntaxTreeFromText("empty.ts", "", "typescript");
    assert.equal(empty.nodeCount, 1);
    assert.equal(empty.tokenCount, 0);
    assert.equal(buildSyntaxTreeFromText("cut.ts", "\"x\\", "typescript").tokens[0].text, "\"x\\");
    assert.throws((): unknown => buildSyntaxTreeFromText("x.ts", "x", "typescript", { maxNodes: -1 }), /invalid_arguments/);
    assert.throws((): unknown => buildSyntaxTreeFromText("x.ts", "x", "typescript", { maxTokens: 0 }), /invalid_arguments/);
    const declarations = buildSyntaxTreeFromText("deep.ts", "class A { ".repeat(6000) + "}".repeat(6000), "typescript");
    assert.equal(declarations.truncated, true);
    assert.ok(declarations.nodeCount <= 257);
    const headings = buildSyntaxTreeFromText("many.md", "# a\n".repeat(10000), "markdown", { maxNodes: 1 });
    assert.equal(headings.truncated, true);
    assert.equal(headings.nodeCount, 1);
    const decorated = buildSyntaxTreeFromText("decorated.py", "@decorator\n", "python");
    assert.deepEqual(decorated.root.tokens.map((token): string => token.text), ["@", "decorator"]);
});

test("markup self-closing siblings and hostile tag nesting do not overflow", (): void => {
    const siblings = buildSyntaxTreeFromText("view.html", "<div/><p>x</p>", "html");
    assert.deepEqual(siblings.root.children.map((node): string | undefined => node.name), ["div", "p"]);
    const deep = buildSyntaxTreeFromText("deep.html", "<a>".repeat(6000) + "</a>".repeat(6000), "html");
    assert.equal(deep.truncated, true);
    assert.ok(deep.nodeCount <= 20000);
});

test("read-only parser is deterministic for the same bytes", (): void => {
    const text: string = "class A { method() {} }\n";
    const first = buildSyntaxTreeFromText("same.ts", text, "typescript");
    const second = buildSyntaxTreeFromText("same.ts", text, "typescript");
    assert.deepEqual(first.tokens.map((token): string => token.text), second.tokens.map((token): string => token.text));
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.nodeCount, second.nodeCount);
    assert.equal(readFileSync(join(Root, "a.ts"), "utf8").length > 0, true);
});
