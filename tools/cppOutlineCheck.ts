#!/usr/bin/env node
/**
 * C/C++ outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; no fixture is compiled or executed. All assertions go through the
 * public `buildOutline` entry point, so sandbox resolution, charset sniffing,
 * strategy selection, anchor construction, UTF-8 byte ranges, depth/count
 * bounds and truncation are exercised together with `parseCFamily`.
 *
 * The parser is a bounded hand-written scanner, not a C++ front end, so this
 * file separates two things:
 *
 * 1. behavior the scanner deliberately implements, pinned as green assertions;
 * 2. behavior the scanner is expected to implement but currently does not,
 *    pinned by failing `[defect]` tests at the bottom. The source is not
 *    modified here, so those tests fail and print expected-vs-actual, which is
 *    the recorded defect list in `docs/testing/languages/cppReport.md`.
 *
 * Run with:
 * `node tools/cppOutlineCheck.ts`
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

const Root: string = mkdtempSync(join(tmpdir(), "amp-cpp-outline-"));
const RootSpec: SessionRoot = { id: "root.cppOutline", path: Root, writable: true, exclude: [] };
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
 * Run the public outline builder against the fixture sandbox.
 */
const outline: (path: string, options?: OutlineOptions) => OutlineResult = (path: string, options: OutlineOptions = {}): OutlineResult =>
    buildOutline(Sandbox, path, options);

/**
 * Preorder flattening of an outline tree (the file anchor is included).
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
 * First node with one exact label, depth first.
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
 * Labels of one node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] => nodes.map((node: OutlineNode): string => node.label);

/**
 * Child node that starts on one exact line.
 */
const childAtLine: (nodes: readonly OutlineNode[], line: number) => OutlineNode | undefined = (
    nodes: readonly OutlineNode[],
    line: number,
): OutlineNode | undefined => nodes.find((node: OutlineNode): boolean => Number(node.range.startLine) === line);

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
 * Assert one node's line and byte range.
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
 * C++ header fixture: several containers, methods, a static member callable,
 * data members, a template-less class and a trailing namespace close comment.
 */
const ParserHpp: string = [
    "#pragma once",
    "#include <string>",
    "",
    "#define MAX_DEPTH 8",
    "",
    "namespace demo {",
    "",
    "class Parser {",
    "public:",
    "    Parser(int depth);",
    "    int parse(const std::string &input);",
    "    static Parser make();",
    "    static int count;",
    "private:",
    "    int cursor;",
    "};",
    "",
    "struct Options {",
    "    int limit;",
    "};",
    "",
    "enum class Mode {",
    "    Fast,",
    "    Safe",
    "};",
    "",
    "int helper(int value);",
    "",
    "}  // namespace demo",
].join("\n");

/**
 * C fixture: a typedef'd struct, a plain struct with fields, an enum, a
 * prototype, and two function definitions.
 */
const CSource: string = [
    "#include <stddef.h>",
    "",
    "#define POINT_LIMIT 32",
    "",
    "typedef struct Point {",
    "    int x;",
    "    int y;",
    "} Point;",
    "",
    "struct Rect {",
    "    struct Point origin;",
    "    int width;",
    "    int height;",
    "};",
    "",
    "enum Shape {",
    "    SHAPE_CIRCLE,",
    "    SHAPE_SQUARE",
    "};",
    "",
    "int add(int a, int b);",
    "",
    "static int internal_helper(void) {",
    "    return 0;",
    "}",
    "",
    "int area(const struct Rect *rect) {",
    "    return rect->width * rect->height;",
    "}",
].join("\n");

/**
 * Nested namespaces and types plus template forms.
 */
const ContainersCpp: string = [
    "namespace outer {",
    "namespace inner {",
    "",
    "class Alpha {",
    "public:",
    "    class Nested {",
    "        void deep();",
    "    };",
    "    void first();",
    "};",
    "",
    "struct Beta {",
    "    struct Gamma {",
    "    };",
    "};",
    "",
    "}  // namespace inner",
    "}  // namespace outer",
    "",
    "template <typename T>",
    "class Box {",
    "public:",
    "    void put();",
    "};",
    "",
    "template <typename T>",
    "T maximum(const T &a, const T &b) {",
    "    return a;",
    "}",
    "",
    "template <typename T> class Pair {",
    "};",
    "",
    "template <typename T> T inlineMax(const T &a, const T &b) {",
    "    return a;",
    "}",
    "",
    "int free_function(void);",
].join("\n");

/**
 * Member forms: constructor/destructor declarations, `explicit`, `= default`,
 * one-line bodies, a static callable, static data and an instance field.
 */
const MembersCpp: string = [
    "class Widget {",
    "public:",
    "    Widget();",
    "    explicit Widget(int size);",
    "    ~Widget();",
    "    virtual ~Widget() = default;",
    "    Widget(int size) {}",
    "    void draw();",
    "    void drawInline() {}",
    "    static int instances;",
    "    static Widget create();",
    "private:",
    "    int size_;",
    "};",
].join("\n");

/**
 * Allman brace style: the signature line ends with `)` and the body brace is on
 * the next line.
 */
const AllmanCpp: string = ["class Allman {", "public:", "    void foo()", "    {", "    }", "    int bar() const;", "};"].join("\n");

/**
 * Decoys inside line/block comments, string literals, character literals and a
 * preprocessor line; the three real declarations must survive.
 */
const MaskingCpp: string = [
    "// class LineComment { int x; };",
    "/* struct BlockComment {",
    "    void ghost();",
    "}; */",
    '#include "class IncludeFake {"',
    "#define GHOST struct Ghost",
    'const char *text = "class StringFake { void s(); }";',
    "const char open = '{';",
    "const char close = '}';",
    "const char quote = '\\'';",
    "",
    "class Real {",
    "public:",
    "    void method();",
    "};",
    "",
    'const char *url = "http://example.test/class/Fake";',
    "class AfterUrl {",
    "};",
].join("\n");

/**
 * Classic C header: include guard plus `extern "C"` prototype block.
 */
const ApiHeader: string = [
    "#ifndef API_H",
    "#define API_H",
    "",
    "#ifdef __cplusplus",
    'extern "C" {',
    "#endif",
    "",
    "int api_open(const char *path);",
    "void api_close(int handle);",
    "",
    "typedef struct api_ctx api_ctx;",
    "",
    "#ifdef __cplusplus",
    "}",
    "#endif",
    "",
    "#endif",
].join("\n");

/**
 * Same prototypes without the `extern "C"` wrapper, as a control.
 */
