import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentService } from "../intent/index.ts";
import { MissionService } from "../mission/index.ts";
import { SessionService } from "../session/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { Acceptance, TransitionOptions } from "../workflow/types.ts";
import { GoalService } from "./index.ts";

const now = "2026-01-01T00:00:00Z";
const verified: Acceptance = { valid: true, contractVersion: "v1", verificationId: "verification", evidenceIds: ["evidence"] };
const options = (version: number, extra: Partial<TransitionOptions> = {}): TransitionOptions => ({
    actor: "host", expectedVersion: version, cancellationEpoch: 0, ...extra,
});
const fixture = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    const intent = new IntentService(store);
    const mission = new MissionService(store);
    const goal = new GoalService(store);
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
    return { store, goal };
};

test("goal: proposed -> active -> blocked -> unblocked -> active -> achieved", () => {
    const { goal } = fixture();
    assert.equal(goal.propose("g", options(0)).state, "proposed");
    assert.equal(goal.activate("g", options(1)).state, "active");
    assert.equal(goal.block("g", options(2, { reason: "dependency unavailable" })).state, "blocked");
    assert.equal(goal.unblock("g", options(3)).state, "unblocked");
    assert.equal(goal.activate("g", options(4)).state, "active");
    assert.equal(goal.achieve("g", verified, options(5)).state, "achieved");
});

test("goal: illegal edges and abandoned terminal state throw", () => {
    const { goal } = fixture();
    assert.throws(() => goal.achieve("g", verified, options(0)), { code: "invalid_transition" });
    goal.activate("g", options(0));
    goal.block("g", options(1, { reason: "waiting for user input" }));
    assert.throws(() => goal.activate("g", options(2)), { code: "invalid_transition" });
    assert.equal(goal.unblock("g", options(2)).state, "unblocked");
    assert.equal(goal.abandon("g", options(3)).state, "abandoned");
    assert.throws(() => goal.activate("g", options(4)), { code: "invalid_transition" });
});
