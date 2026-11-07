import { Optional, SynchronousOrderedCollectable, SynchronousOrderedMap, SynchronousUnorderedMap } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import {
    initialWorkflowStates, isActionExecutingState, isPlanExecutingState, isTaskActiveState, isTaskCompletedState,
    isWorkflowSettled, isWorkflowTerminal, workflowTransitions,
} from "./transitions.ts";
import { WorkflowError } from "./types.ts";
import type { Acceptance, Action, ActionAttempt, CreateEntity, Goal, Task, TransitionOptions, WorkflowEntities, WorkflowEntity, WorkflowEvent, WorkflowKind, WorkflowSnapshot } from "./types.ts";

const cancellingStates = ["cancel_requested", "draining", "cancelled", "completed_after_cancel"];
const unresolvedStates = ["running", "unknown_outcome"];
const clone = <T>(value: T): T => structuredClone(value);
const requireGuard = (condition: boolean, message: string): void => {
    if (!condition) throw new WorkflowError("guard_rejected", message);
};

/** Single synchronous writer. Returned snapshots cannot mutate stored facts.
 * This kernel performs no IO and does not grant permissions or reserve budgets;
 * the host must perform PDP/ledger checks before invoking its command port.
 */
export class WorkflowStore {
    private readonly entities = new SynchronousUnorderedMap<string, WorkflowEntity>();
    private readonly attempts = new SynchronousUnorderedMap<string, ActionAttempt>();
    private readonly events = new SynchronousOrderedMap<number, WorkflowEvent>();
    private sequence = 0;
    private epoch = 0;
    private readonly clock: () => string;

    constructor(clock: () => string = () => new Date().toISOString()) { this.clock = clock; }

    find<K extends WorkflowKind>(kind: K, id: Identifier): Optional<WorkflowEntities[K]> {
        return this.entities.get(`${kind}:${id}`).map(value => clone(value as WorkflowEntities[K]));
    }

    get<K extends WorkflowKind>(kind: K, id: Identifier): WorkflowEntities[K] {
        const value = this.find(kind, id);
        if (value.isEmpty()) throw new WorkflowError("not_found", `${kind} ${id} does not exist`);
        return value.get();
    }

    /** Uses semantic-typescript's collectable to materialize an isolated projection. */
    list<K extends WorkflowKind>(kind: K, sessionId?: Identifier): WorkflowEntities[K][] {
        const values = this.entities.values();
        return new SynchronousOrderedCollectable<WorkflowEntities[K]>((accept, interrupt) => {
            let index = 0n;
            for (const value of values) {
                if (value.kind !== kind || (sessionId !== void 0 && value.sessionId !== sessionId)) continue;
                const snapshot = clone(value as WorkflowEntities[K]);
                if (interrupt(snapshot, index)) break;
                accept(snapshot, index++);
            }
        }).toArray();
    }

    history(): readonly WorkflowEvent[] { return clone(this.events.values().toArray()); }

    snapshot(): WorkflowSnapshot {
        return clone({ schemaVersion: 1, sequence: this.sequence, cancellationEpoch: this.epoch,
            entities: this.listAll(), attempts: this.attempts.values().toArray(), events: this.events.values().toArray() });
    }

    /** Validate and restore pure facts only. No command replay, clock reads or external calls. */
    static restore(snapshot: WorkflowSnapshot, clock?: () => string): WorkflowStore {
        const store = new WorkflowStore(clock);
        try { store.loadSnapshot(clone(snapshot)); } catch (error) {
            throw new WorkflowError("invalid_snapshot", error instanceof Error ? error.message : "Invalid workflow snapshot");
        }
        return store;
    }
    findAttempt(attemptId: Identifier): Optional<ActionAttempt> {
        return this.attempts.get(attemptId).map(value => clone(value));
    }
    getAttempt(attemptId: Identifier): ActionAttempt {
        const value = this.findAttempt(attemptId);
        if (value.isEmpty()) throw new WorkflowError("not_found", `Attempt ${attemptId} does not exist`);
        return value.get();
    }

