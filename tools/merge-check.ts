#!/usr/bin/env node
/** Result merge checks: tier decay on transfer, independence caps, contested conflicts. */
import assert from 'node:assert/strict'

import { mergeResults, transferTier } from '../src/cooperation/merge.ts'
import type { MergeClaim } from '../src/cooperation/merge.ts'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`)
  }
}

const claim = (over: Partial<MergeClaim> = {}): MergeClaim => ({
  id: 'cl.1',
  subject: 'deploy.cause',
  value: 'deploy',
  tier: 'T2',
  agent: 'a.worker',
  origins: ['logs.query@run.1'],
  replayable: false,
  ...over,
})

test('tier survives for the originating agent', () => {
  assert.equal(transferTier(claim(), 'a.worker'), 'T2')
})

test('tier decays one step on transfer when not replayable', () => {
  assert.equal(transferTier(claim(), 'a.lead'), 'T1')
})

test('replayable observations survive transfer', () => {
  assert.equal(transferTier(claim({ replayable: true }), 'a.lead'), 'T2')
})

test('single agent is capped at T2 regardless of claimed tier', () => {
  const result = mergeResults([claim({ tier: 'T4' })], { forAgent: 'a.worker' })
  assert.equal(result.merged[0].tier, 'T2')
  assert.equal(result.merged[0].status, 'single_agent')
})

test('two independent agents can reach T4 only with two origins', () => {
  const twoAgents = mergeResults(
    [
      claim({ agent: 'a.one', origins: ['run.1'], tier: 'T4', replayable: true }),
      claim({ id: 'cl.2', agent: 'a.two', origins: ['run.1'], tier: 'T4', replayable: true }),
    ],
    { forAgent: 'a.lead' },
  )
  assert.equal(twoAgents.merged[0].tier, 'T3')

  const twoOrigins = mergeResults(
    [
      claim({ agent: 'a.one', origins: ['run.1'], tier: 'T4', replayable: true }),
      claim({ id: 'cl.2', agent: 'a.two', origins: ['run.2'], tier: 'T4', replayable: true }),
    ],
    { forAgent: 'a.lead' },
  )
  assert.equal(twoOrigins.merged[0].tier, 'T4')
})

test('corroboration never raises a decayed tier', () => {
  const result = mergeResults(
    [claim({ agent: 'a.one' }), claim({ id: 'cl.2', agent: 'a.two' })],
    { forAgent: 'a.lead' },
  )
  assert.equal(result.merged[0].tier, 'T1')
})

test('conflicting values are contested, never averaged', () => {
  const result = mergeResults(
    [
      claim({ value: 'deploy' }),
      claim({ id: 'cl.2', agent: 'a.other', value: 'traffic' }),
    ],
    { forAgent: 'a.lead' },
  )
  assert.deepEqual(result.conflicts, ['deploy.cause'])
  assert.equal(result.merged.length, 2)
  assert.ok(result.merged.every((item) => item.status === 'contested'))
})

test('duplicate claims by the same agent count once', () => {
  const result = mergeResults(
    [claim(), claim({ id: 'cl.2', origins: ['run.2'] })],
    { forAgent: 'a.worker' },
  )
  assert.equal(result.merged[0].supporters.length, 1)
})

test('degradation is reported as a warning', () => {
  const result = mergeResults([claim()], { forAgent: 'a.lead' })
  assert.ok(result.warnings.some((warning) => warning.includes('T2 → T1')))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
