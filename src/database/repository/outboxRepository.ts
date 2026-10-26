import type { DatabaseSync, StatementResultingChanges, StatementSync } from "node:sqlite";

import type { OutboxEntity } from "../entity/outbox.ts";
import { OutboxTable } from "../entity/outbox.ts";
import type { MutationResult } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";

export class OutboxRepository extends BaseRepository<OutboxEntity, number> {
    constructor(db: DatabaseSync) {
        super(db, OutboxTable);
    }

    write(topic: string, payload: unknown, at: string): number {
        const result: MutationResult = this.queries.insert({
            topic,
            payload: JSON.stringify(payload),
            created_at: at,
            dispatched_at: null,
        });
        return Number(result.lastInsertRowid);
    }

    pending(limit = 100): OutboxEntity[] {
        return this.queries.select({
            where: "dispatched_at IS NULL",
            orderBy: "ORDER BY id ASC",
            limit,
        });
    }

    byTopic(topic: string, limit = 100): OutboxEntity[] {
        return this.queries.select({
            where: "topic = ?",
            params: [topic],
            orderBy: "ORDER BY id DESC",
            limit,
        });
    }

    countPending(): number {
        return this.queries.count("dispatched_at IS NULL");
    }

    /**
     * Delete dispatched rows older than the cutoff; topic is optional.
     */
    pruneDispatched(before: string, topic?: string): number {
        const clause: string =
            topic === (void 0) ? "dispatched_at IS NOT NULL AND dispatched_at < ?" : "dispatched_at IS NOT NULL AND dispatched_at < ? AND topic = ?";
        const statement: StatementSync = this.connection.prepare(`DELETE FROM outbox WHERE ${clause}`);
        const result: StatementResultingChanges = topic === (void 0) ? statement.run(before) : statement.run(before, topic);
        return Number(result.changes);
    }

    markDispatched(ids: readonly number[], at: string): number {
        let changed: number = 0;
        for (let index: number = 0; index < ids.length; index += 1) {
            const id: number = ids[index];
            changed += this.queries.update(id, { dispatched_at: at });
        }
        return changed;
    }
}
