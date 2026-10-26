import assert from "node:assert/strict";

import { AbstractSyntaxTree } from "../src/structure/abstractSyntaxTree.ts";
import type { AstNode, SourceSpan } from "../src/structure/abstractSyntaxTree.ts";
import { SegmentTree } from "../src/structure/segmentTree.ts";

let passed = 0;
let failed = 0;

const test = (name: string, run: () => void): void => {
    try {
        run();
        passed += 1;
        console.log(`✓ ${name}`);
    } catch (error: unknown) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`✗ ${name}\n  ${message}`);
    }
};

const sum = (left: number, right: number): number => left + right;
const min = (left: number, right: number): number => Math.min(left, right);
const max = (left: number, right: number): number => Math.max(left, right);
const concatenate = (left: string, right: string): string => left + right;

const gcd = (left: number, right: number): number => {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }
    return a;
};

const createRandom = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};

const nodeKinds = <T>(nodes: Iterable<AstNode<T>>): string[] => [...nodes].map((node) => node.kind);

const makeNumberTree = (): AbstractSyntaxTree<number> => {
    const a = AbstractSyntaxTree.leaf<number>("a", 1, {
        start: 0,
        end: 1,
        source: "sample",
    });
    const b1 = AbstractSyntaxTree.leaf<number>("b1", 2, {
        start: 3,
        end: 4,
        source: "sample",
    });
    const b2 = AbstractSyntaxTree.leaf<number>("b2", 3, {
        start: 4,
        end: 5,
        source: "sample",
    });
    const b = AbstractSyntaxTree.branch<number>("b", [b1.root, b2.root], 0, { start: 2, end: 5, source: "sample" });
    const c = AbstractSyntaxTree.leaf<number>("c", 4, {
        start: 6,
        end: 7,
        source: "sample",
    });
    return AbstractSyntaxTree.branch<number>("root", [a.root, b.root, c.root], 0, { start: 0, end: 8, source: "sample" });
};

const PREORDER = ["root", "a", "b", "b1", "b2", "c"];
const POSTORDER = ["a", "b1", "b2", "b", "c", "root"];
const LEVELORDER = ["root", "a", "b", "c", "b1", "b2"];

test("segment tree initializes, reads, sets, and updates sum leaves", () => {
    const tree = new SegmentTree<number>({
        size: 5,
        operation: sum,
        identity: 0,
        values: [1, 2, 3, 4, 5],
    });
    assert.equal(tree.size, 5);
    assert.deepEqual(tree.toArray(), [1, 2, 3, 4, 5]);
    assert.equal(tree.get(0), 1);
    assert.equal(tree.get(4), 5);

    tree.set(2, 10);
    assert.equal(tree.get(2), 10);
    assert.equal(tree.query(0, 5), 22);

    let observed = -1;
    tree.update(4, (previous) => {
        observed = previous;
        return previous + 10;
    });
    assert.equal(observed, 5);
    assert.equal(tree.get(4), 15);
    assert.equal(tree.queryAll(), 32);
    assert.deepEqual(tree.toArray(), [1, 2, 10, 4, 15]);

    const identityFilled = new SegmentTree<number>({
        size: 4,
        operation: sum,
        identity: 0,
    });
    assert.deepEqual(identityFilled.toArray(), [0, 0, 0, 0]);
    identityFilled.set(1, 7);
    assert.equal(identityFilled.queryAll(), 7);
});

test("segment tree sum range queries include empty and full ranges", () => {
    const tree = new SegmentTree<number>({
        size: 6,
        operation: sum,
        identity: 0,
        values: [1, 2, 3, 4, 5, 6],
    });
    assert.equal(tree.query(0, 6), 21);
    assert.equal(tree.queryAll(), 21);
    assert.equal(tree.query(1, 4), 9);
    assert.equal(tree.query(0, 4), 10);
    assert.equal(tree.query(2, 6), 18);
    assert.equal(tree.query(0, 1), 1);
    assert.equal(tree.query(5, 6), 6);
    assert.equal(tree.query(0, 0), 0);
    assert.equal(tree.query(2, 2), 0);
    assert.equal(tree.query(6, 6), 0);
});

