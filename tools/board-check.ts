#!/usr/bin/env node
/**
 * Task board checks: dedup, claim, complete, cancel, counters.
 */
import assert from "node:assert/strict";

import { DuplicateGoal, TaskBoard } from "../src/cooperation/board.ts";
import type { BoardTask } from "../src/cooperation/board.ts";
import type { Lease } from "../src/delegate/team.ts";
import type { Digest } from "../src/types/common.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, body: () => void) => void = (name: string, body: () => void): void => {
    try {
        body();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed += 1;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Goal: Digest = `sha256:${"a".repeat(64)}`;
const lease: (id: string, holder: string) => Lease = (id: string, holder: string): Lease => ({
    id,
    holder,
    delegation: "dl.1",
    taskId: "t",
    fence: 1,
    goalDigest: Goal,
    budget: {},
    deadline: "2026-10-24T12:00:00Z",
    status: "active" as const,
});

test("adding a second open task for the same goal is rejected", () => {
    const board: TaskBoard = new TaskBoard();
    board.add(Goal);
    assert.throws(() => board.add(Goal), DuplicateGoal);
    assert.equal(board.stats().rejected, 1);
});

test("claiming records owner and attempt count", () => {
    const board: TaskBoard = new TaskBoard();
    const task: BoardTask = board.add(Goal);
    board.claim(task.id, lease("ls.1", "a.worker"));
    assert.equal(board.get(task.id).state, "leased");
    assert.equal(board.get(task.id).owner, "a.worker");
    assert.equal(board.get(task.id).attempts, 1);
});

test("a leased task cannot be stolen by another lease", () => {
    const board: TaskBoard = new TaskBoard();
    const task: BoardTask = board.add(Goal);
    board.claim(task.id, lease("ls.1", "a.worker"));
    assert.throws(() => board.claim(task.id, lease("ls.2", "a.other")));
});

test("completion frees the goal", () => {
    const board: TaskBoard = new TaskBoard();
    const task: BoardTask = board.add(Goal);
    board.complete(task.id);
    assert.equal(board.add(Goal).state, "pending");
    assert.equal(board.stats().open, 1);
});

test("cancellation frees the goal too", () => {
    const board: TaskBoard = new TaskBoard();
    const task: BoardTask = board.add(Goal);
    board.cancel(task.id);
    assert.equal(board.add(Goal).state, "pending");
});

test("done and cancelled tasks cannot be reclaimed", () => {
    const board: TaskBoard = new TaskBoard();
    const task: BoardTask = board.add(Goal);
    board.complete(task.id);
    assert.throws(() => board.claim(task.id, lease("ls.9", "a.x")));
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
