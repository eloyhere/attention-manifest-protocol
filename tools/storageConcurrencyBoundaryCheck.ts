#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import type { RetryOptions } from "../src/concurrency/retry.ts";
import type { LockRecord } from "../src/lock/lease.ts";
import type { OnceResult } from "../src/concurrency/idempotency.ts";

interface CountRow {
    count: number;
}
interface Delivered {
    delivered: boolean;
}
type DeliveredResult = OnceResult<Delivered>;

import { withBusyRetry } from "../src/concurrency/retry.ts";
import { once } from "../src/concurrency/idempotency.ts";
import { openStore, transaction } from "../src/database/store/database.ts";
import { acquireLock, getLock, renewLock } from "../src/lock/lease.ts";

const At: string = "2026-10-24T00:00:00.000Z";

test("invalid retry attempts fail before executing an effect", async () => {
    const invalidAttempts: number[] = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
    for (let index: number = 0; index < invalidAttempts.length; index += 1) {
        const attempts: number = invalidAttempts[index];
        let calls: number = 0;
        await assert.rejects(
            withBusyRetry(
                () => {
                    calls += 1;
                },
                { attempts },
            ),
            RangeError,
        );
        assert.equal(calls, 0);
    }
});

test("invalid retry delays fail before executing an effect", async () => {
    const invalidOptions: RetryOptions[] = [{ baseMs: NaN }, { baseMs: -1 }, { maxMs: Infinity }, { baseMs: 10, maxMs: 5 }];
    for (let index: number = 0; index < invalidOptions.length; index += 1) {
        const options: RetryOptions = invalidOptions[index];
        let calls: number = 0;
        await assert.rejects(
            withBusyRetry(() => {
                calls += 1;
            }, options),
            RangeError,
        );
        assert.equal(calls, 0);
    }
});

test("retry preserves final error and clamps exponential backoff", async () => {
    const failure: Error = new Error("SQLITE_BUSY");
    const delays: number[] = [];
    await assert.rejects(
        withBusyRetry(
            () => {
                throw failure;
            },
            {
                attempts: 4,
                baseMs: 10,
                maxMs: 15,
                sleep: async (ms: number): Promise<void> => {
                    delays.push(ms);
                },
            },
        ),
        (error: unknown) => error === failure,
    );
    assert.deepEqual(delays, [10, 15, 15]);
});

test("a SQLite trigger rollback preserves the original failure", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        db.exec("CREATE TRIGGER reject_meta BEFORE INSERT ON meta BEGIN SELECT RAISE(ROLLBACK, 'persist denied'); END");
        assert.throws(
            () =>
                transaction(db, () => {
                    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("boundary", "value");
                }),
            /persist denied/,
        );
        assert.equal(db.isTransaction, false);
        db.exec("DROP TRIGGER reject_meta");
        transaction(db, () => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("boundary", "value"));
    } finally {
        db.close();
    }
});

test("ordinary transaction failures roll back all writes and preserve identity", () => {
    const db: DatabaseSync = openStore(":memory:");
    const failure: Error = new Error("persistence failed");
    try {
        assert.throws(
            () =>
                transaction(db, () => {
                    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("boundary", "value");
                    throw failure;
                }),
            (error: unknown) => error === failure,
        );
        assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'boundary'").get(), undefined);
    } finally {
        db.close();
    }
});

test("idempotent local effects and result commit together", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        db.exec("CREATE TABLE effects (value TEXT)");
        const run: () => number = (): number => {
            db.prepare("INSERT INTO effects (value) VALUES ('sent')").run();
            return 1;
        };
        assert.deepEqual(once(db, "message", At, run), { value: 1, replayed: false });
        assert.deepEqual(once(db, "message", At, run), { value: 1, replayed: true });
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM effects").get() as unknown as CountRow).count, 1);
        assert.throws(
            () =>
                once(db, "bad", At, () => {
                    db.prepare("INSERT INTO effects (value) VALUES ('failed')").run();
                    return undefined;
                }),
            TypeError,
        );
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM effects").get() as unknown as CountRow).count, 1);
        assert.equal(db.prepare("SELECT result FROM idempotency WHERE key = 'bad'").get(), undefined);
    } finally {
        db.close();
    }
});