    create<K extends WorkflowKind>(kind: K, input: CreateEntity<K>, actor: Identifier): WorkflowEntities[K] {
        if (this.entities.containsKey(`${kind}:${input.id}`)) throw new WorkflowError("duplicate", `${kind} ${input.id} already exists`);
        requireGuard(Boolean(input.id && input.sessionId && actor), "IDs and actor must be nonempty");
        const now = this.clock();
        const sessionType = (input as unknown as { readonly sessionType?: string }).sessionType ?? "user_interactive";
        const entity = {
            ...clone(input), kind, state: initialWorkflowStates[kind], version: 0, cancellationEpoch: 0,
            createdAt: now, updatedAt: now,
            ...(kind === "session" ? { sessionType } : {}),
            ...(kind === "goal" ? { validity: "verification_pending" } : {}),
            ...(kind === "action" ? { attemptIds: [] } : {}),
        } as unknown as WorkflowEntities[K];
        this.validateCreation(entity);
        this.put(entity);
        this.record(entity, "created", "", actor, -1);
        return clone(entity);
    }

    transition<K extends WorkflowKind>(kind: K, id: Identifier, to: WorkflowEntities[K]["state"], options: TransitionOptions): WorkflowEntities[K] {
        const current = this.get(kind, id);
        this.checkVersion(current, options.expectedVersion);
        if (!(workflowTransitions[kind][current.state] ?? []).includes(to)) {
            throw new WorkflowError("invalid_transition", `${kind}: ${current.state} -> ${to}`);
        }
        requireGuard(to !== "cancel_requested", "Use requestCancel to propagate cancellation and fence epochs");
        if (kind === "action") {
            requireGuard(!["running", "executing", "succeeded", "failed", "completed_after_cancel"].includes(to), "Use startAttempt, settleAttempt or reconcileAction for execution facts");
        }
        this.guardTransition(current, to, options);
        const taskCompletion = kind === "task" && to === "completed";
        const patch: Partial<WorkflowEntity> = options.acceptance && (["achieved", "succeeded"].includes(to) || taskCompletion)
            ? { assessment: clone(options.acceptance), ...(kind === "goal" ? { validity: "valid", achievedAt: this.clock() } : {}) } : {};
        return this.update(current, to, options.actor, `transition.${to}`, options.reason, patch) as WorkflowEntities[K];
    }

    /** Request and propagation are atomic within this synchronous in-memory writer. */
    requestCancel<K extends "mission" | "goal" | "plan" | "task" | "action">(kind: K, id: Identifier, options: TransitionOptions): WorkflowEntities[K] {
        const root = this.get(kind, id);
        requireGuard(Boolean(options.actor), "Actor is required");
        this.checkVersion(root, options.expectedVersion);
        requireGuard((workflowTransitions[kind][root.state] ?? []).includes("cancel_requested"), `${root.state} cannot be cancelled`);
        const epoch = ++this.epoch;
        for (const entity of [root, ...this.descendants(root)]) {
            const edges = workflowTransitions[entity.kind][entity.state] ?? [];
            if (edges.includes("cancel_requested")) {
                this.update(entity, "cancel_requested", options.actor, "cancel.requested", options.reason, { cancellationEpoch: epoch });
            } else if (!isWorkflowTerminal(entity)) {
                // Unknown/reconciling operations remain explicitly unresolved, but are fenced.
                this.update(entity, entity.state, options.actor, "cancel.fenced", options.reason, { cancellationEpoch: epoch });
            }
        }
        return this.get(kind, id);
    }

    /** Commit gate: call again at the external adapter's final side-effect boundary. */
    assertExecutionAllowed(actionId: Identifier, cancellationEpoch: number): Action {
        const action = this.get("action", actionId);
        this.assertEpoch(action, cancellationEpoch);
        const chain = this.ancestors(action);
        requireGuard(![action, ...chain].some(item => cancellingStates.includes(item.state)), "Cancellation prevents new execution/commit");
        requireGuard(action.state === "ready" || isActionExecutingState(action.state), "Action must be ready/running");
        requireGuard(chain.every(item => {
            if (item.kind === "session") return item.state === "active" || item.state === "idle";
            if (item.kind === "mission") return item.state === "active" || item.state === "achieved";
            if (item.kind === "goal") return item.state === "active" || (item.state === "achieved" && item.validity !== "valid");
            if (item.kind === "plan") return isPlanExecutingState(item.state);
            if (item.kind === "task") return isTaskActiveState(item.state);
            return item.state === "running";
        }), "Work ancestors are not executable");
        const goal = Optional.ofNullable(chain.find((item): item is Goal => item.kind === "goal"));
        requireGuard(goal.map(item => item.validity !== "invalidated" || item.correctivePlanId === this.get("task", action.taskId).planId).orElse(true) === true, "Invalidated goal requires its corrective plan");
        return action;
    }

