import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createKernel } from "./kernel.ts";
import { KernelPersistence } from "./persistence.ts";
import type { Kernel, KernelOptions, KernelOverrides, SettleActionResult } from "./types.ts";
import type { Acceptance, ActionAttempt, Task } from "../workflow/types.ts";
import type { KernelTaskInput } from "./types.ts";
import { WorkflowPersistence } from "../persistence/workflow.ts";
import { removeEntity } from "../persistence/mappers.ts";
import { Store } from "../service/store.ts";
import { WorkflowStore } from "../workflow/store.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

interface Harness {
    readonly kernel: Kernel;
    readonly directory: string;
    readonly path: string;
    cleanup(): void;
}

function makeClock(): () => string {
    let tick = 0;
    return () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString();
}

function harness(options: Partial<KernelOptions> = {}, overrides: KernelOverrides = {}): Harness {
    const directory = mkdtempSync(join(tmpdir(), "amp-kernel-"));
    const path = join(directory, "store.sqlite");
    const kernel = createKernel({
        tenantId: "tenant",
        rootId: "root",
        storePath: path,
        clock: makeClock(),
        ...options,
    }, overrides);
    return {
        kernel,
        directory,
        path,
        cleanup: () => {
            kernel.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

interface ChainIds {
    readonly session: string;
    readonly turn: string;
    readonly intent: string;
    readonly mission: string;
    readonly goal: string;
    readonly plan: string;
    readonly task: string;
    readonly action: string;
}

function chainIds(suffix = ""): ChainIds {
    return {
        session: `session${suffix}`,
        turn: `turn${suffix}`,
        intent: `intent${suffix}`,
        mission: `mission${suffix}`,
        goal: `goal${suffix}`,
        plan: `plan${suffix}`,
        task: `task${suffix}`,
        action: `action${suffix}`,
    };
}

function bounds() {
    return {
        maxAttempts: 3,
        deadline: "2030-01-01T00:00:00.000Z",
        progressMetric: "accepted effects",
        deadLetterOwner: "operator",
    } as const;
}

interface Prepared {
    readonly ids: ChainIds;
    readonly tasks: readonly Task[];
}

function prepare(
    kernel: Kernel,
    suffix = "",
    declarations?: (ids: ChainIds) => readonly KernelTaskInput[],
): Prepared {
    const ids = chainIds(suffix);
    const flow = kernel.flow;
    flow.startSession({ sessionId: ids.session, participants: ["user"] });
    flow.beginTurn({ turnId: ids.turn, sessionId: ids.session });
    flow.captureIntent({ intentId: ids.intent, turnId: ids.turn, text: "deliver the effect" });
    flow.confirmIntent({ intentId: ids.intent });
    flow.createMission({ missionId: ids.mission, intentId: ids.intent });
    flow.createGoal({
        goalId: ids.goal,
        missionId: ids.mission,
        contractVersion: "v1",
        acceptanceCriteria: ["effect observed"],
    });
    const plan = flow.createPlan({
        planId: ids.plan,
        goalId: ids.goal,
        bounds: bounds(),
        tasks: declarations?.(ids) ?? [{ taskId: ids.task, contractVersion: "v1", requiredEffects: ["effect"] }],
    });
    assert.equal(plan.plan.state, "draft");
    const ready = flow.readyTasks({ planId: ids.plan });
    assert.equal(ready.plan.state, "executing");
    return { ids, tasks: ready.tasks };
}

async function runAction(kernel: Kernel, ids: ChainIds): Promise<SettleActionResult> {
    const started = await kernel.flow.startAction({
        actionId: ids.action,
        taskId: ids.task,
        operationId: `operation-${ids.action}`,
        effect: "effect",
        originTurnId: ids.turn,
        budget: { calls: 1 },
    });
    assert.equal(started.action.state, "running");
    assert.equal(started.attempt.state, "running");
    return kernel.flow.settleAction({
        actionId: ids.action,
        observation: { status: "success", value: { ok: true } },
        usage: { calls: 1 },
    });
}

function acceptanceOf(settled: SettleActionResult): Acceptance {
    const evidence = settled.evidence;
    assert.ok(evidence !== undefined);
    return {
        valid: true,
        contractVersion: "v1",
        verificationId: settled.verification.id,
        evidenceIds: [evidence.id],
    };
}

async function runChain(kernel: Kernel, suffix = "") {
    const prepared = prepare(kernel, suffix);
    const settled = await runAction(kernel, prepared.ids);
    const achieved = kernel.flow.achieveGoal({
        goalId: prepared.ids.goal,
        acceptance: acceptanceOf(settled),
    });
    const closed = kernel.flow.closeSession({ sessionId: prepared.ids.session });
    return { prepared, settled, achieved, closed };
}

/**
 * Seeds the same eight-aggregate chain entirely through the independent
 * `src/persistence` layer, so a test can prove that `createKernel` restores
 * facts it never wrote.
 */
function seedPersistence(persistence: WorkflowPersistence, planTasks: readonly string[] = ["k"]): void {
    persistence.create("session", { id: "s", sessionId: "s", participants: ["user"] });
    persistence.transition("session", "s", "active", { expectedVersion: 0, actor: "host" });
    persistence.create("turn", { id: "t", sessionId: "s", classification: "new_intent" });
    persistence.transition("turn", "t", "interpreting", { expectedVersion: 0, actor: "host" });
    persistence.create("intent", { id: "i", sessionId: "s", originTurnId: "t", text: "deliver the effect" });
    persistence.transition("intent", "i", "confirmed", { expectedVersion: 0, actor: "host" });
    persistence.transition("intent", "i", "accepted", { expectedVersion: 1, actor: "host" });
    persistence.create("mission", { id: "m", sessionId: "s", intentId: "i" });
    persistence.transition("mission", "m", "proposed", { expectedVersion: 0, actor: "host" });
    persistence.transition("mission", "m", "active", { expectedVersion: 1, actor: "host" });
    persistence.create("goal", {
        id: "g",
        sessionId: "s",
        missionId: "m",
        contractVersion: "v1",
        acceptanceCriteria: ["effect is verified"],
    });
    persistence.transition("goal", "g", "proposed", { expectedVersion: 0, actor: "host" });
    persistence.transition("goal", "g", "active", { expectedVersion: 1, actor: "host" });
    persistence.create("plan", { id: "p", sessionId: "s", goalId: "g", bounds: bounds() });
    for (const taskId of planTasks) {
        persistence.create("task", {
            id: taskId,
            sessionId: "s",
            planId: "p",
            dependsOn: [],
            required: true,
            contractVersion: "v1",
            requiredEffects: ["effect"],
        });
    }
    persistence.transition("plan", "p", "ready", { expectedVersion: 0, actor: "host" });
    persistence.transition("task", "k", "ready", { expectedVersion: 0, actor: "host" });
    persistence.create("action", {
        id: "a",
        sessionId: "s",
        taskId: "k",
        operationId: "op-1",
        effect: "effect",
        required: true,
        sideEffect: true,
        recovery: "query",
    });
    persistence.transition("action", "a", "ready", { expectedVersion: 0, actor: "host" });
}

/** `<kind>:<state>` label of one unified event, used for order assertions. */
function eventLabel(kind: string, payload: unknown): string {
    const record = payload as { readonly state?: unknown; readonly to?: unknown } | null;
    const state = kind.endsWith(".created") ? record?.state : record?.to;
    return `${kind}:${String(state)}`;
}

function assertCode(expected: string): (error: unknown) => true {
    return (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, expected);
        return true;
    };
}

function assertOrder(kinds: readonly string[], expected: readonly string[]): void {
    let cursor = -1;
    for (const name of expected) {
        const index = kinds.findIndex((kind, position) => position > cursor && kind === name);
        assert.notEqual(index, -1, `missing or out-of-order event ${name} in ${kinds.join(", ")}`);
        cursor = index;
    }
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

test("the full eight-level chain runs once and closes the session", async () => {
    const fixture = harness();
    try {
        const { prepared, settled, achieved, closed } = await runChain(fixture.kernel);
        const { ids } = prepared;
        assert.equal(settled.action.state, "succeeded");
        assert.equal(settled.attempt.state, "succeeded");
        assert.equal(settled.verification.status, "semantic_verified");
        assert.equal(settled.evidence?.status, "active");
        assert.equal(settled.task?.state, "completed");
        assert.equal(settled.plan?.state, "completed");
        assert.equal(achieved.goal.state, "achieved");
        assert.equal(achieved.goal.validity, "valid");
        assert.equal(achieved.mission?.state, "achieved");
        assert.equal(achieved.intent?.state, "fulfilled");
        assert.equal(closed.session.state, "closed");
        assert.equal(fixture.kernel.ports.workflow.get("task", ids.task).state, "completed");
        assert.equal(fixture.kernel.ports.workflow.get("plan", ids.plan).state, "completed");
        const snapshot = fixture.kernel.snapshot();
        assert.equal(snapshot.counts.session, 1);
        assert.equal(snapshot.counts.action, 1);
        assert.equal(snapshot.evidenceCount, 1);
        assert.equal(snapshot.receiptCount, 1);
        assert.equal(snapshot.budget.settled.calls, 1);
        assert.equal(snapshot.budget.reserved.calls, 0);
    } finally {
        fixture.cleanup();
    }
});

test("persisted aggregates and workflow audit reload through createKernel", async () => {
    const fixture = harness();
    const ids = chainIds();
    try {
        await runChain(fixture.kernel);
        fixture.kernel.close();
        const reopened = createKernel({
            tenantId: "tenant",
            rootId: "root",
            storePath: fixture.path,
            clock: makeClock(),
        });
        try {
            const flow = reopened.ports.workflow;
            assert.equal(flow.get("session", ids.session).state, "closed");
            assert.equal(flow.get("intent", ids.intent).state, "fulfilled");
            assert.equal(flow.get("mission", ids.mission).state, "achieved");
            assert.equal(flow.get("goal", ids.goal).state, "achieved");
            assert.equal(flow.get("plan", ids.plan).state, "completed");
            assert.equal(flow.get("task", ids.task).state, "completed");
            assert.equal(flow.get("action", ids.action).state, "succeeded");
            const attempt = flow.getAttempt(`${ids.action}:attempt:1`);
            assert.equal(attempt.state, "succeeded");
            const snapshot = reopened.snapshot();
            assert.equal(snapshot.evidenceCount, 1);
            assert.equal(snapshot.receiptCount, 1);
            assert.equal(snapshot.budget.settled.calls, 1);
            assert.equal(snapshot.budget.reserved.calls, 0);
            assert.equal(snapshot.workflowEvents, flow.history().length);
        } finally {
            reopened.close();
        }
    } finally {
        fixture.cleanup();
    }
});

test("store events use the unified <kind>.<phase> envelope in execution order", async () => {
    const fixture = harness();
    try {
        await runChain(fixture.kernel);
        const events = fixture.kernel.store.events();
        for (const event of events) {
            assert.match(event.kind, /^[a-z_]+\.(created|transitioned)$/);
        }
        const labels = events.map(event => eventLabel(event.kind, event.payload));
        assertOrder(labels, [
            "session.created:created",
            "session.transitioned:active",
            "turn.created:received",
            "turn.transitioned:interpreting",
            "intent.created:captured",
            "intent.transitioned:confirmed",
            "intent.transitioned:accepted",
            "mission.created:accepted",
            "mission.transitioned:proposed",
            "mission.transitioned:active",
            "goal.created:pending",
            "goal.transitioned:proposed",
            "goal.transitioned:active",
            "plan.created:draft",
            "task.created:pending",
            "plan.transitioned:approved",
            "plan.transitioned:executing",
            "task.transitioned:ready",
            "budget_ledger.created:created",
            "action.created:declared",
            "action.transitioned:ready",
            "task.transitioned:active",
            "action.transitioned:running",
            "action.transitioned:succeeded",
            "budget_ledger.transitioned:settled",
            "receipt.created:created",
            "receipt_integrity.created:created",
            "verification.created:created",
            "evidence.created:created",
            "task.transitioned:completed",
            "plan.transitioned:completed",
            "goal.transitioned:achieved",
            "mission.transitioned:achieved",
            "intent.transitioned:delegated",
            "intent.transitioned:fulfilled",
            "turn.transitioned:acting",
            "turn.transitioned:responding",
            "turn.transitioned:completed",
            "session.transitioned:closing",
            "session.transitioned:closed",
        ]);
        assert.equal(labels.includes("budget_ledger.created:created"), true);
        assert.equal(labels.includes("budget_ledger.transitioned:settled"), true);
        assert.equal(labels.includes("receipt_integrity.created:created"), true);
    } finally {
        fixture.cleanup();
    }
});

test("startAction reserves budget and settleAction settles the same reservation", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        const started = await fixture.kernel.flow.startAction({
            actionId: ids.action,
            taskId: ids.task,
            operationId: `operation-${ids.action}`,
            effect: "effect",
            budget: { calls: 1 },
        });
        assert.equal(started.reservation.state, "reserved");
        let budget = fixture.kernel.snapshot().budget;
        assert.equal(budget.reserved.calls, 1);
        assert.equal(budget.settled.calls, 0);
        await fixture.kernel.flow.settleAction({
            actionId: ids.action,
            observation: { status: "success" },
            usage: { calls: 1 },
        });
        budget = fixture.kernel.snapshot().budget;
        assert.equal(budget.reserved.calls, 0);
        assert.equal(budget.settled.calls, 1);
        const record = fixture.kernel.store.resolve<{
            readonly budgetKey: string;
            readonly reservations: readonly { readonly id: string; readonly state: string }[];
        }>("budget_ledger", "tenant:root");
        assert.equal(record.budgetKey, "tenant:root");
        assert.deepEqual(record.reservations.map(item => [item.id, item.state]), [[`operation-${ids.action}`, "settled"]]);
    } finally {
        fixture.cleanup();
    }
});

test("a budget limit rejects startAction before any aggregate is persisted", async () => {
    const fixture = harness({ budgetLimits: { calls: 0 } });
    try {
        const { ids } = prepare(fixture.kernel);
        await assert.rejects(
            fixture.kernel.flow.startAction({
                actionId: ids.action,
                taskId: ids.task,
                operationId: `operation-${ids.action}`,
                effect: "effect",
            }),
            assertCode("limit_exceeded"),
        );
        assert.equal(fixture.kernel.ports.workflow.list("action", ids.session).length, 0);
        assert.equal(fixture.kernel.store.list("action").length, 0);
        const budget = fixture.kernel.snapshot().budget;
        assert.equal(budget.reserved.calls, 0);
        assert.equal(budget.settled.calls, 0);
    } finally {
        fixture.cleanup();
    }
});

test("an executor failure releases the reservation and records a failed action", async () => {
    const fixture = harness({}, {
        executor: {
            execute: () => {
                throw new Error("tool crashed");
            },
        },
    });
    try {
        const { ids } = prepare(fixture.kernel);
        await assert.rejects(
            fixture.kernel.flow.startAction({
                actionId: ids.action,
                taskId: ids.task,
                operationId: `operation-${ids.action}`,
                effect: "effect",
            }),
            assertCode("execution_failed"),
        );
        const action = fixture.kernel.ports.workflow.get("action", ids.action);
        assert.equal(action.state, "failed");
        assert.equal(fixture.kernel.ports.workflow.getAttempt(`${ids.action}:attempt:1`).state, "failed");
        const budget = fixture.kernel.snapshot().budget;
        assert.equal(budget.reserved.calls, 0);
        assert.equal(budget.settled.calls, 0);
        assert.equal(fixture.kernel.store.list("action").length, 1);
        fixture.kernel.close();
        const reopened = createKernel({
            tenantId: "tenant",
            rootId: "root",
            storePath: fixture.path,
            clock: makeClock(),
        });
        try {
            assert.equal(reopened.ports.workflow.get("action", ids.action).state, "failed");
            assert.equal(reopened.ports.workflow.getAttempt(`${ids.action}:attempt:1`).state, "failed");
        } finally {
            reopened.close();
        }
    } finally {
        fixture.cleanup();
    }
});

test("achieveGoal requires a current verification plus existing evidence", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        const settled = await runAction(fixture.kernel, ids);
        const flow = fixture.kernel.flow;
        assert.throws(
            () => flow.achieveGoal({
                goalId: ids.goal,
                acceptance: {
                    valid: true,
                    contractVersion: "v1",
                    verificationId: "verification:missing",
                    evidenceIds: ["evidence:missing"],
                },
            }),
            assertCode("verification_required"),
        );
        assert.throws(
            () => flow.achieveGoal({
                goalId: ids.goal,
                acceptance: { valid: false, contractVersion: "v1", verificationId: settled.verification.id, evidenceIds: [] },
            }),
            assertCode("verification_required"),
        );
        const achieved = flow.achieveGoal({ goalId: ids.goal, acceptance: acceptanceOf(settled) });
        assert.equal(achieved.goal.state, "achieved");
        assert.equal(achieved.goal.validity, "valid");
    } finally {
        fixture.cleanup();
    }
});

