#!/usr/bin/env node
/**
 * Visual Basic outline boundary checks.
 *
 * Fixtures are written to a private temporary directory and removed after the
 * run; fixture source is never executed. The default registry does not contain
 * the VB strategy yet, so every check goes through
 * `new OutlineRegistry([VisualBasicStrategy])`, which exercises sandbox
 * resolution, the byte ceiling, charset detection, strategy selection,
 * line-to-byte mapping and truncation exactly like the built-in strategies.
 * `parseVisualBasic` is also called directly to pin the pure-text contract.
 *
 * The file has three parts:
 *
 * 1. contract checks for the documented VB behavior (blocks, members,
 *    modifiers, comments, attributes, auto-properties, VBScript properties);
 * 2. bound checks for `maxNodes`/`maxDepth` and the closed error codes;
 * 3. a range/invariant sweep over every fixture that asserts bigint ordering,
 *    parent containment, symbol paths and per-node fingerprints.
 *
 * Integration is the host's job: registering `VisualBasicStrategy` in
 * `builtinOutlineStrategies` (before `plainText`) is the only change needed,
 * and the `VisualBasicStrategy.matches` check keeps `.vbproj` on the XML
 * strategy.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { LineIndex } from "../src/syntax/charset.ts";
import { FilesystemError } from "../src/file/errors.ts";
import { OutlineRegistry, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import { VisualBasicStrategy, parseVisualBasic } from "../src/outline/visualBasicOutline.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-vb-outline-"));
const RootSpec: SessionRoot = { id: "root.vb", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

/**
 * Private registry with only the VB strategy, because the default registry does
 * not expose it yet. Selection, anchors, byte ranges and bounds are the
 * registry's, so this is the same path a host takes after registration.
 */
const Registry: OutlineRegistry = new OutlineRegistry([VisualBasicStrategy]);

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
 * Run the registry against the fixture sandbox.
 */
const outline: (relative: string, options?: OutlineOptions) => OutlineResult = (relative: string, options: OutlineOptions = {}): OutlineResult =>
    Registry.build(Sandbox, relative, options);

/**
 * Run the pure parser with a synthetic input, as a host or a cache replay would.
 */
const parse: (relative: string, text: string) => OutlineNode[] = (relative: string, text: string): OutlineNode[] =>
    parseVisualBasic({ path: relative, text, lineIndex: new LineIndex(text) });

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
    return node;
};

/**
 * Labels of a node list, in order.
 */
const labels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    nodes.map((node: OutlineNode): string => node.label);

/**
 * Top-level symbols under the file anchor.
 */
const topLevel: (result: OutlineResult) => readonly OutlineNode[] = (result: OutlineResult): readonly OutlineNode[] => result.nodes[0].children;

/**
 * Start offsets of each logical line, using `\n` as the only separator.
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
 *
 * `base` is the constant byte offset the registry may keep in front of the
 * decoded text for a container prefix (currently the UTF-8 BOM): the anchor
 * starts at byte zero and every symbol range is shifted by that prefix, so the
 * test pins line numbers and the byte length of each span while tolerating the
 * documented prefix choice.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number, base?: bigint) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number, base?: bigint,
): void => {
    const shift: bigint = base ?? 0n;
    assert.equal(Number(node.range.startLine), startLine, `${node.label}: startLine`);
    assert.equal(Number(node.range.endLine), endLine, `${node.label}: endLine`);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte + shift, `${node.label}: startByte`);
    assert.equal(node.range.endByte, expected.endByte + shift, `${node.label}: endByte`);
};

/**
 * Walk a tree asserting bigint ranges, ordering, parent containment and symbol
 * paths relative to the file anchor.
 */
const assertRanges: (nodes: readonly OutlineNode[], filePath: string, parent?: OutlineNode) => void = (
    nodes: readonly OutlineNode[], filePath: string, parent?: OutlineNode,
): void => {
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
        if (parent === (void 0)) {
            assert.ok(node.path === filePath || node.path.startsWith(`${filePath}#`), `${node.label}: path not anchored to ${filePath}`);
        } else {
            const prefix: string = parent.type === "File" ? `${parent.path}#` : `${parent.path}.`;
            assert.ok(node.path.startsWith(prefix), `${node.label}: path not below ${parent.label}`);
            assert.ok(node.range.startLine >= parent.range.startLine, `${node.label}: line start outside ${parent.label}`);
            assert.ok(node.range.endLine <= parent.range.endLine, `${node.label}: line end outside ${parent.label}`);
            assert.ok(node.range.startByte >= parent.range.startByte, `${node.label}: byte start outside ${parent.label}`);
            assert.ok(node.range.endByte <= parent.range.endByte, `${node.label}: byte end outside ${parent.label}`);
        }
        assertRanges(node.children, filePath, node);
    }
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Namespace, class, field, full property, constructor, function, module and a
 * shared member: the canonical VB shape.
 */
const BasicText: string = [
    "Namespace Acme.Tools",
    "    Public Class Widget",
    "        Private _name As String",
    "        Public Property Name As String",
    "            Get",
    "                Return _name",
    "            End Get",
    "            Set(value As String)",
    "                _name = value",
    "            End Set",
    "        End Property",
    "        Public Sub New()",
    "            _name = \"unnamed\"",
    "        End Sub",
    "        Public Function Describe() As String",
    "            Return _name",
    "        End Function",
    "    End Class",
    "    Friend Module Helpers",
    "        Public Shared Sub Reset()",
    "        End Sub",
    "    End Module",
    "End Namespace",
].join("\n");

/**
 * Nested class, structure, interface with body-less members and enum members.
 */
const NestedText: string = [
    "Public Class Outer",
    "    Public Class Inner",
    "        Public Value As Integer",
    "    End Class",
    "    Public Structure Point",
    "        Public X As Integer",
    "        Public Y As Integer",
    "    End Structure",
    "    Public Interface IShape",
    "        Sub Draw()",
    "        Function Area() As Double",
    "    End Interface",
    "    Public Enum Color",
    "        Red",
    "        Green = 2",
    "        Blue",
    "    End Enum",
    "    Public Delegate Sub Notifier()",
    "End Class",
].join("\n");