    startAttempt(actionId: Identifier, input: { expectedVersion: number; cancellationEpoch: number; executionId: Identifier; attemptId: Identifier; actor: Identifier }): ActionAttempt {
        const action = this.get("action", actionId);
        this.checkVersion(action, input.expectedVersion);
        this.assertExecutionAllowed(actionId, input.cancellationEpoch);
        requireGuard(action.state === "ready", "Only a ready action may start an attempt");
        if (this.attempts.containsKey(input.attemptId)) throw new WorkflowError("duplicate", `Attempt ${input.attemptId} already exists`);
        requireGuard(Boolean(input.executionId && input.attemptId && input.actor), "Execution/attempt IDs and actor must be nonempty");
        const plan = this.get("plan", this.get("task", action.taskId).planId);
        requireGuard(action.attemptIds.length < plan.bounds.maxAttempts && Date.parse(this.clock()) < Date.parse(plan.bounds.deadline), "Attempt/deadline bound exhausted; host must dead-letter work");
        const previous = action.attemptIds.map(id => this.getAttempt(id));
        if (previous.some(item => unresolvedStates.includes(item.state))) throw new WorkflowError("unsafe_retry", "Reconcile pending effects before another attempt");
        const attempt: ActionAttempt = {
            executionId: input.executionId, attemptId: input.attemptId, operationId: action.operationId,
            actionId, sessionId: action.sessionId, originTurnId: action.originTurnId,
            cancellationEpoch: input.cancellationEpoch, version: 0, state: "running", startedAt: this.clock(),
        };
        this.attempts.put(attempt.attemptId, attempt);
        this.update(action, "running", input.actor, "attempt.started", void 0, { attemptIds: [...action.attemptIds, attempt.attemptId] });
        return clone(attempt);
    }

    /** Observations are recorded even from old epochs. They do not authorize a commit. */
    settleAttempt(attemptId: Identifier, input: { expectedVersion: number; expectedActionVersion: number; outcome: "succeeded" | "failed" | "cancelled" | "unknown_outcome"; actor: Identifier; observedInTurnId?: Identifier }): ActionAttempt {
        requireGuard(Boolean(input.actor), "Actor is required");
        const attempt = this.getAttempt(attemptId);
        const action = this.get("action", attempt.actionId);
        this.checkVersion(attempt, input.expectedVersion);
        this.checkVersion(action, input.expectedActionVersion);
        requireGuard(attempt.state === "running", "Attempt already settled; use explicit reconciliation for unknown outcomes");
        if (input.observedInTurnId) this.requireSameSession(action, this.get("turn", input.observedInTurnId));
        const cancelled = attempt.cancellationEpoch !== this.currentEpoch(action) || [action, ...this.ancestors(action)].some(item => cancellingStates.includes(item.state));
        let to: Action["state"] = input.outcome === "cancelled" ? "cancelled" : input.outcome;
        if (cancelled && input.outcome === "succeeded") to = "completed_after_cancel";
        else if (cancelled && input.outcome !== "unknown_outcome") to = "cancelled";
        requireGuard(["running", "executing", "cancel_requested", "draining"].includes(action.state), "Action is not awaiting this attempt");
        const settled = { ...attempt, state: input.outcome, version: attempt.version + 1, settledAt: this.clock(), observedInTurnId: input.observedInTurnId };
        this.attempts.put(attemptId, settled);
        this.update(action, to, input.actor, "attempt.settled");
        return clone(settled);
    }

    reconcileAction(actionId: Identifier, input: { expectedVersion: number; expectedAttemptVersion: number; outcome: "succeeded" | "failed" | "cancelled"; actor: Identifier; reconciliationRef: Identifier }): Action {
        const action = this.get("action", actionId);
        this.checkVersion(action, input.expectedVersion);
        requireGuard(Boolean(input.actor), "Actor is required");
        requireGuard(action.state === "reconciling" && Boolean(input.reconciliationRef), "Enter reconciling and supply a query/manual reconciliation reference");
        const attempt = this.getAttempt(action.attemptIds[action.attemptIds.length - 1] ?? "");
        this.checkVersion(attempt, input.expectedAttemptVersion);
        requireGuard(attempt.state === "unknown_outcome", "Latest attempt must have an unknown outcome");
        const cancelled = attempt.cancellationEpoch !== this.currentEpoch(action) || this.ancestors(action).some(item => cancellingStates.includes(item.state));
        const to = cancelled && input.outcome === "succeeded" ? "completed_after_cancel" : input.outcome;
        this.attempts.put(attempt.attemptId, { ...attempt, state: input.outcome, version: attempt.version + 1, settledAt: this.clock() });
        return this.update(action, to, input.actor, "attempt.reconciled", input.reconciliationRef) as Action;
    }