test("repeated flow calls are idempotent and return the persisted aggregate", async () => {
    const fixture = harness();
    try {
        const ids = chainIds();
        const flow = fixture.kernel.flow;
        const session = flow.startSession({ sessionId: ids.session, participants: ["user"] });
        assert.equal(flow.startSession({ sessionId: ids.session, participants: ["user"] }).id, session.id);
        flow.beginTurn({ turnId: ids.turn, sessionId: ids.session });
        assert.equal(flow.beginTurn({ turnId: ids.turn, sessionId: ids.session }).state, "interpreting");
        flow.captureIntent({ intentId: ids.intent, turnId: ids.turn, text: "deliver" });
        assert.equal(flow.captureIntent({ intentId: ids.intent, turnId: ids.turn, text: "deliver" }).state, "captured");
        assert.equal(flow.confirmIntent({ intentId: ids.intent }).state, "accepted");
        assert.equal(flow.confirmIntent({ intentId: ids.intent }).state, "accepted");
        flow.createMission({ missionId: ids.mission, intentId: ids.intent });
        assert.equal(flow.createMission({ missionId: ids.mission, intentId: ids.intent }).state, "active");
        flow.createGoal({ goalId: ids.goal, missionId: ids.mission, contractVersion: "v1", acceptanceCriteria: ["effect observed"] });
        flow.createGoal({ goalId: ids.goal, missionId: ids.mission, contractVersion: "v1", acceptanceCriteria: ["effect observed"] });
        flow.createPlan({
            planId: ids.plan,
            goalId: ids.goal,
            bounds: bounds(),
            tasks: [{ taskId: ids.task, contractVersion: "v1", requiredEffects: ["effect"] }],
        });
        assert.equal(flow.createPlan({ planId: ids.plan, goalId: ids.goal, bounds: bounds(), tasks: [] }).tasks.length, 1);
        const firstReady = flow.readyTasks({ planId: ids.plan });
        const secondReady = flow.readyTasks({ planId: ids.plan });
        assert.equal(firstReady.ready.length, 1);
        assert.equal(secondReady.ready.length, 0);
        const started = await flow.startAction({
            actionId: ids.action,
            taskId: ids.task,
            operationId: `operation-${ids.action}`,
            effect: "effect",
        });
        const repeatedStart = await flow.startAction({
            actionId: ids.action,
            taskId: ids.task,
            operationId: `operation-${ids.action}`,
            effect: "effect",
        });
        assert.equal(repeatedStart.attempt.attemptId, started.attempt.attemptId);
        assert.equal(repeatedStart.invoked, false);
        const settled = await flow.settleAction({ actionId: ids.action, observation: { status: "success" }, usage: { calls: 1 } });
        const repeatedSettle = await flow.settleAction({ actionId: ids.action, observation: { status: "success" }, usage: { calls: 1 } });
        assert.equal(repeatedSettle.receipt.id, settled.receipt.id);
        assert.equal(repeatedSettle.verification.id, settled.verification.id);
        assert.equal(repeatedSettle.evidence?.id, settled.evidence?.id);
        const snapshot = fixture.kernel.snapshot();
        assert.equal(snapshot.counts.session, 1);
        assert.equal(snapshot.counts.turn, 1);
        assert.equal(snapshot.counts.action, 1);
        assert.equal(snapshot.evidenceCount, 1);
        assert.equal(snapshot.receiptCount, 1);
        const closed = flow.closeSession({ sessionId: ids.session });
        assert.equal(closed.session.state, "closed");
        assert.equal(flow.closeSession({ sessionId: ids.session }).session.state, "closed");
    } finally {
        fixture.cleanup();
    }
});

