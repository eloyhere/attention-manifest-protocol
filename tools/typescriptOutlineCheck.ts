#!/usr/bin/env node
/**
 * TypeScript/JavaScript outline boundary checks.
 *
 * Every fixture is written to a private temporary directory and removed after
 * the run. Assertions go through the public `buildOutline` entry point, so
 * sandbox resolution, charset detection, strategy selection, member scanning,
 * source masking and range construction are exercised together.
 *
 * The suite pins language behaviour and regression assertions, including the
 * Unicode, JSX, destructured-parameter, decorator and default-export cases that
 * were fixed after the first boundary run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { FilesystemError } from "../src/file/errors.ts";
import { OutlineMaxFileBytes, buildOutline, outlineNodeFingerprint } from "../src/outline/outline.ts";
import type { OutlineOptions } from "../src/outline/outline.ts";
import { PathSandbox } from "../src/file/path.ts";
import type { OutlineNode, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

const Root: string = mkdtempSync(join(tmpdir(), "amp-ts-outline-"));
const RootSpec: SessionRoot = { id: "root.ts.outline", path: Root, writable: true, exclude: [] };
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
 * Non-anchor symbols, depth first.
 */
const symbols: (result: OutlineResult) => OutlineNode[] = (result: OutlineResult): OutlineNode[] =>
    flatten(result.nodes).filter((node: OutlineNode): boolean => !node.isFile && !node.isDirectory);

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
const requireNode: (nodes: readonly OutlineNode[], label: string) => OutlineNode = (
    nodes: readonly OutlineNode[], label: string,
): OutlineNode => {
    const node: OutlineNode | undefined = findNode(nodes, label);
    assert.ok(node !== (void 0), `missing outline node: ${label}`);
    return node!;
};

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
    const endByte: bigint =
        endLine >= lines.length && !endsWithNewline ? BigInt(Buffer.byteLength(text, "utf8")) : startByteOf(text, endLine + 1);
    return { startByte, endByte };
};

/**
 * Assert one node's inclusive line range and half-open UTF-8 byte range.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number,
): void => {
    assert.equal(Number(node.range.startLine), startLine, `${node.label} startLine`);
    assert.equal(Number(node.range.endLine), endLine, `${node.label} endLine`);
    const expected: { readonly startByte: bigint; readonly endByte: bigint; } = expectedBytes(text, startLine, endLine);
    assert.equal(node.range.startByte, expected.startByte, `${node.label} startByte`);
    assert.equal(node.range.endByte, expected.endByte, `${node.label} endByte`);
};

/**
 * Assert the bigint/order contract on one range.
 */
const assertBigIntRange: (node: OutlineNode) => void = (node: OutlineNode): void => {
    assert.equal(typeof(node.range.startByte), "bigint", `${node.label} startByte type`);
    assert.equal(typeof(node.range.endByte), "bigint", `${node.label} endByte type`);
    assert.equal(typeof(node.range.startLine), "bigint", `${node.label} startLine type`);
    assert.equal(typeof(node.range.endLine), "bigint", `${node.label} endLine type`);
    assert.ok(node.range.startByte <= node.range.endByte, `${node.label} byte order`);
    assert.ok(node.range.startLine <= node.range.endLine, `${node.label} line order`);
    assert.ok(node.range.startLine >= 1n, `${node.label} line origin`);
    assert.ok(Number.isSafeInteger(node.depth) && node.depth >= 0, `${node.label} depth`);
};

/**
 * Assert one classified domain error.
 */
const expectFilesystemError: (code: string, action: () => void) => void = (code: string, action: () => void): void => {
    assert.throws(action, (error: unknown): boolean => error instanceof FilesystemError && error.code === code);
};

const ClassesText: string = [
    "export class Alpha {",
    "    private stored: number = 0;",
    "",
    "    constructor(start: number) {",
    "        this.stored = start;",
    "    }",
    "",
    "    get value(): number {",
    "        return this.stored;",
    "    }",
    "",
    "    set value(next: number) {",
    "        this.stored = next;",
    "    }",
    "",
    "    static count: number = 0;",
    "    static readonly MAX: number = 100;",
    "    #secret = 1;",
    "",
    "    static create(): Alpha {",
    "        return new Alpha(0);",
    "    }",
    "",
    "    static async load(id: string): Promise<Alpha> {",
    "        return new Alpha(0);",
    "    }",
    "",
    "    async refresh<T>(value: T): Promise<T> {",
    "        return value;",
    "    }",
    "}",
    "",
    "export class Beta extends Alpha {",
    "    run(): void {",
    "    }",
    "}",
].join("\n");

const GlobalsText: string = [
    "const LIMIT = 10;",
    "let counter = 0;",
    'var legacy = "x";',
    "",
    "function greet(name: string): string {",
    "    return `hi ${name}`;",
    "}",
    "",
    "const double = (value: number): number => value * 2;",
    "const asyncFetch = async (url: string) => {",
    "    return url;",
    "};",
].join("\n");

const FormsText: string = [
    "export default class DefaultService {",
    '    ping(): string { return "pong"; }',
    "}",
    "",
    "declare class AmbientStore {",
    "    read(key: string): string;",
    "}",
    "",
    "declare function ambient(id: string): void;",
    "",
    "abstract class BaseRunner {",
    "    abstract run(): void;",
    "    protected started = false;",
    "}",
    "",
    "export async function prepare(): Promise<void> {",
    "}",
    "",
    "export const enum Mode {",
    "    Fast,",
    "    Slow,",
    "}",
    "",
    "export interface Options {",
    "    deep: boolean;",
    "}",
    "",
    "export type Identifier = string;",
    "",
    "export namespace Geometry {",
    "    export const PI = 3.14;",
    "}",
].join("\n");

