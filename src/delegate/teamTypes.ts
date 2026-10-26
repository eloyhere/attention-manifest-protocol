/**
 * AMP v0.1 — team manifest and commitment record.
 * Mirrors docs/schemas/team.schema.json.
 */
import type { Budget, Criterion, Id, Timestamp } from '../types/common.ts'

export interface TeamMember {
  id: Id
  role: string
  capabilities?: string[]
  /** Explicit, enumerable authority. A member may never exceed it. */
  authority: string[]
}

export interface TeamManifest {
  amp: '0.1'
  kind: 'team-manifest'
  id: Id
  version: number
  members: TeamMember[]
  max_depth: number
  max_fanout: number
  budget: Budget
  termination: 'verified' | 'budget' | 'stall' | 'authority'
  attested_at: Timestamp
}

/**
 * Joint commitment: active only after every party accepts, and it cannot be
 * rescinded by one side alone (Gilbert). Breach takes the notify-and-repair path.
 */
export interface CommitmentRecord {
  amp: '0.1'
  kind: 'commitment-record'
  id: Id
  parties: Id[]
  proposition: string
  satisfaction: Criterion[]
  status: 'proposed' | 'active' | 'discharged' | 'cancelled' | 'breached'
  proposed_by: Id
  accepted_by?: Id[]
  created: Timestamp
}

export type TeamObject = TeamManifest | CommitmentRecord