test("a stale expectedVersion fails with a stable version_conflict", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        assert.throws(
            () => fixture.kernel.flow.readyTasks({ planId: ids.plan, expectedVersion: 99 }),
            assertCode("version_conflict"),
        );
        assert.throws(
            () => fixture.kernel.flow.confirmIntent({ intentId: ids.intent, expectedVersion: 99 }),
            assertCode("version_conflict"),
        );
        await assert.rejects(
            fixture.kernel.flow.startAction({
                actionId: ids.action,
                taskId: ids.task,
                operationId: `operation-${ids.action}`,
                effect: "effect",
                expectedTaskVersion: 99,
            }),
            assertCode("version_conflict"),
        );
        assert.equal(fixture.kernel.ports.workflow.list("action", ids.session).length, 0);
    } finally {
        fixture.cleanup();
    }
});

test("compileTurnContext mounts attention and persists a context checkpoint", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        const task = fixture.kernel.ports.workflow.get("task", ids.task);
        const result = fixture.kernel.flow.compileTurnContext({
            turnId: ids.turn,
            principalId: "principal",
            budget: { tokens: 4096 },
            create: [{
                id: "attention:1",
                summary: "focus on the ready task",
                pointer: { kind: "task", id: ids.task, version: String(task.version) },
                scope: { tenantId: "tenant", principalId: "principal", sessionId: ids.session, turnId: ids.turn },
                scores: { relevance: 1, urgency: 0.5, confidence: 1, importance: 1 },
                budget: { tokens: 1024, bytes: 4096 },
                expiresAt: "2030-01-01T00:00:00.000Z",
                reason: "route",
            }],
        });
        assert.equal(result.compiled.items.length, 1);
        assert.equal(result.compiled.items[0]?.id, "attention:1");
        assert.equal(result.compiled.exclusions.length, 0);
        assert.equal(result.checkpoint.id, `context:${ids.turn}`);
        assert.deepEqual(result.checkpoint.itemIds, ["attention:1"]);
        const stored = fixture.kernel.store.resolve<{ readonly id: string; readonly itemIds: readonly string[]; readonly version: number }>(
            "context_checkpoint",
            `context:${ids.turn}`,
        );
        assert.deepEqual(stored.itemIds, ["attention:1"]);
        assert.equal(stored.version, 1);
        assert.equal(fixture.kernel.store.list("attention").length, 1);
        assert.equal(fixture.kernel.store.events({ kind: "context_checkpoint.created" }).length, 1);
        const again = fixture.kernel.flow.compileTurnContext({
            turnId: ids.turn,
            principalId: "principal",
            budget: { tokens: 4096 },
        });
        assert.equal(again.checkpoint.version, 2);
    } finally {
        fixture.cleanup();
    }
});

