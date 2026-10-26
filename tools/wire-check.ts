#!/usr/bin/env node
/** Wire round-trip checks for delegation and lease documents. */
import assert from 'node:assert/strict'

import { fromDelegationDoc, toDelegationDoc, toLeaseDoc } from '../src/protocol/wire.ts'
import { TeamRuntime } from '../src/delegate/team.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`)
  }
}

const goal = 'sha256:' + 'a'.repeat(64)
const runtime = () => new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' })

function delegation() {
  const team = runtime()
  return team.createDelegation({
    granter: 'a.lead',
    delegatee: 'a.worker',
    goalDigest: goal,
    scope: ['tool.logs.query'],
    budget: { tokens: 4000, calls: 8 },
    deadline: '2026-10-24T12:00:00Z',
    mayRedelegate: false,
    depth: 0,
  })
}

test('delegation serialises to the wire shape', () => {
  const doc = toDelegationDoc(delegation())
  assert.equal(doc.amp, '0.1')
  assert.equal(doc.kind, 'delegation')
  assert.equal(doc.goal_digest, goal)
  assert.equal(doc.may_redelegate, false)
  assert.equal(Object.hasOwn(doc, 'mayRedelegate'), false)
})

test('delegation round-trips without loss', () => {
  const original = delegation()
  const restored = fromDelegationDoc(toDelegationDoc(original))
  assert.deepEqual(restored, original)
})

test('lease serialises with fence and status', () => {
  const team = runtime()
  const d = team.createDelegation({
    granter: 'a.lead', delegatee: 'a.worker', goalDigest: goal, scope: [],
    budget: { tokens: 100 }, deadline: '2026-10-24T12:00:00Z', mayRedelegate: false, depth: 0,
  })
  const lease = team.issueLease(d.id, {
    taskId: 't1', holder: 'a.worker', goalDigest: goal, budget: { tokens: 50 }, deadline: '2026-10-24T11:00:00Z',
  })
  const doc = toLeaseDoc(lease)
  assert.equal(doc.task_id, 't1')
  assert.equal(doc.fence, 1)
  assert.equal(doc.status, 'active')
})

test('wire document carries no runtime-only fields', () => {
  const doc = toDelegationDoc(delegation())
  assert.deepEqual(Object.keys(doc).sort(), [
    'amp', 'budget', 'deadline', 'delegatee', 'depth', 'goal_digest', 'granter',
    'id', 'kind', 'may_redelegate', 'parent', 'scope',
  ].sort())
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