test("idempotency reuses an enclosing transaction without nesting", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        transaction(db, () => {
            assert.deepEqual(
                once(db, "nested", At, () => ({ ok: true })),
                { value: { ok: true }, replayed: false },
            );
        });
        assert.deepEqual(
            once(db, "nested", At, () => {
                throw new Error("replayed callback");
            }),
            { value: { ok: true }, replayed: true },
        );
    } finally {
        db.close();
    }
});

test("caught idempotency failures roll back only their enclosing savepoint", () => {
    const db: DatabaseSync = openStore(":memory:");
    const failure: Error = new Error("callback failed");
    try {
        db.exec("CREATE TABLE effects (value TEXT)");
        transaction(db, () => {
            db.prepare("INSERT INTO effects VALUES ('outer')").run();
            assert.throws(
                () =>
                    once(db, "throws", At, () => {
                        db.prepare("INSERT INTO effects VALUES ('failed')").run();
                        throw failure;
                    }),
                (error: unknown) => error === failure,
            );
            assert.throws(
                () =>
                    once(db, "undefined", At, () => {
                        db.prepare("INSERT INTO effects VALUES ('undefined')").run();
                        return undefined;
                    }),
                TypeError,
            );
            assert.equal(db.isTransaction, true);
        });
        assert.deepEqual(
            db
                .prepare("SELECT value FROM effects")
                .all()
                .map((row) => row.value),
            ["outer"],
        );
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM idempotency").get() as unknown as CountRow).count, 0);
    } finally {
        db.close();
    }
});

test("the same idempotency key cannot reenter its active callback", () => {
    const db: DatabaseSync = openStore(":memory:");
    let calls: number = 0;
    try {
        assert.deepEqual(
            once(db, "recursive", At, () => {
                calls += 1;
                assert.throws(
                    () =>
                        once(db, "recursive", At, () => {
                            calls += 1;
                            return 2;
                        }),
                    /reentran/i,
                );
                assert.deepEqual(
                    once(db, "other", At, () => 3),
                    { value: 3, replayed: false },
                );
                return 1;
            }),
            { value: 1, replayed: false },
        );
        assert.equal(calls, 1);
        assert.deepEqual(
            once(db, "recursive", At, () => 9),
            { value: 1, replayed: true },
        );
    } finally {
        db.close();
    }
});

test("Promise and thenable results cannot be persisted as successful effects", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        db.exec("CREATE TABLE effects (value TEXT)");
        const invalidResults: unknown[] = [Promise.resolve(1), { then: () => undefined }];
        for (let index: number = 0; index < invalidResults.length; index += 1) {
            const value: unknown = invalidResults[index];
            assert.throws(
                () =>
                    once(db, `async-${index}`, At, () => {
                        db.prepare("INSERT INTO effects VALUES ('async')").run();
                        return value;
                    }),
                /synchronous/i,
            );
        }
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM effects").get() as unknown as CountRow).count, 0);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM idempotency").get() as unknown as CountRow).count, 0);
    } finally {
        db.close();
    }
});

test("async callbacks fail before starting and failed executions release their key", () => {
    const db: DatabaseSync = openStore(":memory:");
    let calls: number = 0;
    try {
        assert.throws(
            () =>
                once(db, "async", At, async () => {
                    calls += 1;
                    return 1;
                }),
            /synchronous/i,
        );
        assert.equal(calls, 0);
        assert.deepEqual(
            once(db, "async", At, () => 2),
            { value: 2, replayed: false },
        );
    } finally {
        db.close();
    }
});

test("a failed result insert rolls back local effects inside an outer transaction", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        db.exec("CREATE TABLE effects (value TEXT)");
        db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT, 'result denied'); END");
        transaction(db, () => {
            assert.throws(
                () =>
                    once(db, "denied", At, () => {
                        db.prepare("INSERT INTO effects VALUES ('failed')").run();
                        return 1;
                    }),
                /result denied/,
            );
            db.prepare("INSERT INTO effects VALUES ('outer')").run();
        });
        assert.deepEqual(
            db
                .prepare("SELECT value FROM effects")
                .all()
                .map((row) => row.value),
            ["outer"],
        );
        db.exec("DROP TRIGGER reject_result");
        assert.deepEqual(
            once(db, "denied", At, () => 2),
            { value: 2, replayed: false },
        );
    } finally {
        db.close();
    }
});

