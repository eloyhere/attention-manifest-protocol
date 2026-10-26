#!/usr/bin/env node
/** One Attention state: stable window, attraction/distraction forces, shift as Action. */
import assert from "node:assert/strict";

import { Attention, toShiftAction } from "../src/attention/index.ts";
import type { AttentionItem } from "../src/attention/index.ts";

const At = "2026-10-24T00:00:00.000Z";
const item = (id: string, order: number): AttentionItem => ({ target: { kind: "evidence", id }, order, weight: 0.5 });

const attention = new Attention({
    subject: { pid: 1 },
    capacity: { slots: 2, tokens: 100 },
    items: [item("a", 0), item("b", 1), item("c", 2), item("d", 3)],
    now: () => At,
});

assert.deepEqual(attention.focus().map((entry) => entry.target.id), ["a", "b"]);
const right = attention.shift({ actionId: "act.1", direction: "right", reason: "next two" });
assert.equal(right.changed, true);
assert.equal(right.blocked, false);
assert.deepEqual(right.snapshot.focus.map((entry) => entry.target.id), ["b", "c"]);
attention.shift({ actionId: "act.2", direction: "right", reason: "next two" });
const edge = attention.shift({ actionId: "act.3", direction: "right", reason: "beyond edge" });
assert.equal(edge.changed, false);
assert.equal(edge.blocked, true);
assert.match(edge.reason, /boundary/);
attention.shift({ actionId: "act.4", direction: "left", reason: "back" });
assert.deepEqual(attention.focus().map((entry) => entry.target.id), ["b", "c"]);

attention.observe({ kind: "attraction", from: { kind: "human", id: "user.1" }, target: { kind: "evidence", id: "d" }, strength: 0.4 });
attention.observe({ kind: "distraction", from: { kind: "event", id: "alert.1" }, target: { kind: "evidence", id: "d" }, competesWith: { kind: "evidence", id: "b" }, strength: 0.3 });
const snapshot = attention.snapshot();
assert.equal(snapshot.forces.length, 2);
assert.equal(snapshot.focus.length, 2);
assert.equal(snapshot.ignored.length, 2);

const action = toShiftAction({ direction: "right", steps: 1, reason: "test" });
assert.equal(action.intent, "attention.shift");
assert.equal(action.risk, "none");
assert.equal(action.successCriteria?.includes("a Receipt is recorded"), true);

attention.close();
assert.throws(() => attention.shift({ actionId: "act.x", direction: "left", reason: "closed" }), /closed/);

console.log(`focus=${snapshot.focus.map((entry) => entry.target.id).join(",")} ignored=${snapshot.ignored.map((entry) => entry.target.id).join(",")} forces=${snapshot.forces.length}`);
console.log("\x1b[32m✓\x1b[0m Attention is one state object; shift is an Action; forces do not reorder the window");
console.log("\n1 passed, 0 failed");
