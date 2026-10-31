#!/usr/bin/env node
/**
 * Wire round-trip checks for delegation and lease documents.
 */
import assert from "node:assert/strict";

import { fromDelegationDoc, toDelegationDoc, toLeaseDoc } from "../src/protocol/wire.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation, Lease } from "../src/delegate/team.ts";
import type { DelegationDoc, LeaseDoc } from "../src/cooperation/collaboration.ts";

let Passed: number = 0;
let Failed: number = 0;

type TestCase = () => void;

const test: (name: string, fn: TestCase) => void = (name: string, fn: TestCase): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Goal: string = `sha256:${"a".repeat(64)}`;
const runtime: () => TeamRuntime = (): TeamRuntime => new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" });

const delegation: () => Delegation = (): Delegation => {
    const team: TeamRuntime = runtime();
    return team.createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: ["tool.logs.query"],
        budget: { tokens: 4000, calls: 8 },
        deadline: "2026-10-24T12:00:00Z",
        mayRedelegate: false,
        depth: 0,
    });
};

test("delegation serialises to the wire shape", () => {
    const doc: DelegationDoc = toDelegationDoc(delegation());
    assert.equal(doc.amp, "0.1");
    assert.equal(doc.kind, "delegation");
    assert.equal(doc.goal_digest, Goal);
    assert.equal(doc.may_redelegate, false);
    assert.equal(Object.hasOwn(doc, "mayRedelegate"), false);
});

test("delegation round-trips without loss", () => {
    const original: Delegation = delegation();
    const restored: Delegation = fromDelegationDoc(toDelegationDoc(original));
    assert.deepEqual(restored, original);
});

test("lease serialises with fence and status", () => {
    const team: TeamRuntime = runtime();
    const d: Delegation = team.createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: [],
        budget: { tokens: 100 },
        deadline: "2026-10-24T12:00:00Z",
        mayRedelegate: false,
        depth: 0,
    });
    const lease: Lease = team.issueLease(d.id, {
        taskId: "t1",
        holder: "a.worker",
        goalDigest: Goal,
        budget: { tokens: 50 },
        deadline: "2026-10-24T11:00:00Z",
    });
    const doc: LeaseDoc = toLeaseDoc(lease);
    assert.equal(doc.task_id, "t1");
    assert.equal(doc.fence, 1);
    assert.equal(doc.status, "active");
});

test("wire document carries no runtime-only fields", () => {
    const doc: DelegationDoc = toDelegationDoc(delegation());
    assert.equal(Object.hasOwn(doc, "parent"), false);
    assert.deepEqual(
        Object.keys(doc).sort(),
        ["amp", "budget", "deadline", "delegatee", "depth", "goal_digest", "granter", "id", "kind", "may_redelegate", "scope"].sort(),
    );
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
