#!/usr/bin/env node
/** Social profile checks: attention budgets, quiet hours, cooldown, debt. */
import assert from 'node:assert/strict'

import { AttentionBroker } from '../src/runtime/social.ts'
import type { AttentionRequest } from '../src/types/index.ts'

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

let minutes = 0
const start = Date.parse('2026-10-24T10:00:00Z')
const now = () => new Date(start + minutes * 60_000).toISOString()

function request(over: Partial<AttentionRequest> = {}): AttentionRequest {
  return {
    amp: '0.1',
    kind: 'attention-request',
    id: 'ar.1',
    from: { kind: 'agent', id: 'a.gamma' },
    to: { kind: 'human', id: 'u.li' },
    target: { kind: 'unknown', id: 'u.17' },
    class: 'commitment',
    urgency: 3,
    why_now: 'deadline',
    if_ignored: 'proceed on an assumption',
    cost: { interrupts: 1, ms: 60_000 },
    fallback: 'queue',
    expected_value: 0.8,
    ...over,
  }
}

test('safety bypasses quiet hours and budget', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  const a = broker.submit(request({ id: 'ar.s1', class: 'safety', urgency: 5 }))
  assert.equal(a.decision, 'grant')
  assert.equal(a.reason, 'safety_bypass')
  assert.equal(a.debtAdded, false)
})

test('commitment is granted inside budget', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  const a = broker.submit(request({ id: 'ar.c1' }))
  assert.equal(a.decision, 'grant')
  assert.equal(a.reason, 'within_budget')
})

test('budget exhaustion queues instead of interrupting', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  for (let i = 0; i < 3; i++) {
    minutes = i
    assert.equal(broker.submit(request({ id: `ar.c${i}`, target: { kind: 'unknown', id: `u.${i}` } })).decision, 'grant')
  }
  minutes = 3
  const out = broker.submit(request({ id: 'ar.c4', target: { kind: 'unknown', id: 'u.4' } }))
  assert.equal(out.decision, 'defer')
  assert.equal(out.reason, 'budget_exhausted')
  assert.equal(out.debtAdded, true)
})

test('fallback drop denies instead of queueing', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  for (let i = 0; i < 3; i++) {
    minutes = i
    broker.submit(request({ id: `ar.d${i}`, target: { kind: 'unknown', id: `u.${i}` } }))
  }
  minutes = 4
  const out = broker.submit(request({ id: 'ar.d4', target: { kind: 'unknown', id: 'u.4' }, fallback: 'drop' }))
  assert.equal(out.decision, 'deny')
  assert.equal(out.debtAdded, false)
})

test('quiet hours defer non-safety requests', () => {
  minutes = 0
  const broker = new AttentionBroker({ now, policy: { quietHours: { start: 0, end: 23 } } })
  const out = broker.submit(request({ id: 'ar.q1' }))
  assert.equal(out.decision, 'defer')
  assert.equal(out.reason, 'quiet_hours')
})

test('cooldown defers a second request about the same target', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  assert.equal(broker.submit(request({ id: 'ar.k1' })).decision, 'grant')
  minutes = 2
  const second = broker.submit(request({ id: 'ar.k2', target: { kind: 'unknown', id: 'u.17' } }))
  assert.equal(second.decision, 'defer')
  assert.equal(second.reason, 'cooldown')
})

test('curiosity below the floor is denied outright', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  const out = broker.submit(request({ id: 'ar.x1', class: 'curiosity', expected_value: 0.2 }))
  assert.equal(out.decision, 'deny')
  assert.equal(out.reason, 'curiosity_below_floor')
})

test('debt accrues with age and resolves', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  for (let i = 0; i < 3; i++) {
    minutes = i
    broker.submit(request({ id: `ar.b${i}`, target: { kind: 'unknown', id: `u.${i}` } }))
  }
  minutes = 3
  const queued = broker.submit(request({ id: 'ar.b3', target: { kind: 'unknown', id: 'u.3' }, urgency: 5 }))
  assert.equal(queued.decision, 'defer')
  minutes = 33
  const before = broker.debtScore()
  assert.ok(before >= 30 * 5, `expected >=150 debt minutes, got ${before}`)
  broker.resolve('ar.b3')
  minutes = 60
  assert.equal(broker.openDebt().length, 0)
})

test('malformed requests and duplicates are rejected', () => {
  minutes = 0
  const broker = new AttentionBroker({ now })
  assert.throws(() => broker.submit(request({ id: 'ar.m1', why_now: '' })), /why_now/)
  broker.submit(request({ id: 'ar.m2' }))
  assert.throws(() => broker.submit(request({ id: 'ar.m2' })), /duplicate/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