const ApiFlat: string = ["#ifndef API_FLAT_H", "#define API_FLAT_H", "", "int api_open(const char *path);", "void api_close(int handle);", "", "#endif"].join(
    "\n",
);

/**
 * CRLF file with one method whose brace sits on the signature line.
 */
const CrlfText: string = ["class Crlf {", "public:", "    void go() {", "        return;", "    }", "};", ""].join("\r\n");

/**
 * UTF-8 BOM file; the BOM is three bytes on disk and is stripped by decode.
 */
const BomBody: string = ["class Bom {", "    void tick();", "};", ""].join("\n");
const BomBytes: Uint8Array = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomBody, "utf8")]);

/**
 * UTF-8 file with CJK comments and a CJK class name (not an ASCII identifier).
 */
const UnicodeCpp: string = [
    "// 中文注释：class 伪类 { } 不应成为节点",
    "class Wide {",
    "    // 方法注释：void 伪造() { }",
    "    void run();",
    "};",
    'const char *greeting = "你好，世界 class 假 { }";',
    "class Tail {",
    "};",
    "class 数据类 {",
    "};",
].join("\n");

/**
 * Top-level functions, qualified out-of-line definitions, one-line bodies and a
 * functional-initialized variable.
 */
const FunctionsCpp: string = [
    "#include <string>",
    "",
    "int add(int a, int b);",
    "",
    "static int clamp_value(int value) {",
    "    return value;",
    "}",
    "",
    "void log_only(void) {}",
    "",
    "ns::Thing::Thing(int x) {}",
    "",
    "ns::Thing::~Thing() {",
    "}",
    "",
    "int ns::Util::compute(int x) {",
    "    return x;",
    "}",
    "",
    'std::string name("demo");',
    "",
    "auto trailing() -> int {",
    "    return 1;",
    "}",
    "",
    "int (*callback)(int);",
    "",
    "struct Ops {",
    "    bool operator==(const Ops &other) const;",
    "};",
].join("\n");

/**
 * Macro forms at top level and inside a namespace/class, plus non-macro
 * preprocessor lines.
 */
const MacrosCpp: string = [
    "#define BUFFER_SIZE 256",
    "#    define SPACED_MACRO 1",
    "#define SQUARE(x) ((x) * (x))",
    "#define MULTI_LINE(a) \\",
    "    ((a) + 1)",
    '#define LABEL "demo-value"',
    "#include <cstddef>",
    "#pragma once",
    "#undef BUFFER_SIZE",
    "",
    "namespace util {",
    "#define NESTED_MACRO 2",
    "class Holder {",
    "#define CLASS_MACRO 3",
    "};",
    "}",
].join("\n");

/**
 * Forward declarations, a union, enums, `final`, a derived template base,
 * `using` and `typedef`.
 */
const TypesCpp: string = [
    "class Forward;",
    "struct Record;",
    "union Value {",
    "    int i;",
    "    float f;",
    "};",
    "enum Plain {",
    "    A,",
    "    B",
    "};",
    "enum class Scoped : int {",
    "    X",
    "};",
    "struct Final final {",
    "};",
    "class Derived : public Base<T> {",
    "};",
    "using Alias = Record;",
    "typedef int Handle;",
].join("\n");

/**
 * Anonymous namespace: no namespace node is produced, but the enclosed class is
 * still found at brace depth 1.
 */
const AnonymousCpp: string = ["namespace {", "class Hidden {", "    void assist();", "};", "}", "int exposed(void);"].join("\n");

/**
 * Code behind `#if 0` and `#if defined(...)` is still scanned.
 */
const DeadCpp: string = ["#if 0", "class Disabled {", "};", "#endif", "#if defined(ENABLE_X)", "class Maybe {", "};", "#endif", "class Enabled {", "};"].join(
    "\n",
);

/**
 * A macro whose replacement list opens a brace that is never closed, which
 * inflates the brace depth of every later line.
 */
const UnbalancedCpp: string = ["#define BEGIN_BLOCK {", "class Leaked {", "    void leak();", "};"].join("\n");

/**
 * Truncation fixture: namespace, two classes, three methods and a tail
 * function, so count and depth bounds are observable on the same tree.
 */
const LimitsCpp: string = [
    "namespace ns {",
    "class A {",
    "    void a();",
    "    void b();",
    "};",
    "class B {",
    "    void c();",
    "};",
    "}",
    "int tail(void);",
].join("\n");

/**
 * Single-line header used by the extension matrix.
 */
const ExtensionText: string = "int add_two(int a, int b);\n";

/**
 * 3003-line file: the scan keeps only the first 3000 lines, so `late` must be
 * invisible while `Early` (line 1) survives.
 */
const ScanCapLines: string[] = ["class Early {", "};"];
for (let index: number = 0; index < 3000; index += 1) {
    ScanCapLines.push(`// filler ${index}`);
}
ScanCapLines.push("int late(void);");
const ScanCapText: string = ScanCapLines.join("\n");
const ScanCapTotal: number = ScanCapLines.length;

