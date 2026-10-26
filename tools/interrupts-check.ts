#!/usr/bin/env node
/**
 * Attention-ledger interrupt checks (A-3/A-4 and §3.2).
 */
import assert from "node:assert/strict";

import { AttentionLedger, admitExternal, MaxExternalShare } from "../src/attention/interrupts.ts";
import type { InterruptRecord } from "../src/attention/interrupts.ts";
import type { AttentionRequest } from "../src/attention/socialTypes.ts";
import type { Receipt } from "../src/receipt/receipt.ts";

type SubmitResult = ReturnType<AttentionLedger["submit"]>;

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void | Promise<void>) => void = (name: string, fn: () => void | Promise<void>): void => {
    try {
        const result: void | Promise<void> = fn();
        if (result instanceof Promise) {
            result.then(
                () => {
                    Passed++;
                    console.log(`\x1b[32m✓\x1b[0m ${name}`);
                },
                (error: unknown) => {
                    Failed++;
                    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${messageOf(error)}`);
                },
            );
            return;
        }
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${messageOf(error)}`);
    }
};

const messageOf: (error: unknown) => string = (error: unknown): string => {
    return error instanceof Error ? error.message : `${error}`;
};

const NOW: string = "2026-10-24T10:00:00Z";

const request: (over?: Partial<AttentionRequest>) => AttentionRequest = (over: Partial<AttentionRequest> = {}): AttentionRequest => ({
    amp: "0.1",
    kind: "attention-request",
    id: "ar.1",
    from: { kind: "agent", id: "a.lead" },
    to: { kind: "human", id: "u.li" },
    target: { kind: "unknown", id: "u.17" },
    class: "commitment",
    urgency: 3,
    why_now: "the commitment is due in ten minutes",
    if_ignored: "the deadline will be missed",
    cost: { interrupts: 1, ms: 30_000 },
    expected_value: 0.8,
    fallback: "queue",
    ...over,
});

const ledger: (receipts?: Receipt[]) => AttentionLedger = (receipts?: Receipt[]): AttentionLedger =>
    new AttentionLedger({
        now: () => NOW,
        policy: { quietHours: undefined, cooldownMinutes: 0, budgets: { safety: 1, commitment: 3, opportunity: 2, curiosity: 1 } },
        defaultExpiryMs: 60_000,
        onReceipt: receipts ? (receipt) => receipts.push(receipt) : undefined,
    });

test("a safety interrupt bypasses the budget and produces a receipt", () => {
    const receipts: Receipt[] = [];
    const attention: AttentionLedger = ledger(receipts);
    const result: SubmitResult = attention.submit(request({ class: "safety", urgency: 5 }));
    assert.equal(result.decision.decision, "grant");
    assert.equal(result.interrupt.status, "granted");
    assert.equal(result.interrupt.granted, true);
    assert.equal(result.interrupt.cost.interrupts, 1);
    assert.equal(result.receipt.outcome, "success");
    assert.equal(result.receipt.usage.interrupts, 1);
    assert.equal(receipts.length, 1);
    assert.equal(attention.grantedCount(), 1);
});

test("budget exhaustion with fallback=queue produces a deferred interrupt with expiry", () => {
    const attention: AttentionLedger = new AttentionLedger({
        now: () => NOW,
        policy: { quietHours: undefined, cooldownMinutes: 0, budgets: { safety: 1, commitment: 0, opportunity: 0, curiosity: 0 } },
        defaultExpiryMs: 60_000,
    });
    const result: SubmitResult = attention.submit(request());
    assert.equal(result.decision.decision, "defer");
    assert.equal(result.interrupt.status, "deferred");
    assert.equal(result.interrupt.granted, false);
    assert.equal(result.interrupt.expires, "2026-10-24T10:01:00.000Z");
    assert.equal(result.receipt.outcome, "partial");
    assert.equal(attention.open().length, 1);
});

test("a denied request is recorded and blocked, with no debt", () => {
    const attention: AttentionLedger = ledger();
    const result: SubmitResult = attention.submit(request({ class: "curiosity", expected_value: 0.1 }));
    assert.equal(result.decision.decision, "deny");
    assert.equal(result.interrupt.status, "denied");
    assert.equal(result.receipt.outcome, "blocked");
    assert.equal(attention.open().length, 0);
});

test("deferred requests expire idempotently after their response window", () => {
    const attention: AttentionLedger = new AttentionLedger({
        now: () => NOW,
        policy: { quietHours: undefined, cooldownMinutes: 0, budgets: { safety: 1, commitment: 0, opportunity: 0, curiosity: 0 } },
        defaultExpiryMs: 60_000,
    });
    const first: SubmitResult = attention.submit(request());
    assert.equal(first.interrupt.status, "deferred");

    assert.deepEqual(attention.sweep("2026-10-24T10:00:59.999Z"), []);
    const expired: InterruptRecord[] = attention.sweep("2026-10-24T10:01:00.000Z");
    assert.equal(expired.length, 1);
    assert.equal(attention.get("ar.1")?.status, "expired");
    assert.equal(attention.open().length, 0);
    assert.deepEqual(attention.sweep("2026-10-24T10:02:00Z"), []);
});

test("a deferred request can be resolved as answered or withdrawn", () => {
    const attention: AttentionLedger = new AttentionLedger({
        now: () => NOW,
        policy: { quietHours: undefined, cooldownMinutes: 0, budgets: { safety: 1, commitment: 0, opportunity: 0, curiosity: 0 } },
    });
    attention.submit(request());
    const answered: InterruptRecord | undefined = attention.resolve("ar.1", "answered");
    assert.equal(answered?.status, "answered");
    assert.equal(attention.resolve("ar.1", "answered"), undefined);

    attention.submit(request({ id: "ar.2" }));
    assert.equal(attention.resolve("ar.2", "withdrawn")?.status, "withdrawn");
});

test("debt is aged until resolution", () => {
    const attention: AttentionLedger = new AttentionLedger({
        now: () => NOW,
        policy: { quietHours: undefined, cooldownMinutes: 0, budgets: { safety: 1, commitment: 0, opportunity: 0, curiosity: 0 } },
    });
    attention.submit(request({ urgency: 4 }));
    const at: string = "2026-10-24T10:10:00Z";
    assert.equal(attention.debtScore(at), 40);
    attention.resolve("ar.1", "answered");
    assert.equal(attention.debtScore(at), 0);
});

test("duplicate request ids fail closed", () => {
    const attention: AttentionLedger = ledger();
    attention.submit(request());
    assert.throws(() => attention.submit(request()), /duplicate interrupt request/);
});

test("external content cannot take the goal slot or exceed the default share", () => {
    assert.equal(MaxExternalShare, 0.15);
    assert.equal(admitExternal({ role: "tool", share: 0.1 }).ok, true);
    assert.equal(admitExternal({ role: "tool", share: 0.2 }).ok, false);
    assert.equal(admitExternal({ role: "tool", share: 0.1, goalSlot: true }).ok, false);
    assert.equal(admitExternal({ role: "tool", share: -0.1 }).ok, false);
    assert.equal(admitExternal({ role: "tool", share: Number.NaN }).ok, false);
    assert.equal(admitExternal({ role: "tool", share: 0.3, maxShare: 0.5 }).ok, true);
    assert.throws(() => admitExternal({ role: "tool", share: 0.1, maxShare: 2 }), RangeError);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
