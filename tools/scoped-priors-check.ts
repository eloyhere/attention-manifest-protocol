#!/usr/bin/env node
/** Scope-level Beta priors: local counts move the posterior, unseen scopes fall back. */
import assert from "node:assert/strict";

import { ScopedPriors } from "../src/bayes/scopedPriors.ts";
import type { Evidence } from "../src/bayes/engine.ts";

const positive: Evidence = { dimension: "correctness", positive: 20, negative: 0, reliability: 1, source: "label" };
const negative: Evidence = { dimension: "correctness", positive: 0, negative: 20, reliability: 1, source: "label" };

const priors = new ScopedPriors();
const globalMean = priors.priorsFor("unseen").correctness;
assert.equal(globalMean.alpha, 2);
assert.equal(globalMean.beta, 2);

priors.observe("scope.good", [positive]);
priors.observe("scope.bad", [negative]);
const good = priors.priorsFor("scope.good").correctness;
const bad = priors.priorsFor("scope.bad").correctness;
assert.ok(good.alpha / (good.alpha + good.beta) > 0.8);
assert.ok(bad.alpha / (bad.alpha + bad.beta) < 0.2);
assert.equal(priors.priorsFor("unseen").correctness.alpha, 2);

const engine = priors.engineFor("scope.good");
const score = engine.scoreAnswer("no evidence", {});
assert.ok(score.dimensions.correctness.mean > 0.8);

const pooled = new ScopedPriors({ globalWeight: 0.5 });
pooled.observe("scope.x", [positive]);
assert.ok(pooled.snapshot().global.correctness.alpha > 2);

console.log("\x1b[32m✓\x1b[0m scoped priors move per-scope posteriors and preserve global fallback");
console.log("\n1 passed, 0 failed");
