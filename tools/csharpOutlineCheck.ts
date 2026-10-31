#!/usr/bin/env node
/**
 * C# outline boundary checks.
 *
 * The fixtures are written to a private temporary directory, driven through the
 * public `buildOutline` entry point and removed again after the run. Nothing in
 * the fixture is compiled or executed: `parseCSharp` is a hand-written line and
 * brace scanner, so every assertion here is about *boundary* behaviour, not
 * about C# semantics.
 *
 * The suite mixes contract assertions (what the parser must guarantee) with a
 * few explicit "known limit" assertions for declaration forms the scanner does
 * not model (`operator`, `delegate`, enum members). The limit assertions are
 * collected in `docs/testing/languages/csharpReport.md` §5 and must be updated
 * together with the report when the parser grows.
 *
 * Run with: `node tools/csharpOutlineCheck.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { ByteLineIndex } from "../src/syntax/byteIndex.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineRange, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";
import { rawTextDigest } from "../src/fingerprint/raw.ts";

/**
 * Private fixture root; the sandbox has exactly one writable session root.
 */
const Root: string = mkdtempSync(join(tmpdir(), "amp-csharp-outline-"));
const RootSpec: SessionRoot = { id: "root.csharp", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

/**
 * Half-open byte span used by the line-range assertion helpers.
 */
interface ByteSpan {
    readonly startByte: bigint;
    readonly endByte: bigint;
}

/**
 * Depth-first lookup signature shared by the tree helpers.
 */
type NodeSearch = (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined;

/**
 * Signature of the range assertion helper.
 */
type RangeCheck = (node: OutlineNode, text: string, startLine: number, endLine: number) => void;

/**
 * Signature of the shifted range assertion helper.
 */
type ShiftedRangeCheck = (node: OutlineNode, text: string, startLine: number, endLine: number, shift: bigint) => void;

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
const findNode: NodeSearch = (nodes: readonly OutlineNode[], label: string): OutlineNode | undefined => {
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
const expectedBytes: (text: string, startLine: number, endLine: number) => ByteSpan = (text: string, startLine: number, endLine: number): ByteSpan => {
    const lines: string[] = text.split("\n");
    const endsWithNewline: boolean = text.endsWith("\n");
    const startByte: bigint = startByteOf(text, startLine);
    const endByte: bigint = endLine >= lines.length && !endsWithNewline ? BigInt(Buffer.byteLength(text, "utf8")) : startByteOf(text, endLine + 1);
    return { startByte, endByte };
};

/**
 * Assert one node's line number and UTF-8 byte range.
 */
const assertRange: RangeCheck = (node: OutlineNode, text: string, startLine: number, endLine: number): void => {
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    const expected: ByteSpan = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte);
    assert.equal(node.range.endByte, expected.endByte);
};

/**
 * Assert one node's line number and byte range after a fixed raw-file prefix
 * such as a UTF-8 BOM.
 */
const assertShiftedRange: ShiftedRangeCheck = (node: OutlineNode, text: string, startLine: number, endLine: number, shift: bigint): void => {
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    const expected: ByteSpan = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte + shift);
    assert.equal(node.range.endByte, expected.endByte + shift);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Block-scoped namespace holding one class with a property, an expression-bodied
 * property, a field, a constructor, a method and two static members.
 */
const NamespaceText: string = [
    "namespace Demo.App {",
    "    public class Greeter {",
    "        public string Name { get; set; }",
    "        public int Age => 42;",
    "        private int count = 0;",
    "",
    "        public Greeter(string name) {",
    "            Name = name;",
    "        }",
    "",
    "        public string Greet() {",
    "            return Name;",
    "        }",
    "",
    "        public static int Total { get; set; }",
    "        public static void Reset() { }",
    "    }",
    "}",
].join("\n");

/**
 * File-scoped namespace, so the namespace statement has no closing brace and the
 * class sits at brace depth zero.
 */
const FileScopedText: string = [
    "using System;",
    "using System.Threading.Tasks;",
    "",
    "namespace Acme.Core;",
    "",
    "public sealed class Service {",
    "    public async Task<int> RunAsync(CancellationToken token) {",
    "        return await Task.FromResult(1);",
    "    }",
    "}",
].join("\n");

/**
 * One namespace declaring each supported type kind.
 */
const TypesText: string = [
    "namespace Model {",
    "    public class Person { }",
    "    public record Employee(string Name);",
    "    public readonly struct Money { }",
    "    public interface IShape {",
    "        double Area();",
    "    }",
    "    public enum Color { Red, Green }",
    "    internal static partial class Util { }",
    "}",
].join("\n");

/**
 * Member matrix on a top-level class: auto property with initializer,
 * expression-bodied property, field, constructor, method, static factory, static
 * property, const field and event field.
 */
const MembersText: string = [
    "public class Account {",
    '    public string Owner { get; set; } = "nobody";',
    "    public decimal Balance => 0m;",
    "    private int logins = 0;",
    "    public Account(string owner) {",
    "        Owner = owner;",
    "    }",
    "    public void Deposit(decimal amount) {",
    "        logins = logins + 1;",
    "    }",
    "    public static Account Open(string owner) => new Account(owner);",
    "    public static int Opened { get; private set; }",
    "    public const int Max = 10;",
    "    public event EventHandler? Changed;",
    "}",
].join("\n");

/**
 * Attribute, generic, async, partial, readonly and required forms, including an
 * attribute written in front of the declaration on the same line.
 */
const FeaturesText: string = [
    "using System;",
    "",
    "namespace Features {",
    "    public partial class Widget {",
    '        [Obsolete("use NewWidget")]',
    "        public void Legacy() { }",
    "",
    "        [Obsolete] public void SameLine() { }",
    "",
    "        public required string Id { get; init; }",
    "        public readonly int Seed = 1;",
    '        public static readonly string Tag = "tag";',
    "        public async Task<int> LoadAsync() {",
    "            return await Task.FromResult(Seed);",
    "        }",
    "        public T Pick<T>(T value) where T : class {",
    "            return value;",
    "        }",
    "        public Widget Clone() => new Widget();",
    "    }",
    "}",
].join("\n");

/**
 * Pseudo declarations hidden in line comments, block comments, string literals,
 * interpolated strings, verbatim strings, raw string literals and char literals.
 */
const StringsText: string = [
    "// public class NotReal { }",
    "/* public void AlsoNotReal() { } */",
    "public class Real {",
    '    public string Literal = "class Fake { void Hidden() { } }";',
    '    public string Verb = @"verbatim { } class V { }";',
    '    public string Interp = $"value {1 + 1} class I { }";',
    '    public string Raw = """',
    "        class RawFake { }",
    '        """;',
    "    public char Brace = '{';",
    "    public void After() { }",
    "}",
].join("\n");

/**
 * A verbatim string spanning lines, with brace-shaped text inside it.
 */
const VerbatimText: string = [
    "public class Holder {",
    '    public string Sql = @"',
    "class MultiLineFake {",
    "    public void Nope() { }",
    '";',
    "    public void Real() { }",
    "}",
].join("\n");

/**
 * Allman-style property whose body brace starts on the next line.
 */
const AllmanText: string = [
    "public class Style {",
    "    public string Name",
    "    {",
    "        get => Name;",
    "        set => Name = value;",
    "    }",
    "    public void Keep() { }",
    "}",
].join("\n");

/**
 * Positional record forms: plain record, `record class` and `record struct`.
 */
const RecordsText: string = [
    "public record Person(string Name);",
    "public record class Entity(int Id);",
    "public record struct Point(int X, int Y);",
    "public readonly struct Money { }",
].join("\n");

/**
 * Constructor forms: implicit private, static, explicit public and finalizer.
 */
const CtorText: string = ["public class Ctor {", "    Ctor() { }", "    static Ctor() { }", "    public Ctor(int value) { }", "    ~Ctor() { }", "}"].join(
    "\n",
);

/**
 * CRLF fixture with the same three-level shape as the block namespace fixture.
 */
const CrlfText: string = "namespace Win {\r\n    public class Form {\r\n        public int Width { get; set; }\r\n    }\r\n}\r\n";

/**
 * UTF-8 BOM fixture body; the three BOM bytes are prepended when it is written.
 */
const BomBody: string = "namespace Bom {\r\n    public class Widget {\r\n        public string Name { get; set; }\r\n    }\r\n}\r\n";

/**
 * UTF-8 BOM plus body, written as raw bytes so detection sees the marker.
 */
const BomBytes: Uint8Array = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomBody, "utf8")]));

