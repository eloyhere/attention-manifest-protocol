#!/usr/bin/env node
/**
 * Go outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; no fixture code is compiled or executed, and no third-party parser is
 * involved. Assertions go through the public `buildOutline` entry point, so
 * sandbox resolution, the charset gate, anchor construction, UTF-8 byte ranges,
 * bounds and strategy selection are exercised together with `parseGo`.
 *
 * The suite has two layers:
 *
 * - contract tests for behavior the Go strategy supports;
 * - `REGRESSION` tests for the Go defects recorded in
 *   `docs/testing/languages/goReport.md`; they state the fixed behavior and
 *   guard against a regression.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline, outlineNodeFingerprint } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-go-outline-"));
const RootSpec: SessionRoot = { id: "root.go.outline", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

after((): void => {
    rmSync(Root, { recursive: true, force: true });
});

/**
 * Minimal test-context surface used for diagnostics; `node:test` supplies the
 * real `TestContext`, so the suite keeps working if that type moves.
 */
interface DiagnosticContext {
    readonly diagnostic: (message: string) => void;
}

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
const outline: (path: string, options?: { readonly maxNodes?: number; readonly maxDepth?: number; }) => OutlineResult = (
    path: string, options: { readonly maxNodes?: number; readonly maxDepth?: number; } = {},
): OutlineResult => buildOutline(Sandbox, path, options);

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
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

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
 * One-line rendering of a node tree, used in `diagnostic` output so a failure
 * shows the observed shape instead of only the expected value.
 */
const describe: (nodes: readonly OutlineNode[]) => string = (nodes: readonly OutlineNode[]): string =>
    flatten(nodes)
        .map((node: OutlineNode): string => `${node.label}:${node.type}:d${node.depth}:L${Number(node.range.startLine)}-${Number(node.range.endLine)}`)
        .join(", ");

/**
 * 1-based start byte offset of one line, matching ByteLineIndex semantics: every
 * logical line keeps its own bytes plus the `\n` separator.
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
    assert.equal(Number(node.range.startLine), startLine, `start line of ${node.label}`);
    assert.equal(Number(node.range.endLine), endLine, `end line of ${node.label}`);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte, `start byte of ${node.label}`);
    assert.equal(node.range.endByte, expected.endByte, `end byte of ${node.label}`);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Core Go fixture: package, constants, variables, two structs, an interface,
 * alias/func/map types, tagged fields, value and pointer receiver methods, a
 * method with an undeclared receiver, multi-return and generic functions, and a
 * body containing defer/go/select and an anonymous closure.
 */
const ApiText: string = [
    "package demo",
    "",
    'import "fmt"',
    "",
    "const Limit = 3",
    "var Global int",
    "var a, b = 1, 2",
    "",
    "type Point struct {",
    "    X int",
    "    Y int",
    "}",
    "",
    "type Shape interface {",
    "    Area() float64",
    "    Name() string",
    "}",
    "",
    "type Alias = int",
    "type Handler func(int) error",
    "type Dict map[string]int",
    "",
    "type Tagged struct {",
    '    Name string `json:"name"`',
    "    Note string // trailing comment",
    "}",
    "",
    "func (p Point) Sum() int { return p.X + p.Y }",
    "func (p *Point) Move(dx, dy int) { p.X += dx }",
    "func (g Ghost) Haunt() {}",
    "",
    "func Pair() (int, error) { return 1, nil }",
    "func Map[T any](xs []T, f func(T) T) []T { return xs }",
    "",
    "func run() {",
    '    defer fmt.Println("done")',
    '    go func() { fmt.Println("async") }()',
    "    select {",
    "    case <-time.After(1):",
    "    default:",
    "    }",
    "    handler := func(x int) int { return x }",
    "    _ = handler",
    "}",
    "",
    "var computed = func() int { return 1 }()",
].join("\n") + "\n";

/**
 * Pseudo declarations hidden in comments, quoted strings and a raw string.
 */
const NoiseText: string = [
    "package demo",
    "",
    "// type Fake struct { X int }",
    "/* func hidden() { } */",
    'var s = "type S struct { A int }"',
    "var r = `func raw() {",
    "type Raw struct { Z int }",
    "}`",
    "",
    "type Real struct {",
    "    // Commented int",
    "    Note string // trailing",
    "}",
].join("\n") + "\n";

