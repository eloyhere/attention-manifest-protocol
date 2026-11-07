import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AttentionObject } from "../attention/types.ts";
import type { ContextCheckpoint } from "../context/lifecycle.ts";
import { LifecycleRegistry } from "../entity/index.ts";
import type { EventRecord } from "../entity/types.ts";
import type { Evidence } from "../evidence/types.ts";
import { Project } from "../project/core.ts";
import type { ProjectRule } from "../project/types.ts";
import type { ReceiptCore } from "../receipt/types.ts";
import { Store } from "../service/store.ts";
import { openSqlite } from "../sql/index.ts";
import type { BudgetSnapshot } from "../tool/types.ts";
import { WorkflowStore } from "../workflow/store.ts";
import { initialWorkflowStates } from "../workflow/transitions.ts";
import type { ActionAttempt, WorkflowEntity, WorkflowKind, WorkflowSnapshot } from "../workflow/types.ts";
import {
    PersistenceError,
    WORKFLOW_KINDS,
    WorkflowPersistence,
    bindProject,
    listEntities,
    loadAttention,
    loadBudgetReservation,
    loadBudgetSnapshot,
    loadContextCheckpoint,
    loadEntity,
    loadEvidence,
    loadProjectRule,
    loadReceipt,
    persistAttention,
    persistBudgetReservation,
    persistBudgetSnapshot,
    persistContextCheckpoint,
    persistEntity,
    persistEvidence,
    persistProjectRule,
    persistReceipt,
    plainEntity,
    rehydrate,
    removeEntity,
    setEntityLifecycleRegistry,
    validateEventOrder,
} from "./index.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const DEADLINE = "2030-01-01T00:00:00.000Z";

function temporaryDatabase(): { readonly path: string; readonly dispose: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "amp-persistence-"));
    return {
        path: join(directory, "store.sqlite"),
        dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
}

function withDatabase(run: (path: string) => void): void {
    const database = temporaryDatabase();
    try {
        run(database.path);
    } finally {
        database.dispose();
    }
}

function openStore(path: string): Store {
    return Store.open({ path, now: () => NOW });
}

function codeOf(error: unknown): string | undefined {
    return error instanceof PersistenceError ? error.code : undefined;
}

function seed(persistence: WorkflowPersistence): void {
    persistence.create("session", { id: "s", sessionId: "s", participants: ["user"] });
    persistence.transition("session", "s", "active", { expectedVersion: 0, actor: "host" });
    persistence.create("turn", { id: "t", sessionId: "s", classification: "new_intent" });
    persistence.transition("turn", "t", "interpreting", { expectedVersion: 0, actor: "host" });
    persistence.create("intent", { id: "i", sessionId: "s", originTurnId: "t", text: "deliver the effect" });
    persistence.transition("intent", "i", "confirmed", { expectedVersion: 0, actor: "host" });
    persistence.transition("intent", "i", "accepted", { expectedVersion: 1, actor: "host" });
    persistence.create("mission", { id: "m", sessionId: "s", intentId: "i" });
    persistence.transition("mission", "m", "active", { expectedVersion: 0, actor: "host" });
    persistence.create("goal", {
        id: "g",
        sessionId: "s",
        missionId: "m",
        contractVersion: "v1",
        acceptanceCriteria: ["effect is verified"],
    });
    persistence.transition("goal", "g", "active", { expectedVersion: 0, actor: "host" });
    persistence.create("plan", {
        id: "p",
        sessionId: "s",
        goalId: "g",
        bounds: { maxAttempts: 2, deadline: DEADLINE, progressMetric: "accepted effects", deadLetterOwner: "operator" },
    });
    persistence.create("task", {
        id: "k",
        sessionId: "s",
        planId: "p",
        dependsOn: [],
        required: true,
        contractVersion: "v1",
        requiredEffects: ["effect"],
    });
    persistence.transition("plan", "p", "ready", { expectedVersion: 0, actor: "host" });
    persistence.transition("task", "k", "ready", { expectedVersion: 0, actor: "host" });
    persistence.create("action", {
        id: "a",
        sessionId: "s",
        taskId: "k",
        operationId: "op-1",
        effect: "effect",
        required: true,
        sideEffect: false,
        recovery: "idempotent",
    });
    persistence.transition("action", "a", "ready", { expectedVersion: 0, actor: "host" });
}