    invalidateGoal(id: Identifier, options: TransitionOptions): Goal {
        const goal = this.get("goal", id);
        this.checkVersion(goal, options.expectedVersion);
        requireGuard(goal.state === "achieved" && Boolean(options.reason), "Only an achieved goal can be invalidated, with a reason");
        return this.update(goal, goal.state, options.actor, "goal.invalidated", options.reason, { validity: "invalidated" }) as Goal;
    }

    attachCorrectivePlan(goalId: Identifier, planId: Identifier, options: TransitionOptions): Goal {
        const goal = this.get("goal", goalId);
        this.checkVersion(goal, options.expectedVersion);
        const plan = this.get("plan", planId);
        requireGuard(goal.validity === "invalidated" && plan.goalId === goalId && plan.state === "draft", "Corrective plan must be a draft for the invalidated goal");
        return this.update(goal, goal.state, options.actor, "goal.correction_attached", options.reason, { correctivePlanId: planId, validity: "verification_pending" }) as Goal;
    }

    revalidateGoal(id: Identifier, options: TransitionOptions): Goal {
        const goal = this.get("goal", id);
        this.checkVersion(goal, options.expectedVersion);
        requireGuard(goal.state === "achieved" && goal.validity !== "valid", "Goal must await revalidation");
        this.checkAcceptance(options.acceptance, goal.contractVersion);
        if (goal.correctivePlanId) requireGuard(this.get("plan", goal.correctivePlanId).state === "completed", "Corrective plan is not complete");
        return this.update(goal, goal.state, options.actor, "goal.revalidated", options.reason, { validity: "valid", assessment: clone(options.acceptance!) }) as Goal;
    }

