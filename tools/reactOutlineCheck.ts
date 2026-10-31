#!/usr/bin/env node
/**
 * React outline boundary checks.
 *
 * Every fixture is written to a private temporary directory, goes through the
 * public `OutlineRegistry` (React strategy registered first, then the built-in
 * list) or through `parseReact` directly, and the temporary root is removed
 * after the run. No fixture is executed and no third-party parser is involved.
 *
 * The suite covers the contract from four angles:
 *
 * 1. selection: React evidence, extension gating, and the registration-order
 *    requirement that React must precede TypeScript/JavaScript for `.tsx`/`.jsx`;
 * 2. symbols: function/arrow/default/class components, multiple components,
 *    Props, built-in and custom hooks, nested JSX, `React.memo`/`forwardRef`,
 *    TSX generics and comment/string decoys;
 * 3. text edges: empty and blank files, CRLF, a UTF-8 BOM, and multi-byte
 *    Unicode content whose byte range must exceed its character count;
 * 4. framing: `maxNodes`/`maxDepth`, bigint line/byte ranges, monotonic ranges
 *    at the top level, parent-scoped paths and depth arithmetic.
 *
 * Run with: `node tools/reactOutlineCheck.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { ByteLineIndex } from "../src/syntax/byteIndex.ts";
import { LineIndex } from "../src/syntax/charset.ts";
import { OutlineRegistry } from "../src/outline/outline.ts";
import type { OutlineOptions, OutlineParseInput } from "../src/outline/outline.ts";
import { builtinOutlineStrategies } from "../src/outline/outlineStrategies.ts";
import { PathSandbox } from "../src/file/path.ts";
import { BuiltinReactHooks, ReactStrategy, parseReact } from "../src/outline/reactOutline.ts";
import type { OutlineNode, OutlineRange, OutlineResult } from "../src/outline/types.ts";
import type { SessionRoot } from "../src/session/types.ts";

/**
 * Private fixture root for this run.
 */
const Root: string = mkdtempSync(join(tmpdir(), "amp-react-outline-"));
const RootSpec: SessionRoot = { id: "root.react.outline", path: Root, writable: true, exclude: [] };
const Sandbox: PathSandbox = new PathSandbox([RootSpec]);

/**
 * Registry with React registered first, which is the integration order the
 * report recommends: React claims `.tsx`/`.jsx` with React evidence, and
 * everything else falls through to the built-in TypeScript/JavaScript strategy.
 */
const Registry: OutlineRegistry = new OutlineRegistry([ReactStrategy, ...builtinOutlineStrategies]);

/**
 * Registry with React registered last, which is what appending it to the
 * built-in list would do. Used only to prove why the order matters.
 */
const LateRegistry: OutlineRegistry = new OutlineRegistry([...builtinOutlineStrategies, ReactStrategy]);

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
 * Build an outline through the React-first registry.
 */
const outline: (path: string, options?: OutlineOptions) => OutlineResult = (path: string, options: OutlineOptions = {}): OutlineResult =>
    Registry.build(Sandbox, path, options);

/**
 * Build an outline through the React-last registry.
 */
const lateOutline: (path: string) => OutlineResult = (path: string): OutlineResult => LateRegistry.build(Sandbox, path);

/**
 * Call the parser directly, with a real line index and the given path.
 */
