#!/usr/bin/env node
/**
 * Java outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; no fixture code is executed and no third-party parser is involved.
 * All extraction goes through the public `buildOutline` entry point, so path
 * resolution, charset sniffing, the strategy registry, UTF-8 byte ranges and
 * the node/depth budgets are exercised together.
 *
 * The checks are split into two groups:
 *
 * - `J*` scenarios assert behavior that already matches the documented
 *   contract (strategy selection, anchors, packages, type kinds, member kinds,
 *   modifiers, pseudo-declaration masking, CRLF/BOM/Unicode, path syntax,
 *   bigint ranges, truncation and closed error codes).
 * - `D*` scenarios assert behavior the contract implies but the Java parser
 *   does not provide. Each failing check is recorded with a stable finding id
 *   (`F-J01` … `F-J11`) instead of aborting at the first mismatch, so one run
 *   reports every deviation at once. These tests are expected to fail until
 *   the parser is fixed; this tool never edits `src/**`.
 *
 * Run with Node's type stripping:
 *
 * ```powershell
 * node tools/javaOutlineCheck.ts
 * ```
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { FilesystemError } from "../src/file/errors.ts";
import { buildOutline, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-java-outline-"));
const RootSpec: SessionRoot = { id: "root.java", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

/**
 * Counted assertion wrappers. `Assertions` is printed in the run summary so the
 * report can state how many assertions actually executed.
 */
let Assertions: number = 0;

const eq: (actual: unknown, expected: unknown, message?: string) => void = (actual: unknown, expected: unknown, message?: string): void => {
    Assertions += 1;
    assert.equal(actual, expected, message ?? "");
};

const ok: (condition: unknown, message?: string) => void = (condition: unknown, message?: string): void => {
    Assertions += 1;
    assert.ok(condition, message ?? "");
};

const deep: (actual: unknown, expected: unknown, message?: string) => void = (actual: unknown, expected: unknown, message?: string): void => {
    Assertions += 1;
    assert.deepEqual(actual, expected, message ?? "");
};

const throwsCode: (code: string, action: () => void, message?: string) => void = (code: string, action: () => void, message?: string): void => {
    Assertions += 1;
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code, message ?? "");
};

/**
 * Write one fixture, creating intermediate directories.
 */
