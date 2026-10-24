import type { Id, Timestamp } from '../types/common.ts'
import type { AttentionRequest, InterruptClass } from '../types/social.ts'

export type Decision = 'grant' | 'defer' | 'deny'

export interface AttentionPolicy {
  /** Grants allowed per class per rolling hour. Safety is never blocked by this. */
  budgets: Record<InterruptClass, number>
  quietHours?: { start: number; end: number }
  cooldownMinutes?: number
  /** Curiosity must clear this expected value to be granted at all. */
  curiosityFloor?: number
}

export const DEFAULT_POLICY: AttentionPolicy = {
  budgets: { safety: 1, commitment: 3, opportunity: 2, curiosity: 1 },
  quietHours: { start: 22, end: 7 },
  cooldownMinutes: 10,
  curiosityFloor: 0.7,
}

export interface AttentionDecision {
  request: Id
  decision: Decision
  reason: string
  at: Timestamp
  class: InterruptClass
  debtAdded: boolean
}

export interface DebtEntry {
  request: Id
  class: InterruptClass
  openedAt: Timestamp
  weight: number
  resolvedAt?: Timestamp
}

/**
 * Attention broker (Profile `Social`).
 *
 * The human's attention is a budgeted resource, not a callable function.
 * Safety bypasses the budget; everything else queues, cools down, or is denied.
 */
export class AttentionBroker {
  private readonly policy: AttentionPolicy
  private readonly now: () => Timestamp
  private readonly requests = new Map<Id, AttentionRequest>()
  private readonly decisions = new Map<Id, AttentionDecision>()
  private readonly grants = new Map<InterruptClass, Timestamp[]>()
  private readonly lastTouch = new Map<Id, number>()
  private readonly debt: DebtEntry[] = []

  constructor(options: { now: () => Timestamp; policy?: Partial<AttentionPolicy> }) {
    this.now = options.now
    this.policy = {
      ...DEFAULT_POLICY,
      ...options.policy,
      budgets: { ...DEFAULT_POLICY.budgets, ...(options.policy?.budgets ?? {}) },
    }
  }

  submit(request: AttentionRequest): AttentionDecision {
    if (!request.why_now || !request.if_ignored) {
      throw new Error('an attention request needs why_now and if_ignored')
    }
    if (this.requests.has(request.id)) throw new Error(`duplicate request: ${request.id}`)
    this.requests.set(request.id, request)

    const at = this.now()
    const kind = request.class
    const decision = this.decide(request, at, kind)
    this.decisions.set(request.id, decision)

    if (decision.decision === 'grant') {
      this.recordGrant(kind, at)
      this.lastTouch.set(request.target.id, Date.parse(at))
    }
    if (decision.decision !== 'grant') this.lastTouch.set(request.id, Date.parse(at))
    if (decision.debtAdded) {
      this.debt.push({ request: request.id, class: kind, openedAt: at, weight: request.urgency })
    }
    return decision
  }

  private decide(request: AttentionRequest, at: Timestamp, kind: InterruptClass): AttentionDecision {
    const immediate: AttentionDecision = {
      request: request.id,
      decision: 'grant',
      reason: 'safety_bypass',
      at,
      class: kind,
      debtAdded: false,
    }
    if (kind === 'safety') return immediate

    const hour = new Date(at).getUTCHours()
    const quiet = this.policy.quietHours
    const inQuietHours = quiet ? (quiet.start <= quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end) : false
    if (inQuietHours) return this.defer(request, at, kind, 'quiet_hours')

    const cooldown = this.policy.cooldownMinutes ?? 0
    const touched = this.lastTouch.get(request.target.id)
    if (touched !== undefined && cooldown > 0) {
      const elapsed = (Date.parse(at) - touched) / 60_000
      if (elapsed < cooldown) return this.defer(request, at, kind, 'cooldown')
    }

    if (kind === 'curiosity' && (request.expected_value ?? 0) < (this.policy.curiosityFloor ?? 0)) {
      return { request: request.id, decision: 'deny', reason: 'curiosity_below_floor', at, class: kind, debtAdded: false }
    }

    if (this.grantedThisHour(kind, at) >= this.policy.budgets[kind]) {
      return request.fallback === 'queue'
        ? this.defer(request, at, kind, 'budget_exhausted')
        : { request: request.id, decision: 'deny', reason: 'budget_exhausted', at, class: kind, debtAdded: false }
    }

    return { request: request.id, decision: 'grant', reason: 'within_budget', at, class: kind, debtAdded: false }
  }

  private defer(request: AttentionRequest, at: Timestamp, kind: InterruptClass, reason: string): AttentionDecision {
    if (request.fallback === 'drop') {
      return { request: request.id, decision: 'deny', reason: `${reason}:fallback_drop`, at, class: kind, debtAdded: false }
    }
    this.lastTouch.set(request.target.id, Date.parse(at))
    return { request: request.id, decision: 'defer', reason, at, class: kind, debtAdded: true }
  }

  private grantedThisHour(kind: InterruptClass, at: Timestamp): number {
    const now = Date.parse(at)
    const window = (this.grants.get(kind) ?? []).filter((stamp) => now - Date.parse(stamp) < 3_600_000)
    this.grants.set(kind, window)
    return window.length
  }

  private recordGrant(kind: InterruptClass, at: Timestamp): void {
    const list = this.grants.get(kind) ?? []
    list.push(at)
    this.grants.set(kind, list)
    this.lastTouch.set(kind, Date.parse(at))
  }

  /** Resolve a deferred request: it is answered, expired, or withdrawn. */
  resolve(requestId: Id, outcome: 'answered' | 'expired' | 'withdrawn' = 'answered'): void {
    const entry = this.debt.find((item) => item.request === requestId && !item.resolvedAt)
    if (!entry) throw new Error(`no open debt for ${requestId}`)
    entry.resolvedAt = this.now()
    void outcome
  }

  /** Age-weighted debt: minutes open × urgency. Higher means more owed. */
  debtScore(at: Timestamp = this.now()): number {
    const now = Date.parse(at)
    return Math.round(
      this.debt.reduce((sum, entry) => {
        const end = entry.resolvedAt ? Date.parse(entry.resolvedAt) : now
        return sum + Math.max(0, (end - Date.parse(entry.openedAt)) / 60_000) * entry.weight
      }, 0),
    )
  }

  openDebt(): DebtEntry[] {
    return this.debt.filter((entry) => !entry.resolvedAt)
  }

  /** How many requests were granted (feeds the unified ledger snapshot). */
  grantedCount(): number {
    let count = 0
    for (const decision of this.decisions.values()) if (decision.decision === 'grant') count += 1
    return count
  }

  decisionOf(requestId: Id): AttentionDecision | undefined {
    return this.decisions.get(requestId)
  }
}
