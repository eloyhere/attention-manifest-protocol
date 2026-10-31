#!/usr/bin/env node
/**
 * Behavioral regressions for indexed Context graphs and the shared node table.
 */
import assert from "node:assert/strict";

import { ContextAst } from "../src/context/ast.ts";
import type { ContextAstEdge, ContextAstNode, ContextAstView } from "../src/context/ast.ts";
import { ContextIndex } from "../src/context/contextIndex.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import { estimateTokens } from "../src/context/agentContext.ts";

const node: (id: string, parentId?: string) => ContextAstNode = (id: string, parentId?: string): ContextAstNode => ({
    id,
    parentId,
    kind: "evidence",
    summary: id,
    order: 0,
});
const ids: (nodes: ContextAstNode[]) => string[] = (nodes: ContextAstNode[]): string[] => nodes.map((item) => item.id);

/**
 * Edge insertion order must survive mixed kinds, duplicate edges and restore.
 */
const Graph: ContextAst = new ContextAst().add(node("source")).add(node("a")).add(node("b")).add(node("c"));
Graph.link({ from: "source", to: "b", kind: "depends" });
Graph.link({ from: "source", to: "a", kind: "before" });
Graph.link({ from: "source", to: "c", kind: "depends" });
Graph.link({ from: "source", to: "a", kind: "before" });
Graph.link({ from: "a", to: "source", kind: "supports" });
Graph.link({ from: "c", to: "source", kind: "contradicts" });
Graph.link({ from: "c", to: "source", kind: "after" });
assert.deepEqual(ids(Graph.order()), ["source", "b", "c", "a"]);
assert.deepEqual(ids(Graph.order(["a", "source", "a", "absent"])), ["source", "a"]);
assert.deepEqual(Graph.order([]), []);
assert.equal(Graph.relations("source", "incoming", "supports")[0].from, "a");
assert.equal(Graph.relations("source", "incoming", "contradicts")[0].from, "c");
assert.equal(Graph.relations("source", "outgoing", "before").length, 2);
assert.equal(Graph.relations("source", "outgoing").length, 4);
assert.deepEqual(Graph.relations("missing", "incoming"), []);
const Edges: ContextAstEdge[] = Graph.relations("source", "outgoing", "depends");
Edges[0].to = "source";
assert.deepEqual(ids(Graph.order()), ["source", "b", "c", "a"]);
const Snapshot: ReturnType<ContextAst["serialize"]> = Graph.serialize();
const Restored: ContextAst = ContextAst.restore(Snapshot);
Snapshot.edges[0].to = "source";
Snapshot.nodes[0].summary = "changed snapshot";
assert.deepEqual(ids(Graph.order()), ids(Restored.order()));
assert.equal(Graph.node("source")?.summary, "source");
assert.deepEqual(Restored.relations("source", "outgoing"), Graph.relations("source", "outgoing"));

/**
 * An unrelated cycle cannot prevent a Frame-scoped view; an internal one must fail.
 */
const Scoped: ContextAst = new ContextAst().add(node("root")).add(node("chosen", "root")).add(node("x")).add(node("y"));
Scoped.link({ from: "x", to: "y", kind: "before" }).link({ from: "y", to: "x", kind: "depends" });
Scoped.link({ from: "x", to: "chosen", kind: "depends" });
assert.deepEqual(ids(Scoped.view(100, ["chosen"]).nodes), ["root", "chosen"]);
assert.equal(Scoped.view(100, []).text, "");
assert.throws(() => Scoped.order(), /precedence.*cycle/);
assert.throws(() => Scoped.view(100, ["x", "y"]), /precedence.*cycle/);
assert.deepEqual(ids(ContextAst.restore(Scoped.serialize()).view(100, ["chosen"]).nodes), ["root", "chosen"]);
const ExternalPath: ContextAst = new ContextAst().add(node("b")).add(node("a")).add(node("outside"));
ExternalPath.link({ from: "a", to: "outside", kind: "before" }).link({ from: "outside", to: "b", kind: "depends" });
assert.deepEqual(ids(ExternalPath.order()), ["a", "outside", "b"]);
assert.deepEqual(ids(ExternalPath.order(["a", "b"])), ["b", "a"]);

/**
 * Late parents are supported, but a rejected cycle leaves the graph unchanged.
 */
