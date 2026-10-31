#!/usr/bin/env node
/**
 * Kernel-backed runtime checks: one cognitive turn = one task step, with
 * kernel lease, receipt, hash-chained runtime.turn object, and exact task
 * selection.
 */
import assert from "node:assert/strict";

import { Database } from "../src/database/service/database.ts";
import type { ProcessEntity } from "../src/database/entity/process.ts";
import type { OutboxEntity } from "../src/database/entity/outbox.ts";
import type { RuntimeApprovalRow } from "../src/database/entity/runtimeApproval.ts";
import { outboxEventSink } from "../src/database/adapter/runtimeSink.ts";
import { AgentService } from "../src/process/index.ts";
import { spawnThread, getThread } from "../src/thread/thread.ts";
import type { ThreadRecord } from "../src/thread/thread.ts";
import { Kernel } from "../src/kernel/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import type { ToolExecutor, ToolResult } from "../src/module/tool/tool.ts";
import { RiskToolPolicy } from "../src/module/tool/policy.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { KernelRuntime } from "../src/runtime/kernelRuntime.ts";
import type { KernelRuntimeTurn } from "../src/runtime/kernelRuntime.ts";
import { getObject } from "../src/database/store/database.ts";
import type { ObjectRow } from "../src/database/store/database.ts";

type TestCase = (name: string, fn: () => Promise<void>) => void;

type NamedTest = [string, () => Promise<void>];

type Fixture = {
    db: Database;
    process: ProcessEntity;
    service: AgentService;
    work: ThreadRecord;
};

type LlmResponseFactory = (text: string, inputTokens?: number, outputTokens?: number) => LlmResponse;

type AnswerBody = {
    answer: string;
};

type ReceiptPayload = {
    task: number;
    turnId: string;
};

type ApprovalPayload = {
    risk: string;
    status: string;
    turnId: string;
};

const At: string = "2026-10-24T00:00:00.000Z";
let Passed: number = 0;
let Failed: number = 0;
const Tests: NamedTest[] = [];
const test: TestCase = (name: string, fn: () => Promise<void>): void => {
    Tests.push([name, fn]);
};

const llmResponse: LlmResponseFactory = (text: string, inputTokens: number = 30, outputTokens: number = 12): LlmResponse => ({
    text,
    usage: { inputTokens, outputTokens },
    finishReason: "stop",
});

const setup: () => Fixture = (): Fixture => {
    const db: Database = new Database(":memory:");
    const process: ProcessEntity = db.processService.create({ id: "a.kernel.runtime", name: "Kernel Runtime Agent", budget: { calls: 100 } }, At);
    const service: AgentService = new AgentService(db.adapters.agents, db.adapters.social);
    service.createAgent({
        pid: process.pid,
        id: "a.kernel.runtime",
        name: "Kernel Runtime Agent",
        values: ["truth"],
        narrative: "I keep evidence and answers in the same ledger.",
        at: At,
    });
    service.remember({ pid: process.pid, kind: "procedural", content: "Run the failing test first.", salience: 0.9, at: At });
    service.setAffect(process.pid, { stress: 0.3, fatigue: 0.2, mood: "focused" }, At);
    const work: ThreadRecord = spawnThread(
        db.db,
        {
            pid: process.pid,
            goal: "g.kernel.runtime",
            statement: "answer the user",
            success: [{ id: "c.kernel.runtime", statement: "answer recorded", check: "inspect" }],
        },
        At,
    );
    return { db, process, service, work };
};

test("one runtime turn is one kernel task with receipt and object", async () => {
    const { db, process, work }: Fixture = setup();
    const llm: ScriptedLlm = new ScriptedLlm([llmResponse("I hear the pressure. Let's identify the single blocker first.")]);
    const cognitive: CognitiveRuntime = new CognitiveRuntime({
        pid: process.pid,
        agent: db.adapters.agents,
        social: db.adapters.social,
        llm,
        budgetTokens: 500,
        now: () => At,
    });
    const kernel: Kernel = new Kernel(db.db, { now: () => At, leaseMs: 60_000 });
    const runtime: KernelRuntime = new KernelRuntime({ kernel, cognitive });
    const result: KernelRuntimeTurn = await runtime.runTask(work.tid, "I'm overwhelmed and need this now!");
    assert.ok(result);
    assert.equal(result.report.status, "done");
    assert.equal(result.turn.answer.length > 0, true);
    assert.equal(result.turn.answerScore !== (void 0), true);
    assert.equal(getThread(db.db, work.tid).state, "done");
    assert.equal(db.processService.byId(process.pid)?.state, "idle");
    const object: ObjectRow = getObject(db.db, "runtime.turn", result.objectId);
    assert.ok(object);
    assert.equal((JSON.parse(object.body) as AnswerBody).answer.length > 0, true);
    assert.ok(getObject(db.db, "receipt", result.receiptId));
    assert.equal(result.report.usage.tokens ?? 0, 42);
    kernel.close();
    db.close();
});

