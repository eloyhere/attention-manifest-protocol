#!/usr/bin/env node
/**
 * Calibrate from imported annotations.
 *
 * Gate order: campaign coverage -> unresolved/unsure -> calibration registry.
 * A fixture-only or partial batch can only produce `refused`, never activation.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { CalibrationRegistry } from "../src/bayes/calibrationRegistry.ts";
import { auditLabels, importAnnotations, importAnnotationsCsv } from "../src/evaluation/labels.ts";
import type { Annotation } from "../src/evaluation/labels.ts";

interface ReplayCase {
    id: string;
    predictedCorrectness: number;
}

interface RecordedCase {
    suite: string;
    condition: string;
    task: string;
    textCorrectness: number;
}

const campaign = importAnnotationsCsv(readFileSync("docs/annotation-campaign.csv", "utf8"));
const campaignIds = campaign.map((row) => row.caseId);
const campaignSet = new Set(campaignIds);
const annotationsPath =
    process.env.AMP_ANNOTATIONS_PATH ??
    (existsSync("docs/eval/annotations.imported.json") ? "docs/eval/annotations.imported.json" : "docs/eval/annotations.json");
const raw = importAnnotations(JSON.parse(readFileSync(annotationsPath, "utf8")) as unknown);
const normalized: Annotation[] = raw.map((annotation) => ({
    ...annotation,
    caseId: campaignSet.has(annotation.caseId)
        ? annotation.caseId
        : campaignSet.has(`replay:${annotation.caseId}`)
          ? `replay:${annotation.caseId}`
          : annotation.caseId,
}));

const replay = JSON.parse(readFileSync("docs/probes/eval-replay.json", "utf8")) as { cases: ReplayCase[] };
const recorded = JSON.parse(readFileSync("docs/probes/eval-recorded-replay.json", "utf8")) as { cases: RecordedCase[] };
const replayById = new Map(replay.cases.map((entry) => [entry.id, entry]));
const audit = auditLabels(campaignIds, normalized);
const unresolved = Object.entries(audit.adjudicated).filter(([, label]) => label === null || label === "unsure");

const points: Array<{ predicted: number; actual: boolean; caseId: string }> = [];
for (const [caseId, label] of Object.entries(audit.adjudicated)) {
    if (label === null || label === "unsure") {
        continue;
    }
    if (caseId.startsWith("replay:")) {
        const entry = replayById.get(caseId.slice("replay:".length));
        if (entry !== (void 0)) {
            points.push({ predicted: entry.predictedCorrectness, actual: label === "correct", caseId });
        }
        continue;
    }
    if (caseId.startsWith("recorded:")) {
        const parts = caseId.split(":");
        const index = Number(parts[parts.length - 1]) - 1;
        const entry = recorded.cases[index];
        if (entry !== (void 0)) {
            points.push({ predicted: entry.textCorrectness, actual: label === "correct", caseId });
        }
    }
}

const registry = new CalibrationRegistry();
let status: "refused" | "raw" | "activated" = "refused";
let reason = "";
let selection = null;
if (audit.coverage < 0.9) {
    reason = `coverage ${audit.coverage.toFixed(3)} < 0.9`;
} else if (audit.duplicates.length > 0) {
    reason = `duplicates ${audit.duplicates.length}`;
} else if (unresolved.length > 0) {
    reason = `unresolved ${unresolved.length}`;
} else if (points.length < 30) {
    reason = `usable points ${points.length} < 30`;
} else {
    const registered = registry.register("imported", points);
    selection = registered.selection;
    status = registered.status;
    reason = registered.status === "activated" ? "CV improvement passed" : "raw remained better";
}

const report = {
    generatedAt: new Date().toISOString(),
    annotationsPath,
    audit,
    coverageGate: "0.9",
    points: points.length,
    status,
    reason,
    selection,
    activation: registry.model("imported") ?? null,
};
writeFileSync("docs/probes/calibration-imported.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
assert.equal(["refused", "raw", "activated"].includes(status), true);

console.log(`annotations=${annotationsPath} coverage=${(audit.coverage * 100).toFixed(0)}% points=${points.length} status=${status} reason=${reason}`);
if (selection !== null) {
    console.log(`rawECE=${selection.rawEce.toFixed(3)} cvECE=${selection.ece.toFixed(3)} method=${selection.method}`);
}
console.log("wrote docs/probes/calibration-imported.json");
