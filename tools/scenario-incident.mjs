#!/usr/bin/env node
/**
 * Scenario: one incident, two agents, one human.
 * Exercises team authority, board, lease, budget, MCP exec, merge, adjudication,
 * attention, ledger snapshot and coordination metrics in a single run.
 */
import assert from 'node:assert/strict'

import { adjudicate, mergeResults } from '../src/runtime/merge.ts'
import { exportLedger, verifySnapshot } from '../src/runtime/persistence.ts'
import { AmpRuntime } from '../src/runtime/runtime.ts'
import { TeamSession } from '../src/runtime/session.ts'
import { ExecProfile } from '../src/runtime/exec.ts'
import { HandleStore } from '../src/runtime/handles.ts'
import { McpClient } from '../src/runtime/mcp/client.ts'
import { DemoServer } from '../src/runtime/mcp/server.ts'
import { MemoryTransport } from '../src/runtime/mcp/transport.ts'

const goal = 'sha256:' + 'a'.repeat(64)
const lead = new AmpRuntime({ agentId: 'a.lead', start: '2026-10-24T10:00:00Z' })
const now = () => lead.nowIso()

const team = new TeamSession({
  budget: { tokens: 1000, calls: 10, ms: 120_000 },
  now,
  manifest: {
    amp: '0.1', kind: 'team-manifest', id: 'team.incident', version: 1,
    members: [
      { id: 'a.lead', role: 'coordinator', authority: ['tool.logs.query', 'tool.metrics.query'] },
      { id: 'a.worker', role: 'investigator', authority: ['tool.logs.query'] },
    ],
    max_depth: 1, max_fanout: 2, budget: { tokens: 800, calls: 8 },
    termination: 'verified', attested_at: '2026-10-24T01:00:00Z',
  },
})

// 1. Lead delegates and opens the task.
const delegation = team.delegate({
  granter: 'a.lead', delegatee: 'a.worker', goalDigest: goal,
  scope: ['tool.logs.query'], budget: { tokens: 300, calls: 3 },
  deadline: '2026-10-24T12:00:00Z', mayRedelegate: false, depth: 0,
})
const { task, lease } = team.start(delegation.id, {
  taskId: 't1', holder: 'a.worker', goalDigest: goal, budget: { tokens: 300, calls: 3 }, deadline: '2026-10-24T11:00:00Z',
})
assert.equal(task.state, 'leased')

// 2. Worker executes a real MCP call through the Exec profile.
const server = new DemoServer()
const client = new McpClient(new MemoryTransport((request) => server.handle(request)))
const exec = new ExecProfile(client, {
  budget: { calls: 5, ms: 60_000 },
  handles: new HandleStore(),
  now,
  maxResultTokens: 300,
})
await exec.connect()
const action = await exec.call('logs.query', { window: 'post' })
assert.ok(action.handle, 'worker should get a handle for the oversized log result')
team.spend(lease.id, { tokens: 120, calls: 1 }, () => undefined)

// 3. Two agents report the same cause; a third disagrees.
const agree = mergeResults(
  [
    { id: 'c1', subject: 'deploy.cause', value: 'deploy', tier: 'T2', agent: 'a.worker', origins: ['logs@run1'], replayable: true },
    { id: 'c2', subject: 'deploy.cause', value: 'deploy', tier: 'T2', agent: 'a.other', origins: ['metrics@run2'], replayable: true },
  ],
  { forAgent: 'a.lead' },
)
assert.equal(agree.merged[0].tier, 'T2')
assert.equal(agree.merged[0].supporters.length, 2)

const conflict = mergeResults(
  [
    { id: 'c3', subject: 'window.start', value: '01:04', tier: 'T2', agent: 'a.worker', origins: ['logs@run1'], replayable: true },
    { id: 'c4', subject: 'window.start', value: '01:07', tier: 'T2', agent: 'a.other', origins: ['metrics@run2'], replayable: true },
  ],
  { forAgent: 'a.lead' },
)
assert.deepEqual(conflict.conflicts, ['window.start'])
const verdict = adjudicate(conflict.merged, { 'a.worker': 0.9, 'a.other': 0.4 })
assert.equal(verdict.decision, 'accept')
assert.equal(verdict.reason, 'higher authority')

// 4. Human attention: one interrupt, one deferred by class budget.
const human = (id, kind) => ({
  amp: '0.1', kind: 'attention-request', id,
  from: { kind: 'agent', id: 'a.lead' }, to: { kind: 'human', id: 'u.li' },
  target: { kind: 'unknown', id: 'u.1' }, class: 'commitment', urgency: 3,
  why_now: kind, if_ignored: 'assume', cost: { interrupts: 1 }, fallback: 'queue',
})
const first = team.requestAttention(human('ar.1', 'confirm rollback'))
assert.equal(first.decision, 'grant')
const second = team.requestAttention(human('ar.2', 'confirm scope'))
assert.equal(second.decision, 'defer')

// 5. Lead records the conclusion and closes the task.
lead.noteClaim({
  statement: 'deploy caused the spike', tier: 'T2',
  evidence: [{ id: 'ev.1', kind: 'observation', trust: 'verified', independence: 0.9, entails: true, origin: 'logs@run1', at: '2026-10-24T01:12:41Z' }],
})
team.finish(lease.id)

// 6. Ledger snapshot + metrics.
const snapshot = exportLedger(lead.ledger, 'a.lead')
const snapshotVerdict = verifySnapshot(snapshot)
assert.equal(snapshotVerdict.ok, true, snapshotVerdict.reasons.join('; '))
const metrics = team.metrics(agree)

console.log(JSON.stringify({
  scenario: 'incident',
  task: { state: team.board.get(task.id).state, attempts: team.board.get(task.id).attempts },
  delegation: { depth: delegation.depth, scope: delegation.scope },
  mcp: { tools: server.tools.length, resultTokens: action.tokens, handle: action.handle },
  merge: { tier: agree.merged[0].tier, supporters: agree.merged[0].supporters },
  conflict: { subjects: conflict.conflicts, verdict: verdict.reason },
  attention: { first: first.decision, second: second.decision, granted: team.snapshot().interruptsGranted, debt: team.snapshot().debtScore },
  budget: team.snapshot(),
  metrics,
  ledger: { entries: snapshot.count, tip: snapshot.tip.slice(0, 20) },
}, null, 2))

