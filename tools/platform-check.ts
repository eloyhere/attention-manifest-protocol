#!/usr/bin/env node
/**
 * Platform checks: database services, Proxy caches, context window, mission
 * queue, leases, evidence graph, progress, goal lifecycle and module ports.
 */
import assert from "node:assert/strict";

import { assembleContext } from "../src/context/index.ts";
import { EntityCache, configureStore, database, processStore, shutdownStore, threadStore } from "../src/store/index.ts";
import { ContextWindow } from "../src/window/index.ts";
import { WindowError } from "../src/error/windowError.ts";
import { MissionQueue } from "../src/mission/index.ts";
import { acquireLock, getLock, releaseLock, renewLock } from "../src/lock/index.ts";
import { EvidenceGraph } from "../src/evidence/index.ts";
import { checkpointProgress, computeProgress } from "../src/progress/index.ts";
import { createGoalLifecycle, transitionGoal } from "../src/goal/index.ts";
import { DeniedSandbox, ScriptedLlm, ToolRegistry } from "../src/module/index.ts";
import type { Goal } from "../src/goal/plan.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const Later: string = "2026-10-24T01:00:00.000Z";

let passed: number = 0;
let failed: number = 0;
const tasks: Array<() => Promise<void>> = [];

const test = (name: string, fn: () => void | Promise<void>): void => {
    tasks.push(async (): Promise<void> => {
        try {
            await fn();
            passed += 1;
            console.log(`\x1b[32m✓\x1b[0m ${name}`);
        } catch (error) {
            failed += 1;
            const message: string = error instanceof Error ? error.message : `${error}`;
            console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
        }
    });
};

test("services cover the entities one-to-one", () => {
    const db = configureStore(":memory:");
    for (const key of [
        "objectService",
        "processService",
        "threadService",
        "handleService",
        "messageService",
        "workerService",
        "stepService",
        "windowService",
    ] as const) {
        assert.equal(typeof(db[key]), "object", `missing ${key}`);
    }
    const process = db.processService.create(
        {
            id: "a.store.1",
            name: "Store Agent",
            budget: { calls: 10 },
        },
        At,
    );
    assert.equal(process.state, "created");
    assert.equal(db.processService.byPublicId("a.store.1")?.pid, process.pid);

    const thread = db.threadService.spawn(
        {
            pid: process.pid,
            goal: "g.store.1",
            statement: "read through the store",
            success: [{ id: "c.store.1", statement: "cache hit", check: "stats" }],
        },
        At,
    );
    assert.equal(db.threadService.byProcess(process.pid).length, 1);

    const object = db.objectService.put("claim", "cl.store.1", { statement: "缓存是读穿层" }, At);
    assert.equal(db.objectService.byId(object.seq)?.id, "cl.store.1");

    const other = db.processService.create({ id: "a.store.2", name: "Second Agent" }, At);
    const message = db.messageService.send({
        id: "m.store.1",
        fromPid: process.pid,
        fromTid: thread.tid,
        toPid: other.pid,
        kind: "event",
        body: { hello: true },
        at: At,
    });
    assert.equal(db.messageService.pendingCount(other.pid), 1);
    assert.equal(db.messageService.markDelivered(message.msg_id, "rc.m.1", Later), 1);

    db.windowService.save(thread.tid, 100, 0, At);
    assert.equal(db.windowService.get(thread.tid)?.capacity_tokens, 100);
    shutdownStore();
});

test("Proxy cache reads through, hits, invalidates", () => {
    const db = configureStore(":memory:");
    const process = db.processService.create({ id: "a.cache.1", name: "Cache Agent" }, At);
    const first = processStore.get(process.pid);
    const second = processStore.get(process.pid);
    assert.ok(first);
    assert.equal(first, second);
    assert.equal(processStore.stats().loads, 1);
    assert.equal(processStore.stats().hits >= 1, true);
    assert.equal(processStore.entities[`${process.pid}`], first);
    processStore.invalidate(process.pid);
    const third = processStore.get(process.pid);
    assert.ok(third);
    assert.equal(processStore.stats().loads, 2);
    threadStore.invalidate();
    shutdownStore();
});

test("EntityCache respects TTL and LRU capacity", () => {
    let clock: number = 0;
    let loads: number = 0;
    const cache = new EntityCache<{ id: string }>({
        load: (key) => {
            loads += 1;
            return { id: key };
        },
        keyOf: (value) => value.id,
        capacity: 1,
        ttlMs: 10,
        now: () => clock,
    });
    cache.get("1");
    cache.get("1");
    assert.equal(loads, 1);
    clock = 20;
    cache.get("1");
    assert.equal(loads, 2);
    cache.get("2");
    assert.equal(cache.stats().evictions >= 1, true);
    cache.get("1");
    assert.equal(loads, 4);
});

