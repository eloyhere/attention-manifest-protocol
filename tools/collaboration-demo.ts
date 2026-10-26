#!/usr/bin/env node
/**
 * Emits schema-valid delegation / lease / result-contract for docs/examples.
 */
import type { ResultContract } from "../src/cooperation/collaboration.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation, Lease } from "../src/delegate/team.ts";

const Team: TeamRuntime = new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" });
const GoalDigest: string = `sha256:${"a".repeat(64)}`;

const DelegationRecord: Delegation = Team.createDelegation({
    granter: "a.lead",
    delegatee: "a.worker",
    goalDigest: GoalDigest,
    scope: ["tool.logs.query", "tool.metrics.query"],
    budget: { tokens: 4000, calls: 8 },
    deadline: "2026-10-24T12:00:00Z",
    mayRedelegate: false,
    depth: 0,
});

const LeaseRecord: Lease = Team.issueLease(DelegationRecord.id, {
    taskId: "t1",
    holder: "a.worker",
    goalDigest: GoalDigest,
    budget: { tokens: 1200, calls: 2 },
    deadline: "2026-10-24T11:00:00Z",
});

const Result: ResultContract = {
    amp: "0.1",
    kind: "result-contract",
    id: "rc.1",
    lease: LeaseRecord.id,
    goal_digest: GoalDigest,
    claims: [{ kind: "claim", id: "cl.91" }],
    evidence: [{ kind: "evidence", id: "ev.1" }],
    unknowns: ["lane B 未采样"],
    artifacts: [{ id: "a.1", digest: `sha256:${"c".repeat(64)}` }],
    status: "ok",
};

console.log(
    JSON.stringify(
        [
            {
                amp: "0.1",
                kind: "delegation",
                id: DelegationRecord.id,
                granter: DelegationRecord.granter,
                delegatee: DelegationRecord.delegatee,
                goal_digest: DelegationRecord.goalDigest,
                scope: DelegationRecord.scope,
                budget: DelegationRecord.budget,
                deadline: DelegationRecord.deadline,
                may_redelegate: DelegationRecord.mayRedelegate,
                depth: DelegationRecord.depth,
            },
            {
                amp: "0.1",
                kind: "lease",
                id: LeaseRecord.id,
                delegation: LeaseRecord.delegation,
                task_id: LeaseRecord.taskId,
                holder: LeaseRecord.holder,
                fence: LeaseRecord.fence,
                goal_digest: LeaseRecord.goalDigest,
                budget: LeaseRecord.budget,
                deadline: LeaseRecord.deadline,
                status: LeaseRecord.status,
            },
            Result,
        ],
        null,
        2,
    ),
);
