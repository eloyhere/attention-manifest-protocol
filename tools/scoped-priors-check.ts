#!/usr/bin/env node
/**
 * Scope-level Beta priors: local counts move the posterior, unseen scopes fall back.
 */
import assert from "node:assert/strict";

import { ScopedPriors } from "../src/bayes/scopedPriors.ts";
import type { AnswerScore, BetaBelief, BayesianEngine, Evidence } from "../src/bayes/engine.ts";

const Positive: Evidence = { dimension: "correctness", positive: 20, negative: 0, reliability: 1, source: "label" };
const Negative: Evidence = { dimension: "correctness", positive: 0, negative: 20, reliability: 1, source: "label" };

const Priors: ScopedPriors = new ScopedPriors();
const GlobalMean: BetaBelief = Priors.priorsFor("unseen").correctness;
assert.equal(GlobalMean.alpha, 2);
assert.equal(GlobalMean.beta, 2);

Priors.observe("scope.good", [Positive]);
Priors.observe("scope.bad", [Negative]);
const Good: BetaBelief = Priors.priorsFor("scope.good").correctness;
const Bad: BetaBelief = Priors.priorsFor("scope.bad").correctness;
assert.ok(Good.alpha / (Good.alpha + Good.beta) > 0.8);
assert.ok(Bad.alpha / (Bad.alpha + Bad.beta) < 0.2);
assert.equal(Priors.priorsFor("unseen").correctness.alpha, 2);

const Engine: BayesianEngine = Priors.engineFor("scope.good");
const Score: AnswerScore = Engine.scoreAnswer("no evidence", {});
assert.ok(Score.dimensions.correctness.mean > 0.8);

const Pooled: ScopedPriors = new ScopedPriors({ globalWeight: 0.5 });
Pooled.observe("scope.x", [Positive]);
assert.ok(Pooled.snapshot().global.correctness.alpha > 2);

console.log("\x1b[32m✓\x1b[0m scoped priors move per-scope posteriors and preserve global fallback");
console.log("\n1 passed, 0 failed");
