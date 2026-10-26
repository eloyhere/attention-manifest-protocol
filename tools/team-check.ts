#!/usr/bin/env node
/**
 * Team collaboration checks: attenuation, dedup, fencing, reservation, cancel.
 */
import assert from "node:assert/strict";

import { AttenuationError, BudgetError, DuplicateTask, FencingError, TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation, Lease } from "../src/delegate/team.ts";

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

let Tick: number = 0;
const now: () => string = (): string => new Date(Date.parse("2026-10-24T10:00:00Z") + Tick++ * 1000).toISOString();
const Deadline: string = "2026-10-24T12:00:00Z";
const Goal: string = `sha256:${"a".repeat(64)}`;

const root: (team: TeamRuntime) => Delegation = (team: TeamRuntime): Delegation => {
    return team.createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: ["tool.logs.query"],
        budget: { tokens: 4000, calls: 8 },
        deadline: Deadline,
        mayRedelegate: true,
        depth: 0,
    });
};

test("child budget must attenuate", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const parent: Delegation = root(team);
    assert.throws(
        () =>
            team.createDelegation({
                parent: parent.id,
                granter: "a.worker",
                delegatee: "a.child",
                goalDigest: `sha256:${"b".repeat(64)}`,
                scope: ["tool.logs.query"],
                budget: { tokens: 5000 },
                deadline: Deadline,
                mayRedelegate: false,
                depth: 1,
            }),
        AttenuationError,
    );
});

test("child deadline cannot exceed parent", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const parent: Delegation = root(team);
    assert.throws(
        () =>
            team.createDelegation({
                parent: parent.id,
                granter: "a.worker",
                delegatee: "a.child",
                goalDigest: `sha256:${"b".repeat(64)}`,
                scope: ["tool.logs.query"],
                budget: { tokens: 1000 },
                deadline: "2026-10-24T13:00:00Z",
                mayRedelegate: false,
                depth: 1,
            }),
        AttenuationError,
    );
});

test("depth is capped at 2", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    assert.throws(
        () =>
            team.createDelegation({ granter: "a", delegatee: "b", goalDigest: Goal, scope: [], budget: {}, deadline: Deadline, mayRedelegate: true, depth: 3 }),
        AttenuationError,
    );
});

test("re-delegation requires may_redelegate", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const parent: Delegation = team.createDelegation({
        granter: "a",
        delegatee: "b",
        goalDigest: Goal,
        scope: [],
        budget: { calls: 2 },
        deadline: Deadline,
        mayRedelegate: false,
        depth: 0,
    });
    assert.throws(
        () =>
            team.createDelegation({
                parent: parent.id,
                granter: "b",
                delegatee: "c",
                goalDigest: `sha256:${"c".repeat(64)}`,
                scope: [],
                budget: {},
                deadline: Deadline,
                mayRedelegate: false,
                depth: 1,
            }),
        AttenuationError,
    );
});

test("duplicate active goal is rejected, and freed on completion", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const delegation: Delegation = root(team);
    const lease: Lease = team.issueLease(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: Goal, budget: { tokens: 1000 }, deadline: Deadline });
    assert.throws(() => team.issueLease(delegation.id, { taskId: "t2", holder: "a.other", goalDigest: Goal, budget: {}, deadline: Deadline }), DuplicateTask);
    team.complete(lease.id);
    assert.ok(team.issueLease(delegation.id, { taskId: "t3", holder: "a.other", goalDigest: Goal, budget: {}, deadline: Deadline }));
});

test("reservation blocks overspend before dispatch", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const delegation: Delegation = root(team);
    const lease: Lease = team.issueLease(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: Goal, budget: { tokens: 100 }, deadline: Deadline });
    team.reserve(lease.id, { tokens: 80 });
    assert.throws(() => team.reserve(lease.id, { tokens: 30 }), BudgetError);
    team.reserve(lease.id, { tokens: 20 });
    team.settle(lease.id, { tokens: 95 });
    assert.equal(team.usage(lease.id).spent.tokens, 95);
});

test("fencing rejects stale writers", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const delegation: Delegation = root(team);
    const first: Lease = team.issueLease(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: Goal, budget: {}, deadline: Deadline });
    team.cancel(first.id);
    const second: Lease = team.issueLease(delegation.id, { taskId: "t1", holder: "a.other", goalDigest: Goal, budget: {}, deadline: Deadline });
    assert.ok(second.fence > first.fence);
    assert.throws(() => team.assertWriter(second.id, first.fence), FencingError);
    team.assertWriter(second.id, second.fence);
});

test("cancellation is sticky", () => {
    const team: TeamRuntime = new TeamRuntime({ now });
    const delegation: Delegation = root(team);
    const lease: Lease = team.issueLease(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: Goal, budget: {}, deadline: Deadline });
    team.cancel(lease.id);
    assert.throws(() => team.complete(lease.id), FencingError);
    assert.throws(() => team.reserve(lease.id, { tokens: 1 }), FencingError);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