const GenericsText: string = [
    'import { Component, Input } from "./decorators.ts";',
    "",
    "@Component({",
    '    selector: "app-generic",',
    '    template: `<div class="fake">function notADecl() {}</div>`,',
    "})",
    "export class GenericBox<T extends object = object> {",
    "    private items: T[] = [];",
    "",
    "    add<U extends T>(item: U): this {",
    "        this.items.push(item as unknown as T);",
    "        return this;",
    "    }",
    "",
    "    map<V>(mapper: (value: T) => V): GenericBox<V> {",
    "        return new GenericBox<V>();",
    "    }",
    "",
    "    static of<T>(value: T): GenericBox<T> {",
    "        return new GenericBox<T>();",
    "    }",
    "}",
    "",
    "export class DecoratedPanel {",
    "    @Input()",
    '    title = "panel";',
    "",
    '    @HostListener("click")',
    "    onClick(): void {}",
    "}",
    "",
    "export function first<T>(values: readonly T[]): T | undefined {",
    "    return values[0];",
    "}",
    "",
    "export const identity = <T>(value: T): T => value;",
].join("\n");

const MasksText: string = [
    "// class LineComment {",
    "/* function blockComment() {",
    "   class NestedInComment {}",
    "} */",
    'const double = "class InString { function hidden() {} }";',
    "const single = 'function alsoHidden() {}';",
    "const template = `class InTemplate {",
    "    function templateFn() {}",
    "}`;",
    "const pattern = /class Fake\\s*\\{/;",
    "const divided = (1 + 2) / 2;",
    "const after = /function fake\\(/;",
    "export class RealThing {",
    "    run(): void {}",
    "}",
].join("\n");

const CrlfText: string = `${[
    "export class CrlfWindow {",
    "    run(): void {",
    "        return;",
    "    }",
    "}",
    "export const limit = 2;",
].join("\r\n")}\r\n`;

const BomText: string = [
    "export class BomClass {",
    "    run(): void {}",
    "}",
    "",
].join("\n");
const BomBytes: Uint8Array = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BomText, "utf8")]);

const UnicodeSafeText: string = [
    "export class UnicodeSafe {",
    "    greet(): string {",
    '        return "你好，世界 🌍";',
    "    }",
    "}",
].join("\n");

const UnicodeIdentifierText: string = [
    "// 注释：class 注释类 {}",
    "export class Café {",
    "    naïve(): void {}",
    "}",
    'export const 名称 = "值";',
].join("\n");

const CommentOnlyText: string = [
    "// class Fake {",
    "/* function hidden() {",
    "   class Nested {}",
    "} */",
].join("\n");

const JavaScriptText: string = [
    "var total = 0;",
    'let name = "world";',
    "const greet = (who) => `hi ${who}`;",
    "function legacy() {",
    "    return `${name}: ${total}`;",
    "}",
    "export default class Widget {",
    "    static build(options) {",
    "        return new Widget();",
    "    }",
    "    get title() {",
    '        return "widget";',
    "    }",
    "    set title(next) {",
    "        this.value = next;",
    "    }",
    "    render() {",
    '        return `<div class="decoy">class Fake {}</div>`;',
    "    }",
    "}",
].join("\n");

const TsxSafeText: string = [
    'import React from "react";',
    "",
    "export interface Props { title: string; }",
    "",
    "export function Card({ title }: Props) {",
    "    return (",
    '        <section className="card">',
    "            {/* class CommentFake {} */}",
    "            <h2>{title}</h2>",
    '            <p data-note="class AttrFake { function hidden() {} }">Some class Fake text</p>',
    "        </section>",
    "    );",
    "}",
    "",
    "export const helper = (value: number): number => value + 1;",
].join("\n");

const JsxText: string = [
    "export const View = () => (",
    "    <div>",
    "        class Fake",
    "        function hidden()",
    "    </div>",
    ");",
    "export const count = 1;",
].join("\n");

const DestructuredText: string = [
    "export function api({ path }: { path: string }): string {",
    "    return path;",
    "}",
    "",
    "export class Handler {",
    "    handle({ id }: { id: string }): void {",
    "        return;",
    "    }",
    "}",
].join("\n");

const ManyText: string = [
    "class Alpha {}",
    "class Beta {}",
    "class Gamma {}",
    "class Delta {}",
].join("\n");

const DepthText: string = [
    "export class Deep {",
    "    outer(): void {",
    "    }",
    "}",
].join("\n");

const PkgTsText: string = [
    "export class Alpha {",
    "    one(): void {}",
    "}",
    "export class Beta {",
    "    two(): void {}",
    "}",
].join("\n");
const PkgJsText: string = ["export function gamma() {", "}"].join("\n");

const AnchorsText: string = [
    "export class Outer {",
    "    method(): void {}",
    "}",
].join("\n");

const AnonClassText: string = [
    "export default class {",
    "    run(): void {}",
    "}",
].join("\n");
const AnonFunctionText: string = ["export default function () {", "}"].join("\n");
const DefaultValueText: string = ["const Foo = 1;", "export default Foo;"].join("\n");

const DecoratorsText: string = [
    "export class Decorated {",
    '    @Input() title = "panel";',
    '    @HostListener("click") onClick(): void {}',
    "    get value(): number { return 1; }",
    "    static get size(): number { return 42; }",
    "    set value(next: number) { this.store = next; }",
    '    accessor label = "x";',
    "}",
].join("\n");

const QuotedModuleText: string = [
    'declare module "pkg:interop" {',
    "    export const value: number;",
    "}",
].join("\n");

const DefaultLiteralText: string = "export default 42;";

const TsxEdgeText: string = [
    "// <div> in a comment must not open JSX",
    "/* </div> */",
    'const note = "<div></div>";',
    "export const identity = <T>(value: T): T => value;",
    "export const isSmall = (value: number): boolean => value < 10;",
    "export function Panel({ title }: { title: string }) {",
    "    return <section title={`t-${title}`}>{title} don't stop</section>;",
    "}",
].join("\n");

