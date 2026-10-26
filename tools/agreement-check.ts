#!/usr/bin/env node
/**
 * Cohen's kappa / Fleiss' kappa agreement checks.
 */
import assert from "node:assert/strict";

import { agreementRate, cohenKappa, fleissKappa } from "../src/evaluation/agreement.ts";

const same = ["correct", "incorrect", "correct", "correct"];
assert.equal(agreementRate(same, same), 1);
assert.equal(cohenKappa(same, same), 1);

const left = ["correct", "correct", "incorrect", "incorrect"];
const right = ["correct", "incorrect", "incorrect", "incorrect"];
assert.equal(agreementRate(left, right), 0.75);
const kappa = cohenKappa(left, right);
assert.equal(kappa > 0 && kappa < 1, true);

const fleiss = fleissKappa([
    ["correct", "correct", "incorrect"],
    ["incorrect", "incorrect", "incorrect"],
    ["correct", "correct", "correct"],
]);
assert.equal(fleiss > 0, true);

console.log("\x1b[32m✓\x1b[0m agreement rate, Cohen's kappa and Fleiss' kappa");
console.log("\n1 passed, 0 failed");