test("snapshot reports entities, budget and provenance counters", async () => {
    const fixture = harness();
    try {
        await runChain(fixture.kernel);
        const snapshot = fixture.kernel.snapshot();
        assert.equal(snapshot.entities.length, 8);
        assert.deepEqual(snapshot.counts, {
            session: 1, turn: 1, intent: 1, mission: 1, goal: 1, plan: 1, task: 1, action: 1,
        });
        assert.equal(snapshot.receiptCount, 1);
        assert.equal(snapshot.verificationCount, 1);
        assert.equal(snapshot.evidenceCount, 1);
        assert.equal(snapshot.store.events > 0, true);
        assert.equal(snapshot.store.entities >= 12, true);
        assert.equal(snapshot.workflowEvents > 0, true);
    } finally {
        fixture.cleanup();
    }
});

test("close is idempotent and every flow call fails with kernel_closed afterwards", async () => {
    const fixture = harness();
    try {
        await runChain(fixture.kernel);
        fixture.kernel.close();
        assert.doesNotThrow(() => fixture.kernel.close());
        assert.throws(() => fixture.kernel.snapshot(), assertCode("kernel_closed"));
        assert.throws(() => fixture.kernel.flow.startSession({ sessionId: "late" }), assertCode("kernel_closed"));
        await assert.rejects(
            fixture.kernel.flow.startAction({ actionId: "late", taskId: "late", operationId: "late", effect: "late" }),
            assertCode("kernel_closed"),
        );
    } finally {
        fixture.cleanup();
    }
});