fixture("ts/classes.ts", ClassesText);
fixture("ts/globals.ts", GlobalsText);
fixture("ts/forms.ts", FormsText);
fixture("ts/generics.ts", GenericsText);
fixture("ts/masks.ts", MasksText);
fixture("ts/crlf.ts", CrlfText);
fixture("ts/bom.ts", BomBytes);
fixture("ts/unicode-safe.ts", UnicodeSafeText);
fixture("ts/unicode-identifiers.ts", UnicodeIdentifierText);
fixture("ts/empty.ts", "");
fixture("ts/comments-only.ts", CommentOnlyText);
fixture("ts/destructured.ts", DestructuredText);
fixture("ts/anchors.ts", AnchorsText);
fixture("ts/decorators.ts", DecoratorsText);
fixture("ts/module-quoted.ts", QuotedModuleText);
fixture("ts/default-literal.ts", DefaultLiteralText);
fixture("js/legacy.js", JavaScriptText);
fixture("tsx/view.tsx", TsxSafeText);
fixture("tsx/jsx-text.tsx", JsxText);
fixture("tsx/edge.tsx", TsxEdgeText);
fixture("jsx/jsx-text.jsx", JsxText);
fixture("limits/many.ts", ManyText);
fixture("limits/depth.ts", DepthText);
fixture("pkg/a.ts", PkgTsText);
fixture("pkg/b.js", PkgJsText);
fixture("pkg/readme.md", "# Notes\n");
fixture("bad/blob.ts", new Uint8Array(64));
fixture("bad/huge.ts", Buffer.alloc(OutlineMaxFileBytes + 1, 97));
fixture("defaults/class.ts", AnonClassText);
fixture("defaults/function.ts", AnonFunctionText);
fixture("defaults/value.ts", DefaultValueText);
const ExtensionCases: ReadonlyArray<{ readonly path: string; readonly strategy: string; readonly language: string; }> = [
    { path: "ext/a.ts", strategy: "typescript", language: "typescript" },
    { path: "ext/b.tsx", strategy: "typescript", language: "typescript" },
    { path: "ext/c.mts", strategy: "typescript", language: "typescript" },
    { path: "ext/d.cts", strategy: "typescript", language: "typescript" },
    { path: "ext/e.js", strategy: "javascript", language: "javascript" },
    { path: "ext/f.jsx", strategy: "javascript", language: "javascript" },
    { path: "ext/g.mjs", strategy: "javascript", language: "javascript" },
    { path: "ext/h.cjs", strategy: "javascript", language: "javascript" },
];
for (let index: number = 0; index < ExtensionCases.length; index += 1) {
    const item: { readonly path: string; readonly strategy: string; readonly language: string; } = ExtensionCases[index];
    const symbol: string = item.strategy === "typescript" ? "export class Marker {}" : "export function marker() {}";
    fixture(item.path, `${symbol}\n`);
}

test("TypeScript outlines two classes in one file as sibling roots", (): void => {
    const result: OutlineResult = outline("ts/classes.ts");
    assert.equal(result.strategy, "typescript");
    assert.equal(result.category, "code");
    assert.equal(result.language, "typescript");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.isDirectory, false);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.label, "classes.ts");
    assert.equal(anchor.path, "ts/classes.ts");
    assert.deepEqual(labels(anchor.children), ["Alpha", "Beta"]);
    const alpha: OutlineNode = requireNode(result.nodes, "Alpha");
    const beta: OutlineNode = requireNode(result.nodes, "Beta");
    assert.equal(alpha.type, "class");
    assert.equal(beta.type, "class");
    assert.equal(alpha.depth, 1);
    assert.equal(beta.depth, 1);
    assert.equal(alpha.path, "ts/classes.ts#Alpha");
    assert.equal(beta.path, "ts/classes.ts#Beta");
    assertRange(alpha, ClassesText, 1, 31);
    assertRange(beta, ClassesText, 33, 36);
});

