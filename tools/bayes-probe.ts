#!/usr/bin/env node
/**
 * Post-hoc Bayesian scoring of docs/probes/deepseek-probe.json.
 *
 * No API calls. Each run gets:
 * - user posterior: clarity/specificity/context/emotion/urgency/openness
 * - answer posterior: correctness/grounding/coherence/conciseness/calibration/safety
 * - attention posterior: load/stress/fatigue/recovery debt/health
 *
 * This shows what the scoring engine adds without changing the answers.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { BayesianEngine } from "../src/bayes/engine.ts";
import { resolveInteraction } from "../src/interaction/interaction.ts";

interface ProbeTask {
    suite: "objective" | "context";
    id: string;
    prompt: string;
    expected: string;
}

interface ProbeRun {
    suite: "objective" | "context";
    condition: string;
    task: string;
    answer: string;
    correct: boolean;
    totalTokens: number;
    costUsd: number;
    attention?: {
        utilization: number;
        pressure: number;
        recoveryDebt: number;
        foregroundSlots: number;
        safetySlots: number;
    };
}

interface ProbeFile {
    generatedAt: string;
    model: string;
    tasks: ProbeTask[];
    runs: ProbeRun[];
}

const source = JSON.parse(readFileSync("docs/probes/deepseek-probe.json", "utf8")) as ProbeFile;
const taskById = new Map(source.tasks.map((task) => [task.id, task]));
const engine = new BayesianEngine();
const think = resolveInteraction({ think: 1 });
const affect = resolveInteraction({ affect: 1 });

const runs = source.runs.map((run) => {
    const task = taskById.get(run.task);
    if (task === (void 0)) {
        throw new Error(`missing task ${run.task}`);
    }
    const user = engine.scoreUser(task.prompt);
    const answer = engine.scoreAnswer(run.answer, { correct: run.correct, targetTokens: 64 });
    const attention =
        run.attention === (void 0)
            ? null
            : engine.scoreAttention({
                  utilization: run.attention.utilization,
                  pressure: run.attention.pressure,
                  recoveryDebt: run.attention.recoveryDebt,
                  errors: 0,
                  switches: 0,
              });
    return {
        task: run.task,
        suite: run.suite,
        condition: run.condition,
        correct: run.correct,
        tokens: run.totalTokens,
        user: {
            clarity: user.dimensions.clarity.mean,
            specificity: user.dimensions.specificity.mean,
            context: user.dimensions.contextSufficiency.mean,
            emotion: user.state.emotionalIntensity,
            urgency: user.state.urgency,
            openness: user.state.openness,
            quality: user.quality,
        },
        answer: {
            correctness: answer.dimensions.correctness.mean,
            grounding: answer.dimensions.grounding.mean,
            coherence: answer.dimensions.coherence.mean,
            conciseness: answer.dimensions.conciseness.mean,
            calibration: answer.dimensions.calibration.mean,
            safety: answer.dimensions.safety.mean,
            actionability: answer.dimensions.actionability.mean,
            overall: answer.overall,
        },
        attention:
            attention === null
                ? null
                : {
                      health: attention.health,
                      load: attention.dimensions.load.mean,
                      stress: attention.dimensions.stress.mean,
                      fatigue: attention.dimensions.fatigue.mean,
                  },
        fit: {
            think: engine.interactionFit(user, think).score,
            affect: engine.interactionFit(user, affect).score,
        },
    };
});

const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

const groups = new Map<string, typeof runs>();
for (const run of runs) {
    const key = `${run.suite}/${run.condition}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
}

const summary = [...groups.entries()].map(([key, list]) => {
    const [suite, condition] = key.split("/");
    const attentionRows = list.filter((run) => run.attention !== null);
    return {
        suite,
        condition,
        runs: list.length,
        accuracy: list.filter((run) => run.correct).length / list.length,
        answerOverall: average(list.map((run) => run.answer.overall)),
        correctness: average(list.map((run) => run.answer.correctness)),
        grounding: average(list.map((run) => run.answer.grounding)),
        calibration: average(list.map((run) => run.answer.calibration)),
        attentionHealth: attentionRows.length === 0 ? null : average(attentionRows.map((run) => (run.attention as { health: number }).health)),
        userClarity: average(list.map((run) => run.user.clarity)),
        avgTokens: average(list.map((run) => run.tokens)),
    };
});

writeFileSync("docs/probes/bayes-scores.json", `${JSON.stringify({ source: source.generatedAt, model: source.model, runs, summary }, null, 2)}\n`, "utf8");

console.log("suite/condition              acc   answer  correct  ground  calib  attnHealth  clarity  avgTok");
for (const row of summary) {
    console.log(
        `${`${row.suite}/${row.condition}`.padEnd(28)} ` +
            `${(row.accuracy * 100).toFixed(0).padStart(4)}%  ` +
            `${row.answerOverall.toFixed(3).padStart(6)}  ` +
            `${row.correctness.toFixed(3).padStart(7)}  ` +
            `${row.grounding.toFixed(3).padStart(6)}  ` +
            `${row.calibration.toFixed(3).padStart(5)}  ` +
            `${(row.attentionHealth === null ? "n/a" : row.attentionHealth.toFixed(3)).padStart(10)}  ` +
            `${row.userClarity.toFixed(3).padStart(7)}  ` +
            `${row.avgTokens.toFixed(0).padStart(6)}`,
    );
}
console.log("\nwrote docs/probes/bayes-scores.json");
