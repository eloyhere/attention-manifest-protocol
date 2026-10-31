#!/usr/bin/env node
/**
 * Annotation server: serve cases, accept a label, persist JSONL.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startAnnotationServer } from "./annotationServer.ts";

const dir = mkdtempSync(join(tmpdir(), "amp-annotation-"));
const outputPath = join(dir, "annotations-A.jsonl");
const running = await startAnnotationServer({ annotator: "A", port: 0, outputPath });
try {
    const page = await fetch(running.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AMP 盲标/);

    const cases = (await (await fetch(new URL("/api/cases", running.url))).json()) as Array<{ caseId: string }>;
    assert.equal(cases.length, 52);

    const response = await fetch(new URL("/api/labels", running.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId: cases[0].caseId, label: "correct", note: "server test" }),
    });
    assert.equal(response.status, 200);
    const rows = readFileSync(outputPath, "utf8").trim().split("\n");
    assert.equal(rows.length, 1);
    const saved = JSON.parse(rows[0]) as { caseId: string; annotator: string; label: string; note: string };
    assert.equal(saved.caseId, cases[0].caseId);
    assert.equal(saved.annotator, "A");
    assert.equal(saved.label, "correct");
    assert.equal(saved.note, "server test");

    const bad = await fetch(new URL("/api/labels", running.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId: cases[0].caseId, label: "maybe" }),
    });
    assert.equal(bad.status, 400);
} finally {
    await running.close();
}

console.log("\x1b[32m✓\x1b[0m annotation server serves 52 cases and persists validated labels");
console.log("\n1 passed, 0 failed");
