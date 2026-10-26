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

console.log("\x1b[32m✓\x1b[0m source weights change the posterior; learned reliability discounts a bad source");
console.log("\n1 passed, 0 failed");
