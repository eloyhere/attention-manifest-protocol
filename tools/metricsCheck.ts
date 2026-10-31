#!/usr/bin/env node
/**
 * Coordination metrics: duplicate rate, alignment share, cost/success, contested rate.
 */
import assert from "node:assert/strict";

import { TaskBoard } from "../src/cooperation/board.ts";
import type { BoardTask } from "../src/cooperation/board.ts";
import { coordinationMetrics } from "../src/cooperation/metrics.ts";
import type { CoordinationMetrics } from "../src/cooperation/metrics.ts";
import type { MergeResult } from "../src/cooperation/merge.ts";
import type { UnifiedSnapshot } from "../src/cooperation/unified.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Goal: string = `sha256:${"a".repeat(64)}`;

type SnapshotOverrides = Partial<UnifiedSnapshot>;

const snapshot: (over?: SnapshotOverrides) => UnifiedSnapshot = (over: SnapshotOverrides = {}): UnifiedSnapshot => ({
    tokens: 100,
    calls: 3,
    ms: 0,
    interruptsGranted: 1,
    debtScore: 0,
    ...over,
});

test("duplicate task rate counts rejected attempts", () => {
    const board: TaskBoard = new TaskBoard();
    board.add(Goal);
    assert.throws(() => board.add(Goal));
    const metrics: CoordinationMetrics = coordinationMetrics({ board, snapshot: snapshot() });
    assert.equal(metrics.duplicateTaskRate, 0.5);
});

test("alignment share is interrupts over knowledge operations", () => {
    const metrics: CoordinationMetrics = coordinationMetrics({ board: new TaskBoard(), snapshot: snapshot({ calls: 3, interruptsGranted: 1 }) });
    assert.equal(metrics.alignmentTokenShare, 0.25);
});

test("cost per success divides tokens by completed tasks", () => {
    const board: TaskBoard = new TaskBoard();
    const first: BoardTask = board.add(Goal);
    board.complete(first.id);
    const second: BoardTask = board.add(`sha256:${"b".repeat(64)}`);
    board.complete(second.id);
    assert.equal(coordinationMetrics({ board, snapshot: snapshot({ tokens: 100 }) }).costPerSuccess, 50);
});

test("contested rate divides conflicts by subjects", () => {
    const merge: MergeResult = {
        merged: [
            { subject: "s1", value: "a", tier: "T2" as const, supporters: ["x"], origins: ["r"], status: "contested" as const },
            { subject: "s1", value: "b", tier: "T2" as const, supporters: ["y"], origins: ["r2"], status: "contested" as const },
            { subject: "s2", value: "c", tier: "T2" as const, supporters: ["x"], origins: ["r"], status: "held" as const },
        ],
        conflicts: ["s1"],
        warnings: [],
    };
    assert.equal(coordinationMetrics({ board: new TaskBoard(), snapshot: snapshot(), merge }).contestedRate, 0.5);
});

test("empty inputs produce zeros instead of NaN", () => {
    const metrics: CoordinationMetrics = coordinationMetrics({ board: new TaskBoard(), snapshot: snapshot({ calls: 0, interruptsGranted: 0, tokens: 0 }) });
    assert.deepEqual(metrics, { duplicateTaskRate: 0, alignmentTokenShare: 0, costPerSuccess: 0, contestedRate: 0 });
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
