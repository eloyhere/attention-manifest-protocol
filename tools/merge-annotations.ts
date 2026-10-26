#!/usr/bin/env node
/**
 * Merge annotation-server JSONL files into docs/eval/annotations.imported.json.
 * Usage: node tools/merge-annotations.ts docs/eval/annotations-A.jsonl docs/eval/annotations-B.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { Annotation } from "../src/evaluation/labels.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    console.error("usage: node tools/merge-annotations.ts <A.jsonl> <B.jsonl> ...");
    process.exit(1);
}
const rows: Annotation[] = [];
for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        const row = JSON.parse(line) as Partial<Annotation>;
        if (typeof(row.caseId) !== "string" || typeof(row.annotator) !== "string" || typeof(row.label) !== "string") {
            throw new Error(`${path}: annotation requires caseId/annotator/label`);
        }
        rows.push({ caseId: row.caseId, annotator: row.annotator, label: row.label, ...(typeof(row.note) === "string" ? { note: row.note } : {}) });
    }
}
writeFileSync("docs/eval/annotations.imported.json", `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`merged ${rows.length} annotations -> docs/eval/annotations.imported.json`);