test("TypeScript class members cover properties, constructor, accessors and static members", (): void => {
    const result: OutlineResult = outline("ts/classes.ts");
    const alpha: OutlineNode = requireNode(result.nodes, "Alpha");
    assert.deepEqual(
        labels(alpha.children),
        ["stored", "constructor", "value", "value", "count", "MAX", "#secret", "create", "load", "refresh"],
    );
    const stored: OutlineNode = requireNode(alpha.children, "stored");
    assert.equal(stored.type, "property");
    assert.equal(stored.depth, 2);
    assert.equal(stored.path, "ts/classes.ts#Alpha.stored");
    assert.deepEqual(stored.modifiers, ["private"]);
    assertRange(stored, ClassesText, 2, 2);
    const constructor: OutlineNode = requireNode(alpha.children, "constructor");
    assert.equal(constructor.type, "method");
    assertRange(constructor, ClassesText, 4, 6);
    const accessors: OutlineNode[] = alpha.children.filter((node: OutlineNode): boolean => node.label === "value");
    assert.equal(accessors.length, 2);
    assert.equal(accessors[0].type, "method");
    assert.equal(accessors[1].type, "method");
    assertRange(accessors[0], ClassesText, 8, 10);
    assertRange(accessors[1], ClassesText, 12, 14);
    assert.notEqual(accessors[0].path, accessors[1].path);
    assert.match(accessors[0].path, /^ts\/classes\.ts#Alpha\.value~method-/);
    assert.match(accessors[1].path, /^ts\/classes\.ts#Alpha\.value~method-/);
    const count: OutlineNode = requireNode(alpha.children, "count");
    assert.equal(count.type, "property");
    assert.deepEqual(count.modifiers, ["static"]);
    assert.ok(count.modifiers?.includes("static"));
    const maximum: OutlineNode = requireNode(alpha.children, "MAX");
    assert.equal(maximum.type, "property");
    assert.deepEqual(maximum.modifiers, ["static", "readonly"]);
    assert.ok(maximum.modifiers?.includes("static"));
    const secret: OutlineNode = requireNode(alpha.children, "#secret");
    assert.equal(secret.type, "property");
    assert.equal(secret.path, "ts/classes.ts#Alpha.%23secret");
    const create: OutlineNode = requireNode(alpha.children, "create");
    assert.equal(create.type, "method");
    assert.deepEqual(create.modifiers, ["static"]);
    assert.ok(create.modifiers?.includes("static"));
    assertRange(create, ClassesText, 20, 22);
    const load: OutlineNode = requireNode(alpha.children, "load");
    assert.equal(load.type, "method");
    assert.deepEqual(load.modifiers, ["static", "async"]);
    assert.ok(load.modifiers?.includes("static"));
    assertRange(load, ClassesText, 24, 26);
    const refresh: OutlineNode = requireNode(alpha.children, "refresh");
    assert.equal(refresh.type, "method");
    assert.deepEqual(refresh.modifiers, ["async"]);
    assertRange(refresh, ClassesText, 28, 30);
    const beta: OutlineNode = requireNode(result.nodes, "Beta");
    assert.deepEqual(labels(beta.children), ["run"]);
    assert.equal(beta.children[0].path, "ts/classes.ts#Beta.run");
    assertRange(beta.children[0], ClassesText, 34, 35);
    const all: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        assertBigIntRange(all[index]);
    }
});

test("TypeScript global const, let, var, function and arrow const are classified", (): void => {
    const result: OutlineResult = outline("ts/globals.ts");
    assert.deepEqual(labels(result.nodes[0].children), ["LIMIT", "counter", "legacy", "greet", "double", "asyncFetch"]);
    const limit: OutlineNode = requireNode(result.nodes, "LIMIT");
    assert.equal(limit.type, "constant");
    assertRange(limit, GlobalsText, 1, 1);
    const counter: OutlineNode = requireNode(result.nodes, "counter");
    assert.equal(counter.type, "variable");
    assertRange(counter, GlobalsText, 2, 2);
    const legacy: OutlineNode = requireNode(result.nodes, "legacy");
    assert.equal(legacy.type, "variable");
    assertRange(legacy, GlobalsText, 3, 3);
    const greet: OutlineNode = requireNode(result.nodes, "greet");
    assert.equal(greet.type, "function");
    assertRange(greet, GlobalsText, 5, 7);
    const double: OutlineNode = requireNode(result.nodes, "double");
    assert.equal(double.type, "function");
    assertRange(double, GlobalsText, 9, 9);
    const asyncFetch: OutlineNode = requireNode(result.nodes, "asyncFetch");
    assert.equal(asyncFetch.type, "function");
    assertRange(asyncFetch, GlobalsText, 10, 12);
});

test("TypeScript export, default, declare, abstract and async declarations are recognized", (): void => {
    const result: OutlineResult = outline("ts/forms.ts");
    assert.deepEqual(
        labels(result.nodes[0].children),
        ["DefaultService", "AmbientStore", "ambient", "BaseRunner", "prepare", "Mode", "Options", "Identifier", "Geometry"],
    );
    const defaultService: OutlineNode = requireNode(result.nodes, "DefaultService");
    assert.equal(defaultService.type, "class");
    assert.deepEqual(defaultService.modifiers, ["export", "default"]);
    assert.equal(defaultService.path, "ts/forms.ts#DefaultService");
    assertRange(defaultService, FormsText, 1, 3);
    assert.deepEqual(labels(defaultService.children), ["ping"]);
    assert.equal(defaultService.children[0].type, "method");
    assertRange(defaultService.children[0], FormsText, 2, 2);
    const ambientStore: OutlineNode = requireNode(result.nodes, "AmbientStore");
    assert.equal(ambientStore.type, "class");
    assert.deepEqual(ambientStore.modifiers, ["declare"]);
    assertRange(ambientStore, FormsText, 5, 7);
    assert.equal(ambientStore.children[0].type, "method");
    assertRange(ambientStore.children[0], FormsText, 6, 6);
    const ambient: OutlineNode = requireNode(result.nodes, "ambient");
    assert.equal(ambient.type, "function");
    assert.deepEqual(ambient.modifiers, ["declare"]);
    assertRange(ambient, FormsText, 9, 9);
    const base: OutlineNode = requireNode(result.nodes, "BaseRunner");
    assert.equal(base.type, "class");
    assert.deepEqual(base.modifiers, ["abstract"]);
    assert.deepEqual(labels(base.children), ["run", "started"]);
    assert.equal(base.children[0].type, "method");
    assert.deepEqual(base.children[0].modifiers, ["abstract"]);
    assertRange(base.children[0], FormsText, 12, 12);
    assert.equal(base.children[1].type, "property");
    assert.deepEqual(base.children[1].modifiers, ["protected"]);
    const prepare: OutlineNode = requireNode(result.nodes, "prepare");
    assert.equal(prepare.type, "function");
    assert.deepEqual(prepare.modifiers, ["export", "async"]);
    assertRange(prepare, FormsText, 16, 17);
});

test("TypeScript interface, type, enum and namespace keep their own kind and do not inline members", (): void => {
    const result: OutlineResult = outline("ts/forms.ts");
    const mode: OutlineNode = requireNode(result.nodes, "Mode");
    assert.equal(mode.type, "enum");
    assert.equal(mode.depth, 1);
    assertRange(mode, FormsText, 19, 22);
    assert.equal(mode.children.length, 0);
    const options: OutlineNode = requireNode(result.nodes, "Options");
    assert.equal(options.type, "interface");
    assertRange(options, FormsText, 24, 26);
    assert.equal(options.children.length, 0);
    const identifier: OutlineNode = requireNode(result.nodes, "Identifier");
    assert.equal(identifier.type, "type");
    assertRange(identifier, FormsText, 28, 28);
    const geometry: OutlineNode = requireNode(result.nodes, "Geometry");
    assert.equal(geometry.type, "namespace");
    assert.equal(geometry.path, "ts/forms.ts#Geometry");
    assertRange(geometry, FormsText, 30, 32);
    assert.equal(geometry.children.length, 0);
    assert.equal(findNode(result.nodes, "PI"), undefined);
    assert.equal(findNode(result.nodes, "Fast"), undefined);
    assert.equal(findNode(result.nodes, "deep"), undefined);
});

test("TypeScript generic class, generic methods and decorators do not leak metadata as symbols", (): void => {
    const result: OutlineResult = outline("ts/generics.ts");
    assert.deepEqual(labels(result.nodes[0].children), ["GenericBox", "DecoratedPanel", "first", "identity"]);
    const box: OutlineNode = requireNode(result.nodes, "GenericBox");
    assert.equal(box.type, "class");
    assert.equal(box.range.startLine, 7n);
    assert.equal(box.range.endLine, 22n);
    assert.deepEqual(labels(box.children), ["items", "add", "map", "of"]);
    assert.equal(box.children[0].type, "property");
    assert.equal(box.children[1].type, "method");
    assertRange(box.children[1], GenericsText, 10, 13);
    assert.equal(box.children[2].type, "method");
    assertRange(box.children[2], GenericsText, 15, 17);
    const of: OutlineNode = requireNode(box.children, "of");
    assert.equal(of.type, "method");
    assert.deepEqual(of.modifiers, ["static"]);
    assert.ok(of.modifiers?.includes("static"));
    assertRange(of, GenericsText, 19, 21);
    const panel: OutlineNode = requireNode(result.nodes, "DecoratedPanel");
    assert.equal(panel.type, "class");
    assert.deepEqual(labels(panel.children), ["title", "onClick"]);
    assert.equal(panel.children[0].type, "property");
    assertRange(panel.children[0], GenericsText, 26, 26);
    assert.equal(panel.children[1].type, "method");
    assertRange(panel.children[1], GenericsText, 29, 29);
    const first: OutlineNode = requireNode(result.nodes, "first");
    assert.equal(first.type, "function");
    assertRange(first, GenericsText, 32, 34);
    const identity: OutlineNode = requireNode(result.nodes, "identity");
    assert.equal(identity.type, "function");
    assertRange(identity, GenericsText, 36, 36);
    assert.equal(findNode(result.nodes, "Component"), undefined);
    assert.equal(findNode(result.nodes, "Input"), undefined);
    assert.equal(findNode(result.nodes, "fake"), undefined);
    assert.equal(findNode(result.nodes, "notADecl"), undefined);
    assert.equal(findNode(result.nodes, "selector"), undefined);
});

test("same-line decorators and get/set/accessor modifiers are reported", (): void => {
    const result: OutlineResult = outline("ts/decorators.ts");
    assert.equal(result.strategy, "typescript");
    const decorated: OutlineNode = requireNode(result.nodes, "Decorated");
    assert.equal(decorated.type, "class");
    assert.deepEqual(labels(decorated.children), ["title", "onClick", "value", "size", "value", "label"]);
    const title: OutlineNode = requireNode(decorated.children, "title");
    assert.equal(title.type, "property");
    assert.equal(title.detail, "title = ;");
    assertRange(title, DecoratorsText, 2, 2);
    const onClick: OutlineNode = requireNode(decorated.children, "onClick");
    assert.equal(onClick.type, "method");
    assertRange(onClick, DecoratorsText, 3, 3);
    const values: OutlineNode[] = decorated.children.filter((node: OutlineNode): boolean => node.label === "value");
    assert.equal(values.length, 2);
    assert.equal(values[0].type, "method");
    assert.equal(values[1].type, "method");
    assert.deepEqual(values[0].modifiers, ["get"]);
    assert.deepEqual(values[1].modifiers, ["set"]);
    assertRange(values[0], DecoratorsText, 4, 4);
    assertRange(values[1], DecoratorsText, 6, 6);
    const size: OutlineNode = requireNode(decorated.children, "size");
    assert.deepEqual(size.modifiers, ["static", "get"]);
    assertRange(size, DecoratorsText, 5, 5);
    const label: OutlineNode = requireNode(decorated.children, "label");
    assert.equal(label.type, "property");
    assert.deepEqual(label.modifiers, ["accessor"]);
});

test("TypeScript masks comments, strings, template literals and regex literals", (): void => {
    const result: OutlineResult = outline("ts/masks.ts");
    assert.deepEqual(labels(result.nodes[0].children), ["double", "single", "template", "pattern", "divided", "after", "RealThing"]);
    assert.equal(requireNode(result.nodes, "double").type, "constant");
    assert.equal(requireNode(result.nodes, "single").type, "constant");
    assert.equal(requireNode(result.nodes, "template").type, "constant");
    assertRange(requireNode(result.nodes, "template"), MasksText, 7, 9);
    assert.equal(requireNode(result.nodes, "pattern").type, "constant");
    assertRange(requireNode(result.nodes, "pattern"), MasksText, 10, 10);
    assert.equal(requireNode(result.nodes, "divided").type, "constant");
    assertRange(requireNode(result.nodes, "divided"), MasksText, 11, 11);
    assert.equal(requireNode(result.nodes, "after").type, "constant");
    assertRange(requireNode(result.nodes, "after"), MasksText, 12, 12);
    const real: OutlineNode = requireNode(result.nodes, "RealThing");
    assert.equal(real.type, "class");
    assert.deepEqual(labels(real.children), ["run"]);
    const decoys: readonly string[] = [
        "Fake",
        "LineComment",
        "blockComment",
        "NestedInComment",
        "hidden",
        "alsoHidden",
        "InTemplate",
        "templateFn",
        "InString",
    ];
    for (let index: number = 0; index < decoys.length; index += 1) {
        assert.equal(findNode(result.nodes, decoys[index]), undefined, `masked decoy ${decoys[index]}`);
    }
});

test("CRLF input keeps byte ranges that include the carriage return", (): void => {
    const result: OutlineResult = outline("ts/crlf.ts");
    assert.equal(result.strategy, "typescript");
    assert.equal(result.charset, "utf-8");
    assert.ok(CrlfText.includes("\r\n"));
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.range.endLine, 6n);
    assert.equal(anchor.range.endByte, BigInt(Buffer.byteLength(CrlfText, "utf8")));
    const window: OutlineNode = requireNode(result.nodes, "CrlfWindow");
    assert.equal(window.type, "class");
    assertRange(window, CrlfText, 1, 5);
    assert.equal(window.range.startByte, 0n);
    const run: OutlineNode = requireNode(window.children, "run");
    assertRange(run, CrlfText, 2, 4);
    const limit: OutlineNode = requireNode(result.nodes, "limit");
    assert.equal(limit.type, "constant");
    assertRange(limit, CrlfText, 6, 6);
    assert.equal(limit.range.startByte, window.range.endByte);
});

