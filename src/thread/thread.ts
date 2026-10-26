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
import { ExecutionRepository } from "../database/repository/executionRepository.ts";

export { canThreadTransition } from "./transitions.ts";

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

export interface ThreadPatch {
    blockedOn?: string | null;
    wakeAt?: string | null;
    sliceUsedMs?: number;
    finishedAt?: string;
    exitNote?: string;
}

/** Task lifecycle. `done`, `failed` and `abandoned` are terminal. */
export const getThread = (db: DatabaseSync, tid: number): ThreadRecord => new ExecutionRepository(db).getTask(tid);

export const findThread = (db: DatabaseSync, id: Id): ThreadRecord | undefined => new ExecutionRepository(db).findTaskByExternalId(id);

export const listThreads = (db: DatabaseSync, pid?: number): ThreadRecord[] => new ExecutionRepository(db).listTasks(pid);

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
    const repository = new ExecutionRepository(db);
    const duplicate = repository.findActiveTaskByGoal(spec.pid, spec.goal);
    if (duplicate !== undefined) {
        throw new KernelError("duplicate_task", [`goal ${spec.goal} already has active task ${duplicate.tid}`]);
    }
    const count = repository.countTasks(spec.pid);
    const id: Id = spec.id ?? `t.${spec.pid}.${count + 1}`;
    if (!isId(id)) throw new KernelError("invalid_thread", [`id ${id} is not a valid AMP id`]);
    return repository.createTask({
        id,
        pid: spec.pid,
        goal: spec.goal,
        statement: spec.statement,
        success: spec.success,
        priority: spec.priority,
        quantumMs: spec.quantumMs,
        budget: spec.budget,
        at,
    });
};

/** Oldest highest-priority task whose agent may run it. */
export const nextReadyThread = (db: DatabaseSync): ThreadRecord | undefined => new ExecutionRepository(db).nextReadyTask();

export const transitionThread = (
    db: DatabaseSync,
    tid: number,
    from: ThreadState | ThreadState[],
    to: ThreadState,
    patch: ThreadPatch = {},
    lease?: number,
): ThreadRecord => new ExecutionRepository(db).transitionTask(tid, from, to, patch, lease);

export interface ThreadClaim {
    tid: number;
    lease: number;
    workerId: string;
}

/** Atomically move a ready task to running; the lease is the fencing token. */
export const claimThread = (db: DatabaseSync, tid: number, workerId: string): ThreadClaim => new ExecutionRepository(db).claimTask(tid, workerId);

export const releaseThread = (db: DatabaseSync, tid: number, workerId: string, lease: number): boolean =>
    new ExecutionRepository(db).releaseTask(tid, workerId, lease);

/** Charge the task's own slice. Exhaustion fails the task, not the agent. */
export const chargeThread = (db: DatabaseSync, tid: number, usage: Budget, at: string): { ok: boolean; exceeded: string[] } =>
    new ExecutionRepository(db).chargeTask(tid, usage, at);

/** Wake every thread blocked on one condition (mailbox, object, handle). */
export const notifyCondition = (db: DatabaseSync, condition: string): number => new ExecutionRepository(db).notify(condition);

/** Promote sleeping tasks whose `wake_at` has passed. */
export const wakeSleeping = (db: DatabaseSync, at: string): number => new ExecutionRepository(db).wake(at);

/** Crash recovery: requeue running tasks owned by a dead worker; agents go idle. */
export const recoverThreads = (db: DatabaseSync, workerId?: string): { threads: number; processes: number } => new ExecutionRepository(db).recover(workerId);

export const liveThreadCount = (db: DatabaseSync, pid: number): number => new ExecutionRepository(db).liveTaskCount(pid);

export const readyThreadCount = (db: DatabaseSync, pid: number): number => new ExecutionRepository(db).readyTaskCount(pid);

export const runningThreadCount = (db: DatabaseSync, pid: number): number => new ExecutionRepository(db).runningTaskCount(pid);
