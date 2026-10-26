#!/usr/bin/env node
/**
 * Telemetry source + attention update check.
 */
import assert from "node:assert/strict";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import type { RuntimeTurn } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";
import { NodeTelemetry, StaticTelemetry } from "../src/runtime/telemetry.ts";
import type { TelemetrySample } from "../src/runtime/telemetry.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const StaticSource: StaticTelemetry = new StaticTelemetry({ systemLoad: 0.9, eventLoopLagMs: 100, memoryMb: 123, errorRate: 0.2 });
assert.equal(StaticSource.sample().systemLoad, 0.9);

const NodeSource: NodeTelemetry = new NodeTelemetry();
const Sample: TelemetrySample = NodeSource.sample();
assert.equal(Number.isFinite(Sample.systemLoad), true);
assert.equal(Number.isFinite(Sample.eventLoopLagMs), true);
NodeSource.close();

const Service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
Service.createAgent({ pid: 1, id: "a.telemetry", name: "Telemetry Agent", at: At });
const Session: RuntimeSession = new RuntimeSession();
const Runtime: CognitiveRuntime = new CognitiveRuntime({
    pid: 1,
    agent: Service.agents,
    social: Service.social,
    llm: new ScriptedLlm([{ text: "answer", usage: { inputTokens: 10, outputTokens: 2 }, finishReason: "stop" }]),
    now: () => At,
    telemetry: StaticSource,
    session: Session,
});
const Turn: RuntimeTurn = await Runtime.respond("question");
assert.equal(Turn.telemetry?.systemLoad, 0.9);
assert.equal(Session.state.stress > 0.2, true);
assert.equal(Session.state.fatigue > 0.2, true);

console.log("\x1b[32m✓\x1b[0m static/node telemetry sample and attention update");
console.log("\n1 passed, 0 failed");
