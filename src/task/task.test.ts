import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalService } from "../goal/index.ts";
import { IntentService } from "../intent/index.ts";
import { MissionService } from "../mission/index.ts";
import { PlanService } from "../plan/index.ts";
import { SessionService } from "../session/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { TASK_STATE_ALIASES } from "../workflow/transitions.ts";
import type { Acceptance, TransitionOptions } from "../workflow/types.ts";
import { TaskService } from "./index.ts";

const now = "2026-01-01T00:00:00Z";
const verified: Acceptance = { valid: true, contractVersion: "v1", verificationId: "verification", evidenceIds: ["evidence"] };
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
    return { store, plan, task };
};

test("task: proposed -> ready -> active -> paused -> active -> blocked -> unblocked -> ready -> completed", () => {
    const { plan, task } = fixture();
    plan.approve("p", options(0));
    assert.equal(task.propose("k", options(0)).state, "proposed");
    assert.equal(task.ready("k", options(1)).state, "ready");
    assert.equal(task.activate("k", options(2)).state, "active");
    assert.equal(task.pause("k", options(3)).state, "paused");
    assert.equal(task.resume("k", options(4)).state, "active");
    assert.equal(task.block("k", options(5, { reason: "waiting" })).state, "blocked");
    assert.equal(task.unblock("k", options(6)).state, "unblocked");
    assert.equal(task.ready("k", options(7)).state, "ready");
    assert.equal(task.activate("k", options(8)).state, "active");
    assert.equal(task.complete("k", verified, options(9)).state, "completed");
    assert.equal(task.get("k").assessment?.verificationId, "verification");
});

test("task: running/succeeded aliases are documented, dead_letter is terminal and illegal edges throw", () => {
    const { plan, task } = fixture();
    assert.equal(TASK_STATE_ALIASES.running, "active");
    assert.equal(TASK_STATE_ALIASES.succeeded, "completed");
    assert.throws(() => task.skip("k", options(0)), { code: "guard_rejected" });
    assert.throws(() => task.complete("k", verified, options(0)), { code: "invalid_transition" });
    plan.approve("p", options(0));
    assert.equal(task.get("k").version, 0);
    assert.equal(task.ready("k", options(0)).version, 1);
    assert.equal(task.start("k", options(1)).version, 2);
    assert.equal(task.deadLetter("k", options(2)).version, 3);
    assert.equal(task.get("k").state, "dead_letter");
    assert.throws(() => task.ready("k", options(3)), { code: "invalid_transition" });
});

test("task: CAS rejects stale versions while every successful transition increments exactly once", () => {
    const { plan, task } = fixture();
    plan.approve("p", options(0));
    assert.throws(() => task.ready("k", options(1)), { code: "version_conflict" });
    const ready = task.ready("k", options(0));
    assert.equal(ready.state, "ready");
    assert.equal(ready.version, 1);
    assert.throws(() => task.start("k", options(0)), { code: "version_conflict" });
    assert.equal(task.start("k", options(1)).version, 2);
    assert.equal(task.pause("k", options(2)).version, 3);
    assert.equal(task.resume("k", options(3)).version, 4);
    assert.equal(task.get("k").state, "active");
});
