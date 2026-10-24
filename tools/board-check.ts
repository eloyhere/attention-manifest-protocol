#!/usr/bin/env node
/** Task board checks: dedup, claim, complete, cancel, counters. */
import assert from 'node:assert/strict'

import { DuplicateGoal, TaskBoard } from '../src/runtime/board.ts'

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
const lease = (id, holder) => ({ id, holder, delegation: 'dl.1', taskId: 't', fence: 1, goalDigest: goal, budget: {}, deadline: '2026-10-24T12:00:00Z', status: 'active' as const })

test('adding a second open task for the same goal is rejected', () => {
  const board = new TaskBoard()
  board.add(goal)
  assert.throws(() => board.add(goal), DuplicateGoal)
  assert.equal(board.stats().rejected, 1)
})

test('claiming records owner and attempt count', () => {
  const board = new TaskBoard()
  const task = board.add(goal)
  board.claim(task.id, lease('ls.1', 'a.worker'))
  assert.equal(board.get(task.id).state, 'leased')
  assert.equal(board.get(task.id).owner, 'a.worker')
  assert.equal(board.get(task.id).attempts, 1)
})

test('a leased task cannot be stolen by another lease', () => {
  const board = new TaskBoard()
  const task = board.add(goal)
  board.claim(task.id, lease('ls.1', 'a.worker'))
  assert.throws(() => board.claim(task.id, lease('ls.2', 'a.other')))
})

test('completion frees the goal', () => {
  const board = new TaskBoard()
  const task = board.add(goal)
  board.complete(task.id)
  assert.equal(board.add(goal).state, 'pending')
  assert.equal(board.stats().open, 1)
})

test('cancellation frees the goal too', () => {
  const board = new TaskBoard()
  const task = board.add(goal)
  board.cancel(task.id)
  assert.equal(board.add(goal).state, 'pending')
})

test('done and cancelled tasks cannot be reclaimed', () => {
  const board = new TaskBoard()
  const task = board.add(goal)
  board.complete(task.id)
  assert.throws(() => board.claim(task.id, lease('ls.9', 'a.x')))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

