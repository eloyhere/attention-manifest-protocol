#!/usr/bin/env node
/**
 * Compaction and pruning checks.
 *
 * Pruning is a view over a verified ledger; compaction is a checkpoint over a
 * cold prefix. Both must be explicit: the tests below fail if a dropped object
 * loses its reason, if a citation dangles, or if a checkpoint stops covering
 * what it claims to cover.
 */
import assert from 'node:assert/strict'

import { Ledger } from '../src/ledger/ledger.ts'
import { exportLedger } from '../src/ledger/persistence.ts'
import type { LedgerSnapshot } from '../src/ledger/persistence.ts'
import { CompactionRefused, compactLedger, planPrune, verifyCompaction } from '../src/window/compaction.ts'
import type { Claim, Hypothesis, UnknownItem } from '../src/types/index.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`\u2713 ${name}`)
  } catch (error) {
    failed++
    console.log(`\u2717 ${name}`)
    console.log(`    ${(error as Error).message}`)
  }
}

const at = (second: number): string => `2026-10-24T01:00:${String(second).padStart(2, '0')}Z`

function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    amp: '0.1',
    kind: 'claim',
    id,
    statement: id,
    tier: 'T2',
    status: 'held',
    provenance: { source: 'test' },
    warrant: { evidence: [], inference: 'testimony', strength: 0.5 },
    created: at(0),
    ...over,
  }
}

function unknown(id: string, over: Partial<UnknownItem> = {}): UnknownItem {
  return {
    amp: '0.1',
    kind: 'unknown',
    id,
    question: `what is ${id}`,
    importance: 0.5,
    blocking: false,
    since: at(0),
    status: 'open',
    ...over,
  }
}

function hypothesis(id: string, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    amp: '0.1',
    kind: 'hypothesis',
    id,
    question: { kind: 'unknown', id: 'u.0' },
    statement: id,
    prediction: 'p',
    refutes_if: 'r',
    status: 'testing',
    created: at(0),
    ...over,
  }
}

function snapshotOf(parts: {
  claims?: Claim[]
  hypotheses?: Hypothesis[]
  unknowns?: UnknownItem[]
}): LedgerSnapshot {
  const ledger = new Ledger()
  for (const item of parts.claims ?? []) ledger.claims.push(item)
  for (const item of parts.hypotheses ?? []) ledger.hypotheses.push(item)
  for (const item of parts.unknowns ?? []) ledger.unknowns.push(item)
  return exportLedger(ledger, 'a.test')
}

const idsOf = (entries: { payload: unknown }[]): string[] =>
  entries.map((entry) => (entry.payload as { id?: string }).id ?? '?')

const droppedIds = (plan: { dropped: { id: string }[] }): string[] => plan.dropped.map((d) => d.id)

test('a superseded claim leaves the view; its successor stays', () => {
  const snapshot = snapshotOf({
    claims: [
      claim('cl.old', { created: at(1) }),
      claim('cl.new', { created: at(2), supersedes: { kind: 'claim', id: 'cl.old' } }),
    ],
  })
  const { plan, keep } = planPrune(snapshot, { keepRecent: 0 })
  assert.deepEqual(droppedIds(plan), ['cl.old'])
  assert.equal(plan.dropped[0].reason, 'superseded')
  assert.match(plan.dropped[0].revisit_if, /cl\.new/)
  assert.deepEqual(idsOf(keep), ['cl.new'])
})

test('a contested claim is retained, superseded or not', () => {
  const snapshot = snapshotOf({
    claims: [
      claim('cl.old', { created: at(1), status: 'contested' }),
      claim('cl.new', { created: at(2), supersedes: { kind: 'claim', id: 'cl.old' } }),
    ],
  })
  const { plan } = planPrune(snapshot, { keepRecent: 0 })
  assert.deepEqual(droppedIds(plan), [])
})

test('a citation pins the cited object even when its own rule would drop it', () => {
  const snapshot = snapshotOf({
    unknowns: [
      unknown('u.used', { status: 'resolved', since: at(1) }),
      unknown('u.unused', { status: 'resolved', since: at(2) }),
    ],
    hypotheses: [hypothesis('h.open', { created: at(3), question: { kind: 'unknown', id: 'u.used' } })],
  })
  const { plan, keep } = planPrune(snapshot, { keepRecent: 0 })
  assert.deepEqual(droppedIds(plan), ['u.unused'])
  assert.ok(idsOf(keep).includes('u.used'))
})

test('a blocking unknown is never pruned, resolved or not', () => {
  const snapshot = snapshotOf({
    unknowns: [unknown('u.block', { status: 'resolved', blocking: true })],
  })
  const { plan } = planPrune(snapshot, { keepRecent: 0 })
  assert.deepEqual(droppedIds(plan), [])
})

test('closed hypotheses leave the view; a testing one stays', () => {
  const snapshot = snapshotOf({
    hypotheses: [
      hypothesis('h.done', { status: 'refuted', created: at(1) }),
      hypothesis('h.open', { status: 'testing', created: at(2) }),
    ],
  })
  const { plan, keep } = planPrune(snapshot, { keepRecent: 0 })
  assert.deepEqual(droppedIds(plan), ['h.done'])
  assert.equal(plan.dropped[0].reason, 'closed')
  assert.deepEqual(idsOf(keep), ['h.open'])
})

test('the retention floor wins over every per-kind rule', () => {
  const snapshot = snapshotOf({
    claims: [
      claim('cl.old', { created: at(1) }),
      claim('cl.new', { created: at(2), supersedes: { kind: 'claim', id: 'cl.old' } }),
    ],
  })
  const { plan } = planPrune(snapshot, { keepRecent: 2 })
  assert.deepEqual(droppedIds(plan), [])
  assert.equal(plan.kept.length, 2)
})

