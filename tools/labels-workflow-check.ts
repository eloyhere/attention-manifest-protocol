#!/usr/bin/env node
/**
 * CSV import, active-learning candidate selection and tie adjudication.
 */
import assert from "node:assert/strict";

import { auditLabels, importAnnotationsCsv, requireLabelCoverage, resolveUnresolved, selectLabelCandidates } from "../src/evaluation/labels.ts";
import type { Annotation, LabelAudit, LabelCandidate } from "../src/evaluation/labels.ts";

const Csv: string = `\uFEFFcaseId,annotator,label,note
a,A,correct,"grounded, concise"
a,B,incorrect,wrong constraint
b,A,correct,
b,B,correct,`;
const Annotations: Annotation[] = importAnnotationsCsv(Csv);
assert.equal(Annotations.length, 4);
assert.equal(Annotations[0].note, "grounded, concise");
assert.equal(Annotations[1].label, "incorrect");

const Audit: LabelAudit = auditLabels(["a", "b", "c"], Annotations);
assert.equal(Audit.coverage, 2 / 3);
assert.deepEqual(Audit.missing, ["c"]);
assert.equal(Audit.disagreements.length, 1);
assert.equal(Audit.adjudicated.a, null);
assert.equal(Audit.adjudicated.b, "correct");

const Resolved: Record<string, string | null> = resolveUnresolved(Audit, { a: "incorrect", b: "incorrect" });
assert.equal(Resolved.a, "incorrect");
assert.equal(Resolved.b, "correct");
assert.equal(Resolved.c, null);

const Candidates: LabelCandidate[] = selectLabelCandidates(
    [
        { caseId: "easy", predicted: 0.99, uncertainty: 0.1 },
        { caseId: "hard", predicted: 0.52, uncertainty: 0.9 },
        { caseId: "medium", predicted: 0.7, uncertainty: 0.5 },
    ],
    2,
);
assert.deepEqual(
    Candidates.map((entry) => entry.caseId),
    ["hard", "medium"],
);

assert.throws(() => requireLabelCoverage(Audit, { minCoverage: 1 }), /coverage/);
requireLabelCoverage(Audit, { minCoverage: 0.6 });

console.log("\x1b[32m✓\x1b[0m CSV import, active-learning selection and third-adjudicator resolution");
console.log("\n1 passed, 0 failed");
