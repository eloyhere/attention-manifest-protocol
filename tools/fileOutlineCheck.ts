#!/usr/bin/env node
/**
 * Outline extraction checks.
 *
 * The fixtures are written to a private temporary directory and removed after
 * the run; no fixture code is executed and no third-party parser is involved.
 * Every assertion uses the public `buildOutline` entry point, so the sandbox
 * resolution, charset gate, anchor construction, UTF-8 ranges, truncation and
 * strategy selection are all exercised together.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { FilesystemError } from "../src/file/errors.ts";
import { ByteLineIndex } from "../src/syntax/byteIndex.ts";
import { buildFileNode } from "../src/file/file.ts";
import { buildDirectoryNode } from "../src/file/directory.ts";
import { buildOutline, OutlineStrategies, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineAnchor, OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import { OutlineKeywordRegistry } from "../src/outline/outlineKeywords.ts";
import { registerOfficeOutlineParser } from "../src/outline/outlineStrategies.ts";
import type { DirectoryNode, FileNode } from "../src/file/types.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";
import { rawDigest, rawTextDigest } from "../src/fingerprint/raw.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-outline-"));
const RootSpec: SessionRoot = { id: "root.outline", path: Root, writable: true, exclude: [] };
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
const outline: (path: string, options?: OutlineOptions, anchor?: OutlineAnchor) => OutlineResult = (
    path: string, options: OutlineOptions = {}, anchor?: OutlineAnchor,
): OutlineResult => buildOutline(Sandbox, path, options, anchor);

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
 * Markdown fixture: front matter, ATX headings, a fenced block, a setext
 * heading and a last heading that closes the first one.
 */
const MarkdownText: string = [
    "---",
    'title: "Outline Spec"',
    "---",
    "",
    "# Top",
    "",
    "## Child",
    "",
    "```sh",
    "# not a heading",
    "```",
    "",
    "### Grand",
    "",
    "Setext Title",
    "------------",
    "",
    "## Second",
].join("\n");

/**
 * TypeScript fixture with an interface, a class, a decoy string and exports.
 */
const TypeScriptText: string = [
    "export interface Shape {",
    "    area(): number;",
    "}",
    "",
    "export class Circle implements Shape {",
    "    private radius: number;",
    "    constructor(radius: number) {",
    "        this.radius = radius;",
    "    }",
    "    area(): number {",
    "        return 3 * this.radius * this.radius;",
    "    }",
    "}",
    "",
    'const DECOY = "class Fake { notReal: string }";',
    "",
    "export const compute = (value: number): number => value * 2;",
    "export function plain(input: string): string {",
    "    return input;",
    "}",
    "export default Circle;",
].join("\n");

