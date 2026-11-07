import type { Identifier, JsonValue } from "../shared.ts";
import type { WorkflowStore } from "./store.ts";
import { isTaskCompletedState, workflowTransitions } from "./transitions.ts";
import { WorkflowError } from "./types.ts";
import type {
    Acceptance,
    Action,
    Goal,
    Mission,
    Plan,
    Task,
    TransitionOptions,
    WorkflowEntities,
    WorkflowEntity,
    WorkflowEvent,
    WorkflowKind,
} from "./types.ts";
import type { CancellationState } from "./types.ts";

/**
 * Reverse propagation (refract §4.9): a failure/result event is examined by the
 * direct parent layer only. `propagate` is a pure decision function: it reads
 * the store, validates that the reported fact is the entity's current state and
 * returns the decisions plus a list of still-unapplied transitions. Applying a
 * returned transition stays an explicit `WorkflowStore.transition` command, so
 * hosts keep their authorization, budget and CAS boundary.
 *
 * Every proposed transition is checked against `workflowTransitions`; this
 * module never invents an edge, never skips a hierarchy level and throws
 * `WorkflowError` when the caller claims a fact that is not current
 * (`invalid_transition`), addresses the wrong entity kind
 * (`invalid_reference`), supplies an unusable cancellation epoch
 * (`stale_epoch`), or tries to advance business state under a cancellation
 * fence (`guard_rejected`).
 */
export type PropagationTrigger =
    | "action.failed"
    | "action.dead_letter"
    | "task.failed"
    | "task.blocked"
    | "plan.failed"
    | "plan.completed"
    | "goal.achieved"
    | "goal.failed"
    | "goal.blocked"
    | "mission.achieved"
    | "mission.failed"
    | "mission.partially_achieved"
    | "mission.abandoned";

/** A fact reported by an execution surface; `propagate` verifies it is current. */
export interface PropagationEvent {
    readonly entityKind: WorkflowKind;
    readonly entityId: Identifier;
    readonly trigger: PropagationTrigger;
    readonly actor: Identifier;
    readonly reason?: string;
    /** Independent Goal verification; `propagate` never synthesizes acceptance. */
    readonly acceptance?: Acceptance;
    /** Business-commit epoch; defaults to the target entity's current epoch. */
    readonly cancellationEpoch?: number;
    /** Decision timestamp; defaults to the source entity's `updatedAt`. */
    readonly at?: string;
}

/** Either an explicit fact or the journal entry that recorded it. */
export type PropagationInput = PropagationEvent | WorkflowEvent;

export interface PropagationTarget {
    readonly kind: WorkflowKind;
    readonly id: Identifier;
}

export type PropagationDecisionKind =
    | "tolerate_action_failure"
    | "retry_action"
    | "reroute_action"
    | "block_task"
    | "skip_task"
    | "unblock_task"
    | "wait_for_dependencies"
    | "retry_plan"
    | "replan_plan"
    | "replace_plan"
    | "fail_plan"
    | "verify_goal"
    | "goal_verification_rejected"
    | "achieve_goal"
    | "retry_goal"
    | "block_goal"
    | "fail_goal"
    | "await_remaining_goals"
    | "mission_degraded"
    | "await_goal_unblock"
    | "achieve_mission"
    | "partially_achieve_mission"
    | "fail_mission"
    | "fulfill_intent"
    | "defer_intent"
    | "already_settled";

/**
 * A transition the parent layer may apply. `expectedVersion` is the version at
 * decision time; transitions are chained, so a second transition of the same
 * entity already expects the version produced by the first one.
 */
export interface PropagationTransition {
    readonly transitionId: Identifier;
    readonly entityKind: WorkflowKind;
    readonly entityId: Identifier;
    readonly from: string;
    readonly to: string;
    readonly expectedVersion: number;
    readonly actor: Identifier;
    readonly reason: string;
    readonly cancellationEpoch?: number;
    readonly acceptance?: Acceptance;
}

export interface PropagationDecision {
    readonly decisionId: Identifier;
    readonly trigger: PropagationTrigger;
    readonly kind: PropagationDecisionKind;
    readonly source: PropagationTarget;
    readonly target: PropagationTarget;
    readonly reason: string;
    readonly transitionIds: readonly Identifier[];
    readonly facts?: Readonly<Record<string, JsonValue>>;
}

