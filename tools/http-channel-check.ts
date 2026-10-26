#!/usr/bin/env node
/** HTTP channel: real local round trip, idempotency key, timeout, rejection. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { digestOf } from '../src/semantic/canonical.ts'
import { delegateOver } from '../src/protocol/channel.ts'
import { HttpTeamChannel } from '../src/protocol/httpChannel.ts'
import { TeamRuntime } from '../src/delegate/team.ts'
import { listen, portOf } from './_helpers.ts'

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
function delegation(budget = { tokens: 100 }) {
  return new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' }).createDelegation({
    granter: 'a.lead',
    delegatee: 'a.worker',
    goalDigest: goal,
    scope: ['tool.logs.query'],
    budget,
    deadline: '2026-10-24T12:00:00Z',
    mayRedelegate: false,
    depth: 0,
  })
}

const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const envelope = JSON.parse(body || '{}')
    seen.push({ key: req.headers['idempotency-key'], envelope })
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: true }))
      }, 200)
      return
    }
    const tooWide = (envelope.delegation?.budget?.tokens ?? 0) > 50
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(tooWide ? { accepted: false, reason: 'peer ceiling' } : { accepted: true }))
  })
})

await listen(server)
const port = portOf(server)
const url = `http://127.0.0.1:${port}/delegate`

await test('accepted delegation crosses HTTP with an idempotency key', async () => {
  const channel = new HttpTeamChannel({ url })
  const doc = await delegateOver(channel, delegation({ tokens: 40 }))
  assert.equal(doc.goal_digest, goal)
  assert.equal(seen.at(-1).key, digestOf(doc))
  assert.equal(seen.at(-1).envelope.kind, 'delegation-envelope')
})

await test('peer rejection is surfaced as a reason', async () => {
  const channel = new HttpTeamChannel({ url })
  await assert.rejects(() => delegateOver(channel, delegation({ tokens: 100 })), /peer ceiling/)
})

await test('timeout fails closed instead of hanging', async () => {
  const channel = new HttpTeamChannel({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 50 })
  await assert.rejects(() => delegateOver(channel, delegation({ tokens: 10 })), /timeout/)
})

await test('HTTP error status fails closed', async () => {
  const channel = new HttpTeamChannel({ url: `http://127.0.0.1:${port}/missing` })
  const server404 = createServer((_req, res) => {
    res.writeHead(503)
    res.end()
  })
  await listen(server404)
  const failing = new HttpTeamChannel({ url: `http://127.0.0.1:${portOf(server404)}/x` })
  void channel
  await assert.rejects(() => delegateOver(failing, delegation({ tokens: 10 })), /HTTP 503/)
  await new Promise((resolve) => server404.close(resolve))
})

server.close()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
