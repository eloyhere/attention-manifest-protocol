#!/usr/bin/env node
/**
 * Rust outline checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run; no fixture is compiled, executed or fetched. All assertions go
 * through the public `buildOutline` entry point, so sandbox resolution, the
 * charset gate, path anchoring, UTF-8 byte ranges, the node/depth budget and
 * the bounded 3000-line scan are exercised together with `parseRust` itself.
 *
 * The suite covers the declarations the strategy documents, the masking
 * boundaries (comments, strings, raw strings, character literals, lifetimes),
 * file-level edges (empty, use-only, CRLF, BOM, Unicode) and the fixed defect
 * boundaries: `static mut`, `[u8; N]` parameters, lifetimes, raw strings with
 * embedded quotes, generic/Allman/attributed declarations, `unsafe impl`,
 * `extern "C" fn`, impl labels, method kinds and items declared inside a
 * function body.
 *
 * Remaining design limits are asserted where they are observable: `detail` is
 * the masked declaration line, the structure scan stops at 3000 lines, and a
 * macro body is not expanded.
 *
 * Run with: node tools/rustOutlineCheck.ts
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

const Root: string = mkdtempSync(join(tmpdir(), "amp-rust-outline-"));
const RootSpec: SessionRoot = { id: "root.rustOutline", path: Root, writable: true, exclude: [] };
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
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

/**
 * Main Rust fixture: declarations, containers, impls, modules, modifiers,
 * generics, a `where` clause, struct/enum members and decoys inside a doc
 * comment and a string.
 */
const LibText: string = [
    "//! Crate docs mention struct Ghost { hidden: bool } and fn ghost() {}",
    "use std::fmt;",
    "",
    "pub const MAX_POINTS: usize = 64;",
    'static GREETING: &str = "fn fake() { }";',
    "pub(crate) type Pair = (u8, u8);",
    "",
    "macro_rules! twice {",
    "    ($x:expr) => { $x * 2 };",
    "}",
    "",
    "pub struct Point {",
    "    pub x: f64,",
    "    y: f64,",
    "}",
    "",
    "pub struct Inline { id: u32, label: String }",
    "pub struct Tuple(u32, u32);",
    "",
    "pub enum Shape {",
    "    Circle { radius: f64 },",
    "    Square(f64),",
    "}",
    "",
    "pub trait Area {",
    "    fn area(&self) -> f64;",
    "    fn label(&self) -> String {",
    '        String::from("shape")',
    "    }",
    "}",
    "",
    "impl Area for Point {",
    "    fn area(&self) -> f64 {",
    "        self.x * self.y",
    "    }",
    "}",
    "",
    "impl Point {",
    "    pub fn new(x: f64, y: f64) -> Self {",
    "        Self { x, y }",
    "    }",
    "    pub async fn fetch<T>(&self, key: &T) -> Option<T> where T: Clone {",
    "        None",
    "    }",
    "    pub unsafe fn danger(&self) -> u8 {",
    "        0",
    "    }",
    "}",
    "",
    "pub mod nested {",
    "    pub struct Inner { value: i32 }",
    "    pub fn helper() -> i32 { 1 }",
    "}",
].join("\n");

/**
 * Decoy fixture: comments, a doc comment, strings, a raw string and a char
 * literal that all contain declaration-shaped text.
 */
const DecoysText: string = [
    "// struct Commented { a: i32 }",
    "/* fn block_hidden() { } */",
    "/// Doc: impl Fake for Real, fn decoy() {}",
    'const NOTE: &str = "struct InString { b: i32 }";',
    'const RAW: &str = r#"fn raw_fake() { struct RawFake { c: u8 } }"#;',
    "const CHAR: char = '{';",
    'const QUOTED: &str = "fn quoted() { let x = \\"{}\\"; }";',
    "pub struct Real {",
    "    pub id: u8,",
    "}",
    "",
    "pub fn real() {}",
].join("\n");

/**
 * Raw string with an interior quote, which the C-style masker cannot pair but
 * the Rust raw-string scanner can.
 */
const RawQuoteText: string = [
    "pub struct Before { a: u8 }",
    'const DOC: &str = r#"say "hi"',
    'struct Leaked { x: u8 }"#;',
    "pub struct Tail { t: u8 }",
].join("\n");

/**
 * Lifetimes, whose apostrophes are not character-literal openers.
 */
const LifetimesText: string = [
    "pub struct Borrowed<'a> {",
    "    pub text: &'a str,",
    "}",
    "",
    "pub fn first<'a>(input: &'a str) -> &'a str {",
    "    input",
    "}",
    "",
    "pub fn after() -> u8 { 1 }",
].join("\n");

/**
 * Generic impl blocks, written `impl<T>` without a space after `impl`.
 */
const ImplGenericText: string = [
    "pub struct Wrap<T> { value: T }",
    "impl<T> Wrap<T> {",
    "    pub fn get(&self) -> &T { &self.value }",
    "}",
    "impl<T> Default for Wrap<T> {",
    "    fn default() -> Self { Wrap { value: Default::default() } }",
    "}",
    "pub fn after_impl() {}",
].join("\n");

/**
 * Function modifiers plus `unsafe impl` and an `extern "C"` function.
 */
const ModifiersText: string = [
    "pub async fn async_pub() {}",
    "pub unsafe fn unsafe_pub() {}",
    "pub const fn const_pub() {}",
    "async unsafe fn async_unsafe() {}",
    'pub extern "C" fn extern_c() {}',
    "unsafe impl Send for Marker {",
    "    fn send(&self) {}",
    "}",
    "pub trait Marker { }",
    "impl Marker for Thing { }",
    "pub struct Thing { id: u8 }",
].join("\n");

/**
 * Multi-line generics/`where` plus a parameter type containing `;`.
 */
const WhereText: string = [
    "pub fn spanning<T, U>(",
    "    left: T,",
    "    right: U,",
    ") -> (T, U)",
    "where",
    "    T: Clone,",
    "    U: Default,",
    "{",
    "    (left, right)",
    "}",
    "",
    "pub fn array_param(buf: [u8; 4]) -> usize {",
    "    buf.len()",
    "}",
    "",
    "pub fn after() -> u8 { 1 }",
].join("\n");

