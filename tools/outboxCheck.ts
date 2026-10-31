#!/usr/bin/env node
/**
 * Persistent runtime receipt sink: outbox write, pending read, dispatch.
 */
import assert from "node:assert/strict";

import { Database } from "../src/database/service/database.ts";
import { OutboxRuntimeReceiptSink } from "../src/database/adapter/runtimeSink.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";

const At = "2026-10-24T00:00:00.000Z";
const db = new Database(":memory:");
const agent = db.processService.create({ id: "a.outbox", name: "Outbox Agent" }, At);
const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({ pid: agent.pid, id: "a.outbox", name: "Outbox Agent", at: At });
const sink = new OutboxRuntimeReceiptSink(db.adapters.outbox);
const runtime = new CognitiveRuntime({
    pid: agent.pid,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm([{ text: "answer", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" }]),
    now: () => At,
    receiptSink: sink,
});
const turn = await runtime.respond("question");
assert.equal(db.adapters.outbox.countPending(), 1);
const pending = db.adapters.outbox.pending();
assert.equal(pending.length, 1);
assert.equal(pending[0].topic, "runtime.receipt");
const payload = JSON.parse(pending[0].payload) as { id: string; outcome: string; usage: { inputTokens: number } };
assert.equal(payload.id, turn.receiptId);
assert.equal(payload.outcome, "success");
assert.equal(payload.usage.inputTokens, 10);
assert.equal(db.adapters.outbox.markDispatched([pending[0].id], At), 1);
assert.equal(db.adapters.outbox.countPending(), 0);
assert.equal(db.adapters.outbox.byTopic("runtime.receipt").length, 1);

const approvalId = db.adapters.outbox.write("runtime.approval", { risk: "destructive", status: "denied" }, At);
assert.equal(db.adapters.outbox.markDispatched([approvalId], At), 1);
assert.equal(db.adapters.outbox.byTopic("runtime.approval").length, 1);
assert.equal(db.adapters.outbox.pruneDispatched("2026-10-25T00:00:00.000Z"), 2);
assert.equal(db.adapters.outbox.byTopic("runtime.receipt").length, 0);
assert.equal(db.adapters.outbox.byTopic("runtime.approval").length, 0);
db.close();
console.log("\x1b[32m✓\x1b[0m runtime receipt is written to the outbox and dispatched");
console.log("\x1b[32m✓\x1b[0m approval topic is queryable and retention prunes dispatched rows");
console.log("\n1 passed, 0 failed");
