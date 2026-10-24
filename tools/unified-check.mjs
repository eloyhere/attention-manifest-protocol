#!/usr/bin/env node
/** Unified ledger: compute and attention share one account and snapshot. */
import assert from 'node:assert/strict'

import { BudgetExceeded } from '../src/runtime/budget.ts'
import { UnifiedLedger } from '../src/runtime/unified.ts'

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

let minute = 0
const now = () => new Date(Date.parse('2026-10-24T10:00:00Z') + minute++ * 60_000).toISOString()
const ledger = () => new UnifiedLedger({ budget: { tokens: 100, calls: 2, ms: 10_000 }, now })

const request = (id) => ({
  amp: '0.1',
  kind: 'attention-request',
  id,
  from: { kind: 'agent', id: 'a.lead' },
  to: { kind: 'human', id: 'u.li' },
  target: { kind: 'unknown', id: 'u.1' },
  class: 'commitment',
  urgency: 3,
  why_now: 'deadline',
  if_ignored: 'assume',
  cost: { interrupts: 1 },
  fallback: 'queue',
})

test('spending charges tokens and calls', () => {
  const account = ledger()
  account.spend(() => undefined, { tokens: 30, calls: 1 })
  assert.equal(account.snapshot().tokens, 30)
  assert.equal(account.snapshot().calls, 1)
})

test('over-budget work never starts', () => {
  const account = ledger()
  account.spend(() => undefined, { tokens: 90 })
  assert.throws(() => account.spend(() => undefined, { tokens: 20 }), BudgetExceeded)
})

test('attention grants appear in the same snapshot', () => {
  const account = ledger()
  account.requestAttention(request('ar.1'))
  account.spend(() => undefined, { tokens: 10 })
  const snap = account.snapshot()
  assert.equal(snap.interruptsGranted, 1)
  assert.equal(snap.tokens, 10)
})

test('debt is visible without spending compute', () => {
  const account = ledger()
  account.requestAttention(request('ar.1'))
  account.requestAttention(request('ar.2'))
  minute += 30
  assert.ok(account.snapshot().debtScore >= 0)
})

test('remaining reflects consumption', () => {
  const account = ledger()
  account.spend(() => undefined, { tokens: 40 })
  assert.equal(account.remaining().tokens, 60)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