/**
 * Allman-brace declarations and an attribute sharing the declaration line.
 */
const StyleText: string = [
    "pub struct Allman",
    "{",
    "    value: u8,",
    "}",
    "",
    "pub trait AllmanTrait",
    "{",
    "    fn mark(&self);",
    "}",
    "",
    "impl Allman",
    "{",
    "    fn method(&self) {}",
    "}",
    "",
    "#[derive(Debug)] pub struct Decorated { a: u8 }",
    "#[inline] pub fn inlined() {}",
    "pub struct Kept { b: u8 }",
].join("\n");

/**
 * Nested modules and a test module behind `#[cfg(test)]`.
 */
const ModulesText: string = [
    "mod filesystem;",
    "pub mod net {",
    "    pub const PORT: u16 = 80;",
    "    pub fn listen() {}",
    "}",
    "#[cfg(test)]",
    "mod tests {",
    "    use super::*;",
    "    #[test]",
    "    fn works() {}",
    "}",
    "pub mod outer {",
    "    pub mod inner {",
    "        pub struct Deep { pub n: u8 }",
    "    }",
    "}",
].join("\n");

/**
 * Unicode in a comment and a string (must stay invisible) plus Unicode
 * identifiers (which are real Rust identifiers and must be reported).
 */
const UnicodeText: string = [
    "// 文档：struct 幽灵 { x: u8 }",
    'const NOTE: &str = "中文 fn 幽灵()";',
    "pub struct Ascii {",
    "    pub label: String,",
    "}",
    "pub fn 计算() -> u8 { 1 }",
    "pub fn after_unicode() -> u8 { 2 }",
].join("\n");

/**
 * `static mut`, whose real item name follows the `mut` keyword.
 */
const StaticsText: string = [
    "static mut COUNTER: u32 = 0;",
    "static READONLY: u8 = 1;",
    'pub static NAME_STR: &str = "x";',
].join("\n");

/**
 * Items declared inside a function body.
 */
const NestedFnText: string = [
    "pub fn holder() {",
    "    struct Hidden { a: u8 }",
    "    fn inner() {}",
    "}",
    "pub fn visible() {}",
].join("\n");

/**
 * Small tree used by the node/depth budget tests.
 */
const ManyText: string = [
    "pub struct A { a: u8, b: u8 }",
    "pub struct B { c: u8 }",
    "pub fn f1() {}",
    "pub fn f2() {}",
    "pub mod m {",
    "    pub struct Deep { d: u8 }",
    "    pub fn f3() {}",
    "}",
].join("\n");

const OnlyUseText: string = [
    "use std::fmt;",
    "use std::io::{self, Read};",
    "pub use crate::inner::Thing;",
].join("\n");

const CrlfText: string = ["pub struct Line {", "    pub value: u8,", "}", "", "pub fn tail() -> u8 {", "    1", "}"].join("\r\n") + "\r\n";

const BomText: string = ["pub struct Bom { pub flag: bool }", "pub fn go() -> bool { true }"].join("\n") + "\n";

const BomBytes: Uint8Array = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomText, "utf8")]);

/**
 * A file whose first declaration is inside the scan window and whose second is
 * past the 3000-line ceiling.
 */
const LongText: string = [
    "pub fn early() {}",
    ...Array.from({ length: 3000 }, (_value: unknown, index: number): string => `// filler ${index}`),
    "pub struct Late { a: u8 }",
].join("\n");

fixture("rust/lib.rs", LibText);
fixture("rust/decoys.rs", DecoysText);
fixture("rust/raw_quote.rs", RawQuoteText);
fixture("rust/lifetimes.rs", LifetimesText);
fixture("rust/impl_generic.rs", ImplGenericText);
fixture("rust/modifiers.rs", ModifiersText);
fixture("rust/where_clause.rs", WhereText);
fixture("rust/style.rs", StyleText);
fixture("rust/modules.rs", ModulesText);
fixture("rust/unicode.rs", UnicodeText);
fixture("rust/statics.rs", StaticsText);
fixture("rust/nested_in_fn.rs", NestedFnText);
fixture("rust/many.rs", ManyText);
fixture("rust/long.rs", LongText);
fixture("rust/empty.rs", "");
fixture("rust/only_use.rs", OnlyUseText);
fixture("rust/crlf.rs", CrlfText);
fixture("rust/bom.rs", BomBytes);
fixture("rust/blob.rs", new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0, 4, 5, 0, 0, 0, 0, 6, 7, 0, 0]));
fixture("rust/huge.rs", Buffer.alloc(4 * 1024 * 1024 + 1, 97));

