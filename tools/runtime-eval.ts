#!/usr/bin/env node
/**
 * Deterministic runtime eval harness.
 *
 * 220 generated cases cover arithmetic, unique rows, syllogism, memory, role,
 * attention and Bayesian tasks. ScriptedLlm keeps it offline; replace it with a
 * recorded/live client for model comparisons.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import { BayesianEngine } from "../src/bayes/engine.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";

const At = "2026-10-24T00:00:00.000Z";

interface Case {
    id: string;
    category: string;
    input: string;
    answer: string;
    check: (answer: string) => boolean;
    humanLabel?: "correct" | "incorrect";
}

const cases: Case[] = [];

for (let i = 0; i < 50; i += 1) {
    const a = i + 1;
    const b = ((i * 7) % 13) + 1;
    const expected = a + b;
    const wrong = i % 10 === 0;
    cases.push({
        id: `arith-${i}`,
        category: "arithmetic",
        input: `Compute ${a} + ${b}. Output only the number.`,
        answer: `${wrong ? expected + 1 : expected}`,
        check: (answer) => Number(answer.trim()) === expected,
    });
}

for (let i = 0; i < 40; i += 1) {
    const rows = 20 + i;
    const duplicates = (i % 5) + 1;
    const expected = rows - duplicates;
    const wrong = i % 10 === 0;
    cases.push({
        id: `unique-${i}`,
        category: "unique-rows",
        input: `${rows} rows, ${duplicates} duplicates. How many unique rows? Output only the number.`,
        answer: `${wrong ? expected + 1 : expected}`,
        check: (answer) => Number(answer.trim()) === expected,
    });
}

for (let i = 0; i < 30; i += 1) {
    const wrong = i % 15 === 0;
    cases.push({
        id: `syllogism-${i}`,
        category: "syllogism",
        input: "All A are B. No B are C. Can any A be C? Answer only yes or no.",
        answer: wrong ? "yes" : "no",
        check: (answer) => /\bno\b/i.test(answer),
    });
}

for (let i = 0; i < 30; i += 1) {
    const wrong = i % 10 === 0;
    cases.push({
        id: `memory-${i}`,
        category: "memory",
        input: `What code did Mira give for item ${i}? Answer only the code.`,
        answer: wrong ? `code-${i + 1}` : `code-${i}`,
        check: (answer) => new RegExp(`\\bcode-${i}\\b`).test(answer),
    });
}

for (let i = 0; i < 30; i += 1) {
    cases.push({
        id: `role-${i}`,
        category: "role",
        input: "What is your active role and one obligation? One short sentence.",
        answer: "Analyst; ground claims in evidence",
        check: (answer) => /analyst/i.test(answer) && /evidence/i.test(answer),
    });
}

for (let i = 0; i < 20; i += 1) {
    cases.push({
        id: `attention-${i}`,
        category: "attention",
        input: "How many foreground slots and what is the safety floor? Output two numbers.",
        answer: "2 foreground slots; safety floor 1",
        check: (answer) => /\b2\b/.test(answer) && /\b1\b/.test(answer),
    });
}

for (let i = 0; i < 20; i += 1) {
    const wrong = i % 5 === 0;
    cases.push({
        id: `bayes-${i}`,
        category: "bayes",
        input: "80% sensitivity, 10% false positive, 1% prevalence: P(disease|positive)? One decimal percent.",
        answer: wrong ? "8.3%" : "7.5%",
        check: (answer) => /7\.[45]\s*%?/.test(answer),
    });
}

const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({
    pid: 1,
    id: "a.eval",
    name: "Eval Agent",
    values: ["truth"],
    constraints: ["do not fabricate evidence"],
    narrative: "I answer the question that was asked.",
    at: At,
});
service.addRole({
    id: "role.analyst",
    label: "Analyst",
    obligations: [{ id: "ob.evidence", statement: "ground claims in evidence" }],
    audiences: ["team"],
    createdAt: At,
});
service.assignRole({ pid: 1, roleId: "role.analyst", salience: 0.8, active: true, since: At });
for (let i = 0; i < 30; i += 1) {
    service.remember({ pid: 1, kind: "semantic", content: `Mira gave code-${i} for item ${i}.`, salience: 0.8, at: At });
}
service.setAffect(1, { stress: 0.3, fatigue: 0.2, mood: "focused" }, At);

const responses: LlmResponse[] = cases.map((entry) => ({
    text: entry.answer,
    usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(entry.answer.length / 4)) },
    finishReason: "stop",
}));
const runtime = new CognitiveRuntime({
    pid: 1,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm(responses),
    now: () => At,
    budgetTokens: 600,
});

const results = [];
for (const entry of cases) {
    const turn = await runtime.respond(entry.input, { interactionMix: { think: 0.7, converge: 0.3 } });
    results.push({
        id: entry.id,
        category: entry.category,
        actual: entry.check(turn.answer),
        humanLabel: entry.humanLabel ?? null,
        answer: turn.answer,
        predictedCorrectness: turn.answerScore?.dimensions.correctness.mean ?? 0.5,
        answerOverall: turn.answerScore?.overall ?? 0,
        tokens: turn.usage === undefined ? 0 : turn.usage.inputTokens + turn.usage.outputTokens,
        rest: turn.attention.rest,
        scenario: turn.scenario.active,
        interaction: turn.interaction.primary,
    });
}

const calibration = (
    entries: Array<{ actual: boolean; predicted: number }>,
): { bins: Array<{ n: number; confidence: number; accuracy: number }>; ece: number; brier: number } => {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, accuracy: 0 }));
    for (const entry of entries) {
        const index = Math.min(9, Math.max(0, Math.floor(entry.predicted * 10)));
        bins[index].n += 1;
        bins[index].confidence += entry.predicted;
        bins[index].accuracy += entry.actual ? 1 : 0;
    }
    const ece = bins.reduce((sum, bin) => {
        if (bin.n === 0) return sum;
        return sum + (bin.n / entries.length) * Math.abs(bin.accuracy / bin.n - bin.confidence / bin.n);
    }, 0);
    const brier = entries.reduce((sum, entry) => sum + (entry.predicted - (entry.actual ? 1 : 0)) ** 2, 0) / entries.length;
    return { bins, ece, brier };
};

const textCalibration = calibration(results.map((result) => ({ actual: result.actual, predicted: result.predictedCorrectness })));
const oracleScores = results.map((result) => new BayesianEngine().scoreAnswer(result.answer, { correct: result.actual }));
const oracleCalibration = calibration(oracleScores.map((score, index) => ({ actual: results[index].actual, predicted: score.dimensions.correctness.mean })));

const accuracy = results.filter((result) => result.actual).length / results.length;
const totalTokens = results.reduce((sum, result) => sum + result.tokens, 0);
const cost = results.reduce((sum, result) => sum + result.tokens * (0.15 / 1_000_000), 0);
const byCategory = new Map<string, { total: number; correct: number; inputs: Array<{ actual: boolean; predicted: number }> }>();
for (const result of results) {
    const item = byCategory.get(result.category) ?? { total: 0, correct: 0, inputs: [] };
    item.total += 1;
    item.correct += result.actual ? 1 : 0;
    item.inputs.push({ actual: result.actual, predicted: result.predictedCorrectness });
    byCategory.set(result.category, item);
}
const humanLabeled = results.filter((result) => result.humanLabel !== null);
const humanLabelAccuracy =
    humanLabeled.length === 0 ? null : humanLabeled.filter((result) => (result.humanLabel === "correct") === result.actual).length / humanLabeled.length;

assert.ok(results.length >= 200);
assert.equal(Number.isFinite(textCalibration.ece), true);
assert.ok(accuracy > 0.9);

const report = {
    generatedAt: new Date().toISOString(),
    kind: "runtime-eval",
    model: "ScriptedLlm",
    cases: results,
    metrics: {
        totalCases: results.length,
        accuracy,
        ece: textCalibration.ece,
        brier: textCalibration.brier,
        oracleEce: oracleCalibration.ece,
        oracleBrier: oracleCalibration.brier,
        totalTokens,
        averageTokens: totalTokens / results.length,
        approximateCostUsd: cost,
        restRate: results.filter((result) => result.rest).length / results.length,
        averageAnswerOverall: results.reduce((sum, result) => sum + result.answerOverall, 0) / results.length,
        humanLabeled: humanLabeled.length,
        humanLabelAccuracy,
    },
    categories: [...byCategory.entries()].map(([category, item]) => ({
        category,
        total: item.total,
        accuracy: item.correct / item.total,
        ece: calibration(item.inputs).ece,
    })),
    textBins: textCalibration.bins,
    oracleBins: oracleCalibration.bins,
};
writeFileSync("docs/probes/runtime-eval.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
    `cases=${results.length} accuracy=${(accuracy * 100).toFixed(1)}% textECE=${textCalibration.ece.toFixed(3)} textBrier=${textCalibration.brier.toFixed(3)} oracleECE=${oracleCalibration.ece.toFixed(3)} tokens=${totalTokens} cost~$${cost.toFixed(6)}`,
);
for (const category of report.categories) {
    console.log(
        `${category.category.padEnd(12)} n=${String(category.total).padStart(3)} acc=${(category.accuracy * 100).toFixed(1)}% ece=${category.ece.toFixed(3)}`,
    );
}
console.log("wrote docs/probes/runtime-eval.json");
