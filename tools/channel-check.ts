#!/usr/bin/env node
/**
 * Channel checks: delegation crosses a seam and fails closed on rejection.
 */
import assert from "node:assert/strict";

import type { DelegationDoc } from "../src/cooperation/collaboration.ts";
import type { Delegation } from "../src/delegate/team.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import { delegateOver, LoopbackChannel } from "../src/protocol/channel.ts";
import type { Budget } from "../src/types/common.ts";

let Passed: number = 0;
let Failed: number = 0;

/**
 * One asynchronous check: the name printed in the report and the body to run.
 */
type Test = (name: string, fn: () => Promise<void>) => Promise<void>;

const test: Test = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed += 1;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Goal: string = `sha256:${"a".repeat(64)}`;

/**
 * Builds the delegation under test, with the budget as the only variable.
 */
type DelegationFactory = (budget?: Budget) => Delegation;

const delegation: DelegationFactory = (budget: Budget = { tokens: 100 }): Delegation =>
    new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" }).createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: ["tool.logs.query"],
        budget,
        deadline: "2026-10-24T12:00:00Z",
        mayRedelegate: false,
        depth: 0,
    });

await test("accepted delegation crosses the channel with wire fields", async () => {
    const channel: LoopbackChannel = new LoopbackChannel();
    const doc: DelegationDoc = await delegateOver(channel, delegation());
    assert.equal(channel.sent.length, 1);
    assert.equal(doc.goal_digest, Goal);
    assert.equal(doc.kind, "delegation");
});

await test("peer rejection fails closed with a reason", async () => {
    const channel: LoopbackChannel = new LoopbackChannel(() => ({ accepted: false, reason: "budget too wide" }));
    await assert.rejects(() => delegateOver(channel, delegation()), /budget too wide/);
});

await test("peer can enforce its own ceiling on the wire document", async () => {
    const channel: LoopbackChannel = new LoopbackChannel((doc) =>
        (doc.budget.tokens ?? 0) > 50 ? { accepted: false, reason: "over peer ceiling" } : { accepted: true },
    );
    await assert.rejects(() => delegateOver(channel, delegation({ tokens: 100 })), /over peer ceiling/);
    assert.ok(await delegateOver(channel, delegation({ tokens: 40 })));
});

await test("every attempt is recorded, including rejected ones", async () => {
    const accepting: LoopbackChannel = new LoopbackChannel(() => ({ accepted: true }));
    await delegateOver(accepting, delegation());
    assert.equal(accepting.sent.length, 1);
    assert.equal(accepting.sent[0].may_redelegate, false);

    const rejecting: LoopbackChannel = new LoopbackChannel(() => ({ accepted: false, reason: "nope" }));
    await assert.rejects(() => delegateOver(rejecting, delegation()), /nope/);
    assert.equal(rejecting.sent.length, 1);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