test("Rust structs: multi-line, inline and tuple fields become property children", (): void => {
    const result: OutlineResult = outline("rust/lib.rs");
    assert.equal(result.strategy, "rust");
    assert.equal(result.category, "code");
    assert.equal(result.language, "rust");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.nodes.length, 1);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "rust/lib.rs");
    assert.equal(anchor.label, "lib.rs");
    assertRange(anchor, LibText, 1, 53);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(LibText, "utf8")));
    assert.equal(flatten(result.nodes).length, 30);

    const point: OutlineNode = requireNode(result.nodes, "Point");
    assert.equal(point.type, "struct");
    assert.equal(point.depth, 1);
    assert.equal(point.path, "rust/lib.rs#Point");
    assert.equal(point.detail, "pub struct Point {");
    assert.deepEqual(point.modifiers, ["pub"]);
    assertRange(point, LibText, 12, 15);
    assert.deepEqual(labels(point.children), ["x", "y"]);
    const x: OutlineNode = requireNode(point.children, "x");
    assert.equal(x.type, "property");
    assert.equal(x.depth, 2);
    assert.equal(x.path, "rust/lib.rs#Point.x");
    assert.equal(x.detail, "pub x: f64,");
    assert.deepEqual(x.modifiers, ["pub"]);
    assertRange(x, LibText, 13, 13);
    const y: OutlineNode = requireNode(point.children, "y");
    assert.equal(y.type, "property");
    assert.equal(y.depth, 2);
    assert.equal(y.detail, "y: f64,");
    assert.equal(y.modifiers, undefined);
    assertRange(y, LibText, 14, 14);

    const inline: OutlineNode = requireNode(result.nodes, "Inline");
    assert.equal(inline.type, "struct");
    assert.equal(inline.detail, "pub struct Inline { id: u32, label: String }");
    assert.deepEqual(labels(inline.children), ["id", "label"]);
    assertRange(inline, LibText, 17, 17);
    for (const field of inline.children) {
        assert.equal(field.type, "property");
        assert.equal(field.depth, 2);
        assertRange(field, LibText, 17, 17);
    }
    assert.equal(requireNode(inline.children, "id").detail, "id: u32");
    assert.equal(requireNode(inline.children, "label").detail, "label: String");

    const tuple: OutlineNode = requireNode(result.nodes, "Tuple");
    assert.equal(tuple.type, "struct");
    assert.equal(tuple.detail, "pub struct Tuple(u32, u32);");
    assert.deepEqual(labels(tuple.children), ["0", "1"]);
    assertRange(tuple, LibText, 18, 18);
    const zero: OutlineNode = requireNode(tuple.children, "0");
    assert.equal(zero.type, "property");
    assert.equal(zero.depth, 2);
    assert.equal(zero.path, "rust/lib.rs#Tuple.0");
    assert.equal(zero.detail, "u32");
    assertRange(zero, LibText, 18, 18);
    assert.equal(requireNode(tuple.children, "1").detail, "u32");
    assert.equal(findNode(result.nodes, "Ghost"), undefined);
    assert.equal(findNode(result.nodes, "ghost"), undefined);
});

test("Rust enum variants become property children in source order", (): void => {
    const result: OutlineResult = outline("rust/lib.rs");
    const shape: OutlineNode = requireNode(result.nodes, "Shape");
    assert.equal(shape.type, "enum");
    assert.equal(shape.depth, 1);
    assert.equal(shape.path, "rust/lib.rs#Shape");
    assert.equal(shape.detail, "pub enum Shape {");
    assert.deepEqual(shape.modifiers, ["pub"]);
    assertRange(shape, LibText, 20, 23);
    assert.deepEqual(labels(shape.children), ["Circle", "Square"]);
    const circle: OutlineNode = requireNode(shape.children, "Circle");
    assert.equal(circle.type, "property");
    assert.equal(circle.depth, 2);
    assert.equal(circle.path, "rust/lib.rs#Shape.Circle");
    assert.equal(circle.detail, "Circle { radius: f64 },");
    assertRange(circle, LibText, 21, 21);
    const square: OutlineNode = requireNode(shape.children, "Square");
    assert.equal(square.type, "property");
    assert.equal(square.detail, "Square(f64),");
    assertRange(square, LibText, 22, 22);
});

test("Rust trait/impl containers: methods attach as `method` and impl labels stay unique", (): void => {
    const result: OutlineResult = outline("rust/lib.rs");
    const anchor: OutlineNode = result.nodes[0];
    assert.deepEqual(labels(anchor.children), [
        "MAX_POINTS", "GREETING", "Pair", "twice", "Point", "Inline", "Tuple", "Shape", "Area",
        "impl Area for Point", "impl Point", "nested",
    ]);

    const traitArea: OutlineNode = requireNode(result.nodes, "Area");
    assert.equal(traitArea.type, "trait");
    assert.equal(traitArea.depth, 1);
    assert.equal(traitArea.path, "rust/lib.rs#Area");
    assertRange(traitArea, LibText, 25, 30);
    assert.deepEqual(labels(traitArea.children), ["area", "label"]);
    const declared: OutlineNode = requireNode(traitArea.children, "area");
    assert.equal(declared.type, "method");
    assert.equal(declared.depth, 2);
    assert.equal(declared.detail, "fn area(&self) -> f64;");
    assertRange(declared, LibText, 26, 26);
    assert.equal(requireNode(traitArea.children, "label").type, "method");
    assertRange(requireNode(traitArea.children, "label"), LibText, 27, 29);

    const objects: OutlineNode[] = anchor.children.filter((node: OutlineNode): boolean => node.type === "object");
    assert.deepEqual(labels(objects), ["impl Area for Point", "impl Point"]);
    assert.equal(objects[0].path, "rust/lib.rs#impl Area for Point");
    assertRange(objects[0], LibText, 32, 36);
    assert.deepEqual(labels(objects[0].children), ["area"]);
    const implArea: OutlineNode = requireNode(objects[0].children, "area");
    assert.equal(implArea.type, "method");
    assert.equal(implArea.path, "rust/lib.rs#impl Area for Point.area");
    assertRange(implArea, LibText, 33, 35);

    assert.equal(objects[1].path, "rust/lib.rs#impl Point");
    assertRange(objects[1], LibText, 38, 48);
    assert.deepEqual(labels(objects[1].children), ["new", "fetch", "danger"]);
    for (const child of objects[1].children) {
        assert.equal(child.type, "method");
        assert.equal(child.depth, 2);
    }
    const created: OutlineNode = requireNode(objects[1].children, "new");
    assert.equal(created.path, "rust/lib.rs#impl Point.new");
    assert.equal(created.detail, "pub fn new(x: f64, y: f64) -> Self {");
    assertRange(created, LibText, 39, 41);
    const fetched: OutlineNode = requireNode(objects[1].children, "fetch");
    assert.equal(fetched.path, "rust/lib.rs#impl Point.fetch");
    assert.equal(fetched.detail, "pub async fn fetch<T>(&self, key: &T) -> Option<T> where T: Clone {");
    assertRange(fetched, LibText, 42, 44);
    assertRange(requireNode(objects[1].children, "danger"), LibText, 45, 47);

    const paths: string[] = flatten(result.nodes).map((node: OutlineNode): string => node.path);
    assert.equal(new Set<string>(paths).size, paths.length, "symbol paths must be unique");
});

