import type { Ignored, ImpasseState, Slot } from '../frame/frame.ts'
import type { Ref } from '../types/common.ts'

/** A scored candidate before it becomes a slot. Mirrors the §5.2 inputs. */
export interface Candidate {
  target: Ref
  role: Slot['role']
  tier?: Slot['tier']
  voi: number
  goalFit: number
  uncertainty: number
  novelty: number
  costTokens: number
  risk: number
  /** Trust cap: external content cannot buy salience, only lose it (A-4). */
  trustCap: number
  why: string
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/**
 * The reference salience function (§5.2).
 *
 * Only its monotonicity is normative: voi up ⇒ not down; cost/risk up ⇒ not up;
 * trust caps the result. The absolute numbers are a starting point, calibrated
 * over time via predicted vs realized VOI.
 */
export function salience(candidate: Candidate): number {
  const value =
    candidate.voi * candidate.goalFit * (0.5 + candidate.uncertainty) * (1 + 0.5 * candidate.novelty)
  const cost = 1 + 2 * clamp01(candidate.costTokens / 2000) + 3 * clamp01(candidate.risk)
  return Math.round(Math.min(clamp01(value / cost), clamp01(candidate.trustCap)) * 1000) / 1000
}

export interface SelectionOptions {
  budgetTokens: number
  cap?: number
  threshold?: number
}

export interface Selection {
  slots: Slot[]
  ignored: Ignored[]
  impasse?: ImpasseState
}

/**
 * Select a focus set under budget, and record deliberate exclusions (A-2).
 * The ignored list is the part classical architectures never kept.
 */
export function selectFocus(candidates: Candidate[], options: SelectionOptions): Selection {
  const threshold = options.threshold ?? 0.12
  const cap = options.cap ?? 7
  const scored = candidates
    .map((c) => ({ candidate: c, score: salience(c) }))
    .sort((a, b) => b.score - a.score)

  const ignored: Ignored[] = []
  const above: typeof scored = []

  for (const entry of scored) {
    if (entry.score < threshold) {
      ignored.push({
        target: entry.candidate.target,
        reason: 'low_voi',
        revisit_if: 'VOI 上升或目标改变',
      })
    } else {
      above.push(entry)
    }
  }

  if (above.length === 0) {
    return { slots: [], ignored, impasse: 'STUCK' }
  }

  const tie = above.length > 1 && Math.abs(above[0].score - above[1].score) < 0.02
  let remaining = options.budgetTokens
  const slots: Slot[] = []

  for (const { candidate, score } of above) {
    if (slots.length >= cap) {
      ignored.push({ target: candidate.target, reason: 'deferred', revisit_if: '焦点释放后' })
      continue
    }
    if (candidate.costTokens > remaining) {
      ignored.push({ target: candidate.target, reason: 'budget', revisit_if: '预算恢复后' })
      continue
    }
    remaining -= candidate.costTokens
    slots.push({
      target: candidate.target,
      role: candidate.role,
      tier: candidate.tier,
      salience: score,
      voi: candidate.voi,
      cost: { tokens: candidate.costTokens },
      budget: { tokens: candidate.costTokens },
      why: candidate.why,
      state: 'active',
    })
  }

  const impasse: ImpasseState | undefined =
    slots.length === 0 ? 'BUDGET' : tie ? 'TIE' : undefined

  return { slots, ignored, impasse }
}

/** Test helper: the contract's monotonicity constraints (§5.2). */
export function respectsMonotonicity(base: Candidate): boolean {
  const at = (over: Partial<Candidate>): number => salience({ ...base, ...over })
  const s0 = at({})
  return (
    at({ voi: Math.min(1, base.voi + 0.1) }) >= s0 &&
    at({ costTokens: base.costTokens + 200 }) <= s0 &&
    at({ risk: Math.min(1, base.risk + 0.1) }) <= s0 &&
    at({ trustCap: Math.min(base.trustCap, 0.2) }) <= s0
  )
}