fixture("cpp/parser.hpp", ParserHpp);
fixture("c/geometry.c", CSource);
fixture("cpp/containers.cpp", ContainersCpp);
fixture("cpp/members.cpp", MembersCpp);
fixture("cpp/allman.cpp", AllmanCpp);
fixture("cpp/masking.cpp", MaskingCpp);
fixture("c/api.h", ApiHeader);
fixture("c/api_flat.h", ApiFlat);
fixture("edge/crlf.hpp", CrlfText);
fixture("edge/empty.cpp", new Uint8Array(0));
fixture("edge/include-only.hpp", '#include <vector>\n#include "local.h"\n');
fixture("edge/bom.hpp", BomBytes);
fixture("edge/unicode.cpp", UnicodeCpp);
fixture("edge/tail-no-newline.c", "int tail(void);");
fixture("edge/scan-cap.cpp", ScanCapText);
fixture("cpp/functions.cpp", FunctionsCpp);
fixture("cpp/macros.cpp", MacrosCpp);
fixture("cpp/types.cpp", TypesCpp);
fixture("cpp/anonymous.cpp", AnonymousCpp);
fixture("cpp/dead.cpp", DeadCpp);
fixture("cpp/unbalanced.cpp", UnbalancedCpp);
fixture("limits/graph.cpp", LimitsCpp);
fixture("cpp/specialization.cpp", ["template <>", "class Fixed<int> {", "};"].join("\n"));
fixture("bad/binary.cpp", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("bad/oversized.c", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

const ExtensionCases: ReadonlyArray<{ readonly path: string; readonly strategy: string; readonly language: string }> = [
    { path: "ext/sample.c", strategy: "c", language: "c" },
    { path: "ext/sample.h", strategy: "c", language: "c" },
    { path: "ext/sample.cpp", strategy: "cpp", language: "cpp" },
    { path: "ext/sample.cc", strategy: "cpp", language: "cpp" },
    { path: "ext/sample.cxx", strategy: "cpp", language: "cpp" },
    { path: "ext/sample.hpp", strategy: "cpp", language: "cpp" },
    { path: "ext/sample.hh", strategy: "cpp", language: "cpp" },
    { path: "ext/sample.hxx", strategy: "cpp", language: "cpp" },
];
for (let index: number = 0; index < ExtensionCases.length; index += 1) {
    fixture(ExtensionCases[index].path, ExtensionText);
}

test("C++ header exposes namespace, class, struct, enum, methods and macro with anchored paths", (): void => {
    const result: OutlineResult = outline("cpp/parser.hpp");
    assert.equal(result.strategy, "cpp");
    assert.equal(result.category, "code");
    assert.equal(result.language, "cpp");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "cpp/parser.hpp");
    assert.equal(anchor.label, "parser.hpp");
    assert.deepEqual(labels(anchor.children), ["MAX_DEPTH", "demo"]);
    const macro: OutlineNode = requireNode(anchor.children, "MAX_DEPTH");
    assert.equal(macro.type, "macro");
    assert.equal(macro.depth, 1);
    assert.equal(macro.detail, "#define MAX_DEPTH 8");
    assert.equal(macro.path, "cpp/parser.hpp#MAX_DEPTH");
    assertRange(macro, ParserHpp, 4, 4);
    const namespaceNode: OutlineNode = requireNode(anchor.children, "demo");
    assert.equal(namespaceNode.type, "namespace");
    assert.equal(namespaceNode.depth, 1);
    assert.equal(namespaceNode.path, "cpp/parser.hpp#demo");
    assert.equal(namespaceNode.detail, "namespace demo {");
    assertRange(namespaceNode, ParserHpp, 6, 29);
    assert.deepEqual(labels(namespaceNode.children), ["Parser", "Options", "Mode", "helper"]);
    const parser: OutlineNode = requireNode(namespaceNode.children, "Parser");
    assert.equal(parser.type, "class");
    assert.equal(parser.depth, 2);
    assert.equal(parser.path, "cpp/parser.hpp#demo.Parser");
    assertRange(parser, ParserHpp, 8, 16);
    assert.deepEqual(labels(parser.children), ["Parser", "parse", "make", "count", "cursor"]);
    const parse: OutlineNode = requireNode(parser.children, "parse");
    assert.equal(parse.type, "method");
    assert.equal(parse.depth, 3);
    assert.equal(parse.path, "cpp/parser.hpp#demo.Parser.parse");
    assert.equal(parse.detail, "int parse(const std::string &input);");
    assertRange(parse, ParserHpp, 11, 11);
    const make: OutlineNode = requireNode(parser.children, "make");
    assert.equal(make.type, "method");
    assert.equal(make.depth, 3);
    assert.equal(make.path, "cpp/parser.hpp#demo.Parser.make");
    assertRange(make, ParserHpp, 12, 12);
    const constructor: OutlineNode = requireNode(parser.children, "Parser");
    assert.equal(constructor.type, "method");
    assert.equal(constructor.depth, 3);
    assert.equal(constructor.path, "cpp/parser.hpp#demo.Parser.Parser");
    assert.equal(constructor.detail, "Parser(int depth);");
    assertRange(constructor, ParserHpp, 10, 10);
    const count: OutlineNode = requireNode(parser.children, "count");
    assert.equal(count.type, "property");
    assert.equal(count.depth, 3);
    assert.equal(count.path, "cpp/parser.hpp#demo.Parser.count");
    assertRange(count, ParserHpp, 13, 13);
    const cursor: OutlineNode = requireNode(parser.children, "cursor");
    assert.equal(cursor.type, "property");
    assertRange(cursor, ParserHpp, 15, 15);
    const options: OutlineNode = requireNode(namespaceNode.children, "Options");
    assert.equal(options.type, "struct");
    assert.equal(options.depth, 2);
    assert.equal(options.path, "cpp/parser.hpp#demo.Options");
    assertRange(options, ParserHpp, 18, 20);
    assert.deepEqual(labels(options.children), ["limit"]);
    assert.equal(requireNode(options.children, "limit").type, "property");
    const mode: OutlineNode = requireNode(namespaceNode.children, "Mode");
    assert.equal(mode.type, "enum");
    assert.equal(mode.depth, 2);
    assert.equal(mode.path, "cpp/parser.hpp#demo.Mode");
    assertRange(mode, ParserHpp, 22, 25);
    assert.equal(mode.children.length, 0);
    const helper: OutlineNode = requireNode(namespaceNode.children, "helper");
    assert.equal(helper.type, "function");
    assert.equal(helper.depth, 2);
    assert.equal(helper.path, "cpp/parser.hpp#demo.helper");
    assertRange(helper, ParserHpp, 27, 27);
    assert.equal(
        anchor.children.some((node: OutlineNode): boolean => node.label === "Parser"),
        false,
    );
});

test("C source reports typedef structs, fields, enums, macros, prototypes and functions", (): void => {
    const result: OutlineResult = outline("c/geometry.c");
    assert.equal(result.strategy, "c");
    assert.equal(result.category, "code");
    assert.equal(result.language, "c");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["POINT_LIMIT", "Point", "Rect", "Shape", "add", "internal_helper", "area"]);
    const macro: OutlineNode = requireNode(anchor.children, "POINT_LIMIT");
    assert.equal(macro.type, "macro");
    assert.equal(Number(macro.range.startLine), 3);
    const point: OutlineNode = requireNode(anchor.children, "Point");
    assert.equal(point.type, "struct");
    assert.equal(point.depth, 1);
    assert.equal(point.path, "c/geometry.c#Point");
    assertRange(point, CSource, 5, 8);
    assert.deepEqual(labels(point.children), ["x", "y"]);
    const rect: OutlineNode = requireNode(anchor.children, "Rect");
    assert.equal(rect.type, "struct");
    assert.equal(rect.depth, 1);
    assert.equal(rect.path, "c/geometry.c#Rect");
    assertRange(rect, CSource, 10, 14);
    assert.deepEqual(labels(rect.children), ["origin", "width", "height"]);
    assert.equal(requireNode(rect.children, "origin").type, "property");
    assertRange(requireNode(rect.children, "width"), CSource, 12, 12);
    const shape: OutlineNode = requireNode(anchor.children, "Shape");
    assert.equal(shape.type, "enum");
    assertRange(shape, CSource, 16, 19);
    assert.equal(shape.children.length, 0);
    const add: OutlineNode = requireNode(anchor.children, "add");
    assert.equal(add.type, "function");
    assert.equal(add.path, "c/geometry.c#add");
    assertRange(add, CSource, 21, 21);
    const helper: OutlineNode = requireNode(anchor.children, "internal_helper");
    assert.equal(helper.type, "function");
    assertRange(helper, CSource, 23, 25);
    const area: OutlineNode = requireNode(anchor.children, "area");
    assert.equal(area.type, "function");
    assertRange(area, CSource, 27, 29);
    assert.equal(findNode(anchor.children, "SHAPE_CIRCLE"), undefined);
});