test("storePath defaults to the hidden directory and accepts an explicit directory", () => {
    const original = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "amp-kernel-default-"));
    try {
        process.chdir(directory);
        const defaultKernel = createKernel({ tenantId: "tenant", rootId: "root", clock: makeClock() });
        try {
            assert.equal(defaultKernel.store.path, join(directory, ".attention-manifest-protocol", "store.sqlite"));
        } finally {
            defaultKernel.close();
        }
    } finally {
        process.chdir(original);
        rmSync(directory, { recursive: true, force: true });
    }
    const explicitDirectory = mkdtempSync(join(tmpdir(), "amp-kernel-dir-"));
    try {
        const explicitKernel = createKernel({ tenantId: "tenant", rootId: "root", storePath: explicitDirectory });
        try {
            assert.equal(explicitKernel.store.path, join(explicitDirectory, "store.sqlite"));
        } finally {
            explicitKernel.close();
        }
    } finally {
        rmSync(explicitDirectory, { recursive: true, force: true });
    }
});

test("dependent tasks become ready in DAG order and complete their plan", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel, "-dag", prefix => [
            { taskId: `${prefix.task}-1`, contractVersion: "v1", requiredEffects: ["effect"] },
            { taskId: `${prefix.task}-2`, dependsOn: [`${prefix.task}-1`], contractVersion: "v1", requiredEffects: ["effect"] },
        ]);
        const first = `${ids.task}-1`;
        const second = `${ids.task}-2`;
        assert.deepEqual(ids && fixture.kernel.ports.workflow.list("task", ids.session).map(task => [task.id, task.state]), [
            [first, "ready"],
            [second, "pending"],
        ]);
        const firstSettled = await (async () => {
            await fixture.kernel.flow.startAction({
                actionId: `${ids.action}-1`,
                taskId: first,
                operationId: `operation-${ids.action}-1`,
                effect: "effect",
            });
            return fixture.kernel.flow.settleAction({
                actionId: `${ids.action}-1`,
                observation: { status: "success" },
                usage: { calls: 1 },
            });
        })();
        assert.equal(firstSettled.task?.state, "completed");
        assert.equal(firstSettled.plan, undefined);
        assert.equal(fixture.kernel.ports.workflow.get("plan", ids.plan).state, "executing");
        const secondReady = fixture.kernel.flow.readyTasks({ planId: ids.plan });
        assert.deepEqual(secondReady.ready.map(task => task.id), [second]);
        await fixture.kernel.flow.startAction({
            actionId: `${ids.action}-2`,
            taskId: second,
            operationId: `operation-${ids.action}-2`,
            effect: "effect",
        });
        const secondSettled = await fixture.kernel.flow.settleAction({
            actionId: `${ids.action}-2`,
            observation: { status: "success" },
            usage: { calls: 1 },
        });
        assert.equal(secondSettled.task?.state, "completed");
        assert.equal(secondSettled.plan?.state, "completed");
        assert.equal(fixture.kernel.snapshot().budget.settled.calls, 2);
    } finally {
        fixture.cleanup();
    }
});

