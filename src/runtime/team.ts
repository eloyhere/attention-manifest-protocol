import type { Budget, Digest, Id, Timestamp } from '../types/common.ts'
import type { TeamManifest } from '../types/team.ts'

export interface Delegation {
  id: Id
  parent?: Id
  granter: Id
  delegatee: Id
  goalDigest: Digest
  scope: string[]
  budget: Budget
  deadline: Timestamp
  mayRedelegate: boolean
  depth: number
}

export interface Lease {
  id: Id
  delegation: Id
  taskId: Id
  holder: Id
  fence: number
  goalDigest: Digest
  budget: Budget
  deadline: Timestamp
  status: 'active' | 'done' | 'cancelled'
}

export class AttenuationError extends Error {
  readonly code = 'delegation_widened'
}

export class FencingError extends Error {
  readonly code = 'stale_writer'
}

export class DuplicateTask extends Error {
  readonly code = 'duplicate_goal'
}

export class BudgetError extends Error {
  readonly code = 'budget_exceeded'
}

const DIMS = ['tokens', 'calls', 'ms', 'interrupts', 'money'] as const

/** Child budgets may only shrink; every dimension is checked independently. */
function attenuate(parent: Budget, child: Budget): void {
  for (const dim of DIMS) {
    const cap = parent[dim]
    const request = child[dim]
    if (request !== undefined && cap !== undefined && request > cap) {
      throw new AttenuationError(`child ${dim} ${request} exceeds parent ${cap}`)
    }
  }
}

/**
 * Team runtime: delegation → lease → reservation → result.
 * All authority checks happen locally; a peer's promise is never trusted.
 */
export class TeamRuntime {
  private readonly delegations = new Map<Id, Delegation>()
  private readonly leases = new Map<Id, Lease>()
  private readonly activeByGoal = new Map<Digest, Id>()
  private readonly fences = new Map<Id, number>()
  private readonly reserved = new Map<Id, Budget>()
  private readonly spent = new Map<Id, Budget>()
  private readonly now: () => Timestamp
  private seq = 0

  constructor(options: { now: () => Timestamp }) {
    this.now = options.now
  }

  /** Injected clock, exposed so leases and receipts share one timeline. */
  nowIso(): Timestamp {
    return this.now()
  }

  createDelegation(input: Omit<Delegation, 'id'>, manifest?: TeamManifest): Delegation {
    if (manifest) this.enforceManifest(input, manifest)
    if (input.depth > 2) throw new AttenuationError('delegation depth exceeds 2')
    if (input.parent) {
      const parent = this.delegations.get(input.parent)
      if (!parent) throw new AttenuationError(`unknown parent delegation ${input.parent}`)
      if (!parent.mayRedelegate) throw new AttenuationError('parent does not allow re-delegation')
      attenuate(parent.budget, input.budget)
      if (input.deadline > parent.deadline) throw new AttenuationError('child deadline exceeds parent')
    }
    this.seq += 1
    const delegation: Delegation = { ...input, id: `dl.${this.seq}` }
    this.delegations.set(delegation.id, delegation)
    return delegation
  }

  issueLease(
    delegationId: Id,
    input: { taskId: Id; holder: Id; goalDigest: Digest; budget: Budget; deadline: Timestamp },
  ): Lease {
    const delegation = this.delegations.get(delegationId)
    if (!delegation) throw new AttenuationError(`unknown delegation ${delegationId}`)
    attenuate(delegation.budget, input.budget)
    if (input.deadline > delegation.deadline) throw new AttenuationError('lease deadline exceeds delegation')

    const active = this.activeByGoal.get(input.goalDigest)
    if (active && this.leases.get(active)?.status === 'active') {
      throw new DuplicateTask(`goal already has an active lease: ${active}`)
    }

    const fence = (this.fences.get(input.taskId) ?? 0) + 1
    this.fences.set(input.taskId, fence)
    this.seq += 1
    const lease: Lease = {
      id: `ls.${this.seq}`,
      delegation: delegationId,
      taskId: input.taskId,
      holder: input.holder,
      fence,
      goalDigest: input.goalDigest,
      budget: input.budget,
      deadline: input.deadline,
      status: 'active',
    }
    this.leases.set(lease.id, lease)
    this.activeByGoal.set(input.goalDigest, lease.id)
    this.reserved.set(lease.id, {})
    this.spent.set(lease.id, {})
    return lease
  }

