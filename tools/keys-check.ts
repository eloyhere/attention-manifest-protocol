#!/usr/bin/env node
/** Key lifecycle checks: windows, rotation, retirement, revocation and merge. */
import assert from 'node:assert/strict'

import {
  checkManifestWindow,
  isRevocationFresh,
  Keyring,
  mergeRevocations,
  requireFresh,
  RevocationError,
} from '../src/manifest/keys.ts'
import { generateSigningKey } from '../src/manifest/sign.ts'
import type { KeyRecord, RevocationList } from '../src/manifest/keys.ts'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (error) {
    failed += 1
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

function recordOf(
  kid: string,
  publicKey: CryptoKey,
  overrides: Partial<Pick<KeyRecord, 'status' | 'validFrom' | 'validTo' | 'supersedes' | 'note'>> = {},
): KeyRecord {
  return {
    kid,
    publicKey,
    status: overrides.status ?? 'active',
    validFrom: overrides.validFrom ?? '2026-10-24T00:00:00.000Z',
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    ...(overrides.supersedes === undefined ? {} : { supersedes: overrides.supersedes }),
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  }
}

function freshList(overrides: Partial<RevocationList> = {}): RevocationList {
  return {
    issuer: overrides.issuer ?? 'org.acme',
    issued: overrides.issued ?? '2026-10-24T10:00:00.000Z',
    nextUpdate: overrides.nextUpdate ?? '2026-10-24T12:00:00.000Z',
    revoked: overrides.revoked ?? [
      { kid: 'agent#0', revokedAt: '2026-10-24T09:00:00.000Z', reason: 'retired' },
    ],
  }
}

const oldKey = await generateSigningKey('agent#1')
const nextKey = await generateSigningKey('agent#2')
const spareKey = await generateSigningKey('agent#3')

const localRevocations: RevocationList = {
  issuer: 'org.acme',
  issued: '2026-10-24T10:00:00.000Z',
  nextUpdate: '2026-10-24T12:00:00.000Z',
  revoked: [
    { kid: 'agent#2', revokedAt: '2026-10-24T09:00:00.000Z', reason: 'local' },
    { kid: 'agent#1', revokedAt: '2026-10-24T08:00:00.000Z' },
  ],
}

const remoteRevocations: RevocationList = {
  issuer: 'org.acme',
  issued: '2026-10-24T11:00:00.000Z',
  nextUpdate: '2026-10-24T13:00:00.000Z',
  revoked: [
    { kid: 'agent#2', revokedAt: '2026-10-24T08:30:00.000Z', reason: 'remote' },
    { kid: 'agent#3', revokedAt: '2026-10-24T09:30:00.000Z', reason: 'remote' },
  ],
}

await test('add stores a key that get returns inside its window', () => {
  let now = '2026-10-24T10:30:00.000Z'
  const ring = new Keyring({ now: () => now })
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T10:00:00.000Z',
      validTo: '2026-10-24T11:00:00.000Z',
      note: 'primary',
    }),
  )
  assert.equal(ring.get('agent#1'), oldKey.publicKey)
  assert.equal(ring.record('agent#1')?.note, 'primary')
  now = '2026-10-24T11:00:00.001Z'
  assert.equal(ring.get('agent#1'), undefined)
  assert.equal(ring.record('missing'), undefined)
})

await test('add rejects a duplicate kid', () => {
  const ring = new Keyring()
  ring.add(recordOf('agent#1', oldKey.publicKey))
  assert.throws(() => ring.add(recordOf('agent#1', nextKey.publicKey)), /duplicate kid/)
})

await test('add rejects inverted windows and malformed timestamps', () => {
  const ring = new Keyring()
  assert.throws(
    () =>
      ring.add(
        recordOf('bad#1', oldKey.publicKey, {
          validFrom: '2026-10-24T11:00:00.000Z',
          validTo: '2026-10-24T10:00:00.000Z',
        }),
      ),
    /validTo/,
  )
  assert.throws(
    () =>
      ring.add(
        recordOf('bad#2', oldKey.publicKey, {
          validFrom: '2026-10-24T11:00:00.000Z',
          validTo: '2026-10-24T11:00:00.000Z',
        }),
      ),
    /validTo/,
  )
  assert.throws(
    () => ring.add(recordOf('bad#3', oldKey.publicKey, { validFrom: 'not-a-date' })),
    /validFrom/,
  )
  assert.throws(
    () => ring.add(recordOf('bad#4', oldKey.publicKey, { validTo: 'not-a-date' })),
    /validTo/,
  )
  assert.equal(ring.record('bad#1'), undefined)
})