test("the extension matrix selects c for .c/.h and cpp for .cpp/.cc/.cxx/.hpp/.hh/.hxx", (): void => {
    for (let index: number = 0; index < ExtensionCases.length; index += 1) {
        const item: { readonly path: string; readonly strategy: string; readonly language: string } = ExtensionCases[index];
        const result: OutlineResult = outline(item.path);
        assert.equal(result.strategy, item.strategy, `strategy for ${item.path}`);
        assert.equal(result.language, item.language, `language for ${item.path}`);
        assert.equal(result.category, "code", `category for ${item.path}`);
        const node: OutlineNode = requireNode(result.nodes, "add_two");
        assert.equal(node.type, "function", `type for ${item.path}`);
        assert.equal(node.path, `${item.path}#add_two`, `path for ${item.path}`);
    }
});

test("nested namespaces, nested classes/structs and template classes nest by brace depth", (): void => {
    const result: OutlineResult = outline("cpp/containers.cpp");
    assert.equal(result.strategy, "cpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["outer", "Box", "maximum", "Pair", "inlineMax", "free_function"]);
    const outer: OutlineNode = requireNode(anchor.children, "outer");
    assert.equal(outer.type, "namespace");
    assert.equal(outer.depth, 1);
    assert.equal(outer.path, "cpp/containers.cpp#outer");
    assertRange(outer, ContainersCpp, 1, 18);
    const inner: OutlineNode = requireNode(outer.children, "inner");
    assert.equal(inner.type, "namespace");
    assert.equal(inner.depth, 2);
    assert.equal(inner.path, "cpp/containers.cpp#outer.inner");
    assertRange(inner, ContainersCpp, 2, 17);
    assert.deepEqual(labels(inner.children), ["Alpha", "Beta"]);
    const alpha: OutlineNode = requireNode(inner.children, "Alpha");
    assert.equal(alpha.type, "class");
    assert.equal(alpha.depth, 3);
    assert.equal(alpha.path, "cpp/containers.cpp#outer.inner.Alpha");
    assertRange(alpha, ContainersCpp, 4, 10);
    assert.deepEqual(labels(alpha.children), ["Nested", "first"]);
    const nested: OutlineNode = requireNode(alpha.children, "Nested");
    assert.equal(nested.type, "class");
    assert.equal(nested.depth, 4);
    assert.equal(nested.path, "cpp/containers.cpp#outer.inner.Alpha.Nested");
    assertRange(nested, ContainersCpp, 6, 8);
    assert.deepEqual(labels(nested.children), ["deep"]);
    const deep: OutlineNode = requireNode(nested.children, "deep");
    assert.equal(deep.type, "method");
    assert.equal(deep.depth, 5);
    assert.equal(deep.path, "cpp/containers.cpp#outer.inner.Alpha.Nested.deep");
    assertRange(deep, ContainersCpp, 7, 7);
    const first: OutlineNode = requireNode(alpha.children, "first");
    assert.equal(first.type, "method");
    assert.equal(first.depth, 4);
    assertRange(first, ContainersCpp, 9, 9);
    const beta: OutlineNode = requireNode(inner.children, "Beta");
    assert.equal(beta.type, "struct");
    assert.equal(beta.depth, 3);
    assertRange(beta, ContainersCpp, 12, 15);
    assert.deepEqual(labels(beta.children), ["Gamma"]);
    const gamma: OutlineNode = requireNode(beta.children, "Gamma");
    assert.equal(gamma.type, "struct");
    assert.equal(gamma.depth, 4);
    assert.equal(gamma.path, "cpp/containers.cpp#outer.inner.Beta.Gamma");
    assertRange(gamma, ContainersCpp, 13, 14);
    const box: OutlineNode = requireNode(anchor.children, "Box");
    assert.equal(box.type, "class");
    assert.equal(box.depth, 1);
    assert.equal(box.detail, "class Box {");
    assertRange(box, ContainersCpp, 21, 24);
    assert.deepEqual(labels(box.children), ["put"]);
    const put: OutlineNode = requireNode(box.children, "put");
    assert.equal(put.type, "method");
    assert.equal(put.depth, 2);
    assert.equal(put.path, "cpp/containers.cpp#Box.put");
    const pair: OutlineNode = requireNode(anchor.children, "Pair");
    assert.equal(pair.type, "class");
    assert.equal(pair.depth, 1);
    assertRange(pair, ContainersCpp, 31, 32);
    const maximum: OutlineNode = requireNode(anchor.children, "maximum");
    assert.equal(maximum.type, "function");
    assert.equal(maximum.depth, 1);
    assertRange(maximum, ContainersCpp, 27, 29);
    const free: OutlineNode = requireNode(anchor.children, "free_function");
    assert.equal(free.type, "function");
    assertRange(free, ContainersCpp, 38, 38);
    const inlineMax: OutlineNode = requireNode(anchor.children, "inlineMax");
    assert.equal(inlineMax.type, "function");
    assert.equal(inlineMax.depth, 1);
    assert.equal(inlineMax.detail, "template <typename T> T inlineMax(const T &a, const T &b) {");
    assertRange(inlineMax, ContainersCpp, 34, 36);
});

test("constructor and destructor forms, static callables, static data and instance fields", (): void => {
    const result: OutlineResult = outline("cpp/members.cpp");
    const anchor: OutlineNode = result.nodes[0];
    const widget: OutlineNode = requireNode(anchor.children, "Widget");
    assert.equal(widget.type, "class");
    assert.equal(widget.depth, 1);
    assertRange(widget, MembersCpp, 1, 14);
    assert.deepEqual(labels(widget.children), ["Widget", "Widget", "~Widget", "~Widget", "Widget", "draw", "drawInline", "instances", "create", "size_"]);
    const declaredConstructor: OutlineNode = requireNode(widget.children, "Widget");
    assert.equal(declaredConstructor.type, "method");
    assert.equal(declaredConstructor.depth, 2);
    assert.match(declaredConstructor.path, /^cpp\/members\.cpp#Widget\.Widget~method-/);
    assert.equal(new Set(widget.children.map((node: OutlineNode): string => node.path)).size, widget.children.length);
    assert.equal(declaredConstructor.detail, "Widget();");
    assertRange(declaredConstructor, MembersCpp, 3, 3);
    const explicitConstructor: OutlineNode = childAtLine(widget.children, 4)!;
    assert.equal(explicitConstructor.label, "Widget");
    assert.equal(explicitConstructor.detail, "explicit Widget(int size);");
    assertRange(explicitConstructor, MembersCpp, 4, 4);
    const declaredDestructor: OutlineNode = childAtLine(widget.children, 5)!;
    assert.equal(declaredDestructor.label, "~Widget");
    assert.equal(declaredDestructor.detail, "~Widget();");
    assertRange(declaredDestructor, MembersCpp, 5, 5);
    const defaultDestructor: OutlineNode = childAtLine(widget.children, 6)!;
    assert.equal(defaultDestructor.label, "~Widget");
    assert.equal(defaultDestructor.detail, "virtual ~Widget() = default;");
    assertRange(defaultDestructor, MembersCpp, 6, 6);
    const inlineConstructor: OutlineNode = childAtLine(widget.children, 7)!;
    assert.equal(inlineConstructor.label, "Widget");
    assert.equal(inlineConstructor.detail, "Widget(int size) {}");
    assertRange(inlineConstructor, MembersCpp, 7, 7);
    const draw: OutlineNode = requireNode(widget.children, "draw");
    assert.equal(draw.type, "method");
    assert.equal(draw.detail, "void draw();");
    assertRange(draw, MembersCpp, 8, 8);
    const drawInline: OutlineNode = childAtLine(widget.children, 9)!;
    assert.equal(drawInline.label, "drawInline");
    assert.equal(drawInline.detail, "void drawInline() {}");
    assertRange(drawInline, MembersCpp, 9, 9);
    const instances: OutlineNode = requireNode(widget.children, "instances");
    assert.equal(instances.type, "property");
    assert.equal(instances.depth, 2);
    assert.equal(instances.path, "cpp/members.cpp#Widget.instances");
    assertRange(instances, MembersCpp, 10, 10);
    const create: OutlineNode = requireNode(widget.children, "create");
    assert.equal(create.type, "method");
    assertRange(create, MembersCpp, 11, 11);
    const sizeField: OutlineNode = requireNode(widget.children, "size_");
    assert.equal(sizeField.type, "property");
    assertRange(sizeField, MembersCpp, 13, 13);
    const allman: OutlineResult = outline("cpp/allman.cpp");
    const allmanClass: OutlineNode = requireNode(allman.nodes, "Allman");
    assert.deepEqual(labels(allmanClass.children), ["foo", "bar"]);
    const foo: OutlineNode = requireNode(allmanClass.children, "foo");
    assert.equal(foo.type, "method");
    assertRange(foo, AllmanCpp, 3, 5);
    assertRange(requireNode(allmanClass.children, "bar"), AllmanCpp, 6, 6);
});

test("comments, strings, character literals and preprocessor decoys never become nodes", (): void => {
    const result: OutlineResult = outline("cpp/masking.cpp");
    assert.equal(result.strategy, "cpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["GHOST", "Real", "AfterUrl"]);
    const ghost: OutlineNode = requireNode(anchor.children, "GHOST");
    assert.equal(ghost.type, "macro");
    assert.equal(ghost.detail, "#define GHOST struct Ghost");
    const real: OutlineNode = requireNode(anchor.children, "Real");
    assert.equal(real.type, "class");
    assert.equal(real.depth, 1);
    assert.equal(real.detail, "class Real {");
    assertRange(real, MaskingCpp, 12, 15);
    assert.deepEqual(labels(real.children), ["method"]);
    assertRange(requireNode(real.children, "method"), MaskingCpp, 14, 14);
    const afterUrl: OutlineNode = requireNode(anchor.children, "AfterUrl");
    assert.equal(afterUrl.type, "class");
    assertRange(afterUrl, MaskingCpp, 18, 19);
    assert.equal(findNode(anchor.children, "LineComment"), undefined);
    assert.equal(findNode(anchor.children, "BlockComment"), undefined);
    assert.equal(findNode(anchor.children, "IncludeFake"), undefined);
    assert.equal(findNode(anchor.children, "StringFake"), undefined);
    assert.equal(findNode(anchor.children, "Ghost"), undefined);
    assert.equal(findNode(anchor.children, "Fake"), undefined);
});

test('include guards and extern "C" blocks expose wrapped prototypes', (): void => {
    const guarded: OutlineResult = outline("c/api.h");
    assert.equal(guarded.strategy, "c");
    const anchor: OutlineNode = guarded.nodes[0];
    assert.deepEqual(labels(anchor.children), ["API_H", "api_open", "api_close", "api_ctx"]);
    assert.equal(requireNode(anchor.children, "API_H").type, "macro");
    const guardedOpen: OutlineNode = requireNode(anchor.children, "api_open");
    assert.equal(guardedOpen.type, "function");
    assert.equal(guardedOpen.depth, 1);
    assert.equal(guardedOpen.path, "c/api.h#api_open");
    assertRange(guardedOpen, ApiHeader, 8, 8);
    assertRange(requireNode(anchor.children, "api_close"), ApiHeader, 9, 9);
    const context: OutlineNode = requireNode(anchor.children, "api_ctx");
    assert.equal(context.type, "struct");
    assertRange(context, ApiHeader, 11, 11);
    const flat: OutlineResult = outline("c/api_flat.h");
    assert.deepEqual(labels(flat.nodes[0].children), ["API_FLAT_H", "api_open", "api_close"]);
    const open: OutlineNode = requireNode(flat.nodes, "api_open");
    assert.equal(open.type, "function");
    assert.equal(open.depth, 1);
    assert.equal(open.path, "c/api_flat.h#api_open");
    assertRange(open, ApiFlat, 4, 4);
    assert.equal(requireNode(flat.nodes, "api_close").type, "function");
});

test("CRLF, BOM, Unicode, empty, include-only and no-final-newline files are decoded consistently", (): void => {
    const crlf: OutlineResult = outline("edge/crlf.hpp");
    assert.equal(crlf.charset, "utf-8");
    assert.equal(crlf.truncated, false);
    const crlfClass: OutlineNode = requireNode(crlf.nodes, "Crlf");
    assert.equal(crlfClass.depth, 1);
    assertRange(crlfClass, CrlfText, 1, 6);
    const go: OutlineNode = requireNode(crlfClass.children, "go");
    assert.equal(go.type, "method");
    assert.equal(go.detail, "void go() {");
    assertRange(go, CrlfText, 3, 5);
    const bom: OutlineResult = outline("edge/bom.hpp");
    assert.equal(bom.charset, "utf-8-bom");
    assert.equal(bom.strategy, "cpp");
    const bomClass: OutlineNode = requireNode(bom.nodes, "Bom");
    assert.equal(bomClass.depth, 1);
    assert.equal(bomClass.detail, "class Bom {");
    assert.equal(bomClass.range.startByte, 3n);
    assert.equal(bomClass.range.endByte, BigInt(BomBytes.length));
    assert.deepEqual(labels(bomClass.children), ["tick"]);
    const tick: OutlineNode = requireNode(bomClass.children, "tick");
    assert.equal(Number(tick.range.startLine), 2);
    assert.equal(tick.range.startByte, 15n);
    assert.equal(tick.range.endByte, 32n);
    assert.equal(bom.nodes[0].range.startByte, 0n);
    assert.equal(bom.nodes[0].range.endByte, BigInt(BomBytes.length));
    const unicode: OutlineResult = outline("edge/unicode.cpp");
    assert.equal(unicode.charset, "utf-8");
    const unicodeAnchor: OutlineNode = unicode.nodes[0];
    assert.deepEqual(labels(unicodeAnchor.children), ["Wide", "Tail"]);
    const wide: OutlineNode = requireNode(unicodeAnchor.children, "Wide");
    assert.equal(wide.depth, 1);
    assert.equal(wide.detail, "class Wide {");
    assertRange(wide, UnicodeCpp, 2, 5);
    assert.deepEqual(labels(wide.children), ["run"]);
    assertRange(requireNode(wide.children, "run"), UnicodeCpp, 4, 4);
    assertRange(requireNode(unicodeAnchor.children, "Tail"), UnicodeCpp, 7, 8);
    assert.equal(findNode(unicodeAnchor.children, "伪类"), undefined);
    assert.equal(findNode(unicodeAnchor.children, "伪造"), undefined);
    assert.equal(findNode(unicodeAnchor.children, "假"), undefined);
    assert.equal(findNode(unicodeAnchor.children, "数据类"), undefined);
    const empty: OutlineResult = outline("edge/empty.cpp");
    assert.equal(empty.strategy, "cpp");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes[0].children.length, 0);
    assert.equal(Number(empty.nodes[0].range.startLine), 1);
    assert.equal(Number(empty.nodes[0].range.endLine), 1);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    const includeOnly: OutlineResult = outline("edge/include-only.hpp");
    assert.equal(includeOnly.strategy, "cpp");
    assert.equal(includeOnly.truncated, false);
    assert.equal(includeOnly.nodes[0].children.length, 0);
    assert.equal(Number(includeOnly.nodes[0].range.endLine), 2);
    const noNewline: OutlineResult = outline("edge/tail-no-newline.c");
    assert.equal(noNewline.strategy, "c");
    const tail: OutlineNode = requireNode(noNewline.nodes, "tail");
    assert.equal(tail.type, "function");
    assert.equal(Number(tail.range.startLine), 1);
    assert.equal(Number(tail.range.endLine), 1);
    assert.equal(tail.range.startByte, 0n);
    assert.equal(tail.range.endByte, BigInt(Buffer.byteLength("int tail(void);")));
});

test("top-level functions, qualified out-of-line methods, prototypes and pointer declarations", (): void => {
    const result: OutlineResult = outline("cpp/functions.cpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["add", "clamp_value", "log_only", "ns::Thing::Thing", "ns::Thing::~Thing", "ns::Util::compute", "trailing", "Ops"]);
    const add: OutlineNode = requireNode(anchor.children, "add");
    assert.equal(add.type, "function");
    assert.equal(add.depth, 1);
    assertRange(add, FunctionsCpp, 3, 3);
    const clamp: OutlineNode = requireNode(anchor.children, "clamp_value");
    assert.equal(clamp.type, "function");
    assert.equal(clamp.detail, "static int clamp_value(int value) {");
    assertRange(clamp, FunctionsCpp, 5, 7);
    const destructor: OutlineNode = requireNode(anchor.children, "ns::Thing::~Thing");
    assert.equal(destructor.type, "method");
    assert.equal(destructor.depth, 1);
    assert.equal(destructor.path, "cpp/functions.cpp#ns::Thing::~Thing");
    assertRange(destructor, FunctionsCpp, 13, 14);
    const compute: OutlineNode = requireNode(anchor.children, "ns::Util::compute");
    assert.equal(compute.type, "method");
    assert.equal(compute.depth, 1);
    assertRange(compute, FunctionsCpp, 16, 18);
    assert.equal(findNode(anchor.children, "name"), undefined);
    assert.equal(requireNode(anchor.children, "log_only").type, "function");
    assert.equal(requireNode(anchor.children, "ns::Thing::Thing").type, "method");
    const trailing: OutlineNode = requireNode(anchor.children, "trailing");
    assert.equal(trailing.type, "function");
    assert.equal(trailing.detail, "auto trailing() -> int {");
    assertRange(trailing, FunctionsCpp, 22, 24);
    const ops: OutlineNode = requireNode(anchor.children, "Ops");
    assert.equal(ops.type, "struct");
    assertRange(ops, FunctionsCpp, 28, 30);
    assert.equal(ops.children.length, 0);
    assert.equal(findNode(anchor.children, "callback"), undefined);
    assert.equal(findNode(anchor.children, "int"), undefined);
});

test("macros are reported with their own line and detail, nested defines are not", (): void => {
    const result: OutlineResult = outline("cpp/macros.cpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["BUFFER_SIZE", "SPACED_MACRO", "SQUARE", "MULTI_LINE", "LABEL", "util"]);
    const buffer: OutlineNode = requireNode(anchor.children, "BUFFER_SIZE");
    assert.equal(buffer.type, "macro");
    assert.equal(buffer.detail, "#define BUFFER_SIZE 256");
    assertRange(buffer, MacrosCpp, 1, 1);
    assertRange(requireNode(anchor.children, "SPACED_MACRO"), MacrosCpp, 2, 2);
    const square: OutlineNode = requireNode(anchor.children, "SQUARE");
    assert.equal(square.detail, "#define SQUARE(x) ((x) * (x))");
    assertRange(square, MacrosCpp, 3, 3);
    const multi: OutlineNode = requireNode(anchor.children, "MULTI_LINE");
    assert.equal(multi.detail, "#define MULTI_LINE(a) \\");
    assertRange(multi, MacrosCpp, 4, 4);
    const label: OutlineNode = requireNode(anchor.children, "LABEL");
    assert.equal(label.detail, '#define LABEL "demo-value"');
    const util: OutlineNode = requireNode(anchor.children, "util");
    assert.equal(util.type, "namespace");
    assertRange(util, MacrosCpp, 11, 16);
    assert.deepEqual(labels(util.children), ["NESTED_MACRO", "Holder"]);
    const holder: OutlineNode = requireNode(util.children, "Holder");
    assert.equal(holder.type, "class");
    assert.equal(holder.depth, 2);
    assertRange(holder, MacrosCpp, 13, 15);
    assert.equal(requireNode(util.children, "NESTED_MACRO").type, "macro");
    assert.equal(requireNode(holder.children, "CLASS_MACRO").type, "macro");
    assert.equal(requireNode(holder.children, "CLASS_MACRO").depth, 3);
    assert.equal(findNode(anchor.children, "x"), undefined);
    assert.equal(findNode(anchor.children, "cstddef"), undefined);
});

test("forward declarations, enums, union-as-struct, final and derived classes are classified", (): void => {
    const result: OutlineResult = outline("cpp/types.cpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["Forward", "Record", "Value", "Plain", "Scoped", "Final", "Derived"]);
    const forward: OutlineNode = requireNode(anchor.children, "Forward");
    assert.equal(forward.type, "class");
    assertRange(forward, TypesCpp, 1, 1);
    assert.equal(requireNode(anchor.children, "Record").type, "struct");
    const value: OutlineNode = requireNode(anchor.children, "Value");
    assert.equal(value.type, "struct");
    assert.equal(value.detail, "union Value {");
    assertRange(value, TypesCpp, 3, 6);
    const plain: OutlineNode = requireNode(anchor.children, "Plain");
    assert.equal(plain.type, "enum");
    assertRange(plain, TypesCpp, 7, 10);
    const scoped: OutlineNode = requireNode(anchor.children, "Scoped");
    assert.equal(scoped.type, "enum");
    assertRange(scoped, TypesCpp, 11, 13);
    const finalStruct: OutlineNode = requireNode(anchor.children, "Final");
    assert.equal(finalStruct.type, "struct");
    assertRange(finalStruct, TypesCpp, 14, 15);
    const derived: OutlineNode = requireNode(anchor.children, "Derived");
    assert.equal(derived.type, "class");
    assertRange(derived, TypesCpp, 16, 17);
    assert.equal(findNode(anchor.children, "Alias"), undefined);
    assert.equal(findNode(anchor.children, "Handle"), undefined);
    assert.equal(findNode(anchor.children, "A"), undefined);
});

test("an anonymous namespace yields no namespace node while its members keep their brace depth", (): void => {
    const result: OutlineResult = outline("cpp/anonymous.cpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), ["Hidden", "exposed"]);
    const hidden: OutlineNode = requireNode(anchor.children, "Hidden");
    assert.equal(hidden.type, "class");
    assert.equal(hidden.depth, 1);
    assert.equal(hidden.path, "cpp/anonymous.cpp#Hidden");
    assertRange(hidden, AnonymousCpp, 2, 4);
    const assist: OutlineNode = requireNode(hidden.children, "assist");
    assert.equal(assist.type, "method");
    assert.equal(assist.depth, 2);
    assert.equal(assist.path, "cpp/anonymous.cpp#Hidden.assist");
    assertRange(assist, AnonymousCpp, 3, 3);
    const exposed: OutlineNode = requireNode(anchor.children, "exposed");
    assert.equal(exposed.type, "function");
    assert.equal(exposed.depth, 1);
    assert.equal(exposed.path, "cpp/anonymous.cpp#exposed");
    assertRange(exposed, AnonymousCpp, 6, 6);
    assert.equal(findNode(anchor.children, "namespace"), undefined);
    assert.deepEqual(labels(flatten(anchor.children)), ["Hidden", "assist", "exposed"]);
});

test("maxNodes and maxDepth truncate explicitly and count the anchor", (): void => {
    const complete: OutlineResult = outline("limits/graph.cpp");
    assert.equal(complete.truncated, false);
    assert.deepEqual(labels(flatten(complete.nodes)), ["graph.cpp", "ns", "A", "a", "b", "B", "c", "tail"]);
    const nodesFour: OutlineResult = outline("limits/graph.cpp", { maxNodes: 4 });
    assert.equal(nodesFour.truncated, true);
    assert.deepEqual(labels(flatten(nodesFour.nodes)), ["graph.cpp", "ns", "A", "a"]);
    const nodesOne: OutlineResult = outline("limits/graph.cpp", { maxNodes: 1 });
    assert.equal(nodesOne.truncated, true);
    assert.deepEqual(labels(flatten(nodesOne.nodes)), ["graph.cpp"]);
    const nodesTwenty: OutlineResult = outline("limits/graph.cpp", { maxNodes: 20 });
    assert.equal(nodesTwenty.truncated, false);
    assert.equal(flatten(nodesTwenty.nodes).length, 8);
    const depthTwo: OutlineResult = outline("limits/graph.cpp", { maxDepth: 2 });
    assert.equal(depthTwo.truncated, true);
    assert.deepEqual(labels(flatten(depthTwo.nodes)), ["graph.cpp", "ns", "A", "B", "tail"]);
    assert.equal(findNode(depthTwo.nodes, "a"), undefined);
    const depthOne: OutlineResult = outline("limits/graph.cpp", { maxDepth: 1 });
    assert.equal(depthOne.truncated, true);
    assert.deepEqual(labels(flatten(depthOne.nodes)), ["graph.cpp", "ns", "tail"]);
    const depthThree: OutlineResult = outline("limits/graph.cpp", { maxDepth: 3 });
    assert.equal(depthThree.truncated, false);
    assert.equal(flatten(depthThree.nodes).length, 8);
    const depthClamped: OutlineResult = outline("limits/graph.cpp", { maxDepth: 17 });
    assert.equal(depthClamped.truncated, false);
    assert.equal(flatten(depthClamped.nodes).length, 8);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/graph.cpp", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/graph.cpp", { maxDepth: 0 });
    });
});

test("binary, oversized, missing and escaping C/C++ paths fail with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("bad/binary.cpp");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("bad/oversized.c");
    });
    expectFilesystemError("not_found", (): void => {
        outline("cpp/missing.cpp");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.cpp");
    });
});