const writeFixture: (relative: string, content: string | Uint8Array) => void = (relative: string, content: string | Uint8Array): void => {
    const absolute: string = join(Root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
};

/**
 * One fixture: its sandbox-relative path, exact text and cleaned lines.
 */
interface Fixture {
    readonly relative: string;
    readonly text: string;
    readonly lines: readonly string[];
}

/**
 * Write a text fixture and index it for range expectations.
 */
const makeFixture: (relative: string, text: string) => Fixture = (relative: string, text: string): Fixture => {
    writeFixture(relative, text);
    const lines: string[] = text.split("\n").map((line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return { relative, text, lines };
};

/**
 * 1-based line number of the first line containing one marker.
 */
const lineOf: (fixture: Fixture, needle: string) => number = (fixture: Fixture, needle: string): number => {
    const index: number = fixture.lines.findIndex((line: string): boolean => line.includes(needle));
    if (index === -1) {
        throw new Error(`fixture line not found: ${needle}`);
    }
    return index + 1;
};

/**
 * Line of the block that starts on `startLine`: the matching close brace, or
 * the semicolon for a body-less declaration. Deliberately independent of the
 * parser, and only used on fixtures without braces inside strings.
 */
const blockEnd: (lines: readonly string[], startLine: number) => number = (lines: readonly string[], startLine: number): number => {
    let depth: number = 0;
    let opened: boolean = false;
    for (let index: number = startLine - 1; index < lines.length; index += 1) {
        const line: string = lines[index];
        for (let column: number = 0; column < line.length; column += 1) {
            const character: string = line[column];
            if (character === "{") {
                depth += 1;
                opened = true;
                continue;
            }
            if (character === "}") {
                depth -= 1;
                if (opened && depth === 0) {
                    return index + 1;
                }
                continue;
            }
            if (character === ";" && !opened) {
                return index + 1;
            }
        }
    }
    return startLine;
};

/**
 * Half-open UTF-8 byte range for an inclusive 1-based line span, matching
 * `ByteLineIndex`: a line's bytes include its trailing newline.
 */
const expectedBytes: (text: string, startLine: number, endLine: number) => { readonly startByte: bigint; readonly endByte: bigint; } = (
    text: string, startLine: number, endLine: number,
): { readonly startByte: bigint; readonly endByte: bigint; } => {
    const parts: string[] = text.split("\n");
    const startByteOf: (line: number) => bigint = (line: number): bigint => {
        let total: number = 0;
        for (let index: number = 0; index < Math.min(line - 1, parts.length); index += 1) {
            total += Buffer.byteLength(parts[index], "utf8") + 1;
        }
        return BigInt(total);
    };
    const endByte: bigint =
        endLine >= parts.length && !text.endsWith("\n") ? BigInt(Buffer.byteLength(text, "utf8")) : startByteOf(endLine + 1);
    return { startByte: startByteOf(startLine), endByte };
};

/**
 * Assert one node's full line/byte range. When `endLine` is omitted it is
 * derived from a simple brace count on the fixture.
 */
const assertRange: (node: OutlineNode, fixture: Fixture, startLine: number, endLine?: number) => void = (
    node: OutlineNode, fixture: Fixture, startLine: number, endLine?: number,
): void => {
    const resolvedEnd: number = endLine ?? blockEnd(fixture.lines, startLine);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(fixture.text, startLine, resolvedEnd);
    eq(Number(node.range.startLine), startLine, `${node.label}: start line`);
    eq(Number(node.range.endLine), resolvedEnd, `${node.label}: end line`);
    eq(node.range.startByte, expected.startByte, `${node.label}: start byte`);
    eq(node.range.endByte, expected.endByte, `${node.label}: end byte`);
};

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
 * Every node with one label, depth first.
 */
const collect: (nodes: readonly OutlineNode[], label: string) => OutlineNode[] = (nodes: readonly OutlineNode[], label: string): OutlineNode[] => {
    const found: OutlineNode[] = [];
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: OutlineNode = nodes[index];
        if (node.label === label) {
            found.push(node);
        }
        const nested: OutlineNode[] = collect(node.children, label);
        for (let nestedIndex: number = 0; nestedIndex < nested.length; nestedIndex += 1) {
            found.push(nested[nestedIndex]);
        }
    }
    return found;
};

/**
 * First node with one label, depth first.
 */
const findNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined = (
    nodes: readonly OutlineNode[], label: string,
): OutlineNode | undefined => collect(nodes, label)[0];

/**
 * First node with one label; throws when absent.
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
 * Modifiers of a node as a plain array, so a missing value is distinguishable.
 */
const modifiersOf: (node: OutlineNode) => string[] = (node: OutlineNode): string[] => [...(node.modifiers ?? [])];

/**
 * Run the public builder against the fixture sandbox.
 */
const outline: (path: string, options?: OutlineOptions) => OutlineResult = (path: string, options: OutlineOptions = {}): OutlineResult =>
    buildOutline(Sandbox, path, options);

/**
 * One contract deviation found by a `D*` scenario.
 */
interface ContractDeviation {
    readonly id: string;
    readonly title: string;
    readonly expected: string;
    readonly actual: string;
}

const Deviations: ContractDeviation[] = [];

/**
 * Record `actual` unless `condition` holds. A deviation never aborts the test,
 * so one scenario reports every mismatch it found.
 */
const contract: (condition: boolean, id: string, title: string, expected: string, actual: string) => void = (
    condition: boolean, id: string, title: string, expected: string, actual: string,
): void => {
    if (!condition) {
        Deviations.push({ id, title, expected, actual });
    }
};

/**
 * Fail a scenario when it recorded at least one deviation.
 */
const assertNoDeviation: (from: number) => void = (from: number): void => {
    const found: ContractDeviation[] = Deviations.slice(from);
    const message: string = found
        .map((deviation: ContractDeviation): string => `${deviation.id} ${deviation.title}: expected ${deviation.expected}, actual ${deviation.actual}`)
        .join("\n");
    deep(found.length, 0, message);
};

/**
 * Range invariants for one file: bigint fields, ordered/nested extents, and an
 * exact match against the line-index byte model.
 */
const inspectRanges: (fixture: Fixture, nodes: readonly OutlineNode[]) => string[] = (
    fixture: Fixture, nodes: readonly OutlineNode[],
): string[] => {
    const problems: string[] = [];
    const visit: (node: OutlineNode) => void = (node: OutlineNode): void => {
        const startByte: bigint = node.range.startByte;
        const endByte: bigint = node.range.endByte;
        const startLine: bigint = node.range.startLine;
        const endLine: bigint = node.range.endLine;
        if (typeof(startByte) !== "bigint" || typeof(endByte) !== "bigint" || typeof(startLine) !== "bigint" || typeof(endLine) !== "bigint") {
            problems.push(`${node.path}: range fields are not bigint`);
        }
        if (startLine < 1n || endLine < startLine) {
            problems.push(`${node.path}: line order ${startLine}-${endLine}`);
        }
        if (startByte < 0n || endByte < startByte) {
            problems.push(`${node.path}: byte order ${startByte}-${endByte}`);
        }
        if (endLine > BigInt(fixture.lines.length)) {
            problems.push(`${node.path}: end line ${endLine} beyond ${fixture.lines.length}`);
        }
        const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(fixture.text, Number(startLine), Number(endLine));
        if (startByte !== expected.startByte || endByte !== expected.endByte) {
            problems.push(`${node.path}: bytes ${startByte}-${endByte} expected ${expected.startByte}-${expected.endByte}`);
        }
        for (let index: number = 0; index < node.children.length; index += 1) {
            const child: OutlineNode = node.children[index];
            if (child.range.startByte < startByte || child.range.endByte > endByte) {
                problems.push(`${child.path}: bytes outside parent ${node.path}`);
            }
            if (child.range.startLine < startLine || child.range.endLine > endLine) {
                problems.push(`${child.path}: lines outside parent ${node.path}`);
            }
            if (child.depth <= node.depth) {
                problems.push(`${child.path}: depth ${child.depth} not deeper than parent ${node.depth}`);
            }
            visit(child);
        }
    };
    for (let index: number = 0; index < nodes.length; index += 1) {
        visit(nodes[index]);
    }
    return problems;
};

let Scenarios: number = 0;

/**
 * Register one scenario and count it for the run summary.
 */
const scenario: (title: string, body: () => void) => void = (title: string, body: () => void): void => {
    Scenarios += 1;
    test(title, body);
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MultiFixture: Fixture = makeFixture(
    "multi/Multi.java",
    [
        "package com.example.multi;",
        "",
        "public class Alpha {",
        "    private int value;",
        "    public Alpha(int value) { this.value = value; }",
        "    public int get() { return value; }",
        "    public static class Nested {",
        "        public void inner() {",
        "        }",
        "    }",
        "}",
        "",
        "class Beta {",
        "    void run() {",
        "    }",
        "}",
        "",
        "interface Shape {",
        "    double area();",
        '    default String name() { return "shape"; }',
        "}",
        "",
        "enum Color {",
        "    RED,",
        "    GREEN;",
        "    public String lower() { return name().toLowerCase(); }",
        "}",
        "",
        "record Point(int x, int y) {",
        "    public int sum() { return x + y; }",
        "}",
    ].join("\n"),
);

const ModsFixture: Fixture = makeFixture(
    "members/Mods.java",
    [
        "public class Mods {",
        "    private static final int LIMIT = 3;",
        "    static int counter = 0;",
        "    public String label;",
        "    protected transient int cache;",
        "    public Mods() {",
        "    }",
        "    private Mods(int seed) {",
        "    }",
        "    public static void main(String[] args) {",
        "    }",
        "    protected synchronized void locked() {",
        "    }",
        "    public static strictfp double square(double x) {",
        "        return x * x;",
        "    }",
        "    static public int reversed() {",
        "        return 1;",
        "    }",
        "    private <T> T identity(T value) {",
        "        return value;",
        "    }",
        '    public String join(String... parts) throws IllegalStateException {',
        '        return String.join(",", parts);',
        "    }",
        "    public java.util.List<String> names() throws java.io.IOException {",
        "        return null;",
        "    }",
        "}",
    ].join("\n"),
);

const GenFixture: Fixture = makeFixture(
    "members/Gen.java",
    [
        "public class Gen<T> {",
        "    private java.util.Map<String, java.util.List<Integer>> cache;",
        "    public Gen(T seed) {",
        "    }",
        "    public java.util.Map<String, java.util.List<Integer>> lookup() {",
        "        return null;",
        "    }",
        "    public <T extends Comparable<? super T>> T max(java.util.List<T> items) {",
        "        return null;",
        "    }",
        "    public java.util.List<? extends Number> nums() {",
        "        return null;",
        "    }",
        "    public static <K, V> java.util.Map<K, V> map() {",
        "        return null;",
        "    }",
        "    public int[] ints() {",
        "        return new int[0];",
        "    }",
        "    public void arrayParam(int[] xs, String... rest) throws java.io.IOException, IllegalStateException {",
        "    }",
        "}",
    ].join("\n"),
);

const AnnoFixture: Fixture = makeFixture(
    "members/Anno.java",
    [
        "import java.lang.annotation.Retention;",
        "",
        "public class Anno {",
        "    @Override",
        "    public String toString() {",
        '        return "anno";',
        "    }",
        "",
        '    @Deprecated(since = "9")',
        "    public void old() {",
        "    }",
        "",
        '    @SuppressWarnings({"a", "b"})',
        "    public void warn() {",
        "    }",
        "",
        "    @FunctionalInterface",
        "    public interface Handler {",
        "        void handle();",
        "    }",
        "}",
    ].join("\n"),
);

const MarkerFixture: Fixture = makeFixture(
    "members/Marker.java",
    ["public @interface Marker {", '    String value() default "";', "}"].join("\n"),
);

const EnumFixture: Fixture = makeFixture(
    "members/Level.java",
    [
        "public enum Level {",
        "    LOW(1),",
        "    HIGH(2);",
        "",
        "    private final int weight;",
        "",
        "    Level(int weight) {",
        "        this.weight = weight;",
        "    }",
        "",
        "    public int weight() {",
        "        return weight;",
        "    }",
        "}",
    ].join("\n"),
);

const Mods2Fixture: Fixture = makeFixture(
    "members/Mods2.java",
    [
        "public class Mods2 {",
        "    public synchronized void a() {",
        "    }",
        "    public native int b(int x);",
        "    public strictfp double c(double x) {",
        "        return x;",
        "    }",
        "    protected transient int d;",
        "    private volatile int e;",
        "}",
    ].join("\n"),
);

const DecoysFixture: Fixture = makeFixture(
    "decoys/Decoys.java",
    [
        "package com.example.decoys;",
        "",
        "/**",
        " * class Fake { void hidden() {} }",
        " */",
        "public class Decoys {",
        "    // class AlsoFake {",
        '    private String text = "class InString { void nope() {} }";',
        "    private char brace = '}';",
        "    private char quote = '\\'';",
        '    private String block = """',
        "        class InTextBlock { int bad; }",
        '        """;',
        "    public void real() {",
        '        System.out.println("}");',
        "    }",
        "}",
    ].join("\n"),
);

const OnlyFixture: Fixture = makeFixture(
    "edge/Only.java",
    ["package only.pkg;", "", "import java.util.List;", "import java.util.Map;"].join("\n"),
);

const EmptyFixture: Fixture = makeFixture("edge/Empty.java", "");

const CrlfFixture: Fixture = makeFixture(
    "edge/Crlf.java",
    ["package com.x;", "", "public class Crlf {", "    public void go() {", "    }", "}"].join("\r\n") + "\r\n",
);

const BomText: string = "package com.bom;\n\npublic class Bom {\n}\n";
const BomBytes: Buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomText, "utf8")]);
writeFixture("edge/Bom.java", BomBytes);

