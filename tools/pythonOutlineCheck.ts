#!/usr/bin/env node
/**
 * Python outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; fixture code is never executed and no third-party parser is
 * involved. Assertions go through the public `buildOutline` entry point so
 * sandbox resolution, the charset gate, the Python strategy, anchor/path
 * construction, UTF-8 byte ranges and the node/depth/scan bounds are exercised
 * together.
 *
 * The suite is a regression gate: it must stay green. Three cases intentionally
 * pin a remaining limitation (marked `KNOWN L-xx` and described in
 * `docs/testing/languages/pythonReport.md`): UTF-16 byte offsets, tolerant
 * invalid indentation and unterminated triple quotes. When such a limitation is
 * fixed, the pinned case flips to FAIL on purpose, which is the signal to
 * promote it to a contract assertion.
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

const Root: string = mkdtempSync(join(tmpdir(), "amp-python-outline-"));
const RootSpec: SessionRoot = { id: "root.pythonOutline", path: Root, writable: true, exclude: [] };
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
const findNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode | undefined = (nodes, label): OutlineNode | undefined => {
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
 * Number of logical lines in decoded text: no phantom line after a trailing
 * newline, zero for the empty file.
 */
const totalLinesOf: (text: string) => number = (text: string): number => {
    if (text.length === 0) {
        return 0;
    }
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};

/**
 * 1-based start byte offset of one line, matching `ByteLineIndex`: a line's
 * span includes its trailing newline, and offsets saturate at EOF.
 */
const startByteOf: (text: string, line: number) => bigint = (text: string, line: number): bigint => {
    if (line <= 1) {
        return 0n;
    }
    const lines: string[] = text.split("\n");
    let total: number = 0;
    for (let index: number = 0; index < Math.min(line - 1, lines.length); index += 1) {
        total += Buffer.byteLength(lines[index], "utf8") + 1;
    }
    return BigInt(Math.min(total, Buffer.byteLength(text, "utf8")));
};

/**
 * One fixture path paired with the exact decoded text used for range math.
 */
interface FixtureCase {
    readonly path: string;
    readonly text: string;
}

/**
 * Assert one node's line range and the matching UTF-8 byte range.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (node, text, startLine, endLine): void => {
    assert.equal(Number(node.range.startLine), startLine, `${node.path}: startLine`);
    assert.equal(Number(node.range.endLine), endLine, `${node.path}: endLine`);
    assert.equal(node.range.startByte, startByteOf(text, startLine), `${node.path}: startByte`);
    assert.equal(node.range.endByte, startByteOf(text, endLine + 1), `${node.path}: endByte`);
};

/**
 * Assert that one range is bigint-typed, ordered, inside the file and exactly
 * aligned with its own line numbers.
 */
const assertRangeCoherent: (node: OutlineNode, text: string) => void = (node: OutlineNode, text: string): void => {
    assert.equal(typeof(node.range.startByte), "bigint", `${node.path}: startByte is bigint`);
    assert.equal(typeof(node.range.endByte), "bigint", `${node.path}: endByte is bigint`);
    assert.equal(typeof(node.range.startLine), "bigint", `${node.path}: startLine is bigint`);
    assert.equal(typeof(node.range.endLine), "bigint", `${node.path}: endLine is bigint`);
    const startLine: number = Number(node.range.startLine);
    const endLine: number = Number(node.range.endLine);
    assert.ok(startLine >= 1, `${node.path}: startLine >= 1`);
    assert.ok(endLine >= startLine, `${node.path}: endLine >= startLine`);
    assert.ok(node.range.startByte <= node.range.endByte, `${node.path}: startByte <= endByte`);
    assert.ok(endLine <= Math.max(1, totalLinesOf(text)), `${node.path}: endLine inside the file`);
    assert.equal(node.range.startByte, startByteOf(text, startLine), `${node.path}: startByte matches startLine`);
    assert.equal(node.range.endByte, startByteOf(text, endLine + 1), `${node.path}: endByte matches endLine`);
};

/**
 * Assert the anchor, the symbol paths and every parent/child range invariant
 * for one file outline.
 */
const assertTreeInvariants: (result: OutlineResult, text: string) => void = (result: OutlineResult, text: string): void => {
    assert.equal(result.nodes.length, 1);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, result.path);
    assert.equal(anchor.depth, 0);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(text, "utf8")));
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), Math.max(1, totalLinesOf(text)));
    assertRangeCoherent(anchor, text);
    const visit: (nodes: readonly OutlineNode[], parent: OutlineNode) => void = (nodes: readonly OutlineNode[], parent: OutlineNode): void => {
        for (let index: number = 0; index < nodes.length; index += 1) {
            const node: OutlineNode = nodes[index];
            assert.equal(node.isFile, false, `${node.path}: symbol is not a file anchor`);
            assert.equal(node.isDirectory, false, `${node.path}: symbol is not a directory anchor`);
            assert.equal(node.depth, parent.depth + 1, `${node.path}: depth follows its parent`);
            assert.equal(node.path, parent.isFile ? `${result.path}#${node.label}` : `${parent.path}.${node.label}`, `${node.path}: path`);
            assert.ok(parent.range.startByte <= node.range.startByte, `${node.path}: parent starts before child`);
            assert.ok(parent.range.endByte >= node.range.endByte, `${node.path}: parent ends after child`);
            assert.ok(parent.range.startLine <= node.range.startLine, `${node.path}: parent line starts before child`);
            assert.ok(parent.range.endLine >= node.range.endLine, `${node.path}: parent line ends after child`);
            assertRangeCoherent(node, text);
            visit(node.children, node);
        }
    };
    visit(anchor.children, anchor);
};

/**
 * Locate a fixture line by exact trimmed content, so line assertions stay
 * readable when a fixture grows.
 */