test("closeSession abandons open business work before closing", () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        const closed = fixture.kernel.flow.closeSession({ sessionId: ids.session });
        assert.equal(closed.session.state, "closed");
        assert.equal(fixture.kernel.ports.workflow.get("mission", ids.mission).state, "cancelled");
        assert.equal(fixture.kernel.ports.workflow.get("goal", ids.goal).state, "cancelled");
        assert.equal(fixture.kernel.ports.workflow.get("plan", ids.plan).state, "cancelled");
        assert.equal(fixture.kernel.ports.workflow.get("task", ids.task).state, "cancelled");
        assert.equal(fixture.kernel.ports.workflow.get("turn", ids.turn).state, "completed");
        assert.ok(closed.cancelled.length >= 4);
        assert.equal(fixture.kernel.snapshot().budget.settled.calls, 0);
    } finally {
        fixture.cleanup();
    }
});

test("recordReceipt, verifyBusiness and recordEvidence compose idempotently", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        await fixture.kernel.flow.startAction({
            actionId: ids.action,
            taskId: ids.task,
            operationId: `operation-${ids.action}`,
            effect: "effect",
        });
        const flow = fixture.kernel.flow;
        const receipt = flow.recordReceipt({
            receiptId: `receipt:manual`,
            actionId: ids.action,
            observation: { status: "success", value: { manual: true } },
        });
        assert.equal(flow.recordReceipt({
            receiptId: `receipt:manual`,
            actionId: ids.action,
            observation: { status: "success", value: { manual: true } },
        }).id, receipt.id);
        const verified = await flow.verifyBusiness({
            receiptId: receipt.id,
            criteriaVersion: "v1",
            claims: ["effect"],
        });
        assert.equal(verified.verification.status, "semantic_verified");
        assert.equal(verified.integrity.status, "integrity_verified");
        const repeated = await flow.verifyBusiness({
            receiptId: receipt.id,
            criteriaVersion: "v1",
            claims: ["effect"],
        });
        assert.equal(repeated.verification.id, verified.verification.id);
        const evidence = await flow.recordEvidence({
            evidenceId: "evidence:manual",
            receiptId: receipt.id,
            verificationId: verified.verification.id,
            claim: "effect",
        });
        assert.equal(evidence.status, "active");
        const repeatedEvidence = await flow.recordEvidence({
            evidenceId: "evidence:manual",
            receiptId: receipt.id,
            verificationId: verified.verification.id,
            claim: "effect",
        });
        assert.equal(repeatedEvidence.id, evidence.id);
        const settled = await flow.settleAction({
            actionId: ids.action,
            observation: { status: "success" },
            usage: { calls: 1 },
        });
        const achieved = flow.achieveGoal({
            goalId: ids.goal,
            acceptance: {
                valid: true,
                contractVersion: "v1",
                verificationId: verified.verification.id,
                evidenceIds: [evidence.id],
            },
        });
        assert.equal(achieved.goal.state, "achieved");
        assert.equal(settled.action.state, "succeeded");
        flow.closeSession({ sessionId: ids.session });
    } finally {
        fixture.cleanup();
    }
});

