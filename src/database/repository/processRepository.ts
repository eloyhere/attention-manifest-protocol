import type { DatabaseSync } from "node:sqlite";

import type { ProcessEntity } from "../entity/process.ts";
import { ProcessTable } from "../entity/process.ts";
import { BaseRepository } from "./base.ts";

/**
 * Process/agent repository.
 */
export class ProcessRepository extends BaseRepository<ProcessEntity> {
    constructor(db: DatabaseSync) {
        super(db, ProcessTable);
    }

    /**
     * Find a process by its public id.
     *
     * @param id - Public process id.
     * @returns The process row, or `undefined`.
     */
    byPublicId(id: string): ProcessEntity | undefined {
        const rows: ProcessEntity[] = this.where("id = ?", id);
        return rows.length === 0 ? (void 0) : rows[0];
    }

    /**
     * Read processes in one state.
     *
     * @param state - Process state.
     * @param limit - Maximum rows.
     * @returns Process rows.
     */
    byState(state: string, limit: number = 100): ProcessEntity[] {
        return this.queries.select({
            where: "state = ?",
            params: [state],
            orderBy: "ORDER BY priority DESC, pid ASC",
            limit,
        });
    }

    /**
     * Agents that have at least one runnable task.
     *
     * @param limit - Maximum rows.
     * @returns Process rows.
     */
    runnable(limit: number = 100): ProcessEntity[] {
        return this.queries.query<ProcessEntity>(
            `SELECT p.* FROM processes p
             WHERE p.state IN ('created','idle','running')
               AND EXISTS (SELECT 1 FROM threads t WHERE t.pid = p.pid AND t.state = 'ready')
             ORDER BY p.priority DESC, p.pid ASC
             LIMIT ?`,
            limit,
        );
    }
}
