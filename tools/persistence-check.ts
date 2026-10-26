#!/usr/bin/env node
/** Persistence checks: chain integrity, tamper/reorder/truncate, restore. */
import assert from "node:assert/strict";

import { exportLedger, restoreLedger, verifySnapshot } from "../src/ledger/persistence.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { AmpEvent } from "../src/receipt/receipt.ts";
import type { Frame } from "../src/frame/frame.ts";
import type { Claim, UnknownItem } from "../src/warrant/epistemic.ts";

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
}

function buildLedger() {
    const ledger = new Ledger();
    ledger.events.push({
        amp: "0.1",
        kind: "event",
        id: "ev.1",
        at: "2026-10-24T01:00:01Z",
        actor: { kind: "self", id: "a.test" },
        type: "test",
        refs: [],
        payload: { statement: "p" },
        digest: "sha256:event",
    } as AmpEvent);
    ledger.frames.push({
        amp: "0.1",
        kind: "frame",
        id: "fr.1",
        at: "2026-10-24T01:00:02Z",
        actor: { kind: "self", id: "a.test" },
        mode: "deliberate",
        question: "q",
        candidates: [],
        selected: { kind: "unknown", id: "u.1" },
        ignored: [],
        budget: { tokens: 2000 },
        cost: { tokens: 0, calls: 0 },
        impasse: "none",
        digest: "sha256:frame",
    } as unknown as Frame);
    ledger.unknowns.push({
        amp: "0.1",
        kind: "unknown",
        id: "u.1",
        question: "q",
        importance: 0.8,
        blocking: true,
        since: "2026-10-24T01:00:03Z",
        at: "2026-10-24T01:00:03Z",
    } as UnknownItem);
    ledger.claims.push({
        amp: "0.1",
        kind: "claim",
        id: "cl.1",
        at: "2026-10-24T01:00:04Z",
        statement: "p",
        tier: "T2",
        status: "active",
        confidence: 0.7,
        evidence: [],
        warrant: { inference: "deduction", auxiliary_assumptions: [] },
    } as unknown as Claim);
    return ledger;
}

const ledger = buildLedger();
const snapshot = exportLedger(ledger, "a.test");

await test("export verifies and preserves counts", () => {
    const verdict = verifySnapshot(snapshot);
    assert.equal(verdict.ok, true, verdict.reasons.join("; "));
    assert.equal(snapshot.count, snapshot.entries.length);
    assert.equal(snapshot.count, snapshot.entries.length);
});

await test("empty ledger still has a valid chain", () => {
    const empty = new Ledger();
    const snap = exportLedger(empty, "a.empty");
    assert.equal(snap.count, 0);
    assert.equal(verifySnapshot(snap).ok, true);
});

await test("tampering with a payload breaks its hash", () => {
    const broken = structuredClone(snapshot);
    broken.entries[1].payload = { ...(broken.entries[1].payload as Record<string, unknown>), statement: "forged" };
    const verdict = verifySnapshot(broken);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.includes("hash")));
});

await test("reordering entries breaks the chain", () => {
    const broken = structuredClone(snapshot);
    const [a, b] = [broken.entries[0], broken.entries[1]];
    broken.entries[0] = b;
    broken.entries[1] = a;
    const verdict = verifySnapshot(broken);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.includes("seq") || r.includes("prev")));
});

await test("truncation is detected by count and tip", () => {
    const broken = structuredClone(snapshot);
    broken.entries = broken.entries.slice(0, -1);
    const verdict = verifySnapshot(broken);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((r) => r.includes("count") || r.includes("tip")));
});

await test("restore preserves frames and claims", () => {
    const restored = restoreLedger(snapshot);
    assert.equal(restored.frames.length, ledger.frames.length);
    assert.equal(restored.claims.length, ledger.claims.length);
    assert.equal((restored.frames[0] as { id: string }).id, ledger.frames[0].id);
});

await test("restore refuses a broken snapshot", () => {
    const broken = structuredClone(snapshot);
    broken.entries[0].payload = { forged: true };
    assert.throws(() => restoreLedger(broken), /refusing to restore/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