    private loadSnapshot(snapshot: WorkflowSnapshot): void {
        const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
        const text = (value: unknown): boolean => typeof value === "string" && value.length > 0;
        const date = (value: string): boolean => text(value) && Number.isFinite(Date.parse(value));
        requireGuard(snapshot.schemaVersion === 1 && integer(snapshot.sequence) && integer(snapshot.cancellationEpoch), "Invalid schema/counters");
        requireGuard(Array.isArray(snapshot.entities) && Array.isArray(snapshot.attempts) && Array.isArray(snapshot.events), "Snapshot collections are required");
        this.sequence = snapshot.sequence;
        this.epoch = snapshot.cancellationEpoch;
        for (const entity of snapshot.entities) {
            requireGuard(Object.hasOwn(initialWorkflowStates, entity.kind), "Unknown entity kind");
            const edges = workflowTransitions[entity.kind];
            const states = [initialWorkflowStates[entity.kind], ...Object.keys(edges), ...Object.values(edges).flat()];
            requireGuard(states.includes(entity.state) && text(entity.id) && text(entity.sessionId), "Invalid entity state/identity");
            requireGuard(integer(entity.version) && integer(entity.cancellationEpoch) && entity.cancellationEpoch <= this.epoch, "Invalid entity version/epoch");
            requireGuard(date(entity.createdAt) && date(entity.updatedAt), "Invalid entity timestamps");
            requireGuard(!this.entities.containsKey(`${entity.kind}:${entity.id}`), "Duplicate entity");
            this.put(entity);
        }
        for (const entity of snapshot.entities) {
            const session = this.get("session", entity.sessionId);
            requireGuard(session.id === session.sessionId, "Invalid session identity");
            if (entity.originTurnId) this.requireSameSession(entity, this.get("turn", entity.originTurnId));
            const parent = this.parent(entity);
            parent.ifPresent(value => this.requireSameSession(entity, value));
            switch (entity.kind) {
                case "session":
                    requireGuard(Array.isArray(entity.participants), "Invalid participants");
                    requireGuard(entity.sessionType === void 0 || ["user_interactive", "autonomous", "scheduled", "delegated"].includes(entity.sessionType), "Invalid session type");
                    requireGuard(entity.expiresAt === void 0 || date(entity.expiresAt), "Invalid session expiry");
                    break;
                case "turn":
                    requireGuard(["steering", "status", "cancel", "new_intent"].includes(entity.classification), "Invalid Turn classification");
                    if (entity.replyTo) this.requireSameSession(entity, this.get("turn", entity.replyTo));
                    if (entity.state === "clarifying") requireGuard(text(entity.continuationKey), "Missing continuation key");
                    break;
                case "intent":
                    requireGuard(text(entity.originTurnId) && text(entity.text), "Invalid Intent");
                    this.requireSameSession(entity, this.get("turn", entity.originTurnId));
                    break;
                case "mission":
                    this.requireSameSession(entity, this.get("intent", entity.intentId));
                    requireGuard(this.list("mission", entity.sessionId).filter(item => item.intentId === entity.intentId).length === 1, "Duplicate Intent承接");
                    break;
                case "goal":
                    requireGuard(text(entity.contractVersion) && entity.acceptanceCriteria.length > 0 && ["valid", "invalidated", "verification_pending"].includes(entity.validity), "Invalid Goal contract/validity");
                    if (entity.state === "achieved") {
                        requireGuard(date(entity.achievedAt!), "Missing achievement history");
                        this.checkAcceptance(entity.assessment, entity.contractVersion);
                    }
                    if (entity.correctivePlanId) requireGuard(this.get("plan", entity.correctivePlanId).goalId === entity.id, "Invalid corrective plan");
                    break;
                case "plan":
                    requireGuard(integer(entity.bounds.maxAttempts) && entity.bounds.maxAttempts > 0 && date(entity.bounds.deadline) && text(entity.bounds.progressMetric) && text(entity.bounds.deadLetterOwner), "Invalid Plan bounds");
                    this.validateDag(entity.id);
                    break;
                case "task":
                    requireGuard(Array.isArray(entity.dependsOn) && Array.isArray(entity.requiredEffects) && text(entity.contractVersion) && typeof entity.required === "boolean", "Invalid Task contract");
                    if (["succeeded", "completed"].includes(entity.state)) this.checkAcceptance(entity.assessment, entity.contractVersion);
                    break;
                case "action":
                    requireGuard(text(entity.operationId) && text(entity.effect) && Array.isArray(entity.attemptIds) && typeof entity.sideEffect === "boolean" && typeof entity.required === "boolean", "Invalid Action");
                    requireGuard(["idempotent", "query", "reconcile", "compensate"].includes(entity.recovery), "Invalid recovery mode");
                    requireGuard(this.list("action", entity.sessionId).filter(item => item.operationId === entity.operationId).length === 1, "Duplicate operation ID");
                    break;
            }
        }
        for (const attempt of snapshot.attempts) {
            requireGuard(text(attempt.attemptId) && text(attempt.executionId) && integer(attempt.version) && integer(attempt.cancellationEpoch), "Invalid attempt identity/version/epoch");
            requireGuard(!this.attempts.containsKey(attempt.attemptId), "Duplicate attempt");
            const action = this.get("action", attempt.actionId);
            this.requireSameSession(action, attempt);
            requireGuard(attempt.operationId === action.operationId && attempt.originTurnId === action.originTurnId && attempt.cancellationEpoch <= this.currentEpoch(action), "Attempt identity/epoch mismatch");
            requireGuard(action.attemptIds.filter(id => id === attempt.attemptId).length === 1, "Attempt is not linked exactly once");
            requireGuard(["running", "succeeded", "failed", "cancelled", "unknown_outcome"].includes(attempt.state) && date(attempt.startedAt), "Invalid attempt state/time");
            requireGuard(attempt.state === "running" ? attempt.version === 0 && !attempt.settledAt : attempt.version > 0 && date(attempt.settledAt!), "Attempt settlement/version mismatch");
            if (attempt.observedInTurnId) this.requireSameSession(action, this.get("turn", attempt.observedInTurnId));
            this.attempts.put(attempt.attemptId, clone(attempt));
        }
        for (const action of this.list("action")) {
            const attempts = action.attemptIds.map(id => this.getAttempt(id));
            const pending = attempts.filter(item => unresolvedStates.includes(item.state));
            requireGuard(pending.length <= 1, "Multiple unresolved attempts");
            if (pending.length) requireGuard(["running", "executing", "cancel_requested", "draining", "unknown_outcome", "reconciling"].includes(action.state), "Unresolved attempt on settled Action");
            if (["running", "executing", "unknown_outcome", "reconciling"].includes(action.state)) requireGuard(pending.length === 1, "Action lacks unresolved attempt");
        }
        const latest = new SynchronousUnorderedMap<string, WorkflowEvent>();
        requireGuard(snapshot.events.length === snapshot.sequence, "Event sequence counter mismatch");
        for (const [index, event] of snapshot.events.entries()) {
            const entity = this.get(event.entityKind, event.entityId);
            const key = `${event.entityKind}:${event.entityId}`;
            const previous = latest.get(key);
            requireGuard(event.sequence === index + 1 && integer(event.version) && integer(event.cancellationEpoch) && event.cancellationEpoch <= this.epoch && text(event.actor) && date(event.timestamp), "Invalid event metadata");
            requireGuard(event.expectedVersion === previous.map(value => value.version).orElse(-1) && event.version === event.expectedVersion + 1 && event.from === previous.map(value => value.to).orElse(""), "Invalid event version chain");
            requireGuard(event.version <= entity.version && event.cancellationEpoch >= previous.map(value => value.cancellationEpoch).orElse(0)!, "Event version/epoch regressed");
            const states = [initialWorkflowStates[event.entityKind], ...Object.keys(workflowTransitions[event.entityKind]), ...Object.values(workflowTransitions[event.entityKind]).flat()];
            requireGuard(states.includes(event.to) && (previous.isPresent() ? states.includes(event.from) : event.to === initialWorkflowStates[event.entityKind] && event.eventType === "created"), "Invalid event state");
            latest.put(key, clone(event));
            this.events.put(event.sequence, clone(event));
        }
        for (const entity of snapshot.entities) {
            const event = latest.get(`${entity.kind}:${entity.id}`);
            requireGuard(event.isPresent() && event.get().version === entity.version && event.get().to === entity.state && event.get().cancellationEpoch === entity.cancellationEpoch, "Entity does not match audit head");
        }
    }