fixture("docs/guide.md", MarkdownText);
fixture("src/circle.ts", TypeScriptText);
fixture("src/greet.js", ["export function greet(name) {", "    return `hi ${name}`;", "}"].join("\n"));
fixture("src/division.ts", [
    "const ratio = (1 + 2) / 2; const pattern = /[a{]/;",
    "",
    "export class AfterRegex {",
    "    run(): number {",
    "        return 1;",
    "    }",
    "}",
].join("\n"));
fixture("src/calc.py", [
    '"""Module docstring with class Fake and def hidden()."""',
    "",
    "class Calculator:",
    '    """A calculator."""',
    "",
    "    def __init__(self, value):",
    "        self.value = value",
    "",
    "    @staticmethod",
    "    def add(self, other):",
    "        return self.value + other",
    "",
    "def helper():",
    "    return 1",
].join("\n"));
fixture("src/App.java", [
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
    '        return "class Fake { " + name;',
    "    }",
    "",
    "    public static class Nested {",
    "        public void inner() {",
    "        }",
    "    }",
    "}",
].join("\n"));
fixture("src/parser.cpp", [
    "#include <string>",
    "",
    "#define MAX_SIZE 16",
    "",
    "namespace demo {",
    "",
    "class Parser {",
    "public:",
    "    Parser();",
    "    int parse(const std::string &input);",
    "private:",
    "    int cursor;",
    "};",
    "",
    "int Parser::parse(const std::string &input) {",
    "    return 0;",
    "}",
    "",
    "}",
].join("\n"));
fixture("src/Greeter.cs", [
    "namespace Demo.App {",
    "    public class Greeter {",
    "        public string Name { get; set; }",
    "",
    "        public Greeter(string name) {",
    "            Name = name;",
    "        }",
    "",
    "        public string Greet() {",
    '            return "class Fake { }";',
    "        }",
    "    }",
    "}",
].join("\n"));
fixture("data/app.json", ["{", '  "name": "demo",', '  "version": "1.0.0",', '  "scripts": {', '    "build": "tsc"', "  }", "}"].join("\n"));
fixture("data/settings.jsonc", ["{", "  // a comment mentioning \"fake\": 1", '  "alpha": 1,', '  "beta": 2,', "}"].join("\n"));
fixture("data/broken.json", ["{", '  "gamma": 1,', "  /* broken */", '  "delta": 2', "}"].join("\n"));
fixture("data/style.css", ["/* fake { } */", ":root {", "    --brand: #ff0000;", "}", "body, .card {", "    color: var(--brand);", "}"].join("\n"));
fixture("data/theme.scss", ["$brand: #111;", "", ".button {", "    color: $brand;", "}"].join("\n"));
fixture("data/attrs.css", ["/* leading comment */", 'a[href="https://example.test/x"] {', "    color: red;", "}"].join("\n"));
fixture("docs/paper.tex", [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\part{Foundations}",
    "\\chapter{Start}",
    "\\section{Intro}",
    "Text with 50\\% done.",
    "\\subsection{Detail}",
    "\\begin{figure}",
    "\\caption{A}",
    "\\end{figure}",
    "\\end{document}",
].join("\n"));
fixture("data/package.json", [
    "{",
    '  "name": "demo-app",',
    '  "version": "1.2.3",',
    '  "scripts": {',
    '    "build": "tsc -p ."',
    "  },",
    '  "workspaces": ["packages/*"],',
    '  "dependencies": {',
    '    "left-pad": "^1.3.0"',
    "  },",
    '  "devDependencies": {',
    '    "typescript": "^5.0.0"',
    "  }",
    "}",
].join("\n"));
fixture("pom.xml", [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<project>",
    "    <modelVersion>4.0.0</modelVersion>",
    "    <groupId>com.example</groupId>",
    "    <artifactId>demo</artifactId>",
    "    <version>1.0.0</version>",
    "    <modules>",
    "        <module>core</module>",
    "    </modules>",
    "    <dependencies>",
    "        <dependency>",
    "            <groupId>org.example</groupId>",
    "            <artifactId>lib</artifactId>",
    "            <version>2.0.0</version>",
    "            <scope>test</scope>",
    "        </dependency>",
    "    </dependencies>",
    "    <build>",
    "        <plugins>",
    "            <plugin>",
    "                <groupId>org.apache.maven.plugins</groupId>",
    "                <artifactId>maven-compiler-plugin</artifactId>",
    "                <version>3.13.0</version>",
    "            </plugin>",
    "        </plugins>",
    "    </build>",
    "</project>",
].join("\n"));
fixture("CMakeLists.txt", [
    "cmake_minimum_required(VERSION 3.20)",
    "project(Demo VERSION 1.0)",
    "",
    "add_library(core STATIC src/core.cpp)",
    "add_executable(app src/main.cpp)",
    "add_subdirectory(tests)",
    "target_link_libraries(app PRIVATE core)",
    'option(DEMO_TESTS "Enable tests" ON)',
].join("\n"));
fixture("build.gradle", [
    "plugins {",
    '    id("java")',
    '    id("application") version "8.5"',
    "}",
    "",
    "dependencies {",
    '    implementation("org.slf4j:slf4j-api:2.0.0")',
    '    testImplementation project(":core")',
    "}",
    "",
    "tasks {",
    '    register("integrationTest")',
    "}",
    "",
    'rootProject.name = "gradle-demo"',
].join("\n"));
fixture("inline/build.gradle", [
    'plugins { id("java") }',
    'dependencies { implementation("org.slf4j:slf4j-api:2.0.0") }',
    'tasks { register("integrationTest") }',
    'rootProject.name = "inline-demo"',
].join("\n"));
fixture("Cargo.toml", [
    "[package]",
    'name = "demo-core"',
    'version = "0.2.0"',
    "",
    "[dependencies]",
    'serde = "1.0"',
    "",
    "[dev-dependencies]",
    'tempfile = "3.10"',
    "",
    "[[bin]]",
    'name = "demo-cli"',
].join("\n"));
fixture("pyproject.toml", [
    "[project]",
    'name = "demo-py"',
    'version = "0.1.0"',
    "dependencies = [",
    '    "requests>=2.31",',
    '    "httpx",',
    "]",
    "",
    "[project.scripts]",
    'demo = "demo.cli:main"',
    "",
    "[project.optional-dependencies]",
    'dev = ["pytest>=8"]',
    "",
    "[tool.poetry.group.dev.dependencies]",
    'ruff = "^0.5"',
].join("\n"));
fixture("ordered/package.json", [
    "{",
    '  "name": "ordered-app",',
    '  "devDependencies": {',
    '    "left-pad": "2.0.0"',
    "  },",
    '  "dependencies": {',
    '    "left-pad": "1.0.0"',
    "  },",
    '  "scripts": {',
    '    "build": "tsc"',
    "  }",
    "}",
].join("\n"));
fixture("fm.md", ["---", 'title: "C# Guide" # inline comment', "---", "", "# Body", ""].join("\n"));
fixture("go.mod", ["module example.com/demo", "", "go 1.22", "", "require (", "    github.com/stretchr/testify v1.9.0", ")", "", "replace example.com/old => example.com/new v2.0.0"].join("\n"));
fixture("Makefile", ["CC = gcc", "", "build: main.o", "\t$(CC) -o app main.o", "", "clean:", "\trm -f app"].join("\n"));
fixture("book.txt", ["卷一 起始", "第一章 相遇", "第一节 初见", "正文段落。", "THE ENDING", "=========="].join("\n"));
fixture("notes.unknown", "plain words only\nno headings here\n");
fixture("README", "readme prose only\n");
fixture("many.md", ["# Alpha", "", "# Beta", "", "# Gamma", "", "# Delta", "", "# Epsilon", "", "# Zeta", ""].join("\n"));
fixture("escape.md", ["# 100% #done", "", "## a/b and c", ""].join("\n"));
fixture("deep.md", ["# One", "", "## Two", "", "### Three", ""].join("\n"));
fixture("anchored.md", "# Anchored\n");
fixture("mutable.md", "# First\n");
fixture("blob.bin", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("huge.md", Buffer.alloc(4 * 1024 * 1024 + 1, 97));
fixture("book/ch1.md", "# Chapter One\n");
fixture("book/ch2.md", "# Chapter Two\n");
fixture("book/notes.txt", "notes\n");
fixture("book/sub/intro.md", "# Intro\n");
fixture("config.xml", '<config><entry id="alpha">one</entry><entry id="beta">two</entry></config>');
fixture("outline.opml", '<opml><body><outline text="Chapter A"><outline text="Section A1"/></outline></body></opml>');
const OfficeBytes: Uint8Array = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
fixture("report.docx", OfficeBytes);

test("Markdown headings nest by # count, fenced # is ignored and front matter titles are depth-0", (): void => {
    const result: OutlineResult = outline("docs/guide.md");
    assert.equal(result.strategy, "markdown");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "markdown");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "docs/guide.md");
    assert.equal(anchor.label, "guide.md");
    assert.ok(anchor.file !== (void 0));
    assert.equal(anchor.file!.path, "docs/guide.md");
    assert.equal(anchor.file!.fingerprint, result.fingerprint);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(MarkdownText, "utf8")));
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), 18);
    assert.deepEqual(labels(anchor.children), ["Outline Spec", "Top"]);
    const title: OutlineNode = requireNode(result.nodes, "Outline Spec");
    assert.equal(title.type, "heading");
    assert.equal(title.depth, 1);
    assert.equal(title.detail, "front matter");
    assert.equal(title.path, "docs/guide.md#Outline Spec");
    assertRange(title, MarkdownText, 2, 4);
    const top: OutlineNode = requireNode(result.nodes, "Top");
    assert.equal(top.depth, 1);
    assert.equal(top.path, "docs/guide.md#Top");
    assertRange(top, MarkdownText, 5, 18);
    const child: OutlineNode = requireNode(result.nodes, "Child");
    assert.equal(child.depth, 2);
    assert.equal(child.path, "docs/guide.md#Top.Child");
    assertRange(child, MarkdownText, 7, 14);
    const grand: OutlineNode = requireNode(result.nodes, "Grand");
    assert.equal(grand.depth, 3);
    assert.equal(grand.path, "docs/guide.md#Top.Child.Grand");
    assertRange(grand, MarkdownText, 13, 14);
    const setext: OutlineNode = requireNode(result.nodes, "Setext Title");
    assert.equal(setext.depth, 2);
    assertRange(setext, MarkdownText, 15, 17);
    assert.equal(findNode(result.nodes, "not a heading"), undefined);
    const markdownIndex: ByteLineIndex = new ByteLineIndex(MarkdownText);
    assert.match(outlineNodeFingerprint(anchor), /^sha256:[0-9a-f]{64}$/);
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
    assert.equal(outlineNodeFingerprint(grand), rawTextDigest(markdownIndex.slice(grand.range)));
    assert.equal(outlineNodeFingerprint(child), rawTextDigest(markdownIndex.slice(child.range)));
    assert.notEqual(outlineNodeFingerprint(child), outlineNodeFingerprint(grand));
    assert.notEqual(outlineNodeFingerprint(child), outlineNodeFingerprint(top));
    const frontMatter: OutlineResult = outline("fm.md");
    const hashTitle: OutlineNode = requireNode(frontMatter.nodes, "C# Guide");
    assert.equal(hashTitle.detail, "front matter");
    assert.equal(hashTitle.depth, 1);
    assert.equal(Number(hashTitle.range.startLine), 2);
});