test("the 3000-line scan cap reports truncation and hides symbols past the prefix", (): void => {
    const result: OutlineResult = outline("edge/scan-cap.cpp");
    assert.equal(result.strategy, "cpp");
    assert.equal(result.truncated, true);
    assert.equal(Number(result.nodes[0].range.endLine), ScanCapTotal);
    assert.deepEqual(labels(result.nodes[0].children), ["Early"]);
    const early: OutlineNode = requireNode(result.nodes, "Early");
    assert.equal(early.type, "class");
    assertRange(early, ScanCapText, 1, 2);
    assert.equal(findNode(result.nodes, "late"), undefined);
    assert.equal(flatten(result.nodes).length, 2);
});

test("the file anchor carries the whole-file fingerprint, range and label", (): void => {
    const result: OutlineResult = outline("cpp/parser.hpp");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "cpp/parser.hpp");
    assert.equal(anchor.label, "parser.hpp");
    assert.ok(anchor.file !== (void 0));
    assert.equal(anchor.file!.path, "cpp/parser.hpp");
    assert.equal(anchor.file!.fingerprint, result.fingerprint);
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(ParserHpp)));
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), 29);
    assert.ok(Object.isFrozen(result.nodes));
    assert.ok(Object.isFrozen(anchor));
    assert.ok(Object.isFrozen(anchor.children));
});

