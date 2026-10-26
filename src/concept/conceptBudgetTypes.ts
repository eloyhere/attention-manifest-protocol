/**
 * AMP v0.1 — concept economy.
 *
 * A concept is the unit that occupies an attention slot, so its size is paid on
 * every turn that uses it. Left alone, a concept accretes: examples pile up,
 * relations duplicate, old versions accumulate in the ledger. This layer bounds
 * both, without letting either the definition or the falsifiers be trimmed away.
 *
 * Two operations, deliberately separate:
 *
 * - **pruneConcept** returns a bounded *view* of one concept. Storage is
 *   untouched and `version` does not move: a view is not a revision.
 * - **compactConceptHistory** replaces every version except the head with a
 *   checkpoint that commits to their digest, so lineage stays provable.
 */
import type { Digest, Id, Timestamp } from '../types/common.ts'

export interface ConceptBudget {
  amp: '0.1'
  kind: 'concept-budget'
  /** Hard ceiling on examples in a view. */
  maxExamples: number
  /** Floor that keeps a concept grounded: zero examples would make it a label. */
  minExamples: number
  maxRelations: number
  /** Versions kept in storage besides the head. 1 means head only. */
  keepVersions: number
}

export type ConceptDropReason = 'duplicate' | 'over-budget' | 'dangling'

export interface ConceptDrop {
  slot: 'example' | 'relation' | 'extension'
  index: number
  /** Human-readable identification of what left the view. */
  summary: string
  reason: ConceptDropReason
  revisit_if: string
}

export interface ConceptPrunePlan {
  amp: '0.1'
  kind: 'concept-prune-plan'
  concept: Id
  version: number
  dropped: ConceptDrop[]
  reclaimedBytes: number
  budget: ConceptBudget
}

export interface ConceptCheckpoint {
  amp: '0.1'
  kind: 'concept-checkpoint'
  id: Id
  concept: Id
  from: number
  to: number
  count: number
  /** Digest of the last removed version, so a holder can spot a swap. */
  tip: Digest
  /** Digest over the removed versions, in version order. */
  root: Digest
  created: Timestamp
  budget: { keepVersions: number }
}
