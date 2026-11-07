import assert from "node:assert/strict";
import test from "node:test";
import { validateMindMap } from "./mindmap.ts";
import type { MindMapEdge, MindMapGraph, MindMapLimits, MindMapNode, MindMapViolation } from "./mindmap.ts";

const limits = (overrides: Partial<MindMapLimits> = {}): MindMapLimits => ({
    maxDepth: 3,
    maxSiblings: 4,
    maxEdges: 4,
    ...overrides,
});

const node = (id: string, overrides: Partial<MindMapNode> = {}): MindMapNode => ({
    id,
    topic: id,
    type: "topic",
    ...overrides,
});

const edge = (from: string, to: string, overrides: Partial<MindMapEdge> = {}): MindMapEdge => ({
    from,
    to,
    kind: "related",
    reason: "shared topic",
    ...overrides,
});

const graph = (nodes: readonly MindMapNode[], overrides: Omit<Partial<MindMapGraph>, "nodes"> = {}): MindMapGraph => ({
    center: "root",
    nodes,
    edges: [],
    ...overrides,
});

const rules = (result: ReturnType<typeof validateMindMap>): string[] => result.violations.map(item => item.rule);

const anchored = (objectId: string, versionHash?: string): MindMapNode["anchor"] =>
    versionHash === undefined ? { objectType: "file", objectId } : { objectType: "file", objectId, versionHash };

test("a valid mind map passes every hard constraint", () => {
    const result = validateMindMap(graph([
        node("root", { type: "topic", children: ["a", "b"], anchor: anchored("ROOT.md") }),
        node("a", { type: "subtopic", summary: "Alpha", children: ["a1"], anchor: anchored("src/a.ts", "h1") }),
        node("a1", { type: "leaf", anchor: anchored("src/a1.ts") }),
        node("b", { type: "reference", summary: "Beta", anchor: anchored("src/b.ts", "h2") }),
    ], { edges: [edge("a", "b", { kind: "supports" })] }), limits());

    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
    assert.equal(Object.isFrozen(result), true);
});

test("the center must exist", () => {
    const result = validateMindMap(graph([node("root"), node("a")], { center: "ghost" }), limits());
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("center_exists"));

    const empty = validateMindMap(graph([node("root")], { center: "" }), limits());
    assert.equal(empty.ok, false);
    assert.ok(rules(empty).includes("center_exists"));
});

test("node ids must be unique so the center stays unique", () => {
    const result = validateMindMap(graph([node("root", { children: ["a"] }), node("a"), node("a")]), limits());
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("node_id_duplicate"));
});

test("parent-child edges must be acyclic", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a"] }),
        node("a", { children: ["root"] }),
    ]), limits());
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("parent_child_cycle"));
});

test("depth may not exceed maxDepth", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a"] }),
        node("a", { children: ["b"] }),
        node("b"),
    ]), limits({ maxDepth: 1 }));
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("max_depth"));
    assert.equal(result.violations.find(item => item.rule === "max_depth")?.subject, "b");
});

test("every node must declare an anchor with non-empty objectType and objectId", () => {
    const missing = validateMindMap(graph([
        node("root", { children: ["a"], anchor: anchored("ROOT.md") }),
        node("a"),
    ]), limits());
    assert.equal(missing.ok, false);
    assert.ok(rules(missing).includes("anchor_missing"));
    assert.equal(missing.violations.find(item => item.rule === "anchor_missing")?.subject, "a");

    const incomplete = validateMindMap(graph([
        node("root", { children: ["a"], anchor: anchored("ROOT.md") }),
        node("a", { anchor: { objectType: "file", objectId: "   " } }),
    ]), limits());
    assert.equal(incomplete.ok, false);
    assert.ok(rules(incomplete).includes("anchor_missing"));
});

test("association edges must carry a reason", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a"] }),
        node("a"),
    ], { edges: [edge("root", "a", { reason: "  " })] }), limits());
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("edge_reason_missing"));
});

test("association edge count may not exceed maxEdges", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a", "b"] }),
        node("a"),
        node("b"),
    ], { edges: [edge("root", "a"), edge("root", "b")] }), limits({ maxEdges: 1 }));
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("max_edges"));
});