/** One execution attempt fact, keyed by `attemptId` rather than `id`. */
function attemptRecord(overrides: Partial<ActionAttempt> = {}): ActionAttempt {
    return {
        executionId: "exec-1",
        operationId: "op-1",
        attemptId: "attempt-1",
        actionId: "a",
        sessionId: "s",
        originTurnId: "t",
        cancellationEpoch: 0,
        version: 0,
        state: "running",
        startedAt: NOW,
        ...overrides,
    };
}

/**
 * Starts an attempt on the seeded action through the live kernel and mirrors
 * the action transition plus the attempt row into the store, exactly as the
 * persistence protocol requires for an attempt-bearing action.
 */
function startSeededAttempt(
    persistence: WorkflowPersistence,
    store: Store,
    attemptId = "attempt-1",
): ActionAttempt {
    // Execution requires an executing plan and an active task.
    if (persistence.workflow.get("plan", "p").state === "ready") {
        persistence.transition("plan", "p", "executing", { expectedVersion: 1, actor: "host" });
    }
    if (persistence.workflow.get("task", "k").state === "ready") {
        persistence.transition("task", "k", "active", { expectedVersion: 1, actor: "host" });
    }
    const started = persistence.workflow.startAttempt("a", {
        expectedVersion: 1,
        cancellationEpoch: 0,
        executionId: "exec-1",
        attemptId,
        actor: "host",
    });
    const action = persistence.workflow.get("action", "a");
    store.transaction((tx) => {
        persistEntity(tx, "action", action);
        tx.appendEvent("action.transitioned", { id: "a", from: "ready", to: action.state, version: action.version }, "a");
    });
    persistence.saveAttempt(started);
    return started;
}

/** Settles the running attempt and mirrors the resulting action version. */
function settleSeededAttempt(
    persistence: WorkflowPersistence,
    store: Store,
    attempt: ActionAttempt,
): ActionAttempt {
    const action = persistence.workflow.get("action", "a");
    const settled = persistence.workflow.settleAttempt(attempt.attemptId, {
        expectedVersion: attempt.version,
        expectedActionVersion: action.version,
        outcome: "succeeded",
        actor: "host",
    });
    const updated = persistence.workflow.get("action", "a");
    store.transaction((tx) => {
        persistEntity(tx, "action", updated);
        tx.appendEvent("action.transitioned", { id: "a", from: action.state, to: updated.state, version: updated.version }, "a");
    });
    persistence.saveAttempt(settled);
    return settled;
}

function evidenceRecord(id = "e1"): Evidence {
    return {
        id,
        tenantId: "tenant-1",
        dependsOn: [],
        claim: "the effect is observable",
        polarity: "supports",
        observationId: "o1",
        receiptId: "r1",
        verificationId: "v1",
        integrityVerificationId: "i1",
        criteriaVersion: "v1",
        environmentVersion: "env-1",
        createdAt: NOW,
        status: "active",
    };
}

function receiptRecord(id = "r1"): ReceiptCore {
    return {
        id,
        invocation: {
            id: "inv-1",
            context: {
                tenantId: "tenant-1",
                principalId: "user-1",
                agentId: "agent-1",
                sessionId: "s",
                operationId: "op-1",
                attemptId: "attempt-1",
                executionId: "exec-1",
                policyVersion: "policy-1",
                cancellationEpoch: 0,
            },
            toolId: "tool-1",
            arguments: null,
            createdAt: NOW,
        },
        observation: { id: "o1", invocationId: "inv-1", status: "success", observedAt: NOW },
        issuedAt: NOW,
        payloadDigest: "sha256:digest",
        hashAlgorithm: "sha256",
        lifecycle: "issued",
    };
}