await test('get treats validFrom and validTo as inclusive boundaries', () => {
  const ring = new Keyring({ now: () => '2026-10-24T10:30:00.000Z' })
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T10:00:00.000Z',
      validTo: '2026-10-24T11:00:00.000Z',
    }),
  )
  assert.equal(ring.get('agent#1', '2026-10-24T09:59:59.999Z'), undefined)
  assert.equal(ring.get('agent#1', '2026-10-24T10:00:00.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T11:00:00.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T11:00:00.001Z'), undefined)
})

await test('clockSkewMs widens key windows only when configured', () => {
  const window = {
    validFrom: '2026-10-24T10:00:00.000Z',
    validTo: '2026-10-24T11:00:00.000Z',
  }
  const strict = new Keyring({ now: () => '2026-10-24T10:30:00.000Z' })
  const tolerant = new Keyring({ now: () => '2026-10-24T10:30:00.000Z', clockSkewMs: 1_000 })
  strict.add(recordOf('strict#1', oldKey.publicKey, window))
  tolerant.add(recordOf('tolerant#1', oldKey.publicKey, window))
  assert.equal(strict.get('strict#1', '2026-10-24T09:59:59.500Z'), undefined)
  assert.equal(tolerant.get('tolerant#1', '2026-10-24T09:59:59.500Z'), oldKey.publicKey)
  assert.equal(tolerant.get('tolerant#1', '2026-10-24T11:00:00.500Z'), oldKey.publicKey)
  assert.equal(tolerant.get('tolerant#1', '2026-10-24T11:00:01.001Z'), undefined)
})

await test('active reports only keys usable at the timestamp', () => {
  const ring = new Keyring()
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T10:00:00.000Z',
      validTo: '2026-10-24T11:00:00.000Z',
    }),
  )
  ring.add(
    recordOf('agent#2', nextKey.publicKey, {
      validFrom: '2026-10-24T11:00:00.000Z',
      validTo: '2026-10-24T12:00:00.000Z',
    }),
  )
  assert.deepEqual(
    ring.active('2026-10-24T10:30:00.000Z').map((record) => record.kid),
    ['agent#1'],
  )
  assert.deepEqual(
    ring.active('2026-10-24T11:00:00.000Z').map((record) => record.kid),
    ['agent#1', 'agent#2'],
  )
  assert.deepEqual(ring.active('2026-10-24T12:00:00.001Z').map((record) => record.kid), [])
  ring.retire('agent#1', '2026-10-24T10:30:00.000Z')
  ring.revoke('agent#2', '2026-10-24T11:30:00.000Z')
  assert.equal(ring.active('2026-10-24T10:45:00.000Z').length, 0)
})

await test('rotate retires the old key and activates its successor', () => {
  let now = '2026-10-24T12:00:00.000Z'
  const ring = new Keyring({ now: () => now })
  ring.add(recordOf('agent#1', oldKey.publicKey, { validFrom: '2026-10-20T00:00:00.000Z' }))
  const successor = ring.rotate('agent#1', {
    kid: 'agent#2',
    publicKey: nextKey.publicKey,
    overlapMs: 60_000,
  })
  assert.equal(successor.kid, 'agent#2')
  assert.equal(successor.status, 'active')
  assert.equal(successor.supersedes, 'agent#1')
  assert.equal(successor.validFrom, now)
  const retired = ring.record('agent#1')
  assert.equal(retired?.status, 'retired')
  assert.equal(retired?.validTo, '2026-10-24T12:01:00.000Z')
  assert.deepEqual(ring.active().map((record) => record.kid), ['agent#2'])
  assert.equal(ring.get('agent#1', '2026-10-24T12:00:30.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T12:01:00.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T12:01:00.001Z'), undefined)
  assert.equal(ring.get('agent#1', '2026-10-21T00:00:00.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#2', '2026-10-24T11:59:59.999Z'), undefined)
  assert.equal(ring.get('agent#2'), nextKey.publicKey)
  now = '2026-10-24T12:01:00.001Z'
  assert.equal(ring.get('agent#1'), undefined)
})

