import type { WorkflowEntity, WorkflowKind } from "./types.ts";

const cancellation = ["cancel_requested"] as const;
const cancelling = {
    cancel_requested: ["draining"],
    draining: ["cancelled", "completed_after_cancel", "unknown_outcome"],
};
/** Explicit local edges. Guards in WorkflowStore additionally enforce contracts and children. */
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
    intent: { captured: ["confirmed", "rejected", "withdrawn"], confirmed: ["accepted", "rejected", "withdrawn"] },
    mission: {
        accepted: ["active", "failed", ...cancellation], active: ["achieved", "failed", ...cancellation], ...cancelling,
        unknown_outcome: ["draining"],
    },
    goal: {
        pending: ["active", "failed", ...cancellation], active: ["achieved", "failed", ...cancellation], ...cancelling,
        unknown_outcome: ["draining"],
    },
    plan: {
        draft: ["ready", "superseded", ...cancellation], ready: ["running", "superseded", ...cancellation],
        running: ["completed", "failed", "superseded", ...cancellation], ...cancelling, unknown_outcome: ["draining"],
    },
    task: {
        pending: ["ready", "blocked", "skipped", ...cancellation], ready: ["running", "blocked", "skipped", ...cancellation],
        blocked: ["ready", "failed", "skipped", ...cancellation], running: ["succeeded", "failed", "blocked", ...cancellation],
        ...cancelling, unknown_outcome: ["draining"],
    },
    action: {
        declared: ["ready", ...cancellation], ready: ["running", ...cancellation], running: ["succeeded", "failed", "unknown_outcome", ...cancellation],
        failed: ["ready"], unknown_outcome: ["reconciling"], reconciling: ["succeeded", "failed", "cancelled", "completed_after_cancel", "unknown_outcome"],
        ...cancelling,
    },
};
export const initialWorkflowStates = {
    session: "created", turn: "received", intent: "captured", mission: "accepted", goal: "pending", plan: "draft", task: "pending", action: "declared",
} as const;
export function isWorkflowTerminal(entity: WorkflowEntity): boolean {
    return !(workflowTransitions[entity.kind][entity.state]?.length);
}
