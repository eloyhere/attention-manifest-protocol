/**
 * Process: a persistent agent.
 *
 * The process is the agent itself: it owns a budget, a memory (address space),
 * capabilities and a parent (for delegated sub-agents). It does not "complete";
 * it moves between created/running/idle/suspended/terminated while tasks come
 * and go. A task is a thread (see `src/thread`), so one agent does one thing at
 * a time, like a CPU running one thread.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Budget, Id, Usage } from "../types/common.ts";
import { isId } from "../boundary/ids.ts";
import { KernelError } from "../error/kernelError.ts";
import { putObject } from "../database/store/database.ts";
import { requirePermission } from "../authz/authz.ts";
import type { Subject } from "../authz/authz.ts";

export type ProcessState = "created" | "running" | "idle" | "suspended" | "terminated";

export interface ProcessSpec {
    id: Id;
    /** Display name of the agent. */
    name: string;
    role?: string;
    priority?: number;
    budget?: Budget;
    parentPid?: number;
}

export interface ProcessRecord {
    pid: number;
    id: Id;
    name: string;
    role?: string;
    state: ProcessState;
    priority: number;
    budget: Budget;
    used: Usage;
    parentPid?: number;
    createdAt: string;
    startedAt?: string;
    terminatedAt?: string;
    exitCode?: string;
    exitNote?: string;
}

interface ProcessRow {
    pid: number;
    id: string;
    name: string;
    role: string | null;
    state: ProcessState;
    priority: number;
    budget: string;
    used: string;
    parent_pid: number | null;
    created_at: string;
    started_at: string | null;
    terminated_at: string | null;
    exit_code: string | null;
    exit_note: string | null;
    version: number;
}

export interface ProcessPatch {
    startedAt?: string;
    terminatedAt?: string;
    exitCode?: string;
    exitNote?: string;
}

/** Agent lifecycle. `terminated` has no outgoing edge. */
const ProcessEdges: Record<ProcessState, readonly ProcessState[]> = {
    created: ["running", "idle", "suspended", "terminated"],
    running: ["idle", "suspended", "terminated"],
    idle: ["running", "suspended", "terminated"],
    suspended: ["running", "idle", "terminated"],
    terminated: [],
};

const canTransition = (from: ProcessState, to: ProcessState): boolean => ProcessEdges[from].includes(to);

export const emptyUsage = (): Required<Pick<Usage, "tokens" | "ms" | "calls" | "interrupts" | "money">> => ({
    tokens: 0,
    ms: 0,
    calls: 0,
    interrupts: 0,
    money: 0,
});

const toRecord = (row: ProcessRow): ProcessRecord => {
    const record: ProcessRecord = {
        pid: row.pid,
        id: row.id,
        name: row.name,
        state: row.state,
        priority: row.priority,
        budget: JSON.parse(row.budget) as Budget,
        used: JSON.parse(row.used) as Usage,
        createdAt: row.created_at,
    };
    if (row.role !== null) record.role = row.role;
    if (row.parent_pid !== null) record.parentPid = row.parent_pid;
    if (row.started_at !== null) record.startedAt = row.started_at;
    if (row.terminated_at !== null) record.terminatedAt = row.terminated_at;
    if (row.exit_code !== null) record.exitCode = row.exit_code;
    if (row.exit_note !== null) record.exitNote = row.exit_note;
    return record;
};

const getRow = (db: DatabaseSync, pid: number): ProcessRow => {
    const row = db.prepare("SELECT * FROM processes WHERE pid = ?").get(pid) as unknown as ProcessRow | undefined;
    if (row === undefined) throw new KernelError("unknown_process", [`pid ${pid}`]);
    return row;
};

export const createProcess = (db: DatabaseSync, spec: ProcessSpec, at: string): ProcessRecord => {
    if (!isId(spec.id)) throw new KernelError("invalid_process", [`id ${spec.id} is not a valid AMP id`]);
    if (spec.name.trim().length === 0) throw new KernelError("invalid_process", ["name is empty"]);
    const budget: Budget = spec.budget ?? {};
    const result = db
        .prepare("INSERT INTO processes (id, name, role, state, priority, budget, used, parent_pid, created_at) VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)")
        .run(spec.id, spec.name, spec.role ?? null, spec.priority ?? 0, JSON.stringify(budget), JSON.stringify(emptyUsage()), spec.parentPid ?? null, at);
    return getProcess(db, Number(result.lastInsertRowid));
};

