import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalService } from "../goal/index.ts";
import { IntentService } from "../intent/index.ts";
import { MissionService } from "../mission/index.ts";
import { SessionService } from "../session/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { PLAN_STATE_ALIASES } from "../workflow/transitions.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { PlanService } from "./index.ts";

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
    return { store, plan };
};

test("plan: approved -> executing -> paused -> executing -> replanning -> approved -> ready/running", () => {
    const { plan } = fixture();
    assert.equal(plan.approve("p", options(0)).state, "approved");
    assert.equal(plan.execute("p", options(1)).state, "executing");
    assert.equal(plan.pause("p", options(2)).state, "paused");
    assert.equal(plan.resume("p", options(3)).state, "executing");
    assert.equal(plan.replan("p", options(4)).state, "replanning");
    assert.equal(plan.approve("p", options(5)).state, "approved");
    assert.equal(plan.ready("p", options(6)).state, "ready");
    assert.equal(plan.start("p", options(7)).state, "running");
});

test("plan: legacy ready/running aliases are documented and illegal edges throw", () => {
    const { plan } = fixture();
    assert.equal(PLAN_STATE_ALIASES.ready, "approved");
    assert.equal(PLAN_STATE_ALIASES.running, "executing");
    assert.throws(() => plan.start("p", options(0)), { code: "invalid_transition" });
    plan.ready("p", options(0));
    assert.throws(() => plan.replan("p", options(1)), { code: "invalid_transition" });
    assert.equal(plan.start("p", options(1)).state, "running");
    assert.throws(() => plan.approve("p", options(2)), { code: "invalid_transition" });
});