/**
 * CRLF fixture: the strategy must keep line numbers and strip the carriage
 * return from labels/details while byte offsets still count it.
 */
const CrlfText: string = "package demo\r\n\r\ntype T struct {\r\n    A int\r\n}\r\n";

/**
 * UTF-8 BOM fixture: the decoded text loses the BOM, so byte offsets start at
 * the first non-BOM byte and the charset reports `utf-8-bom`.
 */
const BomText: string = "\uFEFFpackage bom\n\nconst Answer = 42\n";

/**
 * Unicode content (comments, string literals, raw string) with ASCII
 * declarations: masking must survive multi-byte text.
 */
const UnicodeContentText: string = [
    "package demo",
    "",
    "// 这是注释，含 type Ghost struct { }",
    'const Greeting = "你好，世界"',
    "var Banner = `多行",
    "type Raw struct { }",
    "`",
    "",
    "type Config struct {",
    "    Label string // 标签",
    "}",
].join("\n") + "\n";

/**
 * Generic struct fixture: `Box[T]` with a field and a method whose receiver
 * itself carries the type parameter list.
 */
const GenericText: string = [
    "package demo",
    "",
    "type Box[T any] struct {",
    "    Value T",
    "}",
    "",
    "func (b *Box[T]) Get() T {",
    "    return b.Value",
    "}",
].join("\n") + "\n";

/**
 * Embedded struct fields, both value and pointer form.
 */
const EmbeddedText: string = [
    "package demo",
    "",
    "type Base struct {",
    "    ID int",
    "}",
    "",
    "type Derived struct {",
    "    Base",
    "    *Base",
    "    Label string",
    "}",
].join("\n") + "\n";

/**
 * Interface with method signatures only.
 */
const IfaceText: string = [
    "package demo",
    "",
    "type Reader interface {",
    "    Read(p []byte) (int, error)",
    "    Close() error",
    "}",
].join("\n") + "\n";

/**
 * Struct whose whole field list sits on the declaration line.
 */
const InlineText: string = "package demo\n\ntype Inline struct { A int; B string }\n";

/**
 * Grouped constant and variable blocks, the common `iota` shape.
 */
const GroupedText: string = [
    "package demo",
    "",
    "const (",
    "    A = 1",
    "    B = 2",
    ")",
    "",
    "var (",
    "    x = 1",
    "    y = 2",
    ")",
].join("\n") + "\n";

/**
 * Valid Go using non-ASCII identifiers, which the Go spec allows.
 */
const UnicodeIdentifierText: string = [
    "package 演示",
    "",
    "// 类型说明",
    "type 配置 struct {",
    "    名称 string",
    "}",
    "",
    'const Greeting = "你好，世界"',
].join("\n") + "\n";

/**
 * A function declaration without a body and a signature spanning several lines:
 * both must end at their own declaration.
 */
const SignatureText: string = [
    "package demo",
    "",
    "func add(a, b int) int",
    "",
    "func long(",
    "    value int,",
    ") error {",
    "    return nil",
    "}",
].join("\n") + "\n";

/**
 * Multiple names in one field spec plus package-qualified embedded fields.
 */
const FieldListText: string = [
    "package demo",
    "",
    "type Pair struct {",
    "    Left, Right int",
    "}",
    "",
    "type Wrap struct {",
    "    pkg.Base",
    "    *pkg.Base",
    "    Label string",
    "}",
].join("\n") + "\n";

/**
 * Interface embedding other interfaces beside a method signature.
 */
const EmbeddedInterfaceText: string = [
    "package demo",
    "",
    "type ReadWriter interface {",
    "    io.Reader",
    "    io.Writer",
    "    Flush() error",
    "}",
].join("\n") + "\n";