const lineOf: (text: string, needle: string) => number = (text: string, needle: string): number => {
    const lines: string[] = text.split("\n");
    for (let index: number = 0; index < lines.length; index += 1) {
        if (lines[index].trim() === needle) {
            return index + 1;
        }
    }
    assert.fail(`fixture line not found: ${needle}`);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Two classes in one file: a class property (annotated and plain), a class
 * method, blank-line separators and the second class as a sibling root.
 */
const TwoClassesText: string = ["class Alpha:", "    x: int = 1", "", "    def run(self):", "        return 1", "", "", "class Beta:", "    y = 2"].join("\n");

/**
 * Decorators at module and class scope, including stacked decorators and a
 * `@property` method. No decorator line may become a node or split the class.
 */
const DecoratorsText: string = [
    "@decorate",
    "@retry(times=3)",
    "def helper():",
    "    return 1",
    "",
    "",
    "class Service:",
    '    """Service docstring."""',
    "",
    "    retries: int = 3",
    "",
    "    @staticmethod",
    "    @cached",
    "    def make():",
    "        return Service()",
    "",
    "    @classmethod",
    "    def build(cls):",
    "        return cls()",
    "",
    "    @property",
    "    def name(self):",
    '        return "service"',
].join("\n");

/**
 * Module scope: constant, variable, async def, global def, nested def, nested
 * class with a property and method, and a trailing class.
 */
const ModuleScopeText: string = [
    "MAX_CONNECTIONS = 100",
    "timeout = 30",
    "",
    "async def fetch(url):",
    "    return url",
    "",
    "",
    "def outer():",
    "    def inner():",
    "        return 1",
    "",
    "    class Local:",
    "        value = 2",
    "",
    "        def local_method(self):",
    "            return self.value",
    "",
    "    return inner",
    "",
    "",
    "class Global:",
    "    pass",
].join("\n");

/**
 * Module, function and method docstrings plus a plain string and a comment,
 * each containing pseudo declarations that must stay invisible.
 */
const DocstringsText: string = [
    '"""',
    "Module docstring.",
    "",
    "class Ghost:",
    "    def hidden():",
    "        pass",
    '"""',
    "",
    "def real() -> str:",
    '    """Return a string.',
    "",
    "    def also_hidden(): pass",
    '    """',
    '    text = "def fake(): pass"',
    "    # class Commented:",
    "    '''class TripleGhost: pass'''",
    "    return text",
    "",
    "",
    "class Holder:",
    '    """Holder docs."""',
    "",
    "    value = 1",
    "",
    "    def method(self):",
    '        """Method docs with class Inner: pass."""',
    "        return self.value",
].join("\n");

/**
 * Non-ASCII identifiers: a precomposed Latin class name and CJK names in
 * class/def position.
 */
const UnicodeIdentifiersText: string = [
    "class Café:",
    "    def 方法(self):",
    '        return "值"',
    "",
    "def _héllo():",
    "    pass",
    "",
    "def 全角():",
    "    pass",
    "",
    "class 数据:",
    "    pass",
].join("\n");

/**
 * ASCII declarations with CJK docstring and string values, so UTF-8 byte
 * accounting can be asserted independently of identifier support.
 */
const CjkText: string = ["class Account:", '    """账户。"""', '    label = "账户余额"', "    def balance(self):", '        return "余额"'].join("\n");

/**
 * CRLF source with a property and a method.
 */
const CrlfLines: string[] = ["class Windows:", "    value: int = 1", "    def method(self):", "        return self.value"];
const CrlfText: string = `${CrlfLines.join("\r\n")}\r\n`;

/**
 * Source without a BOM; the fixture is written with a UTF-8 BOM prefix.
 */
const BomText: string = ["class Bom:", "    def m(self):", "        pass", ""].join("\n");

/**
 * Source without a BOM; the fixture is written as UTF-16LE with a BOM.
 */
const Utf16Text: string = ["class Wide16:", "    def m(self):", "        pass", ""].join("\n");

/**
 * Comment-only source: comments are masked, so there is nothing to outline.
 */
const CommentsOnlyText: string = "# just a comment\n# class Ghost:\n    # def hidden():\n";

/**
 * Consistent two-space indentation.
 */
const TwoSpaceText: string = ["class Two:", "  def method(self):", "    if True:", "      return 1"].join("\n");

/**
 * Tab indentation; a tab counts as four columns in the indentation scanner.
 */
const TabsText: string = ["class Tabbed:", "\tdef toggle(self):", "\t\treturn 1", "\tdef other(self):", "\t\treturn 2"].join("\n");

/**
 * Invalid dedent: `nested` is indented one column more than its sibling, so it
 * is treated as a nested function of `method` instead of a method of `Sloppy`.
 */
const InvalidIndentText: string = ["class Sloppy:", "    def method(self):", "        pass", "     def nested(self):", "        pass"].join("\n");

/**
 * Class header split over four lines.
 */
const MultilineClassText: string = ["class LongName(", "    BaseA,", "    BaseB,", "):", "    def method(self):", "        return 1"].join("\n");

/**
 * Function header split over four lines with a nested function body.
 */
const MultilineDefText: string = ["def outer(", "    alpha,", "    beta,", "):", "    def inner():", "        pass", "    return alpha"].join("\n");

/**
 * Module-level assignment forms: plain, comparison, augmented, unpacking,
 * annotation-only, underscore-prefixed and non-ASCII target.
 */
const GlobalFormsText: string = ["x = 1", "x == 2", "count += 1", "a, b = 1, 2", "MAX: int", "_private = 1", "名字 = 1"].join("\n");

/**
 * Annotation-only module and class attributes next to assigned ones.
 */
const AnnotatedText: string = ["MAX_RETRIES: int = 3", "fallback: str", "", "class Config:", "    host: str", "    port: int = 8080"].join("\n");

/**
 * Unterminated triple-quoted string: the masker runs to EOF by design.
 */
const UnterminatedText: string = ["class A:", '    """never closed', "    def hidden(self):", "        pass"].join("\n");

/**
 * A class with three methods and a sibling class, for the node budget.
 */
const ManyText: string = [
    "class Alpha:",
    "    def a(self):",
    "        pass",
    "    def b(self):",
    "        pass",
    "    def c(self):",
    "        pass",
    "class Beta:",
    "    pass",
].join("\n");

/**
 * Twenty nested functions: the default depth ceiling is 8 and the hard ceiling
 * is 16.
 */
const DeepLines: string[] = [];
for (let index: number = 0; index < 20; index += 1) {
    DeepLines.push(`${"    ".repeat(index)}def f${index}():`);
}
DeepLines.push(`${"    ".repeat(20)}pass`);
const DeepText: string = DeepLines.join("\n");

/**
 * 3002 lines: `Early` is inside the 3000-line structure scan, `Late` is on
 * line 3001 and must therefore be absent from the outline.
 */
const ScanLimitLines: string[] = ["class Early:", "    pass"];
for (let index: number = 0; index < 2998; index += 1) {
    ScanLimitLines.push(`# filler ${index}`);
}
ScanLimitLines.push("class Late:", "    pass");
const ScanLimitText: string = ScanLimitLines.join("\n");

/**
 * Type stub content; `.pyi` selects the same Python strategy as `.py`.
 */
const StubText: string = ["class Stub:", "    def method(self) -> int: ..."].join("\n");

/**
 * GUI entry point for `.pyw` selection.
 */
const GuiText: string = ["def main():", "    pass"].join("\n");

/**
 * Assignment target shapes: tuple/starred targets bind names, while attribute,
 * subscript and local targets bind nothing at module/class scope.
 */
const TargetsText: string = [
    "shared, cached = 1, 2",
    "obj.attr = 3",
    "items[0] = 4",
    "first, *rest = [5, 6]",
    "_private = 7",
    '__all__ = ["shared"]',
    "",
    "class Registry:",
    "    total: int",
    "    count = 0",
    "    def touch(self):",
    "        self.local = 1",
    "        items = [1, 2]",
    "        return items",
].join("\n");

/**
 * Multi-line decorator, class header, method header and function call, all
 * with continuation lines that used to be scanned as normal lines.
 */
const BracketText: string = [
    "@decorator(",
    "    option=True,",
    ")",
    "class Bracket:",
    "    def method(",
    "        self,",
    "        value: int = 0,",
    "    ) -> int:",
    "        return value",
    "",
    "",
    "def caller():",
    "    result = build(",
    "        alpha=1,",
    "        beta=2,",
    "    )",
    "    return result",
].join("\n");

fixture("python/two_classes.py", TwoClassesText);
fixture("python/decorators.py", DecoratorsText);
fixture("python/module_scope.py", ModuleScopeText);
fixture("python/docstrings.py", DocstringsText);
fixture("python/unicode_identifiers.py", UnicodeIdentifiersText);
fixture("python/cjk_bytes.py", CjkText);
fixture("python/crlf.py", CrlfText);
fixture("python/bom.py", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomText, "utf8")]));
fixture("python/utf16.py", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(Utf16Text, "utf16le")]));
fixture("python/empty.py", "");
fixture("python/comments_only.py", CommentsOnlyText);
fixture("python/two_space.py", TwoSpaceText);
fixture("python/tabs.py", TabsText);
fixture("python/invalid_indent.py", InvalidIndentText);
fixture("python/multiline_class.py", MultilineClassText);
fixture("python/multiline_def.py", MultilineDefText);
fixture("python/global_forms.py", GlobalFormsText);
fixture("python/annotated.py", AnnotatedText);
fixture("python/unterminated.py", UnterminatedText);
fixture("python/many.py", ManyText);
fixture("python/deep.py", DeepText);
fixture("python/scan_limit.py", ScanLimitText);
fixture("python/stub.pyi", StubText);
fixture("python/gui.pyw", GuiText);
fixture("python/targets.py", TargetsText);
fixture("python/bracket.py", BracketText);
fixture("python/blob.py", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("python/huge.py", Buffer.alloc(4 * 1024 * 1024 + 1, 35));

test("Python: one file with two classes keeps class properties and methods at the right depth, path and range", (): void => {
    const result: OutlineResult = outline("python/two_classes.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.category, "code");
    assert.equal(result.language, "python");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.path, "python/two_classes.py");
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "python/two_classes.py");
    assert.equal(anchor.label, "two_classes.py");
    assert.equal(anchor.depth, 0);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(TwoClassesText, "utf8")));
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), totalLinesOf(TwoClassesText));
    assert.deepEqual(labels(anchor.children), ["Alpha", "Beta"]);
    const alpha: OutlineNode = requireNode(result.nodes, "Alpha");
    assert.equal(alpha.type, "class");
    assert.equal(alpha.depth, 1);
    assert.equal(alpha.path, "python/two_classes.py#Alpha");
    assert.equal(alpha.detail, "class Alpha:");
    assertRange(alpha, TwoClassesText, 1, 5);
    const beta: OutlineNode = requireNode(result.nodes, "Beta");
    assert.equal(beta.type, "class");
    assert.equal(beta.depth, 1);
    assert.equal(beta.path, "python/two_classes.py#Beta");
    assertRange(beta, TwoClassesText, 8, 9);
    assert.deepEqual(labels(alpha.children), ["x", "run"]);
    const x: OutlineNode = requireNode(alpha.children, "x");
    assert.equal(x.type, "property");
    assert.equal(x.depth, 2);
    assert.equal(x.path, "python/two_classes.py#Alpha.x");
    assert.equal(x.detail, "x: int = 1");
    assertRange(x, TwoClassesText, 2, 2);
    const run: OutlineNode = requireNode(alpha.children, "run");
    assert.equal(run.type, "method");
    assert.equal(run.depth, 2);
    assert.equal(run.path, "python/two_classes.py#Alpha.run");
    assert.equal(run.detail, "def run(self):");
    assertRange(run, TwoClassesText, 4, 5);
    assert.deepEqual(labels(beta.children), ["y"]);
    const y: OutlineNode = requireNode(beta.children, "y");
    assert.equal(y.type, "property");
    assert.equal(y.depth, 2);
    assert.equal(y.detail, "y = 2");
    assertRange(y, TwoClassesText, 9, 9);
    assert.equal(findNode(alpha.children, "y"), undefined);
});