/**
 * Defects recorded against the current parser. Each test below states the
 * behavior the outline contract implies; the source is intentionally unchanged,
 * so every one fails and prints expected-vs-actual. A fix turns the matching
 * `[defect]` test green without touching its assertions.
 */
test('DEV-1: prototypes inside an extern "C" block should be outlined', (): void => {
    const result: OutlineResult = outline("c/api.h");
    const open: OutlineNode = requireNode(result.nodes, "api_open");
    assert.equal(open.type, "function");
    assert.equal(open.depth, 1);
});

test("DEV-2: typedef struct Foo { ... } Foo should yield a struct node", (): void => {
    const result: OutlineResult = outline("c/geometry.c");
    const point: OutlineNode = requireNode(result.nodes, "Point");
    assert.equal(point.type, "struct");
    assert.equal(Number(point.range.startLine), 5);
});

test("DEV-3: a one-line definition ending in } should be outlined", (): void => {
    const result: OutlineResult = outline("cpp/functions.cpp");
    const logOnly: OutlineNode = requireNode(result.nodes, "log_only");
    assert.equal(logOnly.type, "function");
});

test("DEV-4: an Allman-brace-style definition should be outlined", (): void => {
    const result: OutlineResult = outline("cpp/allman.cpp");
    const foo: OutlineNode = requireNode(result.nodes, "foo");
    assert.equal(foo.type, "method");
    assert.equal(Number(foo.range.startLine), 3);
});