fixture("go/api.go", ApiText);
fixture("go/noise.go", NoiseText);
fixture("go/crlf.go", CrlfText);
fixture("go/bom.go", BomText);
fixture("go/unicodeContent.go", UnicodeContentText);
fixture("go/generic.go", GenericText);
fixture("go/embedded.go", EmbeddedText);
fixture("go/iface.go", IfaceText);
fixture("go/inline.go", InlineText);
fixture("go/grouped.go", GroupedText);
fixture("go/unicodeIdentifier.go", UnicodeIdentifierText);
fixture("go/signatures.go", SignatureText);
fixture("go/fieldList.go", FieldListText);
fixture("go/embeddedInterface.go", EmbeddedInterfaceText);
fixture("go/empty.go", "");
fixture("go/pkgonly.go", "package only\n");
fixture("go/blob.go", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("go/huge.go", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

test("the Go strategy exposes package, struct, interface and function symbols at depth 1", (): void => {
    const result: OutlineResult = outline("go/api.go");
    assert.equal(result.strategy, "go");
    assert.equal(result.language, "go");
    assert.equal(result.category, "code");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "go/api.go");
    assert.equal(anchor.label, "api.go");
    assert.equal(anchor.depth, 0);
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(ApiText, "utf8")));
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), 46);
    assert.equal(anchor.children.length, 16);
    assert.deepEqual(labels(anchor.children), [
        "demo", "Limit", "Global", "a", "b", "Point", "Shape", "Alias", "Handler", "Dict", "Tagged", "Haunt", "Pair", "Map", "run", "computed",
    ]);
});

test("package, const, var and func declarations carry their kinds, details and paths", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const packageNode: OutlineNode = requireNode(result.nodes, "demo");
    assert.equal(packageNode.type, "package");
    assert.equal(packageNode.depth, 1);
    assert.equal(packageNode.path, "go/api.go#demo");
    assert.equal(packageNode.detail, "package demo");
    assertRange(packageNode, ApiText, 1, 1);
    const limit: OutlineNode = requireNode(result.nodes, "Limit");
    assert.equal(limit.type, "constant");
    assert.equal(limit.detail, "const Limit = 3");
    assertRange(limit, ApiText, 5, 5);
    const global: OutlineNode = requireNode(result.nodes, "Global");
    assert.equal(global.type, "variable");
    assert.equal(global.detail, "var Global int");
    assertRange(global, ApiText, 6, 6);
    const firstOfList: OutlineNode = requireNode(result.nodes, "a");
    assert.equal(firstOfList.type, "variable");
    assert.equal(firstOfList.detail, "var a, b = 1, 2");
    const secondOfList: OutlineNode = requireNode(result.nodes, "b");
    assert.equal(secondOfList.type, "variable");
    assert.equal(secondOfList.detail, "var a, b = 1, 2");
    assertRange(secondOfList, ApiText, 7, 7);
    const pair: OutlineNode = requireNode(result.nodes, "Pair");
    assert.equal(pair.type, "function");
    assert.equal(pair.detail, "func Pair() (int, error) { return 1, nil }");
    assertRange(pair, ApiText, 32, 32);
    assert.equal(findNode(result.nodes, "fmt"), undefined);
});

test("struct fields become property children with tags and trailing comments masked", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const point: OutlineNode = requireNode(result.nodes, "Point");
    assert.equal(point.type, "struct");
    assert.equal(point.depth, 1);
    assert.equal(point.path, "go/api.go#Point");
    assert.equal(point.detail, "type Point struct {");
    assertRange(point, ApiText, 9, 12);
    const properties: OutlineNode[] = point.children.filter((node: OutlineNode): boolean => node.type === "property");
    assert.deepEqual(labels(properties), ["X", "Y"]);
    const x: OutlineNode = requireNode(point.children, "X");
    assert.equal(x.depth, 2);
    assert.equal(x.path, "go/api.go#Point.X");
    assert.equal(x.detail, "X int");
    assertRange(x, ApiText, 10, 10);
    assert.equal(requireNode(point.children, "Y").detail, "Y int");
    const tagged: OutlineNode = requireNode(result.nodes, "Tagged");
    assert.deepEqual(labels(tagged.children), ["Name", "Note"]);
    const name: OutlineNode = requireNode(tagged.children, "Name");
    assert.equal(name.detail, "Name string");
    assertRange(name, ApiText, 24, 24);
    const note: OutlineNode = requireNode(tagged.children, "Note");
    assert.equal(note.detail, "Note string");
    assertRange(note, ApiText, 25, 25);
});

