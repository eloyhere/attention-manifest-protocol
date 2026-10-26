/**
 * SQLite execution adapter: processes, tasks and steps through `TableSql`.
 *
 * State machines stay in the domain (`canProcessTransition` /
 * `canThreadTransition`); this repository owns rows, atomic conditional updates
 * and fencing leases. The kernel sees only `ExecutionStore`.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Budget, Usage } from "../../types/common.ts";
import { KernelError } from "../../error/kernelError.ts";
import { canProcessTransition } from "../../process/transitions.ts";
import type { ProcessPatch, ProcessRecord, ProcessSpec, ProcessState } from "../../process/process.ts";
import { canThreadTransition } from "../../thread/transitions.ts";
import type { ThreadClaim, ThreadPatch, ThreadRecord, ThreadState } from "../../thread/thread.ts";
import type { ChargeResult, ExecutionStore, StepRecordInput } from "../../process/executionStore.ts";
import { TableSql } from "../sql/sql.ts";
import { BaseRepository } from "./base.ts";
import { ProcessTable } from "../entity/process.ts";
import type { ProcessEntity } from "../entity/process.ts";
import { ThreadTable } from "../entity/thread.ts";
import type { ThreadEntity } from "../entity/thread.ts";
import { StepTable } from "../entity/worker.ts";

const emptyUsage = (): Required<Pick<Usage, "tokens" | "ms" | "calls" | "interrupts" | "money">> => ({
    tokens: 0,
    ms: 0,
    calls: 0,
    interrupts: 0,
    money: 0,
});

const toProcess = (row: ProcessEntity): ProcessRecord => {
    const record: ProcessRecord = {
        pid: row.pid,
        id: row.id,
        name: row.name,
        state: row.state as ProcessState,
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

const toThread = (row: ThreadEntity): ThreadRecord => {
    const record: ThreadRecord = {
        tid: row.tid,
        id: row.id,
        pid: row.pid,
        goal: row.goal,
        statement: row.statement,
        success: JSON.parse(row.success),
        state: row.state as ThreadState,
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

const dimensions: Array<keyof Budget> = ["tokens", "ms", "calls", "interrupts", "money"];

const charge = (budget: Budget, usedInput: Usage, usage: Budget): { used: Record<string, number>; exceeded: string[] } => {
    const used: Record<string, number> = { ...emptyUsage(), ...usedInput };
    const exceeded: string[] = [];
    for (const dimension of dimensions) {
        const amount = usage[dimension];
        if (amount === undefined || amount === 0) continue;
        used[dimension] = (used[dimension] ?? 0) + amount;
        const limit = budget[dimension];
        if (limit !== undefined && used[dimension] > limit) exceeded.push(dimension);
    }
    return { used, exceeded };
};

export class ExecutionRepository extends BaseRepository<ProcessEntity, number> implements ExecutionStore {
    private readonly threads: TableSql<ThreadEntity>;
    private readonly steps: TableSql<{ step_id: number }>;

    constructor(db: DatabaseSync) {
        super(db, ProcessTable);
        this.threads = new TableSql(db, ThreadTable);
        this.steps = new TableSql(db, StepTable);
    }

    findAgentByExternalId(id: string): ProcessRecord | undefined {
        const row = this.queries.select({ where: "id = ?", params: [id], limit: 1 })[0];
        return row === undefined ? undefined : toProcess(row);
    }

    listAgents(state?: ProcessState): ProcessRecord[] {
        const rows = this.queries.select({
            where: state === undefined ? (void 0) : "state = ?",
            params: state === undefined ? [] : [state],
            orderBy: "ORDER BY pid ASC",
        });
        return rows.map(toProcess);
    }

    createAgent(spec: ProcessSpec, at: string): ProcessRecord {
        const result = this.queries.insert({
            id: spec.id,
            name: spec.name,
            role: spec.role ?? null,
            state: "created",
            priority: spec.priority ?? 0,
            budget: JSON.stringify(spec.budget ?? {}),
            used: JSON.stringify(emptyUsage()),
            parent_pid: spec.parentPid ?? null,
            created_at: at,
        });
        return this.getAgent(Number(result.lastInsertRowid));
    }

    beginAgent(pid: number, at: string): boolean {
        const row = this.findById(pid);
        if (row === undefined || (row.state !== "created" && row.state !== "idle")) return false;
        const changed = this.queries.updateWhere(
            "pid = ? AND state IN ('created','idle')",
            { state: "running", started_at: row.started_at ?? at, version: row.version + 1 },
            pid,
        );
        return changed === 1;
    }

    getAgent(pid: number): ProcessRecord {
        const row = this.findById(pid);
        if (row === undefined) throw new KernelError("unknown_process", [`pid ${pid}`]);
        return toProcess(row);
    }

    transitionAgent(pid: number, from: ProcessState | ProcessState[], to: ProcessState, patch: ProcessPatch = {}): ProcessRecord {
        const row = this.findById(pid);
        if (row === undefined) throw new KernelError("unknown_process", [`pid ${pid}`]);
        const fromStates = Array.isArray(from) ? from : [from];
        if (!fromStates.includes(row.state as ProcessState) || !canProcessTransition(row.state as ProcessState, to)) {
            throw new KernelError("invalid_transition", [`process ${pid}: ${row.state} -> ${to} is not an edge`]);
        }
        const values: Record<string, unknown> = { state: to, version: row.version + 1 };
        if (patch.startedAt !== undefined) values.started_at = row.started_at ?? patch.startedAt;
        if (patch.terminatedAt !== undefined) values.terminated_at = patch.terminatedAt;
        if (patch.exitCode !== undefined) values.exit_code = patch.exitCode;
        if (patch.exitNote !== undefined) values.exit_note = patch.exitNote;
        const changed = this.queries.updateWhere("pid = ?", values, pid);
        if (changed !== 1) throw new KernelError("invalid_transition", [`process ${pid} was not updated`]);
        return this.getAgent(pid);
    }

    chargeAgent(pid: number, usage: Budget, _at: string): ChargeResult {
        const row = this.findById(pid);
        if (row === undefined) throw new KernelError("unknown_process", [`pid ${pid}`]);
        const result = charge(JSON.parse(row.budget) as Budget, JSON.parse(row.used) as Usage, usage);
        if (result.exceeded.length > 0) {
            this.queries.updateWhere(
                "pid = ?",
                { used: JSON.stringify(result.used), state: "suspended", exit_code: "BUDGET", exit_note: `budget exceeded: ${result.exceeded.join(", ")}` },
                pid,
            );
            return { ok: false, exceeded: result.exceeded };
        }
        this.queries.updateWhere("pid = ?", { used: JSON.stringify(result.used) }, pid);
        return { ok: true, exceeded: [] };
    }

    terminateAgent(pid: number, note: string, at: string, code = "TERMINATED"): ProcessRecord {
        return this.transitionAgent(pid, ["created", "running", "idle", "suspended"], "terminated", {
            terminatedAt: at,
            exitCode: code,
            exitNote: note,
        });
    }

    getTask(tid: number): ThreadRecord {
        const row = this.threads.findById(tid);
        if (row === undefined) throw new KernelError("unknown_thread", [`tid ${tid}`]);
        return toThread(row);
    }

    findTaskByExternalId(id: string): ThreadRecord | undefined {
        const row = this.threads.select({ where: "id = ?", params: [id], limit: 1 })[0];
        return row === undefined ? undefined : toThread(row);
    }

    listTasks(pid?: number): ThreadRecord[] {
        const rows = this.threads.select({
            where: pid === undefined ? (void 0) : "pid = ?",
            params: pid === undefined ? [] : [pid],
            orderBy: "ORDER BY tid ASC",
        });
        return rows.map(toThread);
    }

    countTasks(pid: number): number {
        return this.threads.count("pid = ?", pid);
    }

    findActiveTaskByGoal(pid: number, goal: string): { tid: number } | undefined {
        const row = this.threads.select({
            where: "pid = ? AND goal = ? AND state IN ('ready','running','blocked')",
            params: [pid, goal],
            limit: 1,
        })[0];
        return row === undefined ? undefined : { tid: row.tid };
    }

    createTask(input: {
        id: string;
        pid: number;
        goal: string;
        statement: string;
        success: unknown;
        priority?: number;
        quantumMs?: number;
        budget?: Budget;
        at: string;
    }): ThreadRecord {
        const result = this.threads.insert({
            id: input.id,
            pid: input.pid,
            goal: input.goal,
            statement: input.statement,
            success: JSON.stringify(input.success),
            state: "ready",
            priority: input.priority ?? 0,
            quantum_ms: input.quantumMs ?? 1000,
            slice_used_ms: 0,
            budget: JSON.stringify(input.budget ?? {}),
            used: JSON.stringify(emptyUsage()),
            created_at: input.at,
        });
        return this.getTask(Number(result.lastInsertRowid));
    }

    nextReadyTask(): ThreadRecord | undefined {
        const row = this.threads.queryOne<ThreadEntity>(
            `SELECT t.* FROM threads t
             JOIN processes p ON p.pid = t.pid
             WHERE t.state = 'ready' AND p.state IN ('created','idle','running')
             ORDER BY t.priority DESC, t.tid ASC
             LIMIT 1`,
        );
        return row === undefined ? undefined : toThread(row);
    }

    claimTask(tid: number, workerId: string): ThreadClaim {
        const row = this.threads.findById(tid);
        if (row === undefined || row.state !== "ready") throw new KernelError("claim_failed", [`thread ${tid} is not ready`]);
        const lease = row.lease + 1;
        const changed = this.threads.updateWhere("tid = ? AND state = 'ready'", { state: "running", owner_worker: workerId, lease, slice_used_ms: 0 }, tid);
        if (changed !== 1) throw new KernelError("claim_failed", [`thread ${tid} was claimed`]);
        return { tid, lease, workerId };
    }

    releaseTask(tid: number, workerId: string, lease: number): boolean {
        return (
            this.threads.updateWhere(
                "tid = ? AND state = 'running' AND owner_worker = ? AND lease = ?",
                { state: "ready", owner_worker: null },
                tid,
                workerId,
                lease,
            ) === 1
        );
    }

    transitionTask(tid: number, from: ThreadState | ThreadState[], to: ThreadState, patch: ThreadPatch = {}, lease?: number): ThreadRecord {
        const row = this.threads.findById(tid);
        if (row === undefined) throw new KernelError("unknown_thread", [`tid ${tid}`]);
        const fromStates = Array.isArray(from) ? from : [from];
        if (!fromStates.includes(row.state as ThreadState) || !canThreadTransition(row.state as ThreadState, to)) {
            throw new KernelError("invalid_transition", [`thread ${tid}: ${row.state} -> ${to} is not an edge`]);
        }
        if (lease !== undefined && row.lease !== lease) {
            throw new KernelError("lease_lost", [`thread ${tid}: lease ${lease} is stale, current is ${row.lease}`]);
        }
        const values: Record<string, unknown> = { state: to, version: row.version + 1 };
        if (patch.blockedOn !== undefined) values.blocked_on = patch.blockedOn;
        if (patch.wakeAt !== undefined) values.wake_at = patch.wakeAt;
        if (patch.sliceUsedMs !== undefined) values.slice_used_ms = patch.sliceUsedMs;
        if (patch.finishedAt !== undefined) values.finished_at = patch.finishedAt;
        if (patch.exitNote !== undefined) values.exit_note = patch.exitNote;
        const leaseClause = lease === undefined ? "" : " AND lease = ?";
        const params: Array<number | string> = [tid];
        if (lease !== undefined) params.push(lease);
        const changed = this.threads.updateWhere(`tid = ?${leaseClause}`, values, ...params);
        if (changed !== 1) throw new KernelError("invalid_transition", [`thread ${tid} was not updated`]);
        return this.getTask(tid);
    }

    chargeTask(tid: number, usage: Budget, at: string): ChargeResult {
        const row = this.threads.findById(tid);
        if (row === undefined) throw new KernelError("unknown_thread", [`tid ${tid}`]);
        const result = charge(JSON.parse(row.budget) as Budget, JSON.parse(row.used) as Usage, usage);
        if (result.exceeded.length > 0) {
            this.threads.updateWhere(
                "tid = ?",
                { used: JSON.stringify(result.used), state: "failed", finished_at: at, exit_note: `task budget exceeded: ${result.exceeded.join(", ")}` },
                tid,
            );
            return { ok: false, exceeded: result.exceeded };
        }
        this.threads.updateWhere("tid = ?", { used: JSON.stringify(result.used) }, tid);
        return { ok: true, exceeded: [] };
    }

    countSteps(tid: number): number {
        return this.steps.count("tid = ?", tid);
    }

    writeStep(step: StepRecordInput): void {
        this.steps.insert({
            pid: step.pid,
            tid: step.tid,
            at: step.at,
            outcome: step.status,
            usage: JSON.stringify(step.usage),
            note: step.note ?? null,
            receipt_id: step.receiptId,
        });
    }

    wake(at: string): number {
        const woke = this.threads.updateWhere(
            "state = 'blocked' AND wake_at IS NOT NULL AND wake_at <= ?",
            { state: "ready", wake_at: null, blocked_on: null },
            at,
        );
        this.promoteIdleAgents();
        return woke;
    }

    notify(condition: string): number {
        const woken = this.threads.updateWhere("state = 'blocked' AND blocked_on = ?", { state: "ready", blocked_on: null }, condition);
        this.promoteIdleAgents();
        return woken;
    }

    recover(workerId?: string): { threads: number; processes: number } {
        const rows =
            workerId === undefined
                ? this.threads.select({ where: "state = 'running'" })
                : this.threads.select({ where: "state = 'running' AND (owner_worker IS NULL OR owner_worker = ?)", params: [workerId] });
        let threads = 0;
        for (const row of rows) {
            threads += this.threads.updateWhere(
                "tid = ? AND state = 'running'",
                { state: "ready", owner_worker: null, lease: row.lease + 1, slice_used_ms: 0 },
                row.tid,
            );
        }
        const processes = this.idleAgentsWithoutRunning();
        return { threads, processes };
    }

    closeWorker(workerId: string): void {
        const rows = this.threads.select({ where: "state = 'running' AND owner_worker = ?", params: [workerId] });
        for (const row of rows) {
            this.threads.updateWhere(
                "tid = ? AND state = 'running' AND owner_worker = ?",
                { state: "ready", owner_worker: null, lease: row.lease + 1 },
                row.tid,
                workerId,
            );
        }
        this.idleAgentsWithoutRunning();
    }

    runningTaskCount(pid: number): number {
        return this.threads.count("pid = ? AND state = 'running'", pid);
    }

    readyTaskCount(pid: number): number {
        return this.threads.count("pid = ? AND state = 'ready'", pid);
    }

    liveTaskCount(pid: number): number {
        return this.threads.count("pid = ? AND state IN ('ready','running','blocked')", pid);
    }

    private promoteIdleAgents(): number {
        return this.queries.updateWhere("state = 'idle' AND EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'ready')", {
            state: "running",
        });
    }

    private idleAgentsWithoutRunning(): number {
        return this.queries.updateWhere("state = 'running' AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'running')", {
            state: "idle",
        });
    }
}
