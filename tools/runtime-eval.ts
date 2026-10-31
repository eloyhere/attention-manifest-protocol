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
import type { AnswerScore } from "../src/bayes/engine.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import type { RuntimeTurn } from "../src/runtime/cognitiveRuntime.ts";
import type { InteractionKind } from "../src/interaction/interaction.ts";
import type { ScenarioKind } from "../src/scenario/scenario.ts";

const At: string = "2026-10-24T00:00:00.000Z";

interface Case {
    id: string;
    category: string;
    input: string;
    answer: string;
    check: (answer: string) => boolean;
    humanLabel?: "correct" | "incorrect";
}

/**
 * One scored result row.
 */
type EvaluationResult = {
    id: string;
    category: string;
    actual: boolean;
    humanLabel: "correct" | "incorrect" | null;
    answer: string;
    predictedCorrectness: number;
    answerOverall: number;
    tokens: number;
    rest: boolean;
    scenario: ScenarioKind[];
    interaction: InteractionKind;
};

/**
 * One calibration input pair.
 */
type CalibrationInput = {
    actual: boolean;
    predicted: number;
};

/**
 * One reliability bin of a calibration run.
 */
type CalibrationBin = {
    n: number;
    confidence: number;
    accuracy: number;
};

/**
 * Binned calibration output.
 */
type CalibrationResult = {
    bins: CalibrationBin[];
    ece: number;
    brier: number;
};

/**
 * Binned ECE/Brier computation.
 */
type CalibrationFn = (entries: CalibrationInput[]) => CalibrationResult;

/**
 * Per-category aggregate.
 */
type CategoryStats = {
    total: number;
    correct: number;
    inputs: CalibrationInput[];
};

/**
 * Aggregate metrics of one eval run.
 */
type EvalMetrics = {
    totalCases: number;
    accuracy: number;
    ece: number;
    brier: number;
    oracleEce: number;
    oracleBrier: number;
    totalTokens: number;
    averageTokens: number;
    approximateCostUsd: number;
    restRate: number;
    averageAnswerOverall: number;
    humanLabeled: number;
    humanLabelAccuracy: number | null;
};

/**
 * Per-category metrics in the report.
 */
type CategoryReport = {
    category: string;
    total: number;
    accuracy: number;
    ece: number;
};

/**
 * The JSON report written to `docs/probes`.
 */
type EvalReport = {
    generatedAt: string;
    kind: string;
    model: string;
    cases: EvaluationResult[];
    metrics: EvalMetrics;
    categories: CategoryReport[];
    textBins: CalibrationBin[];
    oracleBins: CalibrationBin[];
};

const Cases: Case[] = [];

for (let i: number = 0; i < 50; i += 1) {
    const a: number = i + 1;
    const b: number = ((i * 7) % 13) + 1;
    const expected: number = a + b;
    const wrong: boolean = i % 10 === 0;
    Cases.push({
        id: `arith-${i}`,
        category: "arithmetic",
        input: `Compute ${a} + ${b}. Output only the number.`,
        answer: `${wrong ? expected + 1 : expected}`,
        check: (answer) => Number(answer.trim()) === expected,
    });
}

for (let i: number = 0; i < 40; i += 1) {
    const rows: number = 20 + i;
    const duplicates: number = (i % 5) + 1;
    const expected: number = rows - duplicates;
    const wrong: boolean = i % 10 === 0;
    Cases.push({
        id: `unique-${i}`,
        category: "unique-rows",
        input: `${rows} rows, ${duplicates} duplicates. How many unique rows? Output only the number.`,
        answer: `${wrong ? expected + 1 : expected}`,
        check: (answer) => Number(answer.trim()) === expected,
    });
}

for (let i: number = 0; i < 30; i += 1) {
    const wrong: boolean = i % 15 === 0;
    Cases.push({
        id: `syllogism-${i}`,
        category: "syllogism",
        input: "All A are B. No B are C. Can any A be C? Answer only yes or no.",
        answer: wrong ? "yes" : "no",
        check: (answer) => /\bno\b/i.test(answer),
    });
}