    private validateCreation(entity: WorkflowEntity): void {
        if (entity.kind === "session") {
            requireGuard(entity.id === entity.sessionId, "Session ID must equal sessionId");
            requireGuard(entity.sessionType === void 0 || ["user_interactive", "autonomous", "scheduled", "delegated"].includes(entity.sessionType), "Invalid session type");
            requireGuard(entity.expiresAt === void 0 || Number.isFinite(Date.parse(entity.expiresAt)), "Invalid session expiry");
            return;
        }
        const session = this.get("session", entity.sessionId);
        requireGuard(session.state === "active" || session.state === "idle", "Session must be active/idle to create work");
        if (entity.originTurnId) this.requireSameSession(entity, this.get("turn", entity.originTurnId));
        switch (entity.kind) {
            case "turn":
                if (entity.replyTo) this.requireSameSession(entity, this.get("turn", entity.replyTo));
                if (entity.replyTo && entity.continuationKey) requireGuard(this.get("turn", entity.replyTo).continuationKey === entity.continuationKey, "Linked continuationKey must match its original Turn");
                break;
            case "intent":
                requireGuard(this.get("turn", entity.originTurnId).state === "interpreting", "Intent must be captured during interpreting");
                break;
            case "mission":
                this.requireSameSession(entity, this.get("intent", entity.intentId));
                requireGuard(this.get("intent", entity.intentId).state === "accepted", "Mission requires accepted Intent");
                requireGuard(!this.list("mission").some(item => item.intentId === entity.intentId), "Intent already has a Mission");
                break;
            case "goal":
                this.requireSameSession(entity, this.get("mission", entity.missionId));
                requireGuard(Boolean(entity.contractVersion) && entity.acceptanceCriteria.length > 0, "Goal requires versioned acceptance criteria");
                break;
            case "plan": {
                const goal = this.get("goal", entity.goalId);
                this.requireSameSession(entity, goal);
                requireGuard(goal.state === "active" || (goal.state === "achieved" && goal.validity !== "valid"), "Plan requires active or invalidated Goal");
                requireGuard(Number.isSafeInteger(entity.bounds.maxAttempts) && entity.bounds.maxAttempts > 0 && Number.isFinite(Date.parse(entity.bounds.deadline)) && Boolean(entity.bounds.progressMetric && entity.bounds.deadLetterOwner), "Plan requires bounded progress/dead-letter metadata");
                break;
            }
            case "task": {
                const plan = this.get("plan", entity.planId);
                this.requireSameSession(entity, plan);
                requireGuard(plan.state === "draft", "Task DAG is fixed when Plan leaves draft");
                requireGuard(Boolean(entity.contractVersion), "Task requires an acceptance contract");
                for (const id of entity.dependsOn) requireGuard(this.get("task", id).planId === entity.planId, "Task dependencies must exist in the same Plan");
                break;
            }
            case "action": {
                const task = this.get("task", entity.taskId);
                this.requireSameSession(entity, task);
                requireGuard(["pending", "proposed", "ready", "running", "active"].includes(task.state), "Task does not accept new Actions");
                requireGuard(Boolean(entity.operationId && entity.effect) && ["idempotent", "query", "reconcile", "compensate"].includes(entity.recovery), "Action requires stable operation ID and recovery strategy");
                requireGuard(!this.list("action", entity.sessionId).some(item => item.operationId === entity.operationId), "Operation ID already belongs to an Action");
                break;
            }
        }
        for (const parent of this.ancestors(entity)) requireGuard(!cancellingStates.includes(parent.state), "Parent cancellation prevents new work");
    }