test("DEV-5: in-class constructor and destructor declarations should be outlined", (): void => {
    const result: OutlineResult = outline("cpp/members.cpp");
    const widget: OutlineNode = requireNode(result.nodes, "Widget");
    assert.ok(childAtLine(widget.children, 3) !== (void 0), "missing constructor declaration at line 3");
    assert.ok(childAtLine(widget.children, 5) !== (void 0), "missing destructor declaration at line 5");
    assert.ok(childAtLine(widget.children, 7) !== (void 0), "missing inline constructor at line 7");
});

test("DEV-6: a single-line template function should be outlined", (): void => {
    const result: OutlineResult = outline("cpp/containers.cpp");
    const inlineMax: OutlineNode = requireNode(result.nodes, "inlineMax");
    assert.equal(inlineMax.type, "function");
});

test("DEV-7: a functional-initialized variable should not be reported as a function", (): void => {
    const result: OutlineResult = outline("cpp/functions.cpp");
    assert.equal(findNode(result.nodes, "name"), undefined);
});

test("DEV-8: a #define inside a namespace or class should be a macro node", (): void => {
    const result: OutlineResult = outline("cpp/macros.cpp");
    const nested: OutlineNode = requireNode(result.nodes, "NESTED_MACRO");
    assert.equal(nested.type, "macro");
});