test("outer rollback discards successful nested idempotency and permits a retry", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        db.exec("CREATE TABLE effects (value TEXT)");
        const run: () => number = (): number => {
            db.prepare("INSERT INTO effects VALUES ('sent')").run();
            return 1;
        };
        assert.throws(
            () =>
                transaction(db, () => {
                    once(db, "rolled-back", At, run);
                    throw new Error("outer failed");
                }),
            /outer failed/,
        );
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM effects").get() as unknown as CountRow).count, 0);
        assert.deepEqual(once(db, "rolled-back", At, run), { value: 1, replayed: false });
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM effects").get() as unknown as CountRow).count, 1);
    } finally {
        db.close();
    }
});

test("workers serialize the same key and replay it after reopening the database", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "amp-once-"));
    const path: string = join(directory, "store.sqlite");
    const db: DatabaseSync = openStore(path);
    db.exec("CREATE TABLE effects (value TEXT)");
    db.close();
    const gate: Int32Array = new Int32Array(new SharedArrayBuffer(8));
    const workers: Worker[] = [];
    const source: string = `
        const { workerData, parentPort } = await import('node:worker_threads');
        const { DatabaseSync } = await import('node:sqlite');
        const { once } = await import(workerData.module);
        const db = new DatabaseSync(workerData.path);
        const gate = new Int32Array(workerData.gate);
        db.exec('PRAGMA busy_timeout = 5000');
        Atomics.add(gate, 0, 1);
        parentPort.postMessage('ready');
        Atomics.wait(gate, 1, 0);
        try {
            const result = once(db, 'workers', workerData.at, () => {
                db.prepare("INSERT INTO effects VALUES ('sent')").run();
                Atomics.wait(gate, 1, 1, 100);
                return { delivered: true };
            });
            parentPort.postMessage(result);
        } finally { db.close(); }
    `;
    try {
        const results: Promise<DeliveredResult>[] = [0, 1].map(
            () =>
                new Promise<DeliveredResult>((resolve, reject) => {
                    const worker: Worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
                        workerData: { path, at: At, gate: gate.buffer, module: new URL("../src/concurrency/idempotency.ts", import.meta.url).href },
                    });
                    workers.push(worker);
                    worker.on("error", reject);
                    worker.on("exit", (code: number) => {
                        if (code !== 0) {
                            reject(new Error(`worker exited ${code}`));
                        }
                    });
                    worker.on("message", (message: "ready" | DeliveredResult) => {
                        if (message === "ready") {
                            if (Atomics.load(gate, 0) === 2) {
                                Atomics.store(gate, 1, 1);
                                Atomics.notify(gate, 1);
                            }
                        } else {
                            resolve(message);
                        }
                    });
                }),
        );
        const completed: DeliveredResult[] = await Promise.all(results);
        assert.deepEqual(completed.map((result) => result.replayed).sort(), [false, true]);
        assert.ok(completed.every((result) => result.value.delivered));
        await Promise.all(workers.map((worker) => worker.terminate()));
        const reopened: DatabaseSync = openStore(path);
        try {
            assert.deepEqual(
                once(reopened, "workers", At, () => {
                    throw new Error("must replay");
                }),
                { value: { delivered: true }, replayed: true },
            );
            assert.equal((reopened.prepare("SELECT COUNT(*) AS count FROM effects").get() as unknown as CountRow).count, 1);
        } finally {
            reopened.close();
        }
    } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
        rmSync(directory, { recursive: true, force: true });
    }
});

test("invalid lease durations never mutate persisted locks", () => {
    const db: DatabaseSync = openStore(":memory:");
    try {
        const initial: LockRecord | undefined = acquireLock(db, "resource", "holder", At, 1000);
        assert.ok(initial);
        const invalidDurations: number[] = [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER];
        for (let index: number = 0; index < invalidDurations.length; index += 1) {
            const ttl: number = invalidDurations[index];
            assert.throws(() => acquireLock(db, "new", "holder", At, ttl), RangeError);
            assert.throws(() => renewLock(db, "resource", "holder", initial.fencing, At, ttl), RangeError);
            assert.equal(getLock(db, "new"), undefined);
            assert.deepEqual(getLock(db, "resource"), initial);
        }
        assert.throws(() => acquireLock(db, "new", "holder", "invalid-date"), RangeError);
        assert.throws(() => acquireLock(db, "new", "holder", "+275760-09-13T00:00:00.000Z", 1), RangeError);
    } finally {
        db.close();
    }
});
