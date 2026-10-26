import type { DatabaseSync } from "node:sqlite";

import { requirePermission } from "../../authz/authz.ts";
import type { Subject } from "../../authz/authz.ts";
import type { RuntimeApprovalInput, RuntimeApprovalRow } from "../entity/runtimeApproval.ts";
import { RuntimeApprovalTable } from "../entity/runtimeApproval.ts";
import { BaseRepository } from "./base.ts";

export class RuntimeApprovalRepository extends BaseRepository<RuntimeApprovalRow, number> {
    constructor(db: DatabaseSync) {
        super(db, RuntimeApprovalTable);
    }

    record(input: RuntimeApprovalInput): number {
        const result = this.queries.insert({
            pid: input.pid,
            turn_id: input.turnId,
            operation_id: input.operationId,
            tool: input.tool,
            risk: input.risk,
            decision: input.decision,
            status: input.status,
            created_at: input.at,
        });
        return Number(result.lastInsertRowid);
    }

    list(pid: number, limit = 100): RuntimeApprovalRow[] {
        return this.queries.select({ where: "pid = ?", params: [pid], orderBy: "ORDER BY id DESC", limit });
    }

    /**
     * Owner (or a subject with a read grant) may read this pid's approval audit.
     */
    listForSubject(subject: Subject, pid: number, at: string, limit = 100): RuntimeApprovalRow[] {
        requirePermission(this.connection, subject, "read", { kind: "object", id: `approval:${pid}`, ownerPid: pid }, at);
        return this.list(pid, limit);
    }

    prune(before: string): number {
        const statement = this.connection.prepare("DELETE FROM runtime_approvals WHERE created_at < ?");
        return Number(statement.run(before).changes);
    }
}
