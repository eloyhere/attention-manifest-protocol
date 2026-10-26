#!/usr/bin/env node
/** Emits schema-valid delegation / lease / result-contract for docs/examples. */
import { TeamRuntime } from '../src/delegate/team.ts'

const team = new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' })
const goalDigest = `sha256:${'a'.repeat(64)}`

const delegation = team.createDelegation({
  granter: 'a.lead',
  delegatee: 'a.worker',
  goalDigest,
  scope: ['tool.logs.query', 'tool.metrics.query'],
  budget: { tokens: 4000, calls: 8 },
  deadline: '2026-10-24T12:00:00Z',
  mayRedelegate: false,
  depth: 0,
})

const lease = team.issueLease(delegation.id, {
  taskId: 't1',
  holder: 'a.worker',
  goalDigest,
  budget: { tokens: 1200, calls: 2 },
  deadline: '2026-10-24T11:00:00Z',
})

const result = {
  amp: '0.1',
  kind: 'result-contract',
  id: 'rc.1',
  lease: lease.id,
  goal_digest: goalDigest,
  claims: [{ kind: 'claim', id: 'cl.91' }],
  evidence: [{ kind: 'evidence', id: 'ev.1' }],
  unknowns: ['lane B 未采样'],
  artifacts: [{ id: 'a.1', digest: `sha256:${'c'.repeat(64)}` }],
  status: 'ok',
}

console.log(
  JSON.stringify(
    [
      {
        amp: '0.1',
        kind: 'delegation',
        id: delegation.id,
        granter: delegation.granter,
        delegatee: delegation.delegatee,
        goal_digest: delegation.goalDigest,
        scope: delegation.scope,
        budget: delegation.budget,
        deadline: delegation.deadline,
        may_redelegate: delegation.mayRedelegate,
        depth: delegation.depth,
      },
      {
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
      },
      result,
    ],
    null,
    2,
  ),
)