test("DEV-9: an unbalanced macro brace should not inflate the depth of later symbols", (): void => {
    const result: OutlineResult = outline("cpp/unbalanced.cpp");
    const leaked: OutlineNode = requireNode(result.nodes, "Leaked");
    assert.equal(leaked.depth, 1);
    assert.equal(leaked.path, "cpp/unbalanced.cpp#Leaked");
});

test("DEV-10: byte ranges of a BOM file should use offsets of the raw file", (): void => {
    const result: OutlineResult = outline("edge/bom.hpp");
    assert.equal(result.nodes[0].range.endByte, BigInt(BomBytes.length));
});

test("DEV-11: code behind #if 0 should not be outlined", (): void => {
    const result: OutlineResult = outline("cpp/dead.cpp");
    assert.equal(findNode(result.nodes, "Disabled"), undefined);
    assert.equal(findNode(result.nodes, "Maybe") !== undefined, true);
});

test("DEV-12: class/struct data members should be outlined like other OO languages", (): void => {
    const result: OutlineResult = outline("c/geometry.c");
    const rect: OutlineNode = requireNode(result.nodes, "Rect");
    assert.deepEqual(labels(rect.children), ["origin", "width", "height"]);
});

test("DEV-13: node detail should preserve string literals instead of masking them", (): void => {
    const result: OutlineResult = outline("cpp/macros.cpp");
    const label: OutlineNode = requireNode(result.nodes, "LABEL");
    assert.equal(label.detail, '#define LABEL "demo-value"');
});

test("DEV-14: an explicit template specialization should be outlined", (): void => {
    const result: OutlineResult = outline("cpp/specialization.cpp");
    const specialized: OutlineNode = requireNode(result.nodes, "Fixed");
    assert.equal(specialized.type, "class");
});
