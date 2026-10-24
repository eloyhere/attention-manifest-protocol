#!/usr/bin/env node
/** Retry behaviour: safe because the same idempotency key is reused. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { listen } from './_helpers.ts'

import { digestOf } from '../src/runtime/canonical.ts'
import { delegateOver } from '../src/runtime/channel.ts'
import { HttpTeamChannel } from '../src/runtime/http-channel.ts'
import { TeamRuntime } from '../src/runtime/team.ts'

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

const goal = 'sha256:' + 'a'.repeat(64)
const delegation = () =>
  new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' }).createDelegation({
    granter: 'a.lead', delegatee: 'a.worker', goalDigest: goal, scope: [],
    budget: { tokens: 10 }, deadline: '2026-10-24T12:00:00Z', mayRedelegate: false, depth: 0,
  })

let failuresLeft = 2
const keys = []
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    keys.push(req.headers['idempotency-key'])
    if (failuresLeft > 0) {
      failuresLeft -= 1
      res.writeHead(503)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ accepted: true }))
  })
})
const port = await listen(server)
const url = `http://127.0.0.1:${port}/delegate`

await test('retries 5xx then succeeds with the same key', async () => {
  const channel = new HttpTeamChannel({ url, retries: 3, backoffMs: 5 })
  await delegateOver(channel, delegation())
  assert.equal(channel.attempts, 3)
  assert.equal(new Set(keys).size, 1)
  assert.equal(keys[0], digestOf(channel.sent[0].envelope.delegation))
})

await test('exhausted retries fail closed', async () => {
  failuresLeft = 5
  const channel = new HttpTeamChannel({ url, retries: 1, backoffMs: 5 })
  await assert.rejects(() => delegateOver(channel, delegation()), /HTTP 503/)
  assert.equal(channel.attempts, 2)
  failuresLeft = 0
})

server.close()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1