test("siblings may not exceed maxSiblings", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a", "b", "c"] }),
        node("a"),
        node("b"),
        node("c"),
    ]), limits({ maxSiblings: 2 }));
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("max_siblings"));
    assert.equal(result.violations.find(item => item.rule === "max_siblings")?.subject, "root");
});

test("nodes sharing an anchor must agree on its version hash", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a", "b"] }),
        node("a", { anchor: anchored("src/a.ts", "h1") }),
        node("b", { anchor: anchored("src/a.ts", "h2") }),
    ]), limits());
    assert.equal(result.ok, false);
    assert.ok(rules(result).includes("anchor_hash_mismatch"));
});

test("duplicate sibling summaries are soft warnings: reported but still ok", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a", "b"], summary: "root", anchor: anchored("ROOT.md") }),
        node("a", { summary: "Same summary", anchor: anchored("src/a.ts") }),
        node("b", { summary: "Same summary", anchor: anchored("src/b.ts") }),
    ]), limits());

    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.rule, "sibling_summary_duplicate");
    assert.equal(result.violations[0]?.subject, "root");
});

test("the validation result, its array and each violation are frozen", () => {
    const result = validateMindMap(graph([
        node("root", { children: ["a", "b"], anchor: anchored("ROOT.md") }),
        node("a", { summary: "Same summary", anchor: anchored("src/a.ts") }),
        node("b", { summary: "Same summary", anchor: anchored("src/b.ts") }),
    ]), limits());

    assert.equal(result.ok, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.violations), true);
    for (const violation of result.violations) assert.equal(Object.isFrozen(violation), true);
    assert.throws(() => (result.violations as MindMapViolation[]).push({
        rule: "fake", subject: "x", message: "x",
    }), TypeError);
});

test("freshness is optional and must be a finite number between 0 and 1", () => {
    const graphWithFreshness = (freshness: number): MindMapGraph => graph([
        node("root", { children: ["a"], anchor: anchored("ROOT.md") }),
        node("a", { anchor: anchored("src/a.ts") }),
    ], { freshness });

    for (const freshness of [0, 0.25, 0.5, 1]) {
        assert.equal(validateMindMap(graphWithFreshness(freshness), limits()).ok, true, String(freshness));
    }
    for (const freshness of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const result = validateMindMap(graphWithFreshness(freshness), limits());
        assert.equal(result.ok, false, String(freshness));
        assert.ok(rules(result).includes("freshness_invalid"), String(freshness));
        assert.equal(result.violations.find(item => item.rule === "freshness_invalid")?.subject, "freshness");
    }
    const nonNumeric = validateMindMap(graph([
        node("root", { anchor: anchored("ROOT.md") }),
    ], { freshness: "0.5" as unknown as number }), limits());
    assert.equal(nonNumeric.ok, false);
    assert.ok(rules(nonNumeric).includes("freshness_invalid"));
});

test("anchor hashes must be non-empty and agree across nodes sharing an anchor", () => {
    const invalid = validateMindMap(graph([
        node("root", { children: ["a"], anchor: anchored("ROOT.md") }),
        node("a", { anchor: { objectType: "file", objectId: "src/a.ts", versionHash: "   " } }),
    ]), limits());
    assert.equal(invalid.ok, false);
    assert.ok(rules(invalid).includes("anchor_hash_invalid"));

    const consistent = validateMindMap(graph([
        node("root", { children: ["a", "b"], anchor: anchored("ROOT.md") }),
        node("a", { anchor: anchored("src/a.ts", "h1") }),
        node("b", { anchor: anchored("src/a.ts", "h1") }),
    ]), limits());
    assert.equal(consistent.ok, true, JSON.stringify(consistent.violations));
    assert.equal(consistent.violations.some(item => item.rule === "anchor_hash_mismatch"), false);

    const mismatch = validateMindMap(graph([
        node("root", { children: ["a", "b"], anchor: anchored("ROOT.md") }),
        node("a", { anchor: anchored("src/a.ts", "h1") }),
        node("b", { anchor: anchored("src/a.ts", "h2") }),
    ]), limits());
    assert.equal(mismatch.ok, false);
    assert.ok(rules(mismatch).includes("anchor_hash_mismatch"));
});
