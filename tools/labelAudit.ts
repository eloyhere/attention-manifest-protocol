#!/usr/bin/env node
/**
 * Annotation import + coverage/duplicate/disagreement/kappa audit.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { importAnnotations, auditLabels } from "../src/evaluation/labels.ts";
import type { Annotation, LabelAudit } from "../src/evaluation/labels.ts";
import { selectCalibration } from "../src/bayes/calibrationSelection.ts";
import type { CalibrationSelection } from "../src/bayes/calibrationSelection.ts";
import type { CalibrationPoint } from "../src/bayes/calibration.ts";

/**
 * Recorded replay case; only its id is read here.
 */
type CaseRecord = {
    id: string;
};

/**
 * Recorded replay case with the model's predicted correctness.
 */
type PredictedCase = {
    id: string;
    predictedCorrectness: number;
};

/**
 * Recorded replay output file.
 */
type ReplayDocument = {
    cases: PredictedCase[];
};

const Cases: CaseRecord[] = JSON.parse(readFileSync("docs/eval/replay-cases.json", "utf8")) as CaseRecord[];
const AnnotationsPath: string = process.env.AMP_ANNOTATIONS_PATH ?? "docs/eval/annotations.json";
const Annotations: Annotation[] = importAnnotations(JSON.parse(readFileSync(AnnotationsPath, "utf8")));
const Audit: LabelAudit = auditLabels(
    Cases.map((entry) => entry.id),
    Annotations,
);

assert.equal(Audit.coverage, 1);
assert.equal(Audit.duplicates.length, 0);
assert.equal(Audit.disagreements.length, 2);
assert.equal(Audit.annotators.length, 2);
assert.equal(Audit.pairwiseKappa.length, 1);
assert.ok(Math.abs(Audit.pairwiseKappa[0].kappa - 0.571) < 0.01);
assert.equal(Object.values(Audit.adjudicated).filter((label) => label === null).length, 2);

const ReplayPath: string = "docs/probes/eval-replay.json";
if (existsSync(ReplayPath)) {
    const replay: ReplayDocument = JSON.parse(readFileSync(ReplayPath, "utf8")) as ReplayDocument;
    const predictions: Map<string, number> = new Map(replay.cases.map((entry) => [entry.id, entry.predictedCorrectness]));
    const points: CalibrationPoint[] = Object.entries(Audit.adjudicated)
        .filter((entry): entry is [string, string] => entry[1] !== null && predictions.has(entry[0]))
        .map(([caseId, label]) => ({ actual: label === "correct", predicted: predictions.get(caseId) as number }));
    if (points.length > 0) {
        const selection: CalibrationSelection = selectCalibration(points);
        assert.equal(Number.isFinite(selection.ece), true);
        console.log(`calibration on adjudicated labels: n=${points.length} method=${selection.method} ece=${selection.ece.toFixed(3)}`);
    }
}

console.log(
    `cases=${Audit.cases} covered=${Audit.covered} annotations=${Audit.annotations} coverage=${(Audit.coverage * 100).toFixed(0)}% disagreements=${Audit.disagreements.length} kappa=${Audit.pairwiseKappa[0].kappa.toFixed(3)} unresolved=${Object.values(Audit.adjudicated).filter((label) => label === null).length}`,
);
console.log("\x1b[32m✓\x1b[0m annotation import, coverage, duplicates, disagreement, kappa and adjudication");
console.log("\n1 passed, 0 failed");
