#!/usr/bin/env node
/** Authenticated A-surface envelope checks: seal, verify, ordering, replay, cancel. */
import assert from 'node:assert/strict'

import {
  EnvelopeRuntime,
  envelopeDigest,
  negotiateVersion,
  sealEnvelope,
  verifyEnvelope,
} from '../src/protocol/envelope.ts'
import type {
  EnvelopeInput,
  SealedEnvelope,
  VersionRange,
} from '../src/protocol/envelope.ts'
import { generateSigningKey } from '../src/manifest/sign.ts'
import type { KeyPair } from '../src/manifest/sign.ts'
import type { Ref } from '../src/types/common.ts'

const alice = await generateSigningKey('a.alice#1')
const bob = await generateSigningKey('a.bob#1')

const ALICE: Ref = { kind: 'agent', id: 'a.alice' }
const BOB: Ref = { kind: 'agent', id: 'a.bob' }
const CAROL: Ref = { kind: 'agent', id: 'a.carol' }

const NOW = '2026-10-24T10:00:00.000Z'
const VERSION: VersionRange = { min: '0.1', max: '0.1' }

type Payload = Record<string, unknown>
type Overrides = Partial<EnvelopeInput<Payload>>

function messageInput(overrides: Overrides = {}): EnvelopeInput<Payload> {
  const id = overrides.id ?? 'm.1'
  return {
    id,
    from: ALICE,
    to: BOB,
    thread: 'th.1',
    seq: 0,
    type: 'request',
    sent: NOW,
    nonce: `n.${id}`,
    version: { ...VERSION },
    payload: { request: 'act.1' },
    ...overrides,
  }
}

async function sealMessage(
  overrides: Overrides = {},
  key: KeyPair = alice,
): Promise<SealedEnvelope<Payload>> {
  return sealEnvelope(messageInput(overrides), key)
}

function replace(
  envelope: SealedEnvelope<Payload>,
  patch: Record<string, unknown>,
): SealedEnvelope<Payload> {
  return { ...envelope, ...patch } as unknown as SealedEnvelope<Payload>
}

function withoutField(
  envelope: SealedEnvelope<Payload>,
  field: string,
): SealedEnvelope<Payload> {
  const copy: Record<string, unknown> = { ...envelope }
  delete copy[field]
  return copy as unknown as SealedEnvelope<Payload>
}

function ids(envelopes: readonly SealedEnvelope[]): string[] {
  return envelopes.map((envelope) => envelope.id)
}