/**
 * CJK comment and string content under ASCII identifiers.
 */
const UnicodeText: string = [
    "// 中文注释：class 假类 { void 假方法() { } }",
    "namespace Demo {",
    "    public class Data {",
    '        public string Title = "中文标题 { }";',
    "        public void Run() { }",
    "    }",
    "}",
].join("\n");

/**
 * CJK namespace, type, method and property identifiers, which C# accepts.
 */
const CjkIdentifierText: string = [
    "// 中文注释：class 假类 { }",
    "namespace 中文.空间 {",
    "    public class 数据 {",
    '        public string 名称 = "中文 { }";',
    "        public void 处理() { }",
    "    }",
    "}",
].join("\n");

/**
 * Indexer with a get-body brace and a normal expression-bodied property.
 */
const IndexerText: string = [
    "public class Matrix {",
    "    public int this[int row, int column] {",
    "        get { return 0; }",
    "    }",
    "    public int Count => 0;",
    "}",
].join("\n");

/**
 * Types whose whole body sits on the declaration line.
 */
const InlineText: string = [
    "public class Inline { public int X { get; set; } public void Run() { } }",
    "public interface IOne { double Area(); void Save(); }",
].join("\n");

/**
 * Nested type declared before a sibling member, to check document order.
 */
const NestedText: string = ["public class Outer {", "    public class Inner { }", "    public int X { get; set; }", "}"].join("\n");

/**
 * Declaration forms the scanner does not model (see report §5).
 */
const UnsupportedText: string = [
    "public class Ops {",
    "    public static Ops operator +(Ops left, Ops right) => left;",
    "    public delegate void Handler();",
    "}",
].join("\n");