test("TypeScript reports classes, members, functions and interfaces while masked strings stay invisible", (): void => {
    const result: OutlineResult = outline("src/circle.ts");
    assert.equal(result.strategy, "typescript");
    assert.equal(result.category, "code");
    assert.equal(result.language, "typescript");
    assert.equal(result.target, "file");
    const shape: OutlineNode = requireNode(result.nodes, "Shape");
    assert.equal(shape.type, "interface");
    assert.equal(shape.depth, 1);
    assertRange(shape, TypeScriptText, 1, 3);
    const circle: OutlineNode = requireNode(result.nodes, "Circle");
    assert.equal(circle.type, "class");
    assert.equal(circle.depth, 1);
    assert.equal(circle.path, "src/circle.ts#Circle");
    assertRange(circle, TypeScriptText, 5, 13);
    assert.deepEqual(labels(circle.children), ["radius", "constructor", "area"]);
    const radius: OutlineNode = requireNode(circle.children, "radius");
    assert.equal(radius.type, "property");
    assert.equal(radius.depth, 2);
    assertRange(radius, TypeScriptText, 6, 6);
    const area: OutlineNode = requireNode(circle.children, "area");
    assert.equal(area.type, "method");
    assert.equal(area.path, "src/circle.ts#Circle.area");
    assertRange(area, TypeScriptText, 10, 12);
    const compute: OutlineNode = requireNode(result.nodes, "compute");
    assert.equal(compute.type, "function");
    assertRange(compute, TypeScriptText, 17, 17);
    const plain: OutlineNode = requireNode(result.nodes, "plain");
    assert.equal(plain.type, "function");
    assertRange(plain, TypeScriptText, 18, 20);
    const defaultExport: OutlineNode = requireNode(result.nodes, "default");
    assert.equal(defaultExport.type, "constant");
    assertRange(defaultExport, TypeScriptText, 21, 21);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
    assert.equal(findNode(result.nodes, "hidden"), undefined);
    assert.equal(findNode(result.nodes, "notReal"), undefined);
});

test("JavaScript uses the same declaration scanner with the javascript language tag", (): void => {
    const result: OutlineResult = outline("src/greet.js");
    assert.equal(result.strategy, "javascript");
    assert.equal(result.category, "code");
    assert.equal(result.language, "javascript");
    const node: OutlineNode = requireNode(result.nodes, "greet");
    assert.equal(node.type, "function");
    assertRange(node, "export function greet(name) {\n    return `hi ${name}`;\n}", 1, 3);
});

test("division before a regex literal does not hide declarations after it", (): void => {
    const result: OutlineResult = outline("src/division.ts");
    assert.equal(result.strategy, "typescript");
    const after: OutlineNode = requireNode(result.nodes, "AfterRegex");
    assert.equal(after.type, "class");
    assert.equal(after.depth, 1);
    assert.deepEqual(labels(after.children), ["run"]);
    assert.equal(findNode(result.nodes, "pattern"), undefined);
});

