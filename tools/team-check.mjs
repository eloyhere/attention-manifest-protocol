#!/usr/bin/env node
/** Team collaboration checks: attenuation, dedup, fencing, reservation, cancel. */
import assert from 'node:assert/strict'

import {
  AttenuationError,
  BudgetError,
  DuplicateTask,
  FencingError,
  TeamRuntime,
} from '../src/runtime/team.ts'

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

let tick = 0
const now = () => new Date(Date.parse('2026-10-24T10:00:00Z') + tick++ * 1000).toISOString()
const deadline = '2026-10-24T12:00:00Z'
const goal = 'sha256:' + 'a'.repeat(64)

function root(team) {
  return team.createDelegation({
    granter: 'a.lead',
    delegatee: 'a.worker',
    goalDigest: goal,
    scope: ['tool.logs.query'],
    budget: { tokens: 4000, calls: 8 },
    deadline,
    mayRedelegate: true,
    depth: 0,
  })
}

test('child budget must attenuate', () => {
  const team = new TeamRuntime({ now })
  const parent = root(team)
  assert.throws(
    () =>
      team.createDelegation({
        parent: parent.id,
        granter: 'a.worker',
        delegatee: 'a.child',
        goalDigest: 'sha256:' + 'b'.repeat(64),
        scope: ['tool.logs.query'],
        budget: { tokens: 5000 },
        deadline,
        mayRedelegate: false,
        depth: 1,
      }),
    AttenuationError,
  )
})

test('child deadline cannot exceed parent', () => {
  const team = new TeamRuntime({ now })
  const parent = root(team)
  assert.throws(
    () =>
      team.createDelegation({
        parent: parent.id,
        granter: 'a.worker',
        delegatee: 'a.child',
        goalDigest: 'sha256:' + 'b'.repeat(64),
        scope: ['tool.logs.query'],
        budget: { tokens: 1000 },
        deadline: '2026-10-24T13:00:00Z',
        mayRedelegate: false,
        depth: 1,
      }),
    AttenuationError,
  )
})

test('depth is capped at 2', () => {
  const team = new TeamRuntime({ now })
  assert.throws(() => team.createDelegation({ granter: 'a', delegatee: 'b', goalDigest: goal, scope: [], budget: {}, deadline, mayRedelegate: true, depth: 3 }), AttenuationError)
})

test('re-delegation requires may_redelegate', () => {
  const team = new TeamRuntime({ now })
  const parent = team.createDelegation({ granter: 'a', delegatee: 'b', goalDigest: goal, scope: [], budget: { calls: 2 }, deadline, mayRedelegate: false, depth: 0 })
  assert.throws(
    () => team.createDelegation({ parent: parent.id, granter: 'b', delegatee: 'c', goalDigest: 'sha256:' + 'c'.repeat(64), scope: [], budget: {}, deadline, mayRedelegate: false, depth: 1 }),
    AttenuationError,
  )
})

test('duplicate active goal is rejected, and freed on completion', () => {
  const team = new TeamRuntime({ now })
  const delegation = root(team)
  const lease = team.issueLease(delegation.id, { taskId: 't1', holder: 'a.worker', goalDigest: goal, budget: { tokens: 1000 }, deadline })
  assert.throws(
    () => team.issueLease(delegation.id, { taskId: 't2', holder: 'a.other', goalDigest: goal, budget: {}, deadline }),
    DuplicateTask,
  )
  team.complete(lease.id)
  assert.ok(team.issueLease(delegation.id, { taskId: 't3', holder: 'a.other', goalDigest: goal, budget: {}, deadline }))
})

test('reservation blocks overspend before dispatch', () => {
  const team = new TeamRuntime({ now })
  const delegation = root(team)
  const lease = team.issueLease(delegation.id, { taskId: 't1', holder: 'a.worker', goalDigest: goal, budget: { tokens: 100 }, deadline })
  team.reserve(lease.id, { tokens: 80 })
  assert.throws(() => team.reserve(lease.id, { tokens: 30 }), BudgetError)
  team.reserve(lease.id, { tokens: 20 })
  team.settle(lease.id, { tokens: 95 })
  assert.equal(team.usage(lease.id).spent.tokens, 95)
})

test('fencing rejects stale writers', () => {
  const team = new TeamRuntime({ now })
  const delegation = root(team)
  const first = team.issueLease(delegation.id, { taskId: 't1', holder: 'a.worker', goalDigest: goal, budget: {}, deadline })
  team.cancel(first.id)
  const second = team.issueLease(delegation.id, { taskId: 't1', holder: 'a.other', goalDigest: goal, budget: {}, deadline })
  assert.ok(second.fence > first.fence)
  assert.throws(() => team.assertWriter(second.id, first.fence), FencingError)
  team.assertWriter(second.id, second.fence)
})

test('cancellation is sticky', () => {
  const team = new TeamRuntime({ now })
  const delegation = root(team)
  const lease = team.issueLease(delegation.id, { taskId: 't1', holder: 'a.worker', goalDigest: goal, budget: {}, deadline })
  team.cancel(lease.id)
  assert.throws(() => team.complete(lease.id), FencingError)
  assert.throws(() => team.reserve(lease.id, { tokens: 1 }), FencingError)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
