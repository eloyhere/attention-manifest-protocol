/**
 * Worker registry: who is allowed to run threads right now.
 *
 * A worker registers with a lease and heartbeats on every step. Another worker
 * may recover only threads whose owner's lease has expired; a stale owner's
 * writes are rejected by the fencing token (`threads.lease`), not by a wall
 * clock comparison inside the handler.
 */
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";

export interface WorkerInput {
    workerId: string;
    host?: string;
    pid?: number;
    leaseMs?: number;
}

export interface WorkerRecord {
    workerId: string;
    host?: string;
    pid?: number;
    startedAt: string;
    heartbeatAt: string;
    expiresAt: string;
}

type WorkerRow = {
    worker_id: string;
    host: string | null;
    pid: number | null;
    started_at: string;
    heartbeat_at: string;
    expires_at: string;
};

type ExpiredWorkerRow = {
    worker_id: string;
};

type RecoveryReport = {
    workers: string[];
    threads: number;
    processes: number;
};

type WorkerRegistrar = (db: DatabaseSync, input: WorkerInput, at: string) => WorkerRecord;

type WorkerHeartbeater = (db: DatabaseSync, workerId: string, at: string, leaseMs?: number) => boolean;

const expiry: (at: string, leaseMs: number) => string = (at: string, leaseMs: number): string => new Date(Date.parse(at) + leaseMs).toISOString();

const toRecord: (row: WorkerRow) => WorkerRecord = (row: WorkerRow): WorkerRecord => {
    const record: WorkerRecord = {
        workerId: row.worker_id,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        expiresAt: row.expires_at,
    };
    if (row.host !== null) {
        record.host = row.host;
    }
    if (row.pid !== null) {
        record.pid = row.pid;
    }
    return record;
};

export const registerWorker: WorkerRegistrar = (db: DatabaseSync, input: WorkerInput, at: string): WorkerRecord => {
    const leaseMs: number = input.leaseMs ?? 15_000;
    const expiresAt: string = expiry(at, leaseMs);
    db.prepare(
        `INSERT INTO workers (worker_id, host, pid, started_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           host = excluded.host,
           pid = excluded.pid,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at`,
    ).run(input.workerId, input.host ?? null, input.pid ?? null, at, at, expiresAt);
    const row: WorkerRow = db.prepare("SELECT * FROM workers WHERE worker_id = ?").get(input.workerId) as unknown as WorkerRow;
    return toRecord(row);
};

export const heartbeatWorker: WorkerHeartbeater = (db: DatabaseSync, workerId: string, at: string, leaseMs: number = 15_000): boolean => {
    const result: StatementResultingChanges = db
        .prepare("UPDATE workers SET heartbeat_at = ?, expires_at = ? WHERE worker_id = ?")
        .run(at, expiry(at, leaseMs), workerId);
    return Number(result.changes) === 1;
};

export const unregisterWorker: (db: DatabaseSync, workerId: string) => void = (db: DatabaseSync, workerId: string): void => {
    db.prepare("DELETE FROM workers WHERE worker_id = ?").run(workerId);
};

export const listWorkers: (db: DatabaseSync) => WorkerRecord[] = (db: DatabaseSync): WorkerRecord[] => {
    const rows: WorkerRow[] = db.prepare("SELECT * FROM workers ORDER BY worker_id ASC").all() as unknown as WorkerRow[];
    return rows.map(toRecord);
};

/**
 * Recover threads owned by workers whose lease has expired.
 *
 * The lease is bumped while requeueing, so the old owner's next
 * `transitionThread(..., lease)` fails with `lease_lost` even if it wakes up.
 */
export const recoverExpiredWorkers: (db: DatabaseSync, at: string) => RecoveryReport = (db: DatabaseSync, at: string): RecoveryReport => {
    const expired: ExpiredWorkerRow[] = db.prepare("SELECT worker_id FROM workers WHERE expires_at <= ?").all(at) as ExpiredWorkerRow[];
    let threads: number = 0;
    for (let index: number = 0; index < expired.length; index += 1) {
        const worker: ExpiredWorkerRow = expired[index];
        const result: StatementResultingChanges = db
            .prepare(
                "UPDATE threads SET state = 'ready', owner_worker = NULL, lease = lease + 1, slice_used_ms = 0 WHERE state = 'running' AND owner_worker = ?",
            )
            .run(worker.worker_id);
        threads += Number(result.changes);
    }
    db.prepare("DELETE FROM workers WHERE expires_at <= ?").run(at);
    const processes: StatementResultingChanges = db
        .prepare(
            `UPDATE processes SET state = 'idle'
             WHERE state = 'running'
               AND EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'ready')
               AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'running')`,
        )
        .run();
    return { workers: expired.map((worker) => worker.worker_id), threads, processes: Number(processes.changes) };
};