test("Python nests classes and functions by indentation and ignores def inside a docstring", (): void => {
    const result: OutlineResult = outline("src/calc.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.category, "code");
    assert.equal(result.language, "python");
    const calculator: OutlineNode = requireNode(result.nodes, "Calculator");
    assert.equal(calculator.type, "class");
    assert.equal(calculator.depth, 1);
    assert.equal(calculator.path, "src/calc.py#Calculator");
    assert.deepEqual(labels(calculator.children), ["__init__", "add"]);
    const init: OutlineNode = requireNode(calculator.children, "__init__");
    assert.equal(init.type, "method");
    assert.equal(init.depth, 2);
    assert.equal(Number(init.range.startLine), 6);
    assert.equal(Number(init.range.endLine), 7);
    const add: OutlineNode = requireNode(calculator.children, "add");
    assert.equal(Number(add.range.startLine), 10);
    assert.equal(Number(add.range.endLine), 11);
    const helper: OutlineNode = requireNode(result.nodes, "helper");
    assert.equal(helper.depth, 1);
    assert.equal(Number(helper.range.startLine), 13);
    assert.equal(Number(helper.range.endLine), 14);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
    assert.equal(findNode(result.nodes, "hidden"), undefined);
});

test("Java reports package, class, fields and methods without seeing class inside a string", (): void => {
    const result: OutlineResult = outline("src/App.java");
    assert.equal(result.strategy, "java");
    assert.equal(result.category, "code");
    const javaPackage: OutlineNode = requireNode(result.nodes, "com.example.app");
    assert.equal(javaPackage.type, "package");
    assert.equal(javaPackage.depth, 1);
    assertRange(javaPackage, ["package com.example.app;", "", "public class Greeter {", "    private final String name;", "", "    public Greeter(String name) {", "        this.name = name;", "    }", "", "    public String greet() {", '        return "class Fake { " + name;', "    }", "}"].join("\n"), 1, 1);
    const greeter: OutlineNode = requireNode(result.nodes, "Greeter");
    assert.equal(greeter.type, "class");
    assert.equal(greeter.depth, 1);
    assert.deepEqual(labels(greeter.children), ["name", "Greeter", "greet", "Nested"]);
    const greet: OutlineNode = requireNode(greeter.children, "greet");
    assert.equal(greet.type, "method");
    assert.equal(Number(greet.range.startLine), 10);
    assert.equal(Number(greet.range.endLine), 12);
    const nested: OutlineNode = requireNode(greeter.children, "Nested");
    assert.equal(nested.type, "class");
    assert.equal(nested.depth, 2);
    assert.equal(Number(nested.range.startLine), 14);
    assert.deepEqual(labels(nested.children), ["inner"]);
    const inner: OutlineNode = requireNode(nested.children, "inner");
    assert.equal(inner.type, "method");
    assert.equal(inner.depth, 3);
    assert.equal(Number(inner.range.startLine), 15);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
});

test("C++ distinguishes macro, namespace, class, method and function nodes", (): void => {
    const result: OutlineResult = outline("src/parser.cpp");
    assert.equal(result.strategy, "cpp");
    assert.equal(result.category, "code");
    assert.equal(result.language, "cpp");
    const macro: OutlineNode = requireNode(result.nodes, "MAX_SIZE");
    assert.equal(macro.type, "macro");
    assert.equal(macro.depth, 1);
    const namespace: OutlineNode = requireNode(result.nodes, "demo");
    assert.equal(namespace.type, "namespace");
    assert.equal(namespace.depth, 1);
    const parser: OutlineNode = requireNode(namespace.children, "Parser");
    assert.equal(parser.type, "class");
    assert.equal(parser.depth, 2);
    const declaration: OutlineNode = requireNode(parser.children, "parse");
    assert.equal(declaration.type, "method");
    assert.equal(Number(declaration.range.startLine), 10);
    assert.equal(Number(declaration.range.endLine), 10);
    const definition: OutlineNode = requireNode(namespace.children, "Parser::parse");
    assert.equal(definition.type, "method");
    assert.equal(Number(definition.range.startLine), 15);
    assert.equal(Number(definition.range.endLine), 17);
});

test("C# nests namespace, type, property, constructor and method by brace depth", (): void => {
    const result: OutlineResult = outline("src/Greeter.cs");
    assert.equal(result.strategy, "csharp");
    assert.equal(result.category, "code");
    assert.equal(result.language, "csharp");
    const namespace: OutlineNode = requireNode(result.nodes, "Demo.App");
    assert.equal(namespace.type, "namespace");
    assert.equal(namespace.depth, 1);
    const greeter: OutlineNode = requireNode(namespace.children, "Greeter");
    assert.equal(greeter.type, "class");
    assert.equal(greeter.depth, 2);
    assert.deepEqual(labels(greeter.children), ["Name", "Greeter", "Greet"]);
    const name: OutlineNode = requireNode(greeter.children, "Name");
    assert.equal(name.type, "property");
    assert.equal(name.depth, 3);
    const greet: OutlineNode = requireNode(greeter.children, "Greet");
    assert.equal(Number(greet.range.startLine), 9);
    assert.equal(Number(greet.range.endLine), 11);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
});

test("JSON reports top-level key lines, and JSONC tolerates comments and trailing commas", (): void => {
    const plainText: string = ["{", '  "name": "demo",', '  "version": "1.0.0",', '  "scripts": {', '    "build": "tsc"', "  }", "}"].join("\n");
    const result: OutlineResult = outline("data/app.json");
    assert.equal(result.strategy, "json");
    assert.equal(result.category, "data");
    assert.equal(result.language, "json");
    assert.equal(result.truncated, false);
    const name: OutlineNode = requireNode(result.nodes, "name");
    assert.equal(name.type, "key");
    assertRange(name, plainText, 2, 2);
    const version: OutlineNode = requireNode(result.nodes, "version");
    assertRange(version, plainText, 3, 3);
    const scripts: OutlineNode = requireNode(result.nodes, "scripts");
    assertRange(scripts, plainText, 4, 7);
    const jsonc: OutlineResult = outline("data/settings.jsonc");
    assert.equal(jsonc.strategy, "json");
    const alpha: OutlineNode = requireNode(jsonc.nodes, "alpha");
    assert.equal(Number(alpha.range.startLine), 3);
    const beta: OutlineNode = requireNode(jsonc.nodes, "beta");
    assert.equal(Number(beta.range.startLine), 4);
    const broken: OutlineResult = outline("data/broken.json");
    assert.equal(broken.strategy, "json");
    requireNode(broken.nodes, "gamma");
    requireNode(broken.nodes, "delta");
});

test("CSS reports top-level selectors and custom properties", (): void => {
    const text: string = ["/* fake { } */", ":root {", "    --brand: #ff0000;", "}", "body, .card {", "    color: var(--brand);", "}"].join("\n");
    const result: OutlineResult = outline("data/style.css");
    assert.equal(result.strategy, "css");
    assert.equal(result.category, "code");
    assert.equal(result.language, "css");
    const root: OutlineNode = requireNode(result.nodes, ":root");
    assert.equal(root.type, "section");
    assert.equal(root.depth, 1);
    assertRange(root, text, 2, 4);
    const brand: OutlineNode = requireNode(root.children, "--brand");
    assert.equal(brand.type, "property");
    assert.equal(brand.detail, "#ff0000");
    assert.equal(brand.depth, 2);
    assertRange(brand, text, 3, 3);
    const rule: OutlineNode = requireNode(result.nodes, "body, .card");
    assert.equal(rule.depth, 1);
    assert.equal(rule.children.length, 0);
    const scss: OutlineResult = outline("data/theme.scss");
    assert.equal(scss.strategy, "scss");
    assert.equal(scss.language, "scss");
    const variable: OutlineNode = requireNode(scss.nodes, "$brand");
    assert.equal(variable.type, "property");
    assert.equal(variable.depth, 1);
    const attributes: OutlineResult = outline("data/attrs.css");
    const attributeSelector: OutlineNode = requireNode(attributes.nodes, 'a[href="https://example.test/x"]');
    assert.equal(attributeSelector.type, "section");
    assert.equal(Number(attributeSelector.range.startLine), 2);
});

test("TeX maps part/chapter/section ranks and pairs begin/end environments", (): void => {
    const text: string = [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\part{Foundations}",
        "\\chapter{Start}",
        "\\section{Intro}",
        "Text with 50\\% done.",
        "\\subsection{Detail}",
        "\\begin{figure}",
        "\\caption{A}",
        "\\end{figure}",
        "\\end{document}",
    ].join("\n");
    const result: OutlineResult = outline("docs/paper.tex");
    assert.equal(result.strategy, "tex");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "tex");
    const part: OutlineNode = requireNode(result.nodes, "Foundations");
    assert.equal(part.type, "part");
    assert.equal(part.depth, 1);
    const chapter: OutlineNode = requireNode(result.nodes, "Start");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    const section: OutlineNode = requireNode(result.nodes, "Intro");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    const subsection: OutlineNode = requireNode(result.nodes, "Detail");
    assert.equal(subsection.type, "subsection");
    assert.equal(subsection.depth, 4);
    const figure: OutlineNode = requireNode(result.nodes, "figure");
    assert.equal(figure.type, "environment");
    assertRange(figure, text, 8, 10);
    assert.equal(findNode(result.nodes, "document"), undefined);
});