/**
 * Comment and string decoys around one real class: `'`/`REM` comments, a
 * quoted `Class`/`End Class`/`Sub`, and a local `Dim` inside a body.
 */
const CommentsText: string = [
    "' Public Class GhostClass",
    "REM Public Sub GhostSub()",
    "Public Class Real",
    "    ' Sub Commented()",
    "    REM Function RemComment()",
    "    Public Sub Demo()",
    "        Dim text As String = \"Public Class FakeClass\"",
    "        Console.WriteLine(\"End Class\")",
    "        REM End Sub",
    "    End Sub",
    "    Public Function Title() As String",
    "        Return \"Sub Fake()\"",
    "    End Function",
    "End Class",
].join("\n");

/**
 * Every documented modifier plus a write-only property with a bare `Set`
 * accessor.
 */
const ModifiersText: string = [
    "Public MustInherit Class Base",
    "    Public Shared ReadOnly Defaults As String = \"x\"",
    "    Protected Friend Overrides Sub Execute()",
    "    End Sub",
    "    Public Async Function LoadAsync() As Task",
    "    End Function",
    "    Public Overloads Sub Run()",
    "    End Sub",
    "    Private Shadows WriteOnly Property Hidden As String",
    "        Set(value As String)",
    "        End Set",
    "    End Property",
    "    Protected NotOverridable Sub Locked()",
    "    End Sub",
    "    Public Partial Class Part",
    "    End Class",
    "End Class",
].join("\n");

/**
 * Auto-implemented properties (no accessor line) must not swallow the members
 * that follow them.
 */
const AutoText: string = [
    "Public Class Settings",
    "    Public Property Name As String",
    "    Public Property Count As Integer = 3",
    "    Public Sub Refresh()",
    "    End Sub",
    "    Public ReadOnly Property Stamp As Date",
    "End Class",
].join("\n");

/**
 * Three file-scope blocks; source order and the closing lines are the contract.
 */
const MultiText: string = [
    "Public Class First",
    "End Class",
    "Public Class Second",
    "End Class",
    "Public Module Third",
    "End Module",
].join("\n");

/**
 * CRLF fixture: every line ends with `\r\n`, including the last one.
 */
const CrlfText: string = [
    "Public Class CrlfWidget",
    "    Private _value As Integer",
    "    Public Function GetValue() As Integer",
    "        Return _value",
    "    End Function",
    "End Class",
    "",
].join("\r\n");

/**
 * BOM fixture body; the BOM bytes are prepended separately.
 */
const BomText: string = [
    "Public Class BomWidget",
    "    Public Sub Ping()",
    "    End Sub",
    "End Class",
    "",
].join("\n");

/**
 * Unicode class/property/function names and a CJK/emoji literal.
 */
const UnicodeText: string = [
    "Public Class 数据服务",
    "    Public Property 名称 As String",
    "    Public Function 问候() As String",
    "        Return \"你好 🌏\"",
    "    End Function",
    "End Class",
].join("\n");

/**
 * VBScript-shaped file: `Property Get`/`Property Let` blocks with the same
 * property name, which also exercises duplicate symbol labels.
 */
const ScriptText: string = [
    "Class Legacy",
    "    Private _value",
    "    Public Property Get Count()",
    "        Count = _value",
    "    End Property",
    "    Public Property Let Count(ByVal item)",
    "        Count = item",
    "    End Property",
    "    Public Sub Run()",
    "    End Sub",
    "End Class",
].join("\n");

/**
 * Attribute-only lines, an attribute before a member and an inline attribute
 * sharing the declaration line.
 */
const AttributesText: string = [
    "<Serializable()>",
    "<Obsolete(\"old\")>",
    "Public Class Attributed",
    "    <Obsolete(\"legacy\")>",
    "    Public Sub Old()",
    "    End Sub",
    "    <CompilerGenerated()> Public Property Value As Integer",
    "End Class",
].join("\n");

/**
 * Four levels of nesting for the depth ceiling.
 */
const DeepText: string = [
    "Public Class A",
    "    Public Class B",
    "        Public Class C",
    "            Public Sub D()",
    "            End Sub",
    "        End Class",
    "    End Class",
    "End Class",
    "",
].join("\n");

/**
 * One class with three methods for the node budget.
 */
const ManyText: string = [
    "Public Class Many",
    "    Public Sub A()",
    "    End Sub",
    "    Public Sub B()",
    "    End Sub",
    "    Public Sub C()",
    "    End Sub",
    "End Class",
    "",
].join("\n");

/**
 * `End If`/`End While` inside a body must not close the enclosing `Sub`.
 */
const FlowText: string = [
    "Public Class Flow",
    "    Public Sub Choose()",
    "        If True Then",
    "            Return",
    "        End If",
    "        While False",
    "        End While",
    "    End Sub",
    "End Class",
].join("\n");

/**
 * A class with no closing `End Class`.
 */
const UnclosedText: string = [
    "Public Class Unclosed",
    "    Public Sub Only()",
    "    End Sub",
].join("\n");

/**
 * Lowercase keywords and a trailing comment on each `End` line.
 */
const CaseText: string = [
    "public class LowerCase",
    "    private sub Shout()",
    "    END SUB ' closes the method",
    "END CLASS ' closes the class",
].join("\n");

/**
 * Only comments: no declaration may survive.
 */
const CommentsOnlyText: string = ["' Public Class Hidden", "REM Public Sub Nope()", ""].join("\n");

/**
 * Trailing `_` continuations: a field whose `As` clause and a signature whose
 * parameters sit on later physical lines.
 */
const ContinuedText: string = [
    "Public Class Continued",
    "    Private _longName _",
    "        As String",
    "    Public Sub Wide( _",
    "        ByVal first As Integer, _",
    "        ByVal second As String)",
    "    End Sub",
    "End Class",
].join("\n");

/**
 * Multiple declarators on one line, including a comma inside a generic
 * constructor argument that must not split.
 */