test("segment tree min queries use the identity for empty ranges", () => {
    const tree = new SegmentTree<number>({
        size: 7,
        operation: min,
        identity: Number.POSITIVE_INFINITY,
        values: [5, 3, 8, 1, 9, 2, 7],
    });
    assert.equal(tree.query(0, 7), 1);
    assert.equal(tree.queryAll(), 1);
    assert.equal(tree.query(0, 4), 1);
    assert.equal(tree.query(0, 3), 3);
    assert.equal(tree.query(4, 7), 2);
    assert.equal(tree.query(3, 4), 1);
    assert.equal(tree.query(2, 2), Number.POSITIVE_INFINITY);
    tree.update(3, (previous) => previous + 10);
    assert.equal(tree.query(0, 4), 3);
    assert.equal(tree.query(3, 4), 11);
});

test("segment tree max queries track point replacements", () => {
    const tree = new SegmentTree<number>({
        size: 5,
        operation: max,
        identity: Number.NEGATIVE_INFINITY,
        values: [4, 1, 7, 3, 6],
    });
    assert.equal(tree.query(0, 5), 7);
    assert.equal(tree.queryAll(), 7);
    assert.equal(tree.query(1, 4), 7);
    assert.equal(tree.query(3, 5), 6);
    assert.equal(tree.query(0, 0), Number.NEGATIVE_INFINITY);
    tree.set(2, 0);
    assert.equal(tree.query(0, 3), 4);
    assert.equal(tree.query(2, 5), 6);
});

test("segment tree gcd queries combine values and track updates", () => {
    const tree = new SegmentTree<number>({
        size: 5,
        operation: gcd,
        identity: 0,
        values: [12, 18, 24, 5, 10],
    });
    assert.equal(tree.query(0, 3), 6);
    assert.equal(tree.query(2, 5), 1);
    assert.equal(tree.query(0, 5), 1);
    assert.equal(tree.queryAll(), 1);
    assert.equal(tree.query(1, 2), 18);
    assert.equal(tree.query(3, 3), 0);
    tree.update(3, () => 30);
    assert.equal(tree.query(0, 4), 6);
    assert.equal(tree.queryAll(), 2);
});

test("segment tree preserves left-to-right order for string concatenation", () => {
    const tree = new SegmentTree<string>({
        size: 5,
        operation: concatenate,
        identity: "",
        values: ["a", "b", "c", "d", "e"],
    });
    assert.equal(tree.query(0, 3), "abc");
    assert.equal(tree.query(1, 4), "bcd");
    assert.equal(tree.query(2, 5), "cde");
    assert.equal(tree.query(0, 5), "abcde");
    assert.equal(tree.queryAll(), "abcde");
    assert.equal(tree.query(2, 2), "");
    assert.equal(tree.query(3, 3), "");
    assert.notEqual(tree.query(0, 3), "cba");

    tree.set(1, "B");
    assert.equal(tree.query(0, 3), "aBc");
    tree.update(2, (previous) => `[${previous}]`);
    assert.equal(tree.query(0, 4), "aB[c]d");
    assert.equal(tree.query(1, 2), "B");
});