export interface PropagationResult {
    readonly trigger: PropagationTrigger;
    readonly source: PropagationTarget;
    readonly decidedAt: string;
    readonly decisions: readonly PropagationDecision[];
    readonly transitions: readonly PropagationTransition[];
}

export interface PropagationApplication {
    readonly applied: readonly PropagationTransition[];
    readonly entities: readonly WorkflowEntity[];
}

const cancellingStates: readonly string[] = ["cancel_requested", "draining", "cancelled", "completed_after_cancel"] as const satisfies readonly CancellationState[];
const taskProgressStates: readonly string[] = ["pending", "proposed", "ready", "running", "active", "paused", "unblocked"] as const;
const taskDeadStates: readonly string[] = ["failed", "dead_letter", "cancelled", "cancel_requested", "draining", "completed_after_cancel", "unknown_outcome"] as const;
const goalSettledStates: readonly string[] = ["achieved", "failed", "abandoned"] as const;
const missionOpenStates: readonly string[] = ["proposed", "active"] as const;
const intentClosedStates: readonly string[] = ["superseded", "withdrawn", "abandoned", "rejected"] as const;

const triggerSpecs: Readonly<Record<PropagationTrigger, { readonly kind: WorkflowKind; readonly state: string }>> = Object.freeze({
    "action.failed": { kind: "action", state: "failed" },
    "action.dead_letter": { kind: "action", state: "dead_letter" },
    "task.failed": { kind: "task", state: "failed" },
    "task.blocked": { kind: "task", state: "blocked" },
    "plan.failed": { kind: "plan", state: "failed" },
    "plan.completed": { kind: "plan", state: "completed" },
    "goal.achieved": { kind: "goal", state: "achieved" },
    "goal.failed": { kind: "goal", state: "failed" },
    "goal.blocked": { kind: "goal", state: "blocked" },
    "mission.achieved": { kind: "mission", state: "achieved" },
    "mission.failed": { kind: "mission", state: "failed" },
    "mission.partially_achieved": { kind: "mission", state: "partially_achieved" },
    "mission.abandoned": { kind: "mission", state: "abandoned" },
});
const triggerByState: ReadonlyMap<string, PropagationTrigger> = new Map(
    (Object.entries(triggerSpecs) as [PropagationTrigger, { readonly kind: WorkflowKind; readonly state: string }][])
        .map(([trigger, spec]) => [`${spec.kind}:${spec.state}`, trigger]),
);

const requireText = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) throw new WorkflowError("invalid_reference", `${field} must be a nonempty string`);
    return value;
};
const isCancelling = (state: string): boolean => cancellingStates.includes(state);
const deadlinePassed = (deadline: string, at: string): boolean => Date.parse(at) >= Date.parse(deadline);

const parentOf = (store: WorkflowStore, entity: WorkflowEntity): WorkflowEntity | undefined => {
    switch (entity.kind) {
        case "goal": return store.get("mission", entity.missionId);
        case "plan": return store.get("goal", entity.goalId);
        case "task": return store.get("plan", entity.planId);
        case "action": return store.get("task", entity.taskId);
        default: return undefined;
    }
};

/** Highest cancellation epoch on the business chain; Intent/Session are not business parents. */
const businessEpoch = (store: WorkflowStore, entity: WorkflowEntity): number => {
    let epoch = entity.cancellationEpoch;
    let parent = parentOf(store, entity);
    while (parent !== undefined) {
        epoch = Math.max(epoch, parent.cancellationEpoch);
        parent = parentOf(store, parent);
    }
    return epoch;
};

const assertPropagationAllowed = (store: WorkflowStore, source: WorkflowEntity): void => {
    for (let cursor: WorkflowEntity | undefined = source; cursor !== undefined; cursor = parentOf(store, cursor)) {
        if (isCancelling(cursor.state)) {
            throw new WorkflowError("guard_rejected", `Cancellation of ${cursor.kind} ${cursor.id} suppresses business propagation`);
        }
    }
    if (source.kind === "mission") {
        const intent = store.get("intent", source.intentId);
        if (isCancelling(intent.state) || intentClosedStates.includes(intent.state)) {
            throw new WorkflowError("guard_rejected", `Intent ${intent.id} is ${intent.state}; Mission results cannot be propagated`);
        }
    }
};

