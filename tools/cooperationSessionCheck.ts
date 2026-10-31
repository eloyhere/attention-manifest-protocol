#!/usr/bin/env node
/**
 * End-to-end collaboration session: delegation → board → lease → spend → metrics.
 */
import assert from "node:assert/strict";

import { DuplicateGoal, type BoardTask } from "../src/cooperation/board.ts";
import { TeamSession } from "../src/cooperation/session.ts";
import type { UnifiedSnapshot } from "../src/cooperation/unified.ts";
import type { Delegation, Lease } from "../src/delegate/team.ts";
import type { TeamManifest } from "../src/delegate/teamTypes.ts";

type SessionFixture = {
    instance: TeamSession;
    delegation: Delegation;
};

type Started = {
    task: BoardTask;
    lease: Lease;
};

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
const now: () => string = (): string => new Date(Date.parse("2026-10-24T10:00:00Z") + Tick++ * 60_000).toISOString();
const Goal: string = `sha256:${"a".repeat(64)}`;
const Deadline: string = "2026-10-24T12:00:00Z";

const session: (manifest: TeamManifest) => SessionFixture = (manifest: TeamManifest): SessionFixture => {
    const instance: TeamSession = new TeamSession({ budget: { tokens: 100, calls: 4, ms: 60_000 }, now, manifest });
    const delegation: Delegation = instance.delegate({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: ["tool.logs.query"],
        budget: { tokens: 80, calls: 3 },
        deadline: Deadline,
        mayRedelegate: false,
        depth: 0,
    });
    return { instance, delegation };
};

const Manifest: TeamManifest = {
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
    const { instance, delegation }: SessionFixture = session(Manifest);
    const { task, lease }: Started = instance.start(delegation.id, {
        taskId: "t1",
        holder: "a.worker",
        goalDigest: Goal,
        budget: { tokens: 50 },
        deadline: Deadline,
    });
    assert.equal(task.state, "leased");
    assert.equal(task.lease, lease.id);
    assert.equal(instance.board.stats().open, 1);
});

test("a duplicate goal never consumes a lease", () => {
    const { instance, delegation }: SessionFixture = session(Manifest);
    instance.start(delegation.id, { taskId: "t1", holder: "a.worker", goalDigest: Goal, budget: { tokens: 10 }, deadline: Deadline });
    assert.throws(
        () => instance.start(delegation.id, { taskId: "t2", holder: "a.worker", goalDigest: Goal, budget: { tokens: 10 }, deadline: Deadline }),
        DuplicateGoal,
    );
    assert.equal(instance.board.stats().open, 1);
});

test("spend reserves on the lease and charges the shared account", () => {
    const { instance, delegation }: SessionFixture = session(Manifest);
    const { lease }: Started = instance.start(delegation.id, {
        taskId: "t1",
        holder: "a.worker",
        goalDigest: Goal,
        budget: { tokens: 50 },
        deadline: Deadline,
    });
    instance.spend(lease.id, { tokens: 30, calls: 1 }, () => "ok");
    assert.equal(instance.snapshot().tokens, 30);
    assert.equal(instance.team.usage(lease.id).spent.tokens, 30);
});

test("over-budget spend is rejected and does not run", () => {
    const { instance, delegation }: SessionFixture = session(Manifest);
    const { lease }: Started = instance.start(delegation.id, {
        taskId: "t1",
        holder: "a.worker",
        goalDigest: Goal,
        budget: { tokens: 20 },
        deadline: Deadline,
    });
    assert.throws(() => instance.spend(lease.id, { tokens: 40 }, () => "never"), Error);
    assert.equal(instance.snapshot().tokens, 0);
});

test("finish closes both the lease and the board task", () => {
    const { instance, delegation }: SessionFixture = session(Manifest);
    const { lease }: Started = instance.start(delegation.id, {
        taskId: "t1",
        holder: "a.worker",
        goalDigest: Goal,
        budget: { tokens: 10 },
        deadline: Deadline,
    });
    instance.spend(lease.id, { tokens: 10 }, () => undefined);
    const { task }: Started = instance.finish(lease.id);
    assert.equal(task.state, "done");
    assert.equal(instance.board.stats().open, 0);
    assert.equal(instance.metrics().costPerSuccess, 10);
});

test("cancellation closes the board task and frees the goal", () => {
    const { instance, delegation }: SessionFixture = session(Manifest);
    const { lease }: Started = instance.start(delegation.id, {
        taskId: "t1",
        holder: "a.worker",
        goalDigest: Goal,
        budget: { tokens: 10 },
        deadline: Deadline,
    });
    instance.cancel(lease.id);
    assert.throws(() => instance.spend(lease.id, { tokens: 1 }, () => undefined), Error);
    assert.equal(instance.board.stats().open, 0);
});

test("attention and compute appear in one snapshot", () => {
    const { instance }: SessionFixture = session(Manifest);
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
    const snap: UnifiedSnapshot = instance.snapshot();
    assert.equal(snap.interruptsGranted, 1);
    assert.ok(instance.metrics().alignmentTokenShare >= 0.2);
});

test("team manifest blocks an unauthorized delegatee", () => {
    const { instance }: SessionFixture = session(Manifest);
    assert.throws(
        () =>
            instance.delegate({
                granter: "a.lead",
                delegatee: "a.stranger",
                goalDigest: `sha256:${"b".repeat(64)}`,
                scope: ["tool.logs.query"],
                budget: { tokens: 1 },
                deadline: Deadline,
                mayRedelegate: false,
                depth: 0,
            }),
        Error,
    );
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
