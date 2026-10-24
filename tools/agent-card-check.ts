#!/usr/bin/env node
/** Agent Card discovery: well-known path, shape validation, endpoint selection. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { fetchAgentCard } from '../src/runtime/agent-card.ts'
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

let mode = 'ok'
const server = createServer((req, res) => {
  if (req.url !== '/.well-known/agent-card.json') {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  if (mode === 'invalid') {
    res.end(JSON.stringify({ description: 'nameless' }))
    return
  }
  res.end(
    JSON.stringify({
      name: 'demo-agent',
      version: '1.0.0',
      supportedInterfaces: [{ url: 'http://127.0.0.1:9999/a2a', protocolBinding: 'JSONRPC' }],
      capabilities: { streaming: false },
      skills: [{ id: 'analyze' }],
    }),
  )
})
await listen(server)
const base = `http://127.0.0.1:${portOf(server)}`

await test('valid card is discovered at the well-known path', async () => {
  mode = 'ok'
  const result = await fetchAgentCard(base)
  assert.equal(result.ok, true, result.reasons.join('; '))
  assert.equal(result.card?.name, 'demo-agent')
  assert.equal(result.endpoint, 'http://127.0.0.1:9999/a2a')
})

await test('card without a name is rejected', async () => {
  mode = 'invalid'
  const result = await fetchAgentCard(base)
  assert.equal(result.ok, false)
  assert.ok(result.reasons.some((reason) => reason.includes('name')))
})

await test('missing card returns the HTTP status', async () => {
  const result = await fetchAgentCard('http://127.0.0.1:1')
  assert.equal(result.ok, false)
  assert.ok(result.reasons.length > 0)
})

server.close()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