const acceptanceMatches = (acceptance: Acceptance, contractVersion: string): boolean =>
    acceptance.valid && acceptance.contractVersion === contractVersion && acceptance.verificationId.length > 0 && acceptance.evidenceIds.length > 0;

const goalsOfMission = (store: WorkflowStore, mission: Mission): Goal[] => store.list("goal").filter(goal => goal.missionId === mission.id);
const plansOfGoal = (store: WorkflowStore, goal: Goal): Plan[] => store.list("plan").filter(plan => plan.goalId === goal.id);
const tasksOfPlan = (store: WorkflowStore, plan: Plan): Task[] => store.list("task").filter(task => task.planId === plan.id);

/** Validate the reported fact without mutating anything. */
export function assertPropagationEvent(store: WorkflowStore, event: PropagationEvent): WorkflowEntity {
    if (event === null || typeof event !== "object") throw new WorkflowError("invalid_reference", "Propagation event must be an object");
    const spec = Object.hasOwn(triggerSpecs, event.trigger) ? triggerSpecs[event.trigger] : undefined;
    if (spec === undefined) throw new WorkflowError("invalid_reference", `Unknown propagation trigger: ${String(event.trigger)}`);
    if (event.entityKind !== spec.kind) {
        throw new WorkflowError("invalid_reference", `${event.trigger} cannot be reported by ${String(event.entityKind)}`);
    }
    requireText(event.entityId, "Propagation entityId");
    requireText(event.actor, "Propagation actor");
    if (event.at !== undefined && !Number.isFinite(Date.parse(event.at))) throw new WorkflowError("invalid_reference", "Propagation timestamp is not ISO-compatible");
    const source = store.get(event.entityKind, event.entityId);
    if (source.state !== spec.state) {
        throw new WorkflowError("invalid_transition", `${source.kind} ${source.id} is ${source.state}, not ${spec.state}; the reported fact is not current`);
    }
    assertPropagationAllowed(store, source);
    return source;
}

/**
 * Adapts a stored `WorkflowEvent` to an explicit fact. The journal entry must be
 * the entity's current head, so a stale/replayed event cannot drive decisions.
 */
function recordedEventToPropagation(store: WorkflowStore, event: WorkflowEvent): PropagationEvent {
    const trigger = triggerByState.get(`${event.entityKind}:${event.to}`);
    if (trigger === undefined) {
        throw new WorkflowError("invalid_reference", `Recorded event ${event.entityKind} -> ${event.to} is not a propagation fact`);
    }
    const entity = store.get(event.entityKind, event.entityId);
    if (entity.state !== event.to) {
        throw new WorkflowError("invalid_transition", `Recorded event ${event.sequence} does not describe the current state of ${event.entityKind} ${event.entityId}`);
    }
    if (entity.version !== event.version) {
        throw new WorkflowError("version_conflict", `Recorded event ${event.sequence} is not the current head of ${event.entityKind} ${event.entityId}`);
    }
    return {
        entityKind: event.entityKind,
        entityId: event.entityId,
        trigger,
        actor: event.actor,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        at: event.timestamp,
    };
}

/**
 * Pure reverse-propagation decision function. No store mutation, no clock read:
 * the decision timestamp is the event's `at` or the source's stored `updatedAt`.
 * Accepts either an explicit `PropagationEvent` or the store's recorded
 * `WorkflowEvent` (for example `store.history().at(-1)`).
 */
