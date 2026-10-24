#!/usr/bin/env node
/** Closed loop: discover an Agent Card, then send a real A2A delegation to it. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { channelFromCard } from '../src/runtime/a2a.ts'
import { fetchAgentCard } from '../src/runtime/agent-card.ts'
import { delegateOver } from '../src/runtime/channel.ts'
import { TeamRuntime } from '../src/runtime/team.ts'

const calls = []
let port = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        name: 'worker-agent',
        supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a`, protocolBinding: 'JSONRPC' }],
      }))
      return
    }
    const request = JSON.parse(body)
    calls.push(request)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'task', id: 'task-7', status: { state: 'submitted' } } }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
port = server.address().port

const goal = 'sha256:' + 'a'.repeat(64)
const card = await fetchAgentCard(`http://127.0.0.1:${port}`)
assert.equal(card.ok, true, card.reasons.join('; '))

const channel = channelFromCard(card)
const delegation = new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' }).createDelegation({
  granter: 'a.lead', delegatee: 'a.worker', goalDigest: goal, scope: [],
  budget: { tokens: 10 }, deadline: '2026-10-24T12:00:00Z', mayRedelegate: false, depth: 0,
})
await delegateOver(channel, delegation)

assert.equal(calls.length, 1)
assert.equal(calls[0].method, 'message/send')
assert.equal(calls[0].params.message.metadata['io.amp/version'], '0.1')

await new Promise((resolve) => server.close(resolve))
console.log('✓ discover → channelFromCard → message/send accepted')
