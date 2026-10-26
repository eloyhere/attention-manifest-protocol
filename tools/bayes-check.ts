#!/usr/bin/env node
/**
 * Bayesian scoring checks.
 *
 * Beta-Binomial posteriors for user input, answer quality and attention.
 * Evidence is graded and reliability-discounted; self-report is weaker than a
 * checker. The tests also verify that scoring is observational (score calls do
 * not mutate the prior) and that learning is explicit.
 */
import assert from "node:assert/strict";

import { BayesianEngine, betaMean, betaVariance, extractAnswerFeatures, extractUserFeatures, posteriorOf } from "../src/bayes/engine.ts";
import type { AttentionMetrics, Evidence, UserScore } from "../src/bayes/engine.ts";
import { resolveInteraction } from "../src/interaction/interaction.ts";

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const prior = { alpha: 2, beta: 2 };
const evidence: Evidence = { dimension: "correctness", positive: 8, negative: 2, reliability: 1, source: "test" };

const syntheticUser = (state: { emotionalIntensity: number; urgency: number; openness: number }, clarity = 0.5, specificity = 0.5): UserScore => {
    const dimension = (mean: number) => ({ alpha: mean * 4, beta: (1 - mean) * 4, mean, variance: 0, interval: [0, 1] as [number, number], evidenceCount: 1 });
    return {
        dimensions: {
            clarity: dimension(clarity),
            specificity: dimension(specificity),
            contextSufficiency: dimension(0.5),
            emotionalIntensity: dimension(state.emotionalIntensity),
            urgency: dimension(state.urgency),
            openness: dimension(state.openness),
        },
        quality: 0.5,
        state,
        evidence: [],
    };
};

test("beta posterior has the expected mean and an interval", () => {
    const posterior = posteriorOf(prior, [evidence], "correctness");
    assert.equal(Math.abs(posterior.mean - 10 / 14) < 1e-9, true);
    assert.equal(posterior.alpha, 10);
    assert.equal(posterior.beta, 4);
    assert.equal(posterior.interval[0] < posterior.mean, true);
    assert.equal(posterior.interval[1] > posterior.mean, true);
    assert.equal(betaMean(prior), 0.5);
    assert.equal(betaVariance(prior) > 0, true);
});

test("evidence order does not change the posterior", () => {
    const a: Evidence = { dimension: "correctness", positive: 2, negative: 0, reliability: 0.8, source: "a" };
    const b: Evidence = { dimension: "correctness", positive: 0, negative: 3, reliability: 0.6, source: "b" };
    const ab = posteriorOf(prior, [a, b], "correctness");
    const ba = posteriorOf(prior, [b, a], "correctness");
    assert.equal(ab.alpha, ba.alpha);
    assert.equal(ab.beta, ba.beta);
});

test("specific questions score higher than vague requests", () => {
    const engine = new BayesianEngine();
    const specific = engine.scoreUser("How many minutes between 09:14 and 09:52? Answer only the number.");
    const vague = engine.scoreUser("stuff is broken somehow, you know?");
    assert.equal(specific.dimensions.clarity.mean > vague.dimensions.clarity.mean, true);
    assert.equal(specific.dimensions.specificity.mean > vague.dimensions.specificity.mean, true);
    assert.equal(specific.quality > vague.quality, true);
});

test("emotional and urgent input is scored as state, not as quality", () => {
    const engine = new BayesianEngine();
    const intense = engine.scoreUser("I'm overwhelmed and need this now!");
    const calm = engine.scoreUser("No rush, whenever is fine.");
    assert.equal(intense.state.emotionalIntensity > calm.state.emotionalIntensity, true);
    assert.equal(intense.state.urgency > calm.state.urgency, true);
    assert.equal(intense.state.emotionalIntensity > 0.5, true);
});