test("value and pointer receiver methods attach to their struct as methods", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const point: OutlineNode = requireNode(result.nodes, "Point");
    const methods: OutlineNode[] = point.children.filter((node: OutlineNode): boolean => node.type === "method");
    assert.deepEqual(labels(methods).sort(), ["Move", "Sum"]);
    const sum: OutlineNode = requireNode(point.children, "Sum");
    assert.equal(sum.type, "method");
    assert.equal(sum.depth, 2);
    assert.equal(sum.path, "go/api.go#Point.Sum");
    assert.equal(sum.detail, "func (p Point) Sum() int { return p.X + p.Y }");
    assertRange(sum, ApiText, 28, 28);
    const move: OutlineNode = requireNode(point.children, "Move");
    assert.equal(move.type, "method");
    assert.equal(move.depth, 2);
    assert.equal(move.path, "go/api.go#Point.Move");
    assert.match(move.detail ?? "", /func \(p \*Point\) Move/);
    assertRange(move, ApiText, 29, 29);
    // Children are sorted by source line: fields X/Y (L10-11) precede the
    // methods Sum/Move (L28-29).
    assert.equal(point.children.length, 4);
    assert.deepEqual(labels(point.children), ["X", "Y", "Sum", "Move"]);
});

test("a method whose receiver type is not declared in the file stays top-level", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const haunt: OutlineNode = requireNode(result.nodes, "Haunt");
    assert.equal(haunt.type, "method");
    assert.equal(haunt.depth, 1);
    assert.equal(haunt.path, "go/api.go#Haunt");
    assert.equal(haunt.detail, "func (g Ghost) Haunt() {}");
    assertRange(haunt, ApiText, 30, 30);
    assert.equal(findNode(result.nodes, "Ghost"), undefined);
});

test("interface, alias, func type and map type declarations use the right type kinds", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const shape: OutlineNode = requireNode(result.nodes, "Shape");
    assert.equal(shape.type, "interface");
    assert.equal(shape.depth, 1);
    assert.equal(shape.detail, "type Shape interface {");
    assertRange(shape, ApiText, 14, 17);
    const alias: OutlineNode = requireNode(result.nodes, "Alias");
    assert.equal(alias.type, "type");
    assert.equal(alias.detail, "type Alias = int");
    assertRange(alias, ApiText, 19, 19);
    const handler: OutlineNode = requireNode(result.nodes, "Handler");
    assert.equal(handler.type, "type");
    assert.equal(handler.detail, "type Handler func(int) error");
    assertRange(handler, ApiText, 20, 20);
    const dict: OutlineNode = requireNode(result.nodes, "Dict");
    assert.equal(dict.type, "type");
    assert.equal(dict.detail, "type Dict map[string]int");
    assertRange(dict, ApiText, 21, 21);
});

test("brace-less and multi-line function signatures keep their own ranges", (): void => {
    const result: OutlineResult = outline("go/signatures.go");
    assert.deepEqual(labels(result.nodes[0].children), ["demo", "add", "long"]);
    const add: OutlineNode = requireNode(result.nodes, "add");
    assert.equal(add.type, "function");
    assertRange(add, SignatureText, 3, 3);
    const long: OutlineNode = requireNode(result.nodes, "long");
    assert.equal(long.type, "function");
    assertRange(long, SignatureText, 5, 9);
});

test("multi-name and package-qualified embedded fields become properties", (): void => {
    const result: OutlineResult = outline("go/fieldList.go");
    const pair: OutlineNode = requireNode(result.nodes, "Pair");
    assert.deepEqual(labels(pair.children), ["Left", "Right"]);
    assert.equal(requireNode(pair.children, "Right").type, "property");
    assert.equal(requireNode(pair.children, "Right").detail, "Left, Right int");
    const wrap: OutlineNode = requireNode(result.nodes, "Wrap");
    assert.deepEqual(labels(wrap.children), ["Base", "Base", "Label"]);
});

test("an interface reports embedded interfaces and method signatures", (): void => {
    const result: OutlineResult = outline("go/embeddedInterface.go");
    const readWriter: OutlineNode = requireNode(result.nodes, "ReadWriter");
    assert.deepEqual(labels(readWriter.children), ["Reader", "Writer", "Flush"]);
    assert.equal(requireNode(readWriter.children, "Reader").type, "property");
    assert.equal(requireNode(readWriter.children, "Flush").type, "method");
});

