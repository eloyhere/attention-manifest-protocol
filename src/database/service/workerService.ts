import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { WorkerEntity } from "../entity/worker.ts";
import { WorkerRepository } from "../repository/workerRepository.ts";
import { heartbeatWorker, listWorkers, recoverExpiredWorkers, registerWorker, unregisterWorker } from "../../concurrency/worker.ts";
import type { WorkerInput, WorkerRecord } from "../../concurrency/worker.ts";
import { Service } from "./service.ts";

/**
 * Counts returned after recovering expired workers.
 */
export interface WorkerRecovery {
    workers: string[];
    threads: number;
    processes: number;
}

/**
 * One service per entity: `workers`.
 */
export class WorkerService extends Service<WorkerEntity, PrimaryKey, WorkerRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, workers: WorkerRepository) {
        super(workers, "Worker");
        this.db = db;
    }

    byId(workerId: string): WorkerEntity | undefined {
        return this.findById(workerId);
    }

    list(): WorkerRecord[] {
        return listWorkers(this.db);
    }

    expired(at: string): WorkerEntity[] {
        return this.repository.expired(at);
    }

    register(input: WorkerInput, at: string): WorkerRecord {
        return registerWorker(this.db, input, at);
    }

    heartbeat(workerId: string, at: string, leaseMs?: number): boolean {
        return heartbeatWorker(this.db, workerId, at, leaseMs);
    }

    unregister(workerId: string): void {
        unregisterWorker(this.db, workerId);
    }

    recover(at: string): WorkerRecovery {
        return recoverExpiredWorkers(this.db, at);
    }
}