const DeclarationsText: string = [
    "Public Class Declarations",
    "    Public Left As Integer, Right As String",
    "    Private Pairs As New Dictionary(Of String, Integer)",
    "End Class",
].join("\n");

/**
 * Multi-line lambdas at class, method and `Return` positions: their
 * `End Sub`/`End Function` must not close the enclosing member. A single-line
 * lambda must push no frame at all.
 */
const LambdaText: string = [
    "Public Class Lambdas",
    "    Private _action As Action = Sub()",
    "        Console.WriteLine(\"tick\")",
    "    End Sub",
    "    Public Sub Outer()",
    "        Dim f As Func(Of Integer, Integer) = Function(x As Integer) As Integer",
    "            Return x * 2",
    "        End Function",
    "        Console.WriteLine(\"after\")",
    "    End Sub",
    "    Public Sub Quick()",
    "        Dim square As Func(Of Integer, Integer) = Function(x As Integer) x * x",
    "    End Sub",
    "    Public Function Make() As Func(Of Integer, Integer)",
    "        Return Function(value As Integer) As Integer",
    "            Return value + 1",
    "        End Function",
    "    End Function",
    "End Class",
].join("\n");

/**
 * VB modifiers and declaration words the documented chain does not name:
 * `Overridable`, `WithEvents`, `Iterator` and a `Declare Auto` signature.
 */
const ExtensionsText: string = [
    "Public Class Extensions",
    "    Public Overridable Function Describe() As String",
    "    End Function",
    "    Public WithEvents Timer As Object",
    "    Public Iterator Function Walk() As IEnumerable(Of Integer)",
    "    End Function",
    "    <DllImport(\"kernel32\", CharSet:=CharSet.Auto)>",
    "    Public Declare Auto Function GetTickCount Lib \"kernel32\" () As Integer",
    "End Class",
].join("\n");

/**
 * VBScript untyped fields, including two declarators on one line and a
 * `Const` without an `As` clause.
 */
const ScriptFieldsText: string = [
    "Class ScriptFields",
    "    Private _count",
    "    Private _left, _right",
    "    Private Const Limit = 10",
    "    Public Sub Bump()",
    "    End Sub",
    "End Class",
].join("\n");

/**
 * A `.vb` class with an untyped field: VB.NET requires `As`, so no node is
 * expected and the VBScript extension stays gated on the extension.
 */
const UntypedText: string = ["Public Class Untyped", "    Private _value", "End Class"].join("\n");


fixture("basic.vb", BasicText);
fixture("nested.vb", NestedText);
fixture("comments.vb", CommentsText);
fixture("modifiers.vb", ModifiersText);
fixture("auto.vb", AutoText);
fixture("multi.vb", MultiText);
fixture("crlf.vb", CrlfText);
const BomBytes: Uint8Array = new Uint8Array(3 + Buffer.byteLength(BomText, "utf8"));
BomBytes.set([0xef, 0xbb, 0xbf], 0);
BomBytes.set(Buffer.from(BomText, "utf8"), 3);
fixture("bom.vb", BomBytes);
fixture("unicode.vb", UnicodeText);
fixture("legacy.vbs", ScriptText);
fixture("attributes.vb", AttributesText);
fixture("deep.vb", DeepText);
fixture("many.vb", ManyText);
fixture("flow.vb", FlowText);
fixture("unclosed.vb", UnclosedText);
fixture("case.vb", CaseText);
fixture("empty.vb", "");
fixture("commentsOnly.vb", CommentsOnlyText);
fixture("continued.vb", ContinuedText);
fixture("declarations.vb", DeclarationsText);
fixture("lambda.vb", LambdaText);
fixture("extensions.vb", ExtensionsText);
fixture("fields.vbs", ScriptFieldsText);
fixture("untyped.vb", UntypedText);
fixture("binary.vb", new Uint8Array(32));

/**
 * Every fixture that must resolve to a VB outline; used by the range sweep.
 */
const VisualBasicFixtures: readonly string[] = [
    "basic.vb",
    "nested.vb",
    "comments.vb",
    "modifiers.vb",
    "auto.vb",
    "multi.vb",
    "crlf.vb",
    "bom.vb",
    "unicode.vb",
    "legacy.vbs",
    "attributes.vb",
    "deep.vb",
    "many.vb",
    "flow.vb",
    "unclosed.vb",
    "case.vb",
    "empty.vb",
    "commentsOnly.vb",
    "continued.vb",
    "declarations.vb",
    "lambda.vb",
    "extensions.vb",
    "fields.vbs",
    "untyped.vb",
];

test("the VB strategy claims .vb and .vbs only and reports stable tags", (): void => {
    assert.equal(VisualBasicStrategy.id, "visualBasic");
    assert.equal(VisualBasicStrategy.category, "code");
    assert.equal(VisualBasicStrategy.language, "visualbasic");
    assert.equal(VisualBasicStrategy.matches({ path: "basic.vb", name: "basic.vb", head: "" }), true);
    assert.equal(VisualBasicStrategy.matches({ path: "legacy.vbs", name: "legacy.vbs", head: "" }), true);
    assert.equal(VisualBasicStrategy.matches({ path: "SHOUT.VB", name: "SHOUT.VB", head: "" }), true);
    assert.equal(VisualBasicStrategy.matches({ path: "src/Module1.vb", name: "src/Module1.vb", head: "" }), true);
    assert.equal(VisualBasicStrategy.matches({ path: "Module1.vbproj", name: "Module1.vbproj", head: "" }), false);
    assert.equal(VisualBasicStrategy.matches({ path: "src/Program.cs", name: "src/Program.cs", head: "" }), false);
    assert.equal(VisualBasicStrategy.matches({ path: "src/Program", name: "src/Program", head: "" }), false);
    assert.equal(Registry.list().length, 1);
    assert.equal(Registry.select({ path: "basic.vb", name: "basic.vb", head: "" }), VisualBasicStrategy);
    assert.equal(Registry.select({ path: "notes.txt", name: "notes.txt", head: "" }) === (void 0), true);
});

