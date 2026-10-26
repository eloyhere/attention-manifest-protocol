import type { DatabaseSync } from "node:sqlite";

import type { PrimaryKey } from "../entity/entity.ts";
import type { ThreadEntity } from "../entity/thread.ts";
import { ThreadRepository } from "../repository/threadRepository.ts";
import { claimThread, getThread, listThreads, nextReadyThread, spawnThread, transitionThread } from "../../thread/thread.ts";
import type { ThreadClaim, ThreadPatch, ThreadRecord, ThreadSpec, ThreadState } from "../../thread/thread.ts";
import { Service } from "./service.ts";

/**
 * One service per entity: `threads`.
 */
export class ThreadService extends Service<ThreadEntity, PrimaryKey, ThreadRepository> {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync, threads: ThreadRepository) {
        super(threads, "Thread");
        this.db = db;
    }

    byId(tid: number): ThreadEntity | undefined {
        return this.findById(tid);
    }

    byProcess(pid: number): ThreadEntity[] {
        return this.repository.byProcess(pid);
    }

    byGoal(goal: string): ThreadEntity[] {
        return this.repository.byGoal(goal);
    }

    nextReady(): ThreadEntity | undefined {
        return this.repository.nextReady();
    }

    spawn(spec: ThreadSpec, at: string): ThreadEntity {
        const record: ThreadRecord = spawnThread(this.db, spec, at);
        const row: ThreadEntity | undefined = this.byId(record.tid);
        if (row === (void 0)) {
            throw new Error(`thread ${record.tid} was not stored`);
        }
        return row;
    }

    record(tid: number): ThreadRecord {
        return getThread(this.db, tid);
    }

    list(pid?: number): ThreadRecord[] {
        return listThreads(this.db, pid);
    }

    claim(tid: number, workerId: string): ThreadClaim {
        return claimThread(this.db, tid, workerId);
    }

    transition(tid: number, from: ThreadState | ThreadState[], to: ThreadState, patch: ThreadPatch = {}, lease?: number): ThreadRecord {
        return transitionThread(this.db, tid, from, to, patch, lease);
    }

    ready(): ThreadRecord | undefined {
        return nextReadyThread(this.db);
    }
}