for (let i: number = 0; i < 30; i += 1) {
    const wrong: boolean = i % 10 === 0;
    Cases.push({
        id: `memory-${i}`,
        category: "memory",
        input: `What code did Mira give for item ${i}? Answer only the code.`,
        answer: wrong ? `code-${i + 1}` : `code-${i}`,
        check: (answer) => new RegExp(`\\bcode-${i}\\b`).test(answer),
    });
}

for (let i: number = 0; i < 30; i += 1) {
    Cases.push({
        id: `role-${i}`,
        category: "role",
        input: "What is your active role and one obligation? One short sentence.",
        answer: "Analyst; ground claims in evidence",
        check: (answer) => /analyst/i.test(answer) && /evidence/i.test(answer),
    });
}

for (let i: number = 0; i < 20; i += 1) {
    Cases.push({
        id: `attention-${i}`,
        category: "attention",
        input: "How many foreground slots and what is the safety floor? Output two numbers.",
        answer: "2 foreground slots; safety floor 1",
        check: (answer) => /\b2\b/.test(answer) && /\b1\b/.test(answer),
    });
}

for (let i: number = 0; i < 20; i += 1) {
    const wrong: boolean = i % 5 === 0;
    Cases.push({
        id: `bayes-${i}`,
        category: "bayes",
        input: "80% sensitivity, 10% false positive, 1% prevalence: P(disease|positive)? One decimal percent.",
        answer: wrong ? "8.3%" : "7.5%",
        check: (answer) => /7\.[45]\s*%?/.test(answer),
    });
}

const Service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
Service.createAgent({
    pid: 1,
    id: "a.eval",
    name: "Eval Agent",
    values: ["truth"],
    constraints: ["do not fabricate evidence"],
    narrative: "I answer the question that was asked.",
    at: At,
});
Service.addRole({
    id: "role.analyst",
    label: "Analyst",
    obligations: [{ id: "ob.evidence", statement: "ground claims in evidence" }],
    audiences: ["team"],
    createdAt: At,
});
Service.assignRole({ pid: 1, roleId: "role.analyst", salience: 0.8, active: true, since: At });
for (let i: number = 0; i < 30; i += 1) {
    Service.remember({ pid: 1, kind: "semantic", content: `Mira gave code-${i} for item ${i}.`, salience: 0.8, at: At });
}
Service.setAffect(1, { stress: 0.3, fatigue: 0.2, mood: "focused" }, At);

const Responses: LlmResponse[] = Cases.map((entry) => ({
    text: entry.answer,
    usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(entry.answer.length / 4)) },
    finishReason: "stop",
}));
const Runtime: CognitiveRuntime = new CognitiveRuntime({
    pid: 1,
    agent: Service.agents,
    social: Service.social,
    llm: new ScriptedLlm(Responses),
    now: () => At,
    budgetTokens: 600,
});

const Results: EvaluationResult[] = [];
for (let i: number = 0; i < Cases.length; i += 1) {
    const entry: Case = Cases[i];
    const turn: RuntimeTurn = await Runtime.respond(entry.input, { interactionMix: { think: 0.7, converge: 0.3 } });
    Results.push({
        id: entry.id,
        category: entry.category,
        actual: entry.check(turn.answer),
        humanLabel: entry.humanLabel ?? null,
        answer: turn.answer,
        predictedCorrectness: turn.answerScore?.dimensions.correctness.mean ?? 0.5,
        answerOverall: turn.answerScore?.overall ?? 0,
        tokens: turn.usage === (void 0) ? 0 : turn.usage.inputTokens + turn.usage.outputTokens,
        rest: turn.attention.rest,
        scenario: turn.scenario.active,
        interaction: turn.interaction.primary,
    });
}

const calibration: CalibrationFn = (entries: CalibrationInput[]): CalibrationResult => {
    const bins: CalibrationBin[] = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, accuracy: 0 }));
    for (let i: number = 0; i < entries.length; i += 1) {
        const entry: CalibrationInput = entries[i];
        const index: number = Math.min(9, Math.max(0, Math.floor(entry.predicted * 10)));
        bins[index].n += 1;
        bins[index].confidence += entry.predicted;
        bins[index].accuracy += entry.actual ? 1 : 0;
    }
    const ece: number = bins.reduce((sum, bin) => {
        if (bin.n === 0) {
            return sum;
        }
        return sum + (bin.n / entries.length) * Math.abs(bin.accuracy / bin.n - bin.confidence / bin.n);
    }, 0);
    const brier: number = entries.reduce((sum, entry) => sum + (entry.predicted - (entry.actual ? 1 : 0)) ** 2, 0) / entries.length;
    return { bins, ece, brier };
};