/**
 * Five sibling classes, used for the node budget.
 */
const ManyText: string = ["public class C1 { }", "public class C2 { }", "public class C3 { }", "public class C4 { }", "public class C5 { }"].join("\n");

/**
 * Namespace > class > nested class > method: four outline levels.
 */
const DeepText: string = [
    "namespace Deep {",
    "    public class Outer {",
    "        public class Inner {",
    "            public void Run() { }",
    "        }",
    "    }",
    "}",
].join("\n");

/**
 * Filler comment lines beyond the 3000-line structural scan window.
 */
const ScanFiller: string[] = Array.from({ length: 3005 }, (unused: unknown, index: number): string => `    // filler ${index}`);

/**
 * A class whose body starts inside the scan window and closes after it, plus a
 * second class that is never scanned.
 */
const ScanText: string = ["public class First {", ...ScanFiller, "}", "public class After { }"].join("\n");

fixture("namespace/Greeter.cs", NamespaceText);
fixture("fileScoped/Service.cs", FileScopedText);
fixture("types/Model.cs", TypesText);
fixture("members/Account.cs", MembersText);
fixture("features/Widget.cs", FeaturesText);
fixture("strings/Real.cs", StringsText);
fixture("regression/Verbatim.cs", VerbatimText);
fixture("regression/Allman.cs", AllmanText);
fixture("regression/Records.cs", RecordsText);
fixture("regression/Ctor.cs", CtorText);
fixture("edge/Empty.cs", "");
fixture("edge/Using.cs", "using System;\nusing System.Linq;\n");
fixture("edge/Blank.cs", "  \n\n\t\n");
fixture("edge/Crlf.cs", CrlfText);
fixture("edge/Bom.cs", BomBytes);
fixture("edge/Unicode.cs", UnicodeText);
fixture("edge/CjkIdentifiers.cs", CjkIdentifierText);
fixture("edge/Indexer.cs", IndexerText);
fixture("edge/Inline.cs", InlineText);
fixture("edge/Nested.cs", NestedText);
fixture("limits/Unsupported.cs", UnsupportedText);
fixture("limits/Many.cs", ManyText);
fixture("limits/Deep.cs", DeepText);
fixture("limits/Blob.cs", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("limits/Huge.cs", Buffer.alloc(4 * 1024 * 1024 + 1, 97));
fixture("limits/Scan.cs", ScanText);

test("block namespace nests class and member nodes with exact paths and ranges", (): void => {
    const result: OutlineResult = outline("namespace/Greeter.cs");
    assert.equal(result.strategy, "csharp");
    assert.equal(result.category, "code");
    assert.equal(result.language, "csharp");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.fingerprint, outlineNodeFingerprint(result.nodes[0]));
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "namespace/Greeter.cs");
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(NamespaceText, "utf8")));
    assertRange(anchor, NamespaceText, 1, 18);
    const namespaceNode: OutlineNode = requireNode(result.nodes, "Demo.App");
    assert.equal(namespaceNode.type, "namespace");
    assert.equal(namespaceNode.depth, 1);
    assert.equal(namespaceNode.path, "namespace/Greeter.cs#Demo.App");
    assert.equal(namespaceNode.modifiers, (void 0));
    assertRange(namespaceNode, NamespaceText, 1, 18);
    const greeter: OutlineNode = requireNode(namespaceNode.children, "Greeter");
    assert.equal(greeter.type, "class");
    assert.equal(greeter.depth, 2);
    assert.equal(greeter.path, "namespace/Greeter.cs#Demo.App.Greeter");
    assert.deepEqual(greeter.modifiers, ["public"]);
    assertRange(greeter, NamespaceText, 2, 17);
    assert.deepEqual(labels(greeter.children), ["Name", "Age", "count", "Greeter", "Greet", "Total", "Reset"]);
    const name: OutlineNode = requireNode(greeter.children, "Name");
    assert.equal(name.type, "property");
    assert.equal(name.depth, 3);
    assert.equal(name.detail, "public string Name { get; set; }");
    assert.deepEqual(name.modifiers, ["public"]);
    assertRange(name, NamespaceText, 3, 3);
    const age: OutlineNode = requireNode(greeter.children, "Age");
    assert.equal(age.type, "property");
    assert.equal(age.detail, "public int Age => 42;");
    assertRange(age, NamespaceText, 4, 4);
    const count: OutlineNode = requireNode(greeter.children, "count");
    assert.equal(count.type, "property");
    assert.deepEqual(count.modifiers, ["private"]);
    assertRange(count, NamespaceText, 5, 5);
    const constructor: OutlineNode = requireNode(greeter.children, "Greeter");
    assert.equal(constructor.type, "method");
    assert.deepEqual(constructor.modifiers, ["public"]);
    assertRange(constructor, NamespaceText, 7, 9);
    const greet: OutlineNode = requireNode(greeter.children, "Greet");
    assert.equal(greet.type, "method");
    assertRange(greet, NamespaceText, 11, 13);
    const total: OutlineNode = requireNode(greeter.children, "Total");
    assert.equal(total.type, "property");
    assert.deepEqual(total.modifiers, ["public", "static"]);
    const reset: OutlineNode = requireNode(greeter.children, "Reset");
    assert.equal(reset.type, "method");
    assert.deepEqual(reset.modifiers, ["public", "static"]);
    assertRange(reset, NamespaceText, 16, 16);
    assert.equal(findNode(result.nodes, "Fake"), (void 0));
});

