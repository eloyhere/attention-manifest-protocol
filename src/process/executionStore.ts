/**
 * Execution port: what the kernel needs from processes and tasks.
 *
 * The kernel must not know table names or SQL. The default adapter delegates to
 * `ExecutionRepository`, which owns the `TableSql` access.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Budget } from "../types/common.ts";
import type { ProcessPatch, ProcessRecord, ProcessState } from "./process.ts";
import type { ThreadClaim, ThreadPatch, ThreadRecord, ThreadState } from "../thread/thread.ts";
import { ExecutionRepository } from "../database/repository/executionRepository.ts";

export interface ChargeResult {
    ok: boolean;
    exceeded: string[];
}

export interface StepRecordInput {
    pid: number;
    tid: number;
    at: string;
    status: string;
    usage: Budget;
    receiptId: string;
    note?: string;
}

export interface ExecutionStore {
    beginAgent(pid: number, at: string): boolean;
    getAgent(pid: number): ProcessRecord;
    transitionAgent(pid: number, from: ProcessState | ProcessState[], to: ProcessState, patch?: ProcessPatch): ProcessRecord;
    chargeAgent(pid: number, usage: Budget, at: string): ChargeResult;
    terminateAgent(pid: number, note: string, at: string, code?: string): ProcessRecord;

    getTask(tid: number): ThreadRecord;
    nextReadyTask(): ThreadRecord | undefined;
    claimTask(tid: number, workerId: string): ThreadClaim;
    releaseTask(tid: number, workerId: string, lease: number): boolean;
    transitionTask(tid: number, from: ThreadState | ThreadState[], to: ThreadState, patch?: ThreadPatch, lease?: number): ThreadRecord;
    chargeTask(tid: number, usage: Budget, at: string): ChargeResult;

    countSteps(tid: number): number;
    writeStep(step: StepRecordInput): void;

    wake(at: string): number;
    notify(condition: string): number;
    recover(workerId?: string): { threads: number; processes: number };
    closeWorker(workerId: string): void;
    runningTaskCount(pid: number): number;
    readyTaskCount(pid: number): number;
    liveTaskCount(pid: number): number;
}

/**
 * Default adapter: the kernel sees only this seam; `ExecutionRepository` owns
 * the SQL and the atomic conditional updates.
 */
export class ProcessExecutionStore implements ExecutionStore {
    private readonly repository: ExecutionRepository;

    constructor(db: DatabaseSync) {
        this.repository = new ExecutionRepository(db);
    }

    beginAgent(pid: number, at: string): boolean {
        return this.repository.beginAgent(pid, at);
    }

    getAgent(pid: number): ProcessRecord {
        return this.repository.getAgent(pid);
    }

    transitionAgent(pid: number, from: ProcessState | ProcessState[], to: ProcessState, patch: ProcessPatch = {}): ProcessRecord {
        return this.repository.transitionAgent(pid, from, to, patch);
    }

    chargeAgent(pid: number, usage: Budget, at: string): ChargeResult {
        return this.repository.chargeAgent(pid, usage, at);
    }

    terminateAgent(pid: number, note: string, at: string, code = "TERMINATED"): ProcessRecord {
        return this.repository.terminateAgent(pid, note, at, code);
    }

    getTask(tid: number): ThreadRecord {
        return this.repository.getTask(tid);
    }

    nextReadyTask(): ThreadRecord | undefined {
        return this.repository.nextReadyTask();
    }

    claimTask(tid: number, workerId: string): ThreadClaim {
        return this.repository.claimTask(tid, workerId);
    }

    releaseTask(tid: number, workerId: string, lease: number): boolean {
        return this.repository.releaseTask(tid, workerId, lease);
    }

    transitionTask(tid: number, from: ThreadState | ThreadState[], to: ThreadState, patch: ThreadPatch = {}, lease?: number): ThreadRecord {
        return this.repository.transitionTask(tid, from, to, patch, lease);
    }

    chargeTask(tid: number, usage: Budget, at: string): ChargeResult {
        return this.repository.chargeTask(tid, usage, at);
    }

    countSteps(tid: number): number {
        return this.repository.countSteps(tid);
    }

    writeStep(step: StepRecordInput): void {
        this.repository.writeStep(step);
    }

    wake(at: string): number {
        return this.repository.wake(at);
    }

    notify(condition: string): number {
        return this.repository.notify(condition);
    }

    recover(workerId?: string): { threads: number; processes: number } {
        return this.repository.recover(workerId);
    }

    closeWorker(workerId: string): void {
        this.repository.closeWorker(workerId);
    }

    runningTaskCount(pid: number): number {
        return this.repository.runningTaskCount(pid);
    }

    readyTaskCount(pid: number): number {
        return this.repository.readyTaskCount(pid);
    }

    liveTaskCount(pid: number): number {
        return this.repository.liveTaskCount(pid);
    }
}