test("Python: @staticmethod, @classmethod, @property and stacked decorators do not break the class hierarchy", (): void => {
    const result: OutlineResult = outline("python/decorators.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["helper", "Service"]);
    const helper: OutlineNode = requireNode(result.nodes, "helper");
    assert.equal(helper.type, "function");
    assert.equal(helper.depth, 1);
    assert.equal(helper.path, "python/decorators.py#helper");
    assert.equal(Number(helper.range.startLine), lineOf(DecoratorsText, "def helper():"));
    assert.equal(Number(helper.range.endLine), lineOf(DecoratorsText, "return 1"));
    assert.equal(helper.children.length, 0);
    const service: OutlineNode = requireNode(result.nodes, "Service");
    assert.equal(service.type, "class");
    assert.equal(service.depth, 1);
    assert.equal(service.path, "python/decorators.py#Service");
    assert.equal(Number(service.range.startLine), lineOf(DecoratorsText, "class Service:"));
    assert.equal(Number(service.range.endLine), lineOf(DecoratorsText, 'return "service"'));
    assert.deepEqual(labels(service.children), ["retries", "make", "build", "name"]);
    const retries: OutlineNode = requireNode(service.children, "retries");
    assert.equal(retries.type, "property");
    assert.equal(retries.depth, 2);
    assert.equal(retries.detail, "retries: int = 3");
    assertRange(retries, DecoratorsText, lineOf(DecoratorsText, "retries: int = 3"), lineOf(DecoratorsText, "retries: int = 3"));
    const make: OutlineNode = requireNode(service.children, "make");
    assert.equal(make.type, "method");
    assert.equal(make.depth, 2);
    assert.equal(make.path, "python/decorators.py#Service.make");
    assert.equal(Number(make.range.startLine), lineOf(DecoratorsText, "def make():"));
    assert.equal(Number(make.range.endLine), lineOf(DecoratorsText, "return Service()"));
    const build: OutlineNode = requireNode(service.children, "build");
    assert.equal(build.type, "method");
    assert.equal(build.depth, 2);
    assert.equal(build.path, "python/decorators.py#Service.build");
    assert.equal(Number(build.range.startLine), lineOf(DecoratorsText, "def build(cls):"));
    assert.equal(Number(build.range.endLine), lineOf(DecoratorsText, "return cls()"));
    const name: OutlineNode = requireNode(service.children, "name");
    assert.equal(name.type, "method");
    assert.equal(name.depth, 2);
    assert.equal(name.path, "python/decorators.py#Service.name");
    assert.equal(Number(name.range.startLine), lineOf(DecoratorsText, "def name(self):"));
    assert.equal(Number(name.range.endLine), lineOf(DecoratorsText, 'return "service"'));
    assert.equal(findNode(result.nodes, "@staticmethod"), undefined);
    assert.equal(findNode(result.nodes, "@property"), undefined);
    assert.equal(findNode(result.nodes, "decorate"), undefined);
    assert.equal(findNode(result.nodes, "retry"), undefined);
    assert.equal(findNode(result.nodes, "cached"), undefined);
    assert.equal(findNode(result.nodes, "staticmethod"), undefined);
    assert.equal(findNode(result.nodes, "classmethod"), undefined);
    assert.equal(findNode(result.nodes, "property"), undefined);
    assert.ok(flatten(result.nodes).every((node: OutlineNode): boolean => !node.label.startsWith("@")));
    assertTreeInvariants(result, DecoratorsText);
});

test("Python: globals, constants, async def, global def and nested function/class are all reported", (): void => {
    const result: OutlineResult = outline("python/module_scope.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["MAX_CONNECTIONS", "timeout", "fetch", "outer", "Global"]);
    const maximum: OutlineNode = requireNode(result.nodes, "MAX_CONNECTIONS");
    assert.equal(maximum.type, "constant");
    assert.equal(maximum.depth, 1);
    assert.equal(maximum.detail, "MAX_CONNECTIONS = 100");
    assertRange(maximum, ModuleScopeText, 1, 1);
    const timeout: OutlineNode = requireNode(result.nodes, "timeout");
    assert.equal(timeout.type, "variable");
    assert.equal(timeout.detail, "timeout = 30");
    assertRange(timeout, ModuleScopeText, 2, 2);
    const fetch: OutlineNode = requireNode(result.nodes, "fetch");
    assert.equal(fetch.type, "function");
    assert.equal(fetch.depth, 1);
    assert.equal(fetch.detail, "async def fetch(url):");
    assert.equal(fetch.path, "python/module_scope.py#fetch");
    assertRange(fetch, ModuleScopeText, 4, 5);
    const outer: OutlineNode = requireNode(result.nodes, "outer");
    assert.equal(outer.type, "function");
    assert.equal(outer.depth, 1);
    assertRange(outer, ModuleScopeText, 8, 18);
    assert.deepEqual(labels(outer.children), ["inner", "Local"]);
    const inner: OutlineNode = requireNode(outer.children, "inner");
    assert.equal(inner.type, "function");
    assert.equal(inner.depth, 2);
    assert.equal(inner.path, "python/module_scope.py#outer.inner");
    assertRange(inner, ModuleScopeText, 9, 10);
    const local: OutlineNode = requireNode(outer.children, "Local");
    assert.equal(local.type, "class");
    assert.equal(local.depth, 2);
    assert.equal(local.path, "python/module_scope.py#outer.Local");
    assertRange(local, ModuleScopeText, 12, 16);
    assert.deepEqual(labels(local.children), ["value", "local_method"]);
    const value: OutlineNode = requireNode(local.children, "value");
    assert.equal(value.type, "property");
    assert.equal(value.depth, 3);
    assertRange(value, ModuleScopeText, 13, 13);
    const localMethod: OutlineNode = requireNode(local.children, "local_method");
    assert.equal(localMethod.type, "method");
    assert.equal(localMethod.depth, 3);
    assert.equal(localMethod.path, "python/module_scope.py#outer.Local.local_method");
    assertRange(localMethod, ModuleScopeText, 15, 16);
    const globalClass: OutlineNode = requireNode(result.nodes, "Global");
    assert.equal(globalClass.type, "class");
    assert.equal(globalClass.depth, 1);
    assert.deepEqual(globalClass.children, []);
    assertRange(globalClass, ModuleScopeText, 21, 22);
    assert.equal(findNode(result.nodes, "url"), undefined);
    assert.equal(findNode(result.nodes, "self"), undefined);
    assertTreeInvariants(result, ModuleScopeText);
});

test("Python: pseudo declarations inside docstrings, strings and comments produce no nodes", (): void => {
    const result: OutlineResult = outline("python/docstrings.py");
    assert.equal(result.strategy, "python");
    assert.deepEqual(labels(result.nodes[0].children), ["real", "Holder"]);
    const real: OutlineNode = requireNode(result.nodes, "real");
    assert.equal(real.type, "function");
    assert.equal(real.depth, 1);
    assert.equal(real.detail, "def real() -> str:");
    assertRange(real, DocstringsText, 9, 17);
    assert.deepEqual(real.children, []);
    const holder: OutlineNode = requireNode(result.nodes, "Holder");
    assert.equal(holder.type, "class");
    assert.equal(holder.depth, 1);
    assertRange(holder, DocstringsText, 20, 27);
    assert.deepEqual(labels(holder.children), ["value", "method"]);
    const value: OutlineNode = requireNode(holder.children, "value");
    assert.equal(value.type, "property");
    assert.equal(value.detail, "value = 1");
    assertRange(value, DocstringsText, 23, 23);
    const method: OutlineNode = requireNode(holder.children, "method");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assert.equal(method.detail, "def method(self):");
    assertRange(method, DocstringsText, 25, 27);
    const pseudo: string[] = ["Ghost", "hidden", "also_hidden", "fake", "Commented", "TripleGhost", "Inner", "text"];
    for (let index: number = 0; index < pseudo.length; index += 1) {
        assert.equal(findNode(result.nodes, pseudo[index]), undefined, `pseudo declaration leaked: ${pseudo[index]}`);
    }
    assert.equal(flatten(result.nodes).length, 5);
});

test("Python: non-ASCII identifiers are outlined with their full names", (): void => {
    const result: OutlineResult = outline("python/unicode_identifiers.py");
    assert.equal(result.strategy, "python");
    assert.deepEqual(labels(result.nodes[0].children), ["Café", "_héllo", "全角", "数据"]);
    const accented: OutlineNode = requireNode(result.nodes, "Café");
    assert.equal(accented.type, "class");
    assert.equal(accented.depth, 1);
    assert.equal(accented.path, "python/unicode_identifiers.py#Café");
    assert.equal(accented.detail, "class Café:");
    assertRange(accented, UnicodeIdentifiersText, 1, 3);
    assert.deepEqual(labels(accented.children), ["方法"]);
    const method: OutlineNode = requireNode(accented.children, "方法");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assert.equal(method.path, "python/unicode_identifiers.py#Café.方法");
    assertRange(method, UnicodeIdentifiersText, 2, 3);
    const accentedHelper: OutlineNode = requireNode(result.nodes, "_héllo");
    assert.equal(accentedHelper.type, "function");
    assert.equal(accentedHelper.depth, 1);
    assert.equal(accentedHelper.path, "python/unicode_identifiers.py#_héllo");
    assertRange(accentedHelper, UnicodeIdentifiersText, 5, 6);
    const cjkFunction: OutlineNode = requireNode(result.nodes, "全角");
    assert.equal(cjkFunction.type, "function");
    assert.equal(cjkFunction.path, "python/unicode_identifiers.py#全角");
    assertRange(cjkFunction, UnicodeIdentifiersText, 8, 9);
    const cjkClass: OutlineNode = requireNode(result.nodes, "数据");
    assert.equal(cjkClass.type, "class");
    assert.equal(cjkClass.path, "python/unicode_identifiers.py#数据");
    assertRange(cjkClass, UnicodeIdentifiersText, 11, 12);
    assert.equal(findNode(result.nodes, "Caf"), undefined);
    assertTreeInvariants(result, UnicodeIdentifiersText);
});

test("Python: CJK docstrings and string values keep UTF-8 byte ranges exact and detail keeps the raw string", (): void => {
    const result: OutlineResult = outline("python/cjk_bytes.py");
    assert.equal(result.charset, "utf-8");
    const account: OutlineNode = requireNode(result.nodes, "Account");
    assert.equal(account.type, "class");
    assert.equal(account.depth, 1);
    assertRange(account, CjkText, 1, 5);
    assert.equal(account.range.endByte, BigInt(Buffer.byteLength(CjkText, "utf8")));
    assert.ok(account.range.endByte > BigInt(CjkText.length), "CJK text has more UTF-8 bytes than UTF-16 code units");
    const label: OutlineNode = requireNode(account.children, "label");
    assert.equal(label.type, "property");
    assert.equal(label.depth, 2);
    assertRange(label, CjkText, 3, 3);
    assert.equal(label.range.startByte, startByteOf(CjkText, 3));
    /**
     * Detail comes from the raw line, so the string value stays visible while
     * the masked line is still what decides the structure.
     */
    assert.equal(label.detail, 'label = "账户余额"');
    const balance: OutlineNode = requireNode(account.children, "balance");
    assert.equal(balance.type, "method");
    assert.equal(balance.depth, 2);
    assert.equal(balance.detail, "def balance(self):");
    assertRange(balance, CjkText, 4, 5);
    assertTreeInvariants(result, CjkText);
});

test("Python: CRLF sources parse with the same hierarchy and byte-accurate ranges", (): void => {
    const result: OutlineResult = outline("python/crlf.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["Windows"]);
    const windows: OutlineNode = requireNode(result.nodes, "Windows");
    assert.equal(windows.type, "class");
    assert.equal(windows.depth, 1);
    assert.equal(windows.detail, "class Windows:");
    assertRange(windows, CrlfText, 1, 4);
    assert.equal(windows.range.endByte, BigInt(Buffer.byteLength(CrlfText, "utf8")));
    assert.deepEqual(labels(windows.children), ["value", "method"]);
    const value: OutlineNode = requireNode(windows.children, "value");
    assert.equal(value.type, "property");
    assert.equal(value.detail, "value: int = 1");
    assertRange(value, CrlfText, 2, 2);
    const method: OutlineNode = requireNode(windows.children, "method");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assert.equal(method.detail, "def method(self):");
    assert.ok(!method.detail!.includes("\r"));
    assertRange(method, CrlfText, 3, 4);
    assertTreeInvariants(result, CrlfText);
});

test("Python: a UTF-8 BOM is bridged to raw-file byte offsets", (): void => {
    const result: OutlineResult = outline("python/bom.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.truncated, false);
    assert.deepEqual(labels(result.nodes[0].children), ["Bom"]);
    const anchor: OutlineNode = result.nodes[0];
    const fileBytes: bigint = BigInt(Buffer.byteLength(BomText, "utf8") + 3);
    assert.equal(anchor.file!.bytes, fileBytes);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, fileBytes);
    assert.equal(Number(anchor.range.endLine), 3);
    const bom: OutlineNode = requireNode(result.nodes, "Bom");
    assert.equal(bom.type, "class");
    assert.equal(bom.depth, 1);
    assert.equal(bom.label, "Bom");
    assert.equal(bom.detail, "class Bom:");
    assert.equal(Number(bom.range.startLine), 1);
    assert.equal(Number(bom.range.endLine), 3);
    /**
     * The three BOM bytes are part of the file, so symbol offsets start after
     * them and the anchor end matches `file.bytes` exactly.
     */
    assert.equal(bom.range.startByte, 3n);
    assert.equal(bom.range.endByte, fileBytes);
    const method: OutlineNode = requireNode(bom.children, "m");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assert.equal(Number(method.range.startLine), 2);
    assert.equal(Number(method.range.endLine), 3);
    assert.equal(method.range.startByte, 14n);
    assert.equal(method.range.endByte, fileBytes);
    assert.equal(anchor.range.endByte, anchor.file!.bytes);
});

test("Python KNOWN L-02: a UTF-16LE BOM file is decoded and outlined, but ranges measure decoded UTF-8 text", (): void => {
    const result: OutlineResult = outline("python/utf16.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.charset, "utf-16le");
    assert.deepEqual(labels(result.nodes[0].children), ["Wide16"]);
    const wide: OutlineNode = requireNode(result.nodes, "Wide16");
    assert.equal(wide.type, "class");
    assert.equal(wide.depth, 1);
    assertRange(wide, Utf16Text, 1, 3);
    const method: OutlineNode = requireNode(wide.children, "m");
    assert.equal(method.type, "method");
    assertRange(method, Utf16Text, 2, 3);
    /**
     * KNOWN L-02: the on-disk file is 90 bytes; the outline reports 44 bytes
     * because the range is measured on the decoded Unicode text encoded as
     * UTF-8, not on the original UTF-16 bytes.
     */
    assert.equal(result.nodes[0].file!.bytes, 90n);
    assert.equal(result.nodes[0].range.endByte, BigInt(Buffer.byteLength(Utf16Text, "utf8")));
    assert.ok(result.nodes[0].range.endByte < result.nodes[0].file!.bytes);
});

test("Python: empty and comment-only files produce an anchor with no symbols", (): void => {
    const empty: OutlineResult = outline("python/empty.py");
    assert.equal(empty.strategy, "python");
    assert.equal(empty.language, "python");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes.length, 1);
    assert.equal(flatten(empty.nodes).length, 1);
    assert.equal(empty.nodes[0].isFile, true);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(empty.nodes[0].range.startLine, 1n);
    assert.equal(empty.nodes[0].range.endLine, 1n);
    assert.deepEqual(empty.nodes[0].children, []);
    const comments: OutlineResult = outline("python/comments_only.py");
    assert.equal(comments.charset, "utf-8");
    assert.equal(comments.truncated, false);
    assert.equal(flatten(comments.nodes).length, 1);
    assert.equal(comments.nodes[0].range.endByte, BigInt(Buffer.byteLength(CommentsOnlyText, "utf8")));
    assert.equal(findNode(comments.nodes, "Ghost"), undefined);
    assert.equal(findNode(comments.nodes, "hidden"), undefined);
});

test("Python: two-space and tab indentation both nest methods under their class", (): void => {
    const twoSpace: OutlineResult = outline("python/two_space.py");
    assert.equal(twoSpace.strategy, "python");
    assert.deepEqual(labels(twoSpace.nodes[0].children), ["Two"]);
    const two: OutlineNode = requireNode(twoSpace.nodes, "Two");
    assert.equal(two.type, "class");
    assert.equal(two.depth, 1);
    assertRange(two, TwoSpaceText, 1, 4);
    assert.deepEqual(labels(two.children), ["method"]);
    const twoMethod: OutlineNode = requireNode(two.children, "method");
    assert.equal(twoMethod.type, "method");
    assert.equal(twoMethod.depth, 2);
    assertRange(twoMethod, TwoSpaceText, 2, 4);
    const tabs: OutlineResult = outline("python/tabs.py");
    assert.deepEqual(labels(tabs.nodes[0].children), ["Tabbed"]);
    const tabbed: OutlineNode = requireNode(tabs.nodes, "Tabbed");
    assert.equal(tabbed.type, "class");
    assert.deepEqual(labels(tabbed.children), ["toggle", "other"]);
    const toggle: OutlineNode = requireNode(tabbed.children, "toggle");
    assert.equal(toggle.type, "method");
    assert.equal(toggle.depth, 2);
    assertRange(toggle, TabsText, 2, 3);
    const other: OutlineNode = requireNode(tabbed.children, "other");
    assert.equal(other.type, "method");
    assertRange(other, TabsText, 4, 5);
    assertTreeInvariants(twoSpace, TwoSpaceText);
    assertTreeInvariants(tabs, TabsText);
});

test("Python KNOWN L-04: an invalid dedent nests a method as a function instead of reporting a diagnostic", (): void => {
    const result: OutlineResult = outline("python/invalid_indent.py");
    assert.equal(result.truncated, false);
    const sloppy: OutlineNode = requireNode(result.nodes, "Sloppy");
    assert.equal(sloppy.type, "class");
    assert.equal(sloppy.depth, 1);
    assertRange(sloppy, InvalidIndentText, 1, 5);
    assert.deepEqual(labels(sloppy.children), ["method"]);
    const method: OutlineNode = requireNode(sloppy.children, "method");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assertRange(method, InvalidIndentText, 2, 5);
    /**
     * KNOWN L-04: Python rejects this indentation; the outline builder is
     * deliberately tolerant and applies the indentation stack literally, so
     * `nested` (indent 5) becomes a child of `method` (indent 4) and its kind
     * is `function`, not `method`.
     */
    assert.deepEqual(labels(method.children), ["nested"]);
    const nested: OutlineNode = requireNode(method.children, "nested");
    assert.equal(nested.type, "function");
    assert.equal(nested.depth, 3);
    assert.equal(nested.path, "python/invalid_indent.py#Sloppy.method.nested");
});

test("Python: a multi-line class/def header keeps its body attached", (): void => {
    const classResult: OutlineResult = outline("python/multiline_class.py");
    assert.equal(classResult.truncated, false);
    assert.deepEqual(labels(classResult.nodes[0].children), ["LongName"]);
    const longName: OutlineNode = requireNode(classResult.nodes, "LongName");
    assert.equal(longName.type, "class");
    assert.equal(longName.depth, 1);
    assert.equal(longName.detail, "class LongName(");
    assertRange(longName, MultilineClassText, 1, 6);
    assert.deepEqual(labels(longName.children), ["method"]);
    const method: OutlineNode = requireNode(longName.children, "method");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assert.equal(method.path, "python/multiline_class.py#LongName.method");
    assertRange(method, MultilineClassText, 5, 6);
    assertTreeInvariants(classResult, MultilineClassText);
    const defResult: OutlineResult = outline("python/multiline_def.py");
    assert.deepEqual(labels(defResult.nodes[0].children), ["outer"]);
    const outer: OutlineNode = requireNode(defResult.nodes, "outer");
    assert.equal(outer.type, "function");
    assert.equal(outer.depth, 1);
    assertRange(outer, MultilineDefText, 1, 7);
    assert.deepEqual(labels(outer.children), ["inner"]);
    const inner: OutlineNode = requireNode(outer.children, "inner");
    assert.equal(inner.type, "function");
    assert.equal(inner.depth, 2);
    assert.equal(inner.path, "python/multiline_def.py#outer.inner");
    assertRange(inner, MultilineDefText, 5, 6);
    assertTreeInvariants(defResult, MultilineDefText);
});

test("Python: module assignment forms cover plain, augmented, tuple and annotation-only targets", (): void => {
    const result: OutlineResult = outline("python/global_forms.py");
    assert.equal(result.strategy, "python");
    assert.deepEqual(labels(result.nodes[0].children), ["x", "count", "a", "b", "MAX", "_private", "名字"]);
    const symbols: readonly OutlineNode[] = result.nodes[0].children;
    assert.deepEqual(
        symbols.map((node: OutlineNode): string => `${node.type}`),
        ["variable", "variable", "variable", "variable", "constant", "variable", "variable"],
    );
    assert.deepEqual(
        symbols.map((node: OutlineNode): number => Number(node.range.startLine)),
        [1, 3, 4, 4, 5, 6, 7],
    );
    assert.equal(symbols[0].detail, "x = 1");
    assert.equal(symbols[1].detail, "count += 1");
    assert.equal(symbols[2].detail, "a, b = 1, 2");
    assert.equal(symbols[3].detail, "a, b = 1, 2");
    assert.equal(symbols[4].detail, "MAX: int");
    assert.equal(symbols[5].detail, "_private = 1");
    assert.equal(symbols[6].detail, "名字 = 1");
    assert.equal(symbols[2].path, "python/global_forms.py#a");
    assert.equal(symbols[3].path, "python/global_forms.py#b");
    assertRange(symbols[1], GlobalFormsText, 3, 3);
    assertRange(symbols[4], GlobalFormsText, 5, 5);
    assertRange(symbols[6], GlobalFormsText, 7, 7);
    assert.equal(flatten(result.nodes).filter((node: OutlineNode): boolean => node.label === "x").length, 1);
    assertTreeInvariants(result, GlobalFormsText);
});

test("Python: annotation-only module and class attributes are outlined", (): void => {
    const result: OutlineResult = outline("python/annotated.py");
    assert.deepEqual(labels(result.nodes[0].children), ["MAX_RETRIES", "fallback", "Config"]);
    const maximum: OutlineNode = requireNode(result.nodes, "MAX_RETRIES");
    assert.equal(maximum.type, "constant");
    assert.equal(maximum.detail, "MAX_RETRIES: int = 3");
    assertRange(maximum, AnnotatedText, 1, 1);
    const fallback: OutlineNode = requireNode(result.nodes, "fallback");
    assert.equal(fallback.type, "variable");
    assert.equal(fallback.detail, "fallback: str");
    assertRange(fallback, AnnotatedText, 2, 2);
    const config: OutlineNode = requireNode(result.nodes, "Config");
    assert.equal(config.type, "class");
    assert.equal(config.depth, 1);
    assertRange(config, AnnotatedText, 4, 6);
    assert.deepEqual(labels(config.children), ["host", "port"]);
    const host: OutlineNode = requireNode(config.children, "host");
    assert.equal(host.type, "property");
    assert.equal(host.depth, 2);
    assert.equal(host.detail, "host: str");
    assertRange(host, AnnotatedText, 5, 5);
    const port: OutlineNode = requireNode(config.children, "port");
    assert.equal(port.type, "property");
    assert.equal(port.detail, "port: int = 8080");
    assertRange(port, AnnotatedText, 6, 6);
    assertTreeInvariants(result, AnnotatedText);
});

test("Python KNOWN L-03: an unterminated triple-quoted string silently masks the rest of the file", (): void => {
    const result: OutlineResult = outline("python/unterminated.py");
    assert.equal(result.charset, "utf-8");
    const partial: OutlineNode = requireNode(result.nodes, "A");
    assert.equal(partial.type, "class");
    assert.equal(partial.depth, 1);
    /**
     * KNOWN L-03: masking is documented as tolerant, but the loss is only
     * visible through the missing symbol: `truncated` is false because the
     * scan ceiling was not hit.
     */
    assertRange(partial, UnterminatedText, 1, 1);
    assert.equal(partial.children.length, 0);
    assert.equal(findNode(result.nodes, "hidden"), undefined);
    assert.equal(result.truncated, false);
    assert.equal(flatten(result.nodes).length, 2);
});

test("Python: maxNodes is a hard, explicitly reported node budget that includes the anchor", (): void => {
    const full: OutlineResult = outline("python/many.py");
    assert.equal(full.truncated, false);
    assert.deepEqual(labels(full.nodes[0].children), ["Alpha", "Beta"]);
    const alpha: OutlineNode = requireNode(full.nodes, "Alpha");
    assert.deepEqual(labels(alpha.children), ["a", "b", "c"]);
    assert.equal(flatten(full.nodes).length, 6);
    const limited: OutlineResult = outline("python/many.py", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.equal(flatten(limited.nodes).length, 3);
    assert.deepEqual(
        flatten(limited.nodes).map((node: OutlineNode): string => node.label),
        ["many.py", "Alpha", "a"],
    );
    const limitedAlpha: OutlineNode = requireNode(limited.nodes, "Alpha");
    assert.deepEqual(labels(limitedAlpha.children), ["a"]);
    const anchorOnly: OutlineResult = outline("python/many.py", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.equal(flatten(anchorOnly.nodes).length, 1);
    assert.equal(anchorOnly.nodes[0].isFile, true);
    assert.deepEqual(anchorOnly.nodes[0].children, []);
});

test("Python: maxDepth truncates at the default and hard ceilings, and invalid bounds are rejected", (): void => {
    const full: OutlineResult = outline("python/deep.py");
    assert.equal(full.truncated, true);
    const kept: OutlineNode[] = flatten(full.nodes).filter((node: OutlineNode): boolean => !node.isFile);
    assert.equal(kept.length, 8);
    assert.deepEqual(
        kept.map((node: OutlineNode): string => node.label),
        ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"],
    );
    assert.equal(kept[7].depth, 8);
    assertRange(kept[0], DeepText, 1, 21);
    assert.equal(findNode(full.nodes, "f8"), undefined);
    const shallow: OutlineResult = outline("python/deep.py", { maxDepth: 4 });
    assert.equal(shallow.truncated, true);
    const shallowKept: OutlineNode[] = flatten(shallow.nodes).filter((node: OutlineNode): boolean => !node.isFile);
    assert.deepEqual(
        shallowKept.map((node: OutlineNode): string => node.label),
        ["f0", "f1", "f2", "f3"],
    );
    assert.deepEqual(shallowKept[3].children, []);
    assert.equal(findNode(shallow.nodes, "f4"), undefined);
    const clamped: OutlineResult = outline("python/deep.py", { maxDepth: 100 });
    assert.equal(clamped.truncated, true);
    const clampedKept: OutlineNode[] = flatten(clamped.nodes).filter((node: OutlineNode): boolean => !node.isFile);
    assert.equal(clampedKept.length, 16);
    assert.equal(requireNode(clamped.nodes, "f15").depth, 16);
    assert.equal(findNode(clamped.nodes, "f16"), undefined);
    expectFilesystemError("invalid_arguments", (): void => {
        outline("python/deep.py", { maxDepth: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("python/deep.py", { maxDepth: -1 });
    });
});

test("Python: the 3000-line structure scan truncates explicitly and skips later declarations", (): void => {
    const result: OutlineResult = outline("python/scan_limit.py");
    assert.equal(result.strategy, "python");
    assert.equal(result.truncated, true);
    assert.equal(Number(result.nodes[0].range.endLine), totalLinesOf(ScanLimitText));
    const early: OutlineNode = requireNode(result.nodes, "Early");
    assert.equal(early.type, "class");
    assert.equal(early.depth, 1);
    assertRange(early, ScanLimitText, 1, 2);
    /**
     * KNOWN L-05: `Late` starts on line 3001; the scan keeps only the first
     * 3000 lines, so the class is absent. `truncated: true` is the explicit
     * signal for the loss.
     */
    assert.equal(findNode(result.nodes, "Late"), undefined);
    assert.equal(flatten(result.nodes).length, 2);
});

test("Python: every node has bigint, ordered and parent-contained ranges aligned with its lines", (): void => {
    const cases: readonly FixtureCase[] = [
        { path: "python/two_classes.py", text: TwoClassesText },
        { path: "python/decorators.py", text: DecoratorsText },
        { path: "python/module_scope.py", text: ModuleScopeText },
    ];
    const symbolTypes: ReadonlySet<string> = new Set<string>(["class", "function", "method", "property", "variable", "constant"]);
    for (let index: number = 0; index < cases.length; index += 1) {
        const current: FixtureCase = cases[index];
        const result: OutlineResult = outline(current.path);
        assertTreeInvariants(result, current.text);
        const symbols: OutlineNode[] = flatten(result.nodes).filter((node: OutlineNode): boolean => !node.isFile);
        assert.ok(symbols.length > 0, `${current.path}: expected symbols`);
        for (let nodeIndex: number = 0; nodeIndex < symbols.length; nodeIndex += 1) {
            const node: OutlineNode = symbols[nodeIndex];
            assert.ok(symbolTypes.has(`${node.type}`), `${current.path}: unexpected symbol type ${node.type}`);
            assert.ok(node.path.startsWith(`${current.path}#`), `${current.path}: symbol path prefix`);
        }
    }
});

test("Python: binary, oversized, escaping and invalid requests fail with closed error codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("python/blob.py");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("python/huge.py");
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("python/two_classes.py", { maxNodes: 0 });
    });
    expectFilesystemError("not_found", (): void => {
        outline("python/missing.py");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.py");
    });
});

test("Python: .pyi and .pyw select the Python strategy like .py", (): void => {
    const stub: OutlineResult = outline("python/stub.pyi");
    assert.equal(stub.strategy, "python");
    assert.equal(stub.category, "code");
    assert.equal(stub.language, "python");
    const stubClass: OutlineNode = requireNode(stub.nodes, "Stub");
    assert.equal(stubClass.type, "class");
    assert.equal(stubClass.depth, 1);
    assert.deepEqual(labels(stubClass.children), ["method"]);
    const stubMethod: OutlineNode = requireNode(stubClass.children, "method");
    assert.equal(stubMethod.type, "method");
    assert.equal(stubMethod.depth, 2);
    assert.equal(stubMethod.detail, "def method(self) -> int: ...");
    assertRange(stubMethod, StubText, 2, 2);
    const gui: OutlineResult = outline("python/gui.pyw");
    assert.equal(gui.strategy, "python");
    assert.equal(gui.language, "python");
    const main: OutlineNode = requireNode(gui.nodes, "main");
    assert.equal(main.type, "function");
    assert.equal(main.depth, 1);
    assertRange(main, GuiText, 1, 2);
});

test("Python: attribute, subscript and local assignment targets bind no outline symbol", (): void => {
    const result: OutlineResult = outline("python/targets.py");
    assert.deepEqual(labels(result.nodes[0].children), ["shared", "cached", "first", "rest", "_private", "__all__", "Registry"]);
    const shared: OutlineNode = requireNode(result.nodes, "shared");
    assert.equal(shared.type, "variable");
    assert.equal(shared.path, "python/targets.py#shared");
    assertRange(shared, TargetsText, 1, 1);
    const cached: OutlineNode = requireNode(result.nodes, "cached");
    assert.equal(cached.type, "variable");
    assert.equal(cached.path, "python/targets.py#cached");
    assertRange(cached, TargetsText, 1, 1);
    assert.equal(requireNode(result.nodes, "first").type, "variable");
    assert.equal(requireNode(result.nodes, "rest").type, "variable");
    assert.equal(requireNode(result.nodes, "__all__").type, "variable");
    const registry: OutlineNode = requireNode(result.nodes, "Registry");
    assert.equal(registry.type, "class");
    assert.equal(registry.depth, 1);
    assertRange(registry, TargetsText, 8, 14);
    assert.deepEqual(labels(registry.children), ["total", "count", "touch"]);
    const total: OutlineNode = requireNode(registry.children, "total");
    assert.equal(total.type, "property");
    assert.equal(total.depth, 2);
    assert.equal(total.detail, "total: int");
    assertRange(total, TargetsText, 9, 9);
    const count: OutlineNode = requireNode(registry.children, "count");
    assert.equal(count.type, "property");
    assert.equal(count.detail, "count = 0");
    const touch: OutlineNode = requireNode(registry.children, "touch");
    assert.equal(touch.type, "method");
    assert.equal(touch.depth, 2);
    assertRange(touch, TargetsText, 11, 14);
    assert.equal(findNode(result.nodes, "obj"), undefined);
    assert.equal(findNode(result.nodes, "attr"), undefined);
    assert.equal(findNode(result.nodes, "items"), undefined);
    assert.equal(findNode(result.nodes, "local"), undefined);
    assertTreeInvariants(result, TargetsText);
});

test("Python: multi-line decorators, headers and calls keep the class tree attached", (): void => {
    const result: OutlineResult = outline("python/bracket.py");
    assert.deepEqual(labels(result.nodes[0].children), ["Bracket", "caller"]);
    const bracket: OutlineNode = requireNode(result.nodes, "Bracket");
    assert.equal(bracket.type, "class");
    assert.equal(bracket.depth, 1);
    assert.equal(bracket.detail, "class Bracket:");
    assertRange(bracket, BracketText, 4, 9);
    assert.deepEqual(labels(bracket.children), ["method"]);
    const method: OutlineNode = requireNode(bracket.children, "method");
    assert.equal(method.type, "method");
    assert.equal(method.depth, 2);
    assert.equal(method.detail, "def method(");
    assert.equal(method.path, "python/bracket.py#Bracket.method");
    assertRange(method, BracketText, 5, 9);
    const caller: OutlineNode = requireNode(result.nodes, "caller");
    assert.equal(caller.type, "function");
    assert.equal(caller.depth, 1);
    assertRange(caller, BracketText, 12, 17);
    const invisible: string[] = ["decorator", "option", "alpha", "beta", "result", "build"];
    for (let index: number = 0; index < invisible.length; index += 1) {
        assert.equal(findNode(result.nodes, invisible[index]), undefined, `continuation line leaked: ${invisible[index]}`);
    }
    assertTreeInvariants(result, BracketText);
});