function budgetSnapshot(): BudgetSnapshot {
    return {
        limit: { tokens: 100, milliseconds: 1_000 },
        settled: { tokens: 10, milliseconds: 5, calls: 1, bytes: 0 },
        reserved: { tokens: 20, milliseconds: 0, calls: 1, bytes: 0 },
    };
}

function attentionRecord(): AttentionObject {
    return {
        id: "attention-1",
        version: 2,
        summary: "persist me",
        pointer: { kind: "evidence", id: "e1", version: "1" },
        sources: [],
        references: { evidence: [], receipts: [], capabilities: [], behaviors: [] },
        scope: { tenantId: "tenant-1", principalId: "user-1", sessionId: "s", turnId: "t" },
        scores: { relevance: 0.9, urgency: 0.4, confidence: 0.8, importance: 0.7 },
        intensity: 0.6,
        mounted: true,
        budget: { tokens: 50 },
        expiresAt: DEADLINE,
        stale: false,
        createdAt: NOW,
        updatedAt: NOW,
        lastReason: "test fixture",
    };
}

function checkpointRecord(): ContextCheckpoint {
    return {
        id: "checkpoint-1",
        planId: "plan-1",
        through: 1,
        entryIds: ["entry-1"],
        digest: "digest-1",
        savedTokens: 12,
        summary: "compacted",
        createdAt: NOW,
        state: "committed",
        reason: "test fixture",
    };
}

function projectRuleRecord(): ProjectRule {
    return {
        id: "rule-1",
        tenantId: "tenant-1",
        rootId: "root-1",
        text: "always run the architecture check",
        version: 1,
        hash: "hash-1",
        updatedAt: NOW,
    };
}

test("8 workflow kinds create/transition and restore in a new store instance", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            seed(persistence);
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const workflow = new WorkflowStore(() => NOW);
            const persistence = new WorkflowPersistence({ store: reopened, workflow, now: () => NOW });
            const report = persistence.restoreAll();
            assert.deepEqual(report, { restored: 8, skipped: [], events: 17, attempts: 0 });
            assert.equal(persistence.workflow, workflow);
            assert.equal(workflow.get("session", "s").state, "active");
            const expected: Record<WorkflowKind, readonly [string, number]> = {
                session: ["s", 1],
                turn: ["t", 1],
                intent: ["i", 2],
                mission: ["m", 1],
                goal: ["g", 1],
                plan: ["p", 1],
                task: ["k", 1],
                action: ["a", 1],
            };
            for (const kind of WORKFLOW_KINDS) {
                const [id, version] = expected[kind];
                const restored = persistence.get(kind, id);
                assert.equal(restored.kind, kind);
                assert.equal(restored.version, version);
            }
            assert.equal(persistence.get("session", "s").state, "active");
            assert.equal(persistence.get("intent", "i").state, "accepted");
            assert.equal(persistence.get("task", "k").state, "ready");
            assert.equal(persistence.get("action", "a").state, "ready");
        } finally {
            reopened.close();
        }
    });
});

test("restored versions and states stay readable after a second process", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store: reopened, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const report = persistence.restoreAll();
            assert.equal(report.restored, 8);
            assert.deepEqual(persistence.list("session").map(entity => entity.id), ["s"]);
            assert.deepEqual(persistence.list("intent").map(entity => [entity.id, entity.version]), [["i", 2]]);
        } finally {
            reopened.close();
        }
    });
});

test("restoreAll is idempotent: no duplicate writes and no duplicate events", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const first = persistence.restoreAll();
            const stats = store.stats();
            const events = store.events().length;
            const second = persistence.restoreAll();
            assert.deepEqual(second, first);
            assert.equal(store.stats().entities, stats.entities);
            assert.equal(store.stats().events, stats.events);
            assert.equal(store.events().length, events);
        } finally {
            store.close();
        }
    });
});

