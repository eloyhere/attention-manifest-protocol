import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflowSelfTest } from "./selfTest.ts";
import { WorkflowStore } from "./store.ts";
import { WorkflowError } from "./types.ts";
import type { WorkflowSnapshot } from "./types.ts";

test("workflow lifecycle guards, cancellation, unknown effects and cross-Turn execution", () => {
    const result = runWorkflowSelfTest();
    assert.ok(result.passed >= 20);
    assert.equal(result.passed, result.checks.length);
});

const fixture = (): WorkflowStore => {
    const store = new WorkflowStore(() => "2026-01-01T00:00:00Z");
    store.create("session", { id: "s", sessionId: "s", participants: ["user"] }, "host");
    store.transition("session", "s", "active", { actor: "host", expectedVersion: 0 });
    store.create("turn", { id: "t", sessionId: "s", classification: "new_intent" }, "host");
    store.transition("turn", "t", "interpreting", { actor: "host", expectedVersion: 0 });
    store.create("intent", { id: "i", sessionId: "s", originTurnId: "t", text: "test" }, "host");
    store.transition("intent", "i", "confirmed", { actor: "host", expectedVersion: 0 });
    store.transition("intent", "i", "accepted", { actor: "host", expectedVersion: 1 });
    store.create("mission", { id: "m", sessionId: "s", intentId: "i" }, "host");
    return store;
};

test("snapshot/restore round trips pure state without invoking the clock or commands", () => {
    const store = fixture();
    store.requestCancel("mission", "m", { actor: "user", expectedVersion: 0 });
    const snapshot = JSON.parse(JSON.stringify(store.snapshot())) as WorkflowSnapshot;
    const restored = WorkflowStore.restore(snapshot, () => { throw new Error("restore must not read clock"); });
    assert.deepEqual(restored.snapshot(), snapshot);
    const detached = store.snapshot() as unknown as { entities: unknown[] };
    detached.entities.length = 0;
    assert.notEqual(store.snapshot().entities.length, 0);
    assert.throws(() => restored.transition("mission", "m", "draining", { actor: "host", expectedVersion: 0 }), { code: "version_conflict" });
});

test("restore rejects corrupt references, versions, epochs, states and audit chains", () => {
    const snapshot = fixture().snapshot();
    const corruptions: ((value: any) => void)[] = [
        value => { value.entities.find((entity: any) => entity.kind === "mission").intentId = "missing"; },
        value => { value.entities[0].version = -1; },
        value => { value.entities[0].version++; },
        value => { value.entities[0].cancellationEpoch = 99; },
        value => { value.cancellationEpoch = -1; },
        value => { value.entities[0].state = "invented"; },
        value => { value.events[1].expectedVersion = 19; },
        value => { value.entities.push(value.entities[0]); },
        value => { value.sequence++; },
    ];
    for (const corrupt of corruptions) {
        const broken = structuredClone(snapshot);
        corrupt(broken);
        assert.throws(() => WorkflowStore.restore(broken), (error: unknown) => error instanceof WorkflowError && error.code === "invalid_snapshot");
    }
});

test("cancel actor is validated before changing epochs or state", () => {
    const store = fixture();
    const before = store.snapshot();
    assert.throws(() => store.requestCancel("mission", "m", { actor: "", expectedVersion: 0 }), { code: "guard_rejected" });
    assert.deepEqual(store.snapshot(), before);
});

test("settled optional Action failure permits verified Task success and Session closure", () => {
    const store = fixture();
    const move = (kind: "mission" | "goal" | "plan" | "task" | "action", id: string, to: any): void => {
        store.transition(kind, id, to, { actor: "host", expectedVersion: store.get(kind, id).version, cancellationEpoch: 0,
            acceptance: { valid: true, contractVersion: "v1", verificationId: "v", evidenceIds: ["e"] } });
    };
    move("mission", "m", "active");
    store.create("goal", { id: "g", sessionId: "s", missionId: "m", contractVersion: "v1", acceptanceCriteria: ["accept optional failure"] }, "host");
    move("goal", "g", "active");
    store.create("plan", { id: "p", sessionId: "s", goalId: "g", bounds: { maxAttempts: 1, deadline: "2027-01-01T00:00:00Z", progressMetric: "verified", deadLetterOwner: "operator" } }, "host");
    store.create("task", { id: "k", sessionId: "s", planId: "p", dependsOn: [], required: true, contractVersion: "v1", requiredEffects: [] }, "host");
    move("plan", "p", "ready"); move("plan", "p", "running");
    move("task", "k", "ready"); move("task", "k", "running");
    store.create("action", { id: "a", sessionId: "s", taskId: "k", operationId: "op", effect: "optional", required: false, sideEffect: false, recovery: "idempotent" }, "host");
    move("action", "a", "ready");
    store.startAttempt("a", { actor: "executor", expectedVersion: 1, cancellationEpoch: 0, executionId: "exec", attemptId: "attempt" });
    store.settleAttempt("attempt", { actor: "executor", expectedVersion: 0, expectedActionVersion: 2, outcome: "failed" });
    move("task", "k", "succeeded"); move("plan", "p", "completed"); move("goal", "g", "achieved"); move("mission", "m", "achieved");
    store.transition("turn", "t", "responding", { actor: "host", expectedVersion: 1 });
    store.transition("turn", "t", "completed", { actor: "host", expectedVersion: 2 });
    store.transition("session", "s", "closing", { actor: "host", expectedVersion: 1 });
    store.transition("session", "s", "closed", { actor: "host", expectedVersion: 2 });
    assert.equal(store.get("session", "s").state, "closed");
    assert.deepEqual(WorkflowStore.restore(store.snapshot()).snapshot(), store.snapshot());
});

test("accepted Intent and drained Mission permit Session closure", () => {
    const store = fixture();
    store.requestCancel("mission", "m", { actor: "user", expectedVersion: 0 });
    store.transition("mission", "m", "draining", { actor: "host", expectedVersion: 1 });
    store.transition("mission", "m", "cancelled", { actor: "host", expectedVersion: 2 });
    store.transition("turn", "t", "responding", { actor: "host", expectedVersion: 1 });
    store.transition("turn", "t", "completed", { actor: "host", expectedVersion: 2 });
    store.transition("session", "s", "closing", { actor: "host", expectedVersion: 1 });
    store.transition("session", "s", "closed", { actor: "host", expectedVersion: 2 });
    assert.equal(store.get("session", "s").state, "closed");
    assert.deepEqual(WorkflowStore.restore(store.snapshot()).snapshot(), store.snapshot());
});
