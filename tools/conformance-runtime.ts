#!/usr/bin/env node
/**
 * Runtime-facing conformance checks (V1–V15 where the operations exist).
 *
 * Unlike `tools/conformance.ts` (pure reference semantics), these checks drive
 * the actual runtime: policy, Exec profile, envelope receiver, append log,
 * checkpoints, interrupt ledger, keyring and guard. They are deliberately
 * black-box at the module boundaries.
 */
import assert from 'node:assert/strict'

import { AmpRuntime } from '../src/cycle/runtime.ts'
import { PolicyEngine } from '../src/policy/policy.ts'
import { ExecProfile, DriftDetected, PolicyDenied } from '../src/execution/exec.ts'
import { HandleStore } from '../src/execution/handles.ts'
import { Dispatcher, BudgetExceeded } from '../src/attention/budget.ts'
import { DemoServer } from '../src/module/mcp/server.ts'
import { McpClient } from '../src/module/mcp/client.ts'
import { MemoryTransport } from '../src/module/mcp/transport.ts'
import { EnvelopeRuntime, sealEnvelope } from '../src/protocol/envelope.ts'
import { generateSigningKey, verifyManifest } from '../src/manifest/sign.ts'
import { AppendLog, MemoryAppendSink } from '../src/storage/appendLog.ts'
import {
  sealCheckpoint,
  verifyCheckpoint,
  verifySnapshotAgainstCheckpoint,
} from '../src/ledger/checkpoint.ts'
import type { LedgerSnapshot } from '../src/ledger/persistence.ts'
import { AttentionLedger, admitExternal } from '../src/attention/interrupts.ts'
import { Keyring, checkManifestWindow } from '../src/manifest/keys.ts'
import { Guard, RateLimited } from '../src/policy/guard.ts'
import type { Candidate } from '../src/attention/attention.ts'
import type { Claim, EvidenceItem } from '../src/types/index.ts'
import type { AttentionRequest } from '../src/attention/socialTypes.ts'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (error) {
    failed++
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`)
  }
}

const NOW = '2026-10-24T10:00:00Z'

const evidence = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: 'ev.1',
  kind: 'observation',
  trust: 'self',
  independence: 0.9,
  entails: true,
  at: NOW,
  ...over,
})

const heldClaim = (tier: Claim['tier'] = 'T3'): Claim => ({
  amp: '0.1',
  kind: 'claim',
  id: `cl.${tier}`,
  statement: 'the action is warranted',
  tier,
  confidence: 0.9,
  status: 'held',
  warrant: { evidence: [evidence()], inference: 'deduction', strength: 0.9 },
  provenance: { source: 'a.lead' },
  created: NOW,
})

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  target: { kind: 'tool', id: 'logs.query' },
  role: 'tool',
  voi: 0.6,
  goalFit: 0.7,
  uncertainty: 0.5,
  novelty: 0.2,
  costTokens: 200,
  risk: 0.1,
  trustCap: 0.95,
  why: 'it answers the blocking question',
  ...over,
})

await test('V1: a description change inside the TTL fails closed before the tool call', async () => {
  const server = new DemoServer()
  const client = new McpClient(new MemoryTransport((request) => server.handle(request)))
  const exec = new ExecProfile(client, {
    budget: { calls: 5, ms: 60_000 },
    handles: new HandleStore(),
    now: () => NOW,
    maxResultTokens: 1200,
  })
  await exec.connect()
  server.mutateDescription()
  await assert.rejects(
    () => exec.call('logs.query', { window: 'post' }),
    (error) => error instanceof DriftDetected,
  )
  assert.equal(server.calls, 0)
})

await test('V3: an oversized result becomes a handle and is never truncated', async () => {
  const server = new DemoServer()
  const client = new McpClient(new MemoryTransport((request) => server.handle(request)))
  const handles = new HandleStore()
  const exec = new ExecProfile(client, {
    budget: { calls: 5, ms: 60_000 },
    handles,
    now: () => NOW,
    maxResultTokens: 1200,
  })
  await exec.connect()
  const out = await exec.call('logs.query', { window: 'post' })
  assert.ok(out.handle)
  assert.ok(out.tokens > 1200)
  const page = handles.read(out.handle, 0, 100)
  assert.ok(page.text.length > 0)
})

await test('V4: no candidate above threshold yields STUCK with an explicit ignored list', () => {
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const result = runtime.attend([candidate({ voi: 0.01, goalFit: 0.01 })], 1000)
  assert.equal(result.frame.impasse?.state, 'STUCK')
  assert.equal(result.frame.slots.length, 0)
  assert.ok((result.frame.ignored ?? []).length > 0)
})

await test('V5: a plan without abandon_if is rejected and never stored', () => {
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const goal = runtime.noteGoal({
    statement: 'restore service',
    success: [{ id: 'c1', statement: '5xx < 0.5%', check: 'metrics.query' }],
    value: 0.9,
  })
  const result = runtime.plan(goal, {
    tasks: [
      {
        id: 't1',
        intent: 'rollback the release',
        actor: 'tool',
        pre: [],
        expect: { observation: 'error rate falls', check: 'metrics.query' },
        irreversibility: 1,
        status: 'pending',
      },
    ],
    budget: { tokens: 1000 },
    abandonIf: [],
  })
  assert.equal(result.receipt.outcome, 'blocked')
  assert.equal(result.plan, undefined)
  assert.equal(runtime.ledger.plans.length, 0)
})

await test('V6: pressure without new evidence does not raise confidence', () => {
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const first = runtime.noteClaim({ statement: 'deploy caused the error', tier: 'T2', evidence: [evidence()] })
  assert.ok(first.claim)
  const before = first.claim.confidence
  const second = runtime.noteClaim({
    statement: 'deploy caused the error',
    tier: 'T2',
    evidence: [],
    underPressure: true,
  })
  assert.equal(second.receipt.outcome, 'blocked')
  assert.equal(second.claim?.confidence, before)
  assert.equal(runtime.ledger.claims.length, 1)
})

await test('V9: nested dispatches hit the same budget counter', () => {
  const dispatcher = new Dispatcher({ calls: 1 })
  dispatcher.run(() => undefined, {})
  assert.throws(() => dispatcher.run(() => undefined, {}), BudgetExceeded)
  assert.equal(dispatcher.usage().calls, 1)
})

await test('V10: a hypothesis without refutes_if never enters the ledger', () => {
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const result = runtime.noteHypothesis({
    statement: 'the deploy introduced the error',
    question: { kind: 'unknown', id: 'u.1' },
    prediction: 'errors fall after rollback',
    refutesIf: '',
  })
  assert.equal(result.receipt.outcome, 'blocked')
  assert.equal(result.hypothesis, undefined)
  assert.equal(runtime.ledger.hypotheses.length, 0)
})

await test('V11: observational causal claims are rejected before storage', () => {
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const result = runtime.noteClaim({
    statement: 'the deploy caused the error',
    tier: 'T3',
    claimScope: 'interventional',
    evidence: [evidence()],
    causal: { assignment_mechanism: 'observed' },
    wouldBeFalseIf: 'the error rate was already rising before the deploy',
  })
  assert.equal(result.receipt.outcome, 'blocked')
  assert.equal(result.claim, undefined)
  assert.equal(runtime.ledger.claims.length, 0)
})

await test('V13: T1 requires entailment, not mere mention', () => {
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const result = runtime.noteClaim({
    statement: 'the runbook says to roll back',
    tier: 'T1',
    evidence: [evidence({ entails: false, trust: 'trusted' })],
    wouldBeFalseIf: 'the runbook says otherwise',
  })
  assert.equal(result.receipt.outcome, 'blocked')
  assert.equal(result.claim, undefined)
})

await test('policy: a T3 effect needs T3 warrant plus a one-time host approval', () => {
  let tick = 0
  const policy = new PolicyEngine({ now: () => new Date(Date.parse(NOW) + ++tick * 1000).toISOString() })
  const request = { action: 'deploy.rollback', effect: 'deploy' as const, claim: heldClaim('T3') }
  const first = policy.decide(request)
  assert.equal(first.outcome, 'approval_required')

  const approval = policy.approve({
    action: 'deploy.rollback',
    effect: 'deploy',
    approvedBy: 'host.operator',
  })
  assert.equal(policy.decide(request, approval).outcome, 'allow')
  const replay = policy.decide(request, approval)
  assert.equal(replay.outcome, 'deny')
  assert.equal(replay.reason, 'approval_consumed')

  const underTier = policy.decide({ ...request, claim: heldClaim('T2') })
  assert.equal(underTier.outcome, 'deny')
  assert.match(underTier.reason, /tier_below_minimum/)
})

await test('runtime act: policy blocks an unwarranted effect before charging budget', () => {
  const runtime = new AmpRuntime({
    agentId: 'a.lead',
    start: NOW,
    policy: new PolicyEngine({ now: () => NOW }),
  })
  const blocked = runtime.act({
    tool: 'deploy.rollback',
    result: 'ok',
    resultTokens: 1,
    budgetTokens: 10,
    effect: 'deploy',
    claim: heldClaim('T2'),
  })
  assert.equal(blocked.receipt.outcome, 'blocked')
  assert.match(blocked.receipt.note ?? '', /tier_below_minimum/)

  const read = runtime.act({
    tool: 'logs.query',
    result: 'ok',
    resultTokens: 1,
    budgetTokens: 10,
    effect: 'read',
  })
  assert.equal(read.receipt.outcome, 'success')
})

await test('runtime signedManifest produces a verifiable declaration', async () => {
  const key = await generateSigningKey('a.lead#1')
  const runtime = new AmpRuntime({ agentId: 'a.lead', start: NOW })
  const manifest = await runtime.signedManifest(key)
  const verdict = await verifyManifest(manifest, key.publicKey)
  assert.equal(verdict.ok, true, verdict.reasons.join('; '))
  assert.equal(manifest.signatures[0]?.kid, key.kid)
})

await test('envelope: replay, tamper and version mismatch are rejected', async () => {
  const key = await generateSigningKey('a.lead#1')
  const from = { kind: 'agent' as const, id: 'a.lead' }
  const to = { kind: 'agent' as const, id: 'a.worker' }
  const base = {
    from,
    to,
    thread: 'th.1',
    type: 'inform' as const,
    sent: NOW,
    nonce: 'n.1',
    version: { min: '0.1', max: '0.1' },
    payload: { note: 'hello' },
  }
  const first = await sealEnvelope({ ...base, id: 'm.1', seq: 0 }, key)
  const tampered = { ...first, payload: { note: 'evil' } }
  const receiver = new EnvelopeRuntime({ now: () => NOW, version: { min: '0.1', max: '0.1' } })
  const invalid = await receiver.receive(tampered, key.publicKey)
  assert.equal(invalid.status, 'invalid')

  const accepted = await receiver.receive(first, key.publicKey)
  assert.equal(accepted.status, 'accepted')
  const duplicate = await receiver.receive(first, key.publicKey)
  assert.equal(duplicate.status, 'duplicate')

  const replay = await receiver.receive(
    await sealEnvelope({ ...base, id: 'm.2', seq: 1, nonce: 'n.1' }, key),
    key.publicKey,
  )
  assert.equal(replay.status, 'invalid')

  const wrongVersion = await receiver.receive(
    await sealEnvelope(
      { ...base, id: 'm.3', seq: 2, nonce: 'n.3', version: { min: '0.2', max: '0.2' } },
      key,
    ),
    key.publicKey,
  )
  assert.equal(wrongVersion.status, 'invalid')
})

await test('checkpoint: a rewritten chain cannot reuse the old signed tip', async () => {
  const key = await generateSigningKey('a.lead#1')
  const sink = new MemoryAppendSink()
  const log = await AppendLog.open(sink, 'a.lead')
  await log.append('claim', { id: 'c.1' })
  await log.append('claim', { id: 'c.2' })
  const checkpoint = await log.seal(key, { tenant: 'tenant.a', issued: NOW })
  const verified = await verifyCheckpoint(checkpoint, key.publicKey)
  assert.equal(verified.ok, true, verified.reasons.join('; '))

  const entries = log.entries().map((entry) => ({
    seq: entry.seq,
    kind: entry.kind,
    payload: entry.payload,
    prev: entry.prev,
    hash: entry.hash,
  }))
  const snapshot: LedgerSnapshot = {
    amp: '0.1',
    kind: 'ledger-snapshot',
    agent: 'a.lead',
    tip: log.tip,
    count: log.count,
    entries,
  }
  const matches = await verifySnapshotAgainstCheckpoint(snapshot, checkpoint)
  assert.equal(matches.ok, true, matches.reasons.join('; '))

  const evilSink = new MemoryAppendSink()
  const evil = await AppendLog.open(evilSink, 'a.lead')
  await evil.append('claim', { id: 'c.1' })
  await evil.append('claim', { id: 'c.evil' })
  const evilSnapshot: LedgerSnapshot = {
    amp: '0.1',
    kind: 'ledger-snapshot',
    agent: 'a.lead',
    tip: evil.tip,
    count: evil.count,
    entries: evil.entries().map((entry) => ({
      seq: entry.seq,
      kind: entry.kind,
      payload: entry.payload,
      prev: entry.prev,
      hash: entry.hash,
    })),
  }
  const mismatch = await verifySnapshotAgainstCheckpoint(evilSnapshot, checkpoint)
  assert.equal(mismatch.ok, false)

  const forged = await sealCheckpoint(evilSnapshot, key, { tenant: 'tenant.a', issued: NOW })
  const forgedVerdict = await verifyCheckpoint(forged, key.publicKey)
  assert.equal(forgedVerdict.ok, true)
  assert.notEqual(forged.tip, checkpoint.tip)
})

await test('interrupt ledger: a deferred request expires and external share is bounded', () => {
  const attention = new AttentionLedger({
    now: () => NOW,
    policy: {
      quietHours: undefined,
      cooldownMinutes: 0,
      budgets: { safety: 1, commitment: 0, opportunity: 0, curiosity: 0 },
    },
    defaultExpiryMs: 60_000,
  })
  const request: AttentionRequest = {
    amp: '0.1',
    kind: 'attention-request',
    id: 'ar.1',
    from: { kind: 'agent', id: 'a.lead' },
    to: { kind: 'human', id: 'u.li' },
    target: { kind: 'unknown', id: 'u.1' },
    class: 'commitment',
    urgency: 3,
    why_now: 'deadline',
    if_ignored: 'missed commitment',
    cost: { interrupts: 1 },
    fallback: 'queue',
  }
  const submitted = attention.submit(request)
  assert.equal(submitted.interrupt.status, 'deferred')
  assert.equal(attention.sweep('2026-10-24T10:01:00Z').length, 1)
  assert.equal(attention.get('ar.1')?.status, 'expired')
  assert.equal(admitExternal({ role: 'tool', share: 0.16 }).ok, false)
})

await test('keyring: rotation keeps a verification overlap, revocation is permanent', async () => {
  const oldKey = await generateSigningKey('a.lead#1')
  const newKey = await generateSigningKey('a.lead#2')
  const keyring = new Keyring({ now: () => NOW })
  keyring.add({
    kid: oldKey.kid,
    publicKey: oldKey.publicKey,
    status: 'active',
    validFrom: '2026-10-24T09:00:00Z',
  })
  keyring.rotate(oldKey.kid, { kid: newKey.kid, publicKey: newKey.publicKey, overlapMs: 60_000 })
  assert.ok(keyring.get(oldKey.kid, '2026-10-24T10:00:30Z'))
  assert.equal(keyring.get(oldKey.kid, '2026-10-24T10:03:00Z'), undefined)
  assert.ok(keyring.get(newKey.kid, '2026-10-24T10:03:00Z'))
  assert.equal(keyring.revoke(oldKey.kid, '2026-10-24T10:04:00Z'), true)
  assert.equal(keyring.get(oldKey.kid, '2026-10-24T09:30:00Z'), undefined)
  assert.equal(
    checkManifestWindow(
      { issued: '2026-10-24T09:00:00Z', expires: '2026-10-24T09:30:00Z' },
      NOW,
    ).ok,
    false,
  )
})

await test('guard: rate limiting stops the next dispatch before it runs', () => {
  let now = 0
  const guard = new Guard({ now: () => now, rate: { limit: 1, intervalMs: 1000 } })
  guard.beforeDispatch()
  now = 10
  assert.throws(() => guard.beforeDispatch(), RateLimited)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