await test('rotation overlap never extends an existing validTo', () => {
  const ring = new Keyring({ now: () => '2026-10-24T12:00:00.000Z' })
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T11:00:00.000Z',
      validTo: '2026-10-24T12:00:30.000Z',
    }),
  )
  ring.rotate('agent#1', {
    kid: 'agent#2',
    publicKey: nextKey.publicKey,
    overlapMs: 3_600_000,
  })
  assert.equal(ring.record('agent#1')?.validTo, '2026-10-24T12:00:30.000Z')
  assert.equal(ring.get('agent#1', '2026-10-24T12:00:30.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T12:00:30.001Z'), undefined)
})

await test('retired keys still verify signatures during the overlap', async () => {
  let now = '2026-10-24T12:00:00.000Z'
  const ring = new Keyring({ now: () => now })
  ring.add(recordOf('agent#1', oldKey.publicKey, { validFrom: '2026-10-20T00:00:00.000Z' }))
  const payload = new TextEncoder().encode('signed before rotation')
  const signature = await crypto.subtle.sign('Ed25519', oldKey.privateKey, payload)
  ring.rotate('agent#1', { kid: 'agent#2', publicKey: nextKey.publicKey, overlapMs: 60_000 })
  const duringOverlap = ring.get('agent#1', '2026-10-24T12:00:30.000Z')
  if (!duringOverlap) throw new Error('expected the retired key during the overlap')
  assert.equal(await crypto.subtle.verify('Ed25519', duringOverlap, signature, payload), true)
  now = '2026-10-24T12:01:00.001Z'
  assert.equal(ring.get('agent#1'), undefined)
  const history = ring.record('agent#1')
  assert.equal(history?.status, 'retired')
  assert.equal(history?.publicKey, oldKey.publicKey)
})

await test('rotate rejects negative overlap, duplicates and unknown keys', () => {
  const ring = new Keyring({ now: () => '2026-10-24T12:00:00.000Z' })
  ring.add(recordOf('agent#1', oldKey.publicKey))
  assert.throws(
    () => ring.rotate('agent#1', { kid: 'agent#2', publicKey: nextKey.publicKey, overlapMs: -1 }),
    /overlapMs/,
  )
  assert.throws(
    () => ring.rotate('agent#1', { kid: 'agent#1', publicKey: nextKey.publicKey }),
    /duplicate kid/,
  )
  assert.throws(
    () => ring.rotate('missing', { kid: 'agent#2', publicKey: nextKey.publicKey }),
    /unknown key/,
  )
  assert.equal(ring.record('agent#1')?.status, 'active')
  assert.equal(ring.record('agent#2'), undefined)
})

await test('revocation wins over overlap, history and later rotation', () => {
  const now = '2026-10-24T12:00:00.000Z'
  const ring = new Keyring({ now: () => now })
  ring.add(recordOf('agent#1', oldKey.publicKey, { validFrom: '2026-10-20T00:00:00.000Z' }))
  ring.rotate('agent#1', {
    kid: 'agent#2',
    publicKey: nextKey.publicKey,
    overlapMs: 3_600_000,
  })
  assert.equal(ring.get('agent#1', '2026-10-24T12:30:00.000Z'), oldKey.publicKey)
  assert.equal(ring.revoke('agent#1', '2026-10-24T12:10:00.000Z', 'key compromise'), true)
  assert.equal(ring.isRevoked('agent#1'), true)
  assert.equal(ring.get('agent#1', '2026-10-24T12:30:00.000Z'), undefined)
  assert.equal(ring.get('agent#1', '2026-10-21T00:00:00.000Z'), undefined)
  assert.equal(ring.get('agent#2', '2026-10-24T12:30:00.000Z'), nextKey.publicKey)
  assert.equal(ring.record('agent#1')?.status, 'revoked')
  assert.equal(ring.revoke('agent#1'), false)
  assert.equal(ring.revoke('missing'), false)
  assert.equal(ring.retire('agent#1'), false)
  assert.throws(
    () => ring.rotate('agent#1', { kid: 'agent#3', publicKey: spareKey.publicKey }),
    /revoked/,
  )
  assert.throws(() => ring.add(recordOf('agent#1', oldKey.publicKey)), /duplicate kid/)
  assert.deepEqual(ring.revocations().map((entry) => entry.kid), ['agent#1'])
  assert.equal(ring.revocations()[0]?.reason, 'key compromise')
})