test("segment tree validates leaf indices and query bounds", () => {
    const tree = new SegmentTree<number>({
        size: 4,
        operation: sum,
        identity: 0,
        values: [1, 2, 3, 4],
    });
    assert.throws(() => tree.get(-1), {
        name: "RangeError",
        message: /index must be a safe integer/,
    });
    assert.throws(() => tree.get(4), RangeError);
    assert.throws(() => tree.get(1.5), RangeError);
    assert.throws(() => tree.set(-1, 0), RangeError);
    assert.throws(() => tree.set(4, 0), RangeError);
    assert.throws(() => tree.update(2.5, (previous) => previous), RangeError);
    assert.throws(() => tree.query(-1, 2), {
        name: "RangeError",
        message: /0 <= left <= right <= 4/,
    });
    assert.throws(() => tree.query(0, 5), RangeError);
    assert.throws(() => tree.query(3, 2), RangeError);
    assert.throws(() => tree.query(1.5, 2), RangeError);
    assert.throws(() => tree.query(0, Number.NaN), RangeError);
    assert.throws(() => tree.query(0, Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => tree.query(Number.NaN, 0), RangeError);
    assert.throws(() => new SegmentTree<number>({ size: -1, operation: sum, identity: 0 }), {
        name: "RangeError",
        message: /size must be a non-negative safe integer/,
    });
    assert.throws(() => new SegmentTree<number>({ size: 1.5, operation: sum, identity: 0 }), RangeError);
    assert.throws(
        () =>
            new SegmentTree<number>({
                size: Number.MAX_SAFE_INTEGER + 1,
                operation: sum,
                identity: 0,
            }),
        RangeError,
    );
});

test("segment tree rejects value counts that do not match size", () => {
    assert.throws(
        () =>
            new SegmentTree<number>({
                size: 3,
                operation: sum,
                identity: 0,
                values: [1, 2],
            }),
        {
            name: "RangeError",
            message: /values must contain exactly 3 values, received 2/,
        },
    );
    assert.throws(
        () =>
            new SegmentTree<number>({
                size: 3,
                operation: sum,
                identity: 0,
                values: [1, 2, 3, 4],
            }),
        RangeError,
    );
    assert.throws(
        () =>
            new SegmentTree<number>({
                size: 0,
                operation: sum,
                identity: 0,
                values: [1],
            }),
        RangeError,
    );
    const emptyWithValues = new SegmentTree<number>({
        size: 0,
        operation: sum,
        identity: 0,
        values: [],
    });
    assert.deepEqual(emptyWithValues.toArray(), []);
});

test("segment tree supports size zero", () => {
    const empty = new SegmentTree<number>({
        size: 0,
        operation: sum,
        identity: 0,
    });
    assert.equal(empty.size, 0);
    assert.deepEqual(empty.toArray(), []);
    assert.equal(empty.query(0, 0), 0);
    assert.equal(empty.queryAll(), 0);
    empty.clear();
    assert.equal(empty.queryAll(), 0);
    assert.throws(() => empty.get(0), RangeError);
    assert.throws(() => empty.set(0, 1), RangeError);
    assert.throws(() => empty.update(0, (previous) => previous + 1), RangeError);
    assert.throws(() => empty.query(0, 1), RangeError);
});

test("segment tree clear resets all leaves and remains usable", () => {
    const tree = new SegmentTree<number>({
        size: 6,
        operation: sum,
        identity: 0,
        values: [1, 2, 3, 4, 5, 6],
    });
    tree.clear();
    assert.equal(tree.size, 6);
    assert.deepEqual(tree.toArray(), [0, 0, 0, 0, 0, 0]);
    assert.equal(tree.queryAll(), 0);
    assert.equal(tree.query(0, 6), 0);
    assert.equal(tree.get(3), 0);

    tree.set(2, 5);
    assert.equal(tree.get(2), 5);
    assert.equal(tree.queryAll(), 5);
    assert.equal(tree.query(0, 3), 5);

    const text = new SegmentTree<string>({
        size: 4,
        operation: concatenate,
        identity: "",
        values: ["a", "b", "c", "d"],
    });
    text.clear();
    assert.equal(text.queryAll(), "");
    text.set(1, "B");
    assert.equal(text.query(0, 3), "B");
});

test("segment tree matches naive sum and min over 10,000 deterministic operations", () => {
    const size = 23;
    const random = createRandom(0x5eed);
    const values: number[] = [];
    for (let index = 0; index < size; index += 1) {
        values.push(Math.floor(random() * 41) - 20);
    }

    const sumTree = new SegmentTree<number>({
        size,
        operation: sum,
        identity: 0,
        values,
    });
    const minTree = new SegmentTree<number>({
        size,
        operation: min,
        identity: Number.POSITIVE_INFINITY,
        values,
    });

    for (let operation = 0; operation < 10_000; operation += 1) {
        const choice = random();
        const index = Math.floor(random() * size);

        if (choice < 0.45) {
            const value = Math.floor(random() * 41) - 20;
            values[index] = value;
            sumTree.set(index, value);
            minTree.set(index, value);
            continue;
        }

        if (choice < 0.75) {
            const delta = Math.floor(random() * 11) - 5;
            values[index] += delta;
            sumTree.update(index, (previous) => previous + delta);
            minTree.update(index, (previous) => previous + delta);
            continue;
        }

        let left = Math.floor(random() * (size + 1));
        let right = Math.floor(random() * (size + 1));
        if (left > right) {
            const swap = left;
            left = right;
            right = swap;
        }

        let expectedSum = 0;
        let expectedMin = Number.POSITIVE_INFINITY;
        for (let cursor = left; cursor < right; cursor += 1) {
            expectedSum += values[cursor];
            expectedMin = Math.min(expectedMin, values[cursor]);
        }

        assert.equal(sumTree.query(left, right), expectedSum);
        assert.equal(minTree.query(left, right), expectedMin);
    }

    assert.deepEqual(sumTree.toArray(), values);
    assert.deepEqual(minTree.toArray(), values);
});

test("AST leaf and branch helpers build the documented shape", () => {
    const leafSpan: SourceSpan = { start: 2, end: 5, source: "input" };
    const leaf = AbstractSyntaxTree.leaf("token", "value", leafSpan);
    assert.equal(leaf.root.kind, "token");
    assert.equal(leaf.root.value, "value");
    assert.deepEqual(leaf.root.children, []);
    assert.deepEqual(leaf.root.span, leafSpan);
    assert.equal(leaf.size, 1);

    const left = AbstractSyntaxTree.leaf<number>("left", 1);
    const right = AbstractSyntaxTree.leaf<number>("right", 2);
    const branch = AbstractSyntaxTree.branch<number>("sum", new Set([left.root, right.root]), 10, { start: 0, end: 2, source: "input" });
    assert.equal(branch.root.kind, "sum");
    assert.equal(branch.root.value, 10);
    assert.deepEqual(branch.root.children, [left.root, right.root]);
    assert.deepEqual(branch.root.span, { start: 0, end: 2, source: "input" });

    const manual: AstNode<number> = {
        kind: "manual",
        children: [{ kind: "inner", children: [] }],
    };
    const wrapped = new AbstractSyntaxTree(manual);
    assert.equal(wrapped.root, manual);
    assert.equal(wrapped.size, 2);
});

test("AST size, height, and leaves describe the tree", () => {
    const tree = makeNumberTree();
    assert.equal(tree.size, 6);
    assert.equal(tree.height, 3);
    assert.equal(tree.leaves, 4);

    const leaf = AbstractSyntaxTree.leaf("only");
    assert.equal(leaf.size, 1);
    assert.equal(leaf.height, 1);
    assert.equal(leaf.leaves, 1);

    const empty = AbstractSyntaxTree.branch("empty", []);
    assert.equal(empty.size, 1);
    assert.equal(empty.height, 1);
    assert.equal(empty.leaves, 1);
});

test("AST walks preorder, postorder, and level order", () => {
    const tree = makeNumberTree();
    assert.deepEqual(nodeKinds(tree.walk()), PREORDER);
    assert.deepEqual(nodeKinds(tree.walk("preorder")), PREORDER);
    assert.deepEqual(nodeKinds(tree.walk("postorder")), POSTORDER);
    assert.deepEqual(nodeKinds(tree.walk("levelorder")), LEVELORDER);
});

test("AST find and findAll respect preorder", () => {
    const tree = makeNumberTree();
    const found = tree.find((node) => node.kind === "b1");
    assert.ok(found);
    assert.equal(found.value, 2);
    assert.equal(
        tree.find((node) => node.kind === "missing"),
        undefined,
    );
    assert.deepEqual(nodeKinds(tree.findAll((node) => node.kind === "a" || node.kind.startsWith("b"))), ["a", "b", "b1", "b2"]);
});

test("AST map runs post-order with mapped children and does not mutate the original", () => {
    const tree = makeNumberTree();
    const snapshot = tree.toJSON();
    const calls: Array<{ kind: string; childKinds: string[] }> = [];

    const mapped = tree.map<number>((node, children) => {
        calls.push({
            kind: node.kind,
            childKinds: children.map((child) => child.kind),
        });
        const ownValue = node.value ?? 0;
        const childTotal = children.reduce((total, child) => total + (child.value ?? 0), 0);
        const result: AstNode<number> = {
            kind: `mapped:${node.kind}`,
            value: ownValue + childTotal,
            children,
        };
        if (node.span !== undefined) {
            result.span = { ...node.span };
        }
        return result;
    });

    assert.deepEqual(calls, [
        { kind: "a", childKinds: [] },
        { kind: "b1", childKinds: [] },
        { kind: "b2", childKinds: [] },
        { kind: "b", childKinds: ["mapped:b1", "mapped:b2"] },
        { kind: "c", childKinds: [] },
        {
            kind: "root",
            childKinds: ["mapped:a", "mapped:b", "mapped:c"],
        },
    ]);
    assert.equal(mapped.root.kind, "mapped:root");
    assert.equal(mapped.root.value, 10);
    assert.equal(mapped.size, 6);
    assert.equal(mapped.height, 3);
    assert.deepEqual(tree.toJSON(), snapshot);
});

test("AST clone copies nodes and spans deeply while sharing values", () => {
    const tree = makeNumberTree();
    const clone = tree.clone();
    assert.notEqual(clone.root, tree.root);
    assert.notEqual(clone.root.children, tree.root.children);
    assert.notEqual(clone.root.children[0], tree.root.children[0]);
    assert.notEqual(clone.root.span, tree.root.span);
    assert.notEqual(clone.root.children[0].span, tree.root.children[0].span);
    assert.equal(clone.equals(tree), true);
    assert.deepEqual(clone.toJSON(), tree.toJSON());

    const cloneSpan = clone.root.span;
    const originalSpan = tree.root.span;
    assert.ok(cloneSpan);
    assert.ok(originalSpan);
    cloneSpan.start = 99;
    clone.root.kind = "mutated";
    clone.root.children.length = 0;
    assert.equal(tree.root.kind, "root");
    assert.equal(originalSpan.start, 0);
    assert.equal(tree.root.children.length, 3);
    assert.equal(tree.size, 6);

    const payload = { count: 1 };
    const single = AbstractSyntaxTree.leaf("object", payload);
    const payloadClone = single.clone();
    assert.equal(payloadClone.root.value, payload);
});

test("AST equals compares kind, value, span, and child order", () => {
    const tree = makeNumberTree();
    assert.equal(tree.equals(makeNumberTree()), true);
    assert.equal(tree.equals(tree.clone()), true);

    const kindClone = tree.clone();
    kindClone.root.kind = "other";
    assert.equal(tree.equals(kindClone), false);

    const valueClone = tree.clone();
    valueClone.root.value = 1;
    assert.equal(tree.equals(valueClone), false);

    const spanClone = tree.clone();
    const span = spanClone.root.span;
    assert.ok(span);
    span.end += 1;
    assert.equal(tree.equals(spanClone), false);

    const reordered = tree.clone();
    const children = reordered.root.children;
    const first = children[0];
    children[0] = children[1];
    children[1] = first;
    assert.equal(tree.equals(reordered), false);

    const fewer = tree.clone();
    fewer.root.children.pop();
    assert.equal(tree.equals(fewer), false);

    assert.equal(AbstractSyntaxTree.leaf("nan", Number.NaN).equals(AbstractSyntaxTree.leaf("nan", Number.NaN)), true);
    assert.equal(AbstractSyntaxTree.leaf("zero", 0).equals(AbstractSyntaxTree.leaf("zero", -0)), false);
});

test("AST toJSON returns a plain deep copy with preserved spans", () => {
    const tree = makeNumberTree();
    const json = tree.toJSON();
    assert.notEqual(json, tree.root);
    assert.notEqual(json.children, tree.root.children);
    assert.notEqual(json.span, tree.root.span);
    assert.notEqual(json.children[0], tree.root.children[0]);
    assert.deepEqual(json, tree.root);
    assert.equal(Object.getPrototypeOf(json), Object.prototype);
    const jsonSpan = json.span;
    assert.ok(jsonSpan);
    assert.equal(Object.getPrototypeOf(jsonSpan), Object.prototype);
    assert.deepEqual(jsonSpan, tree.root.span);
    assert.equal(json.children[1].span?.source, "sample");

    json.children.length = 0;
    assert.equal(tree.root.children.length, 3);
    const roundTrip = JSON.parse(JSON.stringify(json)) as AstNode<number>;
    assert.deepEqual(roundTrip, json);
});

test("AST traversal preserves every source span under clone and toJSON", () => {
    const tree = makeNumberTree();
    const originalSpans = [...tree.walk()].map((node) => node.span);
    const clonedSpans = [...tree.clone().walk()].map((node) => node.span);
    const jsonSpans = [...new AbstractSyntaxTree(tree.toJSON()).walk()].map((node) => node.span);
    assert.deepEqual(clonedSpans, originalSpans);
    assert.deepEqual(jsonSpans, originalSpans);
});

test("AST helpers reject empty kinds while the constructor stays permissive", () => {
    assert.throws(() => AbstractSyntaxTree.leaf(""), {
        name: "TypeError",
        message: /kind must be a non-empty string/,
    });
    assert.throws(() => AbstractSyntaxTree.branch("", []), {
        name: "TypeError",
        message: /kind must be a non-empty string/,
    });
    assert.doesNotThrow(() => new AbstractSyntaxTree<number>({ kind: "", children: [] }));
});

test("AST Symbol.iterator walks preorder", () => {
    const tree = makeNumberTree();
    assert.deepEqual(nodeKinds(tree), PREORDER);
    assert.deepEqual(nodeKinds(tree), nodeKinds(tree.walk("preorder")));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
