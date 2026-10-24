import type { TaskBoard } from './board.ts'
import type { MergeResult } from './merge.ts'
import type { UnifiedSnapshot } from './unified.ts'

export interface CoordinationMetrics {
  /** Rejected duplicate tasks / all attempted tasks. */
  duplicateTaskRate: number
  /** Human interrupts / (tool calls + interrupts). Alignment overhead proxy. */
  alignmentTokenShare: number
  /** Tokens spent per completed task. */
  costPerSuccess: number
  /** Contested subjects / all merged subjects. */
  contestedRate: number
}

/**
 * Coordination is not free, so it has to be measured.
 * All four numbers come from ledgers and boards — never from self-report.
 */
export function coordinationMetrics(input: {
  board: TaskBoard
  snapshot: UnifiedSnapshot
  merge?: MergeResult
}): CoordinationMetrics {
  const stats = input.board.stats()
  const done = input.board.list().filter((task) => task.state === 'done').length
  const knowledgeOps = input.snapshot.calls + input.snapshot.interruptsGranted

  const subjects = input.merge ? new Set(input.merge.merged.map((item) => item.subject)).size : 0

  return {
    duplicateTaskRate: stats.added === 0 ? 0 : round(stats.rejected / stats.added),
    alignmentTokenShare: knowledgeOps === 0 ? 0 : round(input.snapshot.interruptsGranted / knowledgeOps),
    costPerSuccess: done === 0 ? 0 : round(input.snapshot.tokens / done),
    contestedRate: subjects === 0 ? 0 : round((input.merge?.conflicts.length ?? 0) / subjects),
  }
}

const round = (value: number): number => Math.round(value * 1000) / 1000
