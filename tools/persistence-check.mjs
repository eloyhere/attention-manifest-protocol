#!/usr/bin/env node
/** Persistence checks: chain integrity, tamper/reorder/truncate, restore. */
import assert from 'node:assert/strict'

import { exportLedger, restoreLedger, verifySnapshot } from '../src/runtime/persistence.ts'
import { AmpRuntime } from '../src/runtime/runtime.ts'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`)
  }
}

function buildRuntime() {
  const runtime = new AmpRuntime({ agentId: 'a.test', start: '2026-10-24T01:00:00Z' })
  const { unknown } = runtime.noteUnknown({ question: 'q', importance: 0.8, blocking: true })
  runtime.attend(
    [
      {
        target: { kind: 'unknown', id: unknown.id },
        role: 'question',
        voi: 0.9,
        goalFit: 0.9,
        uncertainty: 0.8,
        novelty: 0.5,
        costTokens: 200,
        risk: 0,
        trustCap: 0.9,
        why: 'blocking',
      },
    ],
    2000,
  )
  runtime.noteClaim({
    statement: 'p',
    tier: 'T2',
    evidence: [
      {
        id: 'ev.1',
        kind: 'observation',
        trust: 'self',
        independence: 0.9,
        entails: true,
        origin: 'a',
        at: '2026-10-24T01:00:05Z',
      },
    ],
  })
  return runtime
}

const runtime = buildRuntime()
const snapshot = exportLedger(runtime.ledger, 'a.test')

await test('export verifies and preserves counts', () => {
  const verdict = verifySnapshot(snapshot)
  assert.equal(verdict.ok, true, verdict.reasons.join('; '))
  assert.equal(snapshot.count, snapshot.entries.length)
  assert.equal(snapshot.count, snapshot.entries.length)
})

await test('empty ledger still has a valid chain', () => {
  const empty = new AmpRuntime({ agentId: 'a.empty' })
  const snap = exportLedger(empty.ledger, 'a.empty')
  assert.equal(snap.count, 0)
  assert.equal(verifySnapshot(snap).ok, true)
})

await test('tampering with a payload breaks its hash', () => {
  const broken = structuredClone(snapshot)
  broken.entries[1].payload = { ...broken.entries[1].payload, statement: 'forged' }
  const verdict = verifySnapshot(broken)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((r) => r.includes('hash')))
})

await test('reordering entries breaks the chain', () => {
  const broken = structuredClone(snapshot)
  const [a, b] = [broken.entries[0], broken.entries[1]]
  broken.entries[0] = b
  broken.entries[1] = a
  const verdict = verifySnapshot(broken)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((r) => r.includes('seq') || r.includes('prev')))
})

await test('truncation is detected by count and tip', () => {
  const broken = structuredClone(snapshot)
  broken.entries = broken.entries.slice(0, -1)
  const verdict = verifySnapshot(broken)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((r) => r.includes('count') || r.includes('tip')))
})

await test('restore preserves frames and claims', () => {
  const restored = restoreLedger(snapshot)
  assert.equal(restored.frames.length, runtime.ledger.frames.length)
  assert.equal(restored.claims.length, runtime.ledger.claims.length)
  assert.equal((restored.frames[0]).id, runtime.ledger.frames[0].id)
})

await test('restore refuses a broken snapshot', () => {
  const broken = structuredClone(snapshot)
  broken.entries[0].payload = { forged: true }
  assert.throws(() => restoreLedger(broken), /refusing to restore/)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