/* ------------------------------------------------------------------ */
/* Shared persistence protocol                                        */
/* ------------------------------------------------------------------ */

test("kernel-written workflow facts restore through WorkflowPersistence.restoreAll", () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        const written = fixture.kernel.ports.workflow.snapshot();
        fixture.kernel.close();
        const store = Store.open({ path: fixture.path, now: makeClock() });
        try {
            const workflow = new WorkflowStore(makeClock());
            const persistence = new WorkflowPersistence({ store, workflow, now: makeClock() });
            const report = persistence.restoreAll();
            assert.deepEqual(report, { restored: 7, skipped: [], events: written.sequence, attempts: 0 });
            assert.equal(persistence.workflow, workflow);
            assert.equal(workflow.get("session", ids.session).state, "active");
            assert.equal(workflow.get("turn", ids.turn).state, "interpreting");
            assert.equal(workflow.get("intent", ids.intent).state, "accepted");
            assert.equal(workflow.get("intent", ids.intent).version, 2);
            assert.equal(workflow.get("mission", ids.mission).state, "active");
            assert.equal(workflow.get("goal", ids.goal).state, "active");
            assert.equal(workflow.get("plan", ids.plan).state, "executing");
            assert.equal(workflow.get("task", ids.task).state, "ready");
            assert.equal(workflow.get("task", ids.task).version, 1);
        } finally {
            store.close();
        }
    } finally {
        fixture.cleanup();
    }
});

test("kernel restart restores settled attempts through restoreAll", async () => {
    const fixture = harness();
    try {
        await runChain(fixture.kernel);
        fixture.kernel.close();
        const store = Store.open({ path: fixture.path, now: makeClock() });
        try {
            const persistence = new KernelPersistence(store, "tenant", makeClock());
            const workflow = persistence.restoreWorkflow(makeClock());
            const report = persistence.restoreReport;
            assert.ok(report);
            assert.equal(report.path, "restoreAll");
            assert.deepEqual(report.skipped, []);
            assert.equal(report.restored, 8);
            assert.equal(report.attempts, 1);
            const stored = persistence.find<ActionAttempt>("action_attempt", "action:attempt:1");
            assert.ok(stored);
            assert.equal(stored.state, "succeeded");
            const action = workflow.get("action", "action");
            assert.equal(action.state, "succeeded");
            assert.deepEqual(action.attemptIds, ["action:attempt:1"]);
            assert.equal(workflow.getAttempt("action:attempt:1").state, "succeeded");
        } finally {
            store.close();
        }
    } finally {
        fixture.cleanup();
    }
});

test("kernel restart keeps a running attempt attached to its action", async () => {
    const fixture = harness();
    try {
        const { ids } = prepare(fixture.kernel);
        const started = await fixture.kernel.flow.startAction({
            actionId: ids.action,
            taskId: ids.task,
            operationId: `operation-${ids.action}`,
            effect: "effect",
            originTurnId: ids.turn,
            budget: { calls: 1 },
        });
        assert.equal(started.action.state, "running");
        assert.equal(started.attempt.state, "running");
        fixture.kernel.close();
        const reopened = createKernel({
            tenantId: "tenant",
            rootId: "root",
            storePath: fixture.path,
            clock: makeClock(),
        });
        try {
            const workflow = reopened.ports.workflow;
            const action = workflow.get("action", ids.action);
            assert.equal(action.state, "running");
            assert.deepEqual(action.attemptIds, ["action:attempt:1"]);
            assert.equal(workflow.getAttempt("action:attempt:1").state, "running");
            assert.equal(workflow.getAttempt("action:attempt:1").version, 0);
        } finally {
            reopened.close();
        }
    } finally {
        fixture.cleanup();
    }
});

