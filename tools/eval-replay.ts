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
import type { RuntimeTurn } from "../src/runtime/cognitiveRuntime.ts";
import { agreementRate, cohenKappa } from "../src/evaluation/agreement.ts";

interface ReplayCase {
    id: string;
    category: string;
    input: string;
    answer: string;
    expected: string;
    humanLabel: "correct" | "incorrect";
}

type LabelRow = {
    id: string;
    label: string;
};

type ReplayResult = {
    id: string;
    category: string;
    actual: boolean;
    humanLabel: "correct" | "incorrect";
    labelAgrees: boolean;
    predictedCorrectness: number;
    answer: string;
};

type ReplayMetrics = {
    total: number;
    accuracy: number;
    humanLabeled: number;
    humanLabelAgreement: number;
    annotatorAgreement: number;
    cohenKappa: number;
    brier: number;
};

type ReplayReport = {
    generatedAt: string;
    kind: string;
    note: string;
    cases: ReplayResult[];
    metrics: ReplayMetrics;
};

type CheckFn = (answer: string, expected: string) => boolean;

const At: string = "2026-10-24T00:00:00.000Z";
const Cases: ReplayCase[] = JSON.parse(readFileSync("docs/eval/replay-cases.json", "utf8")) as ReplayCase[];
const LabelsB: LabelRow[] = JSON.parse(readFileSync("docs/eval/replay-labels-b.json", "utf8")) as LabelRow[];
const LabelB: Map<string, string> = new Map(LabelsB.map((entry) => [entry.id, entry.label]));
assert.ok(Cases.length >= 10);
assert.equal(
    Cases.every((entry) => entry.humanLabel === "correct" || entry.humanLabel === "incorrect"),
    true,
);
assert.equal(
    Cases.every((entry) => LabelB.has(entry.id)),
    true,
);

const escape: (value: string) => string = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const check: CheckFn = (answer: string, expected: string): boolean => new RegExp(`\\b${escape(expected)}\\b`, "i").test(answer);

const Service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
Service.createAgent({ pid: 1, id: "a.replay", name: "Replay Agent", at: At });
const Responses: LlmResponse[] = Cases.map((entry) => ({
    text: entry.answer,
    usage: { inputTokens: 10, outputTokens: 3 },
    finishReason: "stop",
}));
const Runtime: CognitiveRuntime = new CognitiveRuntime({
    pid: 1,
    agent: Service.agents,
    social: Service.social,
    llm: new ScriptedLlm(Responses),
    now: () => At,
});

const Results: ReplayResult[] = [];
for (let caseIndex: number = 0; caseIndex < Cases.length; caseIndex += 1) {
    const entry: ReplayCase = Cases[caseIndex];
    const turn: RuntimeTurn = await Runtime.respond(entry.input, { interactionMix: { think: 1 } });
    const actual: boolean = check(turn.answer, entry.expected);
    Results.push({
        id: entry.id,
        category: entry.category,
        actual,
        humanLabel: entry.humanLabel,
        labelAgrees: (entry.humanLabel === "correct") === actual,
        predictedCorrectness: turn.answerScore?.dimensions.correctness.mean ?? 0.5,
        answer: turn.answer,
    });
}

const LabelAgreement: number = Results.filter((result) => result.labelAgrees).length / Results.length;
const Accuracy: number = Results.filter((result) => result.actual).length / Results.length;
const Brier: number = Results.reduce((sum, result) => sum + (result.predictedCorrectness - (result.actual ? 1 : 0)) ** 2, 0) / Results.length;
const LabelsA: string[] = Results.map((result) => result.humanLabel);
const LabelsBRows: string[] = Results.map((result) => LabelB.get(result.id) ?? result.humanLabel);
const AnnotatorAgreement: number = agreementRate(LabelsA, LabelsBRows);
const Kappa: number = cohenKappa(LabelsA, LabelsBRows);
const Report: ReplayReport = {
    generatedAt: new Date().toISOString(),
    kind: "eval-replay",
    note: "fixture labels, not a human study",
    cases: Results,
    metrics: {
        total: Results.length,
        accuracy: Accuracy,
        humanLabeled: Results.length,
        humanLabelAgreement: LabelAgreement,
        annotatorAgreement: AnnotatorAgreement,
        cohenKappa: Kappa,
        brier: Brier,
    },
};
writeFileSync("docs/probes/eval-replay.json", `${JSON.stringify(Report, null, 2)}\n`, "utf8");
assert.equal(LabelAgreement, 1);

console.log(
    `cases=${Results.length} accuracy=${(Accuracy * 100).toFixed(0)}% labelAgreement=${(LabelAgreement * 100).toFixed(0)}% annotatorAgreement=${(AnnotatorAgreement * 100).toFixed(0)}% kappa=${Kappa.toFixed(3)} brier=${Brier.toFixed(3)}`,
);
console.log("wrote docs/probes/eval-replay.json");