test('a plan partitions the chain and reports its size honestly', () => {
  const snapshot = snapshotOf({
    claims: [claim('cl.old', { created: at(1) }), claim('cl.new', { created: at(2), supersedes: { kind: 'claim', id: 'cl.old' } })],
    unknowns: [unknown('u.1', { since: at(3), status: 'resolved' })],
  })
  const { plan } = planPrune(snapshot, { keepRecent: 0 })
  assert.equal(plan.kept.length + plan.dropped.length, plan.sourceCount)
  assert.equal(plan.sourceCount, snapshot.count)
  assert.equal(plan.sourceTip, snapshot.tip)
  const bytes = plan.dropped.reduce((sum, d) => sum + d.bytes, 0)
  assert.equal(plan.reclaimedBytes, bytes)
  assert.equal(plan.estimatedTokens, Math.ceil(bytes / 4))
  assert.deepEqual([...plan.kept].sort((a, b) => a - b), plan.kept)
})

test('every dropped object says why and when to reconsider', () => {
  const snapshot = snapshotOf({
    unknowns: [unknown('u.1', { status: 'resolved', since: at(1) })],
    hypotheses: [hypothesis('h.1', { status: 'supported', created: at(2) })],
  })
  const { plan } = planPrune(snapshot, { keepRecent: 0 })
  assert.equal(plan.dropped.length, 2)
  for (const decision of plan.dropped) {
    assert.ok(['superseded', 'closed', 'resolved'].includes(decision.reason))
    assert.ok(decision.revisit_if.length > 10, `revisit_if too thin: ${decision.revisit_if}`)
    assert.ok(decision.bytes > 0)
  }
})

test('pruning is deterministic', () => {
  const snapshot = snapshotOf({
    claims: [claim('cl.old', { created: at(1) }), claim('cl.new', { created: at(2), supersedes: { kind: 'claim', id: 'cl.old' } })],
  })
  const first = planPrune(snapshot, { keepRecent: 0 })
  const second = planPrune(snapshot, { keepRecent: 0 })
  assert.deepEqual(first.plan, second.plan)
})

test('pruning refuses a ledger whose chain does not verify', () => {
  const snapshot = snapshotOf({ claims: [claim('cl.1')] })
  const broken: LedgerSnapshot = {
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({ ...entry, hash: `sha256:${'2'.repeat(64)}` })),
  }
  assert.throws(() => planPrune(broken), /unverified/)
})

test('compaction replaces a cold prefix with a verifiable checkpoint', () => {
  const snapshot = snapshotOf({
    claims: [claim('cl.1', { created: at(1) }), claim('cl.2', { created: at(2) })],
    unknowns: [unknown('u.1', { since: at(3) }), unknown('u.2', { since: at(4) })],
  })
  const compaction = compactLedger(snapshot, { keepRecent: 2, now: at(0) })
  assert.equal(compaction.removed.length, 2)
  assert.equal(compaction.checkpoint.count, 2)
  assert.equal(compaction.checkpoint.to, compaction.removed[1].seq)
  assert.equal(compaction.tail.entries.length, 2)
  assert.equal(compaction.tail.entries[0].prev, compaction.checkpoint.tip)
  assert.deepEqual(verifyCompaction(compaction), { ok: true, reasons: [] })
})

test('a checkpoint that does not cover its entries is rejected', () => {
  const snapshot = snapshotOf({ claims: [claim('cl.1'), claim('cl.2', { created: at(1) })] })
  const compaction = compactLedger(snapshot, { keepRecent: 1 })
  const rewritten = {
    ...compaction,
    checkpoint: { ...compaction.checkpoint, root: `sha256:${'0'.repeat(64)}` },
  }
  const verdict = verifyCompaction(rewritten)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((reason) => reason.includes('root')))
})

test('a tail that no longer continues the chain is rejected', () => {
  const snapshot = snapshotOf({ claims: [claim('cl.1'), claim('cl.2', { created: at(1) })] })
  const compaction = compactLedger(snapshot, { keepRecent: 1 })
  const disconnected = {
    ...compaction,
    tail: {
      ...compaction.tail,
      entries: compaction.tail.entries.map((entry) => ({ ...entry, prev: `sha256:${'1'.repeat(64)}` })),
    },
  }
  const verdict = verifyCompaction(disconnected)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reasons.some((reason) => reason.includes('prev')))
})

test('compaction refuses to bury an entry the retained tail still cites', () => {
  const snapshot = snapshotOf({
    unknowns: [unknown('u.1', { status: 'resolved', since: at(1) })],
    hypotheses: [hypothesis('h.1', { created: at(2), question: { kind: 'unknown', id: 'u.1' } })],
  })
  assert.throws(
    () => compactLedger(snapshot, { keepRecent: 1 }),
    (error: unknown) =>
      error instanceof CompactionRefused && error.pinned.includes('unknown:u.1'),
  )
})

test('compacting the whole chain leaves a valid empty tail', () => {
  const snapshot = snapshotOf({ claims: [claim('cl.1'), claim('cl.2', { created: at(1) })] })
  const compaction = compactLedger(snapshot, { keepRecent: 0 })
  assert.equal(compaction.tail.count, 0)
  assert.equal(compaction.tail.tip, compaction.checkpoint.tip)
  assert.deepEqual(verifyCompaction(compaction), { ok: true, reasons: [] })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