test("file-scoped namespace spans the file and its type is anchored under it", (): void => {
    const result: OutlineResult = outline("fileScoped/Service.cs");
    assert.equal(result.strategy, "csharp");
    assert.equal(result.truncated, false);
    const namespaceNode: OutlineNode = requireNode(result.nodes, "Acme.Core");
    assert.equal(namespaceNode.type, "namespace");
    assert.equal(namespaceNode.depth, 1);
    assert.equal(namespaceNode.detail, "namespace Acme.Core;");
    assertRange(namespaceNode, FileScopedText, 4, 10);
    const service: OutlineNode = requireNode(namespaceNode.children, "Service");
    assert.equal(service.type, "class");
    assert.equal(service.depth, 2);
    assert.equal(service.path, "fileScoped/Service.cs#Acme.Core.Service");
    assert.deepEqual(service.modifiers, ["public", "sealed"]);
    assertRange(service, FileScopedText, 6, 10);
    assert.deepEqual(labels(service.children), ["RunAsync"]);
    const run: OutlineNode = requireNode(service.children, "RunAsync");
    assert.equal(run.type, "method");
    assert.equal(run.depth, 3);
    assert.deepEqual(run.modifiers, ["public", "async"]);
    assertRange(run, FileScopedText, 7, 9);
    assert.equal(findNode(result.nodes, "System"), (void 0));
});

test("class, record, struct, interface and enum keep their distinct kinds and modifiers", (): void => {
    const result: OutlineResult = outline("types/Model.cs");
    const model: OutlineNode = requireNode(result.nodes, "Model");
    assert.equal(model.type, "namespace");
    assert.deepEqual(labels(model.children), ["Person", "Employee", "Money", "IShape", "Color", "Util"]);
    const person: OutlineNode = requireNode(model.children, "Person");
    assert.equal(person.type, "class");
    assert.equal(person.depth, 2);
    assert.deepEqual(person.modifiers, ["public"]);
    assertRange(person, TypesText, 2, 2);
    const employee: OutlineNode = requireNode(model.children, "Employee");
    assert.equal(employee.type, "class");
    assert.equal(employee.label, "Employee");
    assert.deepEqual(employee.modifiers, ["public"]);
    assertRange(employee, TypesText, 3, 3);
    const money: OutlineNode = requireNode(model.children, "Money");
    assert.equal(money.type, "struct");
    assert.deepEqual(money.modifiers, ["public", "readonly"]);
    assertRange(money, TypesText, 4, 4);
    const shape: OutlineNode = requireNode(model.children, "IShape");
    assert.equal(shape.type, "interface");
    assertRange(shape, TypesText, 5, 7);
    assert.deepEqual(labels(shape.children), ["Area"]);
    assert.equal(requireNode(shape.children, "Area").type, "method");
    assertRange(requireNode(shape.children, "Area"), TypesText, 6, 6);
    const color: OutlineNode = requireNode(model.children, "Color");
    assert.equal(color.type, "enum");
    assertRange(color, TypesText, 8, 8);
    assert.equal(color.children.length, 0);
    const util: OutlineNode = requireNode(model.children, "Util");
    assert.equal(util.type, "class");
    assert.deepEqual(util.modifiers, ["internal", "static", "partial"]);
    assert.equal(util.children.length, 0);
    assertRange(util, TypesText, 9, 9);
    assert.equal(util.path, "types/Model.cs#Model.Util");
});

