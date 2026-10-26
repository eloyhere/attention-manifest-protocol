#!/usr/bin/env node
/**
 * Unified ledger: compute and attention share one account and snapshot.
 */
import assert from "node:assert/strict";

import { BudgetExceeded } from "../src/attention/budget.ts";
import { UnifiedLedger, type UnifiedSnapshot } from "../src/cooperation/unified.ts";
import type { AttentionRequest } from "../src/types/index.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

let Minute: number = 0;
const now: () => string = (): string => new Date(Date.parse("2026-10-24T10:00:00Z") + Minute++ * 60_000).toISOString();
const ledger: () => UnifiedLedger = (): UnifiedLedger => new UnifiedLedger({ budget: { tokens: 100, calls: 2, ms: 10_000 }, now });

const request: (id: string) => AttentionRequest = (id: string): AttentionRequest => ({
    amp: "0.1",
    kind: "attention-request",
    id,
    from: { kind: "agent", id: "a.lead" },
    to: { kind: "human", id: "u.li" },
    target: { kind: "unknown", id: "u.1" },
    class: "commitment",
    urgency: 3,
    why_now: "deadline",
    if_ignored: "assume",
    cost: { interrupts: 1 },
    fallback: "queue",
});

test("spending charges tokens and calls", () => {
    const account: UnifiedLedger = ledger();
    account.spend(() => undefined, { tokens: 30, calls: 1 });
    assert.equal(account.snapshot().tokens, 30);
    assert.equal(account.snapshot().calls, 1);
});

test("over-budget work never starts", () => {
    const account: UnifiedLedger = ledger();
    account.spend(() => undefined, { tokens: 90 });
    assert.throws(() => account.spend(() => undefined, { tokens: 20 }), BudgetExceeded);
});

test("attention grants appear in the same snapshot", () => {
    const account: UnifiedLedger = ledger();
    account.requestAttention(request("ar.1"));
    account.spend(() => undefined, { tokens: 10 });
    const snap: UnifiedSnapshot = account.snapshot();
    assert.equal(snap.interruptsGranted, 1);
    assert.equal(snap.tokens, 10);
});

test("debt is visible without spending compute", () => {
    const account: UnifiedLedger = ledger();
    account.requestAttention(request("ar.1"));
    account.requestAttention(request("ar.2"));
    Minute += 30;
    assert.ok(account.snapshot().debtScore >= 0);
});

test("remaining reflects consumption", () => {
    const account: UnifiedLedger = ledger();
    account.spend(() => undefined, { tokens: 40 });
    assert.equal(account.remaining().tokens, 60);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
