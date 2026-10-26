#!/usr/bin/env node
/**
 * Merge two filled campaign CSVs into docs/eval/annotations.imported.json.
 * Usage: node tools/import-campaign.ts campaign-A.csv campaign-B.csv
 */
import { readFileSync, writeFileSync } from "node:fs";

import { importAnnotationsCsv } from "../src/evaluation/labels.ts";
import type { Annotation } from "../src/evaluation/labels.ts";

const [leftPath, rightPath] = process.argv.slice(2);
if (leftPath === undefined || rightPath === undefined) {
    console.error("usage: node tools/import-campaign.ts <annotator-A.csv> <annotator-B.csv>");
    process.exit(1);
}

const read = (path: string, fallback: string): Annotation[] =>
    importAnnotationsCsv(readFileSync(path, "utf8"))
        .filter((row) => row.label.trim().length > 0)
        .map((row) => ({ ...row, annotator: row.annotator.trim().length > 0 ? row.annotator : fallback }));

const rows = [...read(leftPath, "A"), ...read(rightPath, "B")];
writeFileSync("docs/eval/annotations.imported.json", `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`imported ${rows.length} annotations -> docs/eval/annotations.imported.json`);