test("UTF-8 BOM is detected and byte ranges stay aligned with raw file bytes", (): void => {
    const result: OutlineResult = outline("ts/bom.ts");
    assert.equal(result.charset, "utf-8-bom");
    assert.equal(result.strategy, "typescript");
    const cls: OutlineNode = requireNode(result.nodes, "BomClass");
    assert.equal(cls.type, "class");
    assert.equal(Number(cls.range.startLine), 1);
    assert.equal(Number(cls.range.endLine), 3);
    assert.equal(cls.range.startByte, 3n);
    assert.equal(cls.range.endByte, BigInt(BomBytes.byteLength));
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.range.startByte, 0n);
    assert.equal(anchor.range.endByte, BigInt(BomBytes.byteLength));
    assert.equal(Number(anchor.range.endLine), 3);
    assert.equal(anchor.range.endByte - cls.range.startByte, BigInt(Buffer.byteLength(BomText, "utf8")));
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("Unicode text inside strings keeps UTF-8 byte ranges correct", (): void => {
    const result: OutlineResult = outline("ts/unicode-safe.ts");
    const cls: OutlineNode = requireNode(result.nodes, "UnicodeSafe");
    assert.equal(cls.type, "class");
    assertRange(cls, UnicodeSafeText, 1, 5);
    const greet: OutlineNode = requireNode(cls.children, "greet");
    assert.equal(greet.type, "method");
    assertRange(greet, UnicodeSafeText, 2, 4);
    assert.ok(Buffer.byteLength(UnicodeSafeText, "utf8") > UnicodeSafeText.length);
    assertBigIntRange(greet);
});

test("Unicode identifiers are preserved across declarations and members", (): void => {
    const result: OutlineResult = outline("ts/unicode-identifiers.ts");
    const observed: string[] = symbols(result).map((node: OutlineNode): string => node.label);
    assert.deepEqual(observed, ["Café", "naïve", "名称"], `Unicode identifiers observed=${JSON.stringify(observed)}`);
});

test("empty and comment-only files return a valid anchor without symbols", (): void => {
    const empty: OutlineResult = outline("ts/empty.ts");
    assert.equal(empty.strategy, "typescript");
    assert.equal(empty.category, "code");
    assert.equal(empty.charset, "utf-8");
    assert.equal(empty.truncated, false);
    assert.equal(empty.target, "file");
    assert.equal(empty.nodes.length, 1);
    assert.equal(empty.nodes[0].isFile, true);
    assert.equal(empty.nodes[0].children.length, 0);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.equal(empty.nodes[0].range.startLine, 1n);
    assert.equal(empty.nodes[0].range.endLine, 1n);
    assert.match(empty.fingerprint, /^sha256:[0-9a-f]{64}$/);
    const comments: OutlineResult = outline("ts/comments-only.ts");
    assert.equal(comments.truncated, false);
    assert.equal(comments.nodes[0].children.length, 0);
    assert.equal(flatten(comments.nodes).length, 1);
    assert.equal(comments.nodes[0].range.endByte, BigInt(Buffer.byteLength(CommentOnlyText, "utf8")));
    assert.equal(comments.nodes[0].range.endLine, 4n);
    assert.equal(findNode(comments.nodes, "Fake"), undefined);
    assert.equal(findNode(comments.nodes, "hidden"), undefined);
    assert.equal(findNode(comments.nodes, "Nested"), undefined);
});

test("JavaScript reports functions, classes, accessors and static methods with the same scanner", (): void => {
    const result: OutlineResult = outline("js/legacy.js");
    assert.equal(result.strategy, "javascript");
    assert.equal(result.language, "javascript");
    assert.equal(result.category, "code");
    assert.deepEqual(labels(result.nodes[0].children), ["total", "name", "greet", "legacy", "Widget"]);
    assert.equal(requireNode(result.nodes, "total").type, "variable");
    assert.equal(requireNode(result.nodes, "name").type, "variable");
    assert.equal(requireNode(result.nodes, "greet").type, "function");
    assertRange(requireNode(result.nodes, "greet"), JavaScriptText, 3, 3);
    assert.equal(requireNode(result.nodes, "legacy").type, "function");
    assertRange(requireNode(result.nodes, "legacy"), JavaScriptText, 4, 6);
    const widget: OutlineNode = requireNode(result.nodes, "Widget");
    assert.equal(widget.type, "class");
    assert.deepEqual(widget.modifiers, ["export", "default"]);
    assert.equal(widget.path, "js/legacy.js#Widget");
    assert.deepEqual(labels(widget.children), ["build", "title", "title", "render"]);
    const build: OutlineNode = requireNode(widget.children, "build");
    assert.equal(build.type, "method");
    assert.deepEqual(build.modifiers, ["static"]);
    assert.ok(build.modifiers?.includes("static"));
    assertRange(build, JavaScriptText, 8, 10);
    assert.equal(build.path, "js/legacy.js#Widget.build");
    const titles: OutlineNode[] = widget.children.filter((node: OutlineNode): boolean => node.label === "title");
    assert.equal(titles.length, 2);
    assert.equal(titles[0].type, "method");
    assert.equal(titles[1].type, "method");
    assertRange(titles[0], JavaScriptText, 11, 13);
    assertRange(titles[1], JavaScriptText, 14, 16);
    const render: OutlineNode = requireNode(widget.children, "render");
    assert.equal(render.type, "method");
    assertRange(render, JavaScriptText, 17, 19);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
});

test("TS and JS extensions select the expected strategies", (): void => {
    for (let index: number = 0; index < ExtensionCases.length; index += 1) {
        const item: { readonly path: string; readonly strategy: string; readonly language: string; } = ExtensionCases[index];
        const result: OutlineResult = outline(item.path);
        assert.equal(result.strategy, item.strategy, item.path);
        assert.equal(result.language, item.language, item.path);
        assert.equal(result.category, "code", item.path);
        assert.equal(result.target, "file", item.path);
        assert.equal(result.charset, "utf-8", item.path);
        assert.ok(result.nodes[0].children.length >= 1, `${item.path} symbol`);
    }
});

test("TSX attributes, JSX comments and JSX text inside a component do not become declarations", (): void => {
    const result: OutlineResult = outline("tsx/view.tsx");
    assert.equal(result.strategy, "react");
    assert.deepEqual(labels(result.nodes[0].children), ["Props", "Card", "helper"]);
    assert.equal(requireNode(result.nodes, "Props").type, "props");
    assert.equal(requireNode(result.nodes, "Card").type, "component");
    assert.equal(requireNode(result.nodes, "helper").type, "function");
    assert.equal(findNode(result.nodes, "CommentFake"), undefined);
    assert.equal(findNode(result.nodes, "AttrFake"), undefined);
    assert.equal(findNode(result.nodes, "Fake"), undefined);
    assert.equal(findNode(result.nodes, "hidden"), undefined);
});

test("JSX masking ignores comment/string JSX, generics and comparisons", (): void => {
    const result: OutlineResult = outline("tsx/edge.tsx");
    assert.equal(result.strategy, "typescript");
    assert.deepEqual(labels(result.nodes[0].children), ["note", "identity", "isSmall", "Panel"]);
    const note: OutlineNode = requireNode(result.nodes, "note");
    assert.equal(note.type, "constant");
    assertRange(note, TsxEdgeText, 3, 3);
    const identity: OutlineNode = requireNode(result.nodes, "identity");
    assert.equal(identity.type, "function");
    assertRange(identity, TsxEdgeText, 4, 4);
    const isSmall: OutlineNode = requireNode(result.nodes, "isSmall");
    assert.equal(isSmall.type, "function");
    assertRange(isSmall, TsxEdgeText, 5, 5);
    const panel: OutlineNode = requireNode(result.nodes, "Panel");
    assert.equal(panel.type, "function");
    assertRange(panel, TsxEdgeText, 6, 8);
    assert.equal(findNode(result.nodes, "div"), undefined);
    assert.equal(findNode(result.nodes, "section"), undefined);
    assert.equal(findNode(result.nodes, "T"), undefined);
});

test("expression-level JSX text is masked instead of parsed as declarations", (): void => {
    const tsx: OutlineResult = outline("tsx/jsx-text.tsx");
    const jsx: OutlineResult = outline("jsx/jsx-text.jsx");
    const observed: { readonly tsx: string[]; readonly jsx: string[]; } = {
        tsx: symbols(tsx).map((node: OutlineNode): string => node.label),
        jsx: symbols(jsx).map((node: OutlineNode): string => node.label),
    };
    assert.deepEqual(observed, { tsx: ["View", "count"], jsx: ["View", "count"] }, `expression JSX observed=${JSON.stringify(observed)}`);
});

test("destructured parameters keep the full function and method range", (): void => {
    const result: OutlineResult = outline("ts/destructured.ts");
    const api: OutlineNode = requireNode(result.nodes, "api");
    const handler: OutlineNode = requireNode(result.nodes, "Handler");
    const handle: OutlineNode = requireNode(handler.children, "handle");
    const observed: { readonly api: number[]; readonly handle: number[]; } = {
        api: [Number(api.range.startLine), Number(api.range.endLine)],
        handle: [Number(handle.range.startLine), Number(handle.range.endLine)],
    };
    assert.deepEqual(observed, { api: [1, 3], handle: [6, 8] }, `destructured-parameter ranges observed=${JSON.stringify(observed)}`);
});

test("maxNodes truncates explicitly and counts the file anchor", (): void => {
    const limited: OutlineResult = outline("limits/many.ts", { maxNodes: 3 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["Alpha", "Beta"]);
    assert.equal(flatten(limited.nodes).length, 3);
    const anchorOnly: OutlineResult = outline("limits/many.ts", { maxNodes: 1 });
    assert.equal(anchorOnly.truncated, true);
    assert.equal(anchorOnly.nodes[0].children.length, 0);
    assert.equal(flatten(anchorOnly.nodes).length, 1);
    const complete: OutlineResult = outline("limits/many.ts");
    assert.equal(complete.truncated, false);
    assert.deepEqual(labels(complete.nodes[0].children), ["Alpha", "Beta", "Gamma", "Delta"]);
});

test("maxDepth drops class members and reports truncation", (): void => {
    const shallow: OutlineResult = outline("limits/depth.ts", { maxDepth: 1 });
    assert.equal(shallow.truncated, true);
    const deep: OutlineNode = requireNode(shallow.nodes, "Deep");
    assert.equal(deep.type, "class");
    assert.equal(deep.children.length, 0);
    assert.equal(flatten(shallow.nodes).length, 2);
    const two: OutlineResult = outline("limits/depth.ts", { maxDepth: 2 });
    assert.equal(two.truncated, false);
    const deepTwo: OutlineNode = requireNode(two.nodes, "Deep");
    assert.deepEqual(labels(deepTwo.children), ["outer"]);
    assertRange(deepTwo.children[0], DepthText, 2, 3);
    assert.equal(flatten(two.nodes).length, 3);
});

test("invalid maxNodes and maxDepth values are rejected as invalid_arguments", (): void => {
    const invalid: readonly OutlineOptions[] = [
        { maxNodes: 0 },
        { maxDepth: 0 },
        { maxNodes: 1.5 },
        { maxDepth: -2 },
        { maxNodes: Number.NaN },
    ];
    for (let index: number = 0; index < invalid.length; index += 1) {
        const options: OutlineOptions = invalid[index];
        expectFilesystemError("invalid_arguments", (): void => {
            outline("limits/depth.ts", options);
        });
    }
});

test("directory symbols are opt-in and expand TS and JS children with symbol paths", (): void => {
    const plain: OutlineResult = outline("pkg");
    assert.equal(plain.target, "directory");
    assert.equal(plain.strategy, "directory");
    assert.equal(plain.category, "other");
    assert.equal(plain.language, "directory");
    assert.equal(plain.charset, "none");
    assert.equal(plain.nodes[0].isDirectory, true);
    assert.deepEqual(labels(plain.nodes[0].children), ["a.ts", "b.js", "readme.md"]);
    for (let index: number = 0; index < plain.nodes[0].children.length; index += 1) {
        assert.equal(plain.nodes[0].children[index].children.length, 0);
    }
    const expanded: OutlineResult = outline("pkg", { symbols: true });
    assert.equal(expanded.truncated, false);
    const aFile: OutlineNode = expanded.nodes[0].children[0];
    const bFile: OutlineNode = expanded.nodes[0].children[1];
    const readme: OutlineNode = expanded.nodes[0].children[2];
    assert.deepEqual(labels(aFile.children), ["Alpha", "Beta"]);
    assert.deepEqual(labels(bFile.children), ["gamma"]);
    assert.deepEqual(labels(readme.children), ["Notes"]);
    assert.equal(aFile.children[0].path, "pkg/a.ts#Alpha");
    assert.equal(aFile.children[0].children[0].path, "pkg/a.ts#Alpha.one");
    assert.equal(bFile.children[0].path, "pkg/b.js#gamma");
    assert.equal(readme.children[0].path, "pkg/readme.md#Notes");
});

test("directory symbol expansion obeys the maxNodes budget", (): void => {
    const limited: OutlineResult = outline("pkg", { symbols: true, maxNodes: 4 });
    assert.equal(limited.truncated, true);
    assert.deepEqual(labels(limited.nodes[0].children), ["a.ts"]);
    const aFile: OutlineNode = limited.nodes[0].children[0];
    assert.deepEqual(labels(aFile.children), ["Alpha"]);
    assert.deepEqual(labels(aFile.children[0].children), ["one"]);
    assert.equal(flatten(limited.nodes).length, 4);
});

test("binary and oversized TypeScript files fail with closed error codes", (): void => {
    expectFilesystemError("binary_file", (): void => {
        outline("bad/blob.ts");
    });
    expectFilesystemError("quota_exceeded", (): void => {
        outline("bad/huge.ts");
    });
    expectFilesystemError("path_escape", (): void => {
        outline("../outside.ts");
    });
    expectFilesystemError("not_found", (): void => {
        outline("bad/missing.ts");
    });
});

test("paths use file#Class and file#Class.member while every range stays bigint and ordered", (): void => {
    const result: OutlineResult = outline("ts/anchors.ts");
    const anchor: OutlineNode = result.nodes[0];
    assert.equal(anchor.isFile, true);
    assert.equal(anchor.type, "File");
    assert.equal(anchor.path, "ts/anchors.ts");
    assert.equal(anchor.label, "anchors.ts");
    assert.ok(anchor.file !== (void 0));
    assert.equal(anchor.file!.path, "ts/anchors.ts");
    assert.equal(outlineNodeFingerprint(anchor), result.fingerprint);
    const outer: OutlineNode = requireNode(anchor.children, "Outer");
    const method: OutlineNode = requireNode(outer.children, "method");
    assert.equal(outer.path, "ts/anchors.ts#Outer");
    assert.equal(method.path, "ts/anchors.ts#Outer.method");
    assertRange(anchor, AnchorsText, 1, 3);
    assertRange(outer, AnchorsText, 1, 3);
    assertRange(method, AnchorsText, 2, 2);
    assert.equal(anchor.range.startLine, 1n);
    assert.equal(anchor.range.endLine, 3n);
    assert.match(outlineNodeFingerprint(outer), /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(outlineNodeFingerprint(outer), outlineNodeFingerprint(method));
    const all: OutlineNode[] = flatten(result.nodes);
    for (let index: number = 0; index < all.length; index += 1) {
        const node: OutlineNode = all[index];
        assertBigIntRange(node);
        if (!node.isFile && !node.isDirectory) {
            assert.ok(node.path.startsWith("ts/anchors.ts#"), node.path);
        }
    }
});

test("anonymous default class/function and default identifier produce default symbols", (): void => {
    const anonClass: OutlineResult = outline("defaults/class.ts");
    assert.deepEqual(labels(anonClass.nodes[0].children), ["default"]);
    const defaultClass: OutlineNode = requireNode(anonClass.nodes, "default");
    assert.equal(defaultClass.type, "class");
    assert.equal(defaultClass.path, "defaults/class.ts#default");
    assertRange(defaultClass, AnonClassText, 1, 3);
    assert.deepEqual(labels(defaultClass.children), ["run"]);
    assert.equal(defaultClass.children[0].path, "defaults/class.ts#default.run");
    assertRange(defaultClass.children[0], AnonClassText, 2, 2);
    const anonFunction: OutlineResult = outline("defaults/function.ts");
    assert.deepEqual(labels(anonFunction.nodes[0].children), ["default"]);
    const defaultFunction: OutlineNode = requireNode(anonFunction.nodes, "default");
    assert.equal(defaultFunction.type, "function");
    assertRange(defaultFunction, AnonFunctionText, 1, 2);
    const value: OutlineResult = outline("defaults/value.ts");
    assert.deepEqual(labels(value.nodes[0].children), ["Foo", "default"]);
    const defaultConstant: OutlineNode = requireNode(value.nodes, "default");
    assert.equal(defaultConstant.type, "constant");
    assert.equal(defaultConstant.path, "defaults/value.ts#default");
    assertRange(defaultConstant, DefaultValueText, 2, 2);
});

test("export default with a literal value is reported as a constant", (): void => {
    const result: OutlineResult = outline("ts/default-literal.ts");
    assert.deepEqual(labels(result.nodes[0].children), ["default"]);
    const literal: OutlineNode = requireNode(result.nodes, "default");
    assert.equal(literal.type, "constant");
    assert.equal(literal.path, "ts/default-literal.ts#default");
    assert.equal(literal.detail, "export default 42;");
    assert.deepEqual(literal.modifiers, ["export", "default"]);
    assertRange(literal, DefaultLiteralText, 1, 1);
});

test("quoted declare module names are preserved as namespace labels", (): void => {
    const result: OutlineResult = outline("ts/module-quoted.ts");
    assert.deepEqual(labels(result.nodes[0].children), ["pkg:interop"]);
    const moduleNode: OutlineNode = requireNode(result.nodes, "pkg:interop");
    assert.equal(moduleNode.type, "namespace");
    assert.equal(moduleNode.path, "ts/module-quoted.ts#pkg:interop");
    assert.equal(moduleNode.detail, 'declare module "pkg:interop" {');
    assert.deepEqual(moduleNode.modifiers, ["declare"]);
    assertRange(moduleNode, QuotedModuleText, 1, 3);
    assert.equal(moduleNode.children.length, 0);
});