test("a legacy journal without action_attempt rows still restores attempts through the fallback", async () => {
    const fixture = harness();
    try {
        await runChain(fixture.kernel);
        fixture.kernel.close();
        const store = Store.open({ path: fixture.path, now: makeClock() });
        try {
            assert.equal(removeEntity(store, "action_attempt", "action:attempt:1"), true);
        } finally {
            store.close();
        }
        const reopened = Store.open({ path: fixture.path, now: makeClock() });
        try {
            const persistence = new KernelPersistence(reopened, "tenant", makeClock());
            const workflow = persistence.restoreWorkflow(makeClock());
            const report = persistence.restoreReport;
            assert.ok(report);
            assert.equal(report.path, "fallback");
            assert.equal(report.primary?.attempts, 0);
            assert.ok(report.skipped.includes("attempt:action:attempt:1"));
            assert.equal(report.attempts, 1);
            const action = workflow.get("action", "action");
            assert.equal(action.state, "succeeded");
            assert.deepEqual(action.attemptIds, ["action:attempt:1"]);
            assert.equal(workflow.getAttempt("action:attempt:1").state, "succeeded");
        } finally {
            reopened.close();
        }
    } finally {
        fixture.cleanup();
    }
});

test("workflow facts written by WorkflowPersistence restore through createKernel", () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-kernel-shared-"));
    const path = join(directory, "store.sqlite");
    try {
        const store = Store.open({ path, now: makeClock() });
        try {
            seedPersistence(new WorkflowPersistence({ store, workflow: new WorkflowStore(makeClock()), now: makeClock() }));
        } finally {
            store.close();
        }
        const reader = Store.open({ path, now: makeClock() });
        try {
            const persistence = new KernelPersistence(reader, "tenant", makeClock());
            persistence.restoreWorkflow(makeClock());
            assert.equal(persistence.restoreReport?.path, "restoreAll");
            assert.deepEqual(persistence.restoreReport?.skipped, []);
        } finally {
            reader.close();
        }
        const kernel = createKernel({ tenantId: "tenant", rootId: "root", storePath: path, clock: makeClock() });
        try {
            const workflow = kernel.ports.workflow;
            assert.equal(workflow.get("session", "s").state, "active");
            assert.equal(workflow.get("intent", "i").state, "accepted");
            assert.equal(workflow.get("mission", "m").state, "active");
            assert.equal(workflow.get("goal", "g").state, "active");
            assert.equal(workflow.get("plan", "p").state, "ready");
            assert.equal(workflow.get("task", "k").state, "ready");
            assert.equal(workflow.get("action", "a").state, "ready");
            const resumed = kernel.flow.readyTasks({ planId: "p" });
            assert.equal(resumed.plan.state, "executing");
            assert.equal(kernel.snapshot().counts.action, 1);
        } finally {
            kernel.close();
        }
        const combined = Store.open({ path, now: makeClock() });
        try {
            const persistence = new WorkflowPersistence({
                store: combined,
                workflow: new WorkflowStore(makeClock()),
                now: makeClock(),
            });
            const report = persistence.restoreAll();
            assert.deepEqual(report, { restored: 8, skipped: [], events: 20, attempts: 0 });
            assert.equal(persistence.get("plan", "p").state, "executing");
            assert.equal(persistence.get("plan", "p").version, 2);
            assert.equal(persistence.get("task", "k").state, "ready");
            assert.equal(persistence.get("action", "a").state, "ready");
        } finally {
            combined.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("mixed-layer journals with cancellation restore through the kernel fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "amp-kernel-mixed-"));
    const path = join(directory, "store.sqlite");
    try {
        const store = Store.open({ path, now: makeClock() });
        try {
            seedPersistence(
                new WorkflowPersistence({ store, workflow: new WorkflowStore(makeClock()), now: makeClock() }),
                ["k", "k2"],
            );
        } finally {
            store.close();
        }
        const kernel = createKernel({ tenantId: "tenant", rootId: "root", storePath: path, clock: makeClock() });
        try {
            const flow = kernel.flow;
            flow.readyTasks({ planId: "p" });
            await flow.startAction({
                actionId: "a2",
                taskId: "k",
                operationId: "op-2",
                effect: "effect",
            });
            await flow.settleAction({
                actionId: "a2",
                observation: { status: "success" },
                usage: { calls: 1 },
            });
            const closed = flow.closeSession({ sessionId: "s" });
            assert.equal(closed.session.state, "closed");
        } finally {
            kernel.close();
        }
        const reopened = createKernel({ tenantId: "tenant", rootId: "root", storePath: path, clock: makeClock() });
        try {
            const workflow = reopened.ports.workflow;
            assert.equal(workflow.get("session", "s").state, "closed");
            assert.equal(workflow.get("plan", "p").state, "cancelled");
            assert.equal(workflow.get("task", "k").state, "cancelled");
            assert.equal(workflow.get("task", "k2").state, "cancelled");
            assert.equal(workflow.get("action", "a").state, "cancelled");
            assert.equal(workflow.get("action", "a2").state, "succeeded");
            assert.equal(workflow.getAttempt("a2:attempt:1").state, "succeeded");
            assert.ok(workflow.get("plan", "p").cancellationEpoch > 0);
            const latest = new Map<string, number>();
            for (const event of workflow.history()) {
                const key = `${event.entityKind}:${event.entityId}`;
                const previous = latest.get(key);
                if (previous !== undefined) {
                    assert.ok(event.cancellationEpoch >= previous, `${key} epoch regressed`);
                }
                latest.set(key, event.cancellationEpoch);
            }
        } finally {
            reopened.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
