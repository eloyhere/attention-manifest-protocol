/**
 * Kernel: a persistent scheduler where processes are agents and threads are
 * tasks/goals.
 *
 * Each `step()` picks one ready task, claims it with a fencing lease, runs a
 * handler while the agent is `running`, then commits the budget charge, the
 * handler's objects, the receipt and the step row in one transaction. A task
 * completes; the agent goes back to `idle` and can be given another task.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Budget, Id } from "../types/common.ts";
import type { Outcome, Receipt } from "../receipt/receipt.ts";
import { KernelError } from "../error/kernelError.ts";
import { chargeProcess, getProcess, transitionProcess } from "../process/process.ts";
import type { ProcessRecord } from "../process/process.ts";
import {
    chargeThread,
    claimThread,
    getThread,
    nextReadyThread,
    notifyCondition,
    recoverThreads,
    releaseThread,
    runningThreadCount,
    transitionThread,
    wakeSleeping,
} from "../thread/thread.ts";
import type { ThreadClaim, ThreadRecord } from "../thread/thread.ts";
import { heartbeatWorker, recoverExpiredWorkers, registerWorker, unregisterWorker } from "../concurrency/worker.ts";
import { putObject, transaction } from "../database/store/database.ts";
import { ObjectRepository } from "../database/repository/objectRepository.ts";
import { WindowRepository } from "../database/repository/windowRepository.ts";
import type { WindowPageEntity } from "../database/entity/window.ts";
import { ContextWindow } from "../window/window.ts";
import type { AgentContext } from "../context/agentContext.ts";

export type StepStatus = "yield" | "sleep" | "block" | "done" | "fail";

export interface StepObject {
    kind: string;
    id: Id;
    body: unknown;
}

export interface StepBase {
    usage?: Budget;
    note?: string;
    /** Objects to append in the same transaction as the receipt (claims, frames). */
    objects?: StepObject[];
}

export type StepOutcome =
    | (StepBase & { status: "yield" })
    | (StepBase & { status: "sleep"; wakeAt: string })
    | (StepBase & { status: "block"; blockedOn: string })
    | (StepBase & { status: "done" })
    | (StepBase & { status: "fail" });

export interface StepContext {
    db: DatabaseSync;
    /** The agent (process) executing this task. */
    agent: ProcessRecord;
    /** The task/goal (thread) being executed. */
    task: ThreadRecord;
    now: string;
    /** Per-task context window; contents persist in `window_pages`. */
    window: ContextWindow;
    /** Agent context assembled before this step, when an agent reader is wired. */
    agentContext?: AgentContext;
}

export type StepHandler = (context: StepContext) => StepOutcome;

export interface StepReport {
    pid: number;
    tid: number;
    status: StepStatus;
    usage: Budget;
    receiptId: Id;
    processState: string;
    threadState: string;
    note?: string;
}

export interface KernelOptions {
    /** Injected clock so replays are deterministic. */
    now?: () => string;
    quantumMs?: number;
    /** Stable id for this worker; two kernels sharing a store must differ. */
    workerId?: string;
    /** Lease duration before another worker may recover this one's threads. */
    leaseMs?: number;
    /** Token capacity of each task's context window. Defaults to 4000. */
    windowTokens?: number;
    /**
     * Optional agent reader. The kernel stays unaware of storage; the adapter
     * wires an AgentService/AgentReader and returns the assembled context.
     */
    agentContext?: (pid: number) => AgentContext | undefined;
}

export class Kernel {
    readonly db: DatabaseSync;
    readonly quantumMs: number;
    readonly workerId: string;
    readonly leaseMs: number;
    readonly windowTokens: number;
    private readonly nowFn: () => string;
    private readonly objects: ObjectRepository;
    private readonly windows: WindowRepository;
    private readonly agentContextFn?: (pid: number) => AgentContext | undefined;
    private tick = 0;

