#!/usr/bin/env node
/** Signature checks: digest coverage, tamper detection, key revocation. */
import assert from 'node:assert/strict'

import {
  generateSigningKey,
  KeyRegistry,
  signManifest,
  verifyManifest,
  verifyWithRegistry,
} from '../src/manifest/sign.ts'
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
    attention: {
      policy_digest: 'sha256:' + '0'.repeat(64),
      budget: { tokens: 24000 },
    },
    self: { calibration: { ece: 0.1, buckets: [] }, limits: [], state: { load: 0.4, mode: 'exploit' } },
  }
}

await test('signed manifest verifies', async () => {
  const key = await generateSigningKey('a.gamma#1')
  const manifest = await signManifest(unsignedManifest(), key)
  assert.ok(manifest.digest.startsWith('sha256:'))
  const result = await verifyManifest(manifest, key.publicKey)
  assert.equal(result.ok, true, result.reasons.join('; '))
})

await test('tampering with an agent field fails the digest check', async () => {
  const key = await generateSigningKey('a.gamma#1')
  const manifest = await signManifest(unsignedManifest(), key)
  const tampered = { ...manifest, agent: { ...manifest.agent, role: 'admin' } }
  const result = await verifyManifest(tampered, key.publicKey)
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('digest')))
})

await test('a different key cannot verify the signature', async () => {
  const signer = await generateSigningKey('a.gamma#1')
  const other = await generateSigningKey('a.gamma#2')
  const manifest = await signManifest(unsignedManifest(), signer)
  const result = await verifyManifest(manifest, other.publicKey)
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('signature')))
})

await test('re-signing picks up a new digest', async () => {
  const key = await generateSigningKey('a.gamma#1')
  const first = await signManifest(unsignedManifest(), key)
  const changed = { ...unsignedManifest(), expires: '2026-10-26T07:00:00Z' }
  const second = await signManifest(changed, key)
  assert.notEqual(first.digest, second.digest)
  assert.equal((await verifyManifest(second, key.publicKey)).ok, true)
})

await test('revoked keys stop verifying', async () => {
  const key = await generateSigningKey('a.gamma#1')
  const registry = new KeyRegistry()
  registry.add(key.kid, key.publicKey)
  const manifest = await signManifest(unsignedManifest(), key)
  assert.equal((await verifyWithRegistry(manifest, registry)).ok, true)

  registry.revoke(key.kid)
  const after = await verifyWithRegistry(manifest, registry)
  assert.equal(after.ok, false)
  assert.ok(after.reasons.some((reason) => reason.includes('revoked')))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
