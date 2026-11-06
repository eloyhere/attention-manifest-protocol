import { WorkflowStore } from "./store.ts";
import { WorkflowError } from "./types.ts";
import type { Acceptance, WorkflowEntities, WorkflowErrorCode, WorkflowKind } from "./types.ts";

/** Run with Node >=24: node --input-type=module -e "import('./src/workflow.ts').then(m => console.log(m.runWorkflowSelfTest()))" */
export function runWorkflowSelfTest(): { passed: number; checks: readonly string[] } {
    const checks: string[] = [];
    const check = (name: string, condition: boolean): void => {
        if (!condition) throw new Error(`Workflow self-test failed: ${name}`);
        checks.push(name);
    };
    const rejects = (name: string, code: WorkflowErrorCode, action: () => unknown): void => {
        try { action(); } catch (error) {
            if (error instanceof WorkflowError && error.code === code) { checks.push(name); return; }
            throw error;
        }
        throw new Error(`Workflow self-test expected ${code}: ${name}`);
    };
    const acceptance: Acceptance = { contractVersion: "v1", valid: true, verificationId: "verification-1", evidenceIds: ["evidence-1"] };
    const setup = (): WorkflowStore => {
        const store = new WorkflowStore(() => "2026-01-01T00:00:00.000Z");
        store.create("session", { id: "s", sessionId: "s", participants: ["user"] }, "host");
        store.transition("session", "s", "active", { expectedVersion: 0, actor: "host" });
        store.create("turn", { id: "t", sessionId: "s", classification: "new_intent" }, "host");
        store.transition("turn", "t", "interpreting", { expectedVersion: 0, actor: "host" });
        store.create("intent", { id: "i", sessionId: "s", originTurnId: "t", text: "Deliver required effect" }, "host");
        store.transition("intent", "i", "confirmed", { expectedVersion: 0, actor: "user" });
        store.transition("intent", "i", "accepted", { expectedVersion: 1, actor: "host" });
        store.create("mission", { id: "m", sessionId: "s", originTurnId: "t", intentId: "i" }, "host");
        store.transition("mission", "m", "active", { expectedVersion: 0, actor: "host" });
        store.create("goal", { id: "g", sessionId: "s", missionId: "m", contractVersion: "v1", acceptanceCriteria: ["Effect verified"] }, "host");
        store.transition("goal", "g", "active", { expectedVersion: 0, actor: "host" });
        store.create("plan", { id: "p", sessionId: "s", goalId: "g", bounds: { maxAttempts: 2, deadline: "2027-01-01T00:00:00Z", progressMetric: "accepted effects", deadLetterOwner: "operator" } }, "host");
        store.create("task", { id: "k", sessionId: "s", planId: "p", dependsOn: [], required: true, requiredEffects: ["effect"], contractVersion: "v1" }, "host");
        store.transition("plan", "p", "ready", { expectedVersion: 0, actor: "host" });
        store.transition("plan", "p", "running", { expectedVersion: 1, actor: "host" });
        store.transition("task", "k", "ready", { expectedVersion: 0, actor: "host" });
        store.transition("task", "k", "running", { expectedVersion: 1, actor: "host" });
        store.create("action", { id: "a", sessionId: "s", originTurnId: "t", taskId: "k", operationId: "operation-1", effect: "effect", required: true, sideEffect: true, recovery: "query" }, "host");
        store.transition("action", "a", "ready", { expectedVersion: 0, actor: "host" });
        return store;
    };
    const move = <K extends WorkflowKind>(store: WorkflowStore, kind: K, id: string, state: WorkflowEntities[K]["state"], extra: { acceptance?: Acceptance; cancellationEpoch?: number } = {}): void => {
        store.transition(kind, id, state, { expectedVersion: store.get(kind, id).version, actor: "host", ...extra });
    };
    const start = (store: WorkflowStore): void => {
        store.startAttempt("a", { expectedVersion: store.get("action", "a").version, cancellationEpoch: 0, executionId: "exec-1", attemptId: "attempt-1", actor: "executor" });
    };
    const clarification = setup();
    clarification.create("turn", { id: "clarify", sessionId: "s", classification: "new_intent", continuationKey: "continuation-1" }, "host");
    move(clarification, "turn", "clarify", "interpreting");
    move(clarification, "turn", "clarify", "clarifying");
    rejects("Clarification cannot resume without matching linkage", "guard_rejected", () => move(clarification, "turn", "clarify", "interpreting"));
    clarification.transition("turn", "clarify", "interpreting", { expectedVersion: clarification.get("turn", "clarify").version, actor: "host", clarification: { replyTo: "clarify", continuationKey: "continuation-1" } });
    check("Clarification resumes its original Turn explicitly", clarification.get("turn", "clarify").state === "interpreting");
    const normal = setup();
    rejects("stale entity versions rejected", "version_conflict", () => normal.transition("action", "a", "running", { expectedVersion: 0, actor: "host" }));
    rejects("direct action success rejected", "guard_rejected", () => move(normal, "action", "a", "running"));
    start(normal);
    move(normal, "turn", "t", "responding");
    move(normal, "turn", "t", "completed");
    check("Turn completion preserves running execution", normal.getAttempt("attempt-1").state === "running");
    normal.create("turn", { id: "t2", sessionId: "s", classification: "status" }, "host");
    normal.settleAttempt("attempt-1", { expectedVersion: 0, expectedActionVersion: normal.get("action", "a").version, outcome: "succeeded", observedInTurnId: "t2", actor: "executor" });
    const attempt = normal.getAttempt("attempt-1");
    check("execution origin and observation Turns are independent", attempt.originTurnId === "t" && attempt.observedInTurnId === "t2");
    check("operation ID remains on execution fact", attempt.operationId === "operation-1");
    rejects("Action success alone cannot complete Task", "guard_rejected", () => move(normal, "task", "k", "succeeded", { cancellationEpoch: 0 }));
    move(normal, "task", "k", "succeeded", { cancellationEpoch: 0, acceptance });
    move(normal, "plan", "p", "completed", { cancellationEpoch: 0 });
    rejects("Goal requires independent acceptance", "guard_rejected", () => move(normal, "goal", "g", "achieved", { cancellationEpoch: 0 }));
    move(normal, "goal", "g", "achieved", { cancellationEpoch: 0, acceptance });
    move(normal, "mission", "m", "achieved", { cancellationEpoch: 0 });
    const oldGoal = normal.get("goal", "g");
    normal.invalidateGoal("g", { expectedVersion: oldGoal.version, actor: "evidence", reason: "Evidence revoked" });
    check("Goal invalidation retains achieved history", normal.get("goal", "g").state === "achieved" && normal.get("goal", "g").validity === "invalidated" && normal.get("goal", "g").achievedAt === oldGoal.achievedAt);
    normal.create("plan", { id: "correction", sessionId: "s", goalId: "g", bounds: { maxAttempts: 1, deadline: "2027-01-01T00:00:00Z", progressMetric: "corrected evidence", deadLetterOwner: "operator" } }, "host");
    normal.attachCorrectivePlan("g", "correction", { expectedVersion: normal.get("goal", "g").version, actor: "host" });
    rejects("Revalidation waits for corrective Plan", "guard_rejected", () => normal.revalidateGoal("g", { expectedVersion: normal.get("goal", "g").version, actor: "verifier", acceptance }));
    move(normal, "plan", "correction", "ready");
    move(normal, "plan", "correction", "running");
    move(normal, "plan", "correction", "completed", { cancellationEpoch: 0 });
    normal.revalidateGoal("g", { expectedVersion: normal.get("goal", "g").version, actor: "verifier", acceptance });
    check("Correction revalidates without erasing achievement history", normal.get("goal", "g").validity === "valid" && normal.get("goal", "g").achievedAt === oldGoal.achievedAt);
    const snapshot = normal.get("goal", "g");
    (snapshot.acceptanceCriteria as string[]).push("tampered");
    check("Snapshots cannot mutate state", normal.get("goal", "g").acceptanceCriteria.length === 1);
    check("Events use contiguous ordered sequence", normal.history().every((event, index) => event.sequence === index + 1));

    const cancelled = setup();
    start(cancelled);
    cancelled.requestCancel("mission", "m", { expectedVersion: cancelled.get("mission", "m").version, actor: "user" });
    check("Cancellation propagates to Plan and Action", cancelled.get("plan", "p").state === "cancel_requested" && cancelled.get("action", "a").state === "cancel_requested");
    rejects("Old cancellation epoch rejected at commit gate", "stale_epoch", () => cancelled.assertExecutionAllowed("a", 0));
    move(cancelled, "action", "a", "draining");
    rejects("Cannot cancel before executing attempt drains", "unsettled_work", () => move(cancelled, "action", "a", "cancelled"));
    cancelled.settleAttempt("attempt-1", { expectedVersion: 0, expectedActionVersion: cancelled.get("action", "a").version, outcome: "succeeded", actor: "executor" });
    check("Late success preserved as completed_after_cancel", cancelled.get("action", "a").state === "completed_after_cancel");
    for (const [kind, id] of [["task", "k"], ["plan", "p"], ["goal", "g"], ["mission", "m"]] as const) {
        move(cancelled, kind, id, "draining");
        move(cancelled, kind, id, "cancelled");
    }
    check("Cancellation drains bottom-up", cancelled.get("mission", "m").state === "cancelled");

    const unknown = setup();
    start(unknown);
    unknown.settleAttempt("attempt-1", { expectedVersion: 0, expectedActionVersion: unknown.get("action", "a").version, outcome: "unknown_outcome", actor: "executor" });
    rejects("Unknown outcomes cannot use ordinary retry", "invalid_transition", () => move(unknown, "action", "a", "ready"));
    rejects("Task cannot commit unknown effects", "unsettled_work", () => move(unknown, "task", "k", "succeeded", { cancellationEpoch: 0, acceptance }));
    move(unknown, "action", "a", "reconciling");
    unknown.reconcileAction("a", { expectedVersion: unknown.get("action", "a").version, expectedAttemptVersion: 1, outcome: "failed", reconciliationRef: "query-confirmed-no-effect", actor: "operator" });
    move(unknown, "action", "a", "ready");
    const retry = unknown.startAttempt("a", { expectedVersion: unknown.get("action", "a").version, cancellationEpoch: 0, executionId: "exec-2", attemptId: "attempt-2", actor: "executor" });
    check("Retry retains operation and changes attempt", retry.operationId === "operation-1" && retry.attemptId === "attempt-2");
    rejects("Frozen Plan DAG rejects new tasks", "guard_rejected", () => unknown.create("task", { id: "late", sessionId: "s", planId: "p", dependsOn: [], required: false, contractVersion: "v1", requiredEffects: [] }, "host"));
    rejects("Required Task cannot be skipped", "invalid_transition", () => move(unknown, "task", "k", "skipped"));
    rejects("Session cannot close unsettled work", "guard_rejected", () => {
        move(unknown, "session", "s", "closing");
        move(unknown, "session", "s", "closed");
    });
    for (const [name, store] of [["achieved Goal with correction", normal], ["cancelled hierarchy and late result", cancelled], ["running retry after unknown outcome", unknown]] as const) {
        const snapshot = store.snapshot();
        const restored = WorkflowStore.restore(snapshot, () => { throw new Error("Pure restore must not read clock"); });
        check(`Pure snapshot/restore preserves ${name}`, JSON.stringify(restored.snapshot()) === JSON.stringify(snapshot));
    }
    return { passed: checks.length, checks };
}
