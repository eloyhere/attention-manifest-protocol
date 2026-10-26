#!/usr/bin/env node
/**
 * Attention resource checks: process capacity -> thread allocation.
 *
 * The model is deliberately pure. It answers three questions:
 * 1. how much foreground can this agent run before the reserve is touched?
 * 2. when must the agent go offline/rest?
 * 3. does the floor belong to safety and admitted tasks, not to every task?
 */
import assert from "node:assert/strict";

import type { CognitiveState } from "../src/attention/cognition.ts";
import {
    DefaultAttentionPolicy,
    applyRest,
    attentionHealth,
    planAttention,
    processAttention,
    qualityAdjustedThroughput,
    recoveryDebtOf,
    shouldRest,
} from "../src/attention/resource.ts";
import type { ThreadAttentionCandidate } from "../src/attention/resource.ts";

const At = "2026-10-24T00:00:00.000Z";

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed += 1;
        console.log(`\x1b[32m\u2713\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m\u2717\x1b[0m ${name}\n      ${message}`);
    }
};

const state = (overrides: Partial<CognitiveState> = {}): CognitiveState => {
    const base: CognitiveState = {
        load: 0.2,
        vigilance: 0.9,
        arousal: 0.1,
        mastery: 0.7,
        accountability: 0.5,
        cyclesSinceRest: 0,
        capacityEff: 4,
        pLapse: 0.1,
        source: "default",
        samples: 0,
    };
    return { ...base, ...overrides };
};

const candidate = (
    tid: number,
    priority: number,
    preferredSlots: number,
    foreground = true,
    extras: Partial<ThreadAttentionCandidate> = {},
): ThreadAttentionCandidate => ({
    tid,
    pid: 1,
    priority,
    preferredSlots,
    foreground,
    ...extras,
});

test("process attention keeps a foreground cap and a safety reserve", () => {
    const process = processAttention(1, state());
    assert.equal(process.effectiveSlots, 4);
    assert.equal(process.foregroundCap, 3);
    assert.equal(process.reserveSlots, 1);
    assert.equal(process.safetySlots, 1);
    assert.equal(process.offline, false);
    assert.equal(process.foregroundCap + process.reserveSlots, process.effectiveSlots);
});

test("effective capacity shrinks with load, and rest is triggered by policy", () => {
    const loaded = state({ load: 0.95, capacityEff: 3, vigilance: 0.3, pLapse: 0.7, cyclesSinceRest: 2 });
    const process = processAttention(1, loaded);
    assert.equal(process.effectiveSlots, 3);
    assert.equal(process.foregroundCap, 2);
    assert.equal(process.offline, true);
    assert.equal(shouldRest(loaded), true);
    assert.equal(recoveryDebtOf(loaded) > 0.5, true);

    const rested = applyRest(loaded);
    assert.equal(rested.cyclesSinceRest, 0);
    assert.equal(rested.vigilance > loaded.vigilance, true);
    assert.equal(rested.load < loaded.load, true);
});

test("offline plans admit no foreground and explain every deferral", () => {
    const process = processAttention(1, state({ vigilance: 0.2, cyclesSinceRest: 9 }));
    const plan = planAttention(process, [candidate(1, 9, 2), candidate(2, 5, 1)]);
    assert.equal(plan.rest, true);
    assert.equal(plan.foreground, (void 0));
    assert.equal(plan.deferred.length, 2);
    assert.equal(
        plan.deferred.every((entry) => entry.reason === "offline"),
        true,
    );
    assert.equal(plan.utilization, 0);
});

test("one foreground gets a slice; background uses only the reserve", () => {
    const process = processAttention(1, state());
    const plan = planAttention(process, [candidate(1, 9, 2), candidate(2, 8, 2), candidate(3, 5, 1, false), candidate(4, 4, 2, false)]);
    assert.equal(plan.foreground?.tid, 1);
    assert.equal(plan.foreground?.slots, 2);
    assert.equal(plan.background.length, 1);
    assert.equal(plan.background[0]?.tid, 3);
    assert.equal(plan.background[0]?.slots, 1);
    assert.equal(
        plan.deferred.some((entry) => entry.tid === 2 && entry.reason === "low-priority"),
        true,
    );
    assert.equal(
        plan.deferred.some((entry) => entry.tid === 4 && entry.reason === "budget"),
        true,
    );
    assert.equal(plan.utilization, 3 / 4);
    assert.equal(plan.pressure > 0, true);
    assert.deepEqual(attentionHealth(plan), { utilization: 0.75, pressure: plan.pressure, headroom: 0.25, rest: false });
});

test("floors apply to safety and admitted tasks, never to deferred tasks", () => {
    const process = processAttention(1, state());
    const plan = planAttention(process, [candidate(1, 9, 0, true, { minSlots: 1 }), candidate(2, 8, 2, true), candidate(3, 7, 1, false)]);
    assert.equal(plan.foreground?.slots, 1);
    assert.equal(plan.background[0]?.slots, 1);
    assert.equal(
        plan.deferred.some((entry) => entry.tid === 2),
        true,
    );
    assert.equal(plan.process.safetySlots, 1);
});

test("switch cost raises pressure without silently consuming capacity", () => {
    const process = processAttention(1, state({ dominantRole: "goal" }));
    const plan = planAttention(process, [candidate(1, 9, 2, true, { role: "engineer", switchCost: 2 })]);
    assert.equal(plan.foreground?.switchCost, 2);
    assert.equal(plan.utilization, 2 / 4);
    assert.equal(plan.pressure >= 0.5, true);
});

test("quality-adjusted throughput punishes busy-but-wrong agents", () => {
    const busyWrong = qualityAdjustedThroughput({ successes: 10, attempts: 20, errors: 4, rework: 3, attentionSlots: 4 });
    const slowerClean = qualityAdjustedThroughput({ successes: 8, attempts: 10, errors: 1, rework: 0, attentionSlots: 4 });
    assert.equal(slowerClean > busyWrong, true);
});

test("a policy can be tuned without changing the model", () => {
    const conservative = { ...DefaultAttentionPolicy, maxForegroundUtil: 0.5, reserveRatio: 0.5 };
    const process = processAttention(1, state(), conservative);
    assert.equal(process.foregroundCap, 2);
    assert.equal(process.reserveSlots, 2);
    assert.equal(process.safetySlots, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
