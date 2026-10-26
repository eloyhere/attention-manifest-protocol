#!/usr/bin/env node
/** CSV import, active-learning candidate selection and tie adjudication. */
import assert from "node:assert/strict";

import { auditLabels, importAnnotationsCsv, requireLabelCoverage, resolveUnresolved, selectLabelCandidates } from "../src/evaluation/labels.ts";

const csv = `caseId,annotator,label,note
a,A,correct,"grounded, concise"
a,B,incorrect,wrong constraint
b,A,correct,
b,B,correct,`;
const annotations = importAnnotationsCsv(csv);
assert.equal(annotations.length, 4);
assert.equal(annotations[0].note, "grounded, concise");
assert.equal(annotations[1].label, "incorrect");

const audit = auditLabels(["a", "b", "c"], annotations);
assert.equal(audit.coverage, 2 / 3);
assert.deepEqual(audit.missing, ["c"]);
assert.equal(audit.disagreements.length, 1);
assert.equal(audit.adjudicated.a, null);
assert.equal(audit.adjudicated.b, "correct");

const resolved = resolveUnresolved(audit, { a: "incorrect", b: "incorrect" });
assert.equal(resolved.a, "incorrect");
assert.equal(resolved.b, "correct");
assert.equal(resolved.c, null);

const candidates = selectLabelCandidates(
    [
        { caseId: "easy", predicted: 0.99, uncertainty: 0.1 },
        { caseId: "hard", predicted: 0.52, uncertainty: 0.9 },
        { caseId: "medium", predicted: 0.7, uncertainty: 0.5 },
    ],
    2,
);
assert.deepEqual(
    candidates.map((entry) => entry.caseId),
    ["hard", "medium"],
);

assert.throws(() => requireLabelCoverage(audit, { minCoverage: 1 }), /coverage/);
requireLabelCoverage(audit, { minCoverage: 0.6 });

console.log("\x1b[32m✓\x1b[0m CSV import, active-learning selection and third-adjudicator resolution");
console.log("\n1 passed, 0 failed");
