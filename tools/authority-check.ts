#!/usr/bin/env node
/**
 * Team-manifest enforcement + conflict adjudication.
 */
import assert from "node:assert/strict";

import { adjudicate, mergeResults } from "../src/cooperation/merge.ts";
import { AttenuationError, TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation } from "../src/delegate/team.ts";
import type { TeamManifest } from "../src/types/index.ts";
import type { Adjudication, MergedClaim, MergeResult } from "../src/cooperation/merge.ts";

let Passed: number = 0;
let Failed: number = 0;

type SyncTest = (name: string, fn: () => void) => void;

const test: SyncTest = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Team: TeamManifest = {
    amp: "0.1",
    kind: "team-manifest",
    id: "team.a",
    version: 1,
    members: [
        { id: "a.lead", role: "coordinator", authority: ["tool.logs.query"] },
        { id: "a.worker", role: "investigator", authority: ["tool.logs.query"] },
    ],
    max_depth: 1,
    max_fanout: 1,
    budget: { tokens: 2000 },
    termination: "verified",
    attested_at: "2026-10-24T10:00:00Z",
};

const Goal: string = `sha256:${"a".repeat(64)}`;
const Base: Omit<Delegation, "id"> = {
    granter: "a.lead",
    delegatee: "a.worker",
    goalDigest: Goal,
    scope: ["tool.logs.query"],
    budget: { tokens: 1000 },
    deadline: "2026-10-24T12:00:00Z",
    mayRedelegate: false,
    depth: 0,
};

const runtime: () => TeamRuntime = () => new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" });

test("valid delegation passes manifest checks", () => {
    assert.ok(runtime().createDelegation(Base, Team));
});

test("non-member delegatee is rejected", () => {
    assert.throws(() => runtime().createDelegation({ ...Base, delegatee: "a.stranger" }, Team), AttenuationError);
});

test("scope beyond authority is rejected", () => {
    assert.throws(() => runtime().createDelegation({ ...Base, scope: ["tool.deploy.rollback"] }, Team), AttenuationError);
});

test("budget beyond team budget is rejected", () => {
    assert.throws(() => runtime().createDelegation({ ...Base, budget: { tokens: 5000 } }, Team), AttenuationError);
});

test("fan-out cap is enforced", () => {
    const instance: TeamRuntime = runtime();
    instance.createDelegation(Base, Team);
    assert.throws(() => instance.createDelegation({ ...Base, goalDigest: `sha256:${"b".repeat(64)}` }, Team), AttenuationError);
});

test("adjudication prefers the higher tier", () => {
    const contested: MergedClaim[] = [
        { subject: "s", value: "a", tier: "T3", supporters: ["a.one"], origins: ["r1"], status: "contested" },
        { subject: "s", value: "b", tier: "T1", supporters: ["a.two"], origins: ["r2"], status: "contested" },
    ];
    const verdict: Adjudication = adjudicate(contested, { "a.one": 1, "a.two": 9 });
    assert.equal(verdict.decision, "accept");
    assert.equal(verdict.value, "a");
    assert.equal(verdict.reason, "higher evidence tier");
});

test("adjudication falls back to authority at equal tiers", () => {
    const contested: MergedClaim[] = [
        { subject: "s", value: "a", tier: "T2", supporters: ["a.one"], origins: ["r1"], status: "contested" },
        { subject: "s", value: "b", tier: "T2", supporters: ["a.two"], origins: ["r2"], status: "contested" },
    ];
    assert.equal(adjudicate(contested, { "a.one": 2, "a.two": 8 }).value, "b");
});

test("no dominance escalates instead of guessing", () => {
    const contested: MergedClaim[] = [
        { subject: "s", value: "a", tier: "T2", supporters: ["a.one"], origins: ["r1"], status: "contested" },
        { subject: "s", value: "b", tier: "T2", supporters: ["a.two"], origins: ["r2"], status: "contested" },
    ];
    const verdict: Adjudication = adjudicate(contested, { "a.one": 5, "a.two": 5 });
    assert.equal(verdict.decision, "escalate");
});

test("merge then adjudicate keeps both values until a decision exists", () => {
    const result: MergeResult = mergeResults(
        [
            { id: "c1", subject: "x", value: "a", tier: "T2", agent: "a.one", origins: ["r1"], replayable: true },
            { id: "c2", subject: "x", value: "b", tier: "T2", agent: "a.two", origins: ["r2"], replayable: true },
        ],
        { forAgent: "a.lead" },
    );
    assert.equal(result.merged.length, 2);
    assert.equal(adjudicate(result.merged, { "a.one": 1, "a.two": 3 }).value, "b");
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
