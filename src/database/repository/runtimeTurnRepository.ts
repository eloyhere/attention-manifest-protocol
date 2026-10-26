import type { DatabaseSync } from "node:sqlite";

import type { RuntimeTurn } from "../../runtime/cognitiveRuntime.ts";
import type { RuntimeTurnRow } from "../entity/runtimeTurn.ts";
import { RuntimeTurnTable } from "../entity/runtimeTurn.ts";
import { BaseRepository } from "./base.ts";

export class RuntimeTurnRepository extends BaseRepository<RuntimeTurnRow, string> {
    constructor(db: DatabaseSync) {
        super(db, RuntimeTurnTable);
    }

    save(turn: RuntimeTurn): void {
        const data: string = JSON.stringify(turn);
        const existing: RuntimeTurnRow | undefined = this.findById(turn.turnId);
        if (existing === (void 0)) {
            this.queries.insert({
                id: turn.turnId,
                pid: turn.pid,
                session_id: turn.sessionId ?? null,
                data,
                created_at: turn.at,
            });
        } else {
            this.queries.update(turn.turnId, { data });
        }
    }

    get(turnId: string): RuntimeTurn | undefined {
        const row: RuntimeTurnRow | undefined = this.findById(turnId);
        return row === (void 0) ? undefined : (JSON.parse(row.data) as RuntimeTurn);
    }

    list(pid: number, limit = 100): RuntimeTurn[] {
        return this.queries
            .select({ where: "pid = ?", params: [pid], orderBy: "ORDER BY created_at DESC", limit })
            .map((row) => JSON.parse(row.data) as RuntimeTurn);
    }
}