test("property, field, constructor, method, const, event and static members classify with modifiers", (): void => {
    const result: OutlineResult = outline("members/Account.cs");
    const account: OutlineNode = requireNode(result.nodes, "Account");
    assert.equal(account.type, "class");
    assert.equal(account.depth, 1);
    assert.deepEqual(labels(account.children), ["Owner", "Balance", "logins", "Account", "Deposit", "Open", "Opened", "Max", "Changed"]);
    const owner: OutlineNode = requireNode(account.children, "Owner");
    assert.equal(owner.type, "property");
    assert.deepEqual(owner.modifiers, ["public"]);
    assert.ok((owner.detail ?? "").startsWith("public string Owner { get; set; }"));
    assert.equal((owner.detail ?? "").includes("nobody"), false);
    assertRange(owner, MembersText, 2, 2);
    const balance: OutlineNode = requireNode(account.children, "Balance");
    assert.equal(balance.type, "property");
    assert.equal(balance.detail, "public decimal Balance => 0m;");
    assertRange(balance, MembersText, 3, 3);
    const logins: OutlineNode = requireNode(account.children, "logins");
    assert.equal(logins.type, "property");
    assert.deepEqual(logins.modifiers, ["private"]);
    assertRange(logins, MembersText, 4, 4);
    const constructor: OutlineNode = requireNode(account.children, "Account");
    assert.equal(constructor.type, "method");
    assert.deepEqual(constructor.modifiers, ["public"]);
    assertRange(constructor, MembersText, 5, 7);
    const deposit: OutlineNode = requireNode(account.children, "Deposit");
    assert.equal(deposit.type, "method");
    assert.deepEqual(deposit.modifiers, ["public"]);
    assertRange(deposit, MembersText, 8, 10);
    const open: OutlineNode = requireNode(account.children, "Open");
    assert.equal(open.type, "method");
    assert.deepEqual(open.modifiers, ["public", "static"]);
    assertRange(open, MembersText, 11, 11);
    const opened: OutlineNode = requireNode(account.children, "Opened");
    assert.equal(opened.type, "property");
    assert.deepEqual(opened.modifiers, ["public", "static"]);
    assertRange(opened, MembersText, 12, 12);
    const max: OutlineNode = requireNode(account.children, "Max");
    assert.equal(max.type, "constant");
    assert.deepEqual(max.modifiers, ["public", "const"]);
    assertRange(max, MembersText, 13, 13);
    const changed: OutlineNode = requireNode(account.children, "Changed");
    assert.equal(changed.type, "property");
    assert.deepEqual(changed.modifiers, ["public", "event"]);
    assertRange(changed, MembersText, 14, 14);
});

test("attributes, generics, async, partial, readonly and required reach the expected nodes", (): void => {
    const result: OutlineResult = outline("features/Widget.cs");
    const widget: OutlineNode = requireNode(result.nodes, "Widget");
    assert.equal(widget.type, "class");
    assert.equal(widget.depth, 2);
    assert.deepEqual(widget.modifiers, ["public", "partial"]);
    assert.deepEqual(labels(widget.children), ["Legacy", "SameLine", "Id", "Seed", "Tag", "LoadAsync", "Pick", "Clone"]);
    const legacy: OutlineNode = requireNode(widget.children, "Legacy");
    assert.equal(legacy.type, "method");
    assert.deepEqual(legacy.modifiers, ["public"]);
    assertRange(legacy, FeaturesText, 6, 6);
    const sameLine: OutlineNode = requireNode(widget.children, "SameLine");
    assert.equal(sameLine.type, "method");
    assert.deepEqual(sameLine.modifiers, ["public"]);
    assertRange(sameLine, FeaturesText, 8, 8);
    assert.equal(findNode(result.nodes, "Obsolete"), (void 0));
    const id: OutlineNode = requireNode(widget.children, "Id");
    assert.equal(id.type, "property");
    assert.deepEqual(id.modifiers, ["public", "required"]);
    assertRange(id, FeaturesText, 10, 10);
    const seed: OutlineNode = requireNode(widget.children, "Seed");
    assert.equal(seed.type, "property");
    assert.deepEqual(seed.modifiers, ["public", "readonly"]);
    const tag: OutlineNode = requireNode(widget.children, "Tag");
    assert.equal(tag.type, "property");
    assert.deepEqual(tag.modifiers, ["public", "static", "readonly"]);
    const load: OutlineNode = requireNode(widget.children, "LoadAsync");
    assert.equal(load.type, "method");
    assert.equal(load.label, "LoadAsync");
    assert.deepEqual(load.modifiers, ["public", "async"]);
    assertRange(load, FeaturesText, 13, 15);
    const pick: OutlineNode = requireNode(widget.children, "Pick");
    assert.equal(pick.type, "method");
    assertRange(pick, FeaturesText, 16, 18);
    const clone: OutlineNode = requireNode(widget.children, "Clone");
    assert.equal(clone.type, "method");
    assertRange(clone, FeaturesText, 19, 19);
});

test("pseudo declarations inside comments, strings, interpolation and raw strings stay invisible", (): void => {
    const result: OutlineResult = outline("strings/Real.cs");
    const real: OutlineNode = requireNode(result.nodes, "Real");
    assert.equal(real.type, "class");
    assert.deepEqual(labels(real.children), ["Literal", "Verb", "Interp", "Raw", "Brace", "After"]);
    assert.equal(findNode(result.nodes, "Fake"), (void 0));
    assert.equal(findNode(result.nodes, "Hidden"), (void 0));
    assert.equal(findNode(result.nodes, "NotReal"), (void 0));
    assert.equal(findNode(result.nodes, "AlsoNotReal"), (void 0));
    assert.equal(findNode(result.nodes, "RawFake"), (void 0));
    assert.equal(findNode(result.nodes, "V"), (void 0));
    assert.equal(findNode(result.nodes, "I"), (void 0));
    const literal: OutlineNode = requireNode(real.children, "Literal");
    assert.equal(literal.type, "property");
    assert.equal((literal.detail ?? "").includes("class Fake"), false);
    const raw: OutlineNode = requireNode(real.children, "Raw");
    assert.equal(raw.type, "property");
    assertRange(raw, StringsText, 7, 9);
    const brace: OutlineNode = requireNode(real.children, "Brace");
    assert.equal(brace.type, "property");
    assertRange(brace, StringsText, 10, 10);
    const after: OutlineNode = requireNode(real.children, "After");
    assert.equal(after.type, "method");
    assertRange(after, StringsText, 11, 11);
});