    constructor(db: DatabaseSync, options: KernelOptions = {}) {
        this.db = db;
        this.quantumMs = options.quantumMs ?? 1000;
        this.nowFn = options.now ?? (() => new Date().toISOString());
        this.workerId = options.workerId ?? `w-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
        this.leaseMs = options.leaseMs ?? 15_000;
        this.windowTokens = options.windowTokens ?? 4000;
        this.objects = new ObjectRepository(this.db);
        this.windows = new WindowRepository(this.db);
        this.agentContextFn = options.agentContext;
        registerWorker(this.db, { workerId: this.workerId, pid: process.pid, leaseMs: this.leaseMs }, this.now());
    }

    now(): string {
        return this.nowFn();
    }

    /** Recover expired workers plus this worker's own leftovers. */
    recover(): { threads: number; processes: number } {
        const at: string = this.now();
        const expired = recoverExpiredWorkers(this.db, at);
        const own = recoverThreads(this.db, this.workerId);
        return { threads: expired.threads + own.threads, processes: expired.processes + own.processes };
    }

    /** Release this worker's claims and remove its registry row. */
    close(): void {
        this.db
            .prepare("UPDATE threads SET state = 'ready', owner_worker = NULL, lease = lease + 1 WHERE state = 'running' AND owner_worker = ?")
            .run(this.workerId);
        this.db
            .prepare(
                `UPDATE processes SET state = 'idle'
                 WHERE state = 'running'
                   AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.pid = processes.pid AND t.state = 'running')`,
            )
            .run();
        unregisterWorker(this.db, this.workerId);
    }

    /**
     * Run exactly one task step, or return `undefined` when nothing is runnable.
     *
     * Claiming is an atomic conditional UPDATE that returns a fencing lease. Two
     * workers may select the same task; only one claim succeeds.
     */
    step(handler: StepHandler): StepReport | undefined {
        const at: string = this.now();
        this.tick += 1;
        if (!heartbeatWorker(this.db, this.workerId, at, this.leaseMs)) {
            registerWorker(this.db, { workerId: this.workerId, pid: process.pid, leaseMs: this.leaseMs }, at);
        }
        if (this.tick % 32 === 0) recoverExpiredWorkers(this.db, at);
        wakeSleeping(this.db, at);

        const candidate: ThreadRecord | undefined = nextReadyThread(this.db);
        if (candidate === undefined) return undefined;

        let claim: ThreadClaim;
        try {
            claim = claimThread(this.db, candidate.tid, this.workerId);
        } catch (error) {
            if (error instanceof KernelError && error.code === "claim_failed") return undefined;
            throw error;
        }

        const started = this.db
            .prepare(
                "UPDATE processes SET state = 'running', started_at = COALESCE(started_at, ?), version = version + 1 WHERE pid = ? AND state IN ('created','idle')",
            )
            .run(at, candidate.pid);
        if (Number(started.changes) === 0) {
            const current: ProcessRecord = getProcess(this.db, candidate.pid);
            if (current.state !== "running") {
                releaseThread(this.db, candidate.tid, this.workerId, claim.lease);
                return undefined;
            }
        }

        const context: StepContext = {
            db: this.db,
            agent: getProcess(this.db, candidate.pid),
            task: getThread(this.db, candidate.tid),
            now: at,
            window: this.windowFor(candidate.tid, at),
        };
        const person: AgentContext | undefined = this.agentContextFn?.(candidate.pid);
        if (person !== undefined) context.agentContext = person;

        let outcome: StepOutcome;
        try {
            outcome = handler(context);
        } catch (error) {
            outcome = { status: "fail", note: error instanceof Error ? error.message : `${error}` };
        }

        return transaction(this.db, () => this.commit(candidate.pid, candidate.tid, claim, outcome, at, context.window));
    }

    /** Drain the queue, bounded so a bug cannot spin forever. */
    run(handler: StepHandler, maxSteps = 1000): StepReport[] {
        const reports: StepReport[] = [];
        for (let index = 0; index < maxSteps; index += 1) {
            const report: StepReport | undefined = this.step(handler);
            if (report === undefined) break;
            reports.push(report);
        }
        return reports;
    }

    private commit(pid: number, tid: number, claim: ThreadClaim, outcome: StepOutcome, at: string, window: ContextWindow): StepReport {
        const task: ThreadRecord = getThread(this.db, tid);
        if (task.state !== "running" || task.ownerWorker !== claim.workerId || task.lease !== claim.lease) {
            throw new KernelError("lease_lost", [`thread ${tid} is owned by ${task.ownerWorker ?? "none"} at lease ${task.lease}`]);
        }

        this.windows.replacePages(tid, window.snapshot(), at, this.windowTokens);
        const usage: Budget = { calls: 1, ...outcome.usage };
        const taskCharge = chargeThread(this.db, tid, usage, at);
        const agentCharge = chargeProcess(this.db, pid, usage, at);

        if (!taskCharge.ok) {
            const receipt = this.writeReceipt(task, at, usage, "blocked", `task budget exceeded: ${taskCharge.exceeded.join(", ")}`);
            this.writeStep(pid, tid, at, "budget", usage, receipt.id, "task budget exceeded");
            this.settleAgent(pid);
            return this.report(pid, tid, "fail", usage, receipt.id, "task budget exceeded");
        }

        if (!agentCharge.ok) {
            transitionThread(this.db, tid, ["running"], "failed", { finishedAt: at, exitNote: "agent budget exceeded" }, claim.lease);
            const receipt = this.writeReceipt(task, at, usage, "blocked", `agent budget exceeded: ${agentCharge.exceeded.join(", ")}`);
            this.writeStep(pid, tid, at, "budget", usage, receipt.id, "agent budget exceeded");
            this.settleAgent(pid);
            return this.report(pid, tid, "fail", usage, receipt.id, "agent budget exceeded");
        }

        for (const object of outcome.objects ?? []) {
            putObject(this.db, object.kind, object.id, object.body, at);
        }
        if ((outcome.objects ?? []).length > 0) notifyCondition(this.db, `object:${pid}`);

        if (outcome.status === "done") {
            transitionThread(this.db, tid, ["running"], "done", { finishedAt: at, exitNote: "completed" }, claim.lease);
            const receipt = this.writeReceipt(task, at, usage, "success", outcome.note ?? "task completed");
            this.settleAgent(pid);
            this.writeStep(pid, tid, at, "done", usage, receipt.id, outcome.note);
            return this.report(pid, tid, "done", usage, receipt.id, outcome.note);
        }

        if (outcome.status === "fail") {
            transitionThread(this.db, tid, ["running"], "failed", { finishedAt: at, exitNote: outcome.note ?? "failed" }, claim.lease);
            const receipt = this.writeReceipt(task, at, usage, "failure", outcome.note ?? "task failed");
            this.settleAgent(pid);
            this.writeStep(pid, tid, at, "fail", usage, receipt.id, outcome.note);
            return this.report(pid, tid, "fail", usage, receipt.id, outcome.note);
        }

        if (outcome.status === "sleep") {
            transitionThread(this.db, tid, ["running"], "blocked", { wakeAt: outcome.wakeAt, blockedOn: null, exitNote: outcome.note }, claim.lease);
            const receipt = this.writeReceipt(task, at, usage, "partial", outcome.note ?? `sleeps until ${outcome.wakeAt}`);
            this.settleAgent(pid);
            this.writeStep(pid, tid, at, "sleep", usage, receipt.id, outcome.note);
            return this.report(pid, tid, "sleep", usage, receipt.id, outcome.note);
        }

        if (outcome.status === "block") {
            transitionThread(this.db, tid, ["running"], "blocked", { blockedOn: outcome.blockedOn, wakeAt: null, exitNote: outcome.note }, claim.lease);
            const receipt = this.writeReceipt(task, at, usage, "partial", outcome.note ?? `blocked on ${outcome.blockedOn}`);
            this.settleAgent(pid);
            this.writeStep(pid, tid, at, "block", usage, receipt.id, outcome.note);
            return this.report(pid, tid, "block", usage, receipt.id, outcome.note);
        }

        transitionThread(this.db, tid, ["running"], "ready", { blockedOn: null, wakeAt: null }, claim.lease);
        const receipt = this.writeReceipt(task, at, usage, "success", outcome.note ?? "quantum yielded");
        this.settleAgent(pid);
        this.writeStep(pid, tid, at, "yield", usage, receipt.id, outcome.note);
        return this.report(pid, tid, "yield", usage, receipt.id, outcome.note);
    }

    /** An agent is `running` only while a task runs; otherwise it is `idle`. */
    private settleAgent(pid: number): void {
        const agent: ProcessRecord = getProcess(this.db, pid);
        if (agent.state === "terminated" || agent.state === "suspended") return;
        if (runningThreadCount(this.db, pid) > 0) {
            if (agent.state !== "running") transitionProcess(this.db, pid, [agent.state], "running");
            return;
        }
        if (agent.state === "running") {
            transitionProcess(this.db, pid, ["running"], "idle");
        }
    }

    /** Load the task's page table and build its window for this step. */
    private windowFor(tid: number, at: string): ContextWindow {
        const window = new ContextWindow({
            capacityTokens: this.windowTokens,
            objects: this.objects,
            now: () => Date.parse(at),
        });
        const pages: WindowPageEntity[] = this.windows.pages(tid);
        if (pages.length > 0) {
            window.restore(
                pages.map((page) => ({
                    pageId: page.page_id,
                    objectKind: page.object_kind,
                    objectId: page.object_id,
                    tokens: page.tokens,
                    pinned: page.pinned !== 0,
                    lastUsed: page.last_used,
                })),
            );
        }
        return window;
    }

    private writeReceipt(task: ThreadRecord, at: string, usage: Budget, outcome: Outcome, note: string): Receipt {
        const count = this.db.prepare("SELECT COUNT(*) AS n FROM steps WHERE tid = ?").get(task.tid) as { n: number };
        const receipt: Receipt = {
            amp: "0.1",
            kind: "receipt",
            id: `rc.${task.tid}.${count.n + 1}`,
            op: "act",
            target: { kind: "thread", id: task.id },
            at,
            usage,
            outcome,
            note,
        };
        putObject(this.db, "receipt", receipt.id, receipt, at);
        return receipt;
    }

    private writeStep(pid: number, tid: number, at: string, status: string, usage: Budget, receiptId: Id, note?: string): void {
        this.db
            .prepare("INSERT INTO steps (pid, tid, at, outcome, usage, note, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(pid, tid, at, status, JSON.stringify(usage), note ?? null, receiptId);
    }

    private report(pid: number, tid: number, status: StepStatus, usage: Budget, receiptId: Id, note?: string): StepReport {
        const agent: ProcessRecord = getProcess(this.db, pid);
        const task: ThreadRecord = getThread(this.db, tid);
        const report: StepReport = {
            pid,
            tid,
            status,
            usage,
            receiptId,
            processState: agent.state,
            threadState: task.state,
        };
        if (note !== undefined) report.note = note;
        return report;
    }
}