  /** Reserve before dispatch (D-3): reservation is what makes a budget real. */
  reserve(leaseId: Id, cost: Budget): void {
    const lease = this.active(leaseId)
    const reserved = { ...(this.reserved.get(leaseId) ?? {}) }
    for (const dim of DIMS) {
      const next = (reserved[dim] ?? 0) + (cost[dim] ?? 0)
      const limit = lease.budget[dim]
      if (limit !== undefined && next > limit) throw new BudgetError(`reserved ${dim} ${next} exceeds lease ${limit}`)
      if (cost[dim] !== undefined) reserved[dim] = next
    }
    this.reserved.set(leaseId, reserved)
  }

  settle(leaseId: Id, actual: Budget): void {
    this.active(leaseId)
    this.reserved.set(leaseId, {})
    const spent = { ...(this.spent.get(leaseId) ?? {}) }
    for (const dim of DIMS) spent[dim] = (spent[dim] ?? 0) + (actual[dim] ?? 0)
    this.spent.set(leaseId, spent)
  }

  /** A lease is single-writer: the fence must match or the write is stale. */
  assertWriter(leaseId: Id, fence: number): void {
    const lease = this.active(leaseId)
    if (lease.fence !== fence) throw new FencingError(`stale writer: fence ${fence} != ${lease.fence}`)
  }

  complete(leaseId: Id): Lease {
    const lease = this.active(leaseId)
    lease.status = 'done'
    this.activeByGoal.delete(lease.goalDigest)
    return lease
  }

  cancel(leaseId: Id): Lease {
    const lease = this.active(leaseId)
    lease.status = 'cancelled'
    this.activeByGoal.delete(lease.goalDigest)
    return lease
  }

  lease(leaseId: Id): Lease | undefined {
    return this.leases.get(leaseId)
  }

  usage(leaseId: Id): { reserved: Budget; spent: Budget } {
    return { reserved: this.reserved.get(leaseId) ?? {}, spent: this.spent.get(leaseId) ?? {} }
  }

  /**
   * The team manifest is the directory: if it is supplied, membership, scope,
   * fan-out and budget are checked before a delegation exists at all.
   */
  private enforceManifest(input: Omit<Delegation, 'id'>, manifest: TeamManifest): void {
    const granter = manifest.members.find((member) => member.id === input.granter)
    if (!granter) throw new AttenuationError(`granter ${input.granter} is not a team member`)
    if (!manifest.members.some((member) => member.id === input.delegatee)) {
      throw new AttenuationError(`delegatee ${input.delegatee} is not a team member`)
    }
    if (input.depth > manifest.max_depth) {
      throw new AttenuationError(`depth ${input.depth} exceeds team max ${manifest.max_depth}`)
    }
    for (const scope of input.scope) {
      if (!granter.authority.includes(scope)) {
        throw new AttenuationError(`scope ${scope} exceeds ${granter.id} authority`)
      }
    }
    attenuate(manifest.budget, input.budget)
    const existing = [...this.delegations.values()].filter((item) => item.granter === input.granter)
    if (existing.length >= manifest.max_fanout) {
      throw new AttenuationError(`fan-out limit ${manifest.max_fanout} reached for ${input.granter}`)
    }
  }

  private active(leaseId: Id): Lease {
    const lease = this.leases.get(leaseId)
    if (!lease) throw new FencingError(`unknown lease ${leaseId}`)
    if (lease.status !== 'active') throw new FencingError(`lease ${leaseId} is ${lease.status}`)
    return lease
  }
}