function runtimeAt(
  now: string = NOW,
  clockSkewMs?: number,
  version: VersionRange = VERSION,
): EnvelopeRuntime {
  return new EnvelopeRuntime({ now: () => now, version: { ...version }, clockSkewMs })
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`)
  }
}

await test('seal/verify round trip and defaults', async () => {
  const before = Date.now()
  const envelope = await sealEnvelope(
    messageInput({ id: undefined, nonce: undefined, sent: undefined }),
    alice,
  )
  const after = Date.now()

  assert.equal(envelope.amp, '0.1')
  assert.equal(envelope.kind, 'envelope')
  assert.match(envelope.id, /^m\.[0-9a-f]{32}$/)
  assert.match(envelope.nonce, /^[0-9a-f]{32}$/)
  assert.equal(envelope.seq, 0)
  assert.deepEqual(envelope.version, VERSION)
  assert.equal(envelope.kid, alice.kid)
  assert.equal(Object.hasOwn(envelope, 'expires'), false)
  assert.match(envelope.sig, /^[A-Za-z0-9_-]+$/)

  const sent = Date.parse(envelope.sent)
  assert.ok(Number.isFinite(sent))
  assert.ok(sent >= before - 1_000 && sent <= after + 1_000)

  const verified = await verifyEnvelope(envelope, alice.publicKey, {
    now: envelope.sent,
    expectedVersion: VERSION,
  })
  assert.equal(verified.ok, true, verified.reasons.join('; '))
  assert.deepEqual(verified.reasons, [])

  const wire = JSON.parse(JSON.stringify(envelope)) as SealedEnvelope
  const wireVerified = await verifyEnvelope(wire, alice.publicKey, {
    now: envelope.sent,
    expectedVersion: VERSION,
  })
  assert.equal(wireVerified.ok, true, wireVerified.reasons.join('; '))
})

await test('fixed sent/nonce/seq produce a deterministic signature', async () => {
  const input: Overrides = {
    id: 'm.deterministic',
    seq: 3,
    nonce: 'n.deterministic',
    sent: '2026-10-24T09:59:00.000Z',
    ttlMs: 60_000,
    payload: { request: 'act.deterministic' },
  }
  const first = await sealMessage(input)
  const second = await sealMessage({ ...input, version: { min: '0.1', max: '0.1' } })
  assert.deepEqual(first, second)
  assert.equal(first.sig, second.sig)
  assert.equal(envelopeDigest(first), envelopeDigest(second))

  const changed = await sealMessage({ ...input, payload: { request: 'act.changed' } })
  assert.notEqual(envelopeDigest(first), envelopeDigest(changed))
})

await test('ttl computes expires from sent and rejects a negative ttl', async () => {
  const envelope = await sealMessage({ id: 'm.ttl', ttlMs: 300_000 })
  assert.equal(envelope.expires, '2026-10-24T10:05:00.000Z')

  const result = await verifyEnvelope(envelope, alice.publicKey, { now: NOW })
  assert.equal(result.ok, true, result.reasons.join('; '))

  await assert.rejects(
    sealEnvelope(messageInput({ id: 'm.negative', ttlMs: -1 }), alice),
    /ttlMs/,
  )
  await assert.rejects(
    sealEnvelope(messageInput({ id: 'm.nan', ttlMs: Number.NaN }), alice),
    /ttlMs/,
  )
})

await test('tampering with any signed field fails verification', async () => {
  const original = await sealMessage({ id: 'm.tamper', ttlMs: 60_000 })
  const tampered: Array<[string, SealedEnvelope<Payload>]> = [
    ['id', replace(original, { id: 'm.tamper.other' })],
    ['from', replace(original, { from: { kind: 'agent', id: 'a.mallory' } })],
    ['to', replace(original, { to: { kind: 'agent', id: 'a.mallory' } })],
    ['thread', replace(original, { thread: 'th.other' })],
    ['seq', replace(original, { seq: 1 })],
    ['type', replace(original, { type: 'inform' })],
    ['sent', replace(original, { sent: '2026-10-24T10:00:01.000Z' })],
    ['expires', replace(original, { expires: '2026-10-24T10:10:00.000Z' })],
    ['version', replace(original, { version: { min: '0.1', max: '0.2' } })],
    ['nonce', replace(original, { nonce: 'n.tampered' })],
    ['payload', replace(original, { payload: { request: 'act.evil' } })],
    ['kid', replace(original, { kid: 'a.alice#2' })],
    ['extra field', replace(original, { injected: true })],
  ]

  for (const [field, envelope] of tampered) {
    const result = await verifyEnvelope(envelope, alice.publicKey, {
      now: NOW,
      expectedVersion: VERSION,
    })
    assert.equal(result.ok, false, `${field} tamper must fail`)
    assert.ok(
      result.reasons.some((reason) => reason.includes('signature')),
      `${field} tamper should report a signature failure: ${result.reasons.join('; ')}`,
    )
  }
})

await test('a wrong public key cannot verify and does not consume the nonce', async () => {
  const envelope = await sealMessage({ id: 'm.wrong-key' })
  const seen = new Set<string>()
  const result = await verifyEnvelope(envelope, bob.publicKey, {
    now: NOW,
    expectedVersion: VERSION,
    seenNonces: seen,
  })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('signature')))
  assert.equal(seen.has(envelope.nonce), false)
})

await test('expiry honours clock skew, and an expired envelope burns no nonce', async () => {
  const envelope = await sealMessage({ id: 'm.expiry', ttlMs: 60_000 })
  assert.equal(envelope.expires, '2026-10-24T10:01:00.000Z')

  const atExpiry = await verifyEnvelope(envelope, alice.publicKey, {
    now: envelope.expires as string,
  })
  assert.equal(atExpiry.ok, true, atExpiry.reasons.join('; '))

  const justAfter = await verifyEnvelope(envelope, alice.publicKey, {
    now: '2026-10-24T10:01:00.001Z',
  })
  assert.equal(justAfter.ok, false)
  assert.ok(justAfter.reasons.some((reason) => reason.includes('expired')))

  const withinSkew = await verifyEnvelope(envelope, alice.publicKey, {
    now: '2026-10-24T10:01:30.000Z',
    clockSkewMs: 60_000,
  })
  assert.equal(withinSkew.ok, true, withinSkew.reasons.join('; '))

  const beyondSkew = await verifyEnvelope(envelope, alice.publicKey, {
    now: '2026-10-24T10:02:01.000Z',
    clockSkewMs: 60_000,
  })
  assert.equal(beyondSkew.ok, false)
  assert.ok(beyondSkew.reasons.some((reason) => reason.includes('expired')))

  const seen = new Set<string>()
  const expired = await verifyEnvelope(envelope, alice.publicKey, {
    now: '2026-10-24T10:01:00.001Z',
    seenNonces: seen,
  })
  assert.equal(expired.ok, false)
  assert.equal(seen.has(envelope.nonce), false)
})

await test('missing and malformed required fields are invalid, never thrown', async () => {
  const valid = await sealMessage({ id: 'm.required', ttlMs: 60_000 })
  const fields = [
    'id',
    'from',
    'to',
    'thread',
    'seq',
    'type',
    'sent',
    'nonce',
    'version',
    'payload',
    'kid',
    'sig',
  ]
  for (const field of fields) {
    const result = await verifyEnvelope(withoutField(valid, field), alice.publicKey, {
      now: NOW,
    })
    assert.equal(result.ok, false, `missing ${field} must fail`)
  }

  assert.equal(
    (await verifyEnvelope(null as unknown as SealedEnvelope, alice.publicKey)).ok,
    false,
  )

  const malformed: Array<[string, SealedEnvelope<Payload>, string]> = [
    ['amp', replace(valid, { amp: '0.2' }), 'amp'],
    ['kind', replace(valid, { kind: 'message' }), 'kind'],
    ['type', replace(valid, { type: 'subscribe' }), 'type'],
    ['seq', replace(valid, { seq: -1 }), 'seq'],
    ['nonce', replace(valid, { nonce: '' }), 'nonce'],
    ['version', replace(valid, { version: { min: '0.2', max: '0.1' } }), 'version'],
    ['from', replace(valid, { from: { kind: 'agent', id: '' } }), 'from'],
    ['signature', replace(valid, { sig: '***not-base64url***' }), 'signature'],
  ]
  for (const [field, envelope, reasonWord] of malformed) {
    const result = await verifyEnvelope(envelope, alice.publicKey, { now: NOW })
    assert.equal(result.ok, false, `malformed ${field} must fail`)
    assert.ok(
      result.reasons.some((reason) => reason.includes(reasonWord)),
      `malformed ${field} should mention ${reasonWord}: ${result.reasons.join('; ')}`,
    )
  }
})

await test('version negotiation intersects inclusive major.minor ranges', async () => {
  assert.deepEqual(negotiateVersion(VERSION, { ...VERSION }), VERSION)
  assert.equal(negotiateVersion(VERSION, { min: '0.2', max: '0.2' }), null)
  assert.deepEqual(
    negotiateVersion({ min: '0.1', max: '0.3' }, { min: '0.2', max: '0.4' }),
    { min: '0.2', max: '0.3' },
  )
  assert.deepEqual(
    negotiateVersion({ min: '0.1', max: '0.2' }, { min: '0.2', max: '0.2' }),
    { min: '0.2', max: '0.2' },
  )
  assert.equal(negotiateVersion({ min: '0.2', max: '0.1' }, VERSION), null)
  assert.equal(
    negotiateVersion({ min: '0.10', max: '0.10' }, { min: '0.9', max: '0.9' }),
    null,
  )

  const newer = await sealMessage({
    id: 'm.version.2',
    version: { min: '0.2', max: '0.2' },
  })
  const mismatch = await verifyEnvelope(newer, alice.publicKey, {
    now: NOW,
    expectedVersion: VERSION,
  })
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.reasons.some((reason) => reason.includes('version')))

  const match = await verifyEnvelope(newer, alice.publicKey, {
    now: NOW,
    expectedVersion: { min: '0.2', max: '0.2' },
  })
  assert.equal(match.ok, true, match.reasons.join('; '))
})

await test('seenNonces rejects replay, while a failed signature burns no nonce', async () => {
  const envelope = await sealMessage({ id: 'm.nonce' })
  const seen = new Set<string>()

  const first = await verifyEnvelope(envelope, alice.publicKey, {
    now: NOW,
    seenNonces: seen,
  })
  assert.equal(first.ok, true, first.reasons.join('; '))
  assert.equal(seen.has(envelope.nonce), true)

  const replay = await verifyEnvelope(envelope, alice.publicKey, {
    now: NOW,
    seenNonces: seen,
  })
  assert.equal(replay.ok, false)
  assert.ok(replay.reasons.some((reason) => reason.includes('nonce')))

  const forged = replace(envelope, { payload: { request: 'act.forged' } })
  const clean = new Set<string>()
  const forgedResult = await verifyEnvelope(forged, alice.publicKey, {
    now: NOW,
    seenNonces: clean,
  })
  assert.equal(forgedResult.ok, false)
  assert.equal(clean.has(envelope.nonce), false)
})

await test('random ids and nonces differ across seals', async () => {
  const first = await sealEnvelope(
    messageInput({ id: undefined, nonce: undefined, sent: undefined }),
    alice,
  )
  const second = await sealEnvelope(
    messageInput({ id: undefined, nonce: undefined, sent: undefined }),
    alice,
  )
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.nonce, second.nonce)
  assert.match(first.nonce, /^[0-9a-f]{32}$/)
  assert.match(second.nonce, /^[0-9a-f]{32}$/)
})

await test('receiver accepts seq 0, dedupes ids and does not advance on a duplicate id', async () => {
  const runtime = runtimeAt()
  const first = await sealMessage({ id: 'm.runtime.0', seq: 0 })

  const accepted = await runtime.receive(first, alice.publicKey)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.ok, true)
  assert.deepEqual(ids(runtime.delivered), ['m.runtime.0'])

  const repeat = await runtime.receive(first, alice.publicKey)
  assert.equal(repeat.status, 'duplicate')
  assert.equal(repeat.ok, false)
  assert.deepEqual(ids(runtime.delivered), ['m.runtime.0'])

  const sameIdAhead = await sealMessage({
    id: 'm.runtime.0',
    seq: 1,
    nonce: 'n.same-id-ahead',
    payload: { request: 'act.duplicate-id' },
  })
  const duplicateId = await runtime.receive(sameIdAhead, alice.publicKey)
  assert.equal(duplicateId.status, 'duplicate')
  assert.deepEqual(ids(runtime.delivered), ['m.runtime.0'])

  const next = await sealMessage({ id: 'm.runtime.1', seq: 1 })
  const acceptedNext = await runtime.receive(next, alice.publicKey)
  assert.equal(acceptedNext.status, 'accepted')
  assert.deepEqual(ids(runtime.delivered), ['m.runtime.0', 'm.runtime.1'])
})

await test('receiver queues seq 2, drains 1 then 2, and treats stale seq as duplicate', async () => {
  const runtime = runtimeAt()
  const zero = await sealMessage({ id: 'm.order.0', seq: 0 })
  const two = await sealMessage({ id: 'm.order.2', seq: 2, payload: { request: 'act.2' } })
  const one = await sealMessage({ id: 'm.order.1', seq: 1, payload: { request: 'act.1' } })

  assert.equal((await runtime.receive(zero, alice.publicKey)).status, 'accepted')
  assert.equal((await runtime.receive(two, alice.publicKey)).status, 'out_of_order')
  assert.deepEqual(ids(runtime.delivered), ['m.order.0'])
  assert.deepEqual(ids(runtime.pending), ['m.order.2'])

  const drained = await runtime.receive(one, alice.publicKey)
  assert.equal(drained.status, 'accepted')
  assert.deepEqual(ids(runtime.delivered), ['m.order.0', 'm.order.1', 'm.order.2'])
  assert.deepEqual(ids(runtime.pending), [])

  const stale = await sealMessage({ id: 'm.order.stale', seq: 1, nonce: 'n.stale' })
  const staleResult = await runtime.receive(stale, alice.publicKey)
  assert.equal(staleResult.status, 'duplicate')
  assert.ok(staleResult.reasons.some((reason) => reason.includes('stale')))
  assert.deepEqual(ids(runtime.delivered), ['m.order.0', 'm.order.1', 'm.order.2'])
})

await test('threads and recipient pairs have independent sequence windows', async () => {
  const runtime = runtimeAt()
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.thread.a0', thread: 'th.a', seq: 0 }),
      alice.publicKey,
    )).status,
    'accepted',
  )
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.thread.b0', thread: 'th.b', seq: 0 }),
      alice.publicKey,
    )).status,
    'accepted',
  )
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.thread.a1', thread: 'th.a', seq: 1 }),
      alice.publicKey,
    )).status,
    'accepted',
  )
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.recipient.carol', thread: 'th.a', to: CAROL, seq: 0 }),
      alice.publicKey,
    )).status,
    'accepted',
  )
  assert.deepEqual(ids(runtime.delivered), [
    'm.thread.a0',
    'm.thread.b0',
    'm.thread.a1',
    'm.recipient.carol',
  ])
})

await test('receiver rejects nonce replay without advancing the sequence', async () => {
  const runtime = runtimeAt()
  const first = await sealMessage({ id: 'm.replay.0', seq: 0 })
  assert.equal((await runtime.receive(first, alice.publicKey)).status, 'accepted')

  const replayed = await sealMessage({ id: 'm.replay.1', seq: 1, nonce: first.nonce })
  const rejected = await runtime.receive(replayed, alice.publicKey)
  assert.equal(rejected.status, 'invalid')
  assert.ok(rejected.reasons.some((reason) => reason.includes('nonce')))
  assert.deepEqual(ids(runtime.delivered), ['m.replay.0'])

  const valid = await sealMessage({ id: 'm.replay.1.valid', seq: 1 })
  assert.equal((await runtime.receive(valid, alice.publicKey)).status, 'accepted')
})

await test('signature, ttl and version failures leave dedupe, nonce and sequence state untouched', async () => {
  const runtime = runtimeAt()
  assert.equal(
    (await runtime.receive(await sealMessage({ id: 'm.advance.0', seq: 0 }), alice.publicKey)).status,
    'accepted',
  )

  const legitimateOne = await sealMessage({
    id: 'm.advance.1',
    seq: 1,
    payload: { request: 'act.advance.1' },
  })
  const forgedOne = replace(legitimateOne, { payload: { request: 'act.forged' } })
  assert.equal((await runtime.receive(forgedOne, alice.publicKey)).status, 'invalid')
  assert.deepEqual(ids(runtime.delivered), ['m.advance.0'])
  assert.equal((await runtime.receive(legitimateOne, alice.publicKey)).status, 'accepted')

  const expiredTwo = await sealMessage({
    id: 'm.advance.2.expired',
    seq: 2,
    sent: '2026-10-24T09:00:00.000Z',
    ttlMs: 1_000,
  })
  const expiredResult = await runtime.receive(expiredTwo, alice.publicKey)
  assert.equal(expiredResult.status, 'invalid')
  assert.ok(expiredResult.reasons.some((reason) => reason.includes('expired')))
  assert.deepEqual(ids(runtime.delivered), ['m.advance.0', 'm.advance.1'])
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.advance.2', seq: 2 }),
      alice.publicKey,
    )).status,
    'accepted',
  )

  const wrongVersion = await sealMessage({
    id: 'm.advance.3.version',
    seq: 3,
    version: { min: '0.2', max: '0.2' },
  })
  const versionResult = await runtime.receive(wrongVersion, alice.publicKey)
  assert.equal(versionResult.status, 'invalid')
  assert.ok(versionResult.reasons.some((reason) => reason.includes('version')))
  assert.deepEqual(ids(runtime.delivered), ['m.advance.0', 'm.advance.1', 'm.advance.2'])
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.advance.3', seq: 3 }),
      alice.publicKey,
    )).status,
    'accepted',
  )
})

await test('cancel tombstones suppress a later target without delivering it', async () => {
  const runtime = runtimeAt()
  assert.equal(
    (await runtime.receive(await sealMessage({ id: 'm.cancel.0', seq: 0 }), alice.publicKey)).status,
    'accepted',
  )

  const cancel = await sealMessage({
    id: 'm.cancel.1',
    seq: 1,
    type: 'cancel',
    payload: { targetId: 'm.target.1' },
  })
  assert.equal((await runtime.receive(cancel, alice.publicKey)).status, 'accepted')

  const target = await sealMessage({
    id: 'm.target.1',
    seq: 2,
    payload: { request: 'act.target' },
  })
  const cancelled = await runtime.receive(target, alice.publicKey)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.ok, false)
  assert.deepEqual(ids(runtime.delivered), ['m.cancel.0', 'm.cancel.1'])
  assert.deepEqual(ids(runtime.cancelled), ['m.target.1'])
  assert.equal(
    (await runtime.receive(
      await sealMessage({ id: 'm.cancel.3', seq: 3 }),
      alice.publicKey,
    )).status,
    'accepted',
  )
})

await test('cancel accepts the protocol request alias and rejects a missing target', async () => {
  const runtime = runtimeAt()
  const missing = await sealMessage({
    id: 'm.cancel.missing',
    seq: 0,
    type: 'cancel',
    payload: {},
  })
  const missingResult = await runtime.receive(missing, alice.publicKey)
  assert.equal(missingResult.status, 'invalid')
  assert.ok(missingResult.reasons.some((reason) => reason.includes('targetId')))

  const cancel = await sealMessage({
    id: 'm.cancel.alias',
    seq: 0,
    type: 'cancel',
    payload: { request: 'm.target.alias' },
  })
  assert.equal((await runtime.receive(cancel, alice.publicKey)).status, 'accepted')

  const target = await sealMessage({
    id: 'm.target.alias',
    seq: 1,
    payload: { request: 'act.alias' },
  })
  assert.equal((await runtime.receive(target, alice.publicKey)).status, 'cancelled')
  assert.deepEqual(ids(runtime.cancelled), ['m.target.alias'])
})

await test('a queued target is cancelled when the gap-closing cancel is delivered', async () => {
  const runtime = runtimeAt()
  assert.equal(
    (await runtime.receive(await sealMessage({ id: 'm.q.0', seq: 0 }), alice.publicKey)).status,
    'accepted',
  )

  const target = await sealMessage({
    id: 'm.q.target',
    seq: 2,
    payload: { request: 'act.queued' },
  })
  assert.equal((await runtime.receive(target, alice.publicKey)).status, 'out_of_order')
  assert.deepEqual(ids(runtime.pending), ['m.q.target'])

  const cancel = await sealMessage({
    id: 'm.q.cancel',
    seq: 1,
    type: 'cancel',
    payload: { targetId: 'm.q.target' },
  })
  assert.equal((await runtime.receive(cancel, alice.publicKey)).status, 'accepted')
  assert.deepEqual(ids(runtime.pending), [])
  assert.deepEqual(ids(runtime.delivered), ['m.q.0', 'm.q.cancel'])
  assert.deepEqual(ids(runtime.cancelled), ['m.q.target'])
})

await test('cancel obeys sequence order and never resurrects a delivered id', async () => {
  const runtime = runtimeAt()
  const earlyCancel = await sealMessage({
    id: 'm.cancel.ordered',
    seq: 1,
    type: 'cancel',
    payload: { targetId: 'm.ordered.target' },
  })
  assert.equal((await runtime.receive(earlyCancel, alice.publicKey)).status, 'out_of_order')

  const target = await sealMessage({
    id: 'm.ordered.target',
    seq: 0,
    payload: { request: 'act.ordered' },
  })
  assert.equal((await runtime.receive(target, alice.publicKey)).status, 'accepted')
  assert.deepEqual(ids(runtime.delivered), ['m.ordered.target', 'm.cancel.ordered'])
  assert.deepEqual(ids(runtime.cancelled), [])

  const final = await sealMessage({
    id: 'm.ordered.final',
    seq: 2,
    payload: { request: 'act.final' },
  })
  assert.equal((await runtime.receive(final, alice.publicKey)).status, 'accepted')

  const runtime2 = runtimeAt()
  const deliveredTarget = await sealMessage({
    id: 'm.keep.target',
    seq: 0,
    payload: { request: 'act.keep' },
  })
  assert.equal((await runtime2.receive(deliveredTarget, alice.publicKey)).status, 'accepted')
  const lateCancel = await sealMessage({
    id: 'm.keep.cancel',
    seq: 1,
    type: 'cancel',
    payload: { targetId: 'm.keep.target' },
  })
  assert.equal((await runtime2.receive(lateCancel, alice.publicKey)).status, 'accepted')
  assert.deepEqual(ids(runtime2.delivered), ['m.keep.target', 'm.keep.cancel'])
  assert.deepEqual(ids(runtime2.cancelled), [])
  assert.equal(
    (await runtime2.receive(deliveredTarget, alice.publicKey)).status,
    'duplicate',
  )
  assert.deepEqual(ids(runtime2.delivered), ['m.keep.target', 'm.keep.cancel'])
})

await test('runtime applies clock skew while still rejecting a truly expired envelope', async () => {
  const envelope = await sealMessage({ id: 'm.skew', seq: 0, ttlMs: 60_000 })
  const skewRuntime = runtimeAt('2026-10-24T10:01:30.000Z', 60_000)
  assert.equal((await skewRuntime.receive(envelope, alice.publicKey)).status, 'accepted')

  const strictRuntime = runtimeAt('2026-10-24T10:01:30.000Z')
  const rejected = await strictRuntime.receive(envelope, alice.publicKey)
  assert.equal(rejected.status, 'invalid')
  assert.ok(rejected.reasons.some((reason) => reason.includes('expired')))
})

await test('cancel tombstones are scoped to the sender identity', async () => {
  const runtime = runtimeAt()
  const cancel = await sealEnvelope(
    messageInput({
      id: 'm.cross.cancel',
      seq: 0,
      type: 'cancel',
      from: ALICE,
      to: BOB,
      payload: { targetId: 'm.cross.target' },
    }),
    alice,
  )
  assert.equal((await runtime.receive(cancel, alice.publicKey)).status, 'accepted')

  const bobTarget = await sealEnvelope(
    messageInput({
      id: 'm.cross.target',
      seq: 0,
      from: BOB,
      to: ALICE,
      payload: { request: 'act.bob' },
      nonce: 'n.cross.bob',
    }),
    bob,
  )
  assert.equal((await runtime.receive(bobTarget, bob.publicKey)).status, 'accepted')
  assert.deepEqual(ids(runtime.delivered), ['m.cross.cancel', 'm.cross.target'])
})

if (failed > 0) process.exitCode = 1
console.log(`\n${passed} passed, ${failed} failed`)