test("multi-return functions, generic functions and function-valued vars are reported", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const pair: OutlineNode = requireNode(result.nodes, "Pair");
    assert.equal(pair.type, "function");
    assert.match(pair.detail ?? "", /\(int, error\)/);
    const mapFn: OutlineNode = requireNode(result.nodes, "Map");
    assert.equal(mapFn.type, "function");
    assert.equal(mapFn.detail, "func Map[T any](xs []T, f func(T) T) []T { return xs }");
    assertRange(mapFn, ApiText, 33, 33);
    const computed: OutlineNode = requireNode(result.nodes, "computed");
    assert.equal(computed.type, "variable");
    assert.equal(computed.depth, 1);
    assertRange(computed, ApiText, 46, 46);
});

test("no declarations emerge from defer, go, select or an anonymous closure", (): void => {
    const result: OutlineResult = outline("go/api.go");
    const run: OutlineNode = requireNode(result.nodes, "run");
    assert.equal(run.type, "function");
    assert.equal(run.depth, 1);
    assertRange(run, ApiText, 35, 44);
    assert.equal(run.children.length, 0);
    const all: OutlineNode[] = flatten(result.nodes);
    const flatLabels: string[] = labels(all);
    for (const hidden of ["func", "Println", "handler", "async", "select", "time", "defer", "go"]) {
        assert.equal(flatLabels.includes(hidden), false, `unexpected node from statement text: ${hidden}`);
    }
    assert.equal(findNode(result.nodes, "handler"), undefined);
});

test("pseudo struct and func declarations in comments, strings and raw strings are invisible", (): void => {
    const result: OutlineResult = outline("go/noise.go");
    assert.deepEqual(labels(result.nodes[0].children), ["demo", "s", "r", "Real"]);
    for (const hidden of ["Fake", "hidden", "S", "Raw", "Z", "X"]) {
        assert.equal(findNode(result.nodes, hidden), undefined, `masked pseudo declaration leaked: ${hidden}`);
    }
    const quoted: OutlineNode = requireNode(result.nodes, "s");
    assert.equal(quoted.detail, "var s =");
    const raw: OutlineNode = requireNode(result.nodes, "r");
    assert.equal(raw.detail, "var r =");
    const real: OutlineNode = requireNode(result.nodes, "Real");
    assert.equal(real.type, "struct");
    assertRange(real, NoiseText, 10, 13);
    assert.deepEqual(labels(real.children), ["Note"]);
    assert.equal(requireNode(real.children, "Note").detail, "Note string");
});

test("an empty Go file produces an anchor with no symbols", (): void => {
    const result: OutlineResult = outline("go/empty.go");
    assert.equal(result.strategy, "go");
    assert.equal(result.truncated, false);
    assert.equal(result.nodes[0].isFile, true);
    assert.equal(result.nodes[0].range.startByte, 0n);
    assert.equal(result.nodes[0].range.endByte, 0n);
    assert.deepEqual(result.nodes[0].children, []);
});

test("a file with only a package clause yields exactly one symbol", (): void => {
    const result: OutlineResult = outline("go/pkgonly.go");
    assert.deepEqual(labels(result.nodes[0].children), ["only"]);
    const only: OutlineNode = result.nodes[0].children[0];
    assert.equal(only.type, "package");
    assert.equal(only.depth, 1);
    assert.equal(only.detail, "package only");
});

test("CRLF input keeps line numbers, strips carriage returns and counts CRLF bytes", (): void => {
    const result: OutlineResult = outline("go/crlf.go");
    assert.equal(result.charset, "utf-8");
    const packageNode: OutlineNode = requireNode(result.nodes, "demo");
    assertRange(packageNode, CrlfText, 1, 1);
    const structNode: OutlineNode = requireNode(result.nodes, "T");
    assert.equal(structNode.type, "struct");
    assertRange(structNode, CrlfText, 3, 5);
    const field: OutlineNode = requireNode(structNode.children, "A");
    assert.equal(field.detail, "A int");
    assert.equal((field.detail ?? "").includes("\r"), false);
    assertRange(field, CrlfText, 4, 4);
});

