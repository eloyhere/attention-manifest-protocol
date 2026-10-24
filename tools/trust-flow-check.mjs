#!/usr/bin/env node
/** Cross-domain: domain A's bundle endorses domain B's card, then B accepts a delegation. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { channelFromCard } from '../src/runtime/a2a.ts'
import { signCard } from '../src/runtime/card-sign.ts'
import { delegateOver } from '../src/runtime/channel.ts'
import { attest, exportBundle } from '../src/runtime/federation.ts'
import { generateSigningKey, KeyRegistry, signManifest } from '../src/runtime/sign.ts'
import { fetchTrustedAgent } from '../src/runtime/trust.ts'
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

// Domain B: the worker agent, its card and its A2A endpoint.
const workerKey = await generateSigningKey('worker#1')
let port = 0
const calls = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', async () => {
    if (req.url === '/.well-known/agent-card.json') {
      const card = { name: 'worker-agent', supportedInterfaces: [{ url: `http://127.0.0.1:${port}/a2a` }] }
      const signature = await signCard(card, workerKey)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...card, signatures: [signature] }))
      return
    }
    calls.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { kind: 'task', id: 'task-1', status: { state: 'submitted' } } }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
port = server.address().port
const domainB = `http://127.0.0.1:${port}`

// Domain A: the worker's own organization signs a manifest and endorses it.
const manifest = await signManifest(
  {
    amp: '0.1', kind: 'manifest', agent: { id: 'a.worker' },
    issued: '2026-10-24T07:00:00Z', expires: '2026-10-25T07:00:00Z',
    capabilities: [{ id: 'tool.logs.query', kind: 'tool', confidence: 0.9, tier: 'T2' }],
    attention: { policy_digest: 'sha256:' + '0'.repeat(64), budget: { tokens: 1000 } },
    self: { calibration: { ece: 0.1, buckets: [] } },
  },
  workerKey,
)
const orgKey = await generateSigningKey('org.acme#1')
const attestation = await attest({
  id: 'at.1', issuer: { kind: 'org', id: 'org.acme' }, manifest,
  scope: ['reviewed', 'tool.logs.query'],
  issued: '2026-10-24T07:05:00Z', expires: '2027-01-24T07:05:00Z', key: orgKey,
})
const window = { issued: '2026-10-24T07:00:00Z', expires: '2026-10-26T07:00:00Z' }
const bundle = await exportBundle(manifest, workerKey, { ...window, attestations: [attestation] })

const issuerKeys = new KeyRegistry()
issuerKeys.add(orgKey.kid, orgKey.publicKey)

await test('discovery + policy accept the endorsed card', async () => {
  const trusted = await fetchTrustedAgent(domainB, {
    bundle, policy: { requiredScopes: ['reviewed'] }, issuerKeys,
  })
  assert.equal(trusted.ok, true, trusted.reasons.join('; '))
  assert.equal(trusted.endpoint, `http://127.0.0.1:${port}/a2a`)
  assert.ok(trusted.scopes.includes('reviewed'))
})

await test('delegation flows to the discovered endpoint over A2A', async () => {
  const trusted = await fetchTrustedAgent(domainB, {
    bundle, policy: { requiredScopes: ['reviewed'] }, issuerKeys,
  })
  const channel = channelFromCard(trusted)
  const delegation = new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' }).createDelegation({
    granter: 'a.lead', delegatee: 'a.worker', goalDigest: 'sha256:' + 'a'.repeat(64),
    scope: [], budget: { tokens: 10 }, deadline: '2026-10-24T12:00:00Z',
    mayRedelegate: false, depth: 0,
  })
  await delegateOver(channel, delegation)
  assert.equal(calls.at(-1).method, 'message/send')
})

await test('a missing scope fails the policy gate', async () => {
  const trusted = await fetchTrustedAgent(domainB, {
    bundle, policy: { requiredScopes: ['admin'] }, issuerKeys,
  })
  assert.equal(trusted.ok, false)
  assert.ok(trusted.reasons.some((reason) => reason.includes('missing required scope: admin')))
})

await test('an untrusted issuer key is rejected, not silently ignored', async () => {
  const trusted = await fetchTrustedAgent(domainB, {
    bundle, policy: { requiredScopes: ['reviewed'] }, issuerKeys: new KeyRegistry(),
  })
  assert.equal(trusted.ok, false)
  assert.ok(trusted.reasons.some((reason) => reason.includes('unknown issuer key')))
})

server.close()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
