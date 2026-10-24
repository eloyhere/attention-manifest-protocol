#!/usr/bin/env node
/** Team-manifest enforcement + conflict adjudication. */
import assert from 'node:assert/strict'

import { adjudicate, mergeResults } from '../src/runtime/merge.ts'
import { AttenuationError, TeamRuntime } from '../src/runtime/team.ts'
import type { TeamManifest } from '../src/types/index.ts'
import type { MergedClaim } from '../src/runtime/merge.ts'

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

const team: TeamManifest = {
  amp: '0.1',
  kind: 'team-manifest',
  id: 'team.a',
  version: 1,
  members: [
    { id: 'a.lead', role: 'coordinator', authority: ['tool.logs.query'] },
    { id: 'a.worker', role: 'investigator', authority: ['tool.logs.query'] },
  ],
  max_depth: 1,
  max_fanout: 1,
  budget: { tokens: 2000 },
  termination: 'verified',
  attested_at: '2026-10-24T10:00:00Z',
}

const goal = 'sha256:' + 'a'.repeat(64)
const base = {
  granter: 'a.lead',
  delegatee: 'a.worker',
  goalDigest: goal,
  scope: ['tool.logs.query'],
  budget: { tokens: 1000 },
  deadline: '2026-10-24T12:00:00Z',
  mayRedelegate: false,
  depth: 0,
}

const runtime = () => new TeamRuntime({ now: () => '2026-10-24T10:00:00Z' })

test('valid delegation passes manifest checks', () => {
  assert.ok(runtime().createDelegation(base, team))
})

test('non-member delegatee is rejected', () => {
  assert.throws(
    () => runtime().createDelegation({ ...base, delegatee: 'a.stranger' }, team),
    AttenuationError,
  )
})

test('scope beyond authority is rejected', () => {
  assert.throws(
    () => runtime().createDelegation({ ...base, scope: ['tool.deploy.rollback'] }, team),
    AttenuationError,
  )
})

test('budget beyond team budget is rejected', () => {
  assert.throws(
    () => runtime().createDelegation({ ...base, budget: { tokens: 5000 } }, team),
    AttenuationError,
  )
})

test('fan-out cap is enforced', () => {
  const instance = runtime()
  instance.createDelegation(base, team)
  assert.throws(
    () => instance.createDelegation({ ...base, goalDigest: 'sha256:' + 'b'.repeat(64) }, team),
    AttenuationError,
  )
})

test('adjudication prefers the higher tier', () => {
  const contested: MergedClaim[] = [
    { subject: 's', value: 'a', tier: 'T3', supporters: ['a.one'], origins: ['r1'], status: 'contested' },
    { subject: 's', value: 'b', tier: 'T1', supporters: ['a.two'], origins: ['r2'], status: 'contested' },
  ]
  const verdict = adjudicate(contested, { 'a.one': 1, 'a.two': 9 })
  assert.equal(verdict.decision, 'accept')
  assert.equal(verdict.value, 'a')
  assert.equal(verdict.reason, 'higher evidence tier')
})

test('adjudication falls back to authority at equal tiers', () => {
  const contested: MergedClaim[] = [
    { subject: 's', value: 'a', tier: 'T2', supporters: ['a.one'], origins: ['r1'], status: 'contested' },
    { subject: 's', value: 'b', tier: 'T2', supporters: ['a.two'], origins: ['r2'], status: 'contested' },
  ]
  assert.equal(adjudicate(contested, { 'a.one': 2, 'a.two': 8 }).value, 'b')
})

test('no dominance escalates instead of guessing', () => {
  const contested: MergedClaim[] = [
    { subject: 's', value: 'a', tier: 'T2', supporters: ['a.one'], origins: ['r1'], status: 'contested' },
    { subject: 's', value: 'b', tier: 'T2', supporters: ['a.two'], origins: ['r2'], status: 'contested' },
  ]
  const verdict = adjudicate(contested, { 'a.one': 5, 'a.two': 5 })
  assert.equal(verdict.decision, 'escalate')
})

test('merge then adjudicate keeps both values until a decision exists', () => {
  const result = mergeResults(
    [
      { id: 'c1', subject: 'x', value: 'a', tier: 'T2', agent: 'a.one', origins: ['r1'], replayable: true },
      { id: 'c2', subject: 'x', value: 'b', tier: 'T2', agent: 'a.two', origins: ['r2'], replayable: true },
    ],
    { forAgent: 'a.lead' },
  )
  assert.equal(result.merged.length, 2)
  assert.equal(adjudicate(result.merged, { 'a.one': 1, 'a.two': 3 }).value, 'b')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