test("get/list fall back to the store when the kernel starts empty", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
            const restarted = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            assert.equal(restarted.get("task", "k").state, "ready");
            assert.equal(restarted.list("session").length, 1);
            assert.equal(restarted.list("intent")[0]?.state, "accepted");
        } finally {
            store.close();
        }
    });
});

test("a transition after restore persists the next version", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store: reopened, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            persistence.restoreAll();
            const updated = persistence.transition("turn", "t", "acting", { expectedVersion: 1, actor: "host" });
            assert.equal(updated.state, "acting");
            assert.equal(updated.version, 2);
            const report = persistence.restoreAll();
            assert.equal(report.events, 18);
            assert.equal(persistence.get("turn", "t").state, "acting");
            assert.equal(persistence.get("turn", "t").version, 2);
        } finally {
            reopened.close();
        }
    });
});

test("workflow events use <kind>.created and <kind>.transitioned with exact payloads", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
            const events = store.events();
            const ids: Record<WorkflowKind, string> = {
                session: "s",
                turn: "t",
                intent: "i",
                mission: "m",
                goal: "g",
                plan: "p",
                task: "k",
                action: "a",
            };
            for (const kind of WORKFLOW_KINDS) {
                const created = events.filter(event => event.kind === `${kind}.created`);
                assert.equal(created.length, 1);
                assert.deepEqual(created[0]?.payload, { id: ids[kind], state: initialWorkflowStates[kind] });
            }
            const accepted = events.find((event) => {
                const payload = event.payload as { readonly version?: number } | null;
                return event.kind === "intent.transitioned" && payload?.version === 2;
            });
            assert.deepEqual(accepted?.payload, { id: "i", from: "confirmed", to: "accepted", version: 2 });
            const sequences = events.map(event => event.sequence);
            assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
        } finally {
            store.close();
        }
    });
});

test("transaction rollback leaves neither the entity nor its event", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            assert.throws(() => store.transaction((tx) => {
                persistEntity(tx, "evidence", evidenceRecord());
                tx.appendEvent("evidence.created", { id: "e1", state: "active" }, "e1");
                throw new Error("rollback");
            }), /rollback/);
            assert.equal(loadEntity(store, "evidence", "e1"), undefined);
            assert.equal(store.events().length, 0);
        } finally {
            store.close();
        }
    });
});

test("compare-and-swap rejects a stale expectedVersion and keeps the record", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistEntity(store, "evidence", evidenceRecord());
            const changed: Evidence = { ...evidenceRecord(), claim: "changed" };
            assert.throws(() => persistEntity(store, "evidence", changed, { expectedVersion: 9 }), /version_conflict/);
            const reloaded = loadEntity(store, "evidence", "e1");
            assert.ok(reloaded);
            assert.equal(plainEntity(reloaded).claim, evidenceRecord().claim);
        } finally {
            store.close();
        }
    });
});

test("corrupt entity payload is skipped while the remaining workflow restores", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
        } finally {
            store.close();
        }
        const raw = openSqlite({ path });
        try {
            raw.run({
                sql: "UPDATE entities SET payload = ? WHERE kind = ? AND id = ?",
                parameters: ["{not-json", "action", "a"],
            });
        } finally {
            raw.close();
        }
        const reopened = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store: reopened, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const report = persistence.restoreAll();
            assert.equal(report.restored, 7);
            assert.equal(report.events, 15);
            assert.deepEqual(report.skipped, ["action:a"]);
            assert.equal(persistence.get("task", "k").state, "ready");
            assert.throws(() => persistence.get("action", "a"), (error) => codeOf(error) === "corrupt_payload");
        } finally {
            reopened.close();
        }
    });
});

