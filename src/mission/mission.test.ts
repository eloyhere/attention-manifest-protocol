import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentService } from "../intent/index.ts";
import { SessionService } from "../session/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { MissionService } from "./index.ts";

const now = "2026-01-01T00:00:00Z";
const options = (version: number, extra: Partial<TransitionOptions> = {}): TransitionOptions => ({
    actor: "host", expectedVersion: version, cancellationEpoch: 0, ...extra,
});
const fixture = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    const intent = new IntentService(store);
    const mission = new MissionService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "intent" }, "host");
    intent.confirm("i", options(0));
    intent.accept("i", options(1));
    mission.create({ id: "m", sessionId: "s", intentId: "i" }, "host");
    return { store, mission };
};

test("mission: proposed -> active -> paused <-> resumed -> active -> partially_achieved", () => {
    const { mission } = fixture();
    assert.equal(mission.propose("m", options(0)).state, "proposed");
    assert.equal(mission.activate("m", options(1)).state, "active");
    assert.equal(mission.pause("m", options(2)).state, "paused");
    assert.equal(mission.resume("m", options(3)).state, "resumed");
    assert.equal(mission.pause("m", options(4)).state, "paused");
    assert.equal(mission.resume("m", options(5)).state, "resumed");
    assert.equal(mission.activate("m", options(6)).state, "active");
    assert.equal(mission.partiallyAchieve("m", options(7)).state, "partially_achieved");
});

test("mission: paused -> archived is terminal and illegal transitions still throw", () => {
    const { mission } = fixture();
    mission.activate("m", options(0));
    mission.pause("m", options(1));
    assert.equal(mission.archive("m", options(2)).state, "archived");
    assert.throws(() => mission.activate("m", options(3)), { code: "invalid_transition" });
    assert.throws(() => mission.pause("m", options(3)), { code: "invalid_transition" });
});

test("mission: legacy accepted state stays usable and abandoned is not a cancellation", () => {
    const { mission } = fixture();
    assert.equal(mission.get("m").state, "accepted");
    assert.equal(mission.abandon("m", options(0)).state, "abandoned");
    assert.throws(() => mission.activate("m", options(1)), { code: "invalid_transition" });
});