    private guardTransition(entity: WorkflowEntity, to: string, options: TransitionOptions): void {
        requireGuard(Boolean(options.actor), "Actor is required");
        if (entity.kind === "turn" && to === "clarifying") requireGuard(Boolean(entity.continuationKey), "Clarifying Turn requires a continuationKey");
        if (entity.kind === "turn" && entity.state === "clarifying" && to === "interpreting") {
            requireGuard(options.clarification?.replyTo === entity.id && options.clarification?.continuationKey === entity.continuationKey, "Clarification must match replyTo and continuationKey");
        }
        if (["ready", "running", "executing", "approved", "active", "achieved", "succeeded", "completed", "unblocked", "fulfilled", "partially_achieved"].includes(to) && !["session", "turn", "intent"].includes(entity.kind)) {
            requireGuard(!this.ancestors(entity).some(item => cancellingStates.includes(item.state)), "Cancelled ancestors prevent business advancement");
        }
        if (["achieved", "succeeded", "completed"].includes(to) && !["session", "turn"].includes(entity.kind)) {
            requireGuard(options.cancellationEpoch !== void 0, "Business commit requires cancellationEpoch");
            this.assertEpoch(entity, options.cancellationEpoch!);
            this.assertSettled(entity);
        }
        if (to === "cancelled" || to === "completed_after_cancel") this.assertSettled(entity);
        if (to === "completed_after_cancel") requireGuard(this.descendantAttempts(entity).some(item => item.state === "succeeded"), "Completion after cancel requires an observed successful attempt");
        if (to === "unknown_outcome") requireGuard(this.descendantAttempts(entity).some(item => item.state === "unknown_outcome"), "Unknown outcome requires an unresolved execution observation");
        if (entity.kind === "session" && to === "closed") {
            const work = this.listAll().filter(item => item.sessionId === entity.id && item.kind !== "session");
            requireGuard(work.every(item => isWorkflowSettled(item) || (item.kind === "action" && item.state === "failed")), "Session still has active work");
            requireGuard(!this.attempts.values().toArray().some(item => item.sessionId === entity.id && unresolvedStates.includes(item.state)), "Session has unsettled attempts");
        }
        if (entity.kind === "task" && to === "ready") {
            requireGuard(entity.dependsOn.every(id => isTaskCompletedState(this.get("task", id).state)), "Task dependencies are not satisfied");
            requireGuard(["ready", "approved", "running", "executing"].includes(this.get("plan", entity.planId).state), "Plan must be approved/ready or executing/running");
        }
        if (entity.kind === "task" && to === "skipped") requireGuard(!entity.required, "Required Task cannot be skipped");
        if (entity.kind === "task" && (to === "succeeded" || to === "completed")) {
            this.checkAcceptance(options.acceptance, entity.contractVersion);
            const actions = this.list("action", entity.sessionId).filter(item => item.taskId === entity.id);
            requireGuard(actions.filter(item => item.required).every(item => item.state === "succeeded"), "Required actions have not succeeded");
            requireGuard(entity.requiredEffects.every(effect => actions.some(item => item.effect === effect && item.state === "succeeded")), "Required effects are missing");
        }
        if (entity.kind === "plan" && (to === "ready" || to === "approved")) this.validateDag(entity.id);
        if (entity.kind === "plan" && to === "completed") {
            requireGuard(this.list("task", entity.sessionId).filter(item => item.planId === entity.id).every(item => isTaskCompletedState(item.state) || (!item.required && item.state === "skipped")), "Plan has unaccepted tasks");
        }
        if (entity.kind === "goal" && to === "achieved") this.checkAcceptance(options.acceptance, entity.contractVersion);
        if (entity.kind === "mission" && to === "achieved") {
            const goals = this.list("goal", entity.sessionId).filter(item => item.missionId === entity.id);
            requireGuard(goals.length > 0 && goals.every(item => item.state === "achieved" && item.validity === "valid"), "Mission requires valid achieved Goals");
        }
    }