export const findProcess = (db: DatabaseSync, id: Id): ProcessRecord | undefined => {
    const row = db.prepare("SELECT * FROM processes WHERE id = ?").get(id) as unknown as ProcessRow | undefined;
    return row === undefined ? undefined : toRecord(row);
};

export const getProcess = (db: DatabaseSync, pid: number): ProcessRecord => toRecord(getRow(db, pid));

export const listProcesses = (db: DatabaseSync, state?: ProcessState): ProcessRecord[] => {
    const rows =
        state === undefined
            ? (db.prepare("SELECT * FROM processes ORDER BY pid ASC").all() as unknown as ProcessRow[])
            : (db.prepare("SELECT * FROM processes WHERE state = ? ORDER BY pid ASC").all(state) as unknown as ProcessRow[]);
    return rows.map(toRecord);
};

/** Guarded agent transition. The update only applies from one of `from`. */
export const transitionProcess = (
    db: DatabaseSync,
    pid: number,
    from: ProcessState | ProcessState[],
    to: ProcessState,
    patch: ProcessPatch = {},
): ProcessRecord => {
    const fromStates: ProcessState[] = Array.isArray(from) ? from : [from];
    const current: ProcessState = getRow(db, pid).state;
    if (!canTransition(current, to)) {
        throw new KernelError("invalid_transition", [`process ${pid}: ${current} -> ${to} is not an edge`]);
    }
    const assignments: string[] = ["state = ?", "version = version + 1"];
    const values: (string | number)[] = [to];
    if (patch.startedAt !== undefined) {
        assignments.push("started_at = COALESCE(started_at, ?)");
        values.push(patch.startedAt);
    }
    if (patch.terminatedAt !== undefined) {
        assignments.push("terminated_at = ?");
        values.push(patch.terminatedAt);
    }
    if (patch.exitCode !== undefined) {
        assignments.push("exit_code = ?");
        values.push(patch.exitCode);
    }
    if (patch.exitNote !== undefined) {
        assignments.push("exit_note = ?");
        values.push(patch.exitNote);
    }
    values.push(pid, ...fromStates);
    const placeholders: string = fromStates.map(() => "?").join(", ");
    const result = db.prepare(`UPDATE processes SET ${assignments.join(", ")} WHERE pid = ? AND state IN (${placeholders})`).run(...values);
    if (Number(result.changes) !== 1) {
        throw new KernelError("invalid_transition", [`process ${pid} is not in ${fromStates.join("|")}`]);
    }
    return getProcess(db, pid);
};

/**
 * Charge the agent's overall budget. Exhaustion suspends the agent (it can be
 * resumed with a larger budget); it does not silently drop the task.
 */
export const chargeProcess = (db: DatabaseSync, pid: number, usage: Budget, _at: string): { ok: boolean; exceeded: string[] } => {
    const record = getProcess(db, pid);
    const used: Record<string, number> = { ...emptyUsage(), ...record.used };
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
        db.prepare("UPDATE processes SET used = ?, state = 'suspended', exit_code = 'BUDGET', exit_note = ? WHERE pid = ?").run(
            JSON.stringify(used),
            `budget exceeded: ${exceeded.join(", ")}`,
            pid,
        );
        return { ok: false, exceeded };
    }
    db.prepare("UPDATE processes SET used = ? WHERE pid = ?").run(JSON.stringify(used), pid);
    return { ok: true, exceeded: [] };
};

export const terminateProcess = (db: DatabaseSync, pid: number, note: string, at: string, code = "TERMINATED"): ProcessRecord => {
    return transitionProcess(db, pid, ["created", "running", "idle", "suspended"], "terminated", { terminatedAt: at, exitCode: code, exitNote: note });
};

/* ----------------------------- address space ----------------------------- */

export type AddressRole = "own" | "inherited" | "mapped" | "joined";
export type AddressMode = "read" | "write";

export interface ProcessObjectRecord {
    seq: number;
    kind: string;
    id: string;
    body: string;
    role: AddressRole;
    mode: AddressMode;
}

/**
 * Map an immutable object into an agent's memory.
 *
 * `own` is writable, `inherited` is the read-only copy-on-write view a fork
 * gets, `mapped`/`joined` are cross-agent views. Mapped reads need a capability
 * unless the caller is the owner.
 */