test("runTask targets the requested task, not the next ready one", async () => {
    const { db, process, work }: Fixture = setup();
    const second: ThreadRecord = spawnThread(
        db.db,
        {
            pid: process.pid,
            goal: "g.kernel.runtime.2",
            statement: "second task",
            success: [{ id: "c.kernel.runtime.2", statement: "answer recorded", check: "inspect" }],
        },
        At,
    );
    const llm: ScriptedLlm = new ScriptedLlm([llmResponse("second answer")]);
    const cognitive: CognitiveRuntime = new CognitiveRuntime({
        pid: process.pid,
        agent: db.adapters.agents,
        social: db.adapters.social,
        llm,
        now: () => At,
    });
    const kernel: Kernel = new Kernel(db.db, { now: () => At, leaseMs: 60_000 });
    const runtime: KernelRuntime = new KernelRuntime({ kernel, cognitive });
    const result: KernelRuntimeTurn = await runtime.runTask(second.tid, "answer the second task");
    assert.ok(result);
    assert.equal(getThread(db.db, second.tid).state, "done");
    assert.equal(getThread(db.db, work.tid).state, "ready");
    kernel.close();
    db.close();
});

test("kernel event sink writes runtime receipt in the task commit", async () => {
    const { db, process, work }: Fixture = setup();
    const llm: ScriptedLlm = new ScriptedLlm([llmResponse("atomic answer")]);
    const cognitive: CognitiveRuntime = new CognitiveRuntime({
        pid: process.pid,
        agent: db.adapters.agents,
        social: db.adapters.social,
        llm,
        now: () => At,
    });
    const kernel: Kernel = new Kernel(db.db, { now: () => At, leaseMs: 60_000, eventSink: outboxEventSink });
    const runtime: KernelRuntime = new KernelRuntime({ kernel, cognitive });
    const result: KernelRuntimeTurn = await runtime.runTask(work.tid, "answer atomically");
    assert.ok(result);
    const pending: OutboxEntity[] = db.adapters.outbox.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].topic, "runtime.receipt");
    const payload: ReceiptPayload = JSON.parse(pending[0].payload) as ReceiptPayload;
    assert.equal(payload.task, work.tid);
    assert.equal(payload.turnId, result.turn.turnId);
    kernel.close();
    db.close();
});

test("kernel event sink writes a separate approval audit event", async () => {
    const { db, process, work }: Fixture = setup();
    const registry: ToolRegistry = new ToolRegistry().register({
        name: "deploy.rollback",
        description: "rollback production",
        inputSchema: { type: "object" },
        risk: "destructive",
    });
    let executed: number = 0;
    const executor: ToolExecutor = {
        async execute(): Promise<ToolResult> {
            executed += 1;
            return { ok: true, content: "rolled back" };
        },
    };
    const llm: ScriptedLlm = new ScriptedLlm([
        {
            text: "",
            usage: { inputTokens: 8, outputTokens: 2 },
            finishReason: "tool_call",
            toolCalls: [{ id: "call-approval", name: "deploy.rollback", arguments: "{}" }],
        },
        llmResponse("approval required"),
    ]);
    const cognitive: CognitiveRuntime = new CognitiveRuntime({
        pid: process.pid,
        agent: db.adapters.agents,
        social: db.adapters.social,
        llm,
        now: () => At,
        tools: registry,
        toolExecutor: executor,
        toolPolicy: new RiskToolPolicy(),
    });
    const kernel: Kernel = new Kernel(db.db, { now: () => At, leaseMs: 60_000, eventSink: outboxEventSink });
    const runtime: KernelRuntime = new KernelRuntime({ kernel, cognitive });
    const result: KernelRuntimeTurn = await runtime.runTask(work.tid, "rollback production");
    assert.ok(result);
    assert.equal(executed, 0);
    const pending: OutboxEntity[] = db.adapters.outbox.pending();
    assert.equal(
        pending.some((event) => event.topic === "runtime.receipt"),
        true,
    );
    const approval: OutboxEntity = pending.find((event) => event.topic === "runtime.approval");
    assert.ok(approval);
    const payload: ApprovalPayload = JSON.parse(approval.payload) as ApprovalPayload;
    assert.equal(payload.risk, "destructive");
    assert.equal(payload.status, "denied");
    assert.equal(payload.turnId, result.turn.turnId);
    const approvals: RuntimeApprovalRow[] = db.adapters.approvals.list(process.pid);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].status, "denied");
    assert.equal(approvals[0].tool, "deploy.rollback");
    assert.equal(db.adapters.approvals.prune("2026-10-25T00:00:00.000Z"), 1);
    assert.equal(db.adapters.approvals.list(process.pid).length, 0);
    kernel.close();
    db.close();
});

test("runTask returns undefined when the target task is not ready", async () => {
    const { db, process, work }: Fixture = setup();
    const llm: ScriptedLlm = new ScriptedLlm([]);
    const cognitive: CognitiveRuntime = new CognitiveRuntime({
        pid: process.pid,
        agent: db.adapters.agents,
        social: db.adapters.social,
        llm,
        now: () => At,
    });
    const kernel: Kernel = new Kernel(db.db, { now: () => At, leaseMs: 60_000 });
    const runtime: KernelRuntime = new KernelRuntime({ kernel, cognitive });
    await runtime.runTask(work.tid, "first");
    const second: KernelRuntimeTurn = await runtime.runTask(work.tid, "again");
    assert.equal(second, (void 0));
    kernel.close();
    db.close();
});

for (let i: number = 0; i < Tests.length; i += 1) {
    const [name, fn]: NamedTest = Tests[i];
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