test("package.json emits a package anchor with scripts, workspaces and dependency coordinates", (): void => {
    const result: OutlineResult = outline("data/package.json");
    assert.equal(result.strategy, "npm");
    assert.equal(result.category, "project");
    assert.equal(result.language, "json");
    const packageNode: OutlineNode = requireNode(result.nodes, "demo-app");
    assert.equal(packageNode.type, "package");
    assert.equal(packageNode.detail, "demo-app@1.2.3");
    assert.equal(Number(packageNode.range.startLine), 2);
    const build: OutlineNode = requireNode(result.nodes, "build");
    assert.equal(build.type, "script");
    assert.equal(build.detail, "tsc -p .");
    assert.equal(Number(build.range.startLine), 5);
    const workspace: OutlineNode = requireNode(result.nodes, "packages/*");
    assert.equal(workspace.type, "workspace");
    assert.equal(Number(workspace.range.startLine), 7);
    const leftPad: OutlineNode = requireNode(result.nodes, "left-pad");
    assert.equal(leftPad.type, "dependency");
    assert.equal(leftPad.detail, "^1.3.0");
    assert.equal(Number(leftPad.range.startLine), 9);
    const typescript: OutlineNode = requireNode(result.nodes, "typescript");
    assert.equal(typescript.detail, "^5.0.0");
    assert.equal(Number(typescript.range.startLine), 12);
});

test("npm lines are section-scoped when groups are out of order or names repeat", (): void => {
    const result: OutlineResult = outline("ordered/package.json");
    const dependencies: OutlineNode[] = flatten(result.nodes).filter((node: OutlineNode): boolean => node.label === "left-pad");
    assert.equal(dependencies.length, 2);
    const lines: number[] = dependencies.map((node: OutlineNode): number => Number(node.range.startLine)).sort((left: number, right: number): number => left - right);
    assert.deepEqual(lines, [4, 7]);
    const details: string[] = dependencies.map((node: OutlineNode): string => node.detail ?? "");
    assert.deepEqual(details.sort(), ["1.0.0", "2.0.0"]);
    const build: OutlineNode = requireNode(result.nodes, "build");
    assert.equal(Number(build.range.startLine), 10);
    assert.equal(requireNode(result.nodes, "ordered-app").type, "package");
});

test("pom.xml reports modules, dependency coordinates and plugins", (): void => {
    const result: OutlineResult = outline("pom.xml");
    assert.equal(result.strategy, "maven");
    assert.equal(result.category, "project");
    assert.equal(result.language, "xml");
    const project: OutlineNode = requireNode(result.nodes, "demo");
    assert.equal(project.type, "workspace");
    assert.equal(project.detail, "com.example:demo:1.0.0");
    assert.equal(Number(project.range.startLine), 2);
    const module: OutlineNode = requireNode(result.nodes, "core");
    assert.equal(module.type, "module");
    assert.equal(Number(module.range.startLine), 8);
    const dependency: OutlineNode = requireNode(result.nodes, "lib");
    assert.equal(dependency.type, "dependency");
    assert.equal(dependency.detail, "org.example:lib:2.0.0:test");
    assert.equal(Number(dependency.range.startLine), 11);
    const plugin: OutlineNode = requireNode(result.nodes, "maven-compiler-plugin");
    assert.equal(plugin.type, "plugin");
    assert.equal(plugin.detail, "org.apache.maven.plugins:maven-compiler-plugin:3.13.0");
    assert.equal(Number(plugin.range.startLine), 20);
});

test("CMakeLists reports project, targets, subdirectories, link dependencies and options", (): void => {
    const result: OutlineResult = outline("CMakeLists.txt");
    assert.equal(result.strategy, "cmake");
    assert.equal(result.category, "project");
    assert.equal(result.language, "cmake");
    const project: OutlineNode = requireNode(result.nodes, "Demo");
    assert.equal(project.type, "workspace");
    assert.equal(project.detail, "project");
    const library: OutlineNode = requireNode(result.nodes, "core");
    assert.equal(library.type, "target");
    assert.equal(library.detail, "library:STATIC");
    assert.equal(Number(library.range.startLine), 4);
    const executable: OutlineNode = requireNode(result.nodes, "app");
    assert.equal(executable.detail, "executable");
    const tests: OutlineNode = requireNode(result.nodes, "tests");
    assert.equal(tests.type, "module");
    assert.equal(tests.detail, "subdirectory");
    const coreNodes: OutlineNode[] = flatten(result.nodes).filter((node: OutlineNode): boolean => node.label === "core");
    assert.equal(coreNodes.length, 2);
    assert.ok(coreNodes.some((node: OutlineNode): boolean => node.type === "target"));
    assert.ok(coreNodes.some((node: OutlineNode): boolean => node.type === "dependency"));
    const option: OutlineNode = requireNode(result.nodes, "DEMO_TESTS");
    assert.equal(option.type, "variable");
    assert.equal(option.detail, "option");
});

test("build.gradle reports plugins, dependencies, tasks and rootProject", (): void => {
    const result: OutlineResult = outline("build.gradle");
    assert.equal(result.strategy, "gradle");
    assert.equal(result.category, "project");
    assert.equal(result.language, "groovy");
    const workspace: OutlineNode = requireNode(result.nodes, "gradle-demo");
    assert.equal(workspace.type, "workspace");
    assert.equal(workspace.detail, "gradle");
    const java: OutlineNode = requireNode(result.nodes, "java");
    assert.equal(java.type, "plugin");
    const application: OutlineNode = requireNode(result.nodes, "application");
    assert.equal(application.detail, "plugin:8.5");
    const slf4j: OutlineNode = requireNode(result.nodes, "slf4j-api");
    assert.equal(slf4j.type, "dependency");
    assert.equal(slf4j.detail, "org.slf4j:slf4j-api:2.0.0");
    const core: OutlineNode = requireNode(result.nodes, ":core");
    assert.equal(core.detail, "testImplementation:project");
    const task: OutlineNode = requireNode(result.nodes, "integrationTest");
    assert.equal(task.type, "task");
    assert.equal(Number(task.range.startLine), 12);
    const inline: OutlineResult = outline("inline/build.gradle");
    assert.equal(inline.strategy, "gradle");
    assert.equal(requireNode(inline.nodes, "java").type, "plugin");
    assert.equal(requireNode(inline.nodes, "slf4j-api").type, "dependency");
    assert.equal(requireNode(inline.nodes, "integrationTest").type, "task");
    assert.equal(requireNode(inline.nodes, "inline-demo").type, "workspace");
});

test("Cargo.toml reports package, dependency tables and bin targets", (): void => {
    const result: OutlineResult = outline("Cargo.toml");
    assert.equal(result.strategy, "cargo");
    assert.equal(result.category, "project");
    assert.equal(result.language, "toml");
    const packageNode: OutlineNode = requireNode(result.nodes, "demo-core");
    assert.equal(packageNode.type, "package");
    assert.equal(packageNode.detail, "demo-core 0.2.0");
    const serde: OutlineNode = requireNode(result.nodes, "serde");
    assert.equal(serde.type, "dependency");
    assert.equal(serde.detail, "1.0");
    assert.equal(Number(serde.range.startLine), 6);
    const tempfile: OutlineNode = requireNode(result.nodes, "tempfile");
    assert.equal(tempfile.detail, "3.10");
    const target: OutlineNode = requireNode(result.nodes, "demo-cli");
    assert.equal(target.type, "target");
    assert.equal(target.detail, "bin");
});

