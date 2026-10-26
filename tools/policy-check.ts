#!/usr/bin/env node
/**
 * Action-policy checks: normative tier floors, claim gating, host-controlled
 * approvals, one-time consumption, expiry, digest binding and TTL clamping.
 *
 * The clock is injected everywhere, so there is no real sleeping and every
 * expiry case is deterministic.
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_APPROVAL_EFFECTS,
  EFFECT_CLASSES,
  PolicyEngine,
} from '../src/policy/policy.ts'
import type {
  ActionRequest,
  Approval,
  ApproveInput,
  EffectClass,
  PolicyOptions,
} from '../src/policy/policy.ts'
import type { Tier } from '../src/types/common.ts'
import type { Claim } from '../src/warrant/epistemic.ts'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`)
  }
}

interface Clock {
  now: () => string
  advance: (ms: number) => void
}

function clock(start = '2026-10-24T01:00:00Z'): Clock {
  let current = Date.parse(start)
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms) => {
      current += ms
    },
  }
}

function makeEngine(now: () => string, options: Omit<PolicyOptions, 'now'> = {}): PolicyEngine {
  return new PolicyEngine({ now, ...options })
}

function heldClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    amp: '0.1',
    kind: 'claim',
    id: 'cl.policy.test',
    statement: 'policy-check claim',
    tier: 'T2',
    confidence: 0.9,
    status: 'held',
    warrant: { evidence: [], inference: 'deduction', strength: 0.9 },
    provenance: { source: 'policy-check', trust: 'self' },
    created: '2026-10-24T00:00:00Z',
    ...overrides,
  }
}

function request(effect: EffectClass, overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    action: 'deploy.rollback',
    effect,
    claim: heldClaim({ tier: 'T3' }),
    ...overrides,
  }
}

const TOOL_A = 'sha256:tool-a'
const ARGS_A = 'sha256:args-a'
const TOOL_B = 'sha256:tool-b'
const ARGS_B = 'sha256:args-b'

function deployRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return request('deploy', {
    action: 'deploy.rollback',
    toolDigest: TOOL_A,
    argsDigest: ARGS_A,
    ...overrides,
  })
}

function irreversibleRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return request('write-irreversible', {
    action: 'db.migrate',
    claim: heldClaim({ tier: 'T2' }),
    toolDigest: TOOL_A,
    argsDigest: ARGS_A,
    ...overrides,
  })
}

function issue(engine: PolicyEngine, overrides: Partial<ApproveInput> = {}): Approval {
  return engine.approve({
    action: 'deploy.rollback',
    effect: 'deploy',
    approvedBy: 'host.ops',
    toolDigest: TOOL_A,
    argsDigest: ARGS_A,
    ...overrides,
  })
}

await test('minTierFor maps every effect to the normative floor', () => {
  const engine = makeEngine(clock().now)
  const expected: Record<EffectClass, Tier> = {
    read: 'T0',
    'write-reversible': 'T1',
    'write-irreversible': 'T2',
    spend: 'T2',
    send: 'T2',
    delete: 'T3',
    deploy: 'T3',
    permission: 'T3',
    publish: 'T3',
  }
  assert.deepEqual([...EFFECT_CLASSES].sort(), Object.keys(expected).sort())
  for (const effect of EFFECT_CLASSES) {
    assert.equal(engine.minTierFor(effect), expected[effect])
  }
})

await test('default approval effects cover every externally visible risk', () => {
  assert.deepEqual([...DEFAULT_APPROVAL_EFFECTS].sort(), [
    'delete',
    'deploy',
    'permission',
    'publish',
    'send',
    'spend',
    'write-irreversible',
  ])
  assert.equal(DEFAULT_APPROVAL_EFFECTS.has('read'), false)
  assert.equal(DEFAULT_APPROVAL_EFFECTS.has('write-reversible'), false)
})

await test('read is allowed without a claim by default', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(request('read', { action: 'logs.read', claim: undefined }))
  assert.equal(verdict.outcome, 'allow')
  assert.equal(verdict.reason, 'read_without_claim')
  assert.equal(verdict.minTier, 'T0')
})

await test('allowReadWithoutClaim:false makes reads need a claim', () => {
  const engine = makeEngine(clock().now, { allowReadWithoutClaim: false })
  const verdict = engine.decide(request('read', { action: 'logs.read', claim: undefined }))
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'missing_claim')
})

await test('a T0 claim cannot authorize an irreversible write', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('write-irreversible', {
      action: 'db.migrate',
      claim: heldClaim({ tier: 'T0' }),
    }),
  )
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'tier_below_minimum:T2')
  assert.equal(verdict.minTier, 'T2')
})

await test('a held T1 claim authorizes a reversible write', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('write-reversible', {
      action: 'file.write',
      claim: heldClaim({ tier: 'T1' }),
    }),
  )
  assert.equal(verdict.outcome, 'allow')
  assert.equal(verdict.reason, 'allowed')
  assert.equal(verdict.minTier, 'T1')
})

await test('a T1 claim cannot authorize an irreversible write', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('write-irreversible', {
      action: 'db.migrate',
      claim: heldClaim({ tier: 'T1' }),
    }),
  )
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'tier_below_minimum:T2')
})

await test('a missing claim denies a non-read effect', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('delete', { action: 'repo.delete', claim: undefined }),
  )
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'missing_claim')
  assert.equal(verdict.minTier, 'T3')
})

await test('a contested claim cannot authorize an effect', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('delete', {
      action: 'repo.delete',
      claim: heldClaim({ tier: 'T3', status: 'contested' }),
    }),
  )
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'claim_not_held')
})

await test('a low-confidence claim cannot authorize an effect', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('deploy', {
      action: 'deploy.rollback',
      claim: heldClaim({ tier: 'T3', confidence: 0.2 }),
    }),
  )
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'claim_low_confidence')
})

await test('request.minTier cannot lower the host floor', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(
    request('delete', {
      action: 'repo.delete',
      claim: heldClaim({ tier: 'T2' }),
      minTier: 'T0',
    }),
  )
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'tier_below_minimum:T3')
  assert.equal(verdict.minTier, 'T3')
})

await test('T2 irreversible with a held claim returns approval_required', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(irreversibleRequest())
  assert.equal(verdict.outcome, 'approval_required')
  assert.equal(verdict.reason, 'approval_required')
  assert.equal(verdict.minTier, 'T2')
  assert.equal(verdict.approvalId, undefined)
})

await test('a host-issued approval authorizes the exact request', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  const verdict = engine.decide(irreversibleRequest(), approval)
  assert.equal(verdict.outcome, 'allow')
  assert.equal(verdict.reason, 'approved')
  assert.equal(verdict.minTier, 'T2')
  assert.equal(verdict.approvalId, approval.id)
})

await test('decide consumes an approval exactly once', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  assert.equal(engine.decide(irreversibleRequest(), approval).outcome, 'allow')
  const replay = engine.decide(irreversibleRequest(), approval)
  assert.equal(replay.outcome, 'deny')
  assert.equal(replay.reason, 'approval_consumed')
  assert.equal(replay.approvalId, approval.id)
})

await test('explicit consume redeems once and blocks later reuse', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  const first = engine.consume(approval.id, irreversibleRequest())
  assert.equal(first.outcome, 'allow')
  assert.equal(first.reason, 'approved')
  const second = engine.consume(approval.id, irreversibleRequest())
  assert.equal(second.outcome, 'deny')
  assert.equal(second.reason, 'approval_consumed')
})

await test('checkApproval validates without consuming', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  const checked = engine.checkApproval(approval, irreversibleRequest())
  assert.equal(checked.outcome, 'allow')
  assert.equal(checked.reason, 'approval_valid')
  assert.equal(checked.approvalId, approval.id)
  assert.equal(engine.decide(irreversibleRequest(), approval).outcome, 'allow')
  const afterUse = engine.checkApproval(approval, irreversibleRequest())
  assert.equal(afterUse.outcome, 'deny')
  assert.equal(afterUse.reason, 'approval_consumed')
})

await test('an expired approval is denied', () => {
  const time = clock()
  const engine = makeEngine(time.now, { defaultTtlMs: 1_000, maxTtlMs: 10_000 })
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  time.advance(1_000)
  const verdict = engine.decide(irreversibleRequest(), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_expired')
  assert.equal(verdict.approvalId, approval.id)
})

await test('checkApproval accepts an injected time and denies at expiry', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  const at = new Date(Date.parse(approval.expires)).toISOString()
  const verdict = engine.checkApproval(approval, irreversibleRequest(), at)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_expired')
})

await test('approval TTL is clamped to maxTtlMs', () => {
  const time = clock()
  const engine = makeEngine(time.now, { defaultTtlMs: 1_500, maxTtlMs: 2_000 })
  const long = issue(engine, { ttlMs: 60_000 })
  assert.equal(Date.parse(long.expires) - Date.parse(long.issued), 2_000)
  const byDefault = issue(engine)
  assert.equal(Date.parse(byDefault.expires) - Date.parse(byDefault.issued), 1_500)

  const tight = makeEngine(time.now, { defaultTtlMs: 9_000, maxTtlMs: 1_000 })
  const clampedDefault = issue(tight)
  assert.equal(Date.parse(clampedDefault.expires) - Date.parse(clampedDefault.issued), 1_000)
  assert.throws(
    () => tight.approve({ action: 'deploy.rollback', effect: 'deploy', approvedBy: 'host', ttlMs: 0 }),
    RangeError,
  )
})

await test('a wrong action is denied', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  const verdict = engine.decide(deployRequest({ action: 'deploy.promote' }), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_action_mismatch')
})

await test('a wrong effect is denied', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  const verdict = engine.decide(deployRequest({ effect: 'permission' }), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_effect_mismatch')
})

await test('a wrong tool digest is denied', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  const verdict = engine.decide(deployRequest({ toolDigest: TOOL_B }), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_digest_mismatch')
})

await test('a wrong args digest is denied', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  const verdict = engine.decide(deployRequest({ argsDigest: ARGS_B }), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_digest_mismatch')
})

await test('a missing request digest cannot satisfy a bound approval', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  const verdict = engine.decide(deployRequest({ toolDigest: undefined }), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_digest_mismatch')
})

await test('failed validation does not burn an approval', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  assert.equal(engine.decide(deployRequest({ argsDigest: ARGS_B }), approval).outcome, 'deny')
  const retry = engine.decide(deployRequest(), approval)
  assert.equal(retry.outcome, 'allow')
  assert.equal(retry.reason, 'approved')
})

await test('a revoked approval is denied', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine)
  assert.equal(engine.revoke(approval.id), true)
  assert.equal(engine.revoke(approval.id), true)
  assert.equal(engine.revoke('apr.missing'), false)
  const verdict = engine.decide(deployRequest(), approval)
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_revoked')
})

await test('an unknown approval id is denied', () => {
  const engine = makeEngine(clock().now)
  const verdict = engine.decide(deployRequest(), 'apr.unknown')
  assert.equal(verdict.outcome, 'deny')
  assert.equal(verdict.reason, 'approval_unknown')
})

await test('approve requires a non-empty action, effect and approver', () => {
  const engine = makeEngine(clock().now)
  assert.throws(
    () => engine.approve({ action: 'spend.money', effect: 'spend', approvedBy: '   ' }),
    TypeError,
  )
  assert.throws(
    () => engine.approve({ action: '', effect: 'spend', approvedBy: 'host' }),
    TypeError,
  )
  assert.throws(
    () =>
      engine.approve({
        action: 'spend.money',
        effect: 'not-an-effect' as EffectClass,
        approvedBy: 'host',
      }),
    TypeError,
  )

  // approvedBy is recorded, not implicitly trusted: the host decides trust.
  const untrusted = engine.approve({
    action: 'spend.money',
    effect: 'spend',
    approvedBy: 'agent.other',
  })
  assert.equal(untrusted.approvedBy, 'agent.other')
})

await test('approval ids and nonces are random, unique and non-trivial', () => {
  const engine = makeEngine(clock().now)
  const first = issue(engine, { approvedBy: 'host.one' })
  const second = issue(engine, { approvedBy: 'host.two' })
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.nonce, second.nonce)
  assert.match(first.id, /^apr\.[0-9a-f]{32}$/)
  assert.match(first.nonce, /^[0-9a-f]{48}$/)
  assert.notEqual(first.nonce, first.id)
})

await test('list returns copies, not mutable internals', () => {
  const engine = makeEngine(clock().now)
  const first = issue(engine)
  const second = issue(engine)
  const listed = engine.list()
  assert.equal(listed.length, 2)
  assert.deepEqual(
    listed.map((entry) => entry.id).sort(),
    [first.id, second.id].sort(),
  )
  listed[0].action = 'tampered'
  listed[0].scope.push('tampered')
  assert.equal(engine.list()[0].action, 'deploy.rollback')
  assert.deepEqual(engine.list()[0].scope, ['deploy.rollback'])
})

await test('custom approvalEffects can require approval for reads', () => {
  const engine = makeEngine(clock().now, {
    approvalEffects: new Set<EffectClass>(['read']),
  })
  const readRequest = request('read', { action: 'logs.read', claim: undefined })
  const required = engine.decide(readRequest)
  assert.equal(required.outcome, 'approval_required')
  assert.equal(required.minTier, 'T0')

  const approval = engine.approve({
    action: 'logs.read',
    effect: 'read',
    approvedBy: 'host.read',
  })
  const allowed = engine.decide(readRequest, approval)
  assert.equal(allowed.outcome, 'allow')
  assert.equal(allowed.reason, 'approved')
})

await test('publish can be raised to T4 for cross-task reuse', () => {
  const engine = makeEngine(clock().now)
  const denied = engine.decide(
    request('publish', {
      action: 'report.publish',
      claim: heldClaim({ tier: 'T3' }),
      minTier: 'T4',
    }),
  )
  assert.equal(denied.outcome, 'deny')
  assert.equal(denied.reason, 'tier_below_minimum:T4')
  assert.equal(denied.minTier, 'T4')

  const approval = issue(engine, {
    action: 'report.publish',
    effect: 'publish',
    toolDigest: undefined,
    argsDigest: undefined,
  })
  const allowed = engine.decide(
    request('publish', {
      action: 'report.publish',
      claim: heldClaim({ tier: 'T4' }),
      minTier: 'T4',
    }),
    approval,
  )
  assert.equal(allowed.outcome, 'allow')
  assert.equal(allowed.reason, 'approved')
})

await test('a valid approval cannot override a missing claim', () => {
  const engine = makeEngine(clock().now)
  const approval = issue(engine, { action: 'db.migrate', effect: 'write-irreversible' })
  const denied = engine.decide(irreversibleRequest({ claim: undefined }), approval)
  assert.equal(denied.outcome, 'deny')
  assert.equal(denied.reason, 'missing_claim')

  const allowed = engine.decide(irreversibleRequest(), approval)
  assert.equal(allowed.outcome, 'allow')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
