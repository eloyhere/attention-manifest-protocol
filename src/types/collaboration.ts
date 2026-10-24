/**
 * AMP v0.1 — collaboration: delegation, lease, result contract.
 * Mirrors docs/schemas/collaboration.schema.json.
 *
 * The delegation is the wire object; the lease is the local execution right.
 * Neither transfers authority beyond what the granter already held.
 */
import type { Budget, Digest, Id, Ref, Timestamp } from './common.ts'

export interface DelegationDoc {
  amp: '0.1'
  kind: 'delegation'
  id: Id
  parent?: Id
  granter: Id
  delegatee: Id
  goal_digest: Digest
  scope: string[]
  budget: Budget
  deadline: Timestamp
  may_redelegate: boolean
  depth: number
}

export interface LeaseDoc {
  amp: '0.1'
  kind: 'lease'
  id: Id
  delegation: Id
  task_id: Id
  holder: Id
  fence: number
  goal_digest: Digest
  budget: Budget
  deadline: Timestamp
  status: 'active' | 'done' | 'cancelled'
}

export interface ResultArtifact {
  id: Id
  digest: Digest
}

/** The only accepted shape of a delegatee's answer: claims + evidence + unknowns. */
export interface ResultContract {
  amp: '0.1'
  kind: 'result-contract'
  id: Id
  lease: Id
  goal_digest: Digest
  claims: Ref[]
  evidence: Ref[]
  unknowns: string[]
  artifacts: ResultArtifact[]
  status: 'ok' | 'partial' | 'failed'
}

export type CollaborationObject = DelegationDoc | LeaseDoc | ResultContract
