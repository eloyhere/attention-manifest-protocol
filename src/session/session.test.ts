import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentService } from "../intent/index.ts";
import { TurnService } from "../turn/index.ts";
import { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { SessionService, sessionTypeOf } from "./index.ts";
import type { SessionSnapshot } from "./index.ts";

const now = "2026-01-01T00:00:00Z";
const options = (version: number, extra: Partial<TransitionOptions> = {}): TransitionOptions => ({
    actor: "host", expectedVersion: version, cancellationEpoch: 0, ...extra,
});

test("session: sessionType defaults to user_interactive and explicit types/expiry survive snapshots", () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const interactive = session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    assert.equal(interactive.sessionType, "user_interactive");
    assert.equal(sessionTypeOf(interactive), "user_interactive");
    const scheduled = session.create({
        id: "s2", sessionId: "s2", participants: [], sessionType: "scheduled", expiresAt: "2026-02-01T00:00:00Z",
    }, "host");
    assert.equal(scheduled.sessionType, "scheduled");
    assert.equal(scheduled.expiresAt, "2026-02-01T00:00:00Z");
    const restored = WorkflowStore.restore(store.snapshot());
    assert.equal(restored.get("session", "s2").sessionType, "scheduled");
    assert.equal(restored.get("session", "s2").expiresAt, "2026-02-01T00:00:00Z");
    assert.throws(() => session.create({ id: "s3", sessionId: "s3", participants: [], sessionType: "invalid" as never }, "host"), { code: "guard_rejected" });
    assert.throws(() => session.create({ id: "s4", sessionId: "s4", participants: [], expiresAt: "not-a-date" }, "host"), { code: "guard_rejected" });
});

const suspendedWithPersist = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    const intent = new IntentService(store);
    session.create({
        id: "s", sessionId: "s", participants: ["user"],
        sessionType: "scheduled", expiresAt: "2026-02-01T00:00:00Z",
        budget: { tokens: 100 }, budgetBalance: { tokens: 40 },
        persist: [{ kind: "intent", id: "i", reason: "unresolved input" }],
    }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "resume me" }, "host");
    session.suspend("s", options(1));
    return { store, session, turn, intent };
};

const suspendedPlain = () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    session.suspend("s", options(1));
    return { store, session };
};

test("session: resume(snapshot) restores lifecycle, type, expiry, persist refs and budget balance", () => {
    const { session } = suspendedWithPersist();
    const snapshot = session.snapshot("s", now);
    assert.equal(snapshot.state, "suspended");
    assert.equal(snapshot.version, 2);
    const result = session.resume(snapshot, { actor: "host", now: "2026-01-02T00:00:00Z" });
    assert.equal(result.resumed, true);
    assert.equal(result.idempotent, false);
    assert.equal(result.resumeCount, 1);
    assert.equal(result.session.state, "active");
    assert.equal(result.session.sessionType, "scheduled");
    assert.equal(result.session.expiresAt, "2026-02-01T00:00:00Z");
    assert.deepEqual(result.session.budget, { tokens: 100 });
    assert.deepEqual(result.budgetBalance, { tokens: 40 });
    assert.deepEqual(result.session.budgetBalance, { tokens: 40 });
    assert.deepEqual(result.persist.map(reference => reference.id), ["i"]);
    assert.deepEqual(result.session.persist?.map(reference => reference.id), ["i"]);
    assert.equal(result.skippedPersist.length, 0);
    assert.equal(result.snapshotDigest.startsWith("sha256:"), true);
});

test("session: resume restores type, expiry and budget that the stored row did not carry", () => {
    const { session } = suspendedPlain();
    const base = session.snapshot("s", now);
    const result = session.resume({
        ...base,
        sessionType: "delegated",
        expiresAt: "2027-01-01T00:00:00Z",
        budget: { tokens: 50 },
        budgetBalance: { tokens: 20 },
    }, { now });
    assert.equal(result.session.sessionType, "delegated");
    assert.equal(result.session.expiresAt, "2027-01-01T00:00:00Z");
    assert.deepEqual(result.session.budget, { tokens: 50 });
    assert.deepEqual(result.session.budgetBalance, { tokens: 20 });
    const reread = session.get("s");
    assert.equal(reread.sessionType, "delegated");
    assert.equal(reread.expiresAt, "2027-01-01T00:00:00Z");
    assert.deepEqual(reread.budgetBalance, { tokens: 20 });
    assert.equal(session.snapshot("s", now).sessionType, "delegated");
});

