import type { Delegation, Lease } from './team.ts'
import type { DelegationDoc, LeaseDoc } from '../types/collaboration.ts'

/**
 * Wire mapping for collaboration objects.
 *
 * The runtime uses camelCase; the wire uses snake_case and stable names because
 * a delegation crosses domains and must not depend on an implementation's
 * internal naming. Round-tripping is tested, not assumed.
 */
export function toDelegationDoc(delegation: Delegation): DelegationDoc {
  return {
    amp: '0.1',
    kind: 'delegation',
    id: delegation.id,
    parent: delegation.parent,
    granter: delegation.granter,
    delegatee: delegation.delegatee,
    goal_digest: delegation.goalDigest,
    scope: delegation.scope,
    budget: delegation.budget,
    deadline: delegation.deadline,
    may_redelegate: delegation.mayRedelegate,
    depth: delegation.depth,
  }
}

export function fromDelegationDoc(doc: DelegationDoc): Delegation {
  const delegation: Delegation = {
    id: doc.id,
    granter: doc.granter,
    delegatee: doc.delegatee,
    goalDigest: doc.goal_digest,
    scope: doc.scope,
    budget: doc.budget,
    deadline: doc.deadline,
    mayRedelegate: doc.may_redelegate,
    depth: doc.depth,
  }
  if (doc.parent !== undefined) delegation.parent = doc.parent
  return delegation
}

export function toLeaseDoc(lease: Lease): LeaseDoc {
  return {
    amp: '0.1',
    kind: 'lease',
    id: lease.id,
    delegation: lease.delegation,
    task_id: lease.taskId,
    holder: lease.holder,
    fence: lease.fence,
    goal_digest: lease.goalDigest,
    budget: lease.budget,
    deadline: lease.deadline,
    status: lease.status,
  }
}
