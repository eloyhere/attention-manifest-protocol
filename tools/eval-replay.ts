#!/usr/bin/env node
/**
 * Replay eval with fixture human labels.
 *
 * The labels in docs/eval/replay-cases.json are curated fixtures, not a human
 * study. This validates the label->metric path and replay plumbing.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { agreementRate, cohenKappa } from "../src/evaluation/agreement.ts";

interface ReplayCase {
    id: string;
    category: string;
    input: string;
    answer: string;
    expected: string;
    humanLabel: "correct" | "incorrect";
}

const At = "2026-10-24T00:00:00.000Z";
const cases = JSON.parse(readFileSync("docs/eval/replay-cases.json", "utf8")) as ReplayCase[];
const labelsB = JSON.parse(readFileSync("docs/eval/replay-labels-b.json", "utf8")) as Array<{ id: string; label: string }>;
const labelB = new Map(labelsB.map((entry) => [entry.id, entry.label]));
assert.ok(cases.length >= 10);
assert.equal(
    cases.every((entry) => entry.humanLabel === "correct" || entry.humanLabel === "incorrect"),
    true,
);
assert.equal(
    cases.every((entry) => labelB.has(entry.id)),
    true,
);

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const check = (answer: string, expected: string): boolean => new RegExp(`\\b${escape(expected)}\\b`, "i").test(answer);

const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({ pid: 1, id: "a.replay", name: "Replay Agent", at: At });
const responses: LlmResponse[] = cases.map((entry) => ({
    text: entry.answer,
    usage: { inputTokens: 10, outputTokens: 3 },
    finishReason: "stop",
}));
const runtime = new CognitiveRuntime({
    pid: 1,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm(responses),
    now: () => At,
});

const results = [];
for (const entry of cases) {
    const turn = await runtime.respond(entry.input, { interactionMix: { think: 1 } });
    const actual = check(turn.answer, entry.expected);
    results.push({
        id: entry.id,
        category: entry.category,
        actual,
        humanLabel: entry.humanLabel,
        labelAgrees: (entry.humanLabel === "correct") === actual,
        predictedCorrectness: turn.answerScore?.dimensions.correctness.mean ?? 0.5,
        answer: turn.answer,
    });
}

const labelAgreement = results.filter((result) => result.labelAgrees).length / results.length;
const accuracy = results.filter((result) => result.actual).length / results.length;
const brier = results.reduce((sum, result) => sum + (result.predictedCorrectness - (result.actual ? 1 : 0)) ** 2, 0) / results.length;
const labelsA = results.map((result) => result.humanLabel);
const labelsBRows = results.map((result) => labelB.get(result.id) ?? result.humanLabel);
const annotatorAgreement = agreementRate(labelsA, labelsBRows);
const kappa = cohenKappa(labelsA, labelsBRows);
const report = {
    generatedAt: new Date().toISOString(),
    kind: "eval-replay",
    note: "fixture labels, not a human study",
    cases: results,
    metrics: {
        total: results.length,
        accuracy,
        humanLabeled: results.length,
        humanLabelAgreement: labelAgreement,
        annotatorAgreement,
        cohenKappa: kappa,
        brier,
    },
};
writeFileSync("docs/probes/eval-replay.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
assert.equal(labelAgreement, 1);

console.log(
    `cases=${results.length} accuracy=${(accuracy * 100).toFixed(0)}% labelAgreement=${(labelAgreement * 100).toFixed(0)}% annotatorAgreement=${(annotatorAgreement * 100).toFixed(0)}% kappa=${kappa.toFixed(3)} brier=${brier.toFixed(3)}`,
);
console.log("wrote docs/probes/eval-replay.json");
