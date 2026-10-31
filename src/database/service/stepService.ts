import type { PrimaryKey } from "../entity/entity.ts";
import type { StepEntity } from "../entity/worker.ts";
import { StepRepository } from "../repository/workerRepository.ts";
import type { MutationResult } from "../sql/sql.ts";
import { Service } from "./service.ts";

export interface RecordStepInput {
    pid: number;
    tid: number;
    at: string;
    outcome: string;
    usage: string;
    note?: string;
    receiptId?: string;
}

/**
 * One service per entity: `steps`.
 */
export class StepService extends Service<StepEntity, PrimaryKey, StepRepository> {
    constructor(steps: StepRepository) {
        super(steps, "Step");
    }

    byId(stepId: number): StepEntity | undefined {
        return this.findById(stepId);
    }

    byProcess(pid: number, limit = 200): StepEntity[] {
        return this.repository.byProcess(pid, limit);
    }

    byThread(tid: number, limit = 200): StepEntity[] {
        return this.repository.byThread(tid, limit);
    }

    record(input: RecordStepInput): StepEntity {
        const result: MutationResult = this.repository.insert({
            pid: input.pid,
            tid: input.tid,
            at: input.at,
            outcome: input.outcome,
            usage: input.usage,
            note: input.note ?? null,
            receipt_id: input.receiptId ?? null,
        });
        const row: StepEntity | undefined = this.byId(Number(result.lastInsertRowid));
        if (row === (void 0)) {
            throw new Error("step was not stored");
        }
        return row;
    }
}