export function propagate(store: WorkflowStore, input: PropagationInput): PropagationResult {
    if (input === null || typeof input !== "object") throw new WorkflowError("invalid_reference", "Propagation event must be an object");
    const event = "trigger" in input ? input : recordedEventToPropagation(store, input);
    const source = assertPropagationEvent(store, event);
    const decidedAt = event.at ?? source.updatedAt;
    const transitions: PropagationTransition[] = [];
    const virtual = new Map<string, { readonly state: string; readonly version: number }>();
    const decisions: PropagationDecision[] = [];
    const reasonFor = (fallback: string): string => (typeof event.reason === "string" && event.reason.length > 0 ? event.reason : fallback);

    const currentOf = (kind: WorkflowKind, id: Identifier): { readonly state: string; readonly version: number } => {
        const key = `${kind}:${id}`;
        const known = virtual.get(key);
        if (known !== undefined) return known;
        const entity = store.get(kind, id);
        const value = { state: entity.state, version: entity.version };
        virtual.set(key, value);
        return value;
    };
    /** Propose one edge. Refuses anything outside `workflowTransitions`. */
    const propose = (
        kind: WorkflowKind,
        id: Identifier,
        to: string,
        options: { readonly reason: string; readonly cancellationEpoch?: number; readonly acceptance?: Acceptance },
    ): PropagationTransition => {
        const current = currentOf(kind, id);
        const edges = workflowTransitions[kind][current.state] ?? [];
        if (!edges.includes(to)) {
            throw new WorkflowError("invalid_transition", `Propagation would overreach: ${kind} ${id} ${current.state} -> ${to} is not a legal edge`);
        }
        const transition: PropagationTransition = Object.freeze({
            transitionId: `${kind}:${id}:${current.state}->${to}`,
            entityKind: kind,
            entityId: id,
            from: current.state,
            to,
            expectedVersion: current.version,
            actor: event.actor,
            reason: options.reason,
            ...(options.cancellationEpoch === undefined ? {} : { cancellationEpoch: options.cancellationEpoch }),
            ...(options.acceptance === undefined ? {} : { acceptance: options.acceptance }),
        });
        transitions.push(transition);
        virtual.set(`${kind}:${id}`, { state: to, version: current.version + 1 });
        return transition;
    };
    const record = (
        kind: PropagationDecisionKind,
        target: PropagationTarget,
        reason: string,
        proposed: readonly PropagationTransition[] = [],
        facts?: Readonly<Record<string, JsonValue>>,
    ): void => {
        decisions.push(Object.freeze({
            decisionId: `${event.trigger}:${source.kind}:${source.id}:${kind}`,
            trigger: event.trigger,
            kind,
            source: Object.freeze({ kind: source.kind, id: source.id }),
            target: Object.freeze({ ...target }),
            reason,
            transitionIds: Object.freeze(proposed.map(transition => transition.transitionId)),
            ...(facts === undefined ? {} : { facts: Object.freeze({ ...facts }) }),
        }));
    };
    const epochFor = (entity: WorkflowEntity): number => {
        const current = businessEpoch(store, entity);
        if (event.cancellationEpoch !== undefined && event.cancellationEpoch !== current) {
            throw new WorkflowError("stale_epoch", `Expected cancellation epoch ${current}, received ${event.cancellationEpoch}`);
        }
        return current;
    };

    switch (event.trigger) {
        case "action.failed": {
            const action = source as Action;
            const task = store.get("task", action.taskId);
            const plan = store.get("plan", task.planId);
            if (!taskProgressStates.includes(task.state) && task.state !== "blocked") {
                throw new WorkflowError("guard_rejected", `Task ${task.id} is ${task.state}; it cannot decide an Action failure`);
            }
            if (!action.required) {
                record("tolerate_action_failure", { kind: "task", id: task.id },
                    reasonFor(`Optional Action ${action.id} failed; Task ${task.id} continues`),
                    [], { required: false });
                break;
            }
            if (task.state === "blocked") {
                record("already_settled", { kind: "task", id: task.id }, `Task ${task.id} is already blocked`, [], { taskState: task.state });
                break;
            }
            const attemptsRemaining = Math.max(0, plan.bounds.maxAttempts - action.attemptIds.length);
            const lateAttempt = deadlinePassed(plan.bounds.deadline, decidedAt);
            if (attemptsRemaining > 0 && !lateAttempt) {
                const transition = propose(action.kind, action.id, "ready", {
                    reason: reasonFor(`Retry ${action.id}: ${attemptsRemaining} attempt(s) remain`),
                });
                record("retry_action", { kind: "action", id: action.id },
                    `Task layer retries Action ${action.id}; the operation ID is retained`,
                    [transition], { attemptsRemaining });
                break;
            }
            const alternative = store.list("action")
                .find(candidate => candidate.taskId === task.id
                    && candidate.id !== action.id
                    && candidate.effect === action.effect
                    && ["declared", "pending", "ready"].includes(candidate.state));
            if (alternative !== undefined && !lateAttempt) {
                record("reroute_action", { kind: "task", id: task.id },
                    `Task layer switches to alternate Action ${alternative.id} for effect ${action.effect}`,
                    [], { alternativeActionId: alternative.id, attemptsRemaining });
                break;
            }
            const transition = propose(task.kind, task.id, "blocked", {
                reason: reasonFor(lateAttempt
                    ? `Action ${action.id} exhausted its deadline; Task ${task.id} is blocked`
                    : `Action ${action.id} exhausted the Plan attempt budget; Task ${task.id} is blocked`),
            });
            record("block_task", { kind: "task", id: task.id },
                lateAttempt ? "Action cannot retry after the Plan deadline" : "Action cannot retry: attempt budget exhausted",
                [transition], { attemptsRemaining, deadlinePassed: lateAttempt });
            break;
        }
        case "action.dead_letter": {
            const action = source as Action;
            const task = store.get("task", action.taskId);
            if (task.state === "blocked") {
                record("already_settled", { kind: "task", id: task.id }, `Task ${task.id} is already blocked`, [], { taskState: task.state });
                break;
            }
            if (!taskProgressStates.includes(task.state)) {
                throw new WorkflowError("guard_rejected", `Task ${task.id} is ${task.state}; a dead-letter Action cannot block it`);
            }
            const transition = propose(task.kind, task.id, "blocked", {
                reason: reasonFor(`Action ${action.id} is in the dead-letter queue; Task ${task.id} is blocked`),
            });
            record("block_task", { kind: "task", id: task.id },
                "Dead-letter Action escalates to a blocked Task", [transition], { actionId: action.id });
            break;
        }
        case "task.failed": {
            const task = source as Task;
            const plan = store.get("plan", task.planId);
            if (!["executing", "running", "paused"].includes(plan.state)) {
                throw new WorkflowError("guard_rejected", `Plan ${plan.id} is ${plan.state}; it cannot absorb a failed Task`);
            }
            const others = tasksOfPlan(store, plan).filter(candidate => candidate.id !== task.id);
            const progressing = others.filter(candidate => taskProgressStates.includes(candidate.state));
            const effectsCovered = task.requiredEffects.every(effect =>
                others.some(candidate => candidate.requiredEffects.includes(effect) && !taskDeadStates.includes(candidate.state)));
            const failureReason = reasonFor(`Task ${task.id} failed`);
            if (deadlinePassed(plan.bounds.deadline, decidedAt)) {
                const transition = propose(plan.kind, plan.id, "failed", { reason: reasonFor(`Plan ${plan.id} deadline passed after Task ${task.id} failed`) });
                record("fail_plan", { kind: "plan", id: plan.id },
                    "Plan deadline passed; the Plan fails instead of being retried", [transition], { deadlinePassed: true });
            } else if (progressing.length > 0 && effectsCovered) {
                record("retry_plan", { kind: "plan", id: plan.id },
                    `Redundant tasks still cover the required effects of ${task.id}; the Plan continues`,
                    [], { progressingTasks: progressing.length, effectsCovered: true });
            } else if (progressing.length > 0) {
                const transition = propose(plan.kind, plan.id, "replanning", { reason: failureReason });
                record("replan_plan", { kind: "plan", id: plan.id },
                    "Remaining tasks can progress, but the Plan must be revised", [transition], { progressingTasks: progressing.length });
            } else {
                const transition = propose(plan.kind, plan.id, "superseded", { reason: failureReason });
                record("replace_plan", { kind: "plan", id: plan.id },
                    "No productive task remains; the Plan must be replaced", [transition], { progressingTasks: 0 });
            }
            break;
        }
        case "task.blocked": {
            const task = source as Task;
            const plan = store.get("plan", task.planId);
            if (!["executing", "running", "paused"].includes(plan.state)) {
                throw new WorkflowError("guard_rejected", `Plan ${plan.id} is ${plan.state}; it cannot absorb a blocked Task`);
            }
            if (!task.required) {
                const transition = propose(task.kind, task.id, "skipped", { reason: reasonFor(`Optional Task ${task.id} is blocked and degrades the Plan`) });
                record("skip_task", { kind: "task", id: task.id }, "Optional blocked Task is skipped", [transition], { required: false });
                break;
            }
            const dependencies = task.dependsOn.map(id => store.get("task", id));
            const others = tasksOfPlan(store, plan).filter(candidate => candidate.id !== task.id);
            const deadDependency = dependencies.find(dependency => taskDeadStates.includes(dependency.state));
            if (dependencies.every(dependency => isTaskCompletedState(dependency.state))) {
                const transition = propose(task.kind, task.id, "ready", { reason: reasonFor(`Dependencies of Task ${task.id} are complete`) });
                record("unblock_task", { kind: "task", id: task.id }, "Plan layer unblocks the Task now that dependencies are complete", [transition]);
            } else if (deadDependency !== undefined) {
                const transition = propose(plan.kind, plan.id, "superseded", {
                    reason: reasonFor(`Dependency ${deadDependency.id} is ${deadDependency.state}; Plan ${plan.id} cannot recover`),
                });
                record("replace_plan", { kind: "plan", id: plan.id },
                    "A failed dependency makes the current Plan unrecoverable", [transition], { dependencyId: deadDependency.id });
            } else if (deadlinePassed(plan.bounds.deadline, decidedAt)) {
                const transition = propose(plan.kind, plan.id, "failed", { reason: reasonFor(`Plan ${plan.id} deadline passed with Task ${task.id} blocked`) });
                record("fail_plan", { kind: "plan", id: plan.id }, "Plan deadline passed while the Task was blocked", [transition]);
            } else if (others.every(candidate => !taskProgressStates.includes(candidate.state))) {
                const transition = propose(plan.kind, plan.id, "replanning", { reason: reasonFor(`All remaining tasks of Plan ${plan.id} are blocked`) });
                record("replan_plan", { kind: "plan", id: plan.id }, "No task can progress; the Plan is revised", [transition]);
            } else {
                record("wait_for_dependencies", { kind: "plan", id: plan.id },
                    "Other tasks can still progress; keep the blocked Task waiting");
            }
            break;
        }
        case "plan.failed": {
            const plan = source as Plan;
            const goal = store.get("goal", plan.goalId);
            if (goal.state !== "active") {
                if (goal.state === "blocked" || goal.state === "failed" || goal.state === "achieved") {
                    record("already_settled", { kind: "goal", id: goal.id }, `Goal ${goal.id} is already ${goal.state}`, [], { goalState: goal.state });
                    break;
                }
                throw new WorkflowError("guard_rejected", `Goal ${goal.id} is ${goal.state}; it cannot absorb a failed Plan`);
            }
            const alternatives = plansOfGoal(store, goal).filter(candidate => candidate.id !== plan.id && !["failed", "superseded"].includes(candidate.state));
            if (alternatives.length > 0) {
                record("retry_goal", { kind: "goal", id: goal.id },
                    `Goal ${goal.id} keeps an alternative Plan ${alternatives[0].id}`,
                    [], { alternativePlanId: alternatives[0].id });
            } else if (deadlinePassed(plan.bounds.deadline, decidedAt)) {
                const transition = propose(goal.kind, goal.id, "failed", { reason: reasonFor(`Plan ${plan.id} failed after its deadline`) });
                record("fail_goal", { kind: "goal", id: goal.id }, "No replacement Plan can meet the deadline", [transition]);
            } else {
                const transition = propose(goal.kind, goal.id, "blocked", { reason: reasonFor(`Plan ${plan.id} failed; Goal ${goal.id} is blocked awaiting replacement`) });
                record("block_goal", { kind: "goal", id: goal.id }, "Goal is blocked until a replacement Plan is approved", [transition]);
            }
            break;
        }
        case "plan.completed": {
            const plan = source as Plan;
            const goal = store.get("goal", plan.goalId);
            if (goal.state === "achieved") {
                record("already_settled", { kind: "goal", id: goal.id }, `Goal ${goal.id} is already achieved`, [], { goalState: goal.state });
                break;
            }
            if (goal.state !== "active") {
                throw new WorkflowError("guard_rejected", `Goal ${goal.id} is ${goal.state}; it cannot be verified from a completed Plan`);
            }
            if (event.acceptance === undefined) {
                record("verify_goal", { kind: "goal", id: goal.id },
                    "Plan completion requires independent Goal verification; no acceptance was supplied");
                break;
            }
            if (!event.acceptance.valid) {
                record("goal_verification_rejected", { kind: "goal", id: goal.id },
                    "Independent verification rejected the Goal; the Goal is not advanced", [], { verified: false });
                break;
            }
            if (!acceptanceMatches(event.acceptance, goal.contractVersion)) {
                throw new WorkflowError("guard_rejected", "Acceptance does not match the Goal contract version and evidence requirements");
            }
            const transition = propose(goal.kind, goal.id, "achieved", {
                reason: reasonFor(`Plan ${plan.id} completed and Goal ${goal.id} was independently verified`),
                cancellationEpoch: epochFor(goal),
                acceptance: event.acceptance,
            });
            record("achieve_goal", { kind: "goal", id: goal.id }, "Independent acceptance verifies the Goal", [transition],
                { verificationId: event.acceptance.verificationId });
            break;
        }
        case "goal.achieved": {
            const goal = source as Goal;
            const mission = store.get("mission", goal.missionId);
            if (mission.state === "achieved") {
                record("already_settled", { kind: "mission", id: mission.id }, `Mission ${mission.id} is already achieved`, [], { missionState: mission.state });
                break;
            }
            if (!missionOpenStates.includes(mission.state)) {
                throw new WorkflowError("guard_rejected", `Mission ${mission.id} is ${mission.state}; it cannot absorb an achieved Goal`);
            }
            const goals = goalsOfMission(store, mission);
            if (goals.length > 0 && goals.every(candidate => candidate.state === "achieved" && candidate.validity === "valid")) {
                const transition = propose(mission.kind, mission.id, "achieved", {
                    reason: reasonFor(`All Goals of Mission ${mission.id} are achieved and valid`),
                    cancellationEpoch: epochFor(mission),
                });
                record("achieve_mission", { kind: "mission", id: mission.id }, "Mission layer verifies every critical Goal", [transition],
                    { goals: goals.length });
            } else if (goals.some(candidate => ["failed", "abandoned", "blocked"].includes(candidate.state))) {
                record("mission_degraded", { kind: "mission", id: mission.id },
                    "Mission cannot achieve fully; a failed Goal requires degradation review");
            } else {
                record("await_remaining_goals", { kind: "mission", id: mission.id },
                    "Mission waits for the remaining Goals");
            }
            break;
        }
        case "goal.failed": {
            const goal = source as Goal;
            const mission = store.get("mission", goal.missionId);
            if (!missionOpenStates.includes(mission.state)) {
                if (mission.state === "achieved" || mission.state === "failed" || mission.state === "partially_achieved" || mission.state === "abandoned") {
                    record("already_settled", { kind: "mission", id: mission.id }, `Mission ${mission.id} is already ${mission.state}`, [], { missionState: mission.state });
                    break;
                }
                throw new WorkflowError("guard_rejected", `Mission ${mission.id} is ${mission.state}; it cannot absorb a failed Goal`);
            }
            const goals = goalsOfMission(store, mission);
            const unsettled = goals.filter(candidate => !goalSettledStates.includes(candidate.state));
            if (unsettled.length > 0) {
                record("await_remaining_goals", { kind: "mission", id: mission.id },
                    "Mission waits for the remaining Goals before deciding degradation", [], { remainingGoals: unsettled.length });
                break;
            }
            const anyAchieved = goals.some(candidate => candidate.state === "achieved" && candidate.validity === "valid");
            if (anyAchieved) {
                const transition = propose(mission.kind, mission.id, "partially_achieved", {
                    reason: reasonFor(`Mission ${mission.id} keeps its achieved Goals after a Goal failed`),
                    cancellationEpoch: epochFor(mission),
                });
                record("partially_achieve_mission", { kind: "mission", id: mission.id },
                    "Mission degrades to partial achievement", [transition]);
            } else {
                const transition = propose(mission.kind, mission.id, "failed", {
                    reason: reasonFor(`Mission ${mission.id} has no achieved Goal`),
                    cancellationEpoch: epochFor(mission),
                });
                record("fail_mission", { kind: "mission", id: mission.id }, "Mission fails with no achieved Goal", [transition]);
            }
            break;
        }
        case "goal.blocked": {
            const goal = source as Goal;
            const mission = store.get("mission", goal.missionId);
            if (!missionOpenStates.includes(mission.state)) {
                throw new WorkflowError("guard_rejected", `Mission ${mission.id} is ${mission.state}; it cannot absorb a blocked Goal`);
            }
            record("await_goal_unblock", { kind: "mission", id: mission.id },
                `Mission ${mission.id} waits for Goal ${goal.id} to be unblocked`, [], { goalId: goal.id });
            break;
        }
        case "mission.achieved": {
            const mission = source as Mission;
            const intent = store.get("intent", mission.intentId);
            if (intent.state === "fulfilled") {
                record("already_settled", { kind: "intent", id: intent.id }, `Intent ${intent.id} is already fulfilled`, [], { intentState: intent.state });
                break;
            }
            if (intent.state === "delegated") {
                const transition = propose(intent.kind, intent.id, "fulfilled", { reason: reasonFor(`Mission ${mission.id} achieved`) });
                record("fulfill_intent", { kind: "intent", id: intent.id }, "Achieved Mission fulfils its Intent", [transition], { backfilledDelegation: false });
                break;
            }
            if (intent.state === "accepted") {
                const delegated = propose(intent.kind, intent.id, "delegated", {
                    reason: `Record delegation of Intent ${intent.id} to Mission ${mission.id}`,
                });
                const fulfilled = propose(intent.kind, intent.id, "fulfilled", { reason: reasonFor(`Mission ${mission.id} achieved`) });
                record("fulfill_intent", { kind: "intent", id: intent.id },
                    "Achieved Mission fulfils its Intent; delegation is backfilled", [delegated, fulfilled], { backfilledDelegation: true });
                break;
            }
            throw new WorkflowError("invalid_transition", `Intent ${intent.id} is ${intent.state}; a Mission result cannot fulfil it`);
        }
        case "mission.failed":
        case "mission.partially_achieved":
        case "mission.abandoned": {
            const mission = source as Mission;
            const intent = store.get("intent", mission.intentId);
            if (intent.state === "deferred") {
                record("already_settled", { kind: "intent", id: intent.id }, `Intent ${intent.id} is already deferred`, [], { intentState: intent.state });
                break;
            }
            if (intentClosedStates.includes(intent.state) || intent.state === "fulfilled") {
                throw new WorkflowError("invalid_transition", `Intent ${intent.id} is already ${intent.state}; it cannot be deferred`);
            }
            if (intent.state !== "accepted" && intent.state !== "delegated") {
                throw new WorkflowError("invalid_transition", `Intent ${intent.id} is ${intent.state}; it cannot be deferred`);
            }
            const transition = propose(intent.kind, intent.id, "deferred", {
                reason: reasonFor(`Mission ${mission.id} ended ${mission.state}; Intent recovery conditions are required`),
            });
            record("defer_intent", { kind: "intent", id: intent.id },
                "Mission result defers the Intent for a later continuation", [transition], { missionState: mission.state });
            break;
        }
    }

    return Object.freeze({
        trigger: event.trigger,
        source: Object.freeze({ kind: source.kind, id: source.id }),
        decidedAt,
        decisions: Object.freeze(decisions),
        transitions: Object.freeze(transitions),
    });
}

