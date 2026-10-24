/**
 * AMP v0.1 — common primitives.
 * Mirrors docs/schemas/common.schema.json.
 */

export type Id = string
export type Digest = string
export type Timestamp = string

/** Credence in [0, 1]. For claims this is DERIVED from tier + evidence, never authored. */
export type Confidence = number

/** Where evidence came from, which caps how far it can promote a claim. */
export type Trust = 'self' | 'verified' | 'trusted' | 'asserted' | 'inferred' | 'external'

/**
 * Epistemic investment tier.
 * T0 assumed · T1 sourced (entailment) · T2 observed · T3 tested · T4 replicated
 */
export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'

export type RefKind =
  | 'entity'
  | 'concept'
  | 'process'
  | 'question'
  | 'hypothesis'
  | 'claim'
  | 'evidence'
  | 'goal'
  | 'plan'
  | 'task'
  | 'tool'
  | 'memory'
  | 'other'
  | 'human'
  | 'agent'
  | 'event'
  | 'handle'
  | 'frame'
  | 'self'
  | 'unknown'
  | 'common-ground'
  | 'capability'
  | 'receipt'
  | 'org'

/** A pointer, not a copy. The ledger stores ids; content lives wherever it lives. */
export interface Ref {
  kind: RefKind
  id: Id
  label?: string
}

export type ProvenanceKind =
  | 'observation'
  | 'testimony'
  | 'inference'
  | 'tool'
  | 'memory'
  | 'document'
  | 'simulation'

export interface Provenance {
  source: string
  kind?: ProvenanceKind
  trust?: Trust
  at?: Timestamp
  digest?: Digest
  note?: string
}

/** Five-dimension attention budget. Dimensions do not convert into each other. */
export interface Budget {
  tokens?: number
  ms?: number
  calls?: number
  interrupts?: number
  money?: number
}

export type Usage = Budget

export interface Signature {
  role: 'self' | 'host' | 'registry' | 'org' | 'tenant'
  alg: 'ed25519'
  kid: string
  sig: string
}

/** An observable success / abandonment condition. `check` must be executable. */
export interface Criterion {
  id: Id
  statement: string
  check: string
  kind?: 'observe' | 'query' | 'assert'
}

/** Opaque reference to an oversized result. Never a capability token. */
export interface Handle {
  id: string
  kind: 'table' | 'text' | 'tree' | 'blob' | 'graph'
  tokens?: number
  bytes?: number
  preview?: string
  scope: 'turn' | 'session' | 'task'
  ttl_ms?: number
}
