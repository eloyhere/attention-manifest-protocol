#!/usr/bin/env node
/** Card trust: signature resolved through a registry, not the card itself. */
import assert from 'node:assert/strict'

import { signCard, verifyCardWithRegistry } from '../src/runtime/card-sign.ts'
import { generateSigningKey, KeyRegistry } from '../src/runtime/sign.ts'

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

const card = () => ({
  name: 'worker-agent',
  supportedInterfaces: [{ url: 'https://worker.example/a2a' }],
})

await test('registered key verifies the card', async () => {
  const key = await generateSigningKey('worker#1')
  const signature = await signCard(card(), key)
  const registry = new KeyRegistry()
  registry.add(key.kid, key.publicKey)
  const result = await verifyCardWithRegistry(card(), signature, registry)
  assert.equal(result.ok, true, result.reasons.join('; '))
})

await test('unknown kid is rejected before verification', async () => {
  const key = await generateSigningKey('worker#1')
  const signature = await signCard(card(), key)
  const result = await verifyCardWithRegistry(card(), signature, new KeyRegistry())
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('unknown or revoked')))
})

await test('revoked kid is rejected even with a valid signature', async () => {
  const key = await generateSigningKey('worker#1')
  const signature = await signCard(card(), key)
  const registry = new KeyRegistry()
  registry.add(key.kid, key.publicKey)
  registry.revoke(key.kid)
  assert.equal((await verifyCardWithRegistry(card(), signature, registry)).ok, false)
})

await test('a card signed by a different key fails even if that key is trusted', async () => {
  const signer = await generateSigningKey('worker#1')
  const impostor = await generateSigningKey('worker#2')
  const signature = await signCard(card(), signer)
  const registry = new KeyRegistry()
  registry.add(impostor.kid, impostor.publicKey)
  assert.equal((await verifyCardWithRegistry(card(), signature, registry)).ok, false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
