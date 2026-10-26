#!/usr/bin/env node
/**
 * Rate, circuit-breaker and money guards.
 */
import assert from "node:assert/strict";

import { CircuitOpen, CostCeilingExceeded, Guard, RateLimited } from "../src/policy/guard.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

test("an empty guard is a no-op", () => {
    const guard = new Guard();
    guard.beforeDispatch({ money: 10 });
    guard.recordFailure();
    assert.equal(guard.snapshot().spent, 10);
});

test("sliding-window rate limit blocks before the next dispatch", () => {
    let now = 1_000;
    const guard = new Guard({ now: () => now, rate: { limit: 2, intervalMs: 1_000 } });
    guard.beforeDispatch();
    now += 10;
    guard.beforeDispatch();
    assert.throws(() => guard.beforeDispatch(), RateLimited);
    now += 1_001;
    guard.beforeDispatch();
    assert.equal(guard.snapshot().windowCount, 1);
});

test("rate window is sliding, not fixed buckets", () => {
    let now = 0;
    const guard = new Guard({ now: () => now, rate: { limit: 1, intervalMs: 100 } });
    guard.beforeDispatch();
    now = 50;
    assert.throws(() => guard.beforeDispatch(), RateLimited);
    now = 101;
    guard.beforeDispatch();
});

test("cost ceiling is charged before dispatch and blocks overage", () => {
    const guard = new Guard({ costCeiling: 0.05 });
    guard.beforeDispatch({ money: 0.03 });
    assert.equal(guard.snapshot().spent, 0.03);
    assert.throws(() => guard.beforeDispatch({ money: 0.03 }), CostCeilingExceeded);
    assert.equal(guard.snapshot().spent, 0.03);
    guard.beforeDispatch({ money: 0.02 });
    assert.equal(guard.snapshot().spent, 0.05);
});

test("a failed cost check does not consume rate capacity", () => {
    const guard = new Guard({ rate: { limit: 1, intervalMs: 1_000 }, costCeiling: 1 });
    guard.beforeDispatch({ money: 1 });
    assert.throws(() => guard.beforeDispatch({ money: 1 }), RateLimited);
    assert.equal(guard.snapshot().windowCount, 1);
});

test("breaker opens after the configured consecutive failures", () => {
    const now = 0;
    const guard = new Guard({ now: () => now, breaker: { failures: 2, cooldownMs: 100 } });
    guard.recordFailure();
    assert.equal(guard.snapshot().open, false);
    guard.recordFailure();
    assert.equal(guard.snapshot().open, true);
    assert.throws(() => guard.beforeDispatch(), CircuitOpen);
});

test("breaker half-opens after cooldown and success closes it", () => {
    let now = 0;
    const guard = new Guard({ now: () => now, breaker: { failures: 1, cooldownMs: 100 } });
    guard.recordFailure();
    now = 50;
    assert.throws(() => guard.beforeDispatch(), CircuitOpen);
    now = 100;
    guard.beforeDispatch();
    guard.recordSuccess();
    const snapshot = guard.snapshot();
    assert.equal(snapshot.open, false);
    assert.equal(snapshot.failures, 0);
});

test("a successful dispatch resets the failure count", () => {
    const guard = new Guard({ breaker: { failures: 2, cooldownMs: 100 } });
    guard.recordFailure();
    guard.recordSuccess();
    guard.recordFailure();
    assert.equal(guard.snapshot().open, false);
});

test("snapshot exposes retryAfterMs when rate-limited or open", () => {
    let now = 0;
    const guard = new Guard({ now: () => now, rate: { limit: 1, intervalMs: 100 } });
    guard.beforeDispatch();
    now = 25;
    assert.equal(guard.snapshot().retryAfterMs, 75);
});

test("invalid guard options fail fast", () => {
    assert.throws(() => new Guard({ rate: { limit: -1, intervalMs: 10 } }), RangeError);
    assert.throws(() => new Guard({ rate: { limit: 1, intervalMs: 0 } }), RangeError);
    assert.throws(() => new Guard({ breaker: { failures: 0, cooldownMs: 1 } }), RangeError);
    assert.throws(() => new Guard({ breaker: { failures: 1, cooldownMs: -1 } }), RangeError);
    assert.throws(() => new Guard({ costCeiling: -1 }), RangeError);
    assert.throws(() => new Guard().beforeDispatch({ money: -1 }), RangeError);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
