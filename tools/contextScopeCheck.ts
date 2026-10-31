#!/usr/bin/env node
/**
 * Regression checks for Frame-scoped views and rendered prompt accounting.
 */
import assert from "node:assert/strict";

import { estimateTokens } from "../src/context/agentContext.ts";
import { ContextAst } from "../src/context/ast.ts";
import type { ContextAstNode, ContextAstView } from "../src/context/ast.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import { Context } from "../src/context/lifecycle.ts";
import type { Frame, Slot } from "../src/frame/frame.ts";

const Store: MemoryContentStore = new MemoryContentStore();
const DetailRef: string = Store.put("selected detail");
const OtherRef: string = Store.put("unselected detail");
const Graph: ContextAst = new ContextAst()
    .add({ id: "root", kind: "goal", summary: "goal", order: 0 })
    .add({ id: "chosen", parentId: "root", kind: "evidence", summary: "current evidence", order: 1, salience: 1 })
    .add({ id: "detail", parentId: "chosen", kind: "detail", summary: "detail", detailRef: DetailRef, order: 2 })
    .add({ id: "nested", parentId: "detail", kind: "detail", summary: "nested", detailRef: DetailRef, order: 3 })
    .add({ id: "other", parentId: "root", kind: "evidence", summary: "obsolete evidence", detailRef: OtherRef, order: 4, salience: 999 })
    .add({ id: "branch", parentId: "chosen", kind: "evidence", summary: "unallocated child", detailRef: OtherRef, order: 5 })
    .add({ id: "branch.detail", parentId: "branch", kind: "detail", summary: "unallocated detail", detailRef: OtherRef, order: 6 });

const makeSlot: (id: string, state?: Slot["state"]) => Slot = (id: string, state: Slot["state"] = "active"): Slot => ({
    target: { kind: "evidence", id },
    role: "evidence",
    salience: 1,
    cost: {},
    why: "scope regression",
    state,
});
const makeFrame: (slots: Slot[]) => Frame = (slots: Slot[]): Frame => ({
    amp: "0.1",
    kind: "frame",
    id: "f.scope",
    agent: "a.scope",
    cycle: 1,
    ts: "2026-10-29T00:00:00Z",
    digest: "0".repeat(64),
    mode: "triage",
    slots,
    budget: { allocated: { tokens: 200 }, spent: {} },
});
const Frame: Frame = makeFrame([makeSlot("chosen"), makeSlot("other", "released"), makeSlot("missing")]);
const Scoped: Context = Context.create(Frame, Graph, { store: Store });
Frame.slots[0].target.id = "other";
Frame.slots[0].state = "released";
Scoped.frame.slots.push(makeSlot("other"));
Scoped.frame.id = "changed";
const View: ReturnType<Context["materialize"]> = Scoped.materialize({ budgetTokens: 200 });
assert.equal(View.frameId, "f.scope");
assert.equal(Scoped.frame.slots[0].target.id, "chosen");
const ScopedSnapshot: ReturnType<Context["snapshot"]> = Scoped.snapshot();
ScopedSnapshot.view!.nodes[0].summary = "tampered";
ScopedSnapshot.view!.missingRefs[0].id = "tampered";
assert.equal(View.nodes[0].summary, "goal");
assert.equal(Graph.node("root")!.summary, "goal");
assert.equal(View.missingRefs[0].id, "missing");
assert.equal(Scoped.frame.slots[2].target.id, "missing");
assert.deepEqual(
    View.nodes.map((node) => node.id),
    ["root", "chosen"],
);
assert.deepEqual(
    View.missingRefs.map((ref) => ref.id),
    ["missing"],
);
assert.equal(View.deferred.length, 0);
assert.equal(Scoped.expand("detail"), "selected detail");
assert.equal(Scoped.expand("nested"), "selected detail");
["other", "branch", "branch.detail"].forEach((id: string): void => {
    assert.equal(Scoped.expand(id), (void 0));
});

(["released", "evicted", "done"] as const).forEach((state: Slot["state"]): void => {
    const context: Context = Context.create(makeFrame([makeSlot("other", state), makeSlot("absent", state)]), Graph, { store: Store });
    const view: ReturnType<Context["materialize"]> = context.materialize({ budgetTokens: 200 });
    assert.equal(view.text, "");
    assert.equal(view.tokens, 0);
    assert.equal(view.missingRefs.length, 0);
    assert.equal(context.expand("other"), (void 0));
});
const Empty: Context = Context.create(makeFrame([]), Graph, { store: Store });
assert.equal(Empty.materialize({ budgetTokens: 200 }).nodes.length, 0);
const Deferred: Context = Context.create(makeFrame([makeSlot("chosen")]), Graph, { store: Store });
assert.equal(Deferred.materialize({ budgetTokens: 1 }).nodes.length, 0);
assert.equal(Deferred.expand("detail"), (void 0));
const DeferredSnapshot: ReturnType<Context["snapshot"]> = Deferred.snapshot();
DeferredSnapshot.view!.deferred[0].summary = "tampered";
assert.notEqual(Deferred.view!.deferred[0].summary, "tampered");

/**
 * Graph dependencies may expose reference gaps but never extra content/expansion.
 */
Graph.link({ from: "other", to: "chosen", kind: "depends" });
const WithGap: Context = Context.create(makeFrame([makeSlot("chosen")]), Graph, { store: Store });
const GapView: ReturnType<Context["materialize"]> = WithGap.materialize({ budgetTokens: 200 });
assert.equal(GapView.unresolvedDependencies.length, 1);
assert.doesNotMatch(GapView.text, /obsolete evidence/);
assert.equal(WithGap.expand("other"), (void 0));
const GapSnapshot: ReturnType<Context["snapshot"]> = WithGap.snapshot();
GapSnapshot.view!.unresolvedDependencies[0].from = "tampered";
assert.equal(GapView.unresolvedDependencies[0].from, "other");

const DetailNode: ContextAstNode = Graph.node("detail") as ContextAstNode;
DetailNode.detailRef = OtherRef;
Frame.slots.push(makeSlot("other"));
Graph.add({ id: "late", parentId: "chosen", kind: "detail", summary: "late detail", detailRef: OtherRef, order: 7 });
assert.equal(Scoped.expand("detail"), "selected detail");
assert.equal(Scoped.expand("other"), (void 0));
assert.equal(Scoped.expand("late"), (void 0));

const Restored: ContextAst = ContextAst.restore(Graph.serialize());
assert.equal(Restored.view(200, ["chosen"]).text, Graph.view(200, ["chosen"]).text);
assert.ok(Graph.view(200).nodes.some((node) => node.id === "other"));

const LongGraph: ContextAst = new ContextAst().add({
    id: "id".repeat(100),
    kind: "evidence",
    summary: "x",
    detailRef: "ref".repeat(100),
    order: 0,
});
assert.equal(LongGraph.view(10).text, "");
const LongView: ContextAstView = LongGraph.view(500);
assert.equal(LongView.nodes.length, 1);
[View, LongView, Graph.view(200)].forEach((view: Pick<ContextAstView, "text" | "tokens" | "budgetTokens">): void => {
    assert.ok(view.tokens >= estimateTokens(view.text));
    assert.ok(view.tokens <= view.budgetTokens);
});

console.log("Frame scope, inactive slots, detail chains, deferred targets, captured refs, restore and rendered budgets: passed");
