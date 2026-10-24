#!/usr/bin/env node
/**
 * Exec profile checks: stateless MCP framing, TTL caching, digest pinning,
 * approval policy, budget enforcement and handle shaping.
 */
import assert from 'node:assert/strict'

import { BudgetExceeded } from '../src/runtime/budget.ts'
import { ApprovalRequired, DriftDetected, ExecProfile } from '../src/runtime/exec.ts'
import { HandleStore } from '../src/runtime/handles.ts'
import { McpClient } from '../src/runtime/mcp/client.ts'
import { DemoServer } from '../src/runtime/mcp/server.ts'
import { MemoryTransport } from '../src/runtime/mcp/transport.ts'

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

function setup(options = {}) {
  const server = new DemoServer()
  const transport = new MemoryTransport((request) => server.handle(request))
  const client = new McpClient(transport)
  const handles = new HandleStore()
  const receipts = []
  let tick = 0
  const now = () => new Date(Date.parse('2026-10-24T01:00:00Z') + ++tick * 1000).toISOString()
  const exec = new ExecProfile(client, {
    budget: options.budget ?? { calls: 5, ms: 60_000 },
    handles,
    now,
    maxResultTokens: 1200,
    requireApproval: true,
    onReceipt: (receipt) => receipts.push(receipt),
  })
  return { server, transport, client, handles, receipts, exec }
}

await test('server rejects requests without _meta protocolVersion (-32602)', async () => {
  const { transport } = setup()
  const raw = await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  assert.equal(raw.error?.code, -32602)
})

await test('client sends version and capabilities in _meta', async () => {
  const { transport, client } = setup()
  await client.discover()
  const meta = transport.history[0]?.params?._meta
  assert.equal(meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28')
  assert.ok('io.modelcontextprotocol/clientCapabilities' in meta)
})

await test('connect discovers tools and pins a stable digest', async () => {
  const { exec, receipts } = setup()
  const snapshot = await exec.connect()
  assert.equal(snapshot.tools.length, 3)
  assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(snapshot.ttlMs, 60_000)
  assert.equal(receipts.length, 0)
})

await test('tools/list is cached within ttlMs', async () => {
  const { exec, server } = setup()
  await exec.connect()
  assert.equal(server.listCalls, 1)
  await exec.ensureFresh()
  await exec.ensureFresh()
  assert.equal(server.listCalls, 1)
})

await test('small results stay inline', async () => {
  const { exec, receipts } = setup()
  await exec.connect()
  const out = await exec.call('metrics.query', { metric: '5xx_rate' })
  assert.ok(out.inline?.includes('5xx_rate'))
  assert.equal(out.handle, undefined)
  assert.equal(out.receipt.outcome, 'success')
  assert.equal(out.receipt.usage.calls, 1)
  assert.equal(receipts.length, 1)
})

await test('oversized results become handles, not truncation', async () => {
  const { exec, handles } = setup()
  await exec.connect()
  const out = await exec.call('logs.query', { window: 'post' })
  assert.ok(out.handle, 'expected handle')
  assert.ok(out.tokens > 1200, `expected >1200 tokens, got ${out.tokens}`)
  assert.equal(out.receipt.handle?.id, out.handle)
  const page = handles.read(out.handle, 0, 100)
  assert.ok(page.text.length > 0)
  assert.equal(page.next, 400)
})

await test('destructive tools require approval and never reach the server', async () => {
  const { exec, server } = setup()
  await exec.connect()
  await assert.rejects(
    () => exec.call('deploy.rollback', { version: 'v41' }),
    (error) => error instanceof ApprovalRequired,
  )
  assert.equal(server.calls, 0)

  const approved = await exec.call('deploy.rollback', { version: 'v41' }, { approved: true })
  assert.ok(approved.inline?.includes('v41'))
  assert.equal(server.calls, 1)
})

await test('nested budget exhaustion blocks before the call', async () => {
  const { exec, server } = setup({ budget: { calls: 1, ms: 10_000 } })
  await exec.connect()
  await exec.call('metrics.query', { metric: 'a' })
  await assert.rejects(
    () => exec.call('metrics.query', { metric: 'b' }),
    (error) => error instanceof BudgetExceeded,
  )
  assert.equal(server.calls, 1)
})

await test('catalog drift fails closed', async () => {
  const { exec, server } = setup()
  await exec.connect()
  server.mutateDescription()

  const verdict = await exec.verify()
  assert.equal(verdict.ok, false)
  await assert.rejects(() => exec.refresh(), (error) => error instanceof DriftDetected)
})

await test('clock is injected so receipts share one timeline', async () => {
  const { exec } = setup()
  await exec.connect()
  const out = await exec.call('metrics.query', { metric: 'x' })
  assert.equal(out.receipt.at, '2026-10-24T01:00:01.000Z')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
