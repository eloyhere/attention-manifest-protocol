import type { TableMeta } from "./meta.ts";

export interface RuntimeApprovalRow {
    id: number;
    pid: number;
    turn_id: string;
    operation_id: string;
    tool: string;
    risk: string;
    decision: string;
    status: string;
    created_at: string;
}

export const RuntimeApprovalTable: TableMeta = {
    table: "runtime_approvals",
    primaryKey: "id",
    columns: ["id", "pid", "turn_id", "operation_id", "tool", "risk", "decision", "status", "created_at"],
};

export interface RuntimeApprovalInput {
    pid: number;
    turnId: string;
    operationId: string;
    tool: string;
    risk: string;
    decision: string;
    status: string;
    at: string;
}