export const attachObject = (db: DatabaseSync, pid: number, seq: number, role: AddressRole, mode: AddressMode, at: string, subject?: Subject): void => {
    getProcess(db, pid);
    const exists = db.prepare("SELECT seq FROM objects WHERE seq = ?").get(seq) as { seq: number } | undefined;
    if (exists === undefined) throw new KernelError("unknown_object", [`seq ${seq} is not in the object store`]);
    if (subject !== undefined) {
        requirePermission(db, subject, mode === "write" ? "write" : "read", { kind: "object", id: `${seq}`, ownerPid: pid }, at);
    }
    db.prepare("INSERT OR REPLACE INTO process_objects (pid, seq, role, mode, attached_at) VALUES (?, ?, ?, ?, ?)").run(pid, seq, role, mode, at);
};

export const processObjects = (db: DatabaseSync, pid: number): ProcessObjectRecord[] => {
    return db
        .prepare(
            `SELECT o.seq, o.kind, o.id, o.body, p.role, p.mode
             FROM process_objects p JOIN objects o ON o.seq = p.seq
             WHERE p.pid = ? ORDER BY o.seq ASC`,
        )
        .all(pid) as unknown as ProcessObjectRecord[];
};

export const readProcessObject = (db: DatabaseSync, pid: number, seq: number, subject: Subject, at: string): ProcessObjectRecord => {
    const row = db
        .prepare(
            `SELECT o.seq, o.kind, o.id, o.body, p.role, p.mode
             FROM process_objects p JOIN objects o ON o.seq = p.seq
             WHERE p.pid = ? AND p.seq = ?`,
        )
        .get(pid, seq) as unknown as ProcessObjectRecord | undefined;
    if (row === undefined) throw new KernelError("unknown_object", [`seq ${seq} is not mapped into pid ${pid}`]);
    if (row.role === "own" || row.role === "inherited" || row.role === "joined") return row;
    requirePermission(db, subject, "read", { kind: "object", id: `${seq}` }, at);
    return row;
};

export const writeProcessObject = (db: DatabaseSync, pid: number, seq: number, subject: Subject, at: string): ProcessObjectRecord => {
    const row = readProcessObject(db, pid, seq, subject, at);
    if (row.mode !== "write") {
        requirePermission(db, subject, "write", { kind: "object", id: `${seq}` }, at);
    }
    return row;
};

/** Fork a delegated sub-agent with a read-only view of the parent's memory. */
export const forkProcess = (db: DatabaseSync, parentPid: number, spec: ProcessSpec, at: string, subject?: Subject): ProcessRecord => {
    const parent = getProcess(db, parentPid);
    if (subject !== undefined) {
        requirePermission(db, subject, "fork", { kind: "process", id: parent.id, ownerPid: parentPid }, at);
    }
    const child = createProcess(db, { ...spec, parentPid }, at);
    db.prepare(
        `INSERT OR REPLACE INTO process_objects (pid, seq, role, mode, attached_at)
         SELECT ?, seq, 'inherited', 'read', ? FROM process_objects WHERE pid = ?`,
    ).run(child.pid, at, parentPid);
    return child;
};

/** Join a sub-agent back: its own objects become read-only pages in the parent. */
export const joinProcess = (db: DatabaseSync, childPid: number, parentPid: number, at: string, subject?: Subject): number => {
    const child = getProcess(db, childPid);
    if (child.parentPid !== parentPid) throw new KernelError("invalid_transition", [`pid ${childPid} is not a child of ${parentPid}`]);
    if (subject !== undefined) {
        requirePermission(db, subject, "join", { kind: "process", id: child.id, ownerPid: parentPid }, at);
    }
    const result = db
        .prepare(
            `INSERT OR REPLACE INTO process_objects (pid, seq, role, mode, attached_at)
         SELECT ?, seq, 'joined', 'read', ? FROM process_objects WHERE pid = ? AND role = 'own'`,
        )
        .run(parentPid, at, childPid);
    terminateProcess(db, childPid, `joined into ${parentPid}`, at, "JOINED");
    return Number(result.changes);
};

/** Append a claim/event/frame object inside the same transaction as the step. */
export const putProcessObject = (db: DatabaseSync, kind: string, id: Id, body: unknown, at: string): { seq: number; hash: string } => {
    return putObject(db, kind, id, body, at);
};
