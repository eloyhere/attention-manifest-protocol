import type { DatabaseSync } from "node:sqlite";

import type { ThreadEntity } from "../entity/thread.ts";
import { ThreadTable } from "../entity/thread.ts";
import { BaseRepository } from "./base.ts";

/**
 * Thread/task repository.
 */
export class ThreadRepository extends BaseRepository<ThreadEntity> {
    constructor(db: DatabaseSync) {
        super(db, ThreadTable);
    }

    /**
     * Read threads owned by one process.
     *
     * @param pid - Process id.
     * @returns Thread rows.
     */
    byProcess(pid: number): ThreadEntity[] {
        return this.queries.select({
            where: "pid = ?",
            params: [pid],
            orderBy: "ORDER BY tid ASC",
        });
    }

    /**
     * Read threads with one goal string.
     *
     * @param goal - Goal text.
     * @returns Thread rows.
     */
    byGoal(goal: string): ThreadEntity[] {
        return this.queries.select({
            where: "goal = ?",
            params: [goal],
            orderBy: "ORDER BY tid ASC",
        });
    }

    /**
     * Find the next runnable thread whose process can run.
     *
     * @returns The ready thread, or `undefined`.
     */
    nextReady(): ThreadEntity | undefined {
        return this.queries.queryOne<ThreadEntity>(
            `SELECT t.* FROM threads t
             JOIN processes p ON p.pid = t.pid
             WHERE t.state = 'ready' AND p.state IN ('created','idle','running')
             ORDER BY t.priority DESC, t.tid ASC
             LIMIT 1`,
        );
    }
}
