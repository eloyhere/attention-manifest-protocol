import type { WorkflowEntity, WorkflowKind } from "./types.ts";

const cancellation = ["cancel_requested"] as const;
const cancelling = {
    cancel_requested: ["draining"],
    draining: ["cancelled", "completed_after_cancel", "unknown_outcome"],
};

/**
 * Legacy state names kept as aliases of the refract §4 canonical names.
 * Both spellings are accepted by `workflowTransitions`; guards and services treat
 * each alias pair as the same lifecycle position.
 */
export const PLAN_STATE_ALIASES = { ready: "approved", running: "executing" } as const;
export const TASK_STATE_ALIASES = { running: "active", succeeded: "completed" } as const;
export const ACTION_STATE_ALIASES = { running: "executing" } as const;

const planExecutingStates: readonly string[] = ["running", "executing"];
const taskActiveStates: readonly string[] = ["running", "active"];
const taskCompletedStates: readonly string[] = ["succeeded", "completed"];
const actionExecutingStates: readonly string[] = ["running", "executing"];
const settledIntentStates: readonly string[] = ["accepted", "fulfilled", "deferred", "rejected", "withdrawn", "abandoned", "superseded"];

/** Plan execution position, accepting both the §4.6 and legacy names. */
export const isPlanExecutingState = (state: string): boolean => planExecutingStates.includes(state);
/** Task active position, accepting both the §4.7 and legacy names. */
export const isTaskActiveState = (state: string): boolean => taskActiveStates.includes(state);
/** Task terminal success position, accepting both the §4.7 and legacy names. */
export const isTaskCompletedState = (state: string): boolean => taskCompletedStates.includes(state);
/** Action execution position, accepting both the §4.8 and legacy names. */
export const isActionExecutingState = (state: string): boolean => actionExecutingStates.includes(state);

/**
 * Explicit local edges. Guards in WorkflowStore additionally enforce contracts and children.
 * Every §4 state is represented here. Legacy aliases remain reachable so existing callers,
 * stored snapshots and service methods keep working.
 */
export const workflowTransitions: Readonly<Record<WorkflowKind, Readonly<Record<string, readonly string[]>>>> = {
    session: {
        created: ["active", "aborted"], active: ["idle", "suspended", "closing", "expired", "aborted"],
        idle: ["active", "suspended", "closing", "expired", "aborted"], suspended: ["resumed", "closing", "expired", "aborted"],
        resumed: ["active", "closing", "aborted"], closing: ["closed", "aborted"], closed: ["archived"],
    },
    turn: {
        received: ["interpreting", "failed"], interpreting: ["clarifying", "acting", "responding", "failed", "abandoned"],
        clarifying: ["interpreting", "abandoned", "failed"], acting: ["responding", "interrupted", "failed"],
        responding: ["completed", "failed"], interrupted: ["resumed", "abandoned"], resumed: ["acting", "abandoned", "failed"],
    },
    intent: {
        captured: ["interpreted", "confirmed", "rejected", "withdrawn", "abandoned", "superseded"],
        interpreted: ["clarifying", "rejected", "abandoned", "superseded"],
        clarifying: ["clarified", "interpreted", "abandoned", "superseded"],
        clarified: ["confirmed", "clarifying", "deferred", "abandoned", "superseded"],
        confirmed: ["accepted", "delegated", "deferred", "rejected", "withdrawn", "abandoned", "superseded"],
        accepted: ["delegated", "deferred", "abandoned", "superseded"],
        delegated: ["fulfilled", "deferred", "abandoned", "superseded"],
        deferred: ["resumed", "abandoned", "superseded"],
        resumed: ["confirmed", "abandoned", "superseded"],
        fulfilled: ["superseded"], rejected: ["superseded"], withdrawn: ["superseded"],
        abandoned: ["superseded"], superseded: [],
    },
    mission: {
        accepted: ["proposed", "active", "abandoned", "failed", ...cancellation],
        proposed: ["active", "abandoned", "failed", ...cancellation],
        active: ["achieved", "partially_achieved", "paused", "abandoned", "failed", ...cancellation],
        paused: ["resumed", "archived", "abandoned", "failed", ...cancellation],
        resumed: ["active", "paused", "abandoned", ...cancellation],
        ...cancelling, unknown_outcome: ["draining"],
    },
    goal: {
        pending: ["proposed", "active", "abandoned", "failed", ...cancellation],
        proposed: ["active", "abandoned", "failed", ...cancellation],
        active: ["achieved", "blocked", "abandoned", "failed", ...cancellation],
        blocked: ["unblocked", "failed", "abandoned", ...cancellation],
        unblocked: ["active", "blocked", "abandoned", ...cancellation],
        ...cancelling, unknown_outcome: ["draining"],
    },
    plan: {
        draft: ["ready", "approved", "superseded", ...cancellation],
        approved: ["ready", "running", "executing", "superseded", ...cancellation],
        ready: ["approved", "running", "executing", "superseded", ...cancellation],
        executing: ["completed", "failed", "paused", "replanning", "superseded", ...cancellation],
        running: ["completed", "failed", "paused", "replanning", "superseded", ...cancellation],
        paused: ["executing", "running", "replanning", "failed", "superseded", ...cancellation],
        replanning: ["approved", "ready", "superseded", ...cancellation],
        ...cancelling, unknown_outcome: ["draining"],
    },
    task: {
        pending: ["proposed", "ready", "blocked", "skipped", ...cancellation],
        proposed: ["ready", "blocked", "skipped", ...cancellation],
        ready: ["running", "active", "blocked", "skipped", ...cancellation],
        running: ["succeeded", "completed", "failed", "blocked", "paused", "dead_letter", ...cancellation],
        active: ["succeeded", "completed", "failed", "blocked", "paused", "dead_letter", ...cancellation],
        paused: ["running", "active", "failed", ...cancellation],
        blocked: ["ready", "unblocked", "failed", "skipped", ...cancellation],
        unblocked: ["ready", "failed", ...cancellation],
        ...cancelling, unknown_outcome: ["draining"],
    },
    action: {
        declared: ["pending", "ready", ...cancellation],
        pending: ["ready", "skipped", ...cancellation],
        ready: ["running", "executing", "skipped", ...cancellation],
        running: ["succeeded", "failed", "unknown_outcome", ...cancellation],
        executing: ["succeeded", "failed", "unknown_outcome", ...cancellation],
        failed: ["ready", "retrying", "dead_letter", "skipped"],
        retrying: ["ready", "executing", "dead_letter"],
        unknown_outcome: ["reconciling"],
        reconciling: ["succeeded", "failed", "cancelled", "completed_after_cancel", "unknown_outcome"],
        ...cancelling,
    },
};
export const initialWorkflowStates = {
    session: "created", turn: "received", intent: "captured", mission: "accepted", goal: "pending", plan: "draft", task: "pending", action: "declared",
} as const;
export function isWorkflowTerminal(entity: WorkflowEntity): boolean {
    return !(workflowTransitions[entity.kind][entity.state]?.length);
}
/**
 * Session closure treats resolved intents as settled even though `superseded` remains
 * reachable from every Intent state (§4.3 "any state -> superseded"). All other
 * entities only settle by becoming graph-terminal.
 */
export function isWorkflowSettled(entity: WorkflowEntity): boolean {
    return isWorkflowTerminal(entity) || (entity.kind === "intent" && settledIntentStates.includes(entity.state));
}
