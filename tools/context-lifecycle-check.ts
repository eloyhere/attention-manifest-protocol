#!/usr/bin/env node
/** Single Context lifecycle: Frame -> materialize -> active -> settle -> compact -> archive. */
import assert from "node:assert/strict";

import { Context } from "../src/context/lifecycle.ts";
import { ContextAst } from "../src/context/ast.ts";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { Frame, Slot } from "../src/frame/frame.ts";
import type { Receipt } from "../src/receipt/receipt.ts";

const At = "2026-10-24T00:00:00.000Z";
const slot = (id: string): Slot => ({
    target: { kind: "evidence", id },
    role: "evidence",
    salience: 0.8,
    cost: { tokens: 20 },
    why: `evidence ${id}`,
    state: "active",
});
const frame: Frame = {
    amp: "0.1",
    kind: "frame",
    id: "f.test",
    agent: "a.test",
    cycle: 1,
    ts: At,
    digest: "0".repeat(64),
    mode: "triage",
    slots: [slot("node.1"), slot("missing")],
    budget: { allocated: { tokens: 120 }, spent: { tokens: 0 } },
};

const graph = new ContextAst();
graph.add({ id: "root", kind: "goal", summary: "incident root", order: 0, salience: 1 });
graph.add({ id: "node.1", parentId: "root", kind: "observation", summary: "db lock wait critical", order: 1, salience: 0.9 });

const store = new MemoryContentStore();
const ref = store.put("pg_locks: blocking_pid=4711");
graph.add({ id: "detail.1", parentId: "node.1", kind: "detail", summary: "raw lock detail", detailRef: ref, order: 2, salience: 0.5 });

const context = Context.create(frame, graph, { store, now: () => At });
assert.equal(context.phase, "created");
const view = context.materialize({ budgetTokens: 100 });
assert.equal(context.phase, "materialized");
assert.ok(view.tokens <= 100);
assert.equal(view.missingRefs.length, 1);
assert.equal(view.missingRefs[0].id, "missing");
assert.match(view.text, /db lock wait/);

context.activate();
assert.equal(context.phase, "active");
assert.equal(context.expand("detail.1"), "pg_locks: blocking_pid=4711");
assert.equal(context.expand("node.1"), undefined);

const receipt: Receipt = { amp: "0.1", kind: "receipt", id: "r.test", op: "attend", at: At, usage: { tokens: 10 }, outcome: "success" };
context.settle(receipt);
assert.equal(context.phase, "settled");
assert.deepEqual(context.snapshot().receiptIds, ["r.test"]);
assert.throws(() => context.settle(receipt), /already attached/);
context.compact();
assert.equal(context.phase, "compacted");
context.archive();
assert.equal(context.phase, "archived");
assert.throws(() => context.expand("detail.1"), /archived/);
assert.equal(context.snapshot().frameId, "f.test");

console.log(`phase=${context.phase} nodes=${view.nodes.length} tokens=${view.tokens} missing=${view.missingRefs.length}`);
console.log("\x1b[32m✓\x1b[0m Context owns Frame materialization, detail expansion, receipt settlement and archive lifecycle");
console.log("\n1 passed, 0 failed");
