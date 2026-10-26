#!/usr/bin/env node
/** Reliability-aware evidence + learned source weights. */
import assert from "node:assert/strict";

import { posteriorOf } from "../src/bayes/engine.ts";
import { SourceReliability } from "../src/bayes/reliability.ts";
import type { Evidence } from "../src/bayes/engine.ts";

const evidence: Evidence[] = [{ dimension: "correctness", positive: 5, negative: 0, reliability: 1, source: "text" }];
const withSource = posteriorOf({ alpha: 2, beta: 2 }, evidence, "correctness", { text: 1 });
const withoutSource = posteriorOf({ alpha: 2, beta: 2 }, evidence, "correctness", { text: 0 });
assert.ok(withSource.mean > withoutSource.mean);
assert.equal(withoutSource.mean, 0.5);

const table = new SourceReliability();
assert.equal(table.weight("text"), 1);
table.observe("text", false, 4);
table.observe("text", false, 4);
assert.ok(table.weight("text") < 0.5);
assert.equal(table.weights().text < 0.5, true);

console.log("\x1b[32m✓\x1b[0m source weights change the posterior; learned reliability discounts a bad source");
console.log("\n1 passed, 0 failed");