test("session: resuming the same snapshot twice is idempotent and does not count again", () => {
    const { session } = suspendedWithPersist();
    const snapshot = session.snapshot("s", now);
    const first = session.resume(snapshot, { now });
    const version = session.get("s").version;
    const second = session.resume(snapshot, { now: "2026-03-01T00:00:00Z" });
    assert.equal(second.idempotent, true);
    assert.equal(second.resumed, false);
    assert.equal(second.resumeCount, 1);
    assert.equal(first.resumeCount, 1);
    assert.equal(second.session.version, version);
    assert.equal(session.get("s").version, version);
});

test("session: a snapshot restores into an empty workflow store through the canonical path", () => {
    const { session } = suspendedWithPersist();
    const snapshot = session.snapshot("s", now);
    const freshStore = new WorkflowStore(() => now);
    const fresh = new SessionService(freshStore);
    const result = fresh.resume(snapshot, { actor: "host", now });
    assert.equal(result.session.id, "s");
    assert.equal(result.session.state, "active");
    assert.equal(result.session.sessionType, "scheduled");
    assert.equal(result.session.expiresAt, "2026-02-01T00:00:00Z");
    assert.deepEqual(result.session.budgetBalance, { tokens: 40 });
    assert.equal(result.resumeCount, 1);
    // The referent was not rehydrated into the fresh writer; the ref is reported, not invented.
    assert.deepEqual(result.persist, []);
    assert.deepEqual(result.skippedPersist.map(item => item.reason), ["unresolved"]);
});

test("session: resume rejects malformed, out-of-scope and stale snapshots with stable codes", () => {
    const { session } = suspendedPlain();
    const snapshot = session.snapshot("s", now);
    assert.throws(() => session.resume({ ...snapshot, schemaVersion: 2 } as unknown as SessionSnapshot), { code: "invalid_snapshot" });
    assert.throws(() => session.resume({ ...snapshot, sessionType: "not_a_type" } as unknown as SessionSnapshot), { code: "invalid_snapshot" });
    assert.throws(() => session.resume({ ...snapshot, budgetBalance: { tokens: -1 } } as SessionSnapshot), { code: "invalid_snapshot" });
    assert.throws(() => session.resume({
        ...snapshot,
        persist: [
            { kind: "intent", id: "dup", reason: "one" },
            { kind: "intent", id: "dup", reason: "two" },
        ],
    } as SessionSnapshot), { code: "invalid_snapshot" });
    assert.throws(() => session.resume({ ...snapshot, sessionId: "other" } as SessionSnapshot, { expectedSessionId: "s" }), { code: "scope_mismatch" });

    // A persist reference must belong to the snapshot's Session scope.
    const store = new WorkflowStore(() => now);
    const scoped = new SessionService(store);
    scoped.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    scoped.create({ id: "other", sessionId: "other", participants: ["user"] }, "host");
    scoped.activate("other", options(0));
    const otherTurn = new TurnService(store);
    const otherIntent = new IntentService(store);
    otherTurn.create({ id: "ot", sessionId: "other", classification: "new_intent" }, "host");
    otherTurn.interpret("ot", options(0));
    otherIntent.create({ id: "oi", sessionId: "other", originTurnId: "ot", text: "other scope" }, "host");
    scoped.activate("s", options(0));
    scoped.suspend("s", options(1));
    const crossScope = scoped.snapshot("s", now);
    assert.throws(() => scoped.resume({
        ...crossScope,
        persist: [{ kind: "intent", id: "oi", reason: "wrong session" }],
    }), { code: "scope_mismatch" });

    const live = suspendedPlain();
    const liveSnapshot = live.session.snapshot("s", now);
    live.session.resume(liveSnapshot, { now });
    assert.throws(() => live.session.resume({ ...liveSnapshot, version: liveSnapshot.version + 3 }), { code: "version_conflict" });
});