    private validateDag(planId: Identifier): void {
        const tasks = this.list("task").filter(item => item.planId === planId);
        const visited = new SynchronousUnorderedMap<string, "visiting" | "done">();
        const visit = (task: Task): void => {
            const state = visited.get(task.id);
            requireGuard(state.map(value => value !== "visiting").orElse(true) === true, "Plan Task DAG contains a cycle");
            if (state.filter(value => value === "done").isPresent()) return;
            visited.put(task.id, "visiting");
            for (const id of task.dependsOn) {
                const dependency = this.get("task", id);
                requireGuard(dependency.planId === planId, "Dependency belongs to another Plan");
                visit(dependency);
            }
            visited.put(task.id, "done");
        };
        tasks.forEach(visit);
    }

    private checkAcceptance(value: Acceptance | undefined, contractVersion: string): void {
        requireGuard(Boolean(value?.valid && value.contractVersion === contractVersion && value.verificationId && value.evidenceIds.length), "Independent current verification and evidence are required");
    }
    private checkVersion(value: { version: number }, expected: number): void {
        if (value.version !== expected) throw new WorkflowError("version_conflict", `Expected version ${expected}, current ${value.version}`);
    }
    private requireSameSession(left: { sessionId: string }, right: { sessionId: string }): void {
        if (left.sessionId !== right.sessionId) throw new WorkflowError("invalid_reference", "Cross-session reference rejected");
    }
    private parent(entity: WorkflowEntity): Optional<WorkflowEntity> {
        switch (entity.kind) {
            case "session": return Optional.empty<WorkflowEntity>();
            case "turn": case "intent": case "mission": return Optional.ofNonNull(this.get("session", entity.sessionId));
            case "goal": return Optional.ofNonNull(this.get("mission", entity.missionId));
            case "plan": return Optional.ofNonNull(this.get("goal", entity.goalId));
            case "task": return Optional.ofNonNull(this.get("plan", entity.planId));
            case "action": return Optional.ofNonNull(this.get("task", entity.taskId));
        }
    }
    private ancestors(entity: WorkflowEntity): WorkflowEntity[] {
        const result: WorkflowEntity[] = [];
        let parent = this.parent(entity);
        while (parent.isPresent()) { const value = parent.get(); result.push(value); parent = this.parent(value); }
        return result;
    }
    private listAll(): WorkflowEntity[] { return this.entities.values().toArray(); }
    private descendants(entity: WorkflowEntity): WorkflowEntity[] {
        return this.listAll().filter(item => this.ancestors(item).some(parent => parent.kind === entity.kind && parent.id === entity.id));
    }
    private currentEpoch(entity: WorkflowEntity): number { return Math.max(entity.cancellationEpoch, ...this.ancestors(entity).map(item => item.cancellationEpoch)); }
    private assertEpoch(entity: WorkflowEntity, expected: number): void {
        if (expected !== this.currentEpoch(entity)) throw new WorkflowError("stale_epoch", "Cancellation epoch changed");
    }
    private descendantAttempts(entity: WorkflowEntity): ActionAttempt[] {
        const actions = [entity, ...this.descendants(entity)].filter((item): item is Action => item.kind === "action");
        return actions.flatMap(action => action.attemptIds.map(id => this.getAttempt(id)));
    }
    private assertSettled(entity: WorkflowEntity): void {
        if (this.descendantAttempts(entity).some(item => unresolvedStates.includes(item.state))) throw new WorkflowError("unsettled_work", "Running or unknown effects remain unsettled");
        if (this.descendants(entity).some(item => !isWorkflowTerminal(item) && !(item.kind === "action" && item.state === "failed"))) {
            throw new WorkflowError("unsettled_work", "Child work is not drained");
        }
    }
    private put(entity: WorkflowEntity): void { this.entities.put(`${entity.kind}:${entity.id}`, clone(entity)); }
    private update(entity: WorkflowEntity, state: string, actor: Identifier, eventType: string, reason?: string, patch: Partial<WorkflowEntity> = {}): WorkflowEntity {
        requireGuard(Boolean(actor), "Actor is required");
        const next = { ...entity, ...patch, state, version: entity.version + 1, updatedAt: this.clock() } as WorkflowEntity;
        this.put(next);
        this.record(next, eventType, entity.state, actor, entity.version, reason);
        return clone(next);
    }
    private record(entity: WorkflowEntity, eventType: string, from: string, actor: Identifier, expectedVersion: number, reason?: string): void {
        const sequence = ++this.sequence;
        this.events.put(sequence, { sequence, entityKind: entity.kind, entityId: entity.id, eventType, from, to: entity.state, expectedVersion, version: entity.version, actor, cancellationEpoch: entity.cancellationEpoch, timestamp: entity.updatedAt, reason });
    }
}
