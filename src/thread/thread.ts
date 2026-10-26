/**
 * Thread: one task (or goal) that an agent is executing.
 *
 * The agent is the process; a thread is the unit of work the CPU-like scheduler
 * runs. Multiple tasks may be ready for the same agent, but at most one may be
 * `running` at a time (a partial unique index enforces it): an agent does one
 * thing at a time, and switches by scheduling another thread.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Budget, Criterion, Id, Usage } from "../types/common.ts";
import { isId } from "../boundary/ids.ts";
import { KernelError } from "../error/kernelError.ts";
import { getProcess } from "../process/process.ts";

export type ThreadState = "ready" | "running" | "blocked" | "done" | "failed" | "abandoned";

export interface ThreadSpec {
    /** Defaults to `t.<pid>.<n>`; must satisfy the AMP id grammar. */
    id?: Id;
    pid: number;
    /** Goal this task serves. */
    goal: Id;
    statement: string;
    /** At least one observable completion criterion. */
    success: Criterion[];
    priority?: number;
    budget?: Budget;
    quantumMs?: number;
}

export interface ThreadRecord {
    tid: number;
    id: Id;
    pid: number;
    goal: Id;
    statement: string;
    success: Criterion[];
    state: ThreadState;
    priority: number;
    quantumMs: number;
    sliceUsedMs: number;
    budget: Budget;
    used: Usage;
    blockedOn?: string;
    wakeAt?: string;
    createdAt: string;
    finishedAt?: string;
    exitNote?: string;
    ownerWorker?: string;
    lease: number;
    version: number;
}

interface ThreadRow {
    tid: number;
    id: string;
    pid: number;
    goal: string;
    statement: string;
    success: string;
    state: ThreadState;
    priority: number;
    quantum_ms: number;
    slice_used_ms: number;
    budget: string;
    used: string;
    blocked_on: string | null;
    wake_at: string | null;
    created_at: string;
    finished_at: string | null;
    exit_note: string | null;
    owner_worker: string | null;
    lease: number;
    version: number;
}

export interface ThreadPatch {
    blockedOn?: string | null;
    wakeAt?: string | null;
    sliceUsedMs?: number;
    finishedAt?: string;
    exitNote?: string;
}

/** Task lifecycle. `done`, `failed` and `abandoned` are terminal. */
const ThreadEdges: Record<ThreadState, readonly ThreadState[]> = {
    ready: ["running", "failed", "abandoned"],
    running: ["ready", "blocked", "done", "failed", "abandoned"],
    blocked: ["ready", "done", "failed", "abandoned"],
    done: [],
    failed: [],
    abandoned: [],
};

const toRecord = (row: ThreadRow): ThreadRecord => {
    const record: ThreadRecord = {
        tid: row.tid,
        id: row.id,
        pid: row.pid,
        goal: row.goal,
        statement: row.statement,
        success: JSON.parse(row.success) as Criterion[],
        state: row.state,
        priority: row.priority,
        quantumMs: row.quantum_ms,
        sliceUsedMs: row.slice_used_ms,
        budget: JSON.parse(row.budget) as Budget,
        used: JSON.parse(row.used) as Usage,
        createdAt: row.created_at,
        lease: row.lease,
        version: row.version,
    };
    if (row.blocked_on !== null) record.blockedOn = row.blocked_on;
    if (row.wake_at !== null) record.wakeAt = row.wake_at;
    if (row.finished_at !== null) record.finishedAt = row.finished_at;
    if (row.exit_note !== null) record.exitNote = row.exit_note;
    if (row.owner_worker !== null) record.ownerWorker = row.owner_worker;
    return record;
};

const getRow = (db: DatabaseSync, tid: number): ThreadRow => {
    const row = db.prepare("SELECT * FROM threads WHERE tid = ?").get(tid) as unknown as ThreadRow | undefined;
    if (row === undefined) throw new KernelError("unknown_thread", [`tid ${tid}`]);
    return row;
};

export const getThread = (db: DatabaseSync, tid: number): ThreadRecord => toRecord(getRow(db, tid));

export const findThread = (db: DatabaseSync, id: Id): ThreadRecord | undefined => {
    const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as unknown as ThreadRow | undefined;
    return row === undefined ? undefined : toRecord(row);
};

export const listThreads = (db: DatabaseSync, pid?: number): ThreadRecord[] => {
    const rows =
        pid === undefined
            ? (db.prepare("SELECT * FROM threads ORDER BY tid ASC").all() as unknown as ThreadRow[])
            : (db.prepare("SELECT * FROM threads WHERE pid = ? ORDER BY tid ASC").all(pid) as unknown as ThreadRow[]);
    return rows.map(toRecord);
};

