/**
 * Operation = atomic execution primitive. Only operations touch external state.
 */
export type OperationId = string;

export type OperationKind = "llm.complete" | "tool.call" | "memory.write" | "policy.check" | "human.handoff";

export type SideEffect = "none" | "read" | "write" | "destructive";

export type OperationStatus = "running" | "ok" | "error" | "denied";

export interface OperationRecord {
    id: OperationId;
    actionId: string;
    kind: OperationKind;
    input: unknown;
    executor: string;
    sideEffect: SideEffect;
    idempotencyKey?: string;
    timeoutMs?: number;
    status: OperationStatus;
    result?: unknown;
    evidenceId?: string;
}

/** Independent audit record for a tool approval/denial. */
export interface ApprovalRecord {
    operationId: string;
    tool: string;
    risk: SideEffect;
    decision: string;
    status: "allowed" | "denied" | "not_required";
}