test("a multi-line verbatim string is masked: no pseudo nodes and the outer range stays intact", (): void => {
    const result: OutlineResult = outline("regression/Verbatim.cs");
    const holder: OutlineNode = requireNode(result.nodes, "Holder");
    assert.equal(holder.type, "class");
    assert.equal(holder.depth, 1);
    assertRange(holder, VerbatimText, 1, 7);
    assert.deepEqual(labels(holder.children), ["Sql", "Real"]);
    const sql: OutlineNode = requireNode(holder.children, "Sql");
    assert.equal(sql.type, "property");
    assert.ok((sql.detail ?? "").startsWith("public string Sql"));
    assertRange(sql, VerbatimText, 2, 5);
    const real: OutlineNode = requireNode(holder.children, "Real");
    assert.equal(real.type, "method");
    assertRange(real, VerbatimText, 6, 6);
    assert.equal(findNode(result.nodes, "MultiLineFake"), (void 0));
    assert.equal(findNode(result.nodes, "Nope"), (void 0));
});

test("an Allman property whose body brace starts on the next line is outlined", (): void => {
    const result: OutlineResult = outline("regression/Allman.cs");
    const style: OutlineNode = requireNode(result.nodes, "Style");
    assert.equal(style.type, "class");
    assertRange(style, AllmanText, 1, 8);
    assert.deepEqual(labels(style.children), ["Name", "Keep"]);
    const name: OutlineNode = requireNode(style.children, "Name");
    assert.equal(name.type, "property");
    assert.deepEqual(name.modifiers, ["public"]);
    assert.equal(name.depth, 2);
    assertRange(name, AllmanText, 2, 6);
    const keep: OutlineNode = requireNode(style.children, "Keep");
    assertRange(keep, AllmanText, 7, 7);
});

test("record class and record struct keep their real type name and kind", (): void => {
    const result: OutlineResult = outline("regression/Records.cs");
    assert.deepEqual(labels(result.nodes[0].children), ["Person", "Entity", "Point", "Money"]);
    const person: OutlineNode = requireNode(result.nodes, "Person");
    assert.equal(person.type, "class");
    assert.deepEqual(person.modifiers, ["public"]);
    assertRange(person, RecordsText, 1, 1);
    const entity: OutlineNode = requireNode(result.nodes, "Entity");
    assert.equal(entity.type, "class");
    assert.equal(entity.label, "Entity");
    assertRange(entity, RecordsText, 2, 2);
    const point: OutlineNode = requireNode(result.nodes, "Point");
    assert.equal(point.type, "struct");
    assert.equal(point.label, "Point");
    assertRange(point, RecordsText, 3, 3);
    const money: OutlineNode = requireNode(result.nodes, "Money");
    assert.equal(money.type, "struct");
    assert.deepEqual(money.modifiers, ["public", "readonly"]);
    assert.equal(findNode(result.nodes, "class"), (void 0));
    assert.equal(findNode(result.nodes, "struct"), (void 0));
});

test("modifier-less constructor and finalizer are outlined and static constructors stay distinguishable", (): void => {
    const result: OutlineResult = outline("regression/Ctor.cs");
    const ctor: OutlineNode = requireNode(result.nodes, "Ctor");
    assert.deepEqual(labels(ctor.children), ["Ctor", "Ctor", "Ctor", "~Ctor"]);
    const starts: number[] = ctor.children.map((node: OutlineNode): number => Number(node.range.startLine));
    assert.deepEqual(starts, [2, 3, 4, 5]);
    assert.equal(ctor.children[0].modifiers, (void 0));
    assert.deepEqual(ctor.children[1].modifiers, ["static"]);
    assert.deepEqual(ctor.children[2].modifiers, ["public"]);
    assert.equal(ctor.children[3].modifiers, (void 0));
    assert.equal(ctor.children[3].type, "method");
    assertRange(ctor.children[3], CtorText, 5, 5);
});

test("empty, using-only and whitespace-only files yield an anchor without symbols", (): void => {
    const empty: OutlineResult = outline("edge/Empty.cs");
    assert.equal(empty.strategy, "csharp");
    assert.equal(empty.language, "csharp");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes.length, 1);
    assert.equal(empty.nodes[0].isFile, true);
    assert.equal(empty.nodes[0].children.length, 0);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assertRange(empty.nodes[0], "", 1, 1);
    assert.match(empty.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const usingOnly: OutlineResult = outline("edge/Using.cs");
    assert.equal(usingOnly.strategy, "csharp");
    assert.equal(usingOnly.nodes[0].children.length, 0);
    assert.equal(usingOnly.truncated, false);
    const blank: OutlineResult = outline("edge/Blank.cs");
    assert.equal(blank.nodes[0].children.length, 0);
    assertRange(blank.nodes[0], "  \n\n\t\n", 1, 3);
});

