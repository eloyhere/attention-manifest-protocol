import type { Id, Tier } from '../types/common.ts'

export interface MergeClaim {
  id: Id
  /** What the claim is about, e.g. `deploy.cause`. Conflicts are detected per subject. */
  subject: string
  value: string
  tier: Tier
  agent: Id
  /** Distinct provenance roots behind this claim (not URLs). */
  origins: string[]
  /** Can the receiving agent re-run the observation itself? Only then does tier survive transfer. */
  replayable: boolean
}

export interface MergedClaim {
  subject: string
  value: string
  tier: Tier
  supporters: Id[]
  origins: string[]
  status: 'held' | 'contested' | 'single_agent'
}

export interface MergeResult {
  merged: MergedClaim[]
  conflicts: string[]
  warnings: string[]
}

export interface Adjudication {
  decision: 'accept' | 'escalate'
  value?: string
  reason: string
}

/**
 * Conflicts are resolved by evidence tier first, then by authority — never by
 * majority. If no side dominates, escalate to a named authority.
 */
export function adjudicate(contested: MergedClaim[], authority: Record<Id, number>): Adjudication {
  if (contested.length <= 1) {
    return { decision: 'accept', value: contested[0]?.value, reason: 'single value' }
  }

  const scored = contested
    .map((claim) => ({
      claim,
      score: Math.max(0, ...claim.supporters.map((agent) => authority[agent] ?? 0)),
    }))
    .sort(
      (a, b) =>
        ORDER.indexOf(b.claim.tier) - ORDER.indexOf(a.claim.tier) || b.score - a.score,
    )

  const [first, second] = scored
  if (ORDER.indexOf(first.claim.tier) > ORDER.indexOf(second.claim.tier)) {
    return { decision: 'accept', value: first.claim.value, reason: 'higher evidence tier' }
  }
  if (first.score > second.score) {
    return { decision: 'accept', value: first.claim.value, reason: 'higher authority' }
  }
  return { decision: 'escalate', reason: 'no side dominates; escalate to a named authority' }
}


const ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

function degrade(tier: Tier): Tier {
  const index = ORDER.indexOf(tier)
  return ORDER[Math.max(0, index - 1)]
}

/**
 * A claim does not keep its tier when it changes hands.
 * Unless the receiver can replay the observation, testimony is one level weaker.
 */
export function transferTier(claim: MergeClaim, receiver: Id): Tier {
  if (claim.agent === receiver) return claim.tier
  return claim.replayable ? claim.tier : degrade(claim.tier)
}

function capByIndependence(agents: Id[], origins: string[]): Tier {
  const distinctAgents = new Set(agents).size
  const distinctOrigins = new Set(origins).size
  if (distinctAgents >= 2 && distinctOrigins >= 2) return 'T4'
  if (distinctAgents >= 2) return 'T3'
  return 'T2'
}

/**
 * Merge contracts from several agents.
 *
 * Conflict is never averaged: two agents disagreeing yields `contested`,
 * both values retained, and a conflict entry. Consensus is not correctness.
 */
export function mergeResults(claims: MergeClaim[], options: { forAgent: Id }): MergeResult {
  const warnings: string[] = []
  const bySubject = new Map<string, MergeClaim[]>()

  for (const claim of claims) {
    const transferred = transferTier(claim, options.forAgent)
    if (transferred !== claim.tier) {
      warnings.push(`${claim.id}: tier degraded ${claim.tier} → ${transferred} on transfer`)
    }
    const normalised: MergeClaim = { ...claim, tier: transferred }
    const list = bySubject.get(claim.subject) ?? []
    list.push(normalised)
    bySubject.set(claim.subject, list)
  }

  const merged: MergedClaim[] = []
  const conflicts: string[] = []

  for (const [subject, group] of bySubject) {
    const values = [...new Set(group.map((claim) => claim.value))]
    const agents = [...new Set(group.map((claim) => claim.agent))]
    const origins = [...new Set(group.flatMap((claim) => claim.origins))]

    if (values.length > 1) {
      conflicts.push(subject)
      for (const value of values) {
        const supporters = group.filter((claim) => claim.value === value).map((claim) => claim.agent)
        const supportingOrigins = [...new Set(group.filter((claim) => claim.value === value).flatMap((claim) => claim.origins))]
        merged.push({
          subject,
          value,
          tier: capByIndependence(supporters, supportingOrigins),
          supporters: [...new Set(supporters)],
          origins: supportingOrigins,
          status: 'contested',
        })
      }
      continue
    }

    const highest = group
      .map((claim) => claim.tier)
      .sort((a, b) => ORDER.indexOf(b) - ORDER.indexOf(a))[0]
    const cap = capByIndependence(agents, origins)
    const tier = ORDER.indexOf(highest) <= ORDER.indexOf(cap) ? highest : cap

    merged.push({
      subject,
      value: values[0],
      tier,
      supporters: agents,
      origins,
      status: agents.length === 1 ? 'single_agent' : 'held',
    })
  }

  return { merged, conflicts, warnings }
}
