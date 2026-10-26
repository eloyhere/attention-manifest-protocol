#!/usr/bin/env node
/**
 * Concurrency checks: worker leases, fencing tokens, atomic claims, retry and
 * idempotency. These are the mechanisms that make several kernels safe on one
 * SQLite file; they are deliberately tested without threads so a failure points
 * at the protocol, not at scheduling noise.
 */
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";

import { KernelError } from "../src/error/kernelError.ts";
import { Mutex } from "../src/concurrency/mutex.ts";
import { NamedLocks } from "../src/concurrency/namedLocks.ts";
import { withBusyRetry } from "../src/concurrency/retry.ts";
import { once } from "../src/concurrency/idempotency.ts";
import type { OnceResult } from "../src/concurrency/idempotency.ts";
import { heartbeatWorker, listWorkers, recoverExpiredWorkers, registerWorker, unregisterWorker } from "../src/concurrency/worker.ts";
import { createProcess } from "../src/process/process.ts";
import type { ProcessRecord } from "../src/process/process.ts";
import { claimThread, getThread, spawnThread, transitionThread } from "../src/thread/thread.ts";
import type { ThreadClaim, ThreadRecord } from "../src/thread/thread.ts";
import { openStore, tableNames } from "../src/database/store/database.ts";

type TestCase = (name: string, fn: () => void | Promise<void>) => void;

type RejectionMatcher = (code: string) => (error: unknown) => boolean;

type MetaRow = {
    value: string;
};

type BusyTimeoutRow = {
    timeout: number;
};

type DeliveredEffect = {
    delivered: boolean;
};

type RecoveryReport = ReturnType<typeof recoverExpiredWorkers>;

type Fixture = {
    db: DatabaseSync;
    process: ProcessRecord;
    thread: ThreadRecord;
};

const At: string = "2026-10-24T00:00:00.000Z";

let Passed: number = 0;
let Failed: number = 0;

const Pending: Promise<void>[] = [];

const test: TestCase = (name: string, fn: () => void | Promise<void>): void => {
    Pending.push(
        (async (): Promise<void> => {
            try {
                await fn();
                Passed += 1;
                console.log(`\x1b[32m✓\x1b[0m ${name}`);
            } catch (error) {
                Failed += 1;
                const message: string = error instanceof Error ? error.message : `${error}`;
                console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
            }
        })(),
    );
};

const rejects: RejectionMatcher =
    (code: string) =>
    (error: unknown): boolean =>
        error instanceof KernelError && error.code === code;

const setup: () => Fixture = (): Fixture => {
    const db: DatabaseSync = openStore(":memory:");
    const process: ProcessRecord = createProcess(
        db,
        {
            id: "a.concurrent.1",
            name: "Concurrent Agent",
            budget: { calls: 100 },
        },
        At,
    );
    const thread: ThreadRecord = spawnThread(
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
    const db: DatabaseSync = openStore(":memory:");
    const names: string[] = tableNames(db);
    assert.equal(names.includes("workers"), true);
    assert.equal(names.includes("idempotency"), true);
    const version: MetaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as MetaRow;
    assert.equal(version.value, "4");
    const busy: BusyTimeoutRow = db.prepare("PRAGMA busy_timeout").get() as BusyTimeoutRow;
    assert.equal(busy.timeout, 5000);
    db.close();
});

test("atomic claim lets exactly one worker own a thread", () => {
    const { db, thread }: Fixture = setup();
    const first: ThreadClaim = claimThread(db, thread.tid, "w-a");
    assert.equal(first.lease, 1);
    assert.equal(getThread(db, thread.tid).state, "running");
    assert.throws(() => claimThread(db, thread.tid, "w-b"), rejects("claim_failed"));
    db.close();
});

test("a stale lease cannot commit after another worker claims", () => {
    const { db, thread }: Fixture = setup();
    const claim: ThreadClaim = claimThread(db, thread.tid, "w-a");
    db.prepare("UPDATE threads SET lease = lease + 1 WHERE tid = ?").run(thread.tid);
    assert.throws(() => transitionThread(db, thread.tid, ["running"], "done", { finishedAt: At }, claim.lease), rejects("lease_lost"));
    const current: number = getThread(db, thread.tid).lease;
    const done: ThreadRecord = transitionThread(db, thread.tid, ["running"], "done", { finishedAt: At }, current);
    assert.equal(done.state, "done");
    db.close();
});

test("worker heartbeat and unregister are explicit", () => {
    const db: DatabaseSync = openStore(":memory:");
    registerWorker(db, { workerId: "w-a", leaseMs: 1000 }, At);
    assert.equal(listWorkers(db).length, 1);
    assert.equal(heartbeatWorker(db, "w-a", At, 1000), true);
    unregisterWorker(db, "w-a");
    assert.equal(listWorkers(db).length, 0);
    assert.equal(heartbeatWorker(db, "w-a", At, 1000), false);
    db.close();
});

test("expired worker leases are recovered with a new fencing token", () => {
    const { db, thread }: Fixture = setup();
    registerWorker(db, { workerId: "w-a", leaseMs: 1000 }, At);
    const claim: ThreadClaim = claimThread(db, thread.tid, "w-a");
    assert.equal(getThread(db, thread.tid).ownerWorker, "w-a");

    const later: string = new Date(Date.parse(At) + 5000).toISOString();
    const recovered: RecoveryReport = recoverExpiredWorkers(db, later);
    assert.equal(recovered.threads, 1);
    assert.deepEqual(recovered.workers, ["w-a"]);
    const threadAfter: ThreadRecord = getThread(db, thread.tid);
    assert.equal(threadAfter.state, "ready");
    assert.equal(threadAfter.ownerWorker, (void 0));
    assert.equal(threadAfter.lease, claim.lease + 1);
    assert.equal(listWorkers(db).length, 0);
    db.close();
});

test("Mutex serializes interleaved async sections", async () => {
    const mutex: Mutex = new Mutex();
    let active: number = 0;
    let maxActive: number = 0;
    let counter: number = 0;
    const task: () => Promise<void> = async (): Promise<void> => {
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
    const locks: NamedLocks = new NamedLocks();
    let activeSame: number = 0;
    let maxSame: number = 0;
    const same: () => Promise<void> = async (): Promise<void> => {
        activeSame += 1;
        maxSame = Math.max(maxSame, activeSame);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeSame -= 1;
    };
    await Promise.all([locks.run("file:a", same), locks.run("file:a", same)]);
    assert.equal(maxSame, 1);

    let activeDifferent: number = 0;
    let maxDifferent: number = 0;
    const different: () => Promise<void> = async (): Promise<void> => {
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
    const value: string = await withBusyRetry(
        () => {
            attempts += 1;
            if (attempts < 3) {
                throw new Error("database is locked");
            }
            return "ok";
        },
        { attempts: 5, baseMs: 1, sleep: async () => {} },
    );
    assert.equal(value, "ok");
    assert.equal(attempts, 3);
});

test("idempotency executes an effect once and replays the result", () => {
    const db: DatabaseSync = openStore(":memory:");
    let calls: number = 0;
    const first: OnceResult<DeliveredEffect> = once(db, "send:m.1", At, () => {
        calls += 1;
        return { delivered: true };
    });
    const second: OnceResult<DeliveredEffect> = once(db, "send:m.1", At, () => {
        calls += 1;
        return { delivered: true };
    });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(calls, 1);
    assert.deepEqual(second.value, { delivered: true });
    db.close();
});

await Promise.all(Pending);
console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
