#!/usr/bin/env node
/** Shared-ledger granularity: full / summary / reference. */
import assert from "node:assert/strict";

import { shareLedger } from "../src/ledger/share.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { Claim, UnknownItem } from "../src/warrant/epistemic.ts";

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
}

const ledger = new Ledger();
ledger.unknowns.push({
    amp: "0.1",
    kind: "unknown",
    id: "u.1",
    question: "q",
    importance: 0.8,
    blocking: true,
    since: "2026-10-24T01:00:01Z",
    at: "2026-10-24T01:00:01Z",
} as UnknownItem);
ledger.claims.push({
    amp: "0.1",
    kind: "claim",
    id: "cl.1",
    at: "2026-10-24T01:00:02Z",
    statement: "p",
    tier: "T2",
    status: "active",
    confidence: 0.7,
    evidence: [],
    warrant: { inference: "deduction", auxiliary_assumptions: [] },
} as unknown as Claim);

test("full view carries entries", () => {
    const view = shareLedger(ledger, "a.gamma", "full");
    assert.equal(view.entries?.length, view.count);
});

test("summary view has counts and claim ids but no payloads", () => {
    const view = shareLedger(ledger, "a.gamma", "summary");
    assert.equal(view.entries, undefined);
    assert.equal(view.summary?.byKind.claim, 1);
    assert.equal(view.summary?.claims.length, 1);
});

test("reference view is pointer-only", () => {
    const view = shareLedger(ledger, "a.gamma", "reference");
    assert.equal(view.entries, undefined);
    assert.equal(view.summary, undefined);
    assert.match(view.tip, /^sha256:[a-f0-9]{64}$/);
});

test("views shrink with granularity", () => {
    const full = JSON.stringify(shareLedger(ledger, "a.gamma", "full")).length;
    const summary = JSON.stringify(shareLedger(ledger, "a.gamma", "summary")).length;
    const reference = JSON.stringify(shareLedger(ledger, "a.gamma", "reference")).length;
    assert.ok(full > summary && summary > reference, `${full} > ${summary} > ${reference}`);
});

test("each view has its own integrity digest", () => {
    const full = shareLedger(ledger, "a.gamma", "full");
    const summary = shareLedger(ledger, "a.gamma", "summary");
    const reference = shareLedger(ledger, "a.gamma", "reference");
    assert.notEqual(full.digest, summary.digest);
    assert.notEqual(summary.digest, reference.digest);
    assert.equal(full.tip, reference.tip);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