test("corrupt payload in a parent cascades to dependents without crashing", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
        } finally {
            store.close();
        }
        const raw = openSqlite({ path });
        try {
            raw.run({
                sql: "UPDATE entities SET payload = ? WHERE kind = ? AND id = ?",
                parameters: ["{not-json", "task", "k"],
            });
        } finally {
            raw.close();
        }
        const reopened = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store: reopened, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const report = persistence.restoreAll();
            assert.equal(report.restored, 6);
            assert.equal(report.events, 13);
            assert.deepEqual(report.skipped, ["task:k", "action:a"]);
            assert.equal(persistence.get("plan", "p").state, "ready");
        } finally {
            reopened.close();
        }
    });
});

test("re-created identity restores from its latest created event", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const first = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            first.create("session", { id: "s", sessionId: "s", participants: ["user"] });
            assert.equal(removeEntity(store, "session", "s"), true);
            const second = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            second.create("session", { id: "s", sessionId: "s", participants: ["user"] });
            const report = second.restoreAll();
            assert.deepEqual(report, { restored: 1, skipped: [], events: 1, attempts: 0 });
            assert.equal(second.get("session", "s").state, "created");
        } finally {
            store.close();
        }
    });
});

test("two Store instances over one database return the same proxy identity", () => {
    withDatabase((path) => {
        const first = openStore(path);
        const second = openStore(path);
        try {
            const saved = persistEntity(first, "evidence", evidenceRecord());
            const loaded = loadEntity(second, "evidence", "e1");
            assert.equal(saved, loaded);
            const updated = persistEntity(second, "evidence", { ...evidenceRecord(), claim: "updated" });
            assert.equal(saved, updated);
            assert.equal(plainEntity(updated).claim, "updated");
            assert.deepEqual(listEntities(second, "evidence").map(entity => entity.id), ["e1"]);
            assert.equal(removeEntity(second, "evidence", "e1"), true);
            assert.equal(loadEntity(second, "evidence", "e1"), undefined);
        } finally {
            first.close();
            second.close();
        }
    });
});

test("evidence round-trips through the store", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistEvidence(store, evidenceRecord());
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const loaded = loadEvidence(reopened, "e1");
            assert.ok(loaded);
            assert.deepEqual(plainEntity(loaded), evidenceRecord());
        } finally {
            reopened.close();
        }
    });
});

test("receipt round-trips through the store", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistReceipt(store, receiptRecord());
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const loaded = loadReceipt(reopened, "r1");
            assert.ok(loaded);
            assert.deepEqual(plainEntity(loaded), receiptRecord());
        } finally {
            reopened.close();
        }
    });
});

test("budget ledger snapshot and reservation round-trip", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistBudgetSnapshot(store, "tenant-1:root-1", budgetSnapshot());
            persistBudgetReservation(store, {
                id: "reservation-1",
                budgetKey: "tenant-1:root-1",
                amount: { tokens: 20 },
                state: "reserved",
            });
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            assert.deepEqual(plainEntity(loadBudgetSnapshot(reopened, "tenant-1:root-1")), {
                id: "tenant-1:root-1",
                budgetKey: "tenant-1:root-1",
                ...budgetSnapshot(),
            });
            assert.deepEqual(plainEntity(loadBudgetReservation(reopened, "reservation-1")), {
                id: "reservation-1",
                budgetKey: "tenant-1:root-1",
                amount: { tokens: 20 },
                state: "reserved",
            });
        } finally {
            reopened.close();
        }
    });
});

test("attention object round-trips through the store", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistAttention(store, attentionRecord());
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const loaded = loadAttention(reopened, "attention-1");
            assert.ok(loaded);
            assert.deepEqual(plainEntity(loaded), attentionRecord());
        } finally {
            reopened.close();
        }
    });
});

test("context checkpoint round-trips through the store", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistContextCheckpoint(store, checkpointRecord());
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const loaded = loadContextCheckpoint(reopened, "checkpoint-1");
            assert.ok(loaded);
            assert.deepEqual(plainEntity(loaded), checkpointRecord());
        } finally {
            reopened.close();
        }
    });
});

