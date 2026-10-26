#!/usr/bin/env node
/**
 * Kernel checks under the corrected model: a process is an agent, a thread is
 * a task/goal. An agent is alive across tasks, runs one task at a time, and
 * returns to idle when the current task ends.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Kernel } from "../src/kernel/index.ts";
import type { StepHandler } from "../src/kernel/index.ts";
import { KernelError } from "../src/error/kernelError.ts";
import { createProcess, getProcess, listProcesses, terminateProcess } from "../src/process/process.ts";
import { AgentService } from "../src/process/index.ts";
import { AgentRepository } from "../src/database/repository/agentRepository.ts";
import { SocialRepository } from "../src/database/repository/socialRepository.ts";
import { claimThread, getThread, listThreads, nextReadyThread, spawnThread } from "../src/thread/thread.ts";
import { getObject, openStore, tableNames, verifyObjectChain } from "../src/database/store/database.ts";
import type { CognitiveState } from "../src/attention/cognition.ts";
import { planAttention, processAttention } from "../src/attention/resource.ts";

const At: string = "2026-10-24T00:00:00.000Z";

let passed: number = 0;
let failed: number = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed += 1;
        console.log(`\x1b[32m\u2713\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m\u2717\x1b[0m ${name}\n      ${message}`);
    }
};

const rejects =
    (code: string) =>
    (error: unknown): boolean =>
        error instanceof KernelError && error.code === code;

const agent = (db: ReturnType<typeof openStore>, id = "a.gamma", budget = { calls: 100 }) => {
    return createProcess(db, { id, name: "Gamma", role: "on-call analyst", budget }, At);
};

const task = (db: ReturnType<typeof openStore>, pid: number, goal: string, budget = {}) => {
    return spawnThread(
        db,
        {
            pid,
            goal,
            statement: `finish ${goal}`,
            success: [{ id: "c.task.1", statement: "task outcome observed", check: "observe" }],
            budget,
        },
        At,
    );
};

test("schema has agents/tasks and the one-running-task-per-agent index", () => {
    const db = openStore(":memory:");
    const names: string[] = tableNames(db);
    for (const table of ["processes", "threads", "steps", "process_objects"]) assert.equal(names.includes(table), true);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(version.value, "4");
    db.close();
});

test("an agent starts created and a task starts ready", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    assert.equal(gamma.state, "created");
    const work = task(db, gamma.pid, "g.incident.1");
    assert.equal(work.state, "ready");
    assert.equal(nextReadyThread(db)?.tid, work.tid);
    assert.equal(listThreads(db, gamma.pid).length, 1);
    db.close();
});

test("a yield step leaves the agent idle and the task ready", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    const work = task(db, gamma.pid, "g.yield.1");
    const kernel = new Kernel(db, { now: () => At });
    const report = kernel.step(() => ({ status: "yield", usage: { tokens: 100 } }));
    assert.ok(report);
    assert.equal(report.status, "yield");
    assert.equal(report.usage.calls, 1);
    assert.equal(getThread(db, work.tid).state, "ready");
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    assert.equal(getProcess(db, gamma.pid).used.tokens, 100);
    const receipt = getObject(db, "receipt", report.receiptId);
    assert.ok(receipt);
    assert.equal((JSON.parse(receipt.body) as { outcome: string }).outcome, "success");
    assert.equal(verifyObjectChain(db).ok, true);
    db.close();
});

test("a sleeping task blocks the agent until its wake time", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    const work = task(db, gamma.pid, "g.sleep.1");
    let now: number = Date.parse(At);
    const kernel = new Kernel(db, { now: () => new Date(now).toISOString() });
    let calls: number = 0;
    const handler: StepHandler = () => {
        calls += 1;
        if (calls === 1) return { status: "sleep", wakeAt: new Date(now + 60_000).toISOString() };
        return { status: "done" };
    };
    const first = kernel.step(handler);
    assert.ok(first);
    assert.equal(first.status, "sleep");
    assert.equal(getThread(db, work.tid).state, "blocked");
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    assert.equal(kernel.step(handler), (void 0));
    now += 61_000;
    const second = kernel.step(handler);
    assert.ok(second);
    assert.equal(second.status, "done");
    assert.equal(getThread(db, work.tid).state, "done");
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    db.close();
});

test("a task without success criteria is rejected", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    assert.throws(() => spawnThread(db, { pid: gamma.pid, goal: "g.bad", statement: "x", success: [] }, At), rejects("invalid_thread"));
    db.close();
});

test("task budget exhaustion fails the task, not the agent", () => {
    const db = openStore(":memory:");
    const gamma = agent(db, "a.taskbudget", { calls: 100 });
    const work = task(db, gamma.pid, "g.taskbudget", { calls: 1 });
    const kernel = new Kernel(db, { now: () => At });
    const first = kernel.step(() => ({ status: "yield" }));
    assert.ok(first);
    assert.equal(first.status, "yield");
    const second = kernel.step(() => ({ status: "yield" }));
    assert.ok(second);
    assert.equal(second.status, "fail");
    assert.equal(getThread(db, work.tid).state, "failed");
    assert.match(getThread(db, work.tid).exitNote ?? "", /task budget/);
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    db.close();
});

test("agent budget exhaustion suspends the agent and fails the task", () => {
    const db = openStore(":memory:");
    const gamma = agent(db, "a.agentbudget", { calls: 1 });
    const work = task(db, gamma.pid, "g.agentbudget", { calls: 100 });
    const kernel = new Kernel(db, { now: () => At });
    const first = kernel.step(() => ({ status: "yield" }));
    assert.ok(first);
    const second = kernel.step(() => ({ status: "yield" }));
    assert.ok(second);
    assert.equal(second.status, "fail");
    assert.equal(getProcess(db, gamma.pid).state, "suspended");
    assert.equal(getProcess(db, gamma.pid).exitCode, "BUDGET");
    assert.equal(getThread(db, work.tid).state, "failed");
    db.close();
});

test("one agent runs one task at a time, then picks up the next", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    const first = task(db, gamma.pid, "g.one");
    const second = task(db, gamma.pid, "g.two");
    const kernel = new Kernel(db, { now: () => At });
    const reportA = kernel.step(() => ({ status: "done" }));
    assert.ok(reportA);
    assert.equal(getThread(db, first.tid).state, "done");
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    const reportB = kernel.step(() => ({ status: "done" }));
    assert.ok(reportB);
    assert.equal(getThread(db, second.tid).state, "done");
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    db.close();
});

test("a second running task for the same agent is rejected by the store", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    const first = task(db, gamma.pid, "g.one");
    const second = task(db, gamma.pid, "g.two");
    claimThread(db, first.tid, "w-a");
    assert.throws(() => claimThread(db, second.tid, "w-b"));
    db.close();
});

test("duplicate active task for the same goal is rejected", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    task(db, gamma.pid, "g.same");
    assert.throws(() => task(db, gamma.pid, "g.same"), rejects("duplicate_task"));
    db.close();
});

test("terminated agents have no outgoing transition", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    terminateProcess(db, gamma.pid, "done for now", At);
    assert.throws(() => terminateProcess(db, gamma.pid, "again", At), rejects("invalid_transition"));
    db.close();
});

test("crash recovery re-queues a running task and idles the agent", () => {
    const file: string = join(tmpdir(), `amp-kernel-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    try {
        const first = openStore(file);
        const gamma = agent(first, "a.recover", { calls: 100 });
        const work = task(first, gamma.pid, "g.recover");
        first.exec("UPDATE threads SET state = 'running'");
        first.exec("UPDATE processes SET state = 'running'");
        first.close();

        const second = openStore(file);
        const kernel = new Kernel(second, { now: () => At });
        const recovered = kernel.recover();
        assert.equal(recovered.threads, 1);
        assert.equal(getThread(second, work.tid).state, "ready");
        assert.equal(getProcess(second, gamma.pid).state, "idle");
        second.close();
    } finally {
        rmSync(file, { force: true });
        rmSync(`${file}-wal`, { force: true });
        rmSync(`${file}-shm`, { force: true });
    }
});

test("the object chain detects a tampered body", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    task(db, gamma.pid, "g.tamper");
    const kernel = new Kernel(db, { now: () => At });
    kernel.step(() => ({ status: "yield" }));
    assert.equal(verifyObjectChain(db).ok, true);
    db.exec("UPDATE objects SET body = '{}' WHERE seq = 1");
    assert.equal(verifyObjectChain(db).ok, false);
    db.close();
});

test("file stores open in WAL mode and list agents by state", () => {
    const file: string = join(tmpdir(), `amp-wal-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    try {
        const db = openStore(file);
        const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        assert.equal(mode.journal_mode, "wal");
        agent(db, "a.wal");
        assert.equal(listProcesses(db, "created").length, 1);
        assert.equal(listProcesses(db, "idle").length, 0);
        db.close();
    } finally {
        rmSync(file, { force: true });
        rmSync(`${file}-wal`, { force: true });
        rmSync(`${file}-shm`, { force: true });
    }
});

test("the kernel injects the agent context without knowing storage", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    const service = new AgentService(new AgentRepository(db), new SocialRepository(db));
    service.createAgent({
        id: "a.gamma",
        pid: gamma.pid,
        name: "Gamma Person",
        values: ["truth"],
        narrative: "I am the agent running this task.",
        at: At,
    });
    task(db, gamma.pid, "g.agent-context");
    const kernel = new Kernel(db, {
        now: () => At,
        agentContext: (pid) => service.assemble(pid, { tokens: 400 }),
    });
    const report = kernel.step((context) => {
        assert.equal(context.agentContext?.profile.name, "Gamma Person");
        assert.equal(context.agentContext?.activeRole?.role.label, "self");
        assert.equal(context.agentContext?.segments[0]?.kind, "self");
        return { status: "done" };
    });
    assert.ok(report);
    assert.equal(report.status, "done");
    assert.equal(getProcess(db, gamma.pid).state, "idle");
    kernel.close();
    db.close();
});

test("the kernel exposes process and thread attention", () => {
    const db = openStore(":memory:");
    const gamma = agent(db);
    const work = task(db, gamma.pid, "g.attention");
    const state: CognitiveState = {
        load: 0.2,
        vigilance: 0.9,
        arousal: 0.1,
        mastery: 0.7,
        accountability: 0.5,
        cyclesSinceRest: 0,
        capacityEff: 4,
        pLapse: 0.1,
        source: "default",
        samples: 0,
    };
    const kernel = new Kernel(db, {
        now: () => At,
        attention: (pid, current) => {
            const process = processAttention(pid, state);
            return planAttention(process, [{ tid: current.tid, pid, priority: current.priority, preferredSlots: 2 }]);
        },
    });
    const report = kernel.step((context) => {
        assert.equal(context.attention?.foreground?.tid, work.tid);
        assert.equal(context.attention?.process.safetySlots, 1);
        assert.equal(context.attention?.rest, false);
        return { status: "done" };
    });
    assert.ok(report);
    assert.equal(report.status, "done");
    kernel.close();
    db.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