test("Rust nested modules: depth and path grow one level per container", (): void => {
    const result: OutlineResult = outline("rust/lib.rs");
    const nested: OutlineNode = requireNode(result.nodes, "nested");
    assert.equal(nested.type, "module");
    assert.equal(nested.depth, 1);
    assert.equal(nested.path, "rust/lib.rs#nested");
    assert.deepEqual(nested.modifiers, ["pub"]);
    assertRange(nested, LibText, 50, 53);
    assert.deepEqual(labels(nested.children), ["Inner", "helper"]);
    const inner: OutlineNode = requireNode(nested.children, "Inner");
    assert.equal(inner.type, "struct");
    assert.equal(inner.depth, 2);
    assert.equal(inner.path, "rust/lib.rs#nested.Inner");
    assertRange(inner, LibText, 51, 51);
    const value: OutlineNode = requireNode(inner.children, "value");
    assert.equal(value.type, "property");
    assert.equal(value.depth, 3);
    assert.equal(value.path, "rust/lib.rs#nested.Inner.value");
    assertRange(value, LibText, 51, 51);
    assert.equal(requireNode(nested.children, "helper").type, "function");
    assertRange(requireNode(nested.children, "helper"), LibText, 52, 52);

    const modules: OutlineResult = outline("rust/modules.rs");
    const root: OutlineNode = modules.nodes[0];
    assert.deepEqual(labels(root.children), ["filesystem", "net", "tests", "outer"]);
    const fileModule: OutlineNode = requireNode(modules.nodes, "filesystem");
    assert.equal(fileModule.type, "module");
    assert.equal(fileModule.depth, 1);
    assertRange(fileModule, ModulesText, 1, 1);
    const net: OutlineNode = requireNode(modules.nodes, "net");
    assert.equal(net.type, "module");
    assertRange(net, ModulesText, 2, 5);
    assert.deepEqual(labels(net.children), ["PORT", "listen"]);
    assert.equal(requireNode(net.children, "PORT").type, "constant");
    assert.equal(requireNode(net.children, "PORT").depth, 2);
    assertRange(requireNode(net.children, "PORT"), ModulesText, 3, 3);
    assertRange(requireNode(net.children, "listen"), ModulesText, 4, 4);
    const tests: OutlineNode = requireNode(modules.nodes, "tests");
    assert.equal(tests.type, "module");
    assertRange(tests, ModulesText, 7, 11);
    assert.deepEqual(labels(tests.children), ["works"]);
    assertRange(requireNode(tests.children, "works"), ModulesText, 10, 10);
    const outer: OutlineNode = requireNode(modules.nodes, "outer");
    assert.equal(outer.depth, 1);
    assertRange(outer, ModulesText, 12, 16);
    const innerModule: OutlineNode = requireNode(outer.children, "inner");
    assert.equal(innerModule.type, "module");
    assert.equal(innerModule.depth, 2);
    assert.equal(innerModule.path, "rust/modules.rs#outer.inner");
    assertRange(innerModule, ModulesText, 13, 15);
    const deep: OutlineNode = requireNode(innerModule.children, "Deep");
    assert.equal(deep.type, "struct");
    assert.equal(deep.depth, 3);
    assertRange(deep, ModulesText, 14, 14);
    const n: OutlineNode = requireNode(deep.children, "n");
    assert.equal(n.type, "property");
    assert.equal(n.depth, 4);
    assert.equal(n.path, "rust/modules.rs#outer.inner.Deep.n");
    assertRange(n, ModulesText, 14, 14);
});

test("Rust const/static/type/macro_rules keep their names, kinds and modifiers", (): void => {
    const result: OutlineResult = outline("rust/lib.rs");
    const constant: OutlineNode = requireNode(result.nodes, "MAX_POINTS");
    assert.equal(constant.type, "constant");
    assert.equal(constant.depth, 1);
    assert.equal(constant.path, "rust/lib.rs#MAX_POINTS");
    assert.deepEqual(constant.modifiers, ["pub"]);
    assert.ok((constant.detail ?? "").startsWith("pub const MAX_POINTS"));
    assertRange(constant, LibText, 4, 4);

    const statik: OutlineNode = requireNode(result.nodes, "GREETING");
    assert.equal(statik.type, "constant");
    assert.equal(statik.modifiers, undefined);
    assert.ok((statik.detail ?? "").startsWith("static GREETING"));
    assert.equal((statik.detail ?? "").includes("fn fake"), false, "detail is the masked line");
    assertRange(statik, LibText, 5, 5);

    const alias: OutlineNode = requireNode(result.nodes, "Pair");
    assert.equal(alias.type, "type");
    assert.equal(alias.depth, 1);
    assert.deepEqual(alias.modifiers, ["pub(crate)"]);
    assert.equal(alias.detail, "pub(crate) type Pair = (u8, u8);");
    assertRange(alias, LibText, 6, 6);

    const macro: OutlineNode = requireNode(result.nodes, "twice");
    assert.equal(macro.type, "macro");
    assert.equal(macro.depth, 1);
    assert.equal(macro.path, "rust/lib.rs#twice");
    assert.equal(macro.detail, "macro_rules! twice {");
    assert.equal(macro.modifiers, undefined);
    assertRange(macro, LibText, 8, 10);
    assert.equal(findNode(result.nodes, "fmt"), undefined);
});

