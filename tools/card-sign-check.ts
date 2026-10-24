#!/usr/bin/env node
/** Agent Card signatures: sign, verify, tamper, wrong key. */
import assert from 'node:assert/strict'

import { signCard, verifyCardSignature } from '../src/runtime/card-sign.ts'
import { generateSigningKey } from '../src/runtime/sign.ts'

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
  version: '1.0.0',
  supportedInterfaces: [{ url: 'https://worker.example/a2a', protocolBinding: 'JSONRPC' }],
})

await test('signed card verifies', async () => {
  const key = await generateSigningKey('worker#1')
  const signature = await signCard(card(), key)
  const result = await verifyCardSignature(card(), signature, key.publicKey)
  assert.equal(result.ok, true, result.reasons.join('; '))
})

await test('tampering with the endpoint fails', async () => {
  const key = await generateSigningKey('worker#1')
  const signature = await signCard(card(), key)
  const tampered = { ...card(), supportedInterfaces: [{ url: 'https://evil.example/a2a' }] }
  const result = await verifyCardSignature(tampered, signature, key.publicKey)
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('signature')))
})

await test('a different key fails', async () => {
  const signer = await generateSigningKey('worker#1')
  const other = await generateSigningKey('worker#2')
  const signature = await signCard(card(), signer)
  assert.equal((await verifyCardSignature(card(), signature, other.publicKey)).ok, false)
})

await test('malformed protected header is rejected', async () => {
  const key = await generateSigningKey('worker#1')
  const result = await verifyCardSignature(card(), { protected: 'not-base64-json', signature: 'AA' }, key.publicKey)
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('protected')))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
