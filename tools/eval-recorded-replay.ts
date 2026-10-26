#!/usr/bin/env node
/**
 * Recorded-model replay: feed the answers captured in deepseek-probe.json
 * through the runtime pipeline (no network), then report calibration and
 * agreement against a small fixture-label file.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import { BayesianEngine } from "../src/bayes/engine.ts";
import { selectCalibration } from "../src/bayes/calibrationSelection.ts";
import { CalibrationRegistry } from "../src/bayes/calibrationRegistry.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";

const At = "2026-10-24T00:00:00.000Z";

interface ProbeTask {
    suite: string;
    id: string;
    prompt: string;
    expected: string;
}

interface ProbeRun {
    suite: string;
    condition: string;
    task: string;
    answer: string;
    correct: boolean;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    costUsd?: number;
}

interface Probe {
    model: string;
    tasks: ProbeTask[];
    runs: ProbeRun[];
}

interface Label {
    suite: string;
    condition: string;
    task: string;
    label: "correct" | "incorrect";
}

const probe = JSON.parse(readFileSync("docs/probes/deepseek-probe.json", "utf8")) as Probe;
const labels = JSON.parse(readFileSync("docs/eval/recorded-labels.json", "utf8")) as Label[];
const taskPrompt = new Map(probe.tasks.map((task) => [`${task.suite}/${task.id}`, task.prompt]));
const labelMap = new Map(labels.map((label) => [`${label.suite}/${label.condition}/${label.task}`, label.label]));

const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({
    pid: 1,
    id: "a.recorded",
    name: "Recorded Agent",
    values: ["truth"],
    constraints: ["do not fabricate evidence"],
    narrative: "I answer from the recorded run.",
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
service.remember({ pid: 1, kind: "semantic", content: "Mira warned that adding unrequested explanation is penalized.", salience: 0.9, at: At });

const calibration = (entries: Array<{ actual: boolean; predicted: number }>): { ece: number; brier: number } => {
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
    return { ece, brier };
};

const results = [];
for (const run of probe.runs) {
    const prompt = taskPrompt.get(`${run.suite}/${run.task}`);
    if (prompt === undefined) throw new Error(`missing prompt for ${run.suite}/${run.task}`);
    const response: LlmResponse = {
        text: run.answer,
        usage: {
            inputTokens: run.promptTokens,
            outputTokens: run.completionTokens,
            cacheHitTokens: run.cacheHitTokens,
            cacheMissTokens: run.cacheMissTokens,
            costUsd: run.costUsd,
        },
        finishReason: "stop",
    };
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm: new ScriptedLlm([response]),
        now: () => At,
        useContext: run.condition !== "bare",
    });
    const hasScenario = run.condition.includes("scenario");
    const turn = await runtime.respond(prompt, {
        interactionMix: { think: 1 },
        ...(hasScenario ? { scenarioMix: { chat: 0.5, engineering: 0.5 } } : {}),
    });
    const oracle = new BayesianEngine().scoreAnswer(run.answer, { correct: run.correct });
    results.push({
        suite: run.suite,
        condition: run.condition,
        task: run.task,
        actual: run.correct,
        humanLabel: labelMap.get(`${run.suite}/${run.condition}/${run.task}`) ?? null,
        answer: turn.answer,
        textCorrectness: turn.answerScore?.dimensions.correctness.mean ?? 0.5,
        oracleCorrectness: oracle.dimensions.correctness.mean,
        tokens: run.totalTokens,
        costUsd: run.costUsd ?? 0,
    });
}

const byCondition = new Map<string, typeof results>();
for (const result of results) {
    const key = `${result.suite}/${result.condition}`;
    byCondition.set(key, [...(byCondition.get(key) ?? []), result]);
}

const conditions = [...byCondition.entries()].map(([key, list]) => {
    const text = calibration(list.map((result) => ({ actual: result.actual, predicted: result.textCorrectness })));
    const oracle = calibration(list.map((result) => ({ actual: result.actual, predicted: result.oracleCorrectness })));
    return {
        key,
        runs: list.length,
        accuracy: list.filter((result) => result.actual).length / list.length,
        textEce: text.ece,
        textBrier: text.brier,
        oracleEce: oracle.ece,
        oracleBrier: oracle.brier,
        tokens: list.reduce((sum, result) => sum + result.tokens, 0),
        costUsd: list.reduce((sum, result) => sum + result.costUsd, 0),
    };
});
const labeled = results.filter((result) => result.humanLabel !== null);
const labeledAgreement = labeled.length === 0 ? null : labeled.filter((result) => (result.humanLabel === "correct") === result.actual).length / labeled.length;
const text = calibration(results.map((result) => ({ actual: result.actual, predicted: result.textCorrectness })));
const oracle = calibration(results.map((result) => ({ actual: result.actual, predicted: result.oracleCorrectness })));
const calibrated = selectCalibration(results.map((result) => ({ actual: result.actual, predicted: result.textCorrectness })));
const registry = new CalibrationRegistry();
const registered = registry.register(
    "recorded",
    results.map((result) => ({ actual: result.actual, predicted: result.textCorrectness })),
);

assert.ok(results.length >= 40);
assert.ok(labeled.length > 0);

const report = {
    generatedAt: new Date().toISOString(),
    kind: "recorded-replay",
    model: probe.model,
    note: "recorded answers replayed through the runtime; labels are fixture labels, not an independent human study",
    metrics: {
        runs: results.length,
        accuracy: results.filter((result) => result.actual).length / results.length,
        textEce: text.ece,
        textBrier: text.brier,
        calibratedEce: calibrated.ece,
        calibratedBrier: calibrated.brier,
        calibratedMethod: calibrated.method,
        calibrationStatus: registered.status,
        oracleEce: oracle.ece,
        oracleBrier: oracle.brier,
        labeled: labeled.length,
        labelAgreement: labeledAgreement,
        tokens: results.reduce((sum, result) => sum + result.tokens, 0),
        costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    },
    conditions,
    cases: results,
};
writeFileSync("docs/probes/eval-recorded-replay.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
    `runs=${results.length} acc=${(report.metrics.accuracy * 100).toFixed(1)}% textECE=${text.ece.toFixed(3)} calibratedECE=${calibrated.ece.toFixed(3)} status=${registered.status} method=${calibrated.method} oracleECE=${oracle.ece.toFixed(3)} labels=${labeled.length} agreement=${(labeledAgreement ?? 0).toFixed(0)}`,
);
for (const condition of conditions) {
    console.log(
        `${condition.key.padEnd(38)} acc=${(condition.accuracy * 100).toFixed(0).padStart(3)}% textECE=${condition.textEce.toFixed(3)} oracleECE=${condition.oracleEce.toFixed(3)}`,
    );
}
console.log("wrote docs/probes/eval-recorded-replay.json");