test("Rust async/unsafe/const/extern fn, generics and multi-line where clauses", (): void => {
    const modifiers: OutlineResult = outline("rust/modifiers.rs");
    const callables: readonly string[] = ["async_pub", "unsafe_pub", "const_pub", "async_unsafe", "extern_c"];
    for (let index: number = 0; index < callables.length; index += 1) {
        const node: OutlineNode = requireNode(modifiers.nodes, callables[index]);
        assert.equal(node.type, "function");
        assert.equal(node.depth, 1);
        assertRange(node, ModifiersText, index + 1, index + 1);
    }
    assert.deepEqual(requireNode(modifiers.nodes, "async_pub").modifiers, ["pub", "async"]);
    assert.deepEqual(requireNode(modifiers.nodes, "unsafe_pub").modifiers, ["pub", "unsafe"]);
    assert.deepEqual(requireNode(modifiers.nodes, "const_pub").modifiers, ["pub", "const"]);
    assert.deepEqual(requireNode(modifiers.nodes, "async_unsafe").modifiers, ["async", "unsafe"]);
    assert.deepEqual(requireNode(modifiers.nodes, "extern_c").modifiers, ["pub", "extern"]);
    assert.equal(requireNode(modifiers.nodes, "async_pub").detail, "pub async fn async_pub() {}");
    assert.equal(requireNode(modifiers.nodes, "extern_c").detail, "pub extern fn extern_c() {}", "detail is masked and whitespace-normalized");
    assert.equal((requireNode(modifiers.nodes, "extern_c").detail ?? "").includes('"C"'), false);

    const whereClause: OutlineResult = outline("rust/where_clause.rs");
    const spanning: OutlineNode = requireNode(whereClause.nodes, "spanning");
    assert.equal(spanning.type, "function");
    assert.equal(spanning.detail, "pub fn spanning<T, U>(");
    assertRange(spanning, WhereText, 1, 10);
    const after: OutlineNode = requireNode(whereClause.nodes, "after");
    assert.equal(after.type, "function");
    assertRange(after, WhereText, 16, 16);

    const lib: OutlineResult = outline("rust/lib.rs");
    assert.deepEqual(requireNode(lib.nodes, "fetch").modifiers, ["pub", "async"]);
    assert.deepEqual(requireNode(lib.nodes, "danger").modifiers, ["pub", "unsafe"]);
    assert.deepEqual(requireNode(lib.nodes, "new").modifiers, ["pub"]);
    assert.deepEqual(requireNode(lib.nodes, "Point").modifiers, ["pub"]);
    assert.deepEqual(requireNode(requireNode(lib.nodes, "Point").children, "x").modifiers, ["pub"]);
    assert.equal(requireNode(requireNode(lib.nodes, "Point").children, "y").modifiers, undefined);
});

test("Rust comments, strings, raw strings and char literals never produce declarations", (): void => {
    const result: OutlineResult = outline("rust/decoys.rs");
    assert.equal(result.strategy, "rust");
    assert.equal(flatten(result.nodes).length, 8);
    assert.deepEqual(labels(result.nodes[0].children), ["NOTE", "RAW", "CHAR", "QUOTED", "Real", "real"]);
    const decoys: readonly string[] = ["Commented", "block_hidden", "Fake", "decoy", "InString", "RawFake", "raw_fake", "quoted"];
    for (let index: number = 0; index < decoys.length; index += 1) {
        assert.equal(findNode(result.nodes, decoys[index]), undefined, `decoy leaked: ${decoys[index]}`);
    }
    const real: OutlineNode = requireNode(result.nodes, "Real");
    assert.equal(real.type, "struct");
    assert.deepEqual(labels(real.children), ["id"]);
    assertRange(real, DecoysText, 8, 10);
    assertRange(requireNode(real.children, "id"), DecoysText, 9, 9);
    assert.equal(requireNode(result.nodes, "real").type, "function");
    assertRange(requireNode(result.nodes, "real"), DecoysText, 12, 12);
    assert.equal((requireNode(result.nodes, "RAW").detail ?? "").includes("raw_fake"), false);
    assert.equal((requireNode(result.nodes, "QUOTED").detail ?? "").includes("fn quoted"), false);
});

test("Rust empty files and use-only files return an empty file anchor", (): void => {
    const empty: OutlineResult = outline("rust/empty.rs");
    assert.equal(empty.strategy, "rust");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.target, "file");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes.length, 1);
    const emptyAnchor: OutlineNode = empty.nodes[0];
    assert.equal(emptyAnchor.isFile, true);
    assert.equal(emptyAnchor.label, "empty.rs");
    assert.equal(emptyAnchor.children.length, 0);
    assertRange(emptyAnchor, "", 1, 1);
    assert.equal(emptyAnchor.range.startByte, 0n);
    assert.equal(emptyAnchor.range.endByte, 0n);

    const uses: OutlineResult = outline("rust/only_use.rs");
    assert.equal(uses.strategy, "rust");
    assert.equal(uses.nodes[0].children.length, 0);
    assertRange(uses.nodes[0], OnlyUseText, 1, 3);
});

test("Rust CRLF files keep their line numbers, byte offsets and field detection", (): void => {
    const result: OutlineResult = outline("rust/crlf.rs");
    assert.equal(result.strategy, "rust");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assertRange(result.nodes[0], CrlfText, 1, 7);
    const line: OutlineNode = requireNode(result.nodes, "Line");
    assert.equal(line.type, "struct");
    assert.equal(line.detail, "pub struct Line {");
    assertRange(line, CrlfText, 1, 3);
    assert.deepEqual(labels(line.children), ["value"]);
    const value: OutlineNode = requireNode(line.children, "value");
    assert.equal(value.type, "property");
    assert.equal(value.detail, "pub value: u8,");
    assertRange(value, CrlfText, 2, 2);
    const tail: OutlineNode = requireNode(result.nodes, "tail");
    assert.equal(tail.type, "function");
    assertRange(tail, CrlfText, 5, 7);
    for (const node of flatten(result.nodes)) {
        assert.equal(node.label.includes("\r"), false);
        assert.equal((node.detail ?? "").includes("\r"), false);
    }
});

