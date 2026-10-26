#!/usr/bin/env node
/**
 * Synthetic calibration simulation: with enough labels, a monotone map should
 * beat the raw overconfident score; with 40 labels the selector may still
 * refuse. This validates the method, not the model.
 */
import assert from "node:assert/strict";

import { ece } from "../src/bayes/calibration.ts";
import type { CalibrationPoint } from "../src/bayes/calibration.ts";
import { selectCalibration } from "../src/bayes/calibrationSelection.ts";

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

const random = mulberry32(42);
const points: CalibrationPoint[] = [];
for (let index = 0; index < 400; index += 1) {
    const trueProbability = 0.05 + (index / 399) * 0.9;
    const actual = random() < trueProbability;
    const predicted = Math.min(0.99, trueProbability * 1.25 + 0.1);
    points.push({ predicted, actual });
}

const full = selectCalibration(points);
assert.notEqual(full.method, "raw");
assert.ok(full.ece < full.rawEce, `${full.ece} !< ${full.rawEce}`);

const small = selectCalibration(points.slice(0, 40));
console.log(`n=400 method=${full.method} rawECE=${full.rawEce.toFixed(3)} calibratedECE=${full.ece.toFixed(3)} | n=40 method=${small.method}`);
console.log(`raw ECE check ${ece(points).toFixed(3)}`);
console.log("\n1 passed, 0 failed");
