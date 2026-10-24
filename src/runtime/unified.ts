import type { Budget, Timestamp } from '../types/common.ts'
import type { AttentionRequest } from '../types/social.ts'
import { Dispatcher } from './budget.ts'
import { AttentionBroker, type AttentionPolicy } from './social.ts'

export interface UnifiedSnapshot {
  tokens: number
  calls: number
  ms: number
  interruptsGranted: number
  debtScore: number
}

/**
 * One account for compute and human attention.
 *
 * The two budgets stay non-exchangeable (A-3), but they share a clock and a
 * snapshot so a team cannot claim it "has budget" while owing interruptions.
 */
export class UnifiedLedger {
  readonly dispatcher: Dispatcher
  readonly attention: AttentionBroker
  private readonly now: () => Timestamp

  constructor(options: {
    budget: Budget
    now: () => Timestamp
    policy?: Partial<AttentionPolicy>
  }) {
    this.dispatcher = new Dispatcher(options.budget)
    this.attention = new AttentionBroker({ now: options.now, policy: options.policy })
    this.now = options.now
  }

  /** Charge before dispatch; over-budget work never starts. */
  spend<T>(fn: () => T, cost: { tokens?: number; calls?: number; ms?: number }): T {
    return this.dispatcher.run(fn, cost)
  }

  requestAttention(request: AttentionRequest) {
    return this.attention.submit(request)
  }

  snapshot(): UnifiedSnapshot {
    const usage = this.dispatcher.usage()
    return {
      tokens: usage.tokens ?? 0,
      calls: usage.calls ?? 0,
      ms: usage.ms ?? 0,
      interruptsGranted: this.attention.grantedCount(),
      debtScore: this.attention.debtScore(this.now()),
    }
  }

  remaining(): Required<Pick<Budget, 'tokens' | 'calls' | 'ms'>> {
    return this.dispatcher.remaining()
  }
}
