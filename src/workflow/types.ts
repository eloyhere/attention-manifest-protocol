import type { Budget, Identifier } from "../shared.ts";

export type CancellationState = "cancel_requested" | "draining" | "cancelled" | "completed_after_cancel" | "unknown_outcome";
export type { SessionState, Session } from "../session/types.ts";
import type { Session } from "../session/types.ts";
export type { TurnState, Turn } from "../turn/types.ts";
import type { Turn } from "../turn/types.ts";
export type { IntentState, Intent } from "../intent/types.ts";
import type { Intent } from "../intent/types.ts";
export type { MissionState, Mission } from "../mission/types.ts";
import type { Mission } from "../mission/types.ts";
export type { GoalState, Goal } from "../goal/types.ts";
import type { Goal } from "../goal/types.ts";
export type { PlanState, Plan } from "../plan/types.ts";
import type { Plan } from "../plan/types.ts";
export type { TaskState, Task } from "../task/types.ts";
import type { Task } from "../task/types.ts";
export type { ActionState, Action } from "../action/types.ts";
import type { Action } from "../action/types.ts";
export type WorkflowKind = "session" | "turn" | "intent" | "mission" | "goal" | "plan" | "task" | "action";

export interface VersionedEntity<K extends WorkflowKind, S extends string> {
    readonly kind: K;
    readonly id: Identifier;
    readonly sessionId: Identifier;
    readonly originTurnId?: Identifier;
    readonly state: S;
    readonly version: number;
    readonly cancellationEpoch: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly budget?: Budget;
}

export type InputClassification = "steering" | "status" | "cancel" | "new_intent";



/** Independent L6/L7 input; receipts or action success alone never satisfy it. */
export interface Acceptance {
    readonly contractVersion: string;
    readonly verificationId: Identifier;
    readonly evidenceIds: readonly Identifier[];
    readonly valid: boolean;
}

/** All retries/replans must be bounded by the host; this module performs no retries. */
export interface ProgressBounds {
    readonly maxAttempts: number;
    readonly deadline: string;
    readonly progressMetric: string;
    readonly deadLetterOwner: Identifier;
}


export type RecoveryMode = "idempotent" | "query" | "reconcile" | "compensate";

export interface WorkflowEntities {
    session: Session;
    turn: Turn;
    intent: Intent;
    mission: Mission;
    goal: Goal;
    plan: Plan;
    task: Task;
    action: Action;
}
export type WorkflowEntity = WorkflowEntities[WorkflowKind];
export type CreateEntity<K extends WorkflowKind> = Omit<WorkflowEntities[K], "kind" | "state" | "version" | "cancellationEpoch" | "createdAt" | "updatedAt" | "attemptIds" | "validity" | "achievedAt" | "assessment" | "correctivePlanId">;

/** Execution belongs to stable work, and may settle after its origin Turn ends. */
export interface ActionAttempt {
    readonly executionId: Identifier;
    readonly operationId: Identifier;
    readonly attemptId: Identifier;
    readonly actionId: Identifier;
    readonly sessionId: Identifier;
    readonly originTurnId?: Identifier;
    readonly observedInTurnId?: Identifier;
    readonly cancellationEpoch: number;
    readonly version: number;
    readonly state: "running" | "succeeded" | "failed" | "cancelled" | "unknown_outcome";
    readonly startedAt: string;
    readonly settledAt?: string;
}
export interface TransitionOptions {
    readonly expectedVersion: number;
    readonly actor: Identifier;
    /** Required for execution/commit admission, checked against all ancestors. */
    readonly cancellationEpoch?: number;
    readonly acceptance?: Acceptance;
    readonly clarification?: { readonly replyTo: Identifier; readonly continuationKey: string };
    readonly reason?: string;
}
export interface WorkflowEvent {
    readonly sequence: number;
    readonly entityKind: WorkflowKind;
    readonly entityId: Identifier;
    readonly eventType: string;
    readonly from: string;
    readonly to: string;
    readonly expectedVersion: number;
    readonly version: number;
    readonly actor: Identifier;
    readonly cancellationEpoch: number;
    readonly timestamp: string;
    readonly reason?: string;
}
/** JSON-compatible pure state. Restoring never dispatches an execution. */
export interface WorkflowSnapshot {
    readonly schemaVersion: 1;
    readonly sequence: number;
    readonly cancellationEpoch: number;
    readonly entities: readonly WorkflowEntity[];
    readonly attempts: readonly ActionAttempt[];
    readonly events: readonly WorkflowEvent[];
}
export type WorkflowErrorCode = "invalid_snapshot" | "not_found" | "duplicate" | "version_conflict" | "invalid_transition" | "invalid_reference" | "guard_rejected" | "stale_epoch" | "unsettled_work" | "unsafe_retry";
export class WorkflowError extends Error {
    readonly code: WorkflowErrorCode;
    constructor(code: WorkflowErrorCode, message: string) {
        super(message);
        this.name = "WorkflowError";
        this.code = code;
    }
}