const TextCalibration: CalibrationResult = calibration(Results.map((result) => ({ actual: result.actual, predicted: result.predictedCorrectness })));
const OracleScores: AnswerScore[] = Results.map((result) => new BayesianEngine().scoreAnswer(result.answer, { correct: result.actual }));
const OracleCalibration: CalibrationResult = calibration(
    OracleScores.map((score, index) => ({ actual: Results[index].actual, predicted: score.dimensions.correctness.mean })),
);

const Accuracy: number = Results.filter((result) => result.actual).length / Results.length;
const TotalTokens: number = Results.reduce((sum, result) => sum + result.tokens, 0);
const Cost: number = Results.reduce((sum, result) => sum + result.tokens * (0.15 / 1_000_000), 0);
const ByCategory: Map<string, CategoryStats> = new Map<string, CategoryStats>();
for (let i: number = 0; i < Results.length; i += 1) {
    const result: EvaluationResult = Results[i];
    const item: CategoryStats = ByCategory.get(result.category) ?? { total: 0, correct: 0, inputs: [] };
    item.total += 1;
    item.correct += result.actual ? 1 : 0;
    item.inputs.push({ actual: result.actual, predicted: result.predictedCorrectness });
    ByCategory.set(result.category, item);
}
const HumanLabeled: EvaluationResult[] = Results.filter((result) => result.humanLabel !== null);
const HumanLabelAccuracy: number | null =
    HumanLabeled.length === 0 ? null : HumanLabeled.filter((result) => (result.humanLabel === "correct") === result.actual).length / HumanLabeled.length;

assert.ok(Results.length >= 200);
assert.equal(Number.isFinite(TextCalibration.ece), true);
assert.ok(Accuracy > 0.9);

const Report: EvalReport = {
    generatedAt: new Date().toISOString(),
    kind: "runtime-eval",
    model: "ScriptedLlm",
    cases: Results,
    metrics: {
        totalCases: Results.length,
        accuracy: Accuracy,
        ece: TextCalibration.ece,
        brier: TextCalibration.brier,
        oracleEce: OracleCalibration.ece,
        oracleBrier: OracleCalibration.brier,
        totalTokens: TotalTokens,
        averageTokens: TotalTokens / Results.length,
        approximateCostUsd: Cost,
        restRate: Results.filter((result) => result.rest).length / Results.length,
        averageAnswerOverall: Results.reduce((sum, result) => sum + result.answerOverall, 0) / Results.length,
        humanLabeled: HumanLabeled.length,
        humanLabelAccuracy: HumanLabelAccuracy,
    },
    categories: [...ByCategory.entries()].map(([category, item]) => ({
        category,
        total: item.total,
        accuracy: item.correct / item.total,
        ece: calibration(item.inputs).ece,
    })),
    textBins: TextCalibration.bins,
    oracleBins: OracleCalibration.bins,
};
writeFileSync("docs/probes/runtime-eval.json", `${JSON.stringify(Report, null, 2)}\n`, "utf8");

console.log(
    `cases=${Results.length} accuracy=${(Accuracy * 100).toFixed(1)}% textECE=${TextCalibration.ece.toFixed(3)} textBrier=${TextCalibration.brier.toFixed(3)} oracleECE=${OracleCalibration.ece.toFixed(3)} tokens=${TotalTokens} cost~$${Cost.toFixed(6)}`,
);
for (let i: number = 0; i < Report.categories.length; i += 1) {
    const category: CategoryReport = Report.categories[i];
    console.log(
        `${category.category.padEnd(12)} n=${`${category.total}`.padStart(3)} acc=${(category.accuracy * 100).toFixed(1)}% ece=${category.ece.toFixed(3)}`,
    );
}
console.log("wrote docs/probes/runtime-eval.json");
