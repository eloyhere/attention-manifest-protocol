import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalService } from "../goal/index.ts";
import { IntentService } from "../intent/index.ts";
import { MissionService } from "../mission/index.ts";
import { PlanService } from "../plan/index.ts";
import { SessionService } from "../session/index.ts";
import { TaskService } from "../task/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { ACTION_STATE_ALIASES } from "../workflow/transitions.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { ActionService } from "./index.ts";

const now = "2026-01-01T00:00:00Z";
const options = (version: number, extra: Partial<TransitionOptions> = {}): TransitionOptions => ({
    actor: "host", expectedVersion: version, cancellationEpoch: 0, ...extra,
});
const bounds = { maxAttempts: 2, deadline: "2027-01-01T00:00:00Z", progressMetric: "accepted effects", deadLetterOwner: "operator" };
const fixture = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    const intent = new IntentService(store);
    const mission = new MissionService(store);
    const goal = new GoalService(store);
    const plan = new PlanService(store);
    const task = new TaskService(store);
    const action = new ActionService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "intent" }, "host");
    intent.confirm("i", options(0));
    intent.accept("i", options(1));
    mission.create({ id: "m", sessionId: "s", intentId: "i" }, "host");
    mission.activate("m", options(0));
    goal.create({ id: "g", sessionId: "s", missionId: "m", contractVersion: "v1", acceptanceCriteria: ["criterion"] }, "host");
    goal.activate("g", options(0));
    plan.create({ id: "p", sessionId: "s", goalId: "g", bounds }, "host");
    task.create({ id: "k", sessionId: "s", planId: "p", dependsOn: [], required: true, contractVersion: "v1", requiredEffects: [] }, "host");
    plan.ready("p", options(0));
    plan.start("p", options(1));
    task.ready("k", options(0));
    task.start("k", options(1));
    action.create({ id: "a", sessionId: "s", originTurnId: "t", taskId: "k", operationId: "operation", required: true, effect: "effect", sideEffect: true, recovery: "query" }, "host");
    return { store, action };
};

test("action: declared -> pending -> ready -> skipped keeps execution facts behind attempts", () => {
    const { action } = fixture();
    assert.equal(action.pend("a", options(0)).state, "pending");
    assert.equal(action.ready("a", options(1)).state, "ready");
    assert.throws(() => action.transition("a", "executing", options(2)), { code: "guard_rejected" });
    assert.throws(() => action.transition("a", "running", options(2)), { code: "guard_rejected" });
    assert.equal(action.skip("a", options(2)).state, "skipped");
    assert.throws(() => action.ready("a", options(3)), { code: "invalid_transition" });
});

test("action: failed -> retrying -> dead_letter; running is the legacy alias of executing", () => {
    const { action, store } = fixture();
    assert.equal(ACTION_STATE_ALIASES.running, "executing");
    action.ready("a", options(0));
    action.startAttempt("a", { expectedVersion: 1, cancellationEpoch: 0, actor: "executor", executionId: "execution-1", attemptId: "attempt-1" });
    assert.equal(action.get("a").state, "running");
    action.settleAttempt("attempt-1", { actor: "executor", expectedVersion: 0, expectedActionVersion: 2, outcome: "failed" });
    assert.equal(store.get("action", "a").state, "failed");
    assert.equal(action.retry("a", options(3)).state, "retrying");
    assert.equal(action.deadLetter("a", options(4)).state, "dead_letter");
    assert.throws(() => action.ready("a", options(5)), { code: "invalid_transition" });
    assert.throws(() => action.retry("a", options(5)), { code: "invalid_transition" });
});

test("action: retrying can re-enter ready and admit a fresh attempt", () => {
    const { action } = fixture();
    action.ready("a", options(0));
    action.startAttempt("a", { expectedVersion: 1, cancellationEpoch: 0, actor: "executor", executionId: "execution-1", attemptId: "attempt-1" });
    action.settleAttempt("attempt-1", { actor: "executor", expectedVersion: 0, expectedActionVersion: 2, outcome: "failed" });
    action.retry("a", options(3));
    action.ready("a", options(4));
    action.startAttempt("a", { expectedVersion: 5, cancellationEpoch: 0, actor: "executor", executionId: "execution-2", attemptId: "attempt-2" });
    action.settleAttempt("attempt-2", { actor: "executor", expectedVersion: 0, expectedActionVersion: 6, outcome: "succeeded" });
    assert.equal(action.get("a").state, "succeeded");
    assert.equal(action.attempts("a").length, 2);
});
