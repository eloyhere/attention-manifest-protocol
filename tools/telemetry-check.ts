#!/usr/bin/env node
/**
 * Telemetry source + attention update check.
 */
import assert from "node:assert/strict";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";
import { NodeTelemetry, StaticTelemetry } from "../src/runtime/telemetry.ts";

const At = "2026-10-24T00:00:00.000Z";
const staticTelemetry = new StaticTelemetry({ systemLoad: 0.9, eventLoopLagMs: 100, memoryMb: 123, errorRate: 0.2 });
assert.equal(staticTelemetry.sample().systemLoad, 0.9);

const nodeTelemetry = new NodeTelemetry();
const sample = nodeTelemetry.sample();
assert.equal(Number.isFinite(sample.systemLoad), true);
assert.equal(Number.isFinite(sample.eventLoopLagMs), true);
nodeTelemetry.close();

const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({ pid: 1, id: "a.telemetry", name: "Telemetry Agent", at: At });
const session = new RuntimeSession();
const runtime = new CognitiveRuntime({
    pid: 1,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm([{ text: "answer", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" }]),
    now: () => At,
    telemetry: staticTelemetry,
    session,
});
const turn = await runtime.respond("question");
assert.equal(turn.telemetry?.systemLoad, 0.9);
assert.equal(session.state.stress > 0.2, true);
assert.equal(session.state.fatigue > 0.2, true);

console.log("\x1b[32m✓\x1b[0m static/node telemetry sample and attention update");
console.log("\n1 passed, 0 failed");
