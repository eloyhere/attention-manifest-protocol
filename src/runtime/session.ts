import type { Budget, Digest, Id, Timestamp } from '../types/common.ts'
import type { AttentionRequest } from '../types/social.ts'
import type { TeamManifest } from '../types/team.ts'
import { TaskBoard, type BoardTask } from './board.ts'
import { coordinationMetrics, type CoordinationMetrics } from './metrics.ts'
import type { MergeResult } from './merge.ts'
import { TeamRuntime, type Delegation, type Lease } from './team.ts'
import { UnifiedLedger, type UnifiedSnapshot } from './unified.ts'

/**
 * One real collaboration session: team authority, board, lease and the unified
 * budget account are wired together so none of them can drift.
 */
export class TeamSession {
  readonly team: TeamRuntime
  readonly board = new TaskBoard()
  readonly ledger: UnifiedLedger
  private readonly manifest?: TeamManifest
  private readonly leaseToTask = new Map<Id, Id>()

  constructor(options: {
    budget: Budget
    now: () => Timestamp
    manifest?: TeamManifest
  }) {
    this.manifest = options.manifest
    this.team = new TeamRuntime({ now: options.now })
    this.ledger = new UnifiedLedger({ budget: options.budget, now: options.now })
  }

  delegate(input: Omit<Delegation, 'id'>): Delegation {
    return this.team.createDelegation(input, this.manifest)
  }

  /** Board first: a duplicate goal never consumes a lease. */
  start(
    delegationId: Id,
    input: { taskId: Id; holder: Id; goalDigest: Digest; budget: Budget; deadline: Timestamp },
  ): { task: BoardTask; lease: Lease } {
    const task = this.board.add(input.goalDigest)
    try {
      const lease = this.team.issueLease(delegationId, input)
      this.board.claim(task.id, lease)
      this.leaseToTask.set(lease.id, task.id)
      return { task: this.board.get(task.id), lease }
    } catch (error) {
      this.board.cancel(task.id)
      throw error
    }
  }

  /** Reserve on the lease, charge the shared account, then settle. */
  spend<T>(leaseId: Id, cost: Budget, fn: () => T): T {
    this.team.reserve(leaseId, cost)
    try {
      return this.ledger.spend(fn, cost)
    } finally {
      this.team.settle(leaseId, cost)
    }
  }

  finish(leaseId: Id): { lease: Lease; task: BoardTask } {
    const lease = this.team.complete(leaseId)
    const taskId = this.leaseToTask.get(leaseId)
    const task = taskId ? this.board.complete(taskId) : undefined
    if (!task) throw new Error(`lease ${leaseId} has no board task`)
    return { lease, task }
  }

  cancel(leaseId: Id): { lease: Lease; task?: BoardTask } {
    const lease = this.team.cancel(leaseId)
    const taskId = this.leaseToTask.get(leaseId)
    return { lease, task: taskId ? this.board.cancel(taskId) : undefined }
  }

  requestAttention(request: AttentionRequest) {
    return this.ledger.requestAttention(request)
  }

  snapshot(): UnifiedSnapshot {
    return this.ledger.snapshot()
  }

  metrics(merge?: MergeResult): CoordinationMetrics {
    return coordinationMetrics({ board: this.board, snapshot: this.snapshot(), merge })
  }
}
