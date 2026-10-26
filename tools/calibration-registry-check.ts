#!/usr/bin/env node
/**
 * Calibration registry: activate only when CV improvement passes the margin.
 */
import assert from "node:assert/strict";

import { CalibrationRegistry } from "../src/bayes/calibrationRegistry.ts";
import type { CalibrationPoint } from "../src/bayes/calibration.ts";

const mulberry32 = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state += 0x6d2b79f5;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
};

const random = mulberry32(7);
const points: CalibrationPoint[] = [];
for (let index = 0; index < 400; index += 1) {
    const truth = 0.05 + (index / 399) * 0.9;
    points.push({ predicted: Math.min(0.99, truth * 1.25 + 0.1), actual: random() < truth });
}

const registry = new CalibrationRegistry();
const activated = registry.register("scope.calibrated", points, { at: "2026-10-24T00:00:00.000Z" });
assert.equal(activated.status, "activated");
assert.notEqual(registry.model("scope.calibrated"), undefined);
assert.ok((registry.model("scope.calibrated")?.ciUpper ?? 0) < 0);
assert.ok(registry.calibrate("scope.calibrated", 0.9) < 0.9);

const small = registry.register("scope.small", points.slice(0, 10));
assert.equal(small.status, "raw");
assert.equal(registry.model("scope.small"), undefined);
assert.equal(registry.calibrate("scope.small", 0.9), 0.9);

console.log("\x1b[32m✓\x1b[0m calibration registry activates only on sufficient CV improvement");
console.log("\n1 passed, 0 failed");