test("pyproject.toml reports project dependencies, scripts and optional groups", (): void => {
    const result: OutlineResult = outline("pyproject.toml");
    assert.equal(result.strategy, "pyproject");
    assert.equal(result.category, "project");
    assert.equal(result.language, "toml");
    const packageNode: OutlineNode = requireNode(result.nodes, "demo-py");
    assert.equal(packageNode.type, "package");
    assert.equal(packageNode.detail, "demo-py 0.1.0");
    const requests: OutlineNode = requireNode(result.nodes, "requests>=2.31");
    assert.equal(requests.type, "dependency");
    assert.equal(requests.detail, "runtime");
    assert.equal(Number(requests.range.startLine), 5);
    const httpx: OutlineNode = requireNode(result.nodes, "httpx");
    assert.equal(Number(httpx.range.startLine), 6);
    const script: OutlineNode = requireNode(result.nodes, "demo");
    assert.equal(script.type, "script");
    assert.equal(script.detail, "demo.cli:main");
    const pytest: OutlineNode = requireNode(result.nodes, "pytest>=8");
    assert.equal(pytest.detail, "dev");
    const ruff: OutlineNode = requireNode(result.nodes, "ruff");
    assert.equal(ruff.type, "dependency");
    assert.equal(ruff.detail, "dev");
});

test("go.mod reports module, requires and replaces", (): void => {
    const result: OutlineResult = outline("go.mod");
    assert.equal(result.strategy, "gomod");
    assert.equal(result.category, "project");
    const module: OutlineNode = requireNode(result.nodes, "example.com/demo");
    assert.equal(module.type, "module");
    assert.equal(module.detail, "module");
    const dependency: OutlineNode = requireNode(result.nodes, "github.com/stretchr/testify");
    assert.equal(dependency.type, "dependency");
    assert.equal(dependency.detail, "v1.9.0");
    assert.equal(Number(dependency.range.startLine), 6);
    const replace: OutlineNode = requireNode(result.nodes, "example.com/old");
    assert.equal(replace.type, "reference");
    assert.equal(replace.detail, "example.com/new");
});

test("Makefile reports targets with recipe coverage and variables", (): void => {
    const result: OutlineResult = outline("Makefile");
    assert.equal(result.strategy, "makefile");
    assert.equal(result.category, "project");
    assert.equal(result.language, "make");
    const variable: OutlineNode = requireNode(result.nodes, "CC");
    assert.equal(variable.type, "variable");
    assert.equal(variable.detail, "gcc");
    const build: OutlineNode = requireNode(result.nodes, "build");
    assert.equal(build.type, "target");
    assert.equal(build.detail, "main.o");
    assert.equal(Number(build.range.startLine), 3);
    assert.equal(Number(build.range.endLine), 5);
    const clean: OutlineNode = requireNode(result.nodes, "clean");
    assert.equal(Number(clean.range.startLine), 6);
});

test("plain text books derive part/chapter/section depth and honor CJK byte ranges", (): void => {
    const text: string = ["卷一 起始", "第一章 相遇", "第一节 初见", "正文段落。", "THE ENDING", "=========="].join("\n");
    const result: OutlineResult = outline("book.txt");
    assert.equal(result.strategy, "plainText");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "txt");
    const part: OutlineNode = requireNode(result.nodes, "卷一 起始");
    assert.equal(part.type, "part");
    assert.equal(part.depth, 1);
    assertRange(part, text, 1, 4);
    assert.equal(part.range.startByte, 0n);
    assert.ok(part.range.endByte - part.range.startByte > BigInt(Buffer.byteLength("卷一 起始", "utf8")));
    const chapter: OutlineNode = requireNode(result.nodes, "第一章 相遇");
    assert.equal(chapter.type, "chapter");
    assert.equal(chapter.depth, 2);
    assert.equal(Number(chapter.range.startLine), 2);
    assert.equal(Number(chapter.range.endLine), 4);
    const section: OutlineNode = requireNode(result.nodes, "第一节 初见");
    assert.equal(section.type, "section");
    assert.equal(section.depth, 3);
    const underlined: OutlineNode = requireNode(result.nodes, "THE ENDING");
    assert.equal(underlined.type, "heading");
    assert.equal(underlined.depth, 1);
    assertRange(underlined, text, 5, 6);
    assert.equal(findNode(result.nodes, "正文段落。"), undefined);
});

test("unknown extensions fall back to plainText with the extension as language", (): void => {
    const result: OutlineResult = outline("notes.unknown");
    assert.equal(result.strategy, "plainText");
    assert.equal(result.category, "prose");
    assert.equal(result.language, "unknown");
    assert.equal(result.nodes[0].isFile, true);
    assert.equal(result.nodes[0].children.length, 0);
    const readme: OutlineResult = outline("README");
    assert.equal(readme.strategy, "plainText");
    assert.equal(readme.language, "text");
    assert.equal(readme.nodes[0].children.length, 0);
});

test("maxNodes truncates explicitly and counts the anchor", (): void => {
    const limited: OutlineResult = outline("many.md", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.equal(limited.nodes[0].isFile, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["Alpha", "Beta"]);
    const complete: OutlineResult = outline("many.md", { maxNodes: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(complete.nodes[0].children.length, 6);
});

test("maxDepth drops deeper symbols and reports truncation", (): void => {
    const limited: OutlineResult = outline("deep.md", { maxDepth: 2 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["One"]);
    const one: OutlineNode = requireNode(limited.nodes, "One");
    assert.deepEqual(labels(one.children), ["Two"]);
    assert.equal(findNode(limited.nodes, "Three"), undefined);
    const complete: OutlineResult = outline("deep.md");
    assert.equal(complete.truncated, false);
    assert.equal(requireNode(complete.nodes, "Three").depth, 3);
});

test("binary files and files over the byte ceiling are refused with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("blob.bin");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("huge.md");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.md");
    });
    expectFilesystemError("not_found", (): void => {
        outline("docs/missing.md");
    });
});

