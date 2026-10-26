#!/usr/bin/env node
/** Partial pooling: unseen scopes benefit from shared scope evidence. */
import assert from "node:assert/strict";

import { ScopedPriors } from "../src/bayes/scopedPriors.ts";
import type { Evidence } from "../src/bayes/engine.ts";

const positive: Evidence = { dimension: "correctness", positive: 1, negative: 0, reliability: 1, source: "label" };
const negative: Evidence = { dimension: "correctness", positive: 0, negative: 1, reliability: 1, source: "label" };

const make = (globalWeight: number): ScopedPriors => {
    const priors = new ScopedPriors({ globalWeight });
    for (let index = 0; index < 60; index += 1) priors.observe("scope.a", [positive]);
    for (let index = 0; index < 40; index += 1) priors.observe("scope.b", [positive]);
    return priors;
};

const pooled = make(0.5);
const unpooled = make(0);
const unseenPooled = pooled.priorsFor("unseen").correctness;
const unseenUnpooled = unpooled.priorsFor("unseen").correctness;
const pooledMean = unseenPooled.alpha / (unseenPooled.alpha + unseenPooled.beta);
const unpooledMean = unseenUnpooled.alpha / (unseenUnpooled.alpha + unseenUnpooled.beta);
assert.ok(pooledMean > unpooledMean);
assert.ok(pooledMean > 0.5);

console.log(`unseen mean: pooled=${pooledMean.toFixed(3)} unpooled=${unpooledMean.toFixed(3)}`);
console.log("\x1b[32m✓\x1b[0m partial pooling raises the unseen-scope prior from shared evidence");
console.log("\n1 passed, 0 failed");
