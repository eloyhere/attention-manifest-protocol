/**
 * Address-space adapter: process_objects <-> objects.
 *
 * This is a separate aggregate from the execution state machine, so it gets its
 * own repository instead of bloating ExecutionRepository.
 */
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";

import type { AddressMode, AddressRole, ProcessObjectRecord } from "../../process/process.ts";

/**
 * Shape of the row returned by the object existence probe.
 */
type SeqRow = {
    seq: number;
};

export class AddressSpaceRepository {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync) {
        this.db = db;
    }

    hasObject(seq: number): boolean {
        const row: SeqRow | undefined = this.db.prepare("SELECT seq FROM objects WHERE seq = ?").get(seq) as SeqRow | undefined;
        return row !== (void 0);
    }

    attach(pid: number, seq: number, role: AddressRole, mode: AddressMode, at: string): void {
        this.db.prepare("INSERT OR REPLACE INTO process_objects (pid, seq, role, mode, attached_at) VALUES (?, ?, ?, ?, ?)").run(pid, seq, role, mode, at);
    }

    list(pid: number): ProcessObjectRecord[] {
        return this.db
            .prepare(
                `SELECT o.seq, o.kind, o.id, o.body, p.role, p.mode
                 FROM process_objects p JOIN objects o ON o.seq = p.seq
                 WHERE p.pid = ? ORDER BY o.seq ASC`,
            )
            .all(pid) as unknown as ProcessObjectRecord[];
    }

    read(pid: number, seq: number): ProcessObjectRecord | undefined {
        return this.db
            .prepare(
                `SELECT o.seq, o.kind, o.id, o.body, p.role, p.mode
                 FROM process_objects p JOIN objects o ON o.seq = p.seq
                 WHERE p.pid = ? AND p.seq = ?`,
            )
            .get(pid, seq) as unknown as ProcessObjectRecord | undefined;
    }

    fork(parentPid: number, childPid: number, at: string): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO process_objects (pid, seq, role, mode, attached_at)
                 SELECT ?, seq, 'inherited', 'read', ? FROM process_objects WHERE pid = ?`,
            )
            .run(childPid, at, parentPid);
    }

    join(parentPid: number, childPid: number, at: string): number {
        const result: StatementResultingChanges = this.db
            .prepare(
                `INSERT OR REPLACE INTO process_objects (pid, seq, role, mode, attached_at)
                 SELECT ?, seq, 'joined', 'read', ? FROM process_objects WHERE pid = ? AND role = 'own'`,
            )
            .run(parentPid, at, childPid);
        return Number(result.changes);
    }
}
