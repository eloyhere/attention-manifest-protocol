#!/usr/bin/env node
/** Bundle → trust registry → card verification. */
import assert from 'node:assert/strict'

import { signCard, verifyCardWithRegistry } from '../src/runtime/card-sign.ts'
import { exportBundle, registryFromBundle } from '../src/runtime/federation.ts'
import { generateSigningKey, signManifest } from '../src/runtime/sign.ts'

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

const key = await generateSigningKey('worker#1')
const manifest = await signManifest(
  {
    amp: '0.1',
    kind: 'manifest',
    agent: { id: 'a.worker' },
    issued: '2026-10-24T07:00:00Z',
    expires: '2026-10-25T07:00:00Z',
    capabilities: [{ id: 'tool.x', kind: 'tool', confidence: 0.9, tier: 'T2' }],
    attention: { policy_digest: 'sha256:' + '0'.repeat(64), budget: { tokens: 1000 } },
    self: { calibration: { ece: 0.1, buckets: [] } },
  },
  key,
)
const window = { issued: '2026-10-24T07:00:00Z', expires: '2026-10-26T07:00:00Z' }
const card = { name: 'worker-agent', supportedInterfaces: [{ url: 'https://worker.example/a2a' }] }

await test('bundle keys populate the registry and verify a card', async () => {
  const bundle = await exportBundle(manifest, key, window)
  const registry = await registryFromBundle(bundle)
  const signature = await signCard(card, key)
  const result = await verifyCardWithRegistry(card, signature, registry)
  assert.equal(result.ok, true, result.reasons.join('; '))
})

await test('revoked kids in the bundle stay revoked', async () => {
  const bundle = await exportBundle(manifest, key, { ...window, revoked: [key.kid] })
  const registry = await registryFromBundle(bundle)
  assert.equal(registry.get(key.kid), undefined)
})

await test('a bundle without the signing key cannot verify the card', async () => {
  const other = await generateSigningKey('worker#2')
  const bundle = await exportBundle(manifest, other, window)
  const registry = await registryFromBundle(bundle)
  const signature = await signCard(card, key)
  const result = await verifyCardWithRegistry(card, signature, registry)
  assert.equal(result.ok, false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
