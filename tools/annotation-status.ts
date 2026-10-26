#!/usr/bin/env node
/**
 * Progress/validation for the two blind annotation packets.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import type { Annotation } from "../src/evaluation/labels.ts";
import { importAnnotationsCsv } from "../src/evaluation/labels.ts";

type InspectResult = {
    filled: number;
    invalid: string[];
    unknown: string[];
    duplicate: string[];
};

const Allowed: Set<string> = new Set(["correct", "incorrect", "unsure"]);
const Campaign: Annotation[] = importAnnotationsCsv(readFileSync("docs/annotation-campaign.csv", "utf8"));
const Expected: Set<string> = new Set(Campaign.map((row) => row.caseId));

const inspect: (path: string) => InspectResult = (path: string): InspectResult => {
    const rows: Annotation[] = importAnnotationsCsv(readFileSync(path, "utf8"));
    const seen: Set<string> = new Set<string>();
    const duplicate: string[] = [];
    for (let index: number = 0; index < rows.length; index += 1) {
        const row: Annotation = rows[index];
        if (seen.has(row.caseId)) {
            duplicate.push(row.caseId);
        }
        seen.add(row.caseId);
    }
    return {
        filled: rows.filter((row) => row.label.trim().length > 0).length,
        invalid: rows.filter((row) => row.label.length > 0 && !Allowed.has(row.label)).map((row) => `${row.caseId}:${row.label}`),
        unknown: rows.filter((row) => !Expected.has(row.caseId)).map((row) => row.caseId),
        duplicate,
    };
};

const Left: InspectResult = inspect("docs/annotation-campaign-A.csv");
const Right: InspectResult = inspect("docs/annotation-campaign-B.csv");
const Results: InspectResult[] = [Left, Right];
for (let index: number = 0; index < Results.length; index += 1) {
    const result: InspectResult = Results[index];
    assert.equal(result.unknown.length, 0);
    assert.equal(result.duplicate.length, 0);
    assert.equal(result.invalid.length, 0);
}

console.log(
    `A=${Left.filled}/${Campaign.length} B=${Right.filled}/${Campaign.length} invalid=${Left.invalid.length + Right.invalid.length} unknown=${Left.unknown.length + Right.unknown.length}`,
);
const jsonl: (path: string) => number = (path: string): number =>
    existsSync(path)
        ? readFileSync(path, "utf8")
              .split(/\r?\n/)
              .filter((line) => line.trim().length > 0).length
        : 0;
console.log(`UI A=${jsonl("docs/eval/annotations-A.jsonl")}/${Campaign.length} UI B=${jsonl("docs/eval/annotations-B.jsonl")}/${Campaign.length}`);
if (Left.filled < Campaign.length || Right.filled < Campaign.length) {
    console.log("status=pending human labels");
} else {
    console.log("status=ready to import");
}
