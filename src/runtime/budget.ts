import type { Budget, Usage } from '../types/common.ts'

export type BudgetDimension = 'tokens' | 'calls' | 'ms'

export class BudgetExceeded extends Error {
  readonly code = 'budget_exceeded'
  readonly dimension: BudgetDimension
  readonly limit: number
  readonly observed: number

  constructor(dimension: BudgetDimension, limit: number, observed: number) {
    super(`budget exceeded on ${dimension}: observed ${observed} > limit ${limit}`)
    this.name = 'BudgetExceeded'
    this.dimension = dimension
    this.limit = limit
    this.observed = observed
  }
}

export interface CallCost {
  tokens?: number
  calls?: number
  ms?: number
}

/**
 * The single metering point (A-3).
 *
 * The 2026 CVE-2026-114386 showed why this cannot live inside a sandbox: a
 * nested call that bypasses the outer counter makes every quota advisory.
 * Here, `run` charges *before* executing, so a nested orchestration that loops
 * still hits the same counter.
 */
export class Dispatcher {
  readonly lease: Budget
  private used: { tokens: number; calls: number; ms: number } = { tokens: 0, calls: 0, ms: 0 }

  constructor(lease: Budget) {
    this.lease = lease
  }

  run<T>(fn: () => T, cost: CallCost = {}): T {
    this.charge('tokens', cost.tokens ?? 0)
    this.charge('calls', cost.calls ?? 1)
    this.charge('ms', cost.ms ?? 0)
    return fn()
  }

  private charge(dimension: BudgetDimension, amount: number): void {
    if (amount === 0) return
    const limit = this.lease[dimension]
    const next = this.used[dimension] + amount
    if (limit !== undefined && next > limit) throw new BudgetExceeded(dimension, limit, next)
    this.used[dimension] = next
  }

  usage(): Usage {
    return { tokens: this.used.tokens, calls: this.used.calls, ms: this.used.ms }
  }

  remaining(): Required<Pick<Budget, 'tokens' | 'calls' | 'ms'>> {
    return {
      tokens: Math.max(0, (this.lease.tokens ?? 0) - this.used.tokens),
      calls: Math.max(0, (this.lease.calls ?? 0) - this.used.calls),
      ms: Math.max(0, (this.lease.ms ?? 0) - this.used.ms),
    }
  }
}