await test('retire limits the key to timestamps before the retirement instant', () => {
  let now = '2026-10-24T09:00:00.000Z'
  const ring = new Keyring({ now: () => now })
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T08:00:00.000Z',
      validTo: '2026-10-24T12:00:00.000Z',
    }),
  )
  assert.equal(ring.retire('agent#1', '2026-10-24T10:00:00.000Z'), true)
  assert.equal(ring.record('agent#1')?.status, 'retired')
  assert.equal(ring.record('agent#1')?.validTo, '2026-10-24T10:00:00.000Z')
  assert.equal(ring.get('agent#1', '2026-10-24T09:59:59.999Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T10:00:00.000Z'), oldKey.publicKey)
  assert.equal(ring.get('agent#1', '2026-10-24T10:00:00.001Z'), undefined)
  assert.equal(ring.active('2026-10-24T09:00:00.000Z').length, 0)
  now = '2026-10-24T10:30:00.000Z'
  assert.equal(ring.get('agent#1'), undefined)
  assert.equal(ring.retire('agent#1'), false)
  assert.equal(ring.retire('missing'), false)
})

await test('verifyWindow explains missing, early, expired and revoked keys', () => {
  const ring = new Keyring({ now: () => '2026-10-24T10:30:00.000Z' })
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T10:00:00.000Z',
      validTo: '2026-10-24T11:00:00.000Z',
    }),
  )
  const missing = ring.verifyWindow('missing', '2026-10-24T10:30:00.000Z')
  assert.equal(missing.ok, false)
  assert.ok(missing.reasons.some((reason) => reason.includes('missing')))
  const early = ring.verifyWindow('agent#1', '2026-10-24T09:59:59.999Z')
  assert.equal(early.ok, false)
  assert.ok(early.reasons.some((reason) => reason.includes('not yet valid')))
  assert.deepEqual(ring.verifyWindow('agent#1', '2026-10-24T10:30:00.000Z'), {
    ok: true,
    reasons: [],
  })
  const late = ring.verifyWindow('agent#1', '2026-10-24T11:00:00.001Z')
  assert.equal(late.ok, false)
  assert.ok(late.reasons.some((reason) => reason.includes('expired')))
  ring.revoke('agent#1', '2026-10-24T10:30:00.000Z')
  const revoked = ring.verifyWindow('agent#1', '2026-10-24T10:30:00.000Z')
  assert.equal(revoked.ok, false)
  assert.ok(revoked.reasons.some((reason) => reason.includes('revoked')))
})

await test('a record added as revoked is retained for audit and never usable', () => {
  const ring = new Keyring({ now: () => '2026-10-24T11:00:00.000Z' })
  ring.add(
    recordOf('agent#9', spareKey.publicKey, {
      status: 'revoked',
      validFrom: '2026-10-24T10:00:00.000Z',
      note: 'imported revocation',
    }),
  )
  assert.equal(ring.get('agent#9'), undefined)
  assert.equal(ring.isRevoked('agent#9'), true)
  assert.equal(ring.record('agent#9')?.status, 'revoked')
  assert.equal(ring.revocations().length, 1)
  assert.equal(ring.revocations()[0]?.revokedAt, '2026-10-24T10:00:00.000Z')
  assert.equal(ring.revocations()[0]?.reason, 'imported revocation')
})

await test('revocation freshness accepts a current list', () => {
  assert.equal(isRevocationFresh(freshList(), '2026-10-24T11:00:00.000Z', 0), true)
  assert.equal(
    isRevocationFresh(
      freshList({ nextUpdate: '2026-10-24T11:00:00.000Z' }),
      '2026-10-24T11:00:00.000Z',
      0,
    ),
    true,
  )
  assert.equal(isRevocationFresh(freshList(), '2026-10-24T12:00:01.000Z', 1_000), true)
})

await test('revocation freshness rejects stale and future-issued lists', () => {
  assert.equal(isRevocationFresh(freshList(), '2026-10-24T12:00:00.001Z', 0), false)
  assert.equal(isRevocationFresh(freshList(), '2026-10-24T12:00:01.001Z', 1_000), false)
  assert.equal(
    isRevocationFresh(
      freshList({ issued: '2026-10-24T11:00:00.001Z' }),
      '2026-10-24T11:00:00.000Z',
      0,
    ),
    false,
  )
  assert.equal(
    isRevocationFresh(
      freshList({
        issued: '2026-10-24T12:00:00.000Z',
        nextUpdate: '2026-10-24T11:00:00.000Z',
      }),
      '2026-10-24T10:00:00.000Z',
      0,
    ),
    false,
  )
})