/**
 * Explicit application of a `propagate` result. Each transition still passes
 * through `WorkflowStore.transition`, so its guards, version CAS and epoch
 * checks remain authoritative. Returns the applied transitions and snapshots.
 */
export function applyPropagation(store: WorkflowStore, result: PropagationResult): PropagationApplication {
    const applied: PropagationTransition[] = [];
    const entities: WorkflowEntity[] = [];
    for (const transition of result.transitions) {
        const current = store.get(transition.entityKind, transition.entityId);
        if (current.state !== transition.from) {
            throw new WorkflowError("invalid_transition", `Cannot apply ${transition.transitionId}: ${transition.entityKind} ${transition.entityId} is ${current.state}, expected ${transition.from}`);
        }
        if (current.version !== transition.expectedVersion) {
            throw new WorkflowError("version_conflict", `Cannot apply ${transition.transitionId}: expected version ${transition.expectedVersion}, current ${current.version}`);
        }
        const options: TransitionOptions = {
            expectedVersion: transition.expectedVersion,
            actor: transition.actor,
            ...(transition.reason === undefined ? {} : { reason: transition.reason }),
            ...(transition.cancellationEpoch === undefined ? {} : { cancellationEpoch: transition.cancellationEpoch }),
            ...(transition.acceptance === undefined ? {} : { acceptance: transition.acceptance }),
        };
        const entity = store.transition(
            transition.entityKind,
            transition.entityId,
            transition.to as WorkflowEntities[WorkflowKind]["state"],
            options,
        );
        applied.push(transition);
        entities.push(entity);
    }
    return Object.freeze({ applied: Object.freeze(applied), entities: Object.freeze(entities) });
}
