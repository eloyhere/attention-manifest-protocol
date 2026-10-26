#!/usr/bin/env node
/** Federation checks F1–F8: export/import, tamper, revocation, expiry, endorsement. */
import assert from 'node:assert/strict'

import { digestOf } from '../src/semantic/canonical.ts'
import { attest, exportBundle, importBundle } from '../src/manifest/federation.ts'
import { generateSigningKey, KeyRegistry, signManifest } from '../src/manifest/sign.ts'
import type { Manifest } from '../src/types/index.ts'

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

function unsignedManifest(): Omit<Manifest, 'signatures' | 'digest'> {
  return {
    amp: '0.1',
    kind: 'manifest',
    agent: { id: 'a.gamma', name: 'Gamma', version: '0.1.0', role: 'analyst' },
    issued: '2026-10-24T07:00:00Z',
    expires: '2026-10-25T07:00:00Z',
    capabilities: [{ id: 'logs.query', kind: 'tool', confidence: 0.9, tier: 'T2' }],
    attention: { policy_digest: 'sha256:' + '0'.repeat(64), budget: { tokens: 24000 } },
    self: { calibration: { ece: 0.1, buckets: [] }, limits: [], state: { load: 0.4, mode: 'exploit' } },
  }
}

const NOW = '2026-10-24T09:00:00Z'
const key = await generateSigningKey('a.gamma#1')
const manifest = await signManifest(unsignedManifest(), key)
const window = { issued: '2026-10-24T07:00:00Z', expires: '2026-10-26T07:00:00Z' }

await test('F1 export then import succeeds', async () => {
  const bundle = await exportBundle(manifest, key, window)
  const result = await importBundle(bundle, { now: NOW })
  assert.equal(result.ok, true, result.reasons.join('; '))
  assert.equal(result.manifest?.digest, manifest.digest)
  assert.equal(result.attested, false)
})

await test('F2 tampered keys fail the bundle digest', async () => {
  const bundle = await exportBundle(manifest, key, window)
  const tampered = { ...bundle, keys: [{ ...bundle.keys[0], publicKey: 'AAAA' }] }
  const result = await importBundle(tampered, { now: NOW })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((r) => r.includes('digest')))
})

await test('F3 tampered manifest fails the signature even with a rebuilt digest', async () => {
  const bundle = await exportBundle(manifest, key, window)
  const tamperedManifest = { ...bundle.manifest, agent: { ...bundle.manifest.agent, role: 'admin' } }
  const rest = { ...bundle, manifest: tamperedManifest }
  const forged = { ...rest, digest: digestOf({ manifest: tamperedManifest, keys: rest.keys, revoked: rest.revoked, issued: rest.issued, expires: rest.expires }) }
  const result = await importBundle(forged, { now: NOW })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((r) => r.includes('signature') || r.includes('digest')))
})

await test('F4 revoked keys fail even with a valid signature', async () => {
  const bundle = await exportBundle(manifest, key, { ...window, revoked: [key.kid] })
  const result = await importBundle(bundle, { now: NOW })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((r) => r.includes('revoked')))

  const local = await exportBundle(manifest, key, window)
  const localResult = await importBundle(local, { now: NOW, revoked: [key.kid] })
  assert.equal(localResult.ok, false)
})

await test('F5 expired bundles fail', async () => {
  const bundle = await exportBundle(manifest, key, { ...window, expires: '2026-10-24T08:00:00Z' })
  const result = await importBundle(bundle, { now: NOW })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((r) => r.includes('expired')))
})

await test('F6 attestation must bind the digest and verify with a trusted issuer key', async () => {
  const org = await generateSigningKey('org.acme#1')
  const issuerKeys = new KeyRegistry()
  issuerKeys.add(org.kid, org.publicKey)
  const good = await attest({
    id: 'at.1', issuer: { kind: 'org', id: 'org.acme' }, manifest, scope: ['reviewed'],
    issued: window.issued, expires: window.expires, key: org,
  })
  const accepts = await importBundle(await exportBundle(manifest, key, { ...window, attestations: [good] }), {
    now: NOW,
    issuerKeys,
  })
  assert.equal(accepts.attested, true)

  const noTrust = await importBundle(await exportBundle(manifest, key, { ...window, attestations: [good] }), { now: NOW })
  assert.equal(noTrust.attested, false, 'bundle content is not an issuer trust root')

  const wrong = await attest({
    id: 'at.2', issuer: { kind: 'org', id: 'org.acme' },
    manifest: { ...manifest, digest: 'sha256:' + '1'.repeat(64) },
    scope: ['reviewed'], issued: window.issued, expires: window.expires, key: org,
  })
  const rejects = await importBundle(await exportBundle(manifest, key, { ...window, attestations: [wrong] }), {
    now: NOW,
    issuerKeys,
  })
  assert.equal(rejects.attested, false)
  assert.equal(rejects.ok, true, 'missing endorsement must not invalidate verification')

  const impostor = await generateSigningKey('org.acme#evil')
  const forged = await attest({
    id: 'at.3', issuer: { kind: 'org', id: 'org.acme' }, manifest, scope: ['reviewed'],
    issued: window.issued, expires: window.expires, key: impostor,
  })
  const forgedResult = await importBundle(await exportBundle(manifest, key, { ...window, attestations: [forged] }), {
    now: NOW,
    issuerKeys,
  })
  assert.equal(forgedResult.attested, false, 'an attestation signed by the wrong key must not endorse')
})

await test('F7 missing key is reported specifically', async () => {
  const bundle = await exportBundle(manifest, key, window)
  const stripped = { ...bundle, keys: [] }
  const result = await importBundle(stripped, { now: NOW })
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((r) => r.includes('missing key')))
})

await test('F8 importing the same bundle twice is idempotent', async () => {
  const bundle = await exportBundle(manifest, key, window)
  const first = await importBundle(bundle, { now: NOW })
  const second = await importBundle(bundle, { now: NOW })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.manifest?.digest, second.manifest?.digest)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
