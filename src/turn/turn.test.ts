import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentService } from "../intent/index.ts";
import { SessionService } from "../session/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { TurnService } from "./index.ts";
import type { TurnCompactionPolicy } from "./index.ts";

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
    return { store, session, turn, intent };
};

const actingTurn = () => {
    const instance = fixture();
    instance.turn.create({ id: "origin", sessionId: "s", classification: "new_intent" }, "host");
    instance.turn.create({ id: "t", sessionId: "s", classification: "new_intent", originTurnId: "origin" }, "host");
    instance.turn.interpret("t", options(0));
    instance.intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "continue this work" }, "host");
    instance.turn.act("t", options(1));
    return instance;
};

const completeTurns = (turn: TurnService, count: number, start = 1): void => {
    for (let index = start; index < start + count; index += 1) {
        const id = `t${index}`;
        turn.create({ id, sessionId: "s", classification: "new_intent" }, "host");
        turn.interpret(id, options(0));
        turn.respond(id, options(1));
        turn.complete(id, options(2));
    }
};

test("turn: §4.2 interpreting -> clarifying -> interpreting -> acting -> responding -> completed", () => {
    const { turn } = fixture();
    turn.create({ id: "t", sessionId: "s", classification: "new_intent", continuationKey: "continuation" }, "host");
    assert.equal(turn.interpret("t", options(0)).state, "interpreting");
    assert.equal(turn.clarify("t", options(1)).state, "clarifying");
    assert.throws(() => turn.resumeClarification("t", "wrong", options(2)), { code: "guard_rejected" });
    assert.equal(turn.resumeClarification("t", "continuation", options(2)).state, "interpreting");
    assert.equal(turn.act("t", options(3)).state, "acting");
    assert.equal(turn.respond("t", options(4)).state, "responding");
    assert.equal(turn.complete("t", options(5)).state, "completed");
});

test("turn: interrupt captures the §4.2 site snapshot and resume continues back into acting", () => {
    const { turn } = actingTurn();
    const interrupted = turn.interrupt("t", {
        expectedVersion: 2, actor: "host", reason: "timeout", now,
        workspaceChanges: [{ path: "src/a.ts", change: "modified", digest: "sha256:a", summary: "edited" }],
    });
    assert.equal(interrupted.state, "interrupted");
    const snapshot = turn.interruption("t");
    assert.ok(snapshot !== void 0);
    assert.equal(snapshot.state, "acting");
    assert.equal(snapshot.turnId, "t");
    assert.equal(snapshot.sessionId, "s");
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.originTurnId, "origin");
    assert.equal(snapshot.pendingIntentId, "i");
    assert.deepEqual(snapshot.pendingIntentIds, ["i"]);
    assert.equal(snapshot.workspaceChanges[0]?.path, "src/a.ts");
    assert.equal(snapshot.digest.startsWith("sha256:"), true);
    assert.equal(interrupted.interruption?.digest, snapshot.digest);

    const resumed = turn.resume("t", { expectedVersion: 3, actor: "host" });
    assert.equal(resumed.state, "acting");
    assert.equal(resumed.resumedFromSnapshot, true);
    assert.equal(resumed.version, 5);
    const replay = turn.resume("t");
    assert.equal(replay.state, "acting");
    assert.equal(replay.version, resumed.version);
});

test("turn: resume rejects tampered snapshots and detects pending-Intent staleness", () => {
    const { turn, intent } = actingTurn();
    turn.interrupt("t", { expectedVersion: 2, actor: "host", reason: "network drop", now });
    const snapshot = turn.interruption("t");
    assert.ok(snapshot !== void 0);
    assert.throws(() => turn.resume("t", { snapshot: { ...snapshot, reason: "tampered" } }), { code: "invalid_snapshot" });

    const stale = actingTurn();
    stale.turn.interrupt("t", { expectedVersion: 2, actor: "host", reason: "timeout", now });
    stale.intent.abandon("i", options(0, { actor: "host" }));
    assert.throws(() => stale.turn.resume("t", { expectedVersion: 3 }), { code: "stale_snapshot" });
    assert.equal(stale.turn.get("t").state, "interrupted");
    assert.equal(intent.get("i").state, "captured");
});

test("turn: supersede interrupts a new-input replacement while explicit abandon is terminal (§4.2)", () => {
    const { turn } = actingTurn();
    const superseded = turn.supersede("t", "a new user message arrived", options(2));
    assert.equal(superseded.state, "interrupted");
    assert.equal(superseded.interruption?.state, "acting");
    assert.match(superseded.interruption?.reason ?? "", /superseded by new input/);
    const abandoned = turn.abandon("t", options(3, { reason: "user cancelled explicitly" }));
    assert.equal(abandoned.state, "abandoned");
    const events = turn.get("t");
    assert.equal(events.state, "abandoned");

    const direct = actingTurn();
    const cancelled = direct.turn.abandon("t", "user cancelled explicitly", options(2));
    assert.equal(cancelled.state, "abandoned");
    assert.equal(cancelled.interruption?.state, "acting");
    assert.equal(direct.turn.abandon("t", "again").state, "abandoned");
});