export const spawnThread = (db: DatabaseSync, spec: ThreadSpec, at: string): ThreadRecord => {
    const agent = getProcess(db, spec.pid);
    if (!["created", "idle", "running"].includes(agent.state)) {
        throw new KernelError("invalid_transition", [`agent ${agent.id} is ${agent.state}`]);
    }
    if (!isId(spec.goal)) throw new KernelError("invalid_thread", [`goal ${spec.goal} is not a valid AMP id`]);
    if (spec.statement.trim().length === 0) throw new KernelError("invalid_thread", ["statement is empty"]);
    if (!Array.isArray(spec.success) || spec.success.length === 0) {
        throw new KernelError("invalid_thread", ["success must contain at least one criterion"]);
    }
    for (const criterion of spec.success) {
        if (!isId(criterion.id) || criterion.statement.trim().length === 0 || criterion.check.trim().length === 0) {
            throw new KernelError("invalid_thread", [`criterion ${criterion.id} is incomplete`]);
        }
    }
    const duplicate = db.prepare("SELECT tid FROM threads WHERE pid = ? AND goal = ? AND state IN ('ready','running','blocked')").get(spec.pid, spec.goal) as
        { tid: number } | undefined;
    if (duplicate !== undefined) {
        throw new KernelError("duplicate_task", [`goal ${spec.goal} already has active task ${duplicate.tid}`]);
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE pid = ?").get(spec.pid) as { n: number };
    const id: Id = spec.id ?? `t.${spec.pid}.${count.n + 1}`;
    if (!isId(id)) throw new KernelError("invalid_thread", [`id ${id} is not a valid AMP id`]);
    const result = db
        .prepare(
            "INSERT INTO threads (id, pid, goal, statement, success, state, priority, quantum_ms, slice_used_ms, budget, used, created_at) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, 0, ?, ?, ?)",
        )
        .run(
            id,
            spec.pid,
            spec.goal,
            spec.statement,
            JSON.stringify(spec.success),
            spec.priority ?? 0,
            spec.quantumMs ?? 1000,
            JSON.stringify(spec.budget ?? {}),
            JSON.stringify({ tokens: 0, ms: 0, calls: 0, interrupts: 0, money: 0 }),
            at,
        );
    return getThread(db, Number(result.lastInsertRowid));
};

/** Oldest highest-priority task whose agent may run it. */
export const nextReadyThread = (db: DatabaseSync): ThreadRecord | undefined => {
    const row = db
        .prepare(
            `SELECT t.* FROM threads t
             JOIN processes p ON p.pid = t.pid
             WHERE t.state = 'ready' AND p.state IN ('created','idle','running')
             ORDER BY t.priority DESC, t.tid ASC
             LIMIT 1`,
        )
        .get() as unknown as ThreadRow | undefined;
    return row === undefined ? undefined : toRecord(row);
};

export const transitionThread = (
    db: DatabaseSync,
    tid: number,
    from: ThreadState | ThreadState[],
    to: ThreadState,
    patch: ThreadPatch = {},
    lease?: number,
): ThreadRecord => {
    const fromStates: ThreadState[] = Array.isArray(from) ? from : [from];
    const row: ThreadRow = getRow(db, tid);
    if (!ThreadEdges[row.state].includes(to)) {
        throw new KernelError("invalid_transition", [`thread ${tid}: ${row.state} -> ${to} is not an edge`]);
    }
    if (lease !== undefined && row.lease !== lease) {
        throw new KernelError("lease_lost", [`thread ${tid}: lease ${lease} is stale, current is ${row.lease}`]);
    }
    const assignments: string[] = ["state = ?", "version = version + 1"];
    const values: (string | number | null)[] = [to];
    if (patch.blockedOn !== undefined) {
        assignments.push("blocked_on = ?");
        values.push(patch.blockedOn);
    }
    if (patch.wakeAt !== undefined) {
        assignments.push("wake_at = ?");
        values.push(patch.wakeAt);
    }
    if (patch.sliceUsedMs !== undefined) {
        assignments.push("slice_used_ms = ?");
        values.push(patch.sliceUsedMs);
    }
    if (patch.finishedAt !== undefined) {
        assignments.push("finished_at = ?");
        values.push(patch.finishedAt);
    }
    if (patch.exitNote !== undefined) {
        assignments.push("exit_note = ?");
        values.push(patch.exitNote);
    }
    values.push(tid, ...fromStates);
    const placeholders: string = fromStates.map(() => "?").join(", ");
    const leaseClause: string = lease === undefined ? "" : " AND lease = ?";
    if (lease !== undefined) values.push(lease);
    const result = db.prepare(`UPDATE threads SET ${assignments.join(", ")} WHERE tid = ? AND state IN (${placeholders})${leaseClause}`).run(...values);
    if (Number(result.changes) !== 1) {
        throw new KernelError("invalid_transition", [`thread ${tid} is not in ${fromStates.join("|")}`]);
    }
    return getThread(db, tid);
};

export interface ThreadClaim {
    tid: number;
    lease: number;
    workerId: string;
}

/** Atomically move a ready task to running; the lease is the fencing token. */
export const claimThread = (db: DatabaseSync, tid: number, workerId: string): ThreadClaim => {
    const result = db
        .prepare("UPDATE threads SET state = 'running', owner_worker = ?, lease = lease + 1, slice_used_ms = 0 WHERE tid = ? AND state = 'ready'")
        .run(workerId, tid);
    if (Number(result.changes) !== 1) {
        throw new KernelError("claim_failed", [`thread ${tid} is not ready`]);
    }
    return { tid, lease: getRow(db, tid).lease, workerId };
};

export const releaseThread = (db: DatabaseSync, tid: number, workerId: string, lease: number): boolean => {
    const result = db
        .prepare("UPDATE threads SET state = 'ready', owner_worker = NULL WHERE tid = ? AND state = 'running' AND owner_worker = ? AND lease = ?")
        .run(tid, workerId, lease);
    return Number(result.changes) === 1;
};

/** Charge the task's own slice. Exhaustion fails the task, not the agent. */
export const chargeThread = (db: DatabaseSync, tid: number, usage: Budget, at: string): { ok: boolean; exceeded: string[] } => {
    const record = getThread(db, tid);
    const used: Record<string, number> = { tokens: 0, ms: 0, calls: 0, interrupts: 0, money: 0, ...record.used };
    const exceeded: string[] = [];
    const dimensions: Array<keyof Budget> = ["tokens", "ms", "calls", "interrupts", "money"];
    for (const dimension of dimensions) {
        const amount: number | undefined = usage[dimension];
        if (amount === undefined || amount === 0) continue;
        used[dimension] = (used[dimension] ?? 0) + amount;
        const limit: number | undefined = record.budget[dimension];
        if (limit !== undefined && used[dimension] > limit) exceeded.push(dimension);
    }
    if (exceeded.length > 0) {
        db.prepare("UPDATE threads SET used = ?, state = 'failed', finished_at = ?, exit_note = ? WHERE tid = ?").run(
            JSON.stringify(used),
            at,
            `task budget exceeded: ${exceeded.join(", ")}`,
            tid,
        );
        return { ok: false, exceeded };
    }
    db.prepare("UPDATE threads SET used = ? WHERE tid = ?").run(JSON.stringify(used), tid);
    return { ok: true, exceeded: [] };
};

/** Wake every thread blocked on one condition (mailbox, object, handle). */
export const notifyCondition = (db: DatabaseSync, condition: string): number => {
    const result = db.prepare("UPDATE threads SET state = 'ready', blocked_on = NULL WHERE state = 'blocked' AND blocked_on = ?").run(condition);
    db.prepare(
        `UPDATE processes SET state = 'running'
         WHERE state = 'idle'
           AND EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'ready')`,
    ).run();
    return Number(result.changes);
};

/** Promote sleeping tasks whose `wake_at` has passed. */
export const wakeSleeping = (db: DatabaseSync, at: string): number => {
    const result = db
        .prepare("UPDATE threads SET state = 'ready', wake_at = NULL, blocked_on = NULL WHERE state = 'blocked' AND wake_at IS NOT NULL AND wake_at <= ?")
        .run(at);
    db.prepare(
        `UPDATE processes SET state = 'running'
         WHERE state = 'idle'
           AND EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'ready')`,
    ).run();
    return Number(result.changes);
};

/** Crash recovery: requeue running tasks owned by a dead worker; agents go idle. */
export const recoverThreads = (db: DatabaseSync, workerId?: string): { threads: number; processes: number } => {
    const threads =
        workerId === undefined
            ? db.prepare("UPDATE threads SET state = 'ready', owner_worker = NULL, lease = lease + 1, slice_used_ms = 0 WHERE state = 'running'").run()
            : db
                  .prepare(
                      "UPDATE threads SET state = 'ready', owner_worker = NULL, lease = lease + 1, slice_used_ms = 0 WHERE state = 'running' AND (owner_worker IS NULL OR owner_worker = ?)",
                  )
                  .run(workerId);
    const processes = db
        .prepare(
            `UPDATE processes SET state = 'idle'
             WHERE state = 'running'
               AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'running')`,
        )
        .run();
    return { threads: Number(threads.changes), processes: Number(processes.changes) };
};

export const liveThreadCount = (db: DatabaseSync, pid: number): number => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE pid = ? AND state IN ('ready','running','blocked')").get(pid) as { n: number };
    return row.n;
};

export const readyThreadCount = (db: DatabaseSync, pid: number): number => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE pid = ? AND state = 'ready'").get(pid) as { n: number };
    return row.n;
};

export const runningThreadCount = (db: DatabaseSync, pid: number): number => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE pid = ? AND state = 'running'").get(pid) as { n: number };
    return row.n;
};