test("namespace, class, field, property, constructor, function and module close on their End line", (): void => {
    const result: OutlineResult = outline("basic.vb");
    assert.equal(result.strategy, "visualBasic");
    assert.equal(result.category, "code");
    assert.equal(result.language, "visualbasic");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.path, "basic.vb");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(result.nodes.length, 1);
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.label, "basic.vb");
    assert.equal(anchor.depth, 0);
    assert.ok(anchor.file !== (void 0));
    assert.equal(anchor.file?.fingerprint, result.fingerprint);
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
    assertRange(anchor, BasicText, 1, 23);
    assert.ok(Object.isFrozen(result.nodes));
    assert.ok(Object.isFrozen(anchor));
    assert.ok(Object.isFrozen(anchor.children));
    assert.deepEqual(labels(topLevel(result)), ["Acme.Tools"]);
    const namespaceNode: OutlineNode = topLevel(result)[0];
    assert.equal(namespaceNode.type, "namespace");
    assert.equal(namespaceNode.depth, 1);
    assert.equal(namespaceNode.path, "basic.vb#Acme.Tools");
    assert.equal(namespaceNode.modifiers, undefined);
    assertRange(namespaceNode, BasicText, 1, 23);
    assert.deepEqual(labels(namespaceNode.children), ["Widget", "Helpers"]);
    const widget: OutlineNode = namespaceNode.children[0];
    assert.equal(widget.type, "class");
    assert.equal(widget.depth, 2);
    assert.equal(widget.path, "basic.vb#Acme.Tools.Widget");
    assert.deepEqual(widget.modifiers, ["public"]);
    assert.equal(widget.detail, "Public Class Widget");
    assertRange(widget, BasicText, 2, 18);
    assert.deepEqual(labels(widget.children), ["_name", "Name", "New", "Describe"]);
    const field: OutlineNode = widget.children[0];
    assert.equal(field.type, "property");
    assert.equal(field.depth, 3);
    assert.equal(field.path, "basic.vb#Acme.Tools.Widget._name");
    assert.deepEqual(field.modifiers, ["private"]);
    assert.equal(field.detail, "Private _name As String");
    assertRange(field, BasicText, 3, 3);
    const property: OutlineNode = widget.children[1];
    assert.equal(property.type, "property");
    assert.deepEqual(property.modifiers, ["public"]);
    assertRange(property, BasicText, 4, 11);
    assert.equal(property.children.length, 0);
    const constructor: OutlineNode = widget.children[2];
    assert.equal(constructor.type, "method");
    assert.equal(constructor.label, "New");
    assertRange(constructor, BasicText, 12, 14);
    const describe: OutlineNode = widget.children[3];
    assert.equal(describe.type, "function");
    assertRange(describe, BasicText, 15, 17);
    assert.match(outlineNodeFingerprint(describe), /^sha256:[0-9a-f]{64}$/);
    const moduleNode: OutlineNode = namespaceNode.children[1];
    assert.equal(moduleNode.type, "module");
    assert.equal(moduleNode.depth, 2);
    assert.deepEqual(moduleNode.modifiers, ["friend"]);
    assertRange(moduleNode, BasicText, 19, 22);
    assert.deepEqual(labels(moduleNode.children), ["Reset"]);
    const reset: OutlineNode = moduleNode.children[0];
    assert.equal(reset.type, "method");
    assert.deepEqual(reset.modifiers, ["public", "shared"]);
    assertRange(reset, BasicText, 20, 21);
    assert.equal(findNode(result.nodes, "Get"), undefined);
    assert.equal(findNode(result.nodes, "Set"), undefined);
    assert.equal(findNode(result.nodes, "End Get"), undefined);
    assert.equal(findNode(result.nodes, "End Property"), undefined);
    assert.equal(findNode(result.nodes, "End Class"), undefined);
});

test("parseVisualBasic is pure and returns line-only nodes with an empty path", (): void => {
    const first: OutlineNode[] = parse("basic.vb", BasicText);
    const second: OutlineNode[] = parse("basic.vb", BasicText);
    assert.equal(first.length, 1);
    assert.notEqual(first[0], second[0]);
    const namespaceNode: OutlineNode = first[0];
    assert.equal(namespaceNode.path, "");
    assert.equal(namespaceNode.range.startByte, 0n);
    assert.equal(namespaceNode.range.endByte, 0n);
    assert.equal(Number(namespaceNode.range.startLine), 1);
    assert.equal(Number(namespaceNode.range.endLine), 23);
    assert.equal(namespaceNode.depth, 0);
    assert.equal(namespaceNode.children.length, 2);
    const widget: OutlineNode = namespaceNode.children[0];
    assert.equal(widget.path, "");
    assert.equal(widget.depth, 1);
    const property: OutlineNode = widget.children[1];
    assert.equal(property.depth, 2);
    assert.equal(Number(property.range.endLine), 11);
    assert.deepEqual(property.modifiers, ["public"]);
    assert.deepEqual(parse("empty.vb", ""), []);
    assert.deepEqual(parse("commentsOnly.vb", CommentsOnlyText), []);
    const bomInput: OutlineNode[] = parse("bom.vb", `\uFEFF${AutoText}`);
    assert.equal(bomInput.length, 1);
    assert.equal(bomInput[0].label, "Settings");
});