test("a UTF-8 BOM is reported and raw byte ranges include the prefix", (): void => {
    const result: OutlineResult = outline("go/bom.go");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.strategy, "go");
    const base: bigint = BigInt(Buffer.byteLength("\uFEFF", "utf8"));
    const decoded: string = BomText.slice(1);
    assert.equal(result.nodes[0].range.startByte, 0n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(BomText, "utf8")));
    const assertShiftedRange: (node: OutlineNode, startLine: number, endLine: number) => void = (
        node: OutlineNode, startLine: number, endLine: number,
    ): void => {
        const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(decoded, startLine, endLine);
        assert.equal(Number(node.range.startLine), startLine);
        assert.equal(Number(node.range.endLine), endLine);
        assert.equal(node.range.startByte, expected.startByte + base, `start byte of ${node.label}`);
        assert.equal(node.range.endByte, expected.endByte + base, `end byte of ${node.label}`);
    };
    const packageNode: OutlineNode = requireNode(result.nodes, "bom");
    assertShiftedRange(packageNode, 1, 1);
    assert.equal(packageNode.range.startByte, base);
    const answer: OutlineNode = requireNode(result.nodes, "Answer");
    assert.equal(answer.type, "constant");
    assertShiftedRange(answer, 3, 3);
    assert.equal(answer.range.endByte, BigInt(Buffer.byteLength(BomText, "utf8")));
});

test("Unicode comments, string literals and raw strings do not disturb ASCII declarations", (): void => {
    const result: OutlineResult = outline("go/unicodeContent.go");
    assert.equal(result.charset, "utf-8");
    assert.deepEqual(labels(result.nodes[0].children), ["demo", "Greeting", "Banner", "Config"]);
    for (const hidden of ["Ghost", "Raw"]) {
        assert.equal(findNode(result.nodes, hidden), undefined, `masked Unicode pseudo declaration leaked: ${hidden}`);
    }
    assert.equal(requireNode(result.nodes, "Greeting").detail, "const Greeting =");
    assert.equal(requireNode(result.nodes, "Banner").detail, "var Banner =");
    const config: OutlineNode = requireNode(result.nodes, "Config");
    assertRange(config, UnicodeContentText, 9, 11);
    assert.deepEqual(labels(config.children), ["Label"]);
    assert.equal(requireNode(config.children, "Label").detail, "Label string");
    assert.ok(requireNode(result.nodes, "Greeting").range.startByte > 0n);
});

test("maxNodes truncates symbols after the anchor and flips truncated", (): void => {
    const limited: OutlineResult = outline("go/api.go", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["demo", "Limit"]);
    assert.equal(flatten(limited.nodes).length, 3);
    const anchorOnly: OutlineResult = outline("go/api.go", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.deepEqual(anchorOnly.nodes[0].children, []);
    const complete: OutlineResult = outline("go/api.go", { maxNodes: 2000 });
    assert.equal(complete.truncated, false);
    assert.equal(complete.nodes[0].children.length, 16);
});

test("maxDepth drops struct members and reports truncation without losing root symbols", (): void => {
    const shallow: OutlineResult = outline("go/api.go", { maxDepth: 1 });
    assert.equal(shallow.truncated, true);
    assert.deepEqual(requireNode(shallow.nodes, "Point").children, []);
    assert.deepEqual(requireNode(shallow.nodes, "Tagged").children, []);
    assert.equal(shallow.nodes[0].children.length, 16);
    const full: OutlineResult = outline("go/api.go", { maxDepth: 2 });
    assert.equal(full.truncated, false);
    assert.deepEqual(labels(requireNode(full.nodes, "Point").children), ["X", "Y", "Sum", "Move"]);
    assert.equal(requireNode(full.nodes, "Point").children.length, 4);
});

test("binary Go files and files over the byte ceiling fail with closed error codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("go/blob.go");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("go/huge.go");
    });
    expectFilesystemError("not_found", (): void => {
        outline("go/missing.go");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.go");
    });
});

