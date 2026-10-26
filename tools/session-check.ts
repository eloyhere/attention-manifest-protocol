#!/usr/bin/env node
/** End-to-end collaboration session: delegation → board → lease → spend → metrics. */
import assert from "node:assert/strict";

import { BudgetExceeded } from "../src/attention/budget.ts";
import { DuplicateGoal } from "../src/cooperation/board.ts";
import { TeamSession } from "../src/cooperation/session.ts";

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

let tick = 0;
const now = () => new Date(Date.parse("2026-10-24T10:00:00Z") + tick++ * 60_000).toISOString();
const goal = "sha256:" + "a".repeat(64);
const deadline = "2026-10-24T12:00:00Z";

function session(manifest) {
    const instance = new TeamSession({ budget: { tokens: 100, calls: 4, ms: 60_000 }, now, manifest });
    const delegation = instance.delegate({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: goal,
        scope: ["tool.logs.query"],
        budget: { tokens: 80, calls: 3 },
        deadline,
        mayRedelegate: false,
        depth: 0,
    });
    return { instance, delegation };
}

const manifest = {
    amp: "0.1",
    kind: "team-manifest",
    id: "team.a",
    version: 1,
    members: [
        { id: "a.lead", role: "coordinator", authority: ["tool.logs.query"] },
        { id: "a.worker", role: "investigator", authority: ["tool.logs.query"] },
    ],
    max_depth: 1,
    max_fanout: 2,
    budget: { tokens: 200, calls: 6 },
    termination: "verified",
    attested_at: "2026-10-24T10:00:00Z",
};

test("start registers the task once and binds the lease", () => {
    const { instance, delegation } = session(manifest);
    const { task, lease } = instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: goal, budget: { tokens: 50 }, deadline });
    assert.equal(task.state, "leased");
    assert.equal(task.lease, lease.id);
    assert.equal(instance.board.stats().open, 1);
});

test("a duplicate goal never consumes a lease", () => {
    const { instance, delegation } = session(manifest);
    instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: goal, budget: { tokens: 10 }, deadline });
    assert.throws(() => instance.start(delegation.id, { taskId: "t2", holder: "a.worker", goalDigest: goal, budget: { tokens: 10 }, deadline }), DuplicateGoal);
    assert.equal(instance.board.stats().open, 1);
});

test("spend reserves on the lease and charges the shared account", () => {
    const { instance, delegation } = session(manifest);
    const { lease } = instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: goal, budget: { tokens: 50 }, deadline });
    instance.spend(lease.id, { tokens: 30, calls: 1 }, () => "ok");
    assert.equal(instance.snapshot().tokens, 30);
    assert.equal(instance.team.usage(lease.id).spent.tokens, 30);
});

test("over-budget spend is rejected and does not run", () => {
    const { instance, delegation } = session(manifest);
    const { lease } = instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: goal, budget: { tokens: 20 }, deadline });
    assert.throws(() => instance.spend(lease.id, { tokens: 40 }, () => "never"), Error);
    assert.equal(instance.snapshot().tokens, 0);
});

test("finish closes both the lease and the board task", () => {
    const { instance, delegation } = session(manifest);
    const { lease } = instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: goal, budget: { tokens: 10 }, deadline });
    instance.spend(lease.id, { tokens: 10 }, () => undefined);
    const { task } = instance.finish(lease.id);
    assert.equal(task.state, "done");
    assert.equal(instance.board.stats().open, 0);
    assert.equal(instance.metrics().costPerSuccess, 10);
});

test("cancellation closes the board task and frees the goal", () => {
    const { instance, delegation } = session(manifest);
    const { lease } = instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: goal, budget: { tokens: 10 }, deadline });
    instance.cancel(lease.id);
    assert.throws(() => instance.spend(lease.id, { tokens: 1 }, () => undefined), Error);
    assert.equal(instance.board.stats().open, 0);
});

test("attention and compute appear in one snapshot", () => {
    const { instance } = session(manifest);
    instance.requestAttention({
        amp: "0.1",
        kind: "attention-request",
        id: "ar.1",
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
    const snap = instance.snapshot();
    assert.equal(snap.interruptsGranted, 1);
    assert.ok(instance.metrics().alignmentTokenShare >= 0.2);
});

test("team manifest blocks an unauthorized delegatee", () => {
    const { instance } = session(manifest);
    assert.throws(
        () =>
            instance.delegate({
                granter: "a.lead",
                delegatee: "a.stranger",
                goalDigest: "sha256:" + "b".repeat(64),
                scope: ["tool.logs.query"],
                budget: { tokens: 1 },
                deadline,
                mayRedelegate: false,
                depth: 0,
            }),
        Error,
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