test("a directory target returns a directory anchor and direct child anchors", (): void => {
    const ch1: FileNode = buildFileNode(RootSpec, "book/ch1.md");
    const ch2: FileNode = buildFileNode(RootSpec, "book/ch2.md");
    const notes: FileNode = buildFileNode(RootSpec, "book/notes.txt");
    const sub: DirectoryNode = buildDirectoryNode("book/sub", [buildFileNode(RootSpec, "book/sub/intro.md")]);
    const book: DirectoryNode = buildDirectoryNode("book", [ch1, ch2, notes, sub]);
    const result: OutlineResult = outline("book", { anchor: { directory: book } });
    assert.equal(result.target, "directory");
    assert.equal(result.strategy, "directory");
    assert.equal(result.category, "other");
    assert.equal(result.language, "directory");
    assert.equal(result.charset, "none");
    assert.equal(result.fingerprint, book.fingerprint);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isDirectory, true);
    assert.equal(anchor.isFile, false);
    assert.equal(anchor.type, "Directory");
    assert.equal(anchor.path, "book");
    assert.equal(anchor.label, "book");
    assert.equal(anchor.directory, book);
    assert.equal(anchor.range.endByte, book.bytes);
    assert.deepEqual(labels(anchor.children), ["sub", "ch1.md", "ch2.md", "notes.txt"]);
    assert.equal(anchor.children[0].isDirectory, true);
    assert.equal(anchor.children[0].path, "book/sub");
    assert.equal(anchor.children[0].children.length, 0);
    assert.equal(anchor.children[1].isFile, true);
    assert.equal(anchor.children[1].path, "book/ch1.md");
    assert.equal(anchor.children[1].children.length, 0);
    assert.equal(outlineNodeFingerprint(anchor), book.fingerprint);
    assert.equal(outlineNodeFingerprint(anchor.children[1]), ch1.fingerprint);
    const expanded: OutlineResult = outline("book", { anchor: { directory: book }, symbols: true });
    const chapter: OutlineNode = expanded.nodes[0].children[1];
    assert.equal(chapter.isFile, true);
    assert.deepEqual(labels(chapter.children), ["Chapter One"]);
    assert.equal(chapter.children[0].type, "heading");
    assert.equal(chapter.children[0].path, "book/ch1.md#Chapter One");
    assert.equal(expanded.nodes[0].children[0].children.length, 0);
});

test("a provided file anchor is reused instead of re-reading the file", (): void => {
    const anchor: FileNode = buildFileNode(RootSpec, "anchored.md");
    const result: OutlineResult = outline("anchored.md", { anchor: { file: anchor } });
    assert.equal(result.nodes[0].file, anchor);
    assert.equal(result.fingerprint, anchor.fingerprint);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength("# Anchored\n", "utf8")));
    assert.equal(requireNode(result.nodes, "Anchored").type, "heading");
});

test("symbol paths escape %, # and / so the anchor boundary stays unambiguous", (): void => {
    const result: OutlineResult = outline("escape.md");
    const root: OutlineNode = requireNode(result.nodes, "100% #done");
    assert.equal(root.path, "escape.md#100%25 %23done");
    const nested: OutlineNode = requireNode(result.nodes, "a/b and c");
    assert.equal(nested.path, "escape.md#100%25 %23done.a%2Fb and c");
    assert.equal(nested.depth, 2);
    assert.match(outlineNodeFingerprint(root), /^sha256:[0-9a-f]{64}$/);
});

test("results and nodes are freshly built and frozen", (): void => {
    const first: OutlineResult = outline("docs/guide.md");
    const second: OutlineResult = outline("docs/guide.md");
    assert.notEqual(first.nodes[0], second.nodes[0]);
    assert.ok(Object.isFrozen(first.nodes));
    assert.ok(Object.isFrozen(first.nodes[0]));
    assert.ok(Object.isFrozen(first.nodes[0].children));
    assert.ok(Object.isFrozen(first.nodes[0].children[0]));
    assert.equal(outlineNodeFingerprint(first.nodes[0].children[0]), outlineNodeFingerprint(second.nodes[0].children[0]));
    const all: OutlineNode[] = flatten(first.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        assert.match(outlineNodeFingerprint(all[index]), /^sha256:[0-9a-f]{64}$/);
    }
});

test("writing a file changes the file fingerprint and the node fingerprints", (): void => {
    const before: OutlineResult = outline("mutable.md");
    const beforeNode: OutlineNode = requireNode(before.nodes, "First");
    const beforeNodeFingerprint: string = outlineNodeFingerprint(beforeNode);
    fixture("mutable.md", "# First\n\nmore text\n");
    const after: OutlineResult = outline("mutable.md");
    const afterNode: OutlineNode = requireNode(after.nodes, "First");
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.notEqual(outlineNodeFingerprint(afterNode), beforeNodeFingerprint);
    assert.equal(afterNode.label, beforeNode.label);
    assert.equal(outlineNodeFingerprint(afterNode), rawTextDigest(new ByteLineIndex("# First\n\nmore text\n").slice(afterNode.range)));
    fixture("mutable.md", "# First\n");
});

test("XML and OPML documents become element and heading trees", (): void => {
    const xml: OutlineResult = outline("config.xml");
    assert.equal(xml.strategy, "xml");
    assert.equal(xml.category, "data");
    assert.equal(xml.language, "xml");
    const config: OutlineNode = requireNode(xml.nodes, "config");
    assert.equal(config.type, "key");
    assert.equal(config.depth, 1);
    assert.deepEqual(labels(config.children), ["entry", "entry"]);
    assert.equal(config.children[0].detail, "entry:alpha");
    const opml: OutlineResult = outline("outline.opml");
    assert.equal(opml.strategy, "opml");
    assert.equal(opml.category, "prose");
    const body: OutlineNode = requireNode(opml.nodes, "body");
    assert.equal(body.type, "heading");
    const chapter: OutlineNode = requireNode(opml.nodes, "Chapter A");
    assert.equal(chapter.type, "heading");
    assert.deepEqual(labels(chapter.children), ["Section A1"]);
});