test("CRLF line endings keep line numbers, byte ranges and clean details", (): void => {
    const result: OutlineResult = outline("edge/Crlf.cs");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const win: OutlineNode = requireNode(result.nodes, "Win");
    assertRange(win, CrlfText, 1, 5);
    const form: OutlineNode = requireNode(win.children, "Form");
    assertRange(form, CrlfText, 2, 4);
    const width: OutlineNode = requireNode(form.children, "Width");
    assert.equal(width.type, "property");
    assert.equal(width.detail, "public int Width { get; set; }");
    assert.equal((width.detail ?? "").includes("\r"), false);
    assertRange(width, CrlfText, 3, 3);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(CrlfText, "utf8")));
    assert.equal(result.nodes[0].range.endByte, BigInt(CrlfText.length));
});

test("UTF-8 BOM is bridged: ranges are raw-file offsets and fingerprints stay decoded", (): void => {
    const result: OutlineResult = outline("edge/Bom.cs");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.strategy, "csharp");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(BomBytes.byteLength));
    const bom: OutlineNode = requireNode(result.nodes, "Bom");
    assert.equal(bom.type, "namespace");
    assertShiftedRange(bom, BomBody, 1, 5, 3n);
    const widget: OutlineNode = requireNode(bom.children, "Widget");
    assertShiftedRange(widget, BomBody, 2, 4, 3n);
    const name: OutlineNode = requireNode(widget.children, "Name");
    assertShiftedRange(name, BomBody, 3, 3, 3n);
    const localRange: OutlineRange = {
        startByte: name.range.startByte - 3n,
        endByte: name.range.endByte - 3n,
        startLine: name.range.startLine,
        endLine: name.range.endLine,
    };
    assert.equal(outlineNodeFingerprint(name), rawTextDigest(new ByteLineIndex(BomBody).slice(localRange)));
});

test("Unicode content keeps UTF-8 byte offsets and CJK identifiers become outline nodes", (): void => {
    const content: OutlineResult = outline("edge/Unicode.cs");
    const data: OutlineNode = requireNode(content.nodes, "Data");
    assert.equal(data.type, "class");
    assert.equal(findNode(content.nodes, "假类"), (void 0));
    const title: OutlineNode = requireNode(data.children, "Title");
    assertRange(title, UnicodeText, 4, 4);
    const titleLine: string = '        public string Title = "中文标题 { }";';
    assert.ok(Number(title.range.endByte - title.range.startByte) > titleLine.length);
    const run: OutlineNode = requireNode(data.children, "Run");
    assertRange(run, UnicodeText, 5, 5);
    const cjk: OutlineResult = outline("edge/CjkIdentifiers.cs");
    assert.equal(cjk.strategy, "csharp");
    const namespaceNode: OutlineNode = requireNode(cjk.nodes, "中文.空间");
    assert.equal(namespaceNode.type, "namespace");
    assert.equal(namespaceNode.depth, 1);
    assert.equal(namespaceNode.path, "edge/CjkIdentifiers.cs#中文.空间");
    const type: OutlineNode = requireNode(namespaceNode.children, "数据");
    assert.equal(type.type, "class");
    assert.equal(type.depth, 2);
    const property: OutlineNode = requireNode(type.children, "名称");
    assert.equal(property.type, "property");
    assertRange(property, CjkIdentifierText, 4, 4);
    const method: OutlineNode = requireNode(type.children, "处理");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 3);
    assertRange(method, CjkIdentifierText, 5, 5);
    assert.equal(findNode(cjk.nodes, "假类"), (void 0));
});

test("an indexer becomes a property node and shares the member scan", (): void => {
    const result: OutlineResult = outline("edge/Indexer.cs");
    const matrix: OutlineNode = requireNode(result.nodes, "Matrix");
    assert.deepEqual(labels(matrix.children), ["this[]", "Count"]);
    const indexer: OutlineNode = requireNode(matrix.children, "this[]");
    assert.equal(indexer.type, "property");
    assert.deepEqual(indexer.modifiers, ["public"]);
    assertRange(indexer, IndexerText, 2, 4);
    assert.equal(indexer.path, "edge/Indexer.cs#Matrix.this[]");
    const count: OutlineNode = requireNode(matrix.children, "Count");
    assertRange(count, IndexerText, 5, 5);
});

test("members of a type whose body is on the declaration line are outlined", (): void => {
    const result: OutlineResult = outline("edge/Inline.cs");
    const inline: OutlineNode = requireNode(result.nodes, "Inline");
    assert.deepEqual(labels(inline.children), ["X", "Run"]);
    assert.equal(requireNode(inline.children, "X").type, "property");
    assert.equal(requireNode(inline.children, "Run").type, "method");
    assertRange(inline, InlineText, 1, 1);
    assertRange(requireNode(inline.children, "X"), InlineText, 1, 1);
    const one: OutlineNode = requireNode(result.nodes, "IOne");
    assert.equal(one.type, "interface");
    assert.deepEqual(labels(one.children), ["Area", "Save"]);
    assert.equal(requireNode(one.children, "Area").type, "method");
    assert.equal(requireNode(one.children, "Save").type, "method");
    assertRange(one, InlineText, 2, 2);
});

