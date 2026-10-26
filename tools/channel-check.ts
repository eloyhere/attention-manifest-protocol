#!/usr/bin/env node
/** Channel checks: delegation crosses a seam and fails closed on rejection. */
import assert from 'node:assert/strict'

import { delegateOver, LoopbackChannel } from '../src/protocol/channel.ts'
import { TeamRuntime } from '../src/delegate/team.ts'

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

await test('accepted delegation crosses the channel with wire fields', async () => {
  const channel = new LoopbackChannel()
  const doc = await delegateOver(channel, delegation())
  assert.equal(channel.sent.length, 1)
  assert.equal(doc.goal_digest, goal)
  assert.equal(doc.kind, 'delegation')
})

await test('peer rejection fails closed with a reason', async () => {
  const channel = new LoopbackChannel(() => ({ accepted: false, reason: 'budget too wide' }))
  await assert.rejects(() => delegateOver(channel, delegation()), /budget too wide/)
})

await test('peer can enforce its own ceiling on the wire document', async () => {
  const channel = new LoopbackChannel((doc) =>
    (doc.budget.tokens ?? 0) > 50 ? { accepted: false, reason: 'over peer ceiling' } : { accepted: true },
  )
  await assert.rejects(() => delegateOver(channel, delegation({ tokens: 100 })), /over peer ceiling/)
  assert.ok(await delegateOver(channel, delegation({ tokens: 40 })))
})

await test('every attempt is recorded, including rejected ones', async () => {
  const accepting = new LoopbackChannel(() => ({ accepted: true }))
  await delegateOver(accepting, delegation())
  assert.equal(accepting.sent.length, 1)
  assert.equal(accepting.sent[0].may_redelegate, false)

  const rejecting = new LoopbackChannel(() => ({ accepted: false, reason: 'nope' }))
  await assert.rejects(() => delegateOver(rejecting, delegation()), /nope/)
  assert.equal(rejecting.sent.length, 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
