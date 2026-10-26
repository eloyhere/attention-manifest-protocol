/**
 * AMP v0.1 — Warrant Ledger objects: claim | hypothesis | unknown.
 * Mirrors docs/schemas/epistemic.schema.json.
 *
 * Note: `confidence` is DERIVED by the Warrant Engine from `tier` + evidence.
 * It is modelled here for display, never as a field the model may author.
 */
import type {
  Budget,
  Confidence,
  Digest,
  Id,
  Provenance,
  Ref,
  Tier,
  Timestamp,
  Trust,
} from '../types/common.ts'

export type ClaimScope = 'associational' | 'interventional' | 'counterfactual' | 'definitional'
export type ClaimStatus = 'conjecture' | 'held' | 'doubted' | 'contested' | 'retracted'
export type EvidenceKind = 'observation' | 'test' | 'document' | 'testimony' | 'memory' | 'inference'
export type Inference =
  | 'observation'
  | 'deduction'
  | 'induction'
  | 'abduction'
  | 'testimony'
  | 'simulation'

export interface EvidenceItem {
  id: Id
  kind: EvidenceKind
  trust: Trust
  /** 0 = same origin as another item, 1 = fully independent. Duplicates are not corroboration. */
  independence: Confidence
  /** Whether this evidence helps, undercuts, or contradicts the claim. */
  relation?: 'supports' | 'undercuts' | 'contradicts'
  /** T1 requires `true`: the source must entail the claim, not merely mention it. */
  entails?: boolean
  /** Provenance root; items sharing an origin count as one effective source. */
  origin?: string
  ref?: Ref
  excerpt?: string
  digest?: Digest
  at: Timestamp
}

export interface Warrant {
  evidence: EvidenceItem[]
  inference: Inference
  /** Duhem–Quine: a refutation always hits a conjunction. Empty array is malformed for a negative result. */
  auxiliary_assumptions?: string[]
  strength: Confidence
}

export interface CausalClaim {
  assignment_mechanism: 'observed' | 'assigned' | 'randomized' | 'natural_experiment'
  identification_strategy?: string
  identifying_assumption?: string
  adjustment_set?: string[]
  dag_digest?: Digest
}

export interface Alternative {
  statement: string
  confidence: Confidence
  reason_rejected?: string
}

export interface BaseRate {
  value: Confidence
  source?: string
}

export interface Claim {
  amp: '0.1'
  kind: 'claim'
  id: Id
  statement: string
  structured?: { subject?: Ref; relation?: string; value?: unknown }
  claim_scope?: ClaimScope
  tier: Tier
  confidence?: Confidence
  status: ClaimStatus
  would_be_false_if?: string
  check_run_id?: string
  causal?: CausalClaim
  warrant: Warrant
  alternatives?: Alternative[]
  disconfirming?: Ref[]
  base_rate?: BaseRate
  looks?: number
  scope?: string
  provenance: Provenance
  created: Timestamp
  expires?: Timestamp
  supersedes?: Ref
  revision?: { reason: string; at: Timestamp }
}

export type HypothesisStatus =
  | 'proposed'
  | 'testing'
  | 'supported'
  | 'refuted'
  | 'inconclusive'
  | 'out_of_scope'

export interface Prereg {
  hash: Digest
  registered_at: Timestamp
  metric: string
  stopping: string
  exclusions?: string[]
  looks?: number
}

export interface TestSpec {
  method: string
  observation: string
  cost?: Budget
}

export interface Hypothesis {
  amp: '0.1'
  kind: 'hypothesis'
  id: Id
  question: Ref
  statement: string
  prediction: string
  /** The observation that would overturn it. Without this, it is a position, not a hypothesis. */
  refutes_if: string
  auxiliary_assumptions?: string[]
  prereg?: Prereg
  test?: TestSpec
  labels?: Array<'confirmatory' | 'exploratory' | 'replication'>
  status: HypothesisStatus
  evidence?: Ref[]
  created: Timestamp
  closed?: Timestamp
}

export interface UnknownItem {
  amp: '0.1'
  kind: 'unknown'
  id: Id
  question: string
  importance: Confidence
  blocking: boolean
  since: Timestamp
  resolve_cost?: Budget
  attempts?: Ref[]
  status?: 'open' | 'probing' | 'assumed' | 'resolved' | 'abandoned'
}

export type EpistemicObject = Claim | Hypothesis | UnknownItem
