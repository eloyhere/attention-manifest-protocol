import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionService } from "../session/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { IntentService } from "./index.ts";

const now = "2026-01-01T00:00:00Z";
const options = (version: number, extra: Partial<TransitionOptions> = {}): TransitionOptions => ({
    actor: "host", expectedVersion: version, cancellationEpoch: 0, ...extra,
});
const fixture = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    const intent = new IntentService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "intent" }, "host");
    return { store, session, turn, intent };
};

test("intent: §4.3 interpreted -> clarifying <-> clarified -> confirmed -> delegated -> fulfilled", () => {
    const { intent } = fixture();
    assert.equal(intent.interpret("i", options(0)).state, "interpreted");
    assert.equal(intent.clarify("i", options(1)).state, "clarifying");
    assert.equal(intent.resolveClarification("i", options(2)).state, "clarified");
    assert.equal(intent.clarify("i", options(3)).state, "clarifying");
    assert.equal(intent.resolveClarification("i", options(4)).state, "clarified");
    assert.equal(intent.confirm("i", options(5)).state, "confirmed");
    assert.equal(intent.delegate("i", options(6)).state, "delegated");
    assert.equal(intent.fulfill("i", options(7)).state, "fulfilled");
});

test("intent: deferred resumes through confirmed and abandonment is terminal", () => {
    const { intent } = fixture();
    intent.confirm("i", options(0));
    assert.equal(intent.defer("i", options(1)).state, "deferred");
    assert.equal(intent.resume("i", options(2)).state, "resumed");
    assert.equal(intent.confirm("i", options(3)).state, "confirmed");
    assert.equal(intent.abandon("i", options(4)).state, "abandoned");
    assert.throws(() => intent.confirm("i", options(5)), { code: "invalid_transition" });
});

test("intent: superseded is reachable from any non-superseded state and illegal edges throw", () => {
    const { intent } = fixture();
    assert.throws(() => intent.fulfill("i", options(0)), { code: "invalid_transition" });
    assert.throws(() => intent.resolveClarification("i", options(0)), { code: "invalid_transition" });
    intent.confirm("i", options(0));
    intent.accept("i", options(1));
    assert.equal(intent.supersede("i", options(2)).state, "superseded");
    assert.throws(() => intent.accept("i", options(3)), { code: "invalid_transition" });
});
