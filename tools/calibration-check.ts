#!/usr/bin/env node
/** Isotonic calibration + cross-validated ECE/Brier checks. */
import assert from "node:assert/strict";

import { applyIsotonic, brier, crossValidateCalibration, ece, fitIsotonic } from "../src/bayes/calibration.ts";
import { selectCalibration } from "../src/bayes/calibrationSelection.ts";
import type { CalibrationPoint } from "../src/bayes/calibration.ts";

const perfect: CalibrationPoint[] = [
    { predicted: 0, actual: false },
    { predicted: 1, actual: true },
];
assert.equal(ece(perfect), 0);
assert.equal(brier(perfect), 0);

const overconfident: CalibrationPoint[] = Array.from({ length: 10 }, (_, index) => ({ predicted: 0.9, actual: index < 5 }));
assert.ok(Math.abs(ece(overconfident) - 0.4) < 1e-9);
assert.ok(Math.abs(brier(overconfident) - 0.41) < 1e-9);

const model = fitIsotonic([
    { predicted: 0.1, actual: false },
    { predicted: 0.2, actual: false },
    { predicted: 0.8, actual: true },
    { predicted: 0.9, actual: true },
]);
assert.equal(model.thresholds.length > 0, true);
assert.equal(applyIsotonic(model, 0.05) <= applyIsotonic(model, 0.95), true);

const cv = crossValidateCalibration(
    Array.from({ length: 40 }, (_, index) => ({ predicted: (index % 10) / 10, actual: index % 2 === 0 })),
    5,
);
assert.equal(Number.isFinite(cv.ece), true);
assert.equal(Number.isFinite(cv.brier), true);
assert.equal(cv.rawEce >= 0, true);

const selected = selectCalibration(overconfident);
assert.equal(selected.method !== "raw", true);
assert.equal(selected.ece < selected.rawEce, true);

console.log("\x1b[32m✓\x1b[0m isotonic calibration, ECE/Brier and cross-validation");
console.log("\n1 passed, 0 failed");
