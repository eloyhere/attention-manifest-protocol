#!/usr/bin/env node
/**
 * Aggregate eval artifacts into one report. Source data remains authoritative in
 * the per-probe JSON files; this tool does not re-run the runtime.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { CalibrationRegistry } from "../src/bayes/calibrationRegistry.ts";
import { auditLabels, importAnnotations } from "../src/evaluation/labels.ts";

interface ReplayCase {
    id: string;
    actual: boolean;
    humanLabel: "correct" | "incorrect";
    predictedCorrectness: number;
}

interface ReplayProbe {
    metrics: {
        total: number;
        accuracy: number;
        humanLabelAgreement: number;
        annotatorAgreement: number;
        cohenKappa: number;
        brier: number;
    };
    cases: ReplayCase[];
}

interface RecordedCase {
    id: string;
    actual: boolean;
    textCorrectness: number;
    oracleCorrectness: number;
}

interface RecordedProbe {
    metrics: {
        accuracy: number;
        textEce: number;
        oracleEce: number;
        labeled: number;
        calibrationTemperature?: number | null;
        calibrationCiLower?: number | null;
        calibrationCiUpper?: number | null;
        [key: string]: number | string | null;
    };
    cases: RecordedCase[];
}

interface ContextAstProbe {
    context: { nodes: number; viewTokens: number; flatTokens: number; refs: number };
    conditions: Array<{
        id: string;
        inputTokens: number;
        summary: { layer: string | null };
        detail: { pid: string | null; lock: string | null; toolCalls: string[] };
    }>;
}

const replay = JSON.parse(readFileSync("docs/probes/eval-replay.json", "utf8")) as ReplayProbe;
const recorded = JSON.parse(readFileSync("docs/probes/eval-recorded-replay.json", "utf8")) as RecordedProbe;
const cases = JSON.parse(readFileSync("docs/eval/replay-cases.json", "utf8")) as Array<{ id: string }>;
const annotations = importAnnotations(JSON.parse(readFileSync("docs/eval/annotations.json", "utf8")));
const audit = auditLabels(
    cases.map((entry) => entry.id),
    annotations,
);

const registry = new CalibrationRegistry();
const points = recorded.cases.map((entry) => ({ actual: entry.actual, predicted: entry.textCorrectness }));
const calibration = registry.register("recorded", points);
const contextPath = "docs/probes/context-ast-deepseek.json";
const contextProbe = existsSync(contextPath) ? (JSON.parse(readFileSync(contextPath, "utf8")) as ContextAstProbe) : null;
const astSummary =
    contextProbe === null
        ? null
        : {
              nodes: contextProbe.context.nodes,
              summaryTokens: contextProbe.context.viewTokens,
              flatTokens: contextProbe.context.flatTokens,
              flatApiTokens: contextProbe.conditions.find((entry) => entry.id === "flat")?.inputTokens ?? null,
              astApiTokens: contextProbe.conditions.find((entry) => entry.id === "ast-summary")?.inputTokens ?? null,
              astToolApiTokens: contextProbe.conditions.find((entry) => entry.id === "ast-tool")?.inputTokens ?? null,
              detailRecovered: contextProbe.conditions.find((entry) => entry.id === "ast-tool")?.detail.pid === "4711",
          };

const summary = {
    generatedAt: new Date().toISOString(),
    replay: {
        cases: replay.metrics.total,
        accuracy: replay.metrics.accuracy,
        humanLabelAgreement: replay.metrics.humanLabelAgreement,
        annotatorAgreement: replay.metrics.annotatorAgreement,
        cohenKappa: replay.metrics.cohenKappa,
        brier: replay.metrics.brier,
    },
    recorded: {
        runs: recorded.cases.length,
        accuracy: recorded.metrics.accuracy,
        textEce: recorded.metrics.textEce,
        calibratedEce: calibration.selection.ece,
        method: calibration.selection.method,
        status: calibration.status,
        oracleEce: recorded.metrics.oracleEce,
        labels: recorded.metrics.labeled,
        temperature: recorded.metrics.calibrationTemperature ?? null,
        ciLower: recorded.metrics.calibrationCiLower ?? null,
        ciUpper: recorded.metrics.calibrationCiUpper ?? null,
    },
    labels: {
        cases: audit.cases,
        annotations: audit.annotations,
        coverage: audit.coverage,
        duplicates: audit.duplicates.length,
        disagreements: audit.disagreements.length,
        kappa: audit.pairwiseKappa[0]?.kappa ?? null,
        unresolved: Object.values(audit.adjudicated).filter((label) => label === null).length,
    },
    contextAst: astSummary,
};

assert.equal(summary.replay.cases, 12);
assert.equal(summary.recorded.runs, 40);
assert.equal(summary.labels.coverage, 1);
if (astSummary !== null) {
    assert.equal(astSummary.detailRecovered, true);
}

const markdown = `# AMP eval summary

Generated: ${summary.generatedAt}

> Fixture labels only; not an independent human study. Recorded n=${summary.recorded.runs}; replay n=${summary.replay.cases}.

| Surface | Metric | Value |
|---|---|---|
| replay | accuracy | ${(summary.replay.accuracy * 100).toFixed(1)}% |
| replay | annotator agreement | ${(summary.replay.annotatorAgreement * 100).toFixed(0)}% |
| replay | Cohen's kappa | ${summary.replay.cohenKappa.toFixed(3)} |
| replay | Brier | ${summary.replay.brier.toFixed(3)} |
| recorded | accuracy | ${(summary.recorded.accuracy * 100).toFixed(1)}% |
| recorded | text ECE | ${Number(summary.recorded.textEce).toFixed(3)} |
| recorded | calibrated ECE | ${summary.recorded.calibratedEce.toFixed(3)} |
| recorded | calibration | ${summary.recorded.status} (${summary.recorded.method}${summary.recorded.temperature === null ? "" : ` T=${summary.recorded.temperature}`}${summary.recorded.ciLower === null ? "" : ` CI=[${summary.recorded.ciLower},${summary.recorded.ciUpper}]`}) |
| recorded | oracle ECE | ${Number(summary.recorded.oracleEce).toFixed(3)} |
| labels | coverage | ${(summary.labels.coverage * 100).toFixed(0)}% |
| labels | disagreements | ${summary.labels.disagreements} |
| labels | kappa | ${summary.labels.kappa === null ? "n/a" : summary.labels.kappa.toFixed(3)} |
| labels | unresolved | ${summary.labels.unresolved} |
${
    astSummary === null
        ? ""
        : `| context AST | nodes | ${astSummary.nodes} |
| context AST | summary tokens | ${astSummary.summaryTokens} |
| context AST | flat tokens | ${astSummary.flatTokens} |
| context AST | DeepSeek flat input | ${astSummary.flatApiTokens ?? "n/a"} |
| context AST | DeepSeek AST input | ${astSummary.astApiTokens ?? "n/a"} |
| context AST | DeepSeek AST+tool input | ${astSummary.astToolApiTokens ?? "n/a"} |
| context AST | detail recovered | ${astSummary.detailRecovered ? "yes" : "no"} |`
}

Calibration map is activated only when cross-validated ECE beats raw by the registry margin. A \`raw\` status means the data did not justify a map.
`;

writeFileSync("docs/probes/eval-summary.json", `${JSON.stringify(summary, null, 2)}\n`, "utf8");
writeFileSync("docs/eval-summary.md", markdown, "utf8");

console.log(
    `replay=${summary.replay.cases} recorded=${summary.recorded.runs} kappa=${summary.replay.cohenKappa.toFixed(3)} calibration=${summary.recorded.status}/${summary.recorded.method} astTokens=${astSummary?.astApiTokens ?? "n/a"}/${astSummary?.flatApiTokens ?? "n/a"}`,
);
console.log("wrote docs/probes/eval-summary.json and docs/eval-summary.md");
