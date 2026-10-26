/**
 * Rate, circuit-breaker and money guards for the dispatcher.
 *
 * `Dispatcher` enforces the hard budget (A-3). It does not limit the rate of
 * calls, stop a failing dependency from being hammered, or account for money.
 * Those are controls, not meters; they belong before dispatch, not in a report.
 */

export interface RateLimitOptions {
  /** Maximum number of dispatches in one sliding window. */
  limit: number
  /** Window length in milliseconds. */
  intervalMs: number
}

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. */
  failures: number
  /** How long the circuit stays open before a half-open trial. */
  cooldownMs: number
}

export interface GuardOptions {
  /** Injected clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number
  rate?: RateLimitOptions
  breaker?: BreakerOptions
  /** Maximum cumulative money that may be committed. */
  costCeiling?: number
}

export interface GuardSnapshot {
  /** Total money committed through `beforeDispatch`. */
  spent: number
  /** Consecutive failures since the last success. */
  failures: number
  /** True while the circuit is open. */
  open: boolean
  /** Dispatches recorded in the current rate window. */
  windowCount: number
  /** Milliseconds until the next dispatch may be attempted, when blocked. */
  retryAfterMs: number
}

export class RateLimited extends Error {
  readonly code = 'rate_limited'
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(`rate limit exceeded; retry after ${Math.max(0, Math.ceil(retryAfterMs))}ms`)
    this.name = 'RateLimited'
    this.retryAfterMs = retryAfterMs
  }
}

export class CircuitOpen extends Error {
  readonly code = 'circuit_open'
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super(`circuit open; retry after ${Math.max(0, Math.ceil(retryAfterMs))}ms`)
    this.name = 'CircuitOpen'
    this.retryAfterMs = retryAfterMs
  }
}

export class CostCeilingExceeded extends Error {
  readonly code = 'budget_exceeded'
  readonly dimension = 'money'
  readonly limit: number
  readonly observed: number

  constructor(limit: number, observed: number) {
    super(`budget exceeded on money: observed ${observed} > limit ${limit}`)
    this.name = 'CostCeilingExceeded'
    this.limit = limit
    this.observed = observed
  }
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
}

/**
 * A small, synchronous guard. It has no timers and no sleeps: the host decides
 * how to handle a `RateLimited`/`CircuitOpen` error (queue, back off, or fail).
 *
 * The rate window is sliding; the breaker is consecutive-failure based. A
 * successful dispatch closes the breaker. The guard records money at
 * `beforeDispatch` time, matching the dispatcher's charge-before-run rule.
 */
export class Guard {
  private readonly clock: () => number
  private readonly rate?: RateLimitOptions
  private readonly breaker?: BreakerOptions
  private readonly costCeiling?: number
  private readonly events: number[] = []
  private failures = 0
  private openedAt: number | null = null
  private spent = 0

  constructor(options: GuardOptions = {}) {
    this.clock = options.now ?? (() => Date.now())
    if (options.rate) {
      if (!Number.isInteger(options.rate.limit) || options.rate.limit < 0) {
        throw new RangeError('rate.limit must be a non-negative integer')
      }
      if (!Number.isFinite(options.rate.intervalMs) || options.rate.intervalMs <= 0) {
        throw new RangeError('rate.intervalMs must be a positive finite number')
      }
      this.rate = { ...options.rate }
    }
    if (options.breaker) {
      if (!Number.isInteger(options.breaker.failures) || options.breaker.failures <= 0) {
        throw new RangeError('breaker.failures must be a positive integer')
      }
      if (!Number.isFinite(options.breaker.cooldownMs) || options.breaker.cooldownMs < 0) {
        throw new RangeError('breaker.cooldownMs must be a non-negative finite number')
      }
      this.breaker = { ...options.breaker }
    }
    if (options.costCeiling !== undefined) {
      assertNonNegative(options.costCeiling, 'costCeiling')
      this.costCeiling = options.costCeiling
    }
  }

  /** Check all controls and commit the money cost. Throws before any tool runs. */
  beforeDispatch(cost: { money?: number } = {}): void {
    const money = cost.money ?? 0
    assertNonNegative(money, 'money')
    const now = this.clock()

    if (this.rate) this.prune(now)
    if (this.rate && this.events.length >= this.rate.limit) {
      const oldest = this.events[0] ?? now
      throw new RateLimited(this.rate.intervalMs - (now - oldest))
    }

    if (this.breaker && this.openedAt !== null) {
      const elapsed = now - this.openedAt
      if (elapsed < this.breaker.cooldownMs) {
        throw new CircuitOpen(this.breaker.cooldownMs - elapsed)
      }
      this.openedAt = null
      this.failures = 0
    }

    if (this.costCeiling !== undefined && this.spent + money > this.costCeiling) {
      throw new CostCeilingExceeded(this.costCeiling, this.spent + money)
    }

    if (this.rate) this.events.push(now)
    this.spent += money
  }

  recordSuccess(): void {
    this.failures = 0
    this.openedAt = null
  }

  recordFailure(): void {
    this.failures += 1
    if (this.breaker && this.failures >= this.breaker.failures) {
      this.openedAt = this.clock()
    }
  }

  snapshot(): GuardSnapshot {
    const now = this.clock()
    if (this.rate) this.prune(now)
    let retryAfterMs = 0
    if (this.rate && this.events.length >= this.rate.limit) {
      retryAfterMs = Math.max(0, this.rate.intervalMs - (now - (this.events[0] ?? now)))
    }
    if (this.breaker && this.openedAt !== null) {
      retryAfterMs = Math.max(retryAfterMs, this.breaker.cooldownMs - (now - this.openedAt))
    }
    return {
      spent: this.spent,
      failures: this.failures,
      open: this.openedAt !== null,
      windowCount: this.events.length,
      retryAfterMs,
    }
  }

  private prune(now: number): void {
    if (!this.rate) return
    const horizon = now - this.rate.intervalMs
    while (this.events.length > 0 && (this.events[0] ?? 0) <= horizon) this.events.shift()
  }
}