test("nested classes, structures, interfaces and enums keep the End stack", (): void => {
    const result: OutlineResult = outline("nested.vb");
    assert.deepEqual(labels(topLevel(result)), ["Outer"]);
    const outer: OutlineNode = topLevel(result)[0];
    assert.equal(outer.type, "class");
    assert.equal(outer.depth, 1);
    assertRange(outer, NestedText, 1, 19);
    assert.deepEqual(labels(outer.children), ["Inner", "Point", "IShape", "Color", "Notifier"]);
    const inner: OutlineNode = outer.children[0];
    assert.equal(inner.type, "class");
    assert.equal(inner.depth, 2);
    assertRange(inner, NestedText, 2, 4);
    const value: OutlineNode = inner.children[0];
    assert.equal(value.type, "property");
    assert.equal(value.depth, 3);
    assertRange(value, NestedText, 3, 3);
    const point: OutlineNode = outer.children[1];
    assert.equal(point.type, "struct");
    assert.equal(point.depth, 2);
    assertRange(point, NestedText, 5, 8);
    assert.deepEqual(labels(point.children), ["X", "Y"]);
    assert.deepEqual(labels(outer.children[2].children), ["Draw", "Area"]);
    const shape: OutlineNode = outer.children[2];
    assert.equal(shape.type, "interface");
    assertRange(shape, NestedText, 9, 12);
    const draw: OutlineNode = shape.children[0];
    assert.equal(draw.type, "method");
    assert.equal(draw.depth, 3);
    assertRange(draw, NestedText, 10, 10);
    const area: OutlineNode = shape.children[1];
    assert.equal(area.type, "function");
    assertRange(area, NestedText, 11, 11);
    const color: OutlineNode = outer.children[3];
    assert.equal(color.type, "enum");
    assertRange(color, NestedText, 13, 17);
    assert.deepEqual(labels(color.children), ["Red", "Green", "Blue"]);
    const red: OutlineNode = color.children[0];
    assert.equal(red.type, "constant");
    assert.equal(red.depth, 3);
    assertRange(red, NestedText, 14, 14);
    assert.equal(color.children[1].type, "constant");
    assert.equal(color.children[1].detail, "Green = 2");
    assertRange(color.children[1], NestedText, 15, 15);
    const notifier: OutlineNode = requireNode(result.nodes, "Notifier");
    assert.equal(notifier.type, "type");
    assert.equal(notifier.depth, 2);
    assert.equal(Number(requireNode(result.nodes, "Inner").range.endLine), 4);
});

test("comments, REM lines and string literals never produce or close nodes", (): void => {
    const result: OutlineResult = outline("comments.vb");
    assert.deepEqual(labels(topLevel(result)), ["Real"]);
    const real: OutlineNode = topLevel(result)[0];
    assert.equal(real.type, "class");
    assertRange(real, CommentsText, 3, 14);
    assert.deepEqual(labels(real.children), ["Demo", "Title"]);
    const demo: OutlineNode = real.children[0];
    assertRange(demo, CommentsText, 6, 10);
    assert.equal(demo.children.length, 0);
    const title: OutlineNode = real.children[1];
    assertRange(title, CommentsText, 11, 13);
    assert.equal(findNode(result.nodes, "GhostClass"), undefined);
    assert.equal(findNode(result.nodes, "GhostSub"), undefined);
    assert.equal(findNode(result.nodes, "Commented"), undefined);
    assert.equal(findNode(result.nodes, "RemComment"), undefined);
    assert.equal(findNode(result.nodes, "FakeClass"), undefined);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
    assert.equal(findNode(result.nodes, "text"), undefined);
    assert.equal(flatten(result.nodes).length, 4);
});

test("the modifier chain is lowercase and Shared is reported like static", (): void => {
    const result: OutlineResult = outline("modifiers.vb");
    const base: OutlineNode = topLevel(result)[0];
    assert.equal(base.type, "class");
    assertRange(base, ModifiersText, 1, 17);
    assert.deepEqual(base.modifiers, ["public", "mustinherit"]);
    assert.deepEqual(labels(base.children), ["Defaults", "Execute", "LoadAsync", "Run", "Hidden", "Locked", "Part"]);
    const defaults: OutlineNode = base.children[0];
    assert.equal(defaults.type, "property");
    assert.deepEqual(defaults.modifiers, ["public", "shared", "readonly"]);
    assertRange(defaults, ModifiersText, 2, 2);
    const execute: OutlineNode = base.children[1];
    assert.equal(execute.type, "method");
    assert.deepEqual(execute.modifiers, ["protected", "friend", "overrides"]);
    assertRange(execute, ModifiersText, 3, 4);
    const loadAsync: OutlineNode = base.children[2];
    assert.equal(loadAsync.type, "function");
    assert.deepEqual(loadAsync.modifiers, ["public", "async"]);
    assertRange(loadAsync, ModifiersText, 5, 6);
    const run: OutlineNode = base.children[3];
    assert.deepEqual(run.modifiers, ["public", "overloads"]);
    assertRange(run, ModifiersText, 7, 8);
    const hidden: OutlineNode = base.children[4];
    assert.equal(hidden.type, "property");
    assert.deepEqual(hidden.modifiers, ["private", "shadows", "writeonly"]);
    assertRange(hidden, ModifiersText, 9, 12);
    const locked: OutlineNode = base.children[5];
    assert.deepEqual(locked.modifiers, ["protected", "notoverridable"]);
    assertRange(locked, ModifiersText, 13, 14);
    const part: OutlineNode = base.children[6];
    assert.equal(part.type, "class");
    assert.deepEqual(part.modifiers, ["public", "partial"]);
    assert.equal(part.depth, 2);
    assertRange(part, ModifiersText, 15, 16);
    const flat: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < flat.length; index += 1) {
        const modifiers: readonly string[] = flat[index].modifiers ?? [];
        for (let modifierIndex: number = 0; modifierIndex < modifiers.length; modifierIndex += 1) {
            assert.equal(modifiers[modifierIndex], modifiers[modifierIndex].toLowerCase(), flat[index].label);
        }
    }
});

test("auto-implemented properties stay one-line nodes and do not swallow later members", (): void => {
    const result: OutlineResult = outline("auto.vb");
    const settings: OutlineNode = topLevel(result)[0];
    assert.equal(settings.type, "class");
    assertRange(settings, AutoText, 1, 7);
    assert.deepEqual(labels(settings.children), ["Name", "Count", "Refresh", "Stamp"]);
    const name: OutlineNode = settings.children[0];
    assert.equal(name.type, "property");
    assertRange(name, AutoText, 2, 2);
    assert.equal(name.children.length, 0);
    const count: OutlineNode = settings.children[1];
    assert.equal(count.type, "property");
    assert.equal(count.children.length, 0);
    assert.match(count.detail ?? "", /= 3$/);
    assertRange(count, AutoText, 3, 3);
    const refresh: OutlineNode = settings.children[2];
    assert.equal(refresh.type, "method");
    assert.equal(refresh.depth, 2);
    assertRange(refresh, AutoText, 4, 5);
    const stamp: OutlineNode = settings.children[3];
    assert.equal(stamp.type, "property");
    assert.deepEqual(stamp.modifiers, ["public", "readonly"]);
    assertRange(stamp, AutoText, 6, 6);
    assert.equal(flatten(result.nodes).length, 6);
});