const UniFixture: Fixture = makeFixture(
    "edge/Uni.java",
    [
        "package com.example.uni;",
        "",
        "// 中文注释 class 伪",
        "public class Uni {",
        '    private String s = "中文";',
        "    public void go() {",
        "    }",
        "}",
    ].join("\n"),
);

const UniIdFixture: Fixture = makeFixture(
    "edge/UniId.java",
    ["public class Café {", "    private int 数量;", "    public void 计算() {", "    }", "}", "", "class Caf {", "}"].join("\n"),
);

const OrderFixture: Fixture = makeFixture(
    "order/Order.java",
    [
        "public class Order {",
        "    static class Inner {",
        "        void deep() {",
        "        }",
        "    }",
        "    public void methodA() {",
        "    }",
        "    static class Second {",
        "    }",
        "    public void methodB() {",
        "    }",
        "}",
    ].join("\n"),
);

const InlineFixture: Fixture = makeFixture(
    "dev/Inline.java",
    [
        "public class Inline {",
        '    @Override public String toString() { return "x"; }',
        '    @Deprecated(since = "1.0") public void old() {',
        "    }",
        "}",
        "",
        '@SuppressWarnings("all") public class Annotated {',
        "    public void ping() {",
        "    }",
        "}",
    ].join("\n"),
);

const SameLineFixture: Fixture = makeFixture("dev/SameLine.java", "class A { void x() {} } class B { void y() {} }\n");

const OverloadFixture: Fixture = makeFixture("dev/Overload.java", "class Overload { void run() {} void run(int value) {} }\n");

const OneLineFixture: Fixture = makeFixture("dev/OneLine.java", "public class OneLine { public int field; }\n");

const EdgeFixture: Fixture = makeFixture(
    "dev/Edge.java",
    [
        "public class Edge {",
        "    Edge() {",
        "    }",
        "    public String",
        "    multiline(int x) {",
        '        return "";',
        "    }",
        "    public <T extends Comparable<? super T>> T max(java.util.List<T> items) {",
        "        return null;",
        "    }",
        "    static {",
        '        System.out.println("init");',
        "    }",
        "    {",
        '        System.out.println("instance init");',
        "    }",
        "    public void outerMethod() {",
        "        class Local {",
        "            void localMethod() {",
        "            }",
        "        }",
        "        Runnable r = new Runnable() {",
        "            public void run() {",
        "            }",
        "        };",
        "    }",
        "    private int[] counts = { 1, 2, 3 };",
        "}",
    ].join("\n"),
);

const DollarFixture: Fixture = makeFixture(
    "edge/Dollar.java",
    ["package p;", "public class Foo$Bar {", "    public void m$1() {", "    }", "}"].join("\n"),
);

