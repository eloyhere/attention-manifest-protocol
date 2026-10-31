#!/usr/bin/env node
/**
 * Merge annotation-server JSONL files into docs/eval/annotations.imported.json.
 * Usage: node tools/merge-annotations.ts docs/eval/annotations-A.jsonl docs/eval/annotations-B.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { Annotation } from "../src/evaluation/labels.ts";

const Paths: string[] = process.argv.slice(2);
if (Paths.length === 0) {
    console.error("usage: node tools/merge-annotations.ts <A.jsonl> <B.jsonl> ...");
    process.exit(1);
}
const Rows: Annotation[] = [];
for (let i: number = 0; i < Paths.length; i += 1) {
    const path: string = Paths[i];
    const lines: string[] = readFileSync(path, "utf8").split(/\r?\n/);
    for (let j: number = 0; j < lines.length; j += 1) {
        const line: string = lines[j];
        if (line.trim().length === 0) {
            continue;
        }
        const row: Partial<Annotation> = JSON.parse(line) as Partial<Annotation>;
        if (typeof(row.caseId) !== "string" || typeof(row.annotator) !== "string" || typeof(row.label) !== "string") {
            throw new Error(`${path}: annotation requires caseId/annotator/label`);
        }
        Rows.push({ caseId: row.caseId, annotator: row.annotator, label: row.label, ...(typeof(row.note) === "string" ? { note: row.note } : {}) });
    }
}
writeFileSync("docs/eval/annotations.imported.json", `${JSON.stringify(Rows, null, 2)}\n`, "utf8");
console.log(`merged ${Rows.length} annotations -> docs/eval/annotations.imported.json`);