test("several classes and one module at file scope keep source order and ranges", (): void => {
    const result: OutlineResult = outline("multi.vb");
    assert.deepEqual(labels(topLevel(result)), ["First", "Second", "Third"]);
    assertRange(topLevel(result)[0], MultiText, 1, 2);
    assertRange(topLevel(result)[1], MultiText, 3, 4);
    const third: OutlineNode = topLevel(result)[2];
    assert.equal(third.type, "module");
    assert.equal(third.depth, 1);
    assertRange(third, MultiText, 5, 6);
    assert.equal(Number(requireNode(result.nodes, "Second").range.startLine), 3);
});

test("empty and comment-only files yield the anchor with no symbols", (): void => {
    const empty: OutlineResult = outline("empty.vb");
    assert.equal(empty.strategy, "visualBasic");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes.length, 1);
    assert.equal(empty.nodes[0].type, "File");
    assert.equal(empty.nodes[0].children.length, 0);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(empty.nodes[0].range.endLine, 1n);
    const commented: OutlineResult = outline("commentsOnly.vb");
    assert.equal(commented.nodes[0].children.length, 0);
    assert.match(outlineNodeFingerprint(commented.nodes[0]), /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(parse("commentsOnly.vb", CommentsOnlyText), []);
    assert.deepEqual(parse("empty.vb", ""), []);
});

test("CRLF line endings keep line numbers and every byte range includes the carriage return", (): void => {
    const result: OutlineResult = outline("crlf.vb");
    assert.equal(result.charset, "utf-8");
    const widget: OutlineNode = topLevel(result)[0];
    assert.equal(widget.label, "CrlfWidget");
    assert.equal(widget.label.includes("\r"), false);
    assertRange(widget, CrlfText, 1, 6);
    const field: OutlineNode = widget.children[0];
    assert.equal(field.label, "_value");
    assertRange(field, CrlfText, 2, 2);
    assert.equal(field.range.endByte - field.range.startByte, BigInt(Buffer.byteLength("    Private _value As Integer\r\n", "utf8")));
    assertRange(widget.children[1], CrlfText, 3, 5);
});

test("a UTF-8 BOM is reported and the first declaration still matches", (): void => {
    const result: OutlineResult = outline("bom.vb");
    assert.equal(result.charset, "utf-8-bom");
    const anchor: OutlineNode = result.nodes[0];
    const decodedBytes: bigint = BigInt(Buffer.byteLength(BomText, "utf8"));
    const base: bigint = anchor.range.endByte - decodedBytes;
    assert.ok(base === 0n || base === 3n, `unexpected BOM byte base: ${base}`);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, decodedBytes + base);
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), 4);
    assert.equal(BigInt(BomBytes.length), decodedBytes + 3n);
    const widget: OutlineNode = topLevel(result)[0];
    assert.equal(widget.label, "BomWidget");
    assertRange(widget, BomText, 1, 4, base);
    const ping: OutlineNode = widget.children[0];
    assert.equal(ping.label, "Ping");
    assertRange(ping, BomText, 2, 3, base);
});

test("Unicode identifiers and literals keep labels and UTF-8 byte ranges", (): void => {
    const result: OutlineResult = outline("unicode.vb");
    const service: OutlineNode = topLevel(result)[0];
    assert.equal(service.label, "数据服务");
    assert.equal(service.type, "class");
    assert.equal(service.path, "unicode.vb#数据服务");
    assertRange(service, UnicodeText, 1, 6);
    assert.deepEqual(labels(service.children), ["名称", "问候"]);
    const property: OutlineNode = service.children[0];
    assert.equal(property.type, "property");
    assertRange(property, UnicodeText, 2, 2);
    const greeting: OutlineNode = service.children[1];
    assert.equal(greeting.type, "function");
    assert.equal(greeting.path, "unicode.vb#数据服务.问候");
    assertRange(greeting, UnicodeText, 3, 5);
    const lineText: string = "    Public Property 名称 As String\n";
    const lineBytes: bigint = property.range.endByte - property.range.startByte;
    assert.equal(lineBytes, BigInt(Buffer.byteLength(lineText, "utf8")));
    assert.ok(lineBytes > BigInt(lineText.length), "UTF-8 bytes must exceed the UTF-16 code-unit length");
});