await test('revocation freshness fails closed on malformed dates', () => {
  const now = '2026-10-24T11:00:00.000Z'
  assert.equal(isRevocationFresh(freshList({ issued: 'not-a-date' }), now, 0), false)
  assert.equal(isRevocationFresh(freshList({ nextUpdate: 'not-a-date' }), now, 0), false)
  assert.equal(
    isRevocationFresh(
      freshList({ revoked: [{ kid: 'agent#0', revokedAt: 'not-a-date' }] }),
      now,
      0,
    ),
    false,
  )
  assert.equal(isRevocationFresh(freshList(), 'not-a-date', 0), false)
  assert.equal(isRevocationFresh(freshList(), now, Number.NaN), false)
  assert.equal(isRevocationFresh(freshList(), now, -1), false)
})

await test('requireFresh returns a fresh list and throws RevocationError otherwise', () => {
  const fresh = freshList()
  assert.equal(requireFresh(fresh, '2026-10-24T11:00:00.000Z', 0), fresh)
  assert.throws(
    () => requireFresh(fresh, '2026-10-24T13:00:00.000Z', 0),
    (error: unknown) => {
      assert.ok(error instanceof RevocationError)
      assert.ok(error.reasons.some((reason) => reason.includes('stale')))
      return true
    },
  )
})

await test('mergeRevocations unions kids and keeps the earliest revocation', () => {
  const merged = mergeRevocations(localRevocations, remoteRevocations)
  assert.equal(merged.issuer, 'org.acme')
  assert.equal(merged.issued, remoteRevocations.issued)
  assert.equal(merged.nextUpdate, remoteRevocations.nextUpdate)
  assert.deepEqual(
    merged.revoked.map((entry) => entry.kid),
    ['agent#1', 'agent#2', 'agent#3'],
  )
  const second = merged.revoked.find((entry) => entry.kid === 'agent#2')
  assert.equal(second?.revokedAt, '2026-10-24T08:30:00.000Z')
  assert.equal(second?.reason, 'remote')
  assert.equal(localRevocations.revoked.length, 2)
  assert.equal(remoteRevocations.revoked.length, 2)
})

await test('mergeRevocations is order-independent and idempotent', () => {
  const forward = mergeRevocations(localRevocations, remoteRevocations)
  const reverse = mergeRevocations(remoteRevocations, localRevocations)
  assert.deepEqual(forward, reverse)
  assert.deepEqual(mergeRevocations(forward, remoteRevocations), forward)
  assert.deepEqual(mergeRevocations(forward, localRevocations), forward)
  const tiedLocal = freshList({
    revoked: [{ kid: 'agent#5', revokedAt: '2026-10-24T09:00:00.000Z' }],
  })
  const tiedRemote = freshList({
    revoked: [
      { kid: 'agent#5', revokedAt: '2026-10-24T09:00:00.000Z', reason: 'evidence' },
    ],
  })
  assert.deepEqual(mergeRevocations(tiedLocal, tiedRemote), mergeRevocations(tiedRemote, tiedLocal))
  assert.equal(mergeRevocations(tiedLocal, tiedRemote).revoked[0]?.reason, 'evidence')
})

await test('mergeRevocations refuses lists from different issuers', () => {
  assert.throws(
    () => mergeRevocations(localRevocations, { ...remoteRevocations, issuer: 'org.evil' }),
    /different issuers/,
  )
})

await test('mergeRevocations fails closed on malformed timestamps', () => {
  assert.throws(
    () => mergeRevocations({ ...localRevocations, issued: 'not-a-date' }, remoteRevocations),
    /issued/,
  )
  assert.throws(
    () =>
      mergeRevocations(
        { ...localRevocations, revoked: [{ kid: 'bad', revokedAt: 'not-a-date' }] },
        remoteRevocations,
      ),
    /revokedAt/,
  )
  assert.throws(
    () =>
      mergeRevocations(
        { ...localRevocations, revoked: [{ kid: 'only', revokedAt: 'not-a-date' }] },
        { ...remoteRevocations, revoked: [] },
      ),
    /revokedAt/,
  )
})

