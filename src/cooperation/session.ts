import type { Budget, Digest, Id, Timestamp } from "../types/common.ts";
import type { AttentionRequest } from "../attention/socialTypes.ts";
import type { TeamManifest } from "../delegate/teamTypes.ts";
import { TaskBoard, type BoardTask } from "../cooperation/board.ts";
import { coordinationMetrics, type CoordinationMetrics } from "../cooperation/metrics.ts";
import type { MergeResult } from "../cooperation/merge.ts";
import { TeamRuntime, type Delegation, type Lease } from "../delegate/team.ts";
import { UnifiedLedger, type UnifiedSnapshot } from "../cooperation/unified.ts";

/**
 * Wiring required to open a session: the budget account, the clock and the
 * optional team manifest.
 */
type TeamSessionOptions = {
    budget: Budget;
    now: () => Timestamp;
    manifest?: TeamManifest;
};

/**
 * Work item a delegation claims on the board.
 */
type StartInput = {
    taskId: Id;
    holder: Id;
    goalDigest: Digest;
    budget: Budget;
    deadline: Timestamp;
};

/**
 * Task and lease produced by `start()`.
 */
type StartedWork = {
    task: BoardTask;
    lease: Lease;
};

/**
 * Lease and task produced by `finish()`.
 */
type FinishedWork = {
    lease: Lease;
    task: BoardTask;
};

/**
 * Lease and optional task produced by `cancel()`.
 */
type CancelledWork = {
    lease: Lease;
    task?: BoardTask;
};

/**
 * One real collaboration session: team authority, board, lease and the unified
 * budget account are wired together so none of them can drift.
 */
export class TeamSession {
    readonly team: TeamRuntime;
    readonly board = new TaskBoard();
    readonly ledger: UnifiedLedger;
    private readonly manifest?: TeamManifest;
    private readonly leaseToTask = new Map<Id, Id>();

    constructor(options: TeamSessionOptions) {
        this.manifest = options.manifest;
        this.team = new TeamRuntime({ now: options.now });
        this.ledger = new UnifiedLedger({ budget: options.budget, now: options.now });
    }

    delegate(input: Omit<Delegation, "id">): Delegation {
        return this.team.createDelegation(input, this.manifest);
    }

    /**
     * Board first: a duplicate goal never consumes a lease.
     */
    start(delegationId: Id, input: StartInput): StartedWork {
        const task: BoardTask = this.board.add(input.goalDigest);
        try {
            const lease: Lease = this.team.issueLease(delegationId, input);
            this.board.claim(task.id, lease);
            this.leaseToTask.set(lease.id, task.id);
            return { task: this.board.get(task.id), lease };
        } catch (error) {
            this.board.cancel(task.id);
            throw error;
        }
    }

    /**
     * Reserve on the lease, charge the shared account, then settle.
     */
    spend<T>(leaseId: Id, cost: Budget, fn: () => T): T {
        this.team.reserve(leaseId, cost);
        try {
            return this.ledger.spend(fn, cost);
        } finally {
            this.team.settle(leaseId, cost);
        }
    }

    finish(leaseId: Id): FinishedWork {
        const lease: Lease = this.team.complete(leaseId);
        const taskId: Id | undefined = this.leaseToTask.get(leaseId);
        const task: BoardTask | undefined = taskId ? this.board.complete(taskId) : undefined;
        if (!task) {
            throw new Error(`lease ${leaseId} has no board task`);
        }
        return { lease, task };
    }

    cancel(leaseId: Id): CancelledWork {
        const lease: Lease = this.team.cancel(leaseId);
        const taskId: Id | undefined = this.leaseToTask.get(leaseId);
        return { lease, task: taskId ? this.board.cancel(taskId) : undefined };
    }

    requestAttention(request: AttentionRequest) {
        return this.ledger.requestAttention(request);
    }

    snapshot(): UnifiedSnapshot {
        return this.ledger.snapshot();
    }

    metrics(merge?: MergeResult): CoordinationMetrics {
        return coordinationMetrics({ board: this.board, snapshot: this.snapshot(), merge });
    }
}
