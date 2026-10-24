#!/usr/bin/env node
/**
 * Reference runtime checks (not a spec conformance suite — see tools/conformance.ts).
 * These assert that the implementation actually honours the invariants it claims.
 */
import assert from 'node:assert/strict'

import { sha256Hex } from '../src/runtime/sha256.ts'
import { canonical, digestOf } from '../src/runtime/canonical.ts'
import { Dispatcher, BudgetExceeded } from '../src/runtime/budget.ts'
import { HandleStore } from '../src/runtime/handles.ts'
import {
  canAuthorizeEffect,
  deriveConfidence,
  validateClaim,
  validateHypothesis,
} from '../src/runtime/warrant.ts'
import { respectsMonotonicity, salience, selectFocus } from '../src/runtime/attention.ts'
import { AmpRuntime } from '../src/runtime/runtime.ts'
import type { Claim, EvidenceItem, Hypothesis } from '../src/types/index.ts'
import type { Candidate } from '../src/runtime/attention.ts'

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

const evidence = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: 'ev.1',
  kind: 'observation',
  trust: 'self',
  independence: 0.9,
  entails: true,
  origin: 'a',
  at: '2026-10-24T01:00:00Z',
  ...over,
})

const claim = (over: Partial<Claim> = {}): Claim => ({
  amp: '0.1',
  kind: 'claim',
  id: 'cl.1',
  statement: 'x',
  tier: 'T2',
  status: 'held',
  warrant: { evidence: [evidence()], inference: 'abduction', strength: 0.7 },
  provenance: { source: 'a.gamma' },
  created: '2026-10-24T01:00:00Z',
  ...over,
})

test('sha256 matches FIPS vectors', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('canonical JSON is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }))
  assert.equal(digestOf({ b: 1, a: 2 }), digestOf({ a: 2, b: 1 }))
})

test('nested calls hit the same budget counter', () => {
  const dispatcher = new Dispatcher({ calls: 2 })
  dispatcher.run(() => undefined, {})
  dispatcher.run(() => undefined, {})
  assert.throws(() => dispatcher.run(() => undefined, {}), BudgetExceeded)
  assert.equal(dispatcher.usage().calls, 2)
})

test('handles page deterministically', () => {
  const store = new HandleStore()
  const handle = store.put('x'.repeat(1000), 'text', 250)
  const page1 = store.read(handle.id, 0, 100)
  assert.equal(page1.text.length, 400)
  assert.equal(page1.next, 400)
  const page2 = store.read(handle.id, page1.next, 100)
  assert.equal(page2.text.length, 400)
  assert.equal(store.read(handle.id, 0, 100).text, page1.text)
})

test('confidence is derived from tier and capped by the weakest source', () => {
  const t0 = deriveConfidence({ tier: 'T0', warrant: { evidence: [], inference: 'abduction', strength: 0.5 } })
  assert.ok(t0 <= 0.6, `T0 derived ${t0}`)

  const external = deriveConfidence(claim({ tier: 'T1', warrant: { evidence: [evidence({ trust: 'external' })], inference: 'testimony', strength: 0.5 } }))
  assert.ok(external <= 0.5, `external trust cap violated: ${external}`)
})

test('tier inflation is rejected', () => {
  assert.ok(validateClaim(claim({ tier: 'T1', warrant: { evidence: [evidence({ entails: false })], inference: 'testimony', strength: 0.5 } })).length > 0)
  assert.ok(validateClaim(claim({ tier: 'T2', warrant: { evidence: [evidence({ trust: 'external' })], inference: 'testimony', strength: 0.5 } })).length > 0)
  assert.equal(validateClaim(claim()).length, 0)
})

test('hypothesis without refutes_if is rejected', () => {
  const hypothesis: Hypothesis = {
    amp: '0.1',
    kind: 'hypothesis',
    id: 'h.1',
    question: { kind: 'unknown', id: 'u.1' },
    statement: 'x',
    prediction: 'y',
    refutes_if: '',
    status: 'testing',
    created: '2026-10-24T01:00:00Z',
  }
  assert.ok(validateHypothesis(hypothesis).includes('refutes_if is required'))
})

