#!/usr/bin/env node
/**
 * Reliability-aware evidence + learned source weights.
 */
import assert from "node:assert/strict";

import { posteriorOf } from "../src/bayes/engine.ts";
import { SourceReliability } from "../src/bayes/reliability.ts";
import type { Evidence, Posterior } from "../src/bayes/engine.ts";

const Evidence: Evidence[] = [{ dimension: "correctness", positive: 5, negative: 0, reliability: 1, source: "text" }];
const WithSource: Posterior = posteriorOf({ alpha: 2, beta: 2 }, Evidence, "correctness", { text: 1 });
const WithoutSource: Posterior = posteriorOf({ alpha: 2, beta: 2 }, Evidence, "correctness", { text: 0 });
assert.ok(WithSource.mean > WithoutSource.mean);
assert.equal(WithoutSource.mean, 0.5);

const Table: SourceReliability = new SourceReliability();
assert.equal(Table.weight("text"), 1);
Table.observe("text", false, 4);
Table.observe("text", false, 4);
assert.ok(Table.weight("text") < 0.5);
assert.equal(Table.weights().text < 0.5, true);
const Before = Table.snapshot();
const Snapshot = Table.snapshot();
Snapshot.text.alpha = 999;
assert.deepEqual(Table.snapshot(), Before);
const Observed = Table.observe("other", true);
Observed.alpha = 999;
assert.equal(Table.snapshot().other.alpha, 3);
assert.throws(() => Table.observe("text", true, Number.NaN), RangeError);
assert.throws(() => Table.observe("text", true, -1), RangeError);
const Prior = { alpha: 2, beta: 2 };
const Isolated = new SourceReliability(Prior);
Prior.alpha = 999;
assert.equal(Isolated.observe("source", false).alpha, 2);
const Huge = new SourceReliability({ alpha: Number.MAX_VALUE, beta: Number.MAX_VALUE });
Huge.observe("source", true, 0);
assert.equal(Huge.weight("source"), 0.5);
assert.throws(() => Huge.observe("source", true, Number.MAX_VALUE), RangeError);

console.log("\x1b[32m✓\x1b[0m source weights change the posterior; learned reliability discounts a bad source");
console.log("\n1 passed, 0 failed");
