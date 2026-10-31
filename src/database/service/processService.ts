import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { ProcessEntity } from "../entity/process.ts";
import { ProcessRepository } from "../repository/processRepository.ts";
import { createProcess, getProcess, listProcesses, terminateProcess, transitionProcess } from "../../process/process.ts";
import type { ProcessPatch, ProcessRecord, ProcessSpec, ProcessState } from "../../process/process.ts";
import { Service } from "./service.ts";

/**
 * One service per entity: `processes`.
 */
export class ProcessService extends Service<ProcessEntity, PrimaryKey, ProcessRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, processes: ProcessRepository) {
        super(processes, "Process");
        this.db = db;
    }

    byId(pid: number): ProcessEntity | undefined {
        return this.findById(pid);
    }

    byPublicId(id: string): ProcessEntity | undefined {
        return this.repository.byPublicId(id);
    }

    byState(state: string, limit = 100): ProcessEntity[] {
        return this.repository.byState(state, limit);
    }

    runnable(limit = 100): ProcessEntity[] {
        return this.repository.runnable(limit);
    }

    create(spec: ProcessSpec, at: string): ProcessEntity {
        const record: ProcessRecord = createProcess(this.db, spec, at);
        const row: ProcessEntity | undefined = this.byId(record.pid);
        if (row === (void 0)) {
            throw new Error(`process ${record.pid} was not stored`);
        }
        return row;
    }

    record(pid: number): ProcessRecord {
        return getProcess(this.db, pid);
    }

    list(state?: ProcessState): ProcessRecord[] {
        return listProcesses(this.db, state);
    }

    transition(pid: number, from: ProcessState | ProcessState[], to: ProcessState, patch: ProcessPatch = {}): ProcessRecord {
        return transitionProcess(this.db, pid, from, to, patch);
    }

    terminate(pid: number, note: string, at: string, code = "TERMINATED"): ProcessRecord {
        return terminateProcess(this.db, pid, note, at, code);
    }
}
