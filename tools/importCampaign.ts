#!/usr/bin/env node
/**
 * Merge two filled campaign CSVs into docs/eval/annotations.imported.json.
 * Usage: node tools/importCampaign.ts campaign-A.csv campaign-B.csv
 */
import { readFileSync, writeFileSync } from "node:fs";

import { importAnnotationsCsv } from "../src/evaluation/labels.ts";
import type { Annotation } from "../src/evaluation/labels.ts";

const Argv: string[] = process.argv.slice(2);
const LeftPath: string = Argv[0];
const RightPath: string = Argv[1];
if (LeftPath === (void 0) || RightPath === (void 0)) {
    console.error("usage: node tools/importCampaign.ts <annotator-A.csv> <annotator-B.csv>");
    process.exit(1);
}

type AnnotationReader = (path: string, fallback: string) => Annotation[];

const read: AnnotationReader = (path: string, fallback: string): Annotation[] =>
    importAnnotationsCsv(readFileSync(path, "utf8"))
        .filter((row) => row.label.trim().length > 0)
        .map((row) => ({ ...row, annotator: row.annotator.trim().length > 0 ? row.annotator : fallback }));

const Rows: Annotation[] = [...read(LeftPath, "A"), ...read(RightPath, "B")];
writeFileSync("docs/eval/annotations.imported.json", `${JSON.stringify(Rows, null, 2)}\n`, "utf8");
console.log(`imported ${Rows.length} annotations -> docs/eval/annotations.imported.json`);
