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
import type { CalibrationSelection } from "../src/bayes/calibrationSelection.ts";

const mulberry32: (seed: number) => () => number = (seed: number): (() => number) => {
    let state: number = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value: number = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

const Random: () => number = mulberry32(42);
const Points: CalibrationPoint[] = [];
for (let index: number = 0; index < 400; index += 1) {
    const trueProbability: number = 0.05 + (index / 399) * 0.9;
    const actual: boolean = Random() < trueProbability;
    const predicted: number = Math.min(0.99, trueProbability * 1.25 + 0.1);
    Points.push({ predicted, actual });
}

const Full: CalibrationSelection = selectCalibration(Points);
assert.notEqual(Full.method, "raw");
assert.ok(Full.ece < Full.rawEce, `${Full.ece} !< ${Full.rawEce}`);

const Small: CalibrationSelection = selectCalibration(Points.slice(0, 40));
console.log(`n=400 method=${Full.method} rawECE=${Full.rawEce.toFixed(3)} calibratedECE=${Full.ece.toFixed(3)} | n=40 method=${Small.method}`);
console.log(`raw ECE check ${ece(Points).toFixed(3)}`);
console.log("\n1 passed, 0 failed");
