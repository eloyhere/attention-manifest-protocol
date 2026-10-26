import type { DatabaseSync } from "node:sqlite";

import type { OutboxEntity } from "../entity/outbox.ts";
import { OutboxTable } from "../entity/outbox.ts";
import { BaseRepository } from "./base.ts";

export class OutboxRepository extends BaseRepository<OutboxEntity, number> {
    constructor(db: DatabaseSync) {
        super(db, OutboxTable);
    }

    write(topic: string, payload: unknown, at: string): number {
        const result = this.queries.insert({
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

    /** Delete dispatched rows older than the cutoff; topic is optional. */
    pruneDispatched(before: string, topic?: string): number {
        const clause =
            topic === undefined ? "dispatched_at IS NOT NULL AND dispatched_at < ?" : "dispatched_at IS NOT NULL AND dispatched_at < ? AND topic = ?";
        const statement = this.connection.prepare(`DELETE FROM outbox WHERE ${clause}`);
        const result = topic === undefined ? statement.run(before) : statement.run(before, topic);
        return Number(result.changes);
    }

    markDispatched(ids: readonly number[], at: string): number {
        let changed = 0;
        for (const id of ids) {
            changed += this.queries.update(id, { dispatched_at: at });
        }
        return changed;
    }
}
