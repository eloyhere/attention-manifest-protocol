#!/usr/bin/env node
/** Annotation import + coverage/duplicate/disagreement/kappa audit. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { importAnnotations, auditLabels } from "../src/evaluation/labels.ts";
import { selectCalibration } from "../src/bayes/calibrationSelection.ts";

const cases = JSON.parse(readFileSync("docs/eval/replay-cases.json", "utf8")) as Array<{ id: string }>;
const annotationsPath = process.env.AMP_ANNOTATIONS_PATH ?? "docs/eval/annotations.json";
const annotations = importAnnotations(JSON.parse(readFileSync(annotationsPath, "utf8")));
const audit = auditLabels(
    cases.map((entry) => entry.id),
    annotations,
);

assert.equal(audit.coverage, 1);
assert.equal(audit.duplicates.length, 0);
assert.equal(audit.disagreements.length, 2);
assert.equal(audit.annotators.length, 2);
assert.equal(audit.pairwiseKappa.length, 1);
assert.ok(Math.abs(audit.pairwiseKappa[0].kappa - 0.571) < 0.01);
assert.equal(Object.values(audit.adjudicated).filter((label) => label === null).length, 2);

const replayPath = "docs/probes/eval-replay.json";
if (existsSync(replayPath)) {
    const replay = JSON.parse(readFileSync(replayPath, "utf8")) as { cases: Array<{ id: string; predictedCorrectness: number }> };
    const predictions = new Map(replay.cases.map((entry) => [entry.id, entry.predictedCorrectness]));
    const points = Object.entries(audit.adjudicated)
        .filter((entry): entry is [string, string] => entry[1] !== null && predictions.has(entry[0]))
        .map(([caseId, label]) => ({ actual: label === "correct", predicted: predictions.get(caseId) as number }));
    if (points.length > 0) {
        const selection = selectCalibration(points);
        assert.equal(Number.isFinite(selection.ece), true);
        console.log(`calibration on adjudicated labels: n=${points.length} method=${selection.method} ece=${selection.ece.toFixed(3)}`);
    }
}

console.log(
    `cases=${audit.cases} covered=${audit.covered} annotations=${audit.annotations} coverage=${(audit.coverage * 100).toFixed(0)}% disagreements=${audit.disagreements.length} kappa=${audit.pairwiseKappa[0].kappa.toFixed(3)} unresolved=${Object.values(audit.adjudicated).filter((label) => label === null).length}`,
);
console.log("\x1b[32m✓\x1b[0m annotation import, coverage, duplicates, disagreement, kappa and adjudication");
console.log("\n1 passed, 0 failed");