test("project rule round-trips through the store", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            persistProjectRule(store, projectRuleRecord());
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const loaded = loadProjectRule(reopened, "rule-1");
            assert.ok(loaded);
            assert.deepEqual(plainEntity(loaded), projectRuleRecord());
        } finally {
            reopened.close();
        }
    });
});

test("lifecycle hooks fire in persist/load/update/remove order", () => {
    withDatabase((path) => {
        const calls: string[] = [];
        const hooks = {
            prePersist: () => calls.push("prePersist"),
            postPersist: () => calls.push("postPersist"),
            preUpdate: () => calls.push("preUpdate"),
            postUpdate: () => calls.push("postUpdate"),
            preRemove: () => calls.push("preRemove"),
            postRemove: () => calls.push("postRemove"),
            postLoad: () => calls.push("postLoad"),
        };
        setEntityLifecycleRegistry(new LifecycleRegistry({ evidence: hooks }));
        const store = openStore(path);
        try {
            persistEntity(store, "evidence", evidenceRecord());
            loadEntity(store, "evidence", "e1");
            persistEntity(store, "evidence", { ...evidenceRecord(), claim: "updated" });
            removeEntity(store, "evidence", "e1");
        } finally {
            store.close();
            setEntityLifecycleRegistry();
        }
        assert.deepEqual(calls, [
            "prePersist", "postPersist",
            "postLoad",
            "preUpdate", "postUpdate",
            "preRemove", "postRemove",
        ]);
    });
});

test("restoreSnapshot reports schema, sequence and duplicate conflicts", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const empty: WorkflowSnapshot = {
                schemaVersion: 1,
                sequence: 0,
                cancellationEpoch: 0,
                entities: [],
                attempts: [],
                events: [],
            };
            assert.deepEqual(persistence.restoreSnapshot(empty), { restored: 0, skipped: [], events: 0, attempts: 0 });
            assert.throws(
                () => persistence.restoreSnapshot({ ...empty, schemaVersion: 2 as unknown as 1 }),
                (error) => codeOf(error) === "schema_version",
            );
            assert.throws(
                () => persistence.restoreSnapshot({ ...empty, sequence: 1 }),
                (error) => codeOf(error) === "sequence_mismatch",
            );
            const duplicate = { kind: "session", id: "s" } as unknown as WorkflowEntity;
            assert.throws(
                () => persistence.restoreSnapshot({ ...empty, entities: [duplicate, duplicate] }),
                (error) => codeOf(error) === "duplicate_entity",
            );
        } finally {
            store.close();
        }
    });
});

test("rehydrate returns a RestoreReport and validates monotonic event order", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            seed(new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW }));
            const target = new WorkflowStore(() => NOW);
            const report = rehydrate(store, target, { now: () => NOW });
            assert.equal(report.restored, 8);
            assert.equal(report.events, 17);
            assert.equal(report.attempts, 0);
            assert.deepEqual(report.skipped, []);
            assert.equal(target.get("task", "k").state, "ready");
            const outOfOrder: EventRecord[] = [
                { sequence: 2, kind: "session.created", recordedAt: NOW, payload: { id: "s" } },
                { sequence: 1, kind: "session.created", recordedAt: NOW, payload: { id: "s" } },
            ];
            assert.throws(() => validateEventOrder(outOfOrder), (error) => codeOf(error) === "sequence_mismatch");
        } finally {
            store.close();
        }
    });
});

