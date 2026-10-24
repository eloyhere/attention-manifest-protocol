#!/usr/bin/env node
/** Coordination metrics: duplicate rate, alignment share, cost/success, contested rate. */
import assert from 'node:assert/strict'

import { TaskBoard } from '../src/runtime/board.ts'
import { coordinationMetrics } from '../src/runtime/metrics.ts'

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

const goal = 'sha256:' + 'a'.repeat(64)
const snapshot = (over = {}) => ({ tokens: 100, calls: 3, ms: 0, interruptsGranted: 1, debtScore: 0, ...over })

test('duplicate task rate counts rejected attempts', () => {
  const board = new TaskBoard()
  board.add(goal)
  assert.throws(() => board.add(goal))
  const metrics = coordinationMetrics({ board, snapshot: snapshot() })
  assert.equal(metrics.duplicateTaskRate, 0.5)
})

test('alignment share is interrupts over knowledge operations', () => {
  const metrics = coordinationMetrics({ board: new TaskBoard(), snapshot: snapshot({ calls: 3, interruptsGranted: 1 }) })
  assert.equal(metrics.alignmentTokenShare, 0.25)
})

test('cost per success divides tokens by completed tasks', () => {
  const board = new TaskBoard()
  const first = board.add(goal)
  board.complete(first.id)
  const second = board.add('sha256:' + 'b'.repeat(64))
  board.complete(second.id)
  assert.equal(coordinationMetrics({ board, snapshot: snapshot({ tokens: 100 }) }).costPerSuccess, 50)
})

test('contested rate divides conflicts by subjects', () => {
  const merge = {
    merged: [
      { subject: 's1', value: 'a', tier: 'T2', supporters: ['x'], origins: ['r'], status: 'contested' },
      { subject: 's1', value: 'b', tier: 'T2', supporters: ['y'], origins: ['r2'], status: 'contested' },
      { subject: 's2', value: 'c', tier: 'T2', supporters: ['x'], origins: ['r'], status: 'held' },
    ],
    conflicts: ['s1'],
    warnings: [],
  }
  assert.equal(coordinationMetrics({ board: new TaskBoard(), snapshot: snapshot(), merge }).contestedRate, 0.5)
})

test('empty inputs produce zeros instead of NaN', () => {
  const metrics = coordinationMetrics({ board: new TaskBoard(), snapshot: snapshot({ calls: 0, interruptsGranted: 0, tokens: 0 }) })
  assert.deepEqual(metrics, { duplicateTaskRate: 0, alignmentTokenShare: 0, costPerSuccess: 0, contestedRate: 0 })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