const parseText: (path: string, text: string) => OutlineNode[] = (path: string, text: string): OutlineNode[] => {
    const input: OutlineParseInput = { path, text, lineIndex: new LineIndex(text) };
    return parseReact(input);
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
 * 1-based line number of the first line containing a needle.
 */
const lineOf: (text: string, needle: string) => number = (text: string, needle: string): number => {
    const lines: string[] = text.split("\n");
    const index: number = lines.findIndex((line: string): boolean => line.includes(needle));
    assert.notEqual(index, -1, `missing fixture line: ${needle}`);
    return index + 1;
};

/**
 * Assert one node's inclusive line range and UTF-8 byte range.
 */
const assertRange: (node: OutlineNode, text: string, startLine: number, endLine: number) => void = (
    node: OutlineNode, text: string, startLine: number, endLine: number,
): void => {
    const expected: OutlineRange = new ByteLineIndex(text).range(startLine, endLine);
    assert.equal(Number(node.range.startLine), startLine);
    assert.equal(Number(node.range.endLine), endLine);
    assert.equal(node.range.startByte, expected.startByte);
    assert.equal(node.range.endByte, expected.endByte);
};

/**
 * Runtime type tag. The React kinds (`component`/`hook`/`props`/`jsx`) are
 * outside the shared `OutlineKind` union until the main integration widens it,
 * so a comparison reads the value through a string view.
 */
const typeTag: (node: OutlineNode) => string = (node: OutlineNode): string => node.type as string;

/**
 * Hook labels present in a tree, sorted.
 */
const hookLabels: (nodes: readonly OutlineNode[]) => string[] = (nodes: readonly OutlineNode[]): string[] =>
    flatten(nodes)
        .filter((node: OutlineNode): boolean => typeTag(node) === "hook")
        .map((node: OutlineNode): string => node.label)
        .sort();

/**
 * React fixture with a props interface, a function component, an arrow
 * component that returns JSX, and a named default-export component.
 */
const GreetingTsx: string = [
    'import React, { useState } from "react";',
    "",
    "interface GreetingProps {",
    "    name: string;",
    "}",
    "",
    "export function Greeting({ name }: GreetingProps) {",
    "    const [count, setCount] = useState(0);",
    '    return <div className="greeting">{name}: {count}</div>;',
    "}",
    "",
    "export const Badge = (props: GreetingProps) => (",
    '    <span className="badge">{props.name}</span>',
    ");",
    "",
    "export default function App() {",
    '    return <Greeting name="world" />;',
    "}",
].join("\n") + "\n";

/**
 * Class component fixture. The generic argument names an interface instead of
 * an inline object literal on purpose: the wrapped TypeScript scanner resolves
 * a class body at the first `{`, so an inline type literal in the header would
 * shorten the class range on the upstream side.
 */
const CounterTsx: string = [
    'import React from "react";',
    "",
    "interface CounterProps {",
    "    start: number;",
    "}",
    "",
    "interface CounterState {",
    "    value: number;",
    "}",
    "",
    "export class Counter extends React.Component<CounterProps, CounterState> {",
    "    state: CounterState = { value: 0 };",
    "",
    "    render() {",
    "        return (",
    "            <section>",
    "                <h1>{this.state.value}</h1>",
    '                <Button label="go" />',
    "            </section>",
    "        );",
    "    }",
    "}",
].join("\n") + "\n";

/**
 * Hooks fixture: a custom hook declaration plus all seven built-in hooks,
 * including a `React.useState` member call and repeated `useState` calls.
 */
const HooksTsx: string = [
    'import React, { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";',
    "",
    "function useCounter(initial: number) {",
    "    const [value, setValue] = useState(initial);",
    "    useEffect(() => {}, []);",
    "    const doubled = useMemo(() => value * 2, [value]);",
    "    const ref = useRef<number | null>(null);",
    "    return { value, setValue, doubled, ref };",
    "}",
    "",
    "export function Panel() {",
    "    const { value } = useCounter(1);",
    "    const theme = useContext(ThemeContext);",
    "    const onOpen = useCallback(() => {}, []);",
    "    const [state, dispatch] = useReducer(reducer, 0);",
    "    const [open, setOpen] = React.useState(false);",
    "    return <div>{value}{theme}{onOpen}{state}{open ? 1 : 0}</div>;",
    "}",
].join("\n") + "\n";

/**
 * Wrapper fixture: `React.memo`, `React.forwardRef`, an inline object type in
 * the wrapper header, and nested JSX component tags.
 */
const WrappedTsx: string = [
    'import React from "react";',
    "",
    "export const Header = () => <header>Hi</header>;",
    "",
    "export const Card = React.memo(function CardBody(props: { title: string }) {",
    "    return <Header />;",
    "});",
    "",
    "export const Field = React.forwardRef<HTMLInputElement, { label: string }>((props, ref) => (",
    "    <label>",
    "        <input ref={ref} />",
    "        <Badge />",
    "    </label>",
    "));",
].join("\n") + "\n";

/**
 * Plain TSX fixture with generic parameters and lowercase JSX but no React
 * evidence: `.tsx` alone must not select the React strategy.
 */
const GenericTsx: string = [
    "export function identity<T>(value: T): T {",
    "    return value;",
    "}",
    "",
    "export const Generic = <T,>(props: { value: T }) => <div>{String(props.value)}</div>;",
].join("\n") + "\n";

/**
 * Decoy fixture: component, hook and JSX lookalikes inside comments and
 * strings must not become nodes.
 */
const DecoyTsx: string = [
    'import React from "react";',
    "",
    "// export function Fake() { return <FakeThing />; }",
    "/* class Ghost extends React.Component { render() { return <GhostThing />; } } */",
    'const decoy = "useState(1) and <Ghost /> and function Phantom() {}";',
    "",
    "export function Real() {",
    "    // useState(99)",
    '    const label = "useEffect(() => {})";',
    "    return <div>{label}</div>;",
    "}",
].join("\n") + "\n";

/**
 * JSX prose fixture: an apostrophe and a URL inside tag text must not hide the
 * component tags that follow them on the same line.
 */
const TextEdgesTsx: string = [
    'import React, { useState } from "react";',
    "",
    "export function Copy() {",
    "    const [value] = useState(0);",
    "    return (",
    "        <p>",
    "            don't panic <Widget /> https://example.test/a <Badge />",
    "        </p>",
    "    );",
    "}",
].join("\n") + "\n";

/**
 * Template literal fixture: literal text hides a decoy hook, while a hook call
 * inside a `${...}` interpolation stays visible.
 */
const TemplateTsx: string = [
    'import React, { useMemo } from "react";',
    "",
    "export function Templated() {",
    "    const decoy = `useState(777)`;",
    "    const label = `${useMemo(() => 1, [])}`;",
    "    return <div>{decoy}{label}</div>;",
    "}",
].join("\n") + "\n";

/**
 * Single-letter JSX tag fixture: `<A />` and `<B>...</B>` must be children,
 * while the generic parameter `<T>` must not.
 */
const TinyTagsTsx: string = [
    'import React from "react";',
    "",
    "export function Tiny() {",
    "    return (",
    "        <A />",
    "    );",
    "}",
    "",
    "export function Pair() {",
    "    return <B>text</B>;",
    "}",
    "",
    "export function Generic() {",
    "    const identity = <T>(value: T): T => value;",
    "    return <div />;",
    "}",
].join("\n") + "\n";

/**
 * CRLF fixture.
 */
const CrlfTsx: string = [
    'import React from "react";',
    "",
    "export function Crlf() {",
    "    return <div />;",
    "}",
].join("\r\n") + "\r\n";

/**
 * UTF-8 BOM fixture (the BOM byte is written, the text here is the decoded body).
 */
const BomTsx: string = [
    'import React from "react";',
    "",
    "export function Bom() {",
    "    return <div />;",
    "}",
].join("\n") + "\n";

/**
 * Multi-byte Unicode fixture. Identifiers stay ASCII so the fixture does not
 * depend on the upstream declaration scanner's Unicode-identifier policy; the
 * Unicode lives in a string, an attribute value and JSX text, which is exactly
 * where byte offsets matter.
 */
const UnicodeTsx: string = [
    'import React, { useState } from "react";',
    "",
    "interface PanelProps {",
    "    title: string;",
    "}",
    "",
    "export function Panel(props: PanelProps) {",
    '    const [value] = useState("你好，世界");',
    '    return <div title="面板">你好，世界 {value}</div>;',
    "}",
].join("\n") + "\n";

/**
 * Small fixture for the node/depth budget.
 */
const LimitsTsx: string = [
    'import React from "react";',
    "",
    "export function Alpha() {",
    "    return <Beta />;",
    "}",
    "",
    "export function Beta() {",
    "    return <div />;",
    "}",
].join("\n") + "\n";

/**
 * Small `.jsx` fixture.
 */
const WidgetJsx: string = [
    'import React from "react";',
    "",
    "export function Widget() {",
    "    return <div />;",
    "}",
].join("\n") + "\n";

/**
 * Anonymous default arrow fixture: `export default () => ...` is not a
 * declaration the wrapped TypeScript scanner reports, so the React layer adds
 * the `default` component itself.
 */
const AnonymousTsx: string = [
    'import { useState } from "react";',
    "",
    "const Label = () => <span />;",
    "",
    "export default (props: { title: string }) => {",
    "    const [open] = useState(false);",
    "    return <Label>{props.title}</Label>;",
    "};",
].join("\n") + "\n";

/**
 * `React.PureComponent` fixture.
 */
const PureTsx: string = [
    'import React from "react";',
    "",
    "interface BlockProps {",
    "    size: number;",
    "}",
    "",
    "export class Block extends React.PureComponent<BlockProps> {",
    "    render() {",
    "        return <div>{this.props.size}</div>;",
    "    }",
    "}",
].join("\n") + "\n";

fixture("src/Greeting.tsx", GreetingTsx);
fixture("src/Counter.tsx", CounterTsx);
fixture("src/Hooks.tsx", HooksTsx);
fixture("src/Wrapped.tsx", WrappedTsx);
fixture("src/Plain.tsx", GenericTsx);
fixture("src/Decoy.tsx", DecoyTsx);
fixture("src/TextEdges.tsx", TextEdgesTsx);
fixture("src/Template.tsx", TemplateTsx);
fixture("src/TinyTags.tsx", TinyTagsTsx);
fixture("src/Widget.jsx", WidgetJsx);
fixture("src/plain.jsx", "export function helper() {\n    return 1;\n}\n");
fixture("src/Empty.tsx", "");
fixture("src/Blank.tsx", "   \n\n");
fixture("src/evidence.ts", 'import React from "react";\n\nexport function helper() {\n    return 1;\n}\n');
fixture("src/crlf/Crlf.tsx", CrlfTsx);
fixture("src/Bom.tsx", "\uFEFF" + BomTsx);
fixture("src/Unicode.tsx", UnicodeTsx);
fixture("src/Limits.tsx", LimitsTsx);
fixture("src/Anonymous.tsx", AnonymousTsx);
fixture("src/Pure.tsx", PureTsx);

test("strategy metadata and the React evidence gate", (): void => {
    assert.equal(ReactStrategy.id, "react");
    assert.equal(ReactStrategy.category, "code");
    assert.equal(ReactStrategy.language, "react");
    const match: (name: string, head: string) => boolean = (name: string, head: string): boolean =>
        ReactStrategy.matches({ path: name, name, head });
    assert.equal(match("App.tsx", 'import React from "react";'), true);
    assert.equal(match("App.tsx", "import { useState } from 'react';"), true);
    assert.equal(match("Widget.jsx", "const C = React.memo(() => null);"), true);
    assert.equal(match("Widget.jsx", "export const A = () => <Widget />;"), true);
    assert.equal(match("Widget.tsx", "/** @jsx h */"), true);
    assert.equal(match("Widget.tsx", 'const { useState } = require("react");'), true);
    assert.equal(match("Plain.tsx", "export const value = 1;"), false);
    assert.equal(match("Plain.tsx", "export function identity<T>(value: T): T { return value; }"), false);
    assert.equal(match("Plain.tsx", "const list: Array<Props> = [];"), false);
    assert.equal(match("Plain.jsx", "export function helper() { return 1; }"), false);
    assert.equal(match("evidence.ts", 'import React from "react";'), false);
    assert.equal(match("App.mjs", 'import React from "react";'), false);
});

test("a function component, an arrow component, Props and a named default export", (): void => {
    const result: OutlineResult = outline("src/Greeting.tsx");
    assert.equal(result.strategy, "react");
    assert.equal(result.category, "code");
    assert.equal(result.language, "react");
    assert.equal(result.target, "file");
    assert.equal(result.charset, "utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.nodes[0].isFile, true);
    assert.deepEqual(labels(result.nodes[0].children), ["GreetingProps", "Greeting", "useState", "Badge", "App"]);
    const props: OutlineNode = requireNode(result.nodes, "GreetingProps");
    assert.equal(props.type, "props");
    assert.equal(props.depth, 1);
    assert.equal(props.path, "src/Greeting.tsx#GreetingProps");
    assertRange(props, GreetingTsx, lineOf(GreetingTsx, "interface GreetingProps"), lineOf(GreetingTsx, "interface GreetingProps") + 2);
    const greeting: OutlineNode = requireNode(result.nodes, "Greeting");
    assert.equal(greeting.type, "component");
    assert.equal(greeting.depth, 1);
    assert.equal(greeting.path, "src/Greeting.tsx#Greeting");
    assertRange(greeting, GreetingTsx, lineOf(GreetingTsx, "export function Greeting"), lineOf(GreetingTsx, "export function Greeting") + 3);
    const badge: OutlineNode = requireNode(result.nodes, "Badge");
    assert.equal(badge.type, "component");
    assert.equal(badge.depth, 1);
    assertRange(badge, GreetingTsx, lineOf(GreetingTsx, "export const Badge"), lineOf(GreetingTsx, "export const Badge") + 2);
    const app: OutlineNode = requireNode(result.nodes, "App");
    assert.equal(app.type, "component");
    assert.equal(app.depth, 1);
    assert.deepEqual(labels(app.children), ["Greeting"]);
    const usedGreeting: OutlineNode = app.children[0];
    assert.equal(usedGreeting.type, "jsx");
    assert.equal(usedGreeting.depth, 2);
    assert.equal(usedGreeting.path, "src/Greeting.tsx#App.Greeting");
    const useStateNode: OutlineNode = requireNode(result.nodes, "useState");
    assert.equal(useStateNode.type, "hook");
    assert.equal(useStateNode.depth, 1);
    assert.equal(useStateNode.path, "src/Greeting.tsx#useState");
    assert.match(useStateNode.detail ?? "", /useState\(0\)/);
    assert.equal(findNode(result.nodes, "default"), undefined);
});

test("a class component reports members and nested JSX component children", (): void => {
    const result: OutlineResult = outline("src/Counter.tsx");
    assert.equal(result.strategy, "react");
    const counter: OutlineNode = requireNode(result.nodes, "Counter");
    assert.equal(counter.type, "component");
    assert.equal(counter.depth, 1);
    assert.equal(counter.path, "src/Counter.tsx#Counter");
    assertRange(counter, CounterTsx, lineOf(CounterTsx, "export class Counter"), lineOf(CounterTsx, "export class Counter") + 11);
    assert.deepEqual(labels(counter.children), ["state", "render", "Button"]);
    const state: OutlineNode = requireNode(counter.children, "state");
    assert.equal(state.type, "property");
    assert.equal(state.depth, 2);
    const render: OutlineNode = requireNode(counter.children, "render");
    assert.equal(render.type, "method");
    assert.equal(render.depth, 2);
    assertRange(render, CounterTsx, lineOf(CounterTsx, "    render()"), lineOf(CounterTsx, "    render()") + 7);
    const button: OutlineNode = requireNode(counter.children, "Button");
    assert.equal(button.type, "jsx");
    assert.equal(button.depth, 2);
    assert.equal(button.path, "src/Counter.tsx#Counter.Button");
    assertRange(button, CounterTsx, lineOf(CounterTsx, "<Button"), lineOf(CounterTsx, "<Button"));
    assert.equal(findNode(counter.children, "CounterProps"), undefined);
    assert.equal(findNode(counter.children, "CounterState"), undefined);
    const props: OutlineNode = requireNode(result.nodes, "CounterProps");
    assert.equal(props.type, "props");
    assert.equal(requireNode(result.nodes, "CounterState").type, "interface");
});

test("built-in and custom hooks become one deduplicated hook node per name", (): void => {
    const result: OutlineResult = outline("src/Hooks.tsx");
    assert.equal(result.strategy, "react");
    assert.equal(requireNode(result.nodes, "useCounter").type, "hook");
    assert.equal(requireNode(result.nodes, "Panel").type, "component");
    assert.equal(BuiltinReactHooks.size, 7);
    const hooks: string[] = hookLabels(result.nodes);
    assert.equal(hooks.length, 8);
    assert.deepEqual(hooks, [
        "useCallback",
        "useContext",
        "useEffect",
        "useMemo",
        "useReducer",
        "useRef",
        "useCounter",
        "useState",
    ].sort());
    for (const name of BuiltinReactHooks) {
        assert.ok(hooks.includes(name), `missing built-in hook node: ${name}`);
    }
    const useStateNodes: OutlineNode[] = flatten(result.nodes).filter((node: OutlineNode): boolean => node.label === "useState");
    assert.equal(useStateNodes.length, 1);
    assert.equal(Number(useStateNodes[0].range.startLine), lineOf(HooksTsx, "useState(initial)"));
    assert.equal(useStateNodes[0].path, "src/Hooks.tsx#useState");
    assert.equal(useStateNodes[0].detail, "useState(initial)");
    const topLevel: readonly OutlineNode[] = result.nodes[0].children;
    for (let index: number = 1; index < topLevel.length; index += 1) {
        assert.ok(Number(topLevel[index].range.startLine) >= Number(topLevel[index - 1].range.startLine));
    }
});

test("React.memo, React.forwardRef, inline object types and nested JSX", (): void => {
    const result: OutlineResult = outline("src/Wrapped.tsx");
    assert.equal(result.strategy, "react");
    const header: OutlineNode = requireNode(result.nodes, "Header");
    assert.equal(header.type, "component");
    assertRange(header, WrappedTsx, lineOf(WrappedTsx, "export const Header"), lineOf(WrappedTsx, "export const Header"));
    const card: OutlineNode = requireNode(result.nodes, "Card");
    assert.equal(card.type, "component");
    assert.match(card.detail ?? "", /React\.memo/);
    assertRange(card, WrappedTsx, lineOf(WrappedTsx, "export const Card"), lineOf(WrappedTsx, "export const Card") + 2);
    assert.deepEqual(labels(card.children), ["Header"]);
    const field: OutlineNode = requireNode(result.nodes, "Field");
    assert.equal(field.type, "component");
    assert.match(field.detail ?? "", /forwardRef/);
    assertRange(field, WrappedTsx, lineOf(WrappedTsx, "export const Field"), lineOf(WrappedTsx, "export const Field") + 5);
    assert.deepEqual(labels(field.children), ["Badge"]);
    assert.equal(field.children[0].type, "jsx");
    assert.equal(field.children[0].path, "src/Wrapped.tsx#Field.Badge");
    assert.equal(findNode(field.children, "label"), undefined);
    assert.equal(findNode(field.children, "input"), undefined);
    assert.equal(findNode(field.children, "HTMLInputElement"), undefined);
});

test("anonymous default arrows and React.PureComponent are components", (): void => {
    const anonymous: OutlineResult = outline("src/Anonymous.tsx");
    assert.equal(anonymous.strategy, "react");
    assert.equal(requireNode(anonymous.nodes, "Label").type, "component");
    const fallback: OutlineNode = requireNode(anonymous.nodes, "default");
    assert.equal(fallback.type, "component");
    assert.equal(fallback.depth, 1);
    assert.equal(fallback.path, "src/Anonymous.tsx#default");
    assert.deepEqual(labels(fallback.children), ["Label"]);
    assert.equal(fallback.children[0].type, "jsx");
    assertRange(
        fallback,
        AnonymousTsx,
        lineOf(AnonymousTsx, "export default"),
        lineOf(AnonymousTsx, "export default") + 3,
    );
    assert.equal(requireNode(anonymous.nodes, "useState").type, "hook");
    const pure: OutlineResult = outline("src/Pure.tsx");
    assert.equal(pure.strategy, "react");
    const block: OutlineNode = requireNode(pure.nodes, "Block");
    assert.equal(block.type, "component");
    assert.equal(block.depth, 1);
    assert.deepEqual(labels(block.children), ["render"]);
    assert.equal(requireNode(pure.nodes, "BlockProps").type, "props");
    assert.equal(requireNode(pure.nodes, "BlockProps").path, "src/Pure.tsx#BlockProps");
});

test("TSX generics are React only when the evidence gate says so", (): void => {
    const selected: OutlineResult = outline("src/Plain.tsx");
    assert.equal(selected.strategy, "typescript");
    assert.equal(requireNode(selected.nodes, "identity").type, "function");
    assert.equal(requireNode(selected.nodes, "Generic").type, "function");
    assert.equal(findNode(selected.nodes, "Generic")?.children.length, 0);
    const direct: OutlineNode[] = parseText("src/Plain.tsx", GenericTsx);
    assert.deepEqual(labels(direct), ["identity", "Generic"]);
    assert.equal(direct[0].type, "function");
    assert.equal(requireNode(direct, "Generic").type, "component");
    assert.equal(requireNode(direct, "Generic").path, "src/Plain.tsx#Generic");
    assert.equal(requireNode(direct, "identity").children.length, 0);
});

test("components, hooks and JSX inside comments and strings are invisible", (): void => {
    const result: OutlineResult = outline("src/Decoy.tsx");
    assert.equal(result.strategy, "react");
    assert.equal(requireNode(result.nodes, "Real").type, "component");
    for (const decoy of ["Fake", "Phantom", "Ghost", "FakeThing", "GhostThing", "useState", "useEffect"]) {
        assert.equal(findNode(result.nodes, decoy), undefined, `decoy became a node: ${decoy}`);
    }
    assert.deepEqual(hookLabels(result.nodes), []);
    assert.equal(requireNode(result.nodes, "Real").children.length, 0);
    const direct: OutlineNode[] = parseText("src/Decoy.tsx", DecoyTsx);
    assert.deepEqual(labels(direct), ["decoy", "Real"]);
    assert.deepEqual(hookLabels(direct), []);
});

test("JSX prose and template placeholders keep the evidence scan honest", (): void => {
    const prose: OutlineResult = outline("src/TextEdges.tsx");
    assert.equal(prose.strategy, "react");
    const copy: OutlineNode = requireNode(prose.nodes, "Copy");
    assert.equal(copy.type, "component");
    assert.deepEqual(labels(copy.children), ["Widget", "Badge"]);
    assert.equal(copy.children[0].type, "jsx");
    assert.equal(copy.children[1].path, "src/TextEdges.tsx#Copy.Badge");
    assert.equal(requireNode(prose.nodes, "useState").type, "hook");
    const template: OutlineResult = outline("src/Template.tsx");
    assert.equal(template.strategy, "react");
    assert.equal(requireNode(template.nodes, "Templated").type, "component");
    const useMemoNode: OutlineNode = requireNode(template.nodes, "useMemo");
    assert.equal(useMemoNode.type, "hook");
    assert.match(useMemoNode.detail ?? "", /useMemo\(/);
    assert.equal(Number(useMemoNode.range.startLine), lineOf(TemplateTsx, "useMemo(() => 1"));
    assert.equal(findNode(template.nodes, "useState"), undefined);
});

test("single-letter components are kept while generic parameters are not", (): void => {
    const result: OutlineResult = outline("src/TinyTags.tsx");
    assert.equal(result.strategy, "react");
    const tiny: OutlineNode = requireNode(result.nodes, "Tiny");
    assert.equal(tiny.type, "component");
    assert.deepEqual(labels(tiny.children), ["A"]);
    assert.equal(tiny.children[0].type, "jsx");
    const pair: OutlineNode = requireNode(result.nodes, "Pair");
    assert.equal(pair.type, "component");
    assert.deepEqual(labels(pair.children), ["B"]);
    const generic: OutlineNode = requireNode(result.nodes, "Generic");
    assert.equal(generic.type, "component");
    assert.deepEqual(labels(generic.children), []);
});

test("empty and whitespace-only files produce no symbols", (): void => {
    assert.deepEqual(parseText("src/Empty.tsx", ""), []);
    assert.deepEqual(parseText("src/Blank.tsx", "   \n\n"), []);
    assert.equal(ReactStrategy.matches({ path: "src/Empty.tsx", name: "Empty.tsx", head: "" }), false);
    const empty: OutlineResult = outline("src/Empty.tsx");
    assert.equal(empty.strategy, "typescript");
    assert.equal(empty.target, "file");
    assert.equal(empty.truncated, false);
    assert.equal(empty.nodes[0].range.startByte, 0n);
    assert.equal(empty.nodes[0].range.endByte, 0n);
    assert.deepEqual(labels(empty.nodes[0].children), []);
    const blank: OutlineResult = outline("src/Blank.tsx");
    assert.deepEqual(labels(blank.nodes[0].children), []);
    assert.equal(blank.truncated, false);
});

test("CRLF, a UTF-8 BOM and multi-byte Unicode keep bigint byte ranges", (): void => {
    const crlf: OutlineResult = outline("src/crlf/Crlf.tsx");
    assert.equal(crlf.strategy, "react");
    assert.equal(crlf.charset, "utf-8");
    const crlfNode: OutlineNode = requireNode(crlf.nodes, "Crlf");
    assert.equal(crlfNode.type, "component");
    assertRange(crlfNode, CrlfTsx, lineOf(CrlfTsx, "export function Crlf"), lineOf(CrlfTsx, "}"));
    assert.ok(crlfNode.range.startByte > 0n);
    const bom: OutlineResult = outline("src/Bom.tsx");
    assert.equal(bom.strategy, "react");
    assert.equal(bom.charset, "utf-8-bom");
    const bomNode: OutlineNode = requireNode(bom.nodes, "Bom");
    assert.equal(bomNode.type, "component");
    /**
     * The registry reports raw-file byte offsets, so a UTF-8 BOM shifts every
     * symbol range by the three prefix bytes while line numbers stay decoded.
     */
    const bomStart: number = lineOf(BomTsx, "export function Bom");
    const bomEnd: number = bomStart + 2;
    const bomExpected: OutlineRange = new ByteLineIndex(BomTsx).range(bomStart, bomEnd);
    assert.equal(Number(bomNode.range.startLine), bomStart);
    assert.equal(Number(bomNode.range.endLine), bomEnd);
    assert.equal(bomNode.range.startByte, bomExpected.startByte + 3n);
    assert.equal(bomNode.range.endByte, bomExpected.endByte + 3n);
    assert.equal(bom.nodes[0].range.endByte, BigInt(Buffer.byteLength("\uFEFF" + BomTsx, "utf8")));
    const directBom: OutlineNode[] = parseText("src/Bom.tsx", "\uFEFF" + BomTsx);
    const directNode: OutlineNode = requireNode(directBom, "Bom");
    assert.equal(directNode.type, "component");
    assert.equal(directNode.range.startByte, bomExpected.startByte + 3n);
    assert.equal(directNode.range.endByte, bomExpected.endByte + 3n);
    const unicode: OutlineResult = outline("src/Unicode.tsx");
    assert.equal(unicode.strategy, "react");
    assert.equal(unicode.charset, "utf-8");
    const panel: OutlineNode = requireNode(unicode.nodes, "Panel");
    assert.equal(panel.type, "component");
    assert.equal(requireNode(unicode.nodes, "PanelProps").type, "props");
    assertRange(panel, UnicodeTsx, lineOf(UnicodeTsx, "export function Panel"), lineOf(UnicodeTsx, "export function Panel") + 3);
    const start: number = lineOf(UnicodeTsx, "export function Panel");
    const end: number = start + 3;
    const characters: number = UnicodeTsx.split("\n").slice(start - 1, end).join("\n").length;
    assert.ok(Number(panel.range.endByte - panel.range.startByte) > characters);
    assert.equal(requireNode(unicode.nodes, "useState").type, "hook");
    assert.equal(typeof panel.range.endByte, "bigint");
});

test("maxNodes and maxDepth bound the React tree and report truncation", (): void => {
    const complete: OutlineResult = outline("src/Limits.tsx");
    assert.equal(complete.truncated, false);
    assert.equal(requireNode(complete.nodes, "Alpha").children.length, 1);
    assert.equal(complete.nodes[0].children[0].children[0].depth, 2);
    const depthOne: OutlineResult = outline("src/Limits.tsx", { maxDepth: 1 });
    assert.equal(depthOne.truncated, true);
    assert.deepEqual(labels(depthOne.nodes[0].children), ["Alpha", "Beta"]);
    assert.deepEqual(labels(requireNode(depthOne.nodes, "Alpha").children), []);
    const depthTwo: OutlineResult = outline("src/Limits.tsx", { maxDepth: 2 });
    assert.equal(depthTwo.truncated, false);
    assert.deepEqual(labels(requireNode(depthTwo.nodes, "Alpha").children), ["Beta"]);
    const nodesTwo: OutlineResult = outline("src/Limits.tsx", { maxNodes: 2 });
    assert.equal(nodesTwo.truncated, true);
    assert.equal(flatten(nodesTwo.nodes).length, 2);
    assert.deepEqual(labels(nodesTwo.nodes[0].children), ["Alpha"]);
    const nodesThree: OutlineResult = outline("src/Limits.tsx", { maxNodes: 3 });
    assert.equal(nodesThree.truncated, true);
    assert.equal(flatten(nodesThree.nodes).length, 3);
    assert.deepEqual(labels(nodesThree.nodes[0].children), ["Alpha"]);
});

test("paths, depths and bigint ranges are ordered and parent-scoped", (): void => {
    const direct: OutlineNode[] = parseText("src/Greeting.tsx", GreetingTsx);
    assert.ok(direct.length >= 5);
    const index: ByteLineIndex = new ByteLineIndex(GreetingTsx);
    const totalBytes: bigint = BigInt(Buffer.byteLength(GreetingTsx, "utf8"));
    for (let position: number = 1; position < direct.length; position += 1) {
        assert.ok(Number(direct[position].range.startLine) >= Number(direct[position - 1].range.startLine));
    }
    const all: OutlineNode[] = flatten(direct);
    for (const node of all) {
        assert.equal(typeof node.range.startLine, "bigint");
        assert.equal(typeof node.range.endLine, "bigint");
        assert.equal(typeof node.range.startByte, "bigint");
        assert.equal(typeof node.range.endByte, "bigint");
        assert.ok(Number.isInteger(Number(node.range.startLine)));
        assert.ok(node.range.startLine >= 1n);
        assert.ok(node.range.endLine >= node.range.startLine);
        assert.ok(node.range.startByte >= 0n);
        assert.ok(node.range.endByte >= node.range.startByte);
        assert.ok(node.range.endByte <= totalBytes);
        assert.ok(node.path.startsWith("src/Greeting.tsx#"));
        assert.ok(node.label.length > 0);
        for (const child of node.children) {
            assert.equal(child.depth, node.depth + 1);
            assert.ok(child.path.startsWith(`${node.path}.`));
        }
    }
    const greeting: OutlineNode = requireNode(direct, "Greeting");
    assert.equal(greeting.depth, 0);
    assert.deepEqual(greeting.range, index.range(lineOf(GreetingTsx, "export function Greeting"), lineOf(GreetingTsx, "export function Greeting") + 3));
    assert.equal(requireNode(direct, "useState").depth, 0);
    const app: OutlineNode = requireNode(direct, "App");
    assert.equal(app.children[0].path, "src/Greeting.tsx#App.Greeting");
    assert.equal(app.children[0].type, "jsx");
});

test("registration order decides React versus TypeScript for .tsx", (): void => {
    assert.equal(outline("src/Greeting.tsx").strategy, "react");
    assert.equal(lateOutline("src/Greeting.tsx").strategy, "typescript");
    assert.equal(outline("src/Plain.tsx").strategy, "typescript");
    assert.equal(outline("src/evidence.ts").strategy, "typescript");
    assert.equal(outline("src/Widget.jsx").strategy, "react");
    assert.equal(outline("src/plain.jsx").strategy, "javascript");
    const late: OutlineResult = lateOutline("src/Greeting.tsx");
    assert.equal(requireNode(late.nodes, "Greeting").type, "function");
    assert.equal(findNode(late.nodes, "Greeting")?.children.length, 0);
    assert.equal(findNode(late.nodes, "useState"), undefined);
    const widget: OutlineResult = outline("src/Widget.jsx");
    assert.equal(requireNode(widget.nodes, "Widget").type, "component");
    assert.equal(requireNode(widget.nodes, "Widget").path, "src/Widget.jsx#Widget");
});
