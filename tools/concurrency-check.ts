#!/usr/bin/env node
/**
 * Concurrency checks: worker leases, fencing tokens, atomic claims, retry and
 * idempotency. These are the mechanisms that make several kernels safe on one
 * SQLite file; they are deliberately tested without threads so a failure points
 * at the protocol, not at scheduling noise.
 */
import assert from "node:assert/strict";

import { KernelError } from "../src/error/kernelError.ts";
import { Mutex } from "../src/concurrency/mutex.ts";
import { NamedLocks } from "../src/concurrency/namedLocks.ts";
import { withBusyRetry } from "../src/concurrency/retry.ts";
import { once } from "../src/concurrency/idempotency.ts";
import { heartbeatWorker, listWorkers, recoverExpiredWorkers, registerWorker, unregisterWorker } from "../src/concurrency/worker.ts";
import { createProcess } from "../src/process/process.ts";
import { claimThread, getThread, spawnThread, transitionThread } from "../src/thread/thread.ts";
import { openStore, tableNames } from "../src/database/store/database.ts";

const At: string = "2026-10-24T00:00:00.000Z";

let passed: number = 0;
let failed: number = 0;

const pending: Promise<void>[] = [];

const test = (name: string, fn: () => void | Promise<void>): void => {
    pending.push(
        (async (): Promise<void> => {
            try {
                await fn();
                passed += 1;
                console.log(`\x1b[32m✓\x1b[0m ${name}`);
            } catch (error) {
                failed += 1;
                const message: string = error instanceof Error ? error.message : `${error}`;
                console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
            }
        })(),
    );
};

const rejects =
    (code: string) =>
    (error: unknown): boolean =>
        error instanceof KernelError && error.code === code;

const setup = () => {
    const db = openStore(":memory:");
    const process = createProcess(
        db,
        {
            id: "a.concurrent.1",
            name: "Concurrent Agent",
            budget: { calls: 100 },
        },
        At,
    );
    const thread = spawnThread(
        db,
        {
            pid: process.pid,
            goal: "g.concurrent.1",
            statement: "只有一个任务在跑",
            success: [{ id: "c.concurrent.1", statement: "只有一个任务在跑", check: "threads" }],
        },
        At,
    );
    return { db, process, thread };
};

test("schema exposes workers and idempotency, version 4, busy timeout", () => {
    const db = openStore(":memory:");
    const names: string[] = tableNames(db);
    assert.equal(names.includes("workers"), true);
    assert.equal(names.includes("idempotency"), true);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(version.value, "4");
    const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(busy.timeout, 5000);
    db.close();
});

test("atomic claim lets exactly one worker own a thread", () => {
    const { db, thread } = setup();
    const first = claimThread(db, thread.tid, "w-a");
    assert.equal(first.lease, 1);
    assert.equal(getThread(db, thread.tid).state, "running");
    assert.throws(() => claimThread(db, thread.tid, "w-b"), rejects("claim_failed"));
    db.close();
});

test("a stale lease cannot commit after another worker claims", () => {
    const { db, thread } = setup();
    const claim = claimThread(db, thread.tid, "w-a");
    db.prepare("UPDATE threads SET lease = lease + 1 WHERE tid = ?").run(thread.tid);
    assert.throws(() => transitionThread(db, thread.tid, ["running"], "done", { finishedAt: At }, claim.lease), rejects("lease_lost"));
    const current = getThread(db, thread.tid).lease;
    const done = transitionThread(db, thread.tid, ["running"], "done", { finishedAt: At }, current);
    assert.equal(done.state, "done");
    db.close();
});

test("worker heartbeat and unregister are explicit", () => {
    const db = openStore(":memory:");
    registerWorker(db, { workerId: "w-a", leaseMs: 1000 }, At);
    assert.equal(listWorkers(db).length, 1);
    assert.equal(heartbeatWorker(db, "w-a", At, 1000), true);
    unregisterWorker(db, "w-a");
    assert.equal(listWorkers(db).length, 0);
    assert.equal(heartbeatWorker(db, "w-a", At, 1000), false);
    db.close();
});

test("expired worker leases are recovered with a new fencing token", () => {
    const { db, thread } = setup();
    registerWorker(db, { workerId: "w-a", leaseMs: 1000 }, At);
    const claim = claimThread(db, thread.tid, "w-a");
    assert.equal(getThread(db, thread.tid).ownerWorker, "w-a");

    const later = new Date(Date.parse(At) + 5000).toISOString();
    const recovered = recoverExpiredWorkers(db, later);
    assert.equal(recovered.threads, 1);
    assert.deepEqual(recovered.workers, ["w-a"]);
    const threadAfter = getThread(db, thread.tid);
    assert.equal(threadAfter.state, "ready");
    assert.equal(threadAfter.ownerWorker, (void 0));
    assert.equal(threadAfter.lease, claim.lease + 1);
    assert.equal(listWorkers(db).length, 0);
    db.close();
});

test("Mutex serializes interleaved async sections", async () => {
    const mutex = new Mutex();
    let active: number = 0;
    let maxActive: number = 0;
    let counter: number = 0;
    const task = async (): Promise<void> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        counter += 1;
        active -= 1;
    };
    await Promise.all([mutex.run(task), mutex.run(task), mutex.run(task)]);
    assert.equal(counter, 3);
    assert.equal(maxActive, 1);
});

test("NamedLocks serialize one resource and allow independent ones", async () => {
    const locks = new NamedLocks();
    let activeSame: number = 0;
    let maxSame: number = 0;
    const same = async (): Promise<void> => {
        activeSame += 1;
        maxSame = Math.max(maxSame, activeSame);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeSame -= 1;
    };
    await Promise.all([locks.run("file:a", same), locks.run("file:a", same)]);
    assert.equal(maxSame, 1);

    let activeDifferent: number = 0;
    let maxDifferent: number = 0;
    const different = async (): Promise<void> => {
        activeDifferent += 1;
        maxDifferent = Math.max(maxDifferent, activeDifferent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeDifferent -= 1;
    };
    await Promise.all([locks.run("file:a", different), locks.run("file:b", different)]);
    assert.equal(maxDifferent, 2);
    assert.equal(locks.size, 2);
});

test("withBusyRetry backs off and eventually succeeds", async () => {
    let attempts: number = 0;
    const value = await withBusyRetry(
        () => {
            attempts += 1;
            if (attempts < 3) throw new Error("database is locked");
            return "ok";
        },
        { attempts: 5, baseMs: 1, sleep: async () => {} },
    );
    assert.equal(value, "ok");
    assert.equal(attempts, 3);
});

test("idempotency executes an effect once and replays the result", () => {
    const db = openStore(":memory:");
    let calls: number = 0;
    const first = once(db, "send:m.1", At, () => {
        calls += 1;
        return { delivered: true };
    });
    const second = once(db, "send:m.1", At, () => {
        calls += 1;
        return { delivered: true };
    });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(calls, 1);
    assert.deepEqual(second.value, { delivered: true });
    db.close();
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
