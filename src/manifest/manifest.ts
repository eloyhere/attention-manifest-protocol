/**
 * AMP v0.1 — Manifest (心智清单): the durable, signable self-declaration.
 * Mirrors docs/schemas/manifest.schema.json.
 */
import type {
  Budget,
  Confidence,
  Digest,
  Id,
  Ref,
  Signature,
  Tier,
  Timestamp,
} from '../types/common.ts'

export interface AgentIdentity {
  id: Id
  name?: string
  version?: string
  role?: string
}

export interface ValueStatement {
  id: Id
  statement: string
  weight?: Confidence
}

/** Hard constraints are never traded off; soft ones may be. */
export interface Constraint {
  id: Id
  statement: string
  enforcement?: 'hard' | 'soft'
}

export interface Identity {
  values?: ValueStatement[]
  constraints?: Constraint[]
}

export interface Capability {
  id: Id
  label?: string
  kind: 'tool' | 'skill' | 'knowledge' | 'perception' | 'action'
  /** Must derive from receipts (M-1), not from self-assessment. */
  confidence: Confidence
  /** Evidence tier actually earned by this capability. New capabilities start at T0. */
  tier: Tier
  cost?: Budget
  limits?: string[]
  evidence?: Ref[]
}

export interface Commitment {
  id: Id
  to: Ref
  promise: string
  due?: Timestamp
  status: 'open' | 'kept' | 'broken' | 'released'
  created?: Timestamp
}

export interface ManifestUnknown {
  id: Id
  question: string
  importance: Confidence
  blocking: boolean
  since?: Timestamp
}

export interface AttentionConfig {
  policy_digest: Digest
  frame?: Ref
  budget: Budget
}

export interface CalibrationBucket {
  lo: number
  hi: number
  predicted: number
  observed: number
  n: number
}

/** MEASURED block: every number here is computed from receipts, never self-reported. */
export interface Calibration {
  ece: Confidence
  buckets?: CalibrationBucket[]
}

export interface SelfModel {
  calibration: Calibration
  limits?: string[]
  state?: {
    load?: Confidence
    mode?: 'explore' | 'exploit' | 'triage' | 'reflect' | 'rest'
  }
}

export interface Manifest {
  amp: '0.1'
  kind: 'manifest'
  agent: AgentIdentity
  issued: Timestamp
  expires: Timestamp
  digest: Digest
  identity?: Identity
  capabilities: Capability[]
  concepts?: Ref[]
  commitments?: Commitment[]
  unknowns?: ManifestUnknown[]
  attention: AttentionConfig
  self: SelfModel
  signatures: Signature[]
}