const Tree: ContextAst = new ContextAst().add(node("leaf", "middle")).add(node("middle", "root"));
assert.throws(() => Tree.add(node("root", "leaf")), /hierarchy.*cycle/);
assert.equal(Tree.size, 2);
assert.deepEqual(Tree.children("leaf"), []);
Tree.add(node("root"));
assert.deepEqual(ids(Tree.ancestors("leaf")), ["root", "middle"]);
assert.deepEqual(ids(Tree.descendants("root")), ["middle", "leaf"]);
assert.throws(() => new ContextAst().add(node("self", "self")), /hierarchy.*cycle/);
assert.throws(() => ContextAst.restore({ nodes: [node("a", "b"), node("b", "a")], edges: [] }), /hierarchy.*cycle/);
assert.equal(Reflect.set(Tree.node("middle")!, "parentId", "leaf"), false);
assert.equal(Reflect.set(Tree.node("middle")!, "id", "renamed"), false);
assert.deepEqual(ids(Tree.children("root")), ["middle"]);

/**
 * Caches last one view: live summaries and detail refs are re-read next time.
 */
const Before: string = Tree.view(200, ["leaf"]).text;
Tree.node("middle")!.summary = "updated middle";
assert.notEqual(Tree.view(200, ["leaf"]).text, Before);
assert.match(Tree.view(200, ["leaf"]).text, /    - \[evidence\] leaf/);

/**
 * Wrapping an existing AST and adding directly to it must never create two truths.
 */
const Store: MemoryContentStore = new MemoryContentStore();
const FirstRef: string = Store.put("first");
const SecondRef: string = Store.put("second");
const Existing: ContextAst = new ContextAst().add({ ...node("existing"), detailRef: FirstRef });
const Index: ContextIndex = new ContextIndex(Existing, { store: Store });
assert.equal(Index.node("existing"), Existing.node("existing"));
assert.equal(Index.getDetail("existing"), "first");
Existing.node("existing")!.detailRef = SecondRef;
assert.equal(Index.getDetail("existing"), "second");
Existing.add(node("direct"));
assert.equal(Index.stats().nodes, 2);
assert.equal(Index.node("direct"), Existing.node("direct"));
assert.deepEqual(ids(Index.view(200, ["existing"]).nodes), ["existing"]);
const Added: ContextAstNode = Index.add(node("added"), "third");
assert.equal(Added, Existing.node("added"));
Added.summary = "shared update";
assert.match(Index.view(200, ["added"]).text, /shared update/);
const ContentCount: number = Store.size();
assert.throws(() => Index.add(node("existing"), "must not be written"), /duplicate/);
assert.equal(Store.size(), ContentCount);

/**
 * A highly salient child cannot consume budget without its structural context.
 */
const Bundled: ContextAst = new ContextAst()
    .add({ ...node("large"), summary: "large ancestor ".repeat(100) })
    .add({ ...node("leaf", "large"), salience: 10 })
    .add(node("independent"));
const Tight: ContextAstView = Bundled.view(40, ["leaf", "independent"]);
assert.deepEqual(ids(Tight.nodes), ["independent"]);
assert.equal(Tight.omissions.find((item) => item.id === "leaf")?.reason, "budget");
assert.ok(Tight.omissions.find((item) => item.id === "leaf")?.requiredIds.includes("large"));

/**
 * In-scope prerequisites are indivisible from the dependent, including edge cost.
 */
const Dependent: ContextAst = new ContextAst().add(node("source")).add({ ...node("decision"), salience: 10 });
Dependent.link({ from: "source", to: "decision", kind: "depends" });
const Complete: ContextAstView = Dependent.view(1000);
assert.deepEqual(ids(Complete.nodes), ["source", "decision"]);
assert.match(Complete.text, /\[relation:depends\] "source" -> "decision"/);
assert.deepEqual(ids(Dependent.view(Complete.tokens - 1).nodes), ["source"]);
assert.ok(Complete.tokens >= estimateTokens(Complete.text));

/**
 * Support and contradiction survive rendering, without inferring truth or widening scope.
 */
const Related: ContextAst = new ContextAst().add(node("support")).add(node("conclusion")).add(node("counter"));
Related.link({ from: "support", to: "conclusion", kind: "supports" });
Related.link({ from: "counter", to: "conclusion", kind: "contradicts" });
Related.link({ from: "counter", to: "conclusion", kind: "contradicts" });
const RelatedView: ContextAstView = Related.view(1000);
assert.equal(RelatedView.relations.length, 2);
assert.match(RelatedView.text, /relation:supports/);
assert.match(RelatedView.text, /relation:contradicts/);
RelatedView.relations[0].from = "tampered";
assert.equal(Related.view(1000).relations[0].from, "support");
assert.equal(Related.view(1000, ["conclusion"]).relations.length, 0);