test("VBScript Property Get/Let blocks span to End Property and .vbs selects the strategy", (): void => {
    const result: OutlineResult = outline("legacy.vbs");
    assert.equal(result.strategy, "visualBasic");
    assert.equal(result.language, "visualbasic");
    const legacy: OutlineNode = topLevel(result)[0];
    assert.equal(legacy.type, "class");
    assertRange(legacy, ScriptText, 1, 11);
    assert.deepEqual(labels(legacy.children), ["_value", "Count", "Count", "Run"]);
    const backedField: OutlineNode = legacy.children[0];
    assert.equal(backedField.type, "property");
    assert.deepEqual(backedField.modifiers, ["private"]);
    assertRange(backedField, ScriptText, 2, 2);
    const getter: OutlineNode = legacy.children[1];
    assert.equal(getter.type, "property");
    assert.match(getter.path, /^legacy\.vbs#Legacy\.Count~property-/);
    assert.deepEqual(getter.modifiers, ["public"]);
    assertRange(getter, ScriptText, 3, 5);
    const letter: OutlineNode = legacy.children[2];
    assert.equal(letter.type, "property");
    assertRange(letter, ScriptText, 6, 8);
    assert.notEqual(getter.path, letter.path);
    assertRange(legacy.children[3], ScriptText, 9, 10);
});

test("attribute-only lines are skipped and an inline attribute still declares the member", (): void => {
    const result: OutlineResult = outline("attributes.vb");
    assert.deepEqual(labels(topLevel(result)), ["Attributed"]);
    const attributed: OutlineNode = topLevel(result)[0];
    assert.equal(attributed.depth, 1);
    assertRange(attributed, AttributesText, 3, 8);
    assert.deepEqual(labels(attributed.children), ["Old", "Value"]);
    assertRange(attributed.children[0], AttributesText, 5, 6);
    assert.equal(attributed.children[1].type, "property");
    assertRange(attributed.children[1], AttributesText, 7, 7);
    assert.equal(findNode(result.nodes, "Serializable"), undefined);
    assert.equal(findNode(result.nodes, "Obsolete"), undefined);
    assert.equal(findNode(result.nodes, "CompilerGenerated"), undefined);
});

test("maxNodes counts the anchor and the VB tree and reports truncation", (): void => {
    const limited: OutlineResult = outline("many.vb", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.deepEqual(labels(topLevel(limited)), ["Many"]);
    assert.deepEqual(labels(requireNode(limited.nodes, "Many").children), ["A"]);
    const complete: OutlineResult = outline("many.vb", { maxNodes: 5 });
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 5);
    assert.deepEqual(labels(requireNode(complete.nodes, "Many").children), ["A", "B", "C"]);
    const anchorOnly: OutlineResult = outline("many.vb", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.equal(anchorOnly.nodes[0].children.length, 0);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("many.vb", { maxNodes: 0 });
    });
});

test("maxDepth drops whole VB blocks and reports truncation", (): void => {
    const three: OutlineResult = outline("deep.vb", { maxDepth: 3 });
    assert.equal(three.truncated, true);
    assert.deepEqual(labels(topLevel(three)), ["A"]);
    assert.deepEqual(labels(requireNode(three.nodes, "A").children), ["B"]);
    assert.deepEqual(labels(requireNode(three.nodes, "B").children), ["C"]);
    assert.equal(requireNode(three.nodes, "C").children.length, 0);
    assert.equal(findNode(three.nodes, "D"), undefined);
    const two: OutlineResult = outline("deep.vb", { maxDepth: 2 });
    assert.equal(two.truncated, true);
    assert.deepEqual(labels(requireNode(two.nodes, "A").children), ["B"]);
    assert.equal(requireNode(two.nodes, "B").children.length, 0);
    const one: OutlineResult = outline("deep.vb", { maxDepth: 1 });
    assert.equal(one.truncated, true);
    assert.deepEqual(labels(topLevel(one)), ["A"]);
    assert.equal(one.nodes[0].children.length, 1);
    const complete: OutlineResult = outline("deep.vb", { maxDepth: 8 });
    assert.equal(complete.truncated, false);
    assert.equal(requireNode(complete.nodes, "D").depth, 4);
    assert.equal(flatten(complete.nodes).length, 5);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("deep.vb", { maxDepth: 0 });
    });
});

test("End If and End While inside a body do not close the enclosing Sub", (): void => {
    const result: OutlineResult = outline("flow.vb");
    const flow: OutlineNode = topLevel(result)[0];
    assertRange(flow, FlowText, 1, 9);
    const choose: OutlineNode = flow.children[0];
    assert.equal(choose.type, "method");
    assertRange(choose, FlowText, 2, 8);
    assert.equal(findNode(result.nodes, "If"), undefined);
    assert.equal(findNode(result.nodes, "While"), undefined);
});

test("an unclosed block ends on the last line of the file", (): void => {
    const result: OutlineResult = outline("unclosed.vb");
    const unclosed: OutlineNode = topLevel(result)[0];
    assertRange(unclosed, UnclosedText, 1, 3);
    assertRange(unclosed.children[0], UnclosedText, 2, 3);
});

test("keywords and modifiers are matched case-insensitively", (): void => {
    const result: OutlineResult = outline("case.vb");
    const lower: OutlineNode = topLevel(result)[0];
    assert.equal(lower.label, "LowerCase");
    assert.equal(lower.type, "class");
    assert.equal(lower.detail, "public class LowerCase");
    assert.deepEqual(lower.modifiers, ["public"]);
    assertRange(lower, CaseText, 1, 4);
    const shout: OutlineNode = lower.children[0];
    assert.equal(shout.label, "Shout");
    assert.deepEqual(shout.modifiers, ["private"]);
    assertRange(shout, CaseText, 2, 3);
});

test("a trailing underscore joins physical lines into one logical declaration", (): void => {
    const result: OutlineResult = outline("continued.vb");
    const continued: OutlineNode = topLevel(result)[0];
    assert.equal(continued.type, "class");
    assertRange(continued, ContinuedText, 1, 8);
    assert.deepEqual(labels(continued.children), ["_longName", "Wide"]);
    const field: OutlineNode = continued.children[0];
    assert.equal(field.type, "property");
    assert.deepEqual(field.modifiers, ["private"]);
    assert.equal(field.detail, "Private _longName As String");
    assertRange(field, ContinuedText, 2, 3);
    const method: OutlineNode = continued.children[1];
    assert.equal(method.type, "method");
    assertRange(method, ContinuedText, 4, 7);
    assert.equal(method.detail?.startsWith("Public Sub Wide("), true);
    assert.equal(findNode(result.nodes, "As"), undefined);
});

test("multiple declarators on one line each become a property node", (): void => {
    const result: OutlineResult = outline("declarations.vb");
    const declarations: OutlineNode = topLevel(result)[0];
    assert.equal(declarations.type, "class");
    assertRange(declarations, DeclarationsText, 1, 4);
    assert.deepEqual(labels(declarations.children), ["Left", "Right", "Pairs"]);
    const left: OutlineNode = declarations.children[0];
    assert.equal(left.type, "property");
    assert.deepEqual(left.modifiers, ["public"]);
    assertRange(left, DeclarationsText, 2, 2);
    const right: OutlineNode = declarations.children[1];
    assert.equal(right.type, "property");
    assert.deepEqual(right.modifiers, ["public"]);
    assertRange(right, DeclarationsText, 2, 2);
    const pairs: OutlineNode = declarations.children[2];
    assert.equal(pairs.type, "property");
    assert.deepEqual(pairs.modifiers, ["private"]);
    assert.equal(pairs.detail, "Private Pairs As New Dictionary(Of String, Integer)");
    assertRange(pairs, DeclarationsText, 3, 3);
    assert.equal(findNode(result.nodes, "Dictionary"), undefined);
});