await test('checkManifestWindow accepts a live manifest window', () => {
  const window = {
    issued: '2026-10-24T10:00:00.000Z',
    expires: '2026-10-24T12:00:00.000Z',
  }
  assert.deepEqual(checkManifestWindow(window, '2026-10-24T11:00:00.000Z', 0), {
    ok: true,
    reasons: [],
  })
  assert.deepEqual(checkManifestWindow(window, '2026-10-24T10:00:00.000Z', 0), {
    ok: true,
    reasons: [],
  })
  assert.deepEqual(checkManifestWindow(window, '2026-10-24T12:00:00.000Z', 0), {
    ok: true,
    reasons: [],
  })
})

await test('checkManifestWindow rejects expired and future-issued manifests', () => {
  const window = {
    issued: '2026-10-24T10:00:00.000Z',
    expires: '2026-10-24T12:00:00.000Z',
  }
  const expired = checkManifestWindow(window, '2026-10-24T12:00:00.001Z', 0)
  assert.equal(expired.ok, false)
  assert.ok(expired.reasons.some((reason) => reason.includes('expired')))
  const future = checkManifestWindow(window, '2026-10-24T09:00:00.000Z', 0)
  assert.equal(future.ok, false)
  assert.ok(future.reasons.some((reason) => reason.includes('future')))
})

await test('checkManifestWindow honors explicit and default clock skew', () => {
  const window = {
    issued: '2026-10-24T10:00:00.000Z',
    expires: '2026-10-24T12:00:00.000Z',
  }
  assert.equal(checkManifestWindow(window, '2026-10-24T12:00:30.000Z', 60_000).ok, true)
  assert.equal(checkManifestWindow(window, '2026-10-24T12:01:01.000Z', 60_000).ok, false)
  assert.equal(checkManifestWindow(window, '2026-10-24T09:59:30.000Z', 60_000).ok, true)
  assert.equal(checkManifestWindow(window, '2026-10-24T09:58:59.000Z', 60_000).ok, false)
  assert.equal(checkManifestWindow(window, '2026-10-24T12:04:00.000Z').ok, true)
  assert.equal(checkManifestWindow(window, '2026-10-24T12:05:00.001Z').ok, false)
})

await test('checkManifestWindow rejects inverted and malformed windows', () => {
  const inverted = checkManifestWindow(
    { issued: '2026-10-24T12:00:00.000Z', expires: '2026-10-24T12:00:00.000Z' },
    '2026-10-24T11:00:00.000Z',
    0,
  )
  assert.equal(inverted.ok, false)
  assert.ok(inverted.reasons.some((reason) => reason.includes('after issued')))
  const badIssued = checkManifestWindow(
    { issued: 'not-a-date', expires: '2026-10-24T12:00:00.000Z' },
    '2026-10-24T11:00:00.000Z',
    0,
  )
  assert.equal(badIssued.ok, false)
  assert.ok(badIssued.reasons.some((reason) => reason.includes('issued')))
  const badExpires = checkManifestWindow(
    { issued: '2026-10-24T10:00:00.000Z', expires: 'not-a-date' },
    '2026-10-24T11:00:00.000Z',
    0,
  )
  assert.equal(badExpires.ok, false)
  assert.ok(badExpires.reasons.some((reason) => reason.includes('expires')))
  assert.equal(
    checkManifestWindow(
      { issued: '2026-10-24T10:00:00.000Z', expires: '2026-10-24T12:00:00.000Z' },
      'not-a-date',
      0,
    ).ok,
    false,
  )
  assert.equal(
    checkManifestWindow(
      { issued: '2026-10-24T10:00:00.000Z', expires: '2026-10-24T12:00:00.000Z' },
      '2026-10-24T11:00:00.000Z',
      -1,
    ).ok,
    false,
  )
})

await test('keyring works with WebCrypto keys only', async () => {
  const ring = new Keyring({ now: () => '2026-10-24T10:30:00.000Z' })
  ring.add(
    recordOf('agent#1', oldKey.publicKey, {
      validFrom: '2026-10-24T10:00:00.000Z',
      validTo: '2026-10-24T11:00:00.000Z',
    }),
  )
  const publicKey = ring.get('agent#1')
  if (!publicKey) throw new Error('expected a public key')
  const payload = new TextEncoder().encode('browser-compatible')
  const signature = await crypto.subtle.sign('Ed25519', oldKey.privateKey, payload)
  assert.equal(await crypto.subtle.verify('Ed25519', publicKey, signature, payload), true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