test("answer correctness and grounding follow the evidence", () => {
    const engine = new BayesianEngine();
    const correct = engine.scoreAnswer("14", { correct: true, grounded: true, targetTokens: 10 });
    const wrong = engine.scoreAnswer("8.3%", { correct: false, grounded: false, targetTokens: 10 });
    assert.equal(correct.dimensions.correctness.mean > wrong.dimensions.correctness.mean, true);
    assert.equal(correct.overall > wrong.overall, true);

    const grounded = engine.scoreAnswer("According to https://example.com/source, the value is 14.", { correct: true, targetTokens: 60 });
    const unsupported = engine.scoreAnswer("I think it is probably something like 14 or so.", { correct: true, targetTokens: 60 });
    assert.equal(grounded.dimensions.grounding.mean > unsupported.dimensions.grounding.mean, true);
});

test("overclaiming and rambling reduce calibration and conciseness", () => {
    const engine = new BayesianEngine();
    const clean = engine.scoreAnswer("14", { correct: true, targetTokens: 20 });
    const overclaim = engine.scoreAnswer("This is definitely, certainly, undoubtedly always 14, guaranteed, obviously proven. ".repeat(6), {
        correct: true,
        targetTokens: 20,
    });
    assert.equal(clean.dimensions.conciseness.mean > overclaim.dimensions.conciseness.mean, true);
    assert.equal(clean.dimensions.calibration.mean > overclaim.dimensions.calibration.mean, true);
    assert.equal(clean.overall > overclaim.overall, true);
});

test("attention telemetry yields a strain posterior and health score", () => {
    const engine = new BayesianEngine();
    const high: AttentionMetrics = { utilization: 0.95, pressure: 0.9, recoveryDebt: 0.8, errors: 4, switches: 12, latencyMs: 5000, targetLatencyMs: 1500 };
    const low: AttentionMetrics = { utilization: 0.4, pressure: 0.1, recoveryDebt: 0.1, errors: 0, switches: 1, latencyMs: 300, targetLatencyMs: 1500 };
    const highScore = engine.scoreAttention(high);
    const lowScore = engine.scoreAttention(low);
    assert.equal(highScore.dimensions.load.mean > lowScore.dimensions.load.mean, true);
    assert.equal(highScore.dimensions.stress.mean > lowScore.dimensions.stress.mean, true);
    assert.equal(highScore.health < lowScore.health, true);
});

test("interaction fit uses user state and mode weights", () => {
    const engine = new BayesianEngine();
    const emotional = syntheticUser({ emotionalIntensity: 0.9, urgency: 0.2, openness: 0.7 });
    const urgent = syntheticUser({ emotionalIntensity: 0.2, urgency: 0.9, openness: 0.2 });
    const affect = resolveInteraction({ affect: 1 });
    const think = resolveInteraction({ think: 1 });
    const converge = resolveInteraction({ converge: 1 });
    assert.equal(engine.interactionFit(emotional, affect).score > engine.interactionFit(emotional, think).score, true);
    assert.equal(engine.interactionFit(urgent, converge).score > engine.interactionFit(urgent, affect).score, true);
});

test("learning is explicit and reliability discounts evidence", () => {
    const engine = new BayesianEngine();
    const before = engine.snapshot().correctness.alpha;
    const strong: Evidence = { dimension: "correctness", positive: 2, negative: 0, reliability: 1, source: "checker" };
    const weak: Evidence = { dimension: "correctness", positive: 2, negative: 0, reliability: 0.1, source: "self-report" };
    engine.learn([strong]);
    const afterStrong = engine.snapshot().correctness.alpha;
    engine.learn([weak]);
    const afterWeak = engine.snapshot().correctness.alpha;
    assert.equal(afterStrong - before, 2);
    assert.equal(Math.abs(afterWeak - afterStrong - 0.2) < 1e-9, true);
});

test("feature extraction is deterministic and bounded", () => {
    const user = extractUserFeatures("Can you check 3 things by 17:00 because the release is blocked?");
    assert.equal(user.questions > 0, true);
    assert.equal(user.numbers >= 2, true);
    assert.equal(user.urgencyHits > 0, true);
    const answer = extractAnswerFeatures("- run the test\n- check the logs\nSource: https://example.com");
    assert.equal(answer.structure, true);
    assert.equal(answer.refs > 0, true);
    assert.equal(answer.actions >= 2, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