test("a multi-line lambda End line does not close the enclosing method", (): void => {
    const result: OutlineResult = outline("lambda.vb");
    const lambdas: OutlineNode = topLevel(result)[0];
    assert.equal(lambdas.type, "class");
    assertRange(lambdas, LambdaText, 1, 19);
    assert.deepEqual(labels(lambdas.children), ["_action", "Outer", "Quick", "Make"]);
    const action: OutlineNode = lambdas.children[0];
    assert.equal(action.type, "property");
    assert.deepEqual(action.modifiers, ["private"]);
    assertRange(action, LambdaText, 2, 2);
    const outer: OutlineNode = lambdas.children[1];
    assert.equal(outer.type, "method");
    assertRange(outer, LambdaText, 5, 10);
    const quick: OutlineNode = lambdas.children[2];
    assert.equal(quick.type, "method");
    assertRange(quick, LambdaText, 11, 13);
    const make: OutlineNode = lambdas.children[3];
    assert.equal(make.type, "function");
    assertRange(make, LambdaText, 14, 18);
    assert.equal(findNode(result.nodes, "f"), undefined);
    assert.equal(findNode(result.nodes, "square"), undefined);
    assert.equal(findNode(result.nodes, "tick"), undefined);
    assert.equal(findNode(result.nodes, "after"), undefined);
    assert.equal(findNode(result.nodes, "value"), undefined);
});

test("Overridable, WithEvents, Iterator and Declare Auto are recognized", (): void => {
    const result: OutlineResult = outline("extensions.vb");
    const extensions: OutlineNode = topLevel(result)[0];
    assert.equal(extensions.type, "class");
    assertRange(extensions, ExtensionsText, 1, 9);
    assert.deepEqual(labels(extensions.children), ["Describe", "Timer", "Walk", "GetTickCount"]);
    const describe: OutlineNode = extensions.children[0];
    assert.equal(describe.type, "function");
    assert.deepEqual(describe.modifiers, ["public", "overridable"]);
    assertRange(describe, ExtensionsText, 2, 3);
    const timer: OutlineNode = extensions.children[1];
    assert.equal(timer.type, "property");
    assert.deepEqual(timer.modifiers, ["public", "withevents"]);
    assertRange(timer, ExtensionsText, 4, 4);
    const walk: OutlineNode = extensions.children[2];
    assert.equal(walk.type, "function");
    assert.deepEqual(walk.modifiers, ["public", "iterator"]);
    assertRange(walk, ExtensionsText, 5, 6);
    const tick: OutlineNode = extensions.children[3];
    assert.equal(tick.type, "function");
    assert.equal(tick.label, "GetTickCount");
    assert.deepEqual(tick.modifiers, ["public"]);
    assertRange(tick, ExtensionsText, 8, 8);
    assert.equal(findNode(result.nodes, "DllImport"), undefined);
});

test("VBScript untyped class fields are properties while .vb still requires As", (): void => {
    const result: OutlineResult = outline("fields.vbs");
    const scriptFields: OutlineNode = topLevel(result)[0];
    assert.equal(scriptFields.type, "class");
    assertRange(scriptFields, ScriptFieldsText, 1, 7);
    assert.deepEqual(labels(scriptFields.children), ["_count", "_left", "_right", "Limit", "Bump"]);
    const count: OutlineNode = scriptFields.children[0];
    assert.equal(count.type, "property");
    assert.deepEqual(count.modifiers, ["private"]);
    assertRange(count, ScriptFieldsText, 2, 2);
    assertRange(scriptFields.children[1], ScriptFieldsText, 3, 3);
    assertRange(scriptFields.children[2], ScriptFieldsText, 3, 3);
    assertRange(scriptFields.children[3], ScriptFieldsText, 4, 4);
    const bump: OutlineNode = scriptFields.children[4];
    assert.equal(bump.type, "method");
    assertRange(bump, ScriptFieldsText, 5, 6);
    const typedOnly: OutlineResult = outline("untyped.vb");
    assert.equal(topLevel(typedOnly).length, 1);
    assert.equal(topLevel(typedOnly)[0].children.length, 0);
    assert.deepEqual(parse("untyped.vb", UntypedText)[0].children, []);
});

test("binary and missing VB files are refused with closed error codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("binary.vb");
    });
    expectFilesystemError("not_found", (): void => {
        outline("missing.vb");
    });
});

test("every VB fixture keeps ordered bigint ranges, contained paths and per-node fingerprints", (): void => {
    for (let index: number = 0; index < VisualBasicFixtures.length; index += 1) {
        const relative: string = VisualBasicFixtures[index];
        const result: OutlineResult = outline(relative);
        assert.equal(result.strategy, "visualBasic", relative);
        assert.equal(result.category, "code", relative);
        assert.equal(result.language, "visualbasic", relative);
        assert.equal(result.target, "file", relative);
        assert.equal(result.nodes.length, 1, relative);
        const anchor: OutlineNode = result.nodes[0];
        assert.equal(anchor.type, "File", relative);
        assert.equal(anchor.range.startByte, 0n, relative);
        assert.equal(anchor.range.startLine, 1n, relative);
        assert.equal(anchor.path, relative, relative);
        assertRanges(result.nodes, relative);
        const flat: OutlineNode[] = flatten(result.nodes);
        for (let nodeIndex: number = 0; nodeIndex < flat.length; nodeIndex += 1) {
            assert.match(outlineNodeFingerprint(flat[nodeIndex]), /^sha256:[0-9a-f]{64}$/, flat[nodeIndex].label);
        }
    }
});
