#!/usr/bin/env node
/**
 * Async kernel checks: the handler may await a model/tool call while the
 * write transaction stays short.
 */
import assert from "node:assert/strict";

import { Kernel } from "../src/kernel/index.ts";
import { createProcess, getProcess } from "../src/process/process.ts";
import { getThread, spawnThread } from "../src/thread/thread.ts";
import { openStore } from "../src/database/store/database.ts";

const At = "2026-10-24T00:00:00.000Z";
let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>): void => {
    tests.push([name, fn]);
};

const setup = () => {
    const db = openStore(":memory:");
    const agent = createProcess(db, { id: "a.async", name: "Async Agent", budget: { calls: 100 } }, At);
    const work = spawnThread(
        db,
        {
            pid: agent.pid,
            goal: "g.async",
            statement: "await a model call",
            success: [{ id: "c.async", statement: "answer produced", check: "observe" }],
        },
        At,
    );
    return { db, agent, work, kernel: new Kernel(db, { now: () => At, leaseMs: 60_000 }) };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("stepAsync awaits a handler and commits usage", async () => {
    const { db, agent, work, kernel } = setup();
    const report = await kernel.stepAsync(async () => {
        await sleep(10);
        return { status: "yield", usage: { tokens: 9 } };
    });
    assert.ok(report);
    assert.equal(report.status, "yield");
    assert.equal(getThread(db, work.tid).state, "ready");
    assert.equal(getProcess(db, agent.pid).state, "idle");
    assert.equal(getThread(db, work.tid).used.tokens, 9);
    kernel.close();
    db.close();
});

test("stepAsync turns a rejection into a task failure", async () => {
    const { db, work, kernel } = setup();
    const report = await kernel.stepAsync(async () => {
        await sleep(1);
        throw new Error("model timeout");
    });
    assert.ok(report);
    assert.equal(report.status, "fail");
    assert.equal(getThread(db, work.tid).state, "failed");
    assert.match(getThread(db, work.tid).exitNote ?? "", /model timeout/);
    kernel.close();
    db.close();
});

test("runAsync drains multiple tasks", async () => {
    const { db, agent, work, kernel } = setup();
    spawnThread(
        db,
        {
            pid: agent.pid,
            goal: "g.async.2",
            statement: "second task",
            success: [{ id: "c.async.2", statement: "answer produced", check: "observe" }],
        },
        At,
    );
    const reports = await kernel.runAsync(async () => {
        await sleep(1);
        return { status: "done" };
    });
    assert.equal(reports.length, 2);
    assert.equal(getThread(db, work.tid).state, "done");
    assert.equal(getProcess(db, agent.pid).state, "idle");
    kernel.close();
    db.close();
});

test("stepAsync returns undefined when no task is ready", async () => {
    const { db, kernel } = setup();
    await kernel.stepAsync(async () => ({ status: "done" }));
    const second = await kernel.stepAsync(async () => ({ status: "done" }));
    assert.equal(second, (void 0));
    kernel.close();
    db.close();
});

for (const [name, fn] of tests) {
    try {
        await fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