test("session: closeWithTurns refuses to close over an unfinished Turn with active_turns", () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    assert.throws(() => session.closeWithTurns("s"), { code: "active_turns" });
    assert.equal(session.get("s").state, "active");
    assert.equal(turn.get("t").state, "interpreting");
});

test("session: closeWithTurns(force) abandons unfinished Turns and records the reason", () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    const intent = new IntentService(store);
    intent.create({ id: "i", sessionId: "s", originTurnId: "t", text: "pending input" }, "host");
    const result = session.closeWithTurns("s", { force: true, forceReason: "operator shutdown", actor: "host" });
    assert.equal(result.session.state, "closed");
    assert.deepEqual(result.activeTurns.map(item => item.id), ["t"]);
    assert.equal(result.abandoned.length, 1);
    assert.equal(result.abandoned[0].state, "abandoned");
    assert.deepEqual(result.settledIntents, ["i"]);
    assert.equal(intent.get("i").state, "abandoned");
    const events = store.history().filter(event => event.entityKind === "turn" && event.entityId === "t");
    assert.equal(events.some(event => event.to === "abandoned" && event.reason === "operator shutdown"), true);
});

test("session: closeWithTurns(force) snapshots an acting Turn before abandoning it", () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    turn.act("t", options(1));
    const result = session.closeWithTurns("s", { force: true, forceReason: "host shutdown" });
    assert.equal(result.session.state, "closed");
    assert.equal(result.abandoned[0].state, "abandoned");
    assert.equal(result.abandoned[0].interruption?.state, "acting");
    assert.equal(result.abandoned[0].interruption?.reason, "host shutdown");
});

test("session: closeWithTurns closes cleanly when no Turn is unfinished", () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    const turn = new TurnService(store);
    session.create({ id: "s", sessionId: "s", participants: ["user"] }, "host");
    session.activate("s", options(0));
    turn.create({ id: "t", sessionId: "s", classification: "new_intent" }, "host");
    turn.interpret("t", options(0));
    turn.respond("t", options(1));
    turn.complete("t", options(2));
    const result = session.closeWithTurns("s", { reason: "all work done" });
    assert.equal(result.session.state, "closed");
    assert.equal(result.abandoned.length, 0);
    assert.equal(result.activeTurns.length, 0);
});

test("session: expireIfDue moves only due, expirable sessions to expired using the injected clock", () => {
    const store = new WorkflowStore(() => now);
    const session = new SessionService(store);
    session.create({ id: "s1", sessionId: "s1", participants: [], expiresAt: "2026-01-01T00:00:00Z" }, "host");
    session.activate("s1", options(0));
    session.create({ id: "s2", sessionId: "s2", participants: [], sessionType: "autonomous", expiresAt: "2027-01-01T00:00:00Z" }, "host");
    session.activate("s2", options(0));
    session.create({ id: "s3", sessionId: "s3", participants: [], expiresAt: "2026-01-01T00:00:00Z" }, "host");
    session.create({ id: "s4", sessionId: "s4", participants: [], expiresAt: "2026-01-01T00:00:00Z" }, "host");
    session.activate("s4", options(0));
    session.idle("s4", options(1));
    session.create({ id: "s5", sessionId: "s5", participants: [], expiresAt: "2026-01-01T00:00:00Z" }, "host");
    session.activate("s5", options(0));
    session.suspend("s5", options(1));
    const expired = session.expireIfDue("2026-06-01T00:00:00Z").map(item => item.id).sort();
    assert.deepEqual(expired, ["s1", "s4", "s5"]);
    assert.equal(session.get("s1").state, "expired");
    assert.equal(session.get("s2").state, "active");
    assert.equal(session.get("s3").state, "created");
    assert.deepEqual(session.expireIfDue(new Date("2027-06-01T00:00:00Z")).map(item => item.id), ["s2"]);
    assert.throws(() => session.activate("s1", options(1)), { code: "version_conflict" });
    assert.throws(() => session.activate("s1", options(2)), { code: "invalid_transition" });
    assert.throws(() => session.expireIfDue("not-a-date"), { code: "guard_rejected" });
});