test("Rust UTF-8 BOM: charset is utf-8-bom and ranges use raw-file offsets", (): void => {
    const result: OutlineResult = outline("rust/bom.rs");
    assert.equal(result.strategy, "rust");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    // Ranges are raw-file coordinates: a UTF-8 BOM keeps its 3-byte prefix, so a
    // symbol offset is shifted by bomLength while the anchor still starts at 0.
    const bomLength: bigint = 3n;
    assert.equal(Number(anchor.range.startLine), 1);
    assert.equal(Number(anchor.range.endLine), 2);
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(BomBytes.byteLength));
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(BomText, "utf8")) + bomLength);
    const bom: OutlineNode = requireNode(result.nodes, "Bom");
    assert.equal(bom.type, "struct");
    assert.deepEqual(labels(bom.children), ["flag"]);
    const bomExpected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(BomText, 1, 1);
    assert.equal(Number(bom.range.startLine), 1);
    assert.equal(Number(bom.range.endLine), 1);
    assert.equal(bom.range.startByte, bomExpected.startByte + bomLength);
    assert.equal(bom.range.endByte, bomExpected.endByte + bomLength);
    const go: OutlineNode = requireNode(result.nodes, "go");
    assert.equal(go.type, "function");
    const goExpected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(BomText, 2, 2);
    assert.equal(Number(go.range.startLine), 2);
    assert.equal(Number(go.range.endLine), 2);
    assert.equal(go.range.startByte, goExpected.startByte + bomLength);
    assert.equal(go.range.endByte, goExpected.endByte + bomLength);
    assert.equal(go.range.endByte, BigInt(BomBytes.byteLength));
});

test("Rust Unicode identifiers are reported and multibyte byte ranges stay exact", (): void => {
    const result: OutlineResult = outline("rust/unicode.rs");
    assert.equal(result.strategy, "rust");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const firstLine: string = UnicodeText.split("\n")[0];
    assert.ok(Buffer.byteLength(firstLine, "utf8") > firstLine.length, "fixture must contain multibyte content");
    assert.deepEqual(labels(result.nodes[0].children), ["NOTE", "Ascii", "计算", "after_unicode"]);
    const ascii: OutlineNode = requireNode(result.nodes, "Ascii");
    assert.equal(ascii.type, "struct");
    assertRange(ascii, UnicodeText, 3, 5);
    assert.deepEqual(labels(ascii.children), ["label"]);
    const field: OutlineNode = requireNode(ascii.children, "label");
    assert.equal(field.type, "property");
    assert.equal(field.detail, "pub label: String,");
    assertRange(field, UnicodeText, 4, 4);
    const computed: OutlineNode = requireNode(result.nodes, "计算");
    assert.equal(computed.type, "function");
    assert.equal(computed.path, "rust/unicode.rs#计算");
    assert.deepEqual(computed.modifiers, ["pub"]);
    assertRange(computed, UnicodeText, 6, 6);
    assertRange(requireNode(result.nodes, "after_unicode"), UnicodeText, 7, 7);
    assert.equal(findNode(result.nodes, "幽灵"), undefined);
    assert.equal((requireNode(result.nodes, "NOTE").detail ?? "").includes("幽灵"), false);
});

test("Rust long files: the 3000-line scan ceiling hides later symbols and flags truncation", (): void => {
    const result: OutlineResult = outline("rust/long.rs");
    assert.equal(result.strategy, "rust");
    assert.equal(result.truncated, true);
    assert.equal(findNode(result.nodes, "early") !== (void 0), true);
    assert.equal(findNode(result.nodes, "Late"), undefined);
    assert.equal(Number(result.nodes[0].range.endLine), 3002);
    assert.equal(result.nodes[0].children.length, 1);
});

test("Rust maxNodes truncates explicitly, counts the anchor and drops the rest", (): void => {
    const complete: OutlineResult = outline("rust/many.rs");
    assert.equal(complete.truncated, false);
    assert.equal(flatten(complete.nodes).length, 12);

    const four: OutlineResult = outline("rust/many.rs", { maxNodes: 4 });
    assert.equal(four.truncated, true);
    assert.equal(flatten(four.nodes).length, 4);
    assert.deepEqual(labels(four.nodes[0].children), ["A"]);
    assert.deepEqual(labels(four.nodes[0].children[0].children), ["a", "b"]);
    assert.equal(findNode(four.nodes, "B"), undefined);

    const three: OutlineResult = outline("rust/many.rs", { maxNodes: 3 });
    assert.equal(three.truncated, true);
    assert.equal(flatten(three.nodes).length, 3);
    assert.deepEqual(labels(three.nodes[0].children[0].children), ["a"]);

    const one: OutlineResult = outline("rust/many.rs", { maxNodes: 1 });
    assert.equal(one.truncated, true);
    assert.equal(one.nodes.length, 1);
    assert.equal(one.nodes[0].children.length, 0);
});

test("Rust maxDepth drops deeper subtrees and reports truncation", (): void => {
    const full: OutlineResult = outline("rust/many.rs");
    assert.equal(full.truncated, false);
    assert.equal(requireNode(full.nodes, "d").depth, 3);

    const shallow: OutlineResult = outline("rust/many.rs", { maxDepth: 2 });
    assert.equal(shallow.truncated, true);
    assert.equal(flatten(shallow.nodes).length, 11);
    const modNode: OutlineNode = requireNode(shallow.nodes, "m");
    assert.deepEqual(labels(modNode.children), ["Deep", "f3"]);
    const deepNode: OutlineNode = requireNode(modNode.children, "Deep");
    assert.equal(deepNode.depth, 2);
    assert.equal(deepNode.children.length, 0);
    assert.equal(findNode(shallow.nodes, "d"), undefined);

    const rootsOnly: OutlineResult = outline("rust/many.rs", { maxDepth: 1 });
    assert.equal(rootsOnly.truncated, true);
    assert.equal(flatten(rootsOnly.nodes).length, 6);
    for (const node of rootsOnly.nodes[0].children) {
        assert.equal(node.children.length, 0);
    }
});