test('contested claims cannot authorize effects', () => {
  assert.equal(canAuthorizeEffect(claim({ status: 'contested' }), 'T1'), false)
  assert.equal(canAuthorizeEffect(claim(), 'T1'), true)
  assert.equal(canAuthorizeEffect(claim({ tier: 'T0' }), 'T2'), false)
})

test('salience respects its monotonicity contract', () => {
  const base: Candidate = {
    target: { kind: 'tool', id: 'logs.query' },
    role: 'tool',
    voi: 0.6,
    goalFit: 0.7,
    uncertainty: 0.5,
    novelty: 0.2,
    costTokens: 400,
    risk: 0.1,
    trustCap: 0.95,
    why: 'because',
  }
  assert.ok(respectsMonotonicity(base))
  assert.ok(salience({ ...base, trustCap: 0.1 }) <= 0.1)
})

test('nothing above threshold produces STUCK with an ignored list', () => {
  const selection = selectFocus(
    [
      {
        target: { kind: 'tool', id: 'a' },
        role: 'tool',
        voi: 0.01,
        goalFit: 0.01,
        uncertainty: 0.1,
        novelty: 0,
        costTokens: 100,
        risk: 0,
        trustCap: 0.9,
        why: 'irrelevant',
      },
    ],
    { budgetTokens: 1000 },
  )
  assert.equal(selection.slots.length, 0)
  assert.equal(selection.impasse, 'STUCK')
  assert.equal(selection.ignored.length, 1)
})

test('runtime: frame chain, derived confidence, handle overflow, clean audit', () => {
  const runtime = new AmpRuntime({ agentId: 'a.test', budget: { tokens: 10_000, calls: 10, ms: 60_000 } })
  const { unknown } = runtime.noteUnknown({ question: 'q', importance: 0.8, blocking: true })

  const first = runtime.attend(
    [
      {
        target: { kind: 'unknown', id: unknown.id },
        role: 'question',
        voi: 0.9,
        goalFit: 0.9,
        uncertainty: 0.8,
        novelty: 0.5,
        costTokens: 300,
        risk: 0,
        trustCap: 0.9,
        why: 'blocking',
      },
    ],
    2000,
  )
  assert.equal(first.frame.slots.length, 1)
  assert.equal(first.frame.parent, undefined)

  const second = runtime.attend(
    [
      {
        target: { kind: 'unknown', id: unknown.id },
        role: 'question',
        voi: 0.9,
        goalFit: 0.9,
        uncertainty: 0.8,
        novelty: 0.2,
        costTokens: 300,
        risk: 0,
        trustCap: 0.9,
        why: 'still blocking',
      },
    ],
    2000,
  )
  assert.equal(second.frame.parent?.id, first.frame.id)
  assert.ok(second.frame.digest.startsWith('sha256:'))

  const action = runtime.act({ tool: 'logs.query', result: 'r'.repeat(4000), resultTokens: 1000, budgetTokens: 100 })
  assert.ok(action.handle, 'expected a handle for the over-budget result')
  const page = runtime.readHandle(action.handle, 0, 50)
  assert.ok(page.text.length > 0)

  const noted = runtime.noteClaim({ statement: 'p', tier: 'T2', evidence: [evidence()] })
  assert.ok(noted.claim)
  assert.equal(noted.claim.confidence, deriveConfidence(noted.claim))

  assert.deepEqual(runtime.audit(), [])
})

test('runtime: pressure without new evidence is blocked and logged', () => {
  const runtime = new AmpRuntime({ agentId: 'a.test' })
  const first = runtime.noteClaim({ statement: 'p', tier: 'T2', evidence: [evidence()] })
  assert.ok(first.claim)
  const before = first.claim.confidence

  const second = runtime.noteClaim({ statement: 'p', tier: 'T2', evidence: [evidence()], underPressure: true })
  assert.equal(second.receipt.outcome, 'blocked')
  assert.equal(second.claim.confidence, before)
  assert.ok(runtime.ledger.events.some((e) => e.type === 'integrity.sycophancy_pressure'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
