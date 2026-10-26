import type { DatabaseSync } from "node:sqlite";

import type { SessionSnapshot } from "../../runtime/session.ts";
import type { RuntimeSessionRow } from "../entity/runtimeSession.ts";
import { RuntimeSessionTable } from "../entity/runtimeSession.ts";
import { BaseRepository } from "./base.ts";

export class RuntimeSessionRepository extends BaseRepository<RuntimeSessionRow, number> {
    constructor(db: DatabaseSync) {
        super(db, RuntimeSessionTable);
    }

    load(pid: number): SessionSnapshot | undefined {
        const row = this.findById(pid);
        return row === undefined ? undefined : (JSON.parse(row.data) as SessionSnapshot);
    }

    save(pid: number, snapshot: SessionSnapshot, at: string): void {
        const data = JSON.stringify(snapshot);
        const existing = this.findById(pid);
        if (existing === undefined) {
            this.queries.insert({ pid, data, updated_at: at });
        } else {
            this.queries.update(pid, { data, updated_at: at });
        }
    }
}