test("context window evicts LRU, protects pinned pages and assembles context", () => {
    const window = new ContextWindow({ capacityTokens: 100, maxPages: 2, now: () => 1 });
    window.fault("claim", "cl.1", 60);
    window.fault("claim", "cl.2", 50);
    assert.equal(window.has("claim", "cl.1"), false);
    assert.equal(window.usedTokens, 50);
    assert.equal(window.stats().evictions, 1);
    window.pin("claim", "cl.2");
    assert.throws(
        () => window.fault("claim", "cl.3", 60),
        (error: unknown) => error instanceof WindowError && error.code === "window_full",
    );
    window.unpin("claim", "cl.2");
    window.fault("claim", "cl.3", 40);
    const assembly = assembleContext(window, 70);
    assert.equal(assembly.tokens <= 70, true);
    assert.equal(assembly.segments.length >= 1, true);
});

test("mission queue orders by priority, then arrival", () => {
    const queue = new MissionQueue(() => 0);
    queue.enqueue(1, 1);
    queue.enqueue(2, 5);
    queue.enqueue(3, 5);
    assert.equal(queue.size, 3);
    assert.equal(queue.dequeue(), 2);
    assert.equal(queue.dequeue(), 3);
    assert.equal(queue.dequeue(), 1);
    assert.equal(queue.dequeue(), (void 0));
});

test("leases exclude another holder and fence after expiry", () => {
    const db = configureStore(":memory:").db;
    const first = acquireLock(db, "file:a", "w-a", At, 1000);
    assert.ok(first);
    assert.equal(first?.fencing, 1);
    assert.equal(acquireLock(db, "file:a", "w-b", At, 1000), (void 0));
    const second = acquireLock(db, "file:a", "w-b", Later, 1000);
    assert.ok(second);
    assert.equal(second?.fencing, 2);
    assert.equal(renewLock(db, "file:a", "w-b", second?.fencing ?? 0, Later, 1000), true);
    assert.equal(releaseLock(db, "file:a", "w-b", second?.fencing ?? 0), true);
    assert.equal(getLock(db, "file:a"), (void 0));
    shutdownStore();
});

test("evidence graph links support and rejects cycles", () => {
    const graph = new EvidenceGraph();
    graph.addClaim("cl.1", "the deploy caused the spike");
    graph.addEvidence("ev.1", "5xx rose after deploy", "cl.1", "verified");
    assert.deepEqual(graph.evidenceFor("cl.1"), ["ev.1"]);
    assert.deepEqual(graph.claimsFor("ev.1"), ["cl.1"]);
    assert.throws(() => graph.link("cl.1", "ev.1"), /cycle/);
    assert.equal(graph.size, 2);
});

test("progress is computed from the store and checkpointed", () => {
    const db = configureStore(":memory:");
    const process = db.processService.create({ id: "a.progress.1", name: "Progress Agent" }, At);
    const thread = db.threadService.spawn(
        {
            pid: process.pid,
            goal: "g.progress.1",
            statement: "finish the task",
            success: [{ id: "c.p.1", statement: "task done", check: "inspect" }],
        },
        At,
    );
    const claim = db.threadService.claim(thread.tid, "w-test");
    db.threadService.transition(thread.tid, ["running"], "done", { finishedAt: At }, claim.lease);
    const snapshot = computeProgress(db.db, process.pid);
    assert.equal(snapshot.totalThreads, 1);
    assert.equal(snapshot.doneThreads, 1);
    assert.equal(snapshot.percent, 100);
    const checkpoint = checkpointProgress(db.db, process.pid, At);
    assert.match(checkpoint.checkpoint ?? "", /^pg\./);
    shutdownStore();
});

test("goal lifecycle only moves along legal edges", () => {
    const goal: Goal = {
        amp: "0.1",
        kind: "goal",
        id: "g.1",
        statement: "ship the kernel",
        success: [{ id: "c.1", statement: "tests pass", check: "verify" }],
        value: 1,
        priority: 1,
    };
    let lifecycle = createGoalLifecycle(goal);
    lifecycle = transitionGoal(lifecycle, "committed", At);
    lifecycle = transitionGoal(lifecycle, "active", At);
    lifecycle = transitionGoal(lifecycle, "achieved", Later);
    assert.equal(lifecycle.state, "achieved");
    assert.throws(() => transitionGoal(lifecycle, "active", Later), /not an edge/);
});

test("module ports are usable and the sandbox refuses by default", async () => {
    const llm = new ScriptedLlm([{ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }]);
    const response = await llm.complete({ model: "test", messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.text, "ok");
    assert.equal(llm.calls, 1);

    const registry = new ToolRegistry();
    registry.register({ name: "logs.query", description: "query", inputSchema: { type: "object" } });
    assert.equal(registry.get("logs.query")?.name, "logs.query");
    assert.throws(() => registry.register({ name: "logs.query", description: "dup", inputSchema: {} }), /duplicate/);

    await assert.rejects(new DeniedSandbox().run({ command: "rm" }), /sandbox_unavailable/);
});

for (const task of tasks) await task();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