test("turn: compactHistory keeps recent Turns, summarizes older ones and archives the oldest", () => {
    const { turn } = fixture();
    completeTurns(turn, 6);
    const policy = { keepRecent: 2, summarizeWithin: 1, now };
    const result = turn.compactHistory("s", policy);
    assert.deepEqual(result.kept.map(item => item.id), ["t5", "t6"]);
    assert.deepEqual(result.summarized.map(item => item.turnId), ["t4"]);
    assert.deepEqual(result.archived.map(item => item.turnId), ["t1", "t2", "t3"]);
    assert.equal(result.record.evidenceKind, "system_rule");
    assert.equal(result.record.source.type, "system_rule");
    assert.equal(result.record.source.reliability, 0.95);
    assert.equal(result.record.createdAt, now);
    assert.deepEqual(result.record.keptIds, ["t5", "t6"]);
    assert.deepEqual(result.record.summarizedIds, ["t4"]);
    assert.deepEqual(result.record.archivedIds, ["t1", "t2", "t3"]);
    assert.equal(result.record.policy.keepRecent, 2);
    assert.equal(result.record.policy.summarizeWithin, 1);
    assert.match(result.record.reason, /§4\.2/);
    assert.equal(result.record.reason.length > 0, true);
    assert.equal(result.record.id.startsWith("turn-compaction:"), true);
    assert.match(result.record.sessionSummary, /t1/);

    const again = turn.compactHistory("s", policy);
    assert.equal(again.record.digest, result.record.digest);
    assert.equal(again.record.id, result.record.id);
});

test("turn: compactHistory protects active Turns and Turns with unresolved Intents", () => {
    const active = fixture();
    completeTurns(active.turn, 3);
    active.turn.create({ id: "t4", sessionId: "s", classification: "new_intent" }, "host");
    active.turn.interpret("t4", options(0));
    active.intent.create({ id: "i4", sessionId: "s", originTurnId: "t4", text: "pending" }, "host");
    active.turn.act("t4", options(1));
    completeTurns(active.turn, 1, 5);
    const activeResult = active.turn.compactHistory("s", { keepRecent: 1, summarizeWithin: 1, now });
    assert.deepEqual(activeResult.kept.map(item => item.id), ["t4", "t5"]);
    assert.deepEqual(activeResult.summarized.map(item => item.turnId), ["t3"]);
    assert.deepEqual(activeResult.archived.map(item => item.turnId), ["t1", "t2"]);
    assert.deepEqual(activeResult.record.protected, [{ turnId: "t4", reason: "active_turn" }]);

    const unresolved = fixture();
    unresolved.turn.create({ id: "u", sessionId: "s", classification: "new_intent" }, "host");
    unresolved.turn.interpret("u", options(0));
    unresolved.intent.create({ id: "ui", sessionId: "s", originTurnId: "u", text: "unresolved" }, "host");
    unresolved.turn.respond("u", options(1));
    unresolved.turn.complete("u", options(2));
    unresolved.turn.create({ id: "v", sessionId: "s", classification: "new_intent" }, "host");
    unresolved.turn.interpret("v", options(0));
    unresolved.turn.respond("v", options(1));
    unresolved.turn.complete("v", options(2));
    const unresolvedResult = unresolved.turn.compactHistory("s", { keepRecent: 0, summarizeWithin: 0, now });
    assert.deepEqual(unresolvedResult.kept.map(item => item.id), ["u"]);
    assert.deepEqual(unresolvedResult.archived.map(item => item.turnId), ["v"]);
    assert.deepEqual(unresolvedResult.record.protected, [{ turnId: "u", reason: "unresolved_intent" }]);
});

test("turn: compactHistory boundaries are safe and invalid policies are rejected", () => {
    const { turn } = fixture();
    completeTurns(turn, 2);
    const all = turn.compactHistory("s", { keepRecent: 5, summarizeWithin: 5, now });
    assert.deepEqual(all.kept.map(item => item.id), ["t1", "t2"]);
    assert.deepEqual(all.summarized, []);
    assert.deepEqual(all.archived, []);
    assert.throws(() => turn.compactHistory("s", { keepRecent: -1 } as TurnCompactionPolicy), { code: "invalid_policy" });
    assert.throws(() => turn.compactHistory("s", { keepRecent: 1, summarizeWithin: -1 }), { code: "invalid_policy" });
    assert.throws(() => turn.compactHistory("missing", { keepRecent: 1 }), { code: "not_found" });
});
