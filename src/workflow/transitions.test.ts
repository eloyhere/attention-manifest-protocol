import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ACTION_STATE_ALIASES, PLAN_STATE_ALIASES, TASK_STATE_ALIASES, initialWorkflowStates, workflowTransitions,
} from "./transitions.ts";
import type { WorkflowKind } from "./types.ts";

const statesOf = (kind: WorkflowKind): Set<string> => new Set([
    initialWorkflowStates[kind],
    ...Object.keys(workflowTransitions[kind]),
    ...Object.values(workflowTransitions[kind]).flat(),
]);

test("workflow transitions: every §4 lifecycle state is represented and legacy initial states are unchanged", () => {
    const expected: Readonly<Record<WorkflowKind, readonly string[]>> = {
        session: ["created", "active", "idle", "suspended", "resumed", "closing", "closed", "archived", "expired", "aborted"],
        turn: ["received", "interpreting", "clarifying", "acting", "responding", "completed", "interrupted", "resumed", "abandoned", "failed"],
        intent: ["captured", "interpreted", "clarifying", "clarified", "confirmed", "accepted", "delegated", "fulfilled", "rejected", "deferred", "resumed", "abandoned", "superseded", "withdrawn"],
        mission: ["accepted", "proposed", "active", "achieved", "partially_achieved", "paused", "resumed", "archived", "abandoned", "failed", "cancel_requested", "draining", "cancelled", "completed_after_cancel", "unknown_outcome"],
        goal: ["pending", "proposed", "active", "achieved", "failed", "blocked", "unblocked", "abandoned", "cancel_requested", "draining", "cancelled", "completed_after_cancel", "unknown_outcome"],
        plan: ["draft", "approved", "ready", "executing", "running", "paused", "replanning", "completed", "failed", "superseded", "cancel_requested", "draining", "cancelled", "completed_after_cancel", "unknown_outcome"],
        task: ["pending", "proposed", "ready", "running", "active", "paused", "blocked", "unblocked", "completed", "succeeded", "dead_letter", "skipped", "failed", "cancel_requested", "draining", "cancelled", "completed_after_cancel", "unknown_outcome"],
        action: ["declared", "pending", "ready", "running", "executing", "succeeded", "failed", "skipped", "dead_letter", "retrying", "reconciling", "cancel_requested", "draining", "cancelled", "completed_after_cancel", "unknown_outcome"],
    };
    for (const kind of Object.keys(expected) as WorkflowKind[]) {
        for (const state of expected[kind]) assert.ok(statesOf(kind).has(state), `${kind} is missing ${state}`);
    }
    assert.deepEqual(initialWorkflowStates, {
        session: "created", turn: "received", intent: "captured", mission: "accepted", goal: "pending", plan: "draft", task: "pending", action: "declared",
    });
});

test("workflow transitions: §4 alias maps and lifecycle edges are explicit", () => {
    assert.deepEqual(PLAN_STATE_ALIASES, { ready: "approved", running: "executing" });
    assert.deepEqual(TASK_STATE_ALIASES, { running: "active", succeeded: "completed" });
    assert.deepEqual(ACTION_STATE_ALIASES, { running: "executing" });
    assert.ok(workflowTransitions.intent.clarifying?.includes("clarified"));
    assert.ok(workflowTransitions.intent.clarified?.includes("clarifying"));
    assert.ok(workflowTransitions.intent.deferred?.includes("resumed"));
    assert.ok(workflowTransitions.intent.resumed?.includes("confirmed"));
    for (const [state, edges] of Object.entries(workflowTransitions.intent)) {
        if (state === "superseded") assert.deepEqual(edges, []);
        else assert.ok(edges.includes("superseded"), `intent ${state} cannot be superseded`);
    }
    assert.ok(workflowTransitions.mission.paused?.includes("resumed"));
    assert.ok(workflowTransitions.mission.resumed?.includes("paused"));
    assert.ok(workflowTransitions.mission.paused?.includes("archived"));
    assert.equal(workflowTransitions.mission.archived, void 0);
    assert.ok(workflowTransitions.goal.blocked?.includes("unblocked"));
    assert.ok(workflowTransitions.goal.unblocked?.includes("active"));
    assert.ok(workflowTransitions.goal.unblocked?.includes("abandoned"));
    assert.ok(workflowTransitions.intent.confirmed?.includes("abandoned"));
    assert.ok(workflowTransitions.mission.accepted?.includes("abandoned"));
    assert.ok(workflowTransitions.plan.draft?.includes("approved"));
    assert.ok(workflowTransitions.plan.replanning?.includes("approved"));
    assert.ok(workflowTransitions.task.unblocked?.includes("ready"));
    assert.ok(workflowTransitions.task.paused?.includes("active"));
    assert.ok(workflowTransitions.action.failed?.includes("retrying"));
    assert.ok(workflowTransitions.action.retrying?.includes("dead_letter"));
    assert.equal(workflowTransitions.action.dead_letter, void 0);
    assert.equal(workflowTransitions.task.dead_letter, void 0);
});