test("Rust budget options reject invalid values but clamp values above the hard cap", (): void => {
    expectFilesystemError("invalid_arguments", (): void => {
        outline("rust/many.rs", { maxNodes: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("rust/many.rs", { maxNodes: -3 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("rust/many.rs", { maxNodes: 2.5 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("rust/many.rs", { maxNodes: Number.NaN });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("rust/many.rs", { maxDepth: 0 });
    });
    expectFilesystemError("invalid_arguments", (): void => {
        outline("rust/many.rs", { maxDepth: 1.5 });
    });
    const clamped: OutlineResult = outline("rust/many.rs", { maxNodes: 1_000_000 });
    assert.equal(clamped.truncated, false);
    assert.equal(flatten(clamped.nodes).length, 12);
});

test("Rust binary, oversized, missing and escaping paths fail with closed codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("rust/blob.rs");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("rust/huge.rs");
    });
    expectFilesystemError("not_found", (): void => {
        outline("rust/missing.rs");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.rs");
    });
    expectFilesystemError("invalid_path", (): void => {
        outline("rust\\lib.rs");
    });
});

test("Rust static mut keeps the declared name (D1)", (): void => {
    const result: OutlineResult = outline("rust/statics.rs");
    assert.deepEqual(labels(result.nodes[0].children), ["COUNTER", "READONLY", "NAME_STR"]);
    const counter: OutlineNode = requireNode(result.nodes, "COUNTER");
    assert.equal(counter.type, "constant");
    assert.deepEqual(counter.modifiers, ["mut"]);
    assert.ok((counter.detail ?? "").startsWith("static mut COUNTER"));
    assertRange(counter, StaticsText, 1, 1);
    assert.equal(findNode(result.nodes, "mut"), undefined);
    assert.deepEqual(requireNode(result.nodes, "READONLY").modifiers, undefined);
    assert.deepEqual(requireNode(result.nodes, "NAME_STR").modifiers, ["pub"]);
});

test("Rust `[u8; N]` parameters keep the full function range (D2)", (): void => {
    const result: OutlineResult = outline("rust/where_clause.rs");
    const arrayParam: OutlineNode = requireNode(result.nodes, "array_param");
    assert.equal(arrayParam.type, "function");
    assert.equal(arrayParam.detail, "pub fn array_param(buf: [u8; 4]) -> usize {");
    assertRange(arrayParam, WhereText, 12, 14);
    assert.equal(Number(arrayParam.range.endLine), 14);
    assert.equal(Number(requireNode(result.nodes, "spanning").range.endLine), 10);
    assert.equal(Number(requireNode(result.nodes, "after").range.startLine), 16);
});

test("Rust lifetimes do not hide struct fields or pollute detail (D3)", (): void => {
    const result: OutlineResult = outline("rust/lifetimes.rs");
    const borrowed: OutlineNode = requireNode(result.nodes, "Borrowed");
    assert.equal(borrowed.type, "struct");
    assert.equal(borrowed.detail, "pub struct Borrowed<'a> {");
    assertRange(borrowed, LifetimesText, 1, 3);
    assert.deepEqual(labels(borrowed.children), ["text"]);
    const text: OutlineNode = requireNode(borrowed.children, "text");
    assert.equal(text.type, "property");
    assert.equal(text.detail, "pub text: &'a str,");
    assertRange(text, LifetimesText, 2, 2);
    const first: OutlineNode = requireNode(result.nodes, "first");
    assert.equal(first.type, "function");
    assert.equal(first.detail, "pub fn first<'a>(input: &'a str) -> &'a str {");
    assertRange(first, LifetimesText, 5, 7);
    assert.equal(requireNode(result.nodes, "after").type, "function");
    assertRange(requireNode(result.nodes, "after"), LifetimesText, 9, 9);
});

test("Rust raw strings with embedded quotes stay hidden (D4)", (): void => {
    const result: OutlineResult = outline("rust/raw_quote.rs");
    assert.equal(result.strategy, "rust");
    assert.deepEqual(labels(result.nodes[0].children), ["Before", "DOC", "Tail"]);
    assert.equal(findNode(result.nodes, "Leaked"), undefined);
    assert.equal(findNode(result.nodes, "x"), undefined);
    const doc: OutlineNode = requireNode(result.nodes, "DOC");
    assert.equal(doc.type, "constant");
    assert.ok((doc.detail ?? "").startsWith("const DOC: &str ="));
    assertRange(doc, RawQuoteText, 2, 3);
    const tail: OutlineNode = requireNode(result.nodes, "Tail");
    assert.equal(tail.type, "struct");
    assert.deepEqual(labels(tail.children), ["t"]);
    assertRange(tail, RawQuoteText, 4, 4);
});

test("Rust generic impl blocks are visible (D5)", (): void => {
    const result: OutlineResult = outline("rust/impl_generic.rs");
    assert.deepEqual(labels(result.nodes[0].children), ["Wrap", "impl Wrap<T>", "impl Default for Wrap<T>", "after_impl"]);
    const wrap: OutlineNode = requireNode(result.nodes, "Wrap");
    assert.equal(wrap.type, "struct");
    assert.deepEqual(labels(wrap.children), ["value"]);
    const inherent: OutlineNode = requireNode(result.nodes, "impl Wrap<T>");
    assert.equal(inherent.type, "object");
    assert.equal(inherent.depth, 1);
    assertRange(inherent, ImplGenericText, 2, 4);
    assert.deepEqual(labels(inherent.children), ["get"]);
    const get: OutlineNode = requireNode(inherent.children, "get");
    assert.equal(get.type, "method");
    assert.equal(get.path, "rust/impl_generic.rs#impl Wrap<T>.get");
    assert.deepEqual(get.modifiers, ["pub"]);
    assertRange(get, ImplGenericText, 3, 3);
    const traitImpl: OutlineNode = requireNode(result.nodes, "impl Default for Wrap<T>");
    assert.equal(traitImpl.type, "object");
    assertRange(traitImpl, ImplGenericText, 5, 7);
    assert.deepEqual(labels(traitImpl.children), ["default"]);
    assert.equal(requireNode(traitImpl.children, "default").type, "method");
    assertRange(requireNode(traitImpl.children, "default"), ImplGenericText, 6, 6);
    assert.equal(requireNode(result.nodes, "after_impl").type, "function");
});

test("Rust Allman headers and same-line attributes are visible (D6/D7)", (): void => {
    const result: OutlineResult = outline("rust/style.rs");
    assert.deepEqual(labels(result.nodes[0].children), [
        "Allman", "AllmanTrait", "impl Allman", "Decorated", "inlined", "Kept",
    ]);
    const allman: OutlineNode = requireNode(result.nodes, "Allman");
    assert.equal(allman.type, "struct");
    assertRange(allman, StyleText, 1, 4);
    assert.deepEqual(labels(allman.children), ["value"]);
    const traitNode: OutlineNode = requireNode(result.nodes, "AllmanTrait");
    assert.equal(traitNode.type, "trait");
    assert.equal(traitNode.detail, "pub trait AllmanTrait");
    assertRange(traitNode, StyleText, 6, 9);
    assert.deepEqual(labels(traitNode.children), ["mark"]);
    assert.equal(requireNode(traitNode.children, "mark").type, "method");
    const implNode: OutlineNode = requireNode(result.nodes, "impl Allman");
    assert.equal(implNode.type, "object");
    assertRange(implNode, StyleText, 11, 14);
    assert.deepEqual(labels(implNode.children), ["method"]);
    const decorated: OutlineNode = requireNode(result.nodes, "Decorated");
    assert.equal(decorated.type, "struct");
    assert.ok((decorated.detail ?? "").startsWith("#[derive(Debug)]"), "detail keeps the attribute text");
    assert.deepEqual(labels(decorated.children), ["a"]);
    assertRange(decorated, StyleText, 16, 16);
    const inlined: OutlineNode = requireNode(result.nodes, "inlined");
    assert.equal(inlined.type, "function");
    assert.deepEqual(inlined.modifiers, ["pub"]);
    assert.ok((inlined.detail ?? "").startsWith("#[inline]"));
    assertRange(inlined, StyleText, 17, 17);
    assert.deepEqual(labels(requireNode(result.nodes, "Kept").children), ["b"]);
});

test("Rust unsafe impl and extern fn are visible (D8/D9)", (): void => {
    const result: OutlineResult = outline("rust/modifiers.rs");
    assert.deepEqual(labels(result.nodes[0].children), [
        "async_pub", "unsafe_pub", "const_pub", "async_unsafe", "extern_c",
        "impl Send for Marker", "Marker", "impl Marker for Thing", "Thing",
    ]);
    const sendImpl: OutlineNode = requireNode(result.nodes, "impl Send for Marker");
    assert.equal(sendImpl.type, "object");
    assert.deepEqual(sendImpl.modifiers, ["unsafe"]);
    assertRange(sendImpl, ModifiersText, 6, 8);
    assert.deepEqual(labels(sendImpl.children), ["send"]);
    const send: OutlineNode = requireNode(sendImpl.children, "send");
    assert.equal(send.type, "method");
    assertRange(send, ModifiersText, 7, 7);
    const traitMarker: OutlineNode = requireNode(result.nodes, "Marker");
    assert.equal(traitMarker.type, "trait");
    assert.deepEqual(requireNode(result.nodes, "impl Marker for Thing").children, []);
    assert.deepEqual(labels(requireNode(result.nodes, "Thing").children), ["id"]);
});

test("Rust impl labels and method kinds are unambiguous (D10/D11)", (): void => {
    const result: OutlineResult = outline("rust/lib.rs");
    const anchor: OutlineNode = result.nodes[0];
    const traitArea: OutlineNode = anchor.children.find((node: OutlineNode): boolean => node.label === "Area" && node.type === "trait")!;
    const implArea: OutlineNode = anchor.children.find((node: OutlineNode): boolean => node.type === "object" && node.label.includes("Area"))!;
    assert.notEqual(implArea.path, traitArea.path);
    assert.equal(implArea.path, "rust/lib.rs#impl Area for Point");
    const structPoint: OutlineNode = anchor.children.find((node: OutlineNode): boolean => node.label === "Point" && node.type === "struct")!;
    const implPoint: OutlineNode = anchor.children.find((node: OutlineNode): boolean => node.type === "object" && node.label === "impl Point")!;
    assert.notEqual(implPoint.path, structPoint.path);
    for (const container of [traitArea, implArea, implPoint]) {
        for (const child of container.children) {
            assert.equal(child.type, "method", `${container.label}/${child.label}`);
            assert.equal(child.depth, container.depth + 1);
        }
    }
    assert.equal(requireNode(result.nodes, "helper").type, "function");
    assert.equal(requireNode(result.nodes, "helper").depth, 2);
});

test("Rust items inside a function body nest under that function (D12)", (): void => {
    const result: OutlineResult = outline("rust/nested_in_fn.rs");
    assert.deepEqual(labels(result.nodes[0].children), ["holder", "visible"]);
    const holder: OutlineNode = requireNode(result.nodes, "holder");
    assert.equal(holder.type, "function");
    assertRange(holder, NestedFnText, 1, 4);
    assert.deepEqual(labels(holder.children), ["Hidden", "inner"]);
    const hidden: OutlineNode = requireNode(holder.children, "Hidden");
    assert.equal(hidden.type, "struct");
    assert.equal(hidden.depth, 2);
    assert.equal(hidden.path, "rust/nested_in_fn.rs#holder.Hidden");
    assertRange(hidden, NestedFnText, 2, 2);
    const localField: OutlineNode = requireNode(hidden.children, "a");
    assert.equal(localField.type, "property");
    assert.equal(localField.depth, 3);
    assert.equal(localField.path, "rust/nested_in_fn.rs#holder.Hidden.a");
    const localFunction: OutlineNode = requireNode(holder.children, "inner");
    assert.equal(localFunction.type, "function");
    assert.equal(localFunction.depth, 2);
    assert.equal(localFunction.path, "rust/nested_in_fn.rs#holder.inner");
    assertRange(localFunction, NestedFnText, 3, 3);
});