test("the office strategy slot is registered and maps registered sections with document order", (): void => {
    assert.ok(OutlineStrategies.some((strategy: { readonly id: string; }): boolean => strategy.id === "office"));
    const skeleton: OutlineResult = outline("report.docx");
    assert.equal(skeleton.strategy, "office");
    assert.equal(skeleton.category, "data");
    assert.equal(skeleton.language, "office");
    assert.equal(skeleton.target, "file");
    assert.equal(skeleton.nodes[0].isFile, true);
    assert.equal(skeleton.nodes[0].children.length, 0);
    assert.match(skeleton.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const section: OutlineNode = {
        isFile: false,
        isDirectory: false,
        path: "",
        type: "section",
        range: { startByte: 0n, endByte: 0n, startLine: 1n, endLine: 2n },
        label: "Introduction",
        depth: 0,
        children: [],
    };
    registerOfficeOutlineParser((): OutlineNode[] => [section]);
    try {
        const withSections: OutlineResult = outline("report.docx");
        assert.equal(withSections.nodes[0].children.length, 1);
        assert.deepEqual(labels(withSections.nodes[0].children), ["Introduction"]);
        const mapped: OutlineNode = withSections.nodes[0].children[0];
        assert.equal(mapped.type, "section");
        assert.equal(Number(mapped.range.startLine), 1);
        assert.equal(Number(mapped.range.endLine), 2);
        assert.equal(mapped.range.startByte, 0n);
        assert.equal(mapped.range.endByte, BigInt(OfficeBytes.length));
        assert.equal(mapped.path, "report.docx#Introduction");
        assert.equal(outlineNodeFingerprint(mapped), rawDigest(OfficeBytes));
    } finally {
        registerOfficeOutlineParser(undefined);
    }
});

test("two classes expose class, property and method nodes", (): void => {
    fixture(
        "classes/two.ts",
        `export class A {
  x: number = 1;
  method(value: number): number { return value + 1; }
}
export class B {
  y = true;
  other(): void {}
}
`,
    );
    fixture(
        "classes/two.py",
        `class A:
    x = 1
    def method(self):
        return self.x

class B:
    y = True
    def other(self):
        pass
`,
    );
    fixture(
        "classes/two.go",
        `package demo
type A struct {
    X int
}
func (a A) Method() int { return a.X }
type B struct {
    Y bool
}
func (b B) Other() {}
`,
    );
    const typescript: OutlineResult = outline("classes/two.ts");
    const tsClasses: OutlineNode[] = typescript.nodes[0].children.filter((node: OutlineNode): boolean => node.type === "class");
    assert.equal(tsClasses.length, 2);
    assert.deepEqual(labels(tsClasses[0].children), ["x", "method"]);
    assert.deepEqual(labels(tsClasses[1].children), ["y", "other"]);
    const python: OutlineResult = outline("classes/two.py");
    const pyClasses: OutlineNode[] = python.nodes[0].children.filter((node: OutlineNode): boolean => node.type === "class");
    assert.equal(pyClasses.length, 2);
    assert.deepEqual(labels(pyClasses[0].children), ["x", "method"]);
    const go: OutlineResult = outline("classes/two.go");
    const goStructs: OutlineNode[] = go.nodes[0].children.filter((node: OutlineNode): boolean => node.type === "struct");
    assert.equal(goStructs.length, 2);
    assert.ok(labels(goStructs[0].children).includes("Method"));
    assert.ok(labels(goStructs[0].children).includes("X"));
});

test("global variables, global functions and static members are outline nodes", (): void => {
    fixture(
        "scope/globals.ts",
        `const globalConst = 1;
let globalLet = 2;
var globalVar = 3;
function globalFn(value: number): number { return value + 1; }

class A {
  static count = 0;
  static make(): A { return new A(); }
  value = 1;
  method(): void {}
}
`,
    );
    fixture(
        "scope/Globals.java",
        `public class Globals {
  static int count = 0;
  static void reset() { count = 0; }
  int value = 1;
  void inc() { value++; }
}
`,
    );
    fixture(
        "scope/Globals.cs",
        `public class Globals {
  public static int Count = 0;
  public static void Reset() { Count = 0; }
  public int Value { get; set; }
  public void Inc() { Value++; }
}
`,
    );
    const typescript: OutlineResult = outline("scope/globals.ts");
    assert.deepEqual(labels(typescript.nodes[0].children), ["globalConst", "globalLet", "globalVar", "globalFn", "A"]);
    const classA: OutlineNode = requireNode(typescript.nodes[0].children, "A");
    const staticProperty: OutlineNode = requireNode(classA.children, "count");
    const staticMethod: OutlineNode = requireNode(classA.children, "make");
    assert.deepEqual(staticProperty.modifiers, ["static"]);
    assert.deepEqual(staticMethod.modifiers, ["static"]);
    assert.equal(requireNode(classA.children, "value").modifiers, (void 0));
    const java: OutlineResult = outline("scope/Globals.java");
    const javaClass: OutlineNode = requireNode(java.nodes[0].children, "Globals");
    assert.deepEqual(requireNode(javaClass.children, "count").modifiers, ["static"]);
    assert.deepEqual(requireNode(javaClass.children, "reset").modifiers, ["static"]);
    const csharp: OutlineResult = outline("scope/Globals.cs");
    const csClass: OutlineNode = requireNode(csharp.nodes[0].children, "Globals");
    assert.deepEqual(requireNode(csClass.children, "Count").modifiers, ["public", "static"]);
    assert.deepEqual(requireNode(csClass.children, "Reset").modifiers, ["public", "static"]);
    fixture("scope/globals.py", "GLOBAL = 1\n\ndef helper():\n    return GLOBAL\n");
    const python: OutlineResult = outline("scope/globals.py");
    assert.deepEqual(labels(python.nodes[0].children), ["GLOBAL", "helper"]);
    fixture("scope/globals.go", "package demo\n\nvar Global = 1\nconst Limit = 2\n\nfunc Helper() {}\n");
    const go: OutlineResult = outline("scope/globals.go");
    assert.deepEqual(labels(go.nodes[0].children), ["demo", "Global", "Limit", "Helper"]);
});

test("the outline keyword registry is extensible and classifies modifiers", (): void => {
    const registry = new OutlineKeywordRegistry();
    registry.register("modifier", "static");
    registry.register("variable", "const");
    assert.deepEqual(registry.leadingModifiers("static readonly value = 1"), ["static"]);
    assert.equal(registry.isModifier("static"), true);
    assert.equal(registry.isVariableKeyword("const"), true);
    assert.equal(registry.categoryOf("value"), (void 0));
    assert.throws((): unknown => registry.register("function", "static"), /already registered/);
    assert.throws((): unknown => registry.register("modifier", "bad-word"), /invalid outline keyword/);
});

test("Vue single-file components expose template, script and style blocks", (): void => {
    fixture(
        "components/App.vue",
        `<template>
  <h1>Hello</h1>
  <section id="intro"><h2>Intro</h2></section>
</template>
<script setup lang="ts">
const count = 1;
function increment() {}
</script>
<style scoped>
.a { color: red; }
</style>
`,
    );
    const result: OutlineResult = outline("components/App.vue");
    assert.equal(result.strategy, "vue");
    assert.equal(result.language, "vue");
    const blocks: string[] = result.nodes[0].children.map((node: OutlineNode): string => node.label);
    assert.deepEqual(blocks, ["template", "script (setup, ts)", "style (scoped)"]);
    const template: OutlineNode = result.nodes[0].children[0];
    assert.deepEqual(labels(template.children), ["Hello", "intro"]);
    const script: OutlineNode = result.nodes[0].children[1];
    assert.deepEqual(labels(script.children), ["count", "increment"]);
    assert.ok(result.nodes[0].range.startLine >= 1n);
    assert.ok(result.nodes[0].range.startByte < result.nodes[0].range.endByte);
});
