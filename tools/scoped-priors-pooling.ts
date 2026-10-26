#!/usr/bin/env node
/**
 * Partial pooling: unseen scopes benefit from shared scope evidence.
 */
import assert from "node:assert/strict";

import type { BetaBelief, Evidence } from "../src/bayes/engine.ts";
import { ScopedPriors } from "../src/bayes/scopedPriors.ts";

const Positive: Evidence = { dimension: "correctness", positive: 1, negative: 0, reliability: 1, source: "label" };

const make: (globalWeight: number) => ScopedPriors = (globalWeight: number): ScopedPriors => {
    const priors: ScopedPriors = new ScopedPriors({ globalWeight });
    for (let index: number = 0; index < 60; index += 1) {
        priors.observe("scope.a", [Positive]);
    }
    for (let index: number = 0; index < 40; index += 1) {
        priors.observe("scope.b", [Positive]);
    }
    return priors;
};

const Pooled: ScopedPriors = make(0.5);
const Unpooled: ScopedPriors = make(0);
const UnseenPooled: BetaBelief = Pooled.priorsFor("unseen").correctness;
const UnseenUnpooled: BetaBelief = Unpooled.priorsFor("unseen").correctness;
const PooledMean: number = UnseenPooled.alpha / (UnseenPooled.alpha + UnseenPooled.beta);
const UnpooledMean: number = UnseenUnpooled.alpha / (UnseenUnpooled.alpha + UnseenUnpooled.beta);
assert.ok(PooledMean > UnpooledMean);
assert.ok(PooledMean > 0.5);

console.log(`unseen mean: pooled=${PooledMean.toFixed(3)} unpooled=${UnpooledMean.toFixed(3)}`);
console.log("\x1b[32m✓\x1b[0m partial pooling raises the unseen-scope prior from shared evidence");
console.log("\n1 passed, 0 failed");