test("REGRESSION F-01: generic struct declarations are reported with their fields", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/generic.go");
    t.diagnostic(`observed top-level: ${describe(result.nodes[0].children)}`);
    const box: OutlineNode | undefined = findNode(result.nodes, "Box");
    assert.ok(box !== (void 0), "type Box[T any] struct must be reported as a struct symbol");
    assert.equal(box!.type, "struct");
    assert.equal(Number(box!.range.startLine), 3);
    assert.equal(Number(box!.range.endLine), 5);
    assert.deepEqual(labels(box!.children), ["Value", "Get"]);
    assert.equal(requireNode(box!.children, "Value").type, "property");
});

test("REGRESSION F-02: methods with a generic receiver attach to their type", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/generic.go");
    const get: OutlineNode = requireNode(result.nodes, "Get");
    t.diagnostic(`observed Get: depth=${get.depth} path=${get.path}`);
    assert.equal(get.type, "method");
    assert.equal(get.depth, 2, "method with receiver *Box[T] must attach under Box at depth 2");
    assert.equal(get.path, "go/generic.go#Box.Get");
});

test("REGRESSION F-03: embedded struct fields are reported as properties", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/embedded.go");
    const derived: OutlineNode = requireNode(result.nodes, "Derived");
    t.diagnostic(`observed Derived children: ${labels(derived.children).join(",") || "<none>"}`);
    // `Base` and `*Base` are both anonymous fields of Derived.
    assert.ok(labels(derived.children).includes("Base"), "embedded field Base must be a property child of Derived");
    assert.ok(labels(derived.children).includes("Label"), "named field Label must stay a property child");
    assert.deepEqual(labels(derived.children), ["Base", "Base", "Label"]);
    assert.equal(derived.children.filter((node: OutlineNode): boolean => node.type === "property").length, 3);
});

test("REGRESSION F-04: interface method signatures are reported as children", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/iface.go");
    const reader: OutlineNode = requireNode(result.nodes, "Reader");
    t.diagnostic(`observed Reader children: ${labels(reader.children).join(",") || "<none>"}`);
    assert.deepEqual(labels(reader.children), ["Read", "Close"]);
    assert.equal(requireNode(reader.children, "Read").type, "method");
    assert.equal(requireNode(reader.children, "Read").detail, "Read(p []byte) (int, error)");
});

test("REGRESSION F-05: a single-line struct field list is expanded", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/inline.go");
    const inline: OutlineNode = requireNode(result.nodes, "Inline");
    t.diagnostic(`observed Inline children: ${labels(inline.children).join(",") || "<none>"}`);
    assert.deepEqual(labels(inline.children), ["A", "B"]);
    assert.equal(requireNode(inline.children, "B").type, "property");
});

test("REGRESSION F-06: a brace-less type declaration keeps its own range", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/api.go");
    const alias: OutlineNode = requireNode(result.nodes, "Alias");
    t.diagnostic(`observed Alias range: L${Number(alias.range.startLine)}-${Number(alias.range.endLine)} bytes ${alias.range.startByte}-${alias.range.endByte}`);
    assertRange(alias, ApiText, 19, 19);
    const handler: OutlineNode = requireNode(result.nodes, "Handler");
    assertRange(handler, ApiText, 20, 20);
    const dict: OutlineNode = requireNode(result.nodes, "Dict");
    assertRange(dict, ApiText, 21, 21);
});

test("REGRESSION F-07: grouped const and var blocks are reported", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/grouped.go");
    t.diagnostic(`observed top-level: ${describe(result.nodes[0].children)}`);
    assert.deepEqual(labels(result.nodes[0].children), ["demo", "A", "B", "x", "y"]);
    assert.equal(requireNode(result.nodes, "A").type, "constant");
    assert.equal(requireNode(result.nodes, "x").type, "variable");
});

test("REGRESSION F-08: valid non-ASCII Go identifiers are recognized", (t: DiagnosticContext): void => {
    const result: OutlineResult = outline("go/unicodeIdentifier.go");
    t.diagnostic(`observed top-level: ${describe(result.nodes[0].children)}`);
    assert.deepEqual(labels(result.nodes[0].children), ["演示", "配置", "Greeting"]);
    const config: OutlineNode = requireNode(result.nodes, "配置");
    assert.equal(config.type, "struct");
    assert.deepEqual(labels(config.children), ["名称"]);
});