test("action attempts persist as action_attempt rows and name their events", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const running = attemptRecord();
            persistence.saveAttempt(running);
            assert.deepEqual(plainEntity(loadEntity(store, "action_attempt", "attempt-1")), running);
            assert.equal(store.events().length, 0);

            persistence.persistAttempt(running);
            const settled = attemptRecord({ state: "succeeded", version: 1, settledAt: NOW });
            persistence.persistAttempt(settled, { from: "running" });

            assert.deepEqual(plainEntity(loadEntity(store, "action_attempt", "attempt-1")), settled);
            const events = store.events();
            assert.deepEqual(events.map(event => event.kind), ["action_attempt.created", "action_attempt.transitioned"]);
            assert.deepEqual(events[0]?.payload, { id: "attempt-1", state: "running" });
            assert.deepEqual(events[1]?.payload, { id: "attempt-1", from: "running", to: "succeeded", version: 1 });
        } finally {
            store.close();
        }
    });
});

test("restoreAll rebuilds attempts and keeps the action that references them", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            seed(persistence);
            settleSeededAttempt(persistence, store, startSeededAttempt(persistence, store));
        } finally {
            store.close();
        }
        const reopened = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store: reopened, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const report = persistence.restoreAll();
            assert.equal(report.restored, 8);
            assert.equal(report.attempts, 1);
            assert.deepEqual(report.skipped, []);
            const action = persistence.get("action", "a");
            assert.equal(action.state, "succeeded");
            assert.deepEqual(action.attemptIds, ["attempt-1"]);
            const attempt = persistence.workflow.getAttempt("attempt-1");
            assert.equal(attempt.state, "succeeded");
            assert.equal(attempt.version, 1);
            assert.equal(attempt.settledAt, NOW);
        } finally {
            reopened.close();
        }
    });
});

test("restoreAll tolerates a legacy database with a missing attempt row", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            seed(persistence);
            settleSeededAttempt(persistence, store, startSeededAttempt(persistence, store));
        } finally {
            store.close();
        }
        // Simulate a database written before `action_attempt` existed.
        const raw = openSqlite({ path });
        try {
            raw.run({
                sql: "DELETE FROM entities WHERE kind = ? AND id = ?",
                parameters: ["action_attempt", "attempt-1"],
            });
        } finally {
            raw.close();
        }
        const reopened = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store: reopened, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            const report = persistence.restoreAll();
            assert.equal(report.restored, 8);
            assert.equal(report.attempts, 0);
            assert.deepEqual(report.skipped, ["attempt:attempt-1"]);
            const action = persistence.get("action", "a");
            assert.equal(action.state, "succeeded");
            assert.deepEqual(action.attemptIds, []);
            assert.throws(() => persistence.workflow.getAttempt("attempt-1"), /does not exist/);
        } finally {
            reopened.close();
        }
    });
});

test("action_attempt rows coexist with binding-managed project facts", () => {
    withDatabase((path) => {
        const store = openStore(path);
        try {
            const persistence = new WorkflowPersistence({ store, workflow: new WorkflowStore(() => NOW), now: () => NOW });
            seed(persistence);
            startSeededAttempt(persistence, store);
            const project = new Project({ tenantId: "tenant-1", rootId: "root-1", clock: () => NOW });
            const binding = bindProject(store, project);
            binding.putRule({
                id: "rule-1",
                tenantId: "tenant-1",
                rootId: "root-1",
                text: "attempts and bindings share the store",
            });

            const report = persistence.restoreAll();
            assert.equal(report.restored, 8);
            assert.equal(report.attempts, 1);
            assert.deepEqual(report.skipped, []);
            assert.equal(persistence.workflow.getAttempt("attempt-1").state, "running");

            const storedRule = loadProjectRule(store, "rule-1");
            assert.ok(storedRule);
            assert.equal(plainEntity(storedRule).text, "attempts and bindings share the store");
            const restoredProject = new Project({ tenantId: "tenant-1", rootId: "root-1", clock: () => NOW });
            const restoredBinding = bindProject(store, restoredProject);
            restoredBinding.rehydrate();
            assert.equal(restoredProject.getRule("rule-1")?.text, "attempts and bindings share the store");
        } finally {
            store.close();
        }
    });
});
