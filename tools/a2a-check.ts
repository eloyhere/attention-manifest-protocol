#!/usr/bin/env node
/** A2A v1.0 binding: request shape, task acceptance, RPC error handling. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { toA2ARequest, A2AChannel } from '../src/protocol/a2a.ts'
import { delegateOver } from '../src/protocol/channel.ts'
import { digestOf } from '../src/semantic/canonical.ts'
import { TeamRuntime } from '../src/delegate/team.ts'
import { toDelegationDoc } from '../src/protocol/wire.ts'
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
const delegation = () =>
  new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' }).createDelegation({
    granter: 'a.lead', delegatee: 'a.worker', goalDigest: goal, scope: [],
    budget: { tokens: 10 }, deadline: '2026-10-24T12:00:00Z', mayRedelegate: false, depth: 0,
  })

const received = []
let mode = 'task'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    const request = JSON.parse(body)
    received.push({ request, version: req.headers['a2a-version'] })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (mode === 'error') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'Task not found' } }))
    } else if (mode === 'task') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'task', id: 'task-1', status: { state: 'submitted' } } }))
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { kind: 'message', messageId: 'm-1', role: 'agent', parts: [] } }))
    }
  })
})
await listen(server)
const url = `http://127.0.0.1:${portOf(server)}/a2a`

await test('request is a real A2A message/send envelope', () => {
  const doc = toDelegationDoc(delegation())
  const request = toA2ARequest(doc)
  assert.equal(request.method, 'message/send')
  assert.equal(request.params.message.kind, 'message')
  assert.equal(request.params.message.role, 'user')
  assert.equal(request.params.message.parts.length, 2)
  assert.equal(request.params.message.parts[1].kind, 'data')
  assert.equal(request.params.message.metadata['io.amp/delegation_digest'], digestOf(doc))
})

await test('task result means accepted, with the A2A state surfaced', async () => {
  mode = 'task'
  const channel = new A2AChannel({ url })
  await delegateOver(channel, delegation())
  const last = received.at(-1)
  assert.equal(last.request.method, 'message/send')
  assert.equal(last.version, '1.0')
})

await test('agent message result is also accepted', async () => {
  mode = 'message'
  const channel = new A2AChannel({ url })
  await delegateOver(channel, delegation())
  assert.equal(channel.requests.length, 1)
})

await test('JSON-RPC error fails closed with the code', async () => {
  mode = 'error'
  const channel = new A2AChannel({ url })
  await assert.rejects(() => delegateOver(channel, delegation()), /A2A -32001/)
})

server.close()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
