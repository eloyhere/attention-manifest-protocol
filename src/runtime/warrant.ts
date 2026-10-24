import type { Claim, EvidenceItem, Hypothesis } from '../types/epistemic.ts'
import type { Tier } from '../types/common.ts'

const TIER_BASE: Record<Tier, number> = {
  T0: 0.35,
  T1: 0.55,
  T2: 0.72,
  T3: 0.85,
  T4: 0.92,
}

/** A chain is as strong as its weakest source, so the cap is the minimum. */
const TRUST_CAP: Record<EvidenceItem['trust'], number> = {
  self: 0.9,
  verified: 0.95,
  trusted: 0.85,
  asserted: 0.7,
  inferred: 0.6,
  external: 0.5,
}

const TIER_ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

const round = (n: number): number => Math.round(n * 1000) / 1000

/** Distinct origins, not distinct URLs. Ten retellings of one source are one source. */
export function effectiveOrigins(evidence: EvidenceItem[]): number {
  return new Set(evidence.map((e) => e.origin ?? e.id)).size
}

/**
 * Confidence is DERIVED (M-1), never authored by the model.
 * Tier sets the base, evidence quality moves it, the weakest source caps it.
 */
export function deriveConfidence(claim: Pick<Claim, 'tier' | 'warrant'>): number {
  const base = TIER_BASE[claim.tier]
  const evidence = claim.warrant.evidence
  if (evidence.length === 0) return round(Math.min(base, 0.6))

  const origins = effectiveOrigins(evidence)
  const avgIndependence = evidence.reduce((sum, e) => sum + (e.independence ?? 0.5), 0) / evidence.length
  const corroboration = Math.min(1, (origins - 1) / 2)
  const support =
    evidence.reduce((sum, e) => {
      const weight = e.independence ?? 0.5
      if (e.relation === 'contradicts') return sum - weight
      if (e.relation === 'undercuts') return sum - 0.5 * weight
      return sum + weight
    }, 0) / evidence.length
  const cap = Math.min(...evidence.map((e) => TRUST_CAP[e.trust]))

  const raw = base + 0.12 * corroboration + 0.1 * avgIndependence + 0.08 * support
  return round(Math.max(0, Math.min(raw, cap)))
}

/**
 * Tier inflation is a validation failure, not a style issue (W-5).
 * Returns human-readable violations; empty means admissible.
 */
export function validateClaim(claim: Claim): string[] {
  const problems: string[] = []
  const evidence = claim.warrant.evidence

  if (claim.tier !== 'T0' && evidence.length === 0) {
    problems.push(`${claim.tier} requires at least one evidence item`)
  }
  if (claim.tier === 'T1' && !evidence.some((e) => e.entails === true)) {
    problems.push('T1 requires a source that entails the claim (entails: true)')
  }
  if (claim.tier === 'T2' && !evidence.some((e) => e.trust === 'self' || e.trust === 'verified')) {
    problems.push('T2 requires an observation recorded by this agent')
  }
  if (claim.tier === 'T3') {
    if (!claim.causal || claim.causal.assignment_mechanism === 'observed') {
      problems.push('T3 requires an intervention, randomization, or named identification strategy')
    }
  }
  if (claim.tier === 'T4' && effectiveOrigins(evidence) < 2) {
    problems.push('T4 requires an independent replication (at least two origins)')
  }
  if (claim.causal && claim.causal.assignment_mechanism === 'observed' && claim.claim_scope === 'interventional') {
    problems.push('observational data cannot support an interventional claim without an identification strategy')
  }

  return problems
}

/** A hypothesis without a refutation condition is a position, not a hypothesis (W-2). */
export function validateHypothesis(hypothesis: Hypothesis): string[] {
  const problems: string[] = []
  if (!hypothesis.refutes_if || hypothesis.refutes_if.trim().length === 0) {
    problems.push('refutes_if is required')
  }
  if (!hypothesis.prediction || hypothesis.prediction.trim().length === 0) {
    problems.push('prediction is required')
  }
  return problems
}

/** Registered before data access → confirmatory; otherwise → exploratory (no HARKing). */
export function classifyHypothesis(hypothesis: Hypothesis): 'confirmatory' | 'exploratory' {
  return hypothesis.prereg ? 'confirmatory' : 'exploratory'
}

/**
 * Contested or doubted claims may enter a Frame but must not authorize effects.
 * Returns false whenever the claim is not carried beyond reasonable doubt.
 */
export function canAuthorizeEffect(claim: Claim, minTier: Tier): boolean {
  if (claim.status !== 'held') return false
  if (TIER_ORDER.indexOf(claim.tier) < TIER_ORDER.indexOf(minTier)) return false
  const confidence = claim.confidence ?? deriveConfidence(claim)
  return confidence >= 0.6
}

/** Minimal-change revision: the old claim is kept and referenced, never overwritten (W-3). */
export function reviseClaim(previous: Claim, patch: Partial<Claim>, reason: string, at: string): Claim {
  return {
    ...previous,
    ...patch,
    id: `${previous.id}.r${(previous.revision ? 1 : 0) + 1}`,
    supersedes: { kind: 'claim', id: previous.id },
    revision: { reason, at },
    created: previous.created,
  }
}

/** Suggested tier for a claim — used only to warn, never to promote silently. */
export function suggestTier(evidence: EvidenceItem[]): Tier {
  if (evidence.length === 0) return 'T0'
  if (effectiveOrigins(evidence) >= 2 && evidence.some((e) => e.trust === 'verified')) return 'T4'
  if (evidence.some((e) => e.trust === 'self' || e.trust === 'verified')) return 'T2'
  if (evidence.some((e) => e.entails === true)) return 'T1'
  return 'T0'
}