test("children come out in document order, nested types included", (): void => {
    const result: OutlineResult = outline("edge/Nested.cs");
    const outer: OutlineNode = requireNode(result.nodes, "Outer");
    assert.deepEqual(labels(outer.children), ["Inner", "X"]);
    const inner: OutlineNode = requireNode(outer.children, "Inner");
    assert.equal(inner.type, "class");
    assert.equal(inner.depth, 2);
    assertRange(inner, NestedText, 2, 2);
    const member: OutlineNode = requireNode(outer.children, "X");
    assert.equal(member.depth, 2);
    assertRange(member, NestedText, 3, 3);
});

test("operator and delegate declarations stay outside the outline (known limit)", (): void => {
    const result: OutlineResult = outline("limits/Unsupported.cs");
    const ops: OutlineNode = requireNode(result.nodes, "Ops");
    assert.equal(ops.type, "class");
    assert.equal(ops.children.length, 0);
    assert.equal(findNode(result.nodes, "operator"), (void 0));
    assert.equal(findNode(result.nodes, "Handler"), (void 0));
});

test("symbol paths are dotted and ranges round-trip through the byte line index", (): void => {
    const result: OutlineResult = outline("namespace/Greeter.cs");
    const greeter: OutlineNode = requireNode(result.nodes, "Greeter");
    const total: OutlineNode = requireNode(greeter.children, "Total");
    assert.equal(total.path, "namespace/Greeter.cs#Demo.App.Greeter.Total");
    assert.equal(outlineNodeFingerprint(greeter), rawTextDigest(new ByteLineIndex(NamespaceText).slice(greeter.range)));
    assert.equal(outlineNodeFingerprint(total), rawTextDigest(new ByteLineIndex(NamespaceText).slice(total.range)));
    assert.notEqual(outlineNodeFingerprint(greeter), outlineNodeFingerprint(total));
    const lines: string[] = NamespaceText.split("\n");
    assert.equal(Number(total.range.startLine), 15);
    assert.equal(lines[14], "        public static int Total { get; set; }");
});

test("maxNodes counts the anchor and truncates with an explicit flag", (): void => {
    const limited: OutlineResult = outline("limits/Many.cs", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.equal(limited.nodes[0].isFile, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["C1", "C2"]);
    const one: OutlineResult = outline("limits/Many.cs", { maxNodes: 1 });
    assert.equal(one.truncated, true);
    assert.equal(one.nodes[0].children.length, 0);
    const complete: OutlineResult = outline("limits/Many.cs", { maxNodes: 100 });
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 6);
    assert.deepEqual(labels(complete.nodes[0].children), ["C1", "C2", "C3", "C4", "C5"]);
    const clamped: OutlineResult = outline("limits/Many.cs", { maxNodes: 100000 });
    assert.equal(clamped.truncated, false);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/Many.cs", { maxNodes: 0 });
    });
});

test("maxDepth drops whole subtrees and marks the result truncated", (): void => {
    const complete: OutlineResult = outline("limits/Deep.cs");
    assert.equal(complete.truncated, false);
    const run: OutlineNode = requireNode(complete.nodes, "Run");
    assert.equal(run.depth, 4);
    assert.equal(requireNode(complete.nodes, "Inner").depth, 3);
    const two: OutlineResult = outline("limits/Deep.cs", { maxDepth: 2 });
    assert.equal(two.truncated, true);
    assert.deepEqual(labels(two.nodes[0].children), ["Deep"]);
    assert.equal(requireNode(two.nodes, "Outer").depth, 2);
    assert.equal(findNode(two.nodes, "Inner"), (void 0));
    const three: OutlineResult = outline("limits/Deep.cs", { maxDepth: 3 });
    assert.equal(three.truncated, true);
    assert.equal(requireNode(three.nodes, "Inner").depth, 3);
    assert.equal(findNode(three.nodes, "Run"), (void 0));
    const one: OutlineResult = outline("limits/Deep.cs", { maxDepth: 1 });
    assert.equal(one.truncated, true);
    assert.equal(one.nodes[0].children.length, 1);
    assert.equal(findNode(one.nodes, "Outer"), (void 0));
    expectFilesystemError("invalid_arguments", (): void => {
        outline("limits/Deep.cs", { maxDepth: 0 });
    });
});

test("binary, oversized, missing and escaping targets raise closed error codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("limits/Blob.cs");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("limits/Huge.cs");
    });
    expectFilesystemError("not_found", (): void => {
        outline("limits/Missing.cs");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.cs");
    });
});

test("the 3000-line scan window truncates at the last scanned line, not the declaration", (): void => {
    const result: OutlineResult = outline("limits/Scan.cs");
    assert.equal(result.truncated, true);
    assert.deepEqual(labels(result.nodes[0].children), ["First"]);
    const first: OutlineNode = requireNode(result.nodes, "First");
    assert.equal(Number(first.range.startLine), 1);
    assert.equal(Number(first.range.endLine), 3000);
    assert.equal(findNode(result.nodes, "After"), (void 0));
    assert.equal(Number(result.nodes[0].range.endLine), ScanText.split("\n").length);
});