/**
 * An unallocated prerequisite is an explicit reference gap, never loaded content.
 */
const Boundary: ContextAst = new ContextAst()
    .add({ ...node("secret"), summary: "UNALLOCATED CONTENT", detailRef: "private.ref", salience: 999 })
    .add(node("chosen"));
Boundary.link({ from: "secret", to: "chosen", kind: "depends" });
const BoundaryView: ContextAstView = Boundary.view(1000, ["chosen"]);
assert.deepEqual(ids(BoundaryView.nodes), ["chosen"]);
assert.equal(BoundaryView.unresolvedDependencies.length, 1);
assert.match(BoundaryView.text, /outside_scope; prerequisite unavailable/);
assert.doesNotMatch(BoundaryView.text, /UNALLOCATED CONTENT|private.ref/);
assert.deepEqual(Boundary.view(BoundaryView.tokens - 1, ["chosen"]).nodes, []);
BoundaryView.unresolvedDependencies[0].from = "tampered";
assert.equal(Boundary.view(1000, ["chosen"]).unresolvedDependencies[0].from, "secret");

/**
 * Late structural parents defer the child explicitly, then become usable on rebuild.
 */
const Incomplete: ContextAst = new ContextAst().add(node("child", "absent"));
assert.deepEqual(Incomplete.view(1000).nodes, []);
assert.deepEqual(Incomplete.view(1000).omissions, [{ id: "child", reason: "missing_parent", requiredIds: ["absent"] }]);
Incomplete.add(node("absent"));
assert.equal(Incomplete.view(1000).nodes.length, 2);

/**
 * Independent closure/edge audits across budgets catch partially accepted bundles.
 */
const Audit: ContextAst = new ContextAst().add(node("root"));
const AuditEdges: ContextAstEdge[] = [];
for (let index: number = 0; index < 32; index += 1) {
    Audit.add({ ...node(`n.${index}`, "root"), salience: (index * 7) % 11 });
    if (index > 0) {
        const edge: ContextAstEdge = {
            from: `n.${index - 1}`,
            to: `n.${index}`,
            kind: index % 3 === 0 ? "depends" : index % 3 === 1 ? "supports" : "contradicts",
        };
        Audit.link(edge);
        AuditEdges.push(edge);
    }
}
for (let budget: number = 1; budget < 1100; budget += 23) {
    const view: ContextAstView = Audit.view(budget);
    const chosen: Set<string> = new Set(ids(view.nodes));
    assert.ok(view.tokens <= budget && view.tokens >= (view.text.length === 0 ? 0 : estimateTokens(view.text)));
    assert.equal(view.omissions.length, view.excluded.length);
    view.nodes.forEach((member: ContextAstNode): void => {
        if (member.parentId) {
            assert.ok(chosen.has(member.parentId));
        }
    });
    AuditEdges.forEach((edge: ContextAstEdge): void => {
        if (edge.kind === "depends" && chosen.has(edge.to)) {
            assert.ok(chosen.has(edge.from));
        }
    });
    const expected: ContextAstEdge[] = AuditEdges.filter((edge: ContextAstEdge): boolean => chosen.has(edge.from) && chosen.has(edge.to));
    const key: (edge: ContextAstEdge) => string = (edge: ContextAstEdge): string => JSON.stringify(edge);
    assert.deepEqual(new Set(view.relations.map(key)), new Set(expected.map(key)));
    assert.deepEqual(ContextAst.restore(Audit.serialize()).view(budget), view);
}

/**
 * Dependency closure itself must also be iterative for a deep selected chain.
 */
const Deep: ContextAst = new ContextAst();
for (let index: number = 0; index < 2500; index += 1) {
    Deep.add({ ...node(`${index}`), salience: index === 2499 ? 10 : 0 });
    if (index > 0) {
        Deep.link({ from: `${index - 1}`, to: `${index}`, kind: "depends" });
    }
}
assert.equal(Deep.view(1000000).nodes.length, 2500);

console.log("Indexed scopes, shared ownership, atomic bundles, explicit relations, dependency gaps, budget audits and deep closure: passed");
