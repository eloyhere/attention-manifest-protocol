import type { DatabaseSync } from "node:sqlite";

import type { StepEntity, WorkerEntity } from "../entity/worker.ts";
import { StepTable, WorkerTable } from "../entity/worker.ts";
import { BaseRepository } from "./base.ts";

/**
 * Worker heartbeat repository.
 */
export class WorkerRepository extends BaseRepository<WorkerEntity> {
    constructor(db: DatabaseSync) {
        super(db, WorkerTable);
    }

    /**
     * Read workers whose lease has expired.
     *
     * @param at - Current timestamp.
     * @returns Expired worker rows.
     */
    expired(at: string): WorkerEntity[] {
        return this.queries.select({
            where: "expires_at <= ?",
            params: [at],
            orderBy: "ORDER BY worker_id ASC",
        });
    }
}

/**
 * Execution step repository.
 */
export class StepRepository extends BaseRepository<StepEntity> {
    constructor(db: DatabaseSync) {
        super(db, StepTable);
    }

    /**
     * Read steps for one process.
     *
     * @param pid - Process id.
     * @param limit - Maximum rows.
     * @returns Step rows.
     */
    byProcess(pid: number, limit: number = 200): StepEntity[] {
        return this.queries.select({
            where: "pid = ?",
            params: [pid],
            orderBy: "ORDER BY step_id ASC",
            limit,
        });
    }

    /**
     * Read steps for one thread.
     *
     * @param tid - Thread id.
     * @param limit - Maximum rows.
     * @returns Step rows.
     */
    byThread(tid: number, limit: number = 200): StepEntity[] {
        return this.queries.select({
            where: "tid = ?",
            params: [tid],
            orderBy: "ORDER BY step_id ASC",
            limit,
        });
    }
}