const BigLines: readonly string[] = ((): readonly string[] => {
    const lines: string[] = ["public class Big {"];
    for (let index: number = 0; index < 6; index += 1) {
        lines.push(`    public void m${index}() {`, "    }");
    }
    lines.push("    class In1 {", "        void deep1() {", "            class In2 {", "            }", "        }", "    }", "}");
    return lines;
})();
const BigFixture: Fixture = makeFixture("wide/Big.java", BigLines.join("\n"));

writeFixture("err/Bin.java", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
writeFixture("err/Huge.java", Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));

// ---------------------------------------------------------------------------
// Contract scenarios
// ---------------------------------------------------------------------------

scenario("J01 Java strategy, file anchor, package node and two top-level classes", (): void => {
    const result: OutlineResult = outline(MultiFixture.relative);
    eq(result.strategy, "java");
    eq(result.language, "java");
    eq(result.category, "code");
    eq(result.target, "file");
    eq(result.charset, "utf-8");
    eq(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    eq(anchor.isFile, true);
    eq(anchor.isDirectory, false);
    eq(anchor.type, "File");
    eq(anchor.path, "multi/Multi.java");
    eq(anchor.label, "Multi.java");
    eq(anchor.depth, 0);
    eq(anchor.range.startByte, 0n);
    eq(anchor.range.endByte, BigInt(Buffer.byteLength(MultiFixture.text, "utf8")));
    eq(Number(anchor.range.endLine), MultiFixture.lines.length);
    eq(outlineNodeFingerprint(anchor), result.fingerprint);
    ok(/^sha256:[0-9a-f]{64}$/.test(result.fingerprint));
    const javaPackage: OutlineNode = requireNode(result.nodes, "com.example.multi");
    eq(javaPackage.type, "package");
    eq(javaPackage.depth, 1);
    eq(javaPackage.path, "multi/Multi.java#com.example.multi");
    assertRange(javaPackage, MultiFixture, lineOf(MultiFixture, "package com.example.multi"));
    deep(labels(anchor.children), ["com.example.multi", "Alpha", "Beta", "Shape", "Color", "Point"]);
    const alpha: OutlineNode = requireNode(result.nodes, "Alpha");
    const beta: OutlineNode = requireNode(result.nodes, "Beta");
    eq(alpha.type, "class");
    eq(beta.type, "class");
    eq(alpha.depth, 1);
    eq(beta.depth, 1);
    eq(alpha.path, "multi/Multi.java#Alpha");
    eq(beta.path, "multi/Multi.java#Beta");
    assertRange(alpha, MultiFixture, lineOf(MultiFixture, "public class Alpha"));
    assertRange(beta, MultiFixture, lineOf(MultiFixture, "class Beta"));
});

scenario("J02 nested class and method paths use dot nesting", (): void => {
    const result: OutlineResult = outline(MultiFixture.relative);
    const alpha: OutlineNode = requireNode(result.nodes, "Alpha");
    const nested: OutlineNode = requireNode(alpha.children, "Nested");
    eq(nested.type, "class");
    eq(nested.depth, 2);
    eq(nested.path, "multi/Multi.java#Alpha.Nested");
    assertRange(nested, MultiFixture, lineOf(MultiFixture, "public static class Nested"));
    const inner: OutlineNode = requireNode(nested.children, "inner");
    eq(inner.type, "method");
    eq(inner.depth, 3);
    eq(inner.path, "multi/Multi.java#Alpha.Nested.inner");
    assertRange(inner, MultiFixture, lineOf(MultiFixture, "public void inner"));
    ok(nested.range.startByte >= alpha.range.startByte && nested.range.endByte <= alpha.range.endByte, "nested class inside Alpha");
    ok(inner.range.startByte >= nested.range.startByte && inner.range.endByte <= nested.range.endByte, "inner method inside Nested");
});

scenario("J03 interface and enum anchors with their members", (): void => {
    const result: OutlineResult = outline(MultiFixture.relative);
    const shape: OutlineNode = requireNode(result.nodes, "Shape");
    eq(shape.type, "interface");
    eq(shape.depth, 1);
    assertRange(shape, MultiFixture, lineOf(MultiFixture, "interface Shape"));
    const area: OutlineNode = requireNode(shape.children, "area");
    eq(area.type, "method");
    assertRange(area, MultiFixture, lineOf(MultiFixture, "double area()"));
    const shapeName: OutlineNode = requireNode(shape.children, "name");
    eq(shapeName.type, "method");
    deep(modifiersOf(shapeName), ["default"]);
    const color: OutlineNode = requireNode(result.nodes, "Color");
    eq(color.type, "enum");
    eq(color.depth, 1);
    assertRange(color, MultiFixture, lineOf(MultiFixture, "enum Color"));
    const lower: OutlineNode = requireNode(color.children, "lower");
    eq(lower.type, "method");
    assertRange(lower, MultiFixture, lineOf(MultiFixture, "public String lower"));
});

scenario("J04 record anchor and its members", (): void => {
    const result: OutlineResult = outline(MultiFixture.relative);
    const point: OutlineNode = requireNode(result.nodes, "Point");
    eq(point.depth, 1);
    assertRange(point, MultiFixture, lineOf(MultiFixture, "record Point"));
    const sum: OutlineNode = requireNode(point.children, "sum");
    eq(sum.type, "method");
    assertRange(sum, MultiFixture, lineOf(MultiFixture, "public int sum"));
});

scenario("J05 fields are property and constructors/methods are method", (): void => {
    const result: OutlineResult = outline(ModsFixture.relative);
    const mods: OutlineNode = requireNode(result.nodes, "Mods");
    eq(mods.type, "class");
    deep(labels(mods.children), ["LIMIT", "counter", "label", "cache", "Mods", "Mods", "main", "locked", "square", "reversed", "identity", "join", "names"]);
    for (const field of ["LIMIT", "counter", "label", "cache"]) {
        eq(requireNode(mods.children, field).type, "property", `${field} is a property`);
    }
    const constructors: OutlineNode[] = collect(mods.children, "Mods");
    eq(constructors.length, 2);
    eq(constructors[0].type, "method");
    eq(constructors[1].type, "method");
    eq(requireNode(mods.children, "main").type, "method");
    eq(requireNode(mods.children, "identity").type, "method");
    eq(requireNode(mods.children, "names").type, "method");
});

scenario("J06 static fields/methods carry static and access modifier chains keep source order", (): void => {
    const result: OutlineResult = outline(ModsFixture.relative);
    const mods: OutlineNode = requireNode(result.nodes, "Mods");
    deep(modifiersOf(requireNode(mods.children, "LIMIT")), ["private", "static", "final"]);
    deep(modifiersOf(requireNode(mods.children, "counter")), ["static"]);
    deep(modifiersOf(requireNode(mods.children, "main")), ["public", "static"]);
    deep(modifiersOf(requireNode(mods.children, "square")), ["public", "static", "strictfp"]);
    deep(modifiersOf(requireNode(mods.children, "reversed")), ["static", "public"]);
    deep(modifiersOf(requireNode(mods.children, "label")), ["public"]);
    deep(modifiersOf(requireNode(mods.children, "cache")), ["protected", "transient"]);
    deep(modifiersOf(requireNode(mods.children, "locked")), ["protected", "synchronized"]);
    eq(requireNode(mods.children, "counter").type, "property");
    eq(requireNode(mods.children, "main").type, "method");
});

scenario("J07 generics, arrays, varargs and throws stay on one method node", (): void => {
    const result: OutlineResult = outline(GenFixture.relative);
    const gen: OutlineNode = requireNode(result.nodes, "Gen");
    deep(labels(gen.children), ["cache", "Gen", "lookup", "max", "nums", "map", "ints", "arrayParam"]);
    eq(requireNode(gen.children, "cache").type, "property");
    for (const method of ["Gen", "lookup", "max", "nums", "map", "ints", "arrayParam"]) {
        eq(requireNode(gen.children, method).type, "method", `${method} is a method`);
    }
    deep(modifiersOf(requireNode(gen.children, "map")), ["public", "static"]);
    ok((requireNode(gen.children, "lookup").detail ?? "").includes("Map<String, java.util.List<Integer>>"), "generic return type kept in detail");
    ok((requireNode(gen.children, "max").detail ?? "").includes("Comparable<? super T>"), "bounded type parameter kept in detail");
    ok((requireNode(gen.children, "arrayParam").detail ?? "").includes("throws"), "throws clause kept in detail");
    assertRange(requireNode(gen.children, "max"), GenFixture, lineOf(GenFixture, "public <T extends Comparable"));
    assertRange(requireNode(gen.children, "arrayParam"), GenFixture, lineOf(GenFixture, "public void arrayParam"));
});

scenario("J08 annotations on their own line are skipped while annotated members stay", (): void => {
    const result: OutlineResult = outline(AnnoFixture.relative);
    const anno: OutlineNode = requireNode(result.nodes, "Anno");
    deep(labels(anno.children), ["toString", "old", "warn", "Handler"]);
    eq(requireNode(anno.children, "toString").type, "method");
    eq(requireNode(anno.children, "old").type, "method");
    eq(requireNode(anno.children, "warn").type, "method");
    const handler: OutlineNode = requireNode(anno.children, "Handler");
    eq(handler.type, "interface");
    eq(handler.depth, 2);
    eq(requireNode(handler.children, "handle").type, "method");
    for (const pseudo of ["Override", "Deprecated", "SuppressWarnings", "FunctionalInterface", "Retention", "since"]) {
        eq(findNode(result.nodes, pseudo), undefined, `${pseudo} is not a symbol`);
    }
});

scenario("J09 @interface is an interface kind", (): void => {
    const result: OutlineResult = outline(MarkerFixture.relative);
    const marker: OutlineNode = requireNode(result.nodes, "Marker");
    eq(marker.type, "interface");
    eq(marker.path, "members/Marker.java#Marker");
    assertRange(marker, MarkerFixture, lineOf(MarkerFixture, "public @interface Marker"));
    const value: OutlineNode = requireNode(marker.children, "value");
    eq(value.type, "method");
    assertRange(value, MarkerFixture, lineOf(MarkerFixture, "String value()"));
});

scenario("J10 comments, strings, char literals and text blocks produce no pseudo symbols", (): void => {
    const result: OutlineResult = outline(DecoysFixture.relative);
    const decoys: OutlineNode = requireNode(result.nodes, "Decoys");
    deep(labels(decoys.children), ["text", "brace", "quote", "block", "real"]);
    for (const pseudo of ["Fake", "AlsoFake", "InString", "InTextBlock", "nope", "hidden", "bad"]) {
        eq(findNode(result.nodes, pseudo), undefined, `${pseudo} is masked`);
    }
    for (const member of ["text", "brace", "quote", "block"]) {
        eq(requireNode(decoys.children, member).type, "property", `${member} is a property`);
    }
    const block: OutlineNode = requireNode(decoys.children, "block");
    const blockLine: number = lineOf(DecoysFixture, "private String block");
    eq(Number(block.range.startLine), blockLine);
    eq(Number(block.range.endLine), blockLine + 2);
    const real: OutlineNode = requireNode(decoys.children, "real");
    eq(real.type, "method");
    eq(Number(real.range.startLine), lineOf(DecoysFixture, "public void real"));
    eq(Number(real.range.endLine), lineOf(DecoysFixture, 'System.out.println("}")') + 1);
    assertRange(decoys, DecoysFixture, lineOf(DecoysFixture, "public class Decoys"), DecoysFixture.lines.length);
});

scenario("J11 empty file yields a zero-length file anchor", (): void => {
    const result: OutlineResult = outline(EmptyFixture.relative);
    eq(result.strategy, "java");
    eq(result.nodes.length, 1);
    eq(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    eq(anchor.type, "File");
    eq(anchor.children.length, 0);
    eq(anchor.range.startByte, 0n);
    eq(anchor.range.endByte, 0n);
    eq(anchor.range.startLine, 1n);
    eq(anchor.range.endLine, 1n);
    ok(/^sha256:[0-9a-f]{64}$/.test(result.fingerprint));
});

scenario("J12 package/import-only file reports the package and no import nodes", (): void => {
    const result: OutlineResult = outline(OnlyFixture.relative);
    const anchor: OutlineNode = result.nodes[0];
    eq(anchor.children.length, 1);
    const javaPackage: OutlineNode = requireNode(result.nodes, "only.pkg");
    eq(javaPackage.type, "package");
    eq(javaPackage.depth, 1);
    assertRange(javaPackage, OnlyFixture, lineOf(OnlyFixture, "package only.pkg"));
    eq(findNode(result.nodes, "List"), undefined);
    eq(findNode(result.nodes, "java.util.List"), undefined);
    eq(result.truncated, false);
});

scenario("J13 CRLF keeps line numbers and UTF-8 byte offsets", (): void => {
    const result: OutlineResult = outline(CrlfFixture.relative);
    eq(result.charset, "utf-8");
    eq(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    eq(Number(anchor.range.endLine), CrlfFixture.lines.length);
    eq(anchor.range.endByte, BigInt(Buffer.byteLength(CrlfFixture.text, "utf8")));
    const javaPackage: OutlineNode = requireNode(result.nodes, "com.x");
    eq(Number(javaPackage.range.startLine), 1);
    eq(Number(javaPackage.range.endLine), 1);
    assertRange(javaPackage, CrlfFixture, 1, 1);
    const crlf: OutlineNode = requireNode(result.nodes, "Crlf");
    eq(Number(crlf.range.startLine), 3);
    eq(Number(crlf.range.endLine), 6);
    const go: OutlineNode = requireNode(crlf.children, "go");
    eq(go.type, "method");
    assertRange(go, CrlfFixture, 4, 5);
    ok(!crlf.label.includes("\r") && !go.label.includes("\r"), "labels never carry the carriage return");
});

scenario("J14 UTF-8 BOM is stripped before parsing and reported as charset", (): void => {
    const result: OutlineResult = outline("edge/Bom.java");
    eq(result.charset, "utf-8-bom");
    const anchor: OutlineNode = result.nodes[0];
    eq(anchor.file!.bytes, BigInt(BomBytes.byteLength));
    eq(anchor.range.endByte, BigInt(BomBytes.byteLength));
    eq(Number(anchor.range.endLine), 4);
    const javaPackage: OutlineNode = requireNode(result.nodes, "com.bom");
    eq(javaPackage.type, "package");
    eq(Number(javaPackage.range.startLine), 1);
    eq(javaPackage.range.startByte, 3n);
    const bom: OutlineNode = requireNode(result.nodes, "Bom");
    eq(bom.type, "class");
    eq(Number(bom.range.startLine), 3);
    eq(findNode(result.nodes, "\uFEFFpackage com.bom"), undefined);
});

scenario("J15 Unicode content keeps UTF-8 byte ranges", (): void => {
    const result: OutlineResult = outline(UniFixture.relative);
    const uni: OutlineNode = requireNode(result.nodes, "Uni");
    assertRange(uni, UniFixture, lineOf(UniFixture, "public class Uni"));
    eq(uni.range.startByte, BigInt(Buffer.byteLength('package com.example.uni;\n\n// 中文注释 class 伪\n', "utf8")));
    const property: OutlineNode = requireNode(uni.children, "s");
    eq(property.type, "property");
    assertRange(property, UniFixture, lineOf(UniFixture, "private String s"));
    eq(property.range.endByte - property.range.startByte, BigInt(Buffer.byteLength('    private String s = "中文";\n', "utf8")));
    const go: OutlineNode = requireNode(uni.children, "go");
    eq(go.type, "method");
    assertRange(go, UniFixture, lineOf(UniFixture, "public void go"));
    eq(findNode(result.nodes, "伪"), undefined);
});

scenario("J16 symbol paths are File#Class and File#Class.method", (): void => {
    const result: OutlineResult = outline(MultiFixture.relative);
    eq(requireNode(result.nodes, "Alpha").path, "multi/Multi.java#Alpha");
    eq(requireNode(result.nodes, "get").path, "multi/Multi.java#Alpha.get");
    eq(requireNode(result.nodes, "Nested").path, "multi/Multi.java#Alpha.Nested");
    eq(requireNode(result.nodes, "inner").path, "multi/Multi.java#Alpha.Nested.inner");
    const dollar: OutlineResult = outline(DollarFixture.relative);
    const foo: OutlineNode = requireNode(dollar.nodes, "Foo$Bar");
    eq(foo.path, "edge/Dollar.java#Foo$Bar");
    eq(requireNode(foo.children, "m$1").path, "edge/Dollar.java#Foo$Bar.m$1");
    for (const node of flatten(result.nodes)) {
        if (!node.isFile) {
            ok(node.path.startsWith("multi/Multi.java#"), `${node.label} is anchored`);
        }
    }
    for (const node of flatten(result.nodes)) {
        const siblingCounts: Map<string, number> = new Map<string, number>();
        for (const child of node.children) {
            siblingCounts.set(child.label, (siblingCounts.get(child.label) ?? 0) + 1);
        }
        const siblingPaths: Set<string> = new Set<string>();
        for (const child of node.children) {
            const prefix: string = node.isFile ? `${node.path}#${child.label}` : `${node.path}.${child.label}`;
            ok(child.path.startsWith(prefix), `${child.label} path extends its parent`);
            if ((siblingCounts.get(child.label) ?? 0) === 1) {
                eq(child.path, prefix, `${child.label} unique path remains unchanged`);
            }
            ok(!siblingPaths.has(child.path), `${child.label} sibling path is unique`);
            siblingPaths.add(child.path);
        }
    }
});

scenario("J17 ranges are bigint, ordered, nested and match the byte index", (): void => {
    for (const fixture of [MultiFixture, ModsFixture, GenFixture, AnnoFixture, EnumFixture, OrderFixture, DecoysFixture, CrlfFixture, BigFixture]) {
        const result: OutlineResult = outline(fixture.relative);
        deep(inspectRanges(fixture, result.nodes), [], `${fixture.relative}: range invariants`);
    }
    const result: OutlineResult = outline(MultiFixture.relative);
    const nested: OutlineNode = requireNode(result.nodes, "inner");
    ok(nested.range.startLine > 1n && nested.range.endLine > nested.range.startLine, "lines are 1-based inclusive");
    ok(nested.range.endByte > nested.range.startByte, "bytes are half-open");
});

scenario("J18 maxNodes truncates explicitly and counts the anchor", (): void => {
    const full: OutlineResult = outline(BigFixture.relative);
    eq(flatten(full.nodes).length, 11);
    eq(full.truncated, false);
    const two: OutlineResult = outline(BigFixture.relative, { maxNodes: 2 });
    eq(two.truncated, true);
    deep(labels(two.nodes[0].children), ["Big"]);
    const three: OutlineResult = outline(BigFixture.relative, { maxNodes: 3 });
    eq(three.truncated, true);
    eq(flatten(three.nodes).length, 3);
    deep(labels(three.nodes[0].children[0].children), ["m0"]);
    const one: OutlineResult = outline(BigFixture.relative, { maxNodes: 1 });
    eq(one.truncated, true);
    eq(flatten(one.nodes).length, 1);
    const capped: OutlineResult = outline(BigFixture.relative, { maxNodes: 999999 });
    eq(capped.truncated, false);
    eq(flatten(capped.nodes).length, 11);
});

scenario("J19 maxDepth drops deeper symbols and flags truncation", (): void => {
    const two: OutlineResult = outline(BigFixture.relative, { maxDepth: 2 });
    eq(two.truncated, true);
    deep(labels(two.nodes[0].children), ["Big"]);
    const big: OutlineNode = requireNode(two.nodes, "Big");
    deep(labels(big.children), ["m0", "m1", "m2", "m3", "m4", "m5", "In1"]);
    eq(findNode(two.nodes, "deep1"), undefined);
    eq(findNode(two.nodes, "In2"), undefined);
    const one: OutlineResult = outline(BigFixture.relative, { maxDepth: 1 });
    eq(one.truncated, true);
    eq(flatten(one.nodes).length, 2);
    const full: OutlineResult = outline(BigFixture.relative);
    eq(full.truncated, false);
    eq(requireNode(full.nodes, "deep1").depth, 3);
    eq(requireNode(full.nodes, "In2").depth, 4);
});

scenario("J20 binary, oversize, escape, missing and invalid bounds use closed error codes", (): void => {
    throwsCode("binary_file", (): void => {
        outline("err/Bin.java");
    });
    throwsCode("quota_exceeded", (): void => {
        outline("err/Huge.java");
    });
    throwsCode("path_escape", (): void => {
        outline("../outside.java");
    });
    throwsCode("not_found", (): void => {
        outline("err/Missing.java");
    });
    throwsCode("invalid_arguments", (): void => {
        outline(BigFixture.relative, { maxNodes: 0 });
    });
    throwsCode("invalid_arguments", (): void => {
        outline(BigFixture.relative, { maxDepth: 0 });
    });
    throwsCode("invalid_arguments", (): void => {
        outline(BigFixture.relative, { maxNodes: 2.5 });
    });
    throwsCode("invalid_arguments", (): void => {
        outline(BigFixture.relative, { maxNodes: Number.NaN });
    });
});

// ---------------------------------------------------------------------------
// Contract deviations
//
// The scenarios below assert behavior implied by the module contract. They are
// expected to fail until the Java strategy is fixed; each record carries a
// finding id used by `docs/testing/languages/javaReport.md`.
// ---------------------------------------------------------------------------

scenario("D01 same-line annotation hides the annotated declaration", (): void => {
    const from: number = Deviations.length;
    const result: OutlineResult = outline(InlineFixture.relative);
    const inline: OutlineNode = requireNode(result.nodes, "Inline");
    contract(
        findNode(inline.children, "toString") !== undefined,
        "F-J01",
        "an annotated method shares its declaration line",
        "method toString under Inline",
        `children ${JSON.stringify(labels(inline.children))}`,
    );
    contract(
        findNode(inline.children, "old") !== undefined,
        "F-J01",
        "an annotated method with arguments shares its declaration line",
        "method old under Inline",
        `children ${JSON.stringify(labels(inline.children))}`,
    );
    const annotated: OutlineNode | undefined = findNode(result.nodes, "Annotated");
    contract(annotated !== undefined, "F-J01", "an annotated class shares its declaration line", "class Annotated with method ping", "no Annotated node");
    assertNoDeviation(from);
});

scenario("D02 declarations sharing one physical line keep both top-level types", (): void => {
    const same: OutlineResult = outline(SameLineFixture.relative);
    const classA: OutlineNode = requireNode(same.nodes, "A");
    const classB: OutlineNode = requireNode(same.nodes, "B");
    eq(classA.type, "class");
    eq(classB.type, "class");
    eq(classB.depth, 1);
    eq(Number(classB.range.startLine), 1);
    eq(classB.path, "dev/SameLine.java#B");
    assertRange(classB, SameLineFixture, 1, 1);
    eq(requireNode(classB.children, "y").path, "dev/SameLine.java#B.y");
    const overloads: OutlineNode[] = requireNode(outline(OverloadFixture.relative).nodes, "Overload").children as OutlineNode[];
    eq(overloads.length, 2);
    eq(new Set(overloads.map((node: OutlineNode): string => node.path)).size, 2);
    const oneLine: OutlineResult = outline(OneLineFixture.relative);
    const one: OutlineNode = requireNode(oneLine.nodes, "OneLine");
    eq(findNode(one.children, "field") !== undefined, true);
});

scenario("D03 type children follow declaration order", (): void => {
    const from: number = Deviations.length;
    const result: OutlineResult = outline(OrderFixture.relative);
    const outer: OutlineNode = requireNode(result.nodes, "Order");
    const starts: number[] = outer.children.map((node: OutlineNode): number => Number(node.range.startLine));
    const sorted: number[] = [...starts].sort((left: number, right: number): number => left - right);
    contract(
        starts.every((value: number, index: number): boolean => value === sorted[index]),
        "F-J04",
        "children are ordered by start line",
        `[${sorted.join(",")}]`,
        `[${starts.join(",")}] for ${JSON.stringify(labels(outer.children))}`,
    );
    assertNoDeviation(from);
});

scenario("D04 package-private constructors are missing", (): void => {
    const from: number = Deviations.length;
    const edge: OutlineResult = outline(EdgeFixture.relative);
    const edgeClass: OutlineNode = requireNode(edge.nodes, "Edge");
    contract(findNode(edgeClass.children, "Edge") !== undefined, "F-J02", "constructor without an access modifier", "method Edge", `children ${JSON.stringify(labels(edgeClass.children))}`);
    const level: OutlineNode = requireNode(outline(EnumFixture.relative).nodes, "Level");
    contract(findNode(level.children, "Level") !== undefined, "F-J02", "enum constructor without an access modifier", "method Level", `children ${JSON.stringify(labels(level.children))}`);
    assertNoDeviation(from);
});

scenario("D05 enum constants are symbols and symbol paths are unique", (): void => {
    const from: number = Deviations.length;
    const level: OutlineNode = requireNode(outline(EnumFixture.relative).nodes, "Level");
    contract(findNode(level.children, "LOW") !== undefined, "F-J03", "enum constant", "constant LOW", `children ${JSON.stringify(labels(level.children))}`);
    contract(findNode(level.children, "HIGH") !== undefined, "F-J03", "enum constant", "constant HIGH", `children ${JSON.stringify(labels(level.children))}`);
    const paths: string[] = level.children.map((node: OutlineNode): string => node.path);
    contract(new Set<string>(paths).size === paths.length, "F-J08", "symbol paths are unique inside one type", "unique paths", JSON.stringify(paths));
    assertNoDeviation(from);
});

scenario("D06 record keeps its own kind and exposes components", (): void => {
    const from: number = Deviations.length;
    const point: OutlineNode = requireNode(outline(MultiFixture.relative).nodes, "Point");
    contract(point.type !== "class", "F-J06", "record kind is distinguishable from class", "struct or type kind", `type ${point.type}`);
    const components: string[] = labels(point.children);
    contract(
        findNode(point.children, "x") !== undefined && findNode(point.children, "y") !== undefined,
        "F-J06",
        "record components are properties",
        "properties x and y",
        `children ${JSON.stringify(components)}`,
    );
    assertNoDeviation(from);
});

scenario("D07 Java modifier words are part of the modifier chain", (): void => {
    const from: number = Deviations.length;
    const mods: OutlineNode = requireNode(outline(Mods2Fixture.relative).nodes, "Mods2");
    const cases: readonly (readonly [string, string])[] = [
        ["a", "synchronized"],
        ["b", "native"],
        ["c", "strictfp"],
        ["d", "transient"],
        ["e", "volatile"],
    ];
    for (const [label, modifier] of cases) {
        const node: OutlineNode | undefined = findNode(mods.children, label);
        contract(
            node !== undefined && modifiersOf(node).includes(modifier),
            "F-J05",
            `${modifier} is reported as a modifier`,
            `modifiers include ${modifier}`,
            node === undefined ? "node missing" : JSON.stringify(modifiersOf(node)),
        );
    }
    assertNoDeviation(from);
});

scenario("D08 non-ASCII Java identifiers keep their names", (): void => {
    const from: number = Deviations.length;
    const result: OutlineResult = outline(UniIdFixture.relative);
    const cafe: OutlineNode | undefined = findNode(result.nodes, "Café");
    const truncated: OutlineNode | undefined = findNode(result.nodes, "Caf");
    contract(cafe !== undefined, "F-J07", "non-ASCII class name", "label Café", truncated === undefined ? "missing" : `label ${truncated.label}`);
    contract(findNode(result.nodes, "计算") !== undefined, "F-J07", "non-ASCII method name", "method 计算", "missing");
    contract(findNode(result.nodes, "数量") !== undefined, "F-J07", "non-ASCII field name", "property 数量", "missing");
    const cafs: OutlineNode[] = collect(result.nodes, "Caf");
    contract(new Set<string>(cafs.map((node: OutlineNode): string => node.path)).size === cafs.length, "F-J07", "truncation does not merge distinct declarations", "unique paths", JSON.stringify(cafs.map((node: OutlineNode): string => node.path)));
    assertNoDeviation(from);
});

scenario("D09 a local class is not promoted to a type member", (): void => {
    const from: number = Deviations.length;
    const edgeClass: OutlineNode = requireNode(outline(EdgeFixture.relative).nodes, "Edge");
    const local: OutlineNode | undefined = findNode(edgeClass.children, "Local");
    contract(
        local !== undefined && local.path.startsWith("dev/Edge.java#Edge.outerMethod"),
        "F-J09",
        "local class path nests under its method",
        "dev/Edge.java#Edge.outerMethod.Local",
        local === undefined ? "missing" : local.path,
    );
    assertNoDeviation(from);
});

scenario("D10 a method signature split across lines is a method", (): void => {
    const from: number = Deviations.length;
    const edgeClass: OutlineNode = requireNode(outline(EdgeFixture.relative).nodes, "Edge");
    contract(findNode(edgeClass.children, "multiline") !== undefined, "F-J10", "signature split over two lines", "method multiline", `children ${JSON.stringify(labels(edgeClass.children))}`);
    assertNoDeviation(from);
});

scenario("D11 type declarations expose their own modifiers", (): void => {
    const from: number = Deviations.length;
    const result: OutlineResult = outline(MultiFixture.relative);
    const alpha: OutlineNode = requireNode(result.nodes, "Alpha");
    const nested: OutlineNode = requireNode(result.nodes, "Nested");
    contract(modifiersOf(alpha).includes("public"), "F-J11", "public class modifier", "public", JSON.stringify(modifiersOf(alpha)));
    contract(modifiersOf(nested).includes("static"), "F-J11", "static nested class modifier", "static", JSON.stringify(modifiersOf(nested)));
    assertNoDeviation(from);
});

scenario("D12 a BOM file anchor range covers the file bytes", (): void => {
    const from: number = Deviations.length;
    const result: OutlineResult = outline("edge/Bom.java");
    const anchor: OutlineNode = result.nodes[0];
    const fileBytes: bigint = anchor.file!.bytes;
    eq(fileBytes, BigInt(BomBytes.byteLength));
    contract(
        anchor.range.endByte === fileBytes,
        "F-J12",
        "anchor range endByte equals file.bytes",
        `${fileBytes}`,
        `${anchor.range.endByte} (decoded text without the 3-byte BOM)`,
    );
    assertNoDeviation(from);
});

scenario("Z01 every contract deviation is recorded with its finding id", (): void => {
    const message: string = Deviations.map(
        (deviation: ContractDeviation): string => `${deviation.id} | ${deviation.title} | expected ${deviation.expected} | actual ${deviation.actual}`,
    ).join("\n");
    deep(Deviations.length, 0, message);
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

after((): void => {
    const ids: string[] = [...new Set<string>(Deviations.map((deviation: ContractDeviation): string => deviation.id))].sort();
    console.log(`\nJAVA OUTLINE CHECK SUMMARY scenarios=${Scenarios} assertions=${Assertions} deviations=${Deviations.length} findings=${ids.length}`);
    console.log(`FINDINGS ${ids.join(",")}`);
    for (const deviation of Deviations) {
        console.log(`DEVIATION ${deviation.id} | ${deviation.title} | expected ${deviation.expected} | actual ${deviation.actual}`);
    }
    rmSync(Root, { recursive: true, force: true });
});
