#!/usr/bin/env node
/** Progress/validation for the two blind annotation packets. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { importAnnotationsCsv } from "../src/evaluation/labels.ts";

const allowed = new Set(["correct", "incorrect", "unsure"]);
const campaign = importAnnotationsCsv(readFileSync("docs/annotation-campaign.csv", "utf8"));
const expected = new Set(campaign.map((row) => row.caseId));

const inspect = (path: string): { filled: number; invalid: string[]; unknown: string[]; duplicate: string[] } => {
    const rows = importAnnotationsCsv(readFileSync(path, "utf8"));
    const seen = new Set<string>();
    const duplicate: string[] = [];
    for (const row of rows) {
        if (seen.has(row.caseId)) duplicate.push(row.caseId);
        seen.add(row.caseId);
    }
    return {
        filled: rows.filter((row) => row.label.trim().length > 0).length,
        invalid: rows.filter((row) => row.label.length > 0 && !allowed.has(row.label)).map((row) => `${row.caseId}:${row.label}`),
        unknown: rows.filter((row) => !expected.has(row.caseId)).map((row) => row.caseId),
        duplicate,
    };
};

const left = inspect("docs/annotation-campaign-A.csv");
const right = inspect("docs/annotation-campaign-B.csv");
for (const result of [left, right]) {
    assert.equal(result.unknown.length, 0);
    assert.equal(result.duplicate.length, 0);
    assert.equal(result.invalid.length, 0);
}

console.log(
    `A=${left.filled}/${campaign.length} B=${right.filled}/${campaign.length} invalid=${left.invalid.length + right.invalid.length} unknown=${left.unknown.length + right.unknown.length}`,
);
if (left.filled < campaign.length || right.filled < campaign.length) console.log("status=pending human labels");
else console.log("status=ready to import");
