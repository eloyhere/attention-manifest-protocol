import type { Digest, Id } from '../types/common.ts'
import type { Lease } from './team.ts'

export type TaskState = 'pending' | 'leased' | 'done' | 'cancelled'

export interface BoardTask {
  id: Id
  goalDigest: Digest
  state: TaskState
  owner?: Id
  lease?: Id
  attempts: number
}

export class DuplicateGoal extends Error {
  readonly code = 'duplicate_goal'
}

/**
 * Explicit shared task board.
 *
 * The board is the single authoritative place that answers "who is doing what".
 * A goal may have at most one unfinished task; completion or cancellation frees
 * the goal for a retry.
 */
export class TaskBoard {
  private readonly tasks = new Map<Id, BoardTask>()
  private readonly openByGoal = new Map<Digest, Id>()
  private seq = 0
  private rejected = 0
  private added = 0

  add(goalDigest: Digest): BoardTask {
    this.added += 1
    const open = this.openByGoal.get(goalDigest)
    if (open) {
      this.rejected += 1
      throw new DuplicateGoal(`goal already has task ${open}`)
    }
    this.seq += 1
    const task: BoardTask = { id: `tb.${this.seq}`, goalDigest, state: 'pending', attempts: 0 }
    this.tasks.set(task.id, task)
    this.openByGoal.set(goalDigest, task.id)
    return task
  }

  claim(taskId: Id, lease: Lease): BoardTask {
    const task = this.get(taskId)
    if (task.state === 'done' || task.state === 'cancelled') {
      throw new Error(`task ${taskId} is ${task.state}`)
    }
    if (task.lease && task.lease !== lease.id && task.state === 'leased') {
      throw new Error(`task ${taskId} is already leased to ${task.owner}`)
    }
    task.state = 'leased'
    task.owner = lease.holder
    task.lease = lease.id
    task.attempts += 1
    return task
  }

  complete(taskId: Id): BoardTask {
    const task = this.get(taskId)
    task.state = 'done'
    this.openByGoal.delete(task.goalDigest)
    return task
  }

  cancel(taskId: Id): BoardTask {
    const task = this.get(taskId)
    task.state = 'cancelled'
    this.openByGoal.delete(task.goalDigest)
    return task
  }

  get(taskId: Id): BoardTask {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    return task
  }

  list(): BoardTask[] {
    return [...this.tasks.values()]
  }

  /** Board-level counters feed the coordination metrics. */
  stats(): { added: number; rejected: number; open: number } {
    const open = this.list().filter((task) => task.state === 'pending' || task.state === 'leased').length
    return { added: this.added, rejected: this.rejected, open }
  }
}
