#!/usr/bin/env node
/**
 * Turn persistence: session-linked turn snapshots with actions/operations.
 */
import assert from "node:assert/strict";

import { Database } from "../src/database/service/database.ts";
import { SqliteTurnStore } from "../src/database/adapter/turnStore.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";
import { replayStoredTurn } from "../src/runtime/replay.ts";

const At = "2026-10-24T00:00:00.000Z";
const db = new Database(":memory:");
const agent = db.processService.create({ id: "a.turn", name: "Turn Agent" }, At);
const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({ pid: agent.pid, id: "a.turn", name: "Turn Agent", at: At });
const store = new SqliteTurnStore(db.adapters.turns);
const runtime = new CognitiveRuntime({
    pid: agent.pid,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm([{ text: "answer", usage: { inputTokens: 8, outputTokens: 2 }, finishReason: "stop" }]),
    now: () => At,
    session: new RuntimeSession({ id: "session.check" }),
    turnStore: store,
});
const turn = await runtime.respond("question");
assert.equal(turn.sessionId, "session.check");
assert.equal(turn.actions !== undefined, true);
assert.equal(turn.operations !== undefined, true);
const stored = store.get(turn.turnId);
assert.ok(stored);
assert.equal(stored.turnId, turn.turnId);
assert.equal(stored.sessionId, "session.check");
assert.equal(stored.actions?.[0].intent !== undefined, true);
assert.equal(
    stored.operations?.some((operation) => operation.kind === "llm.complete"),
    true,
);
assert.equal(store.list(agent.pid).length, 1);
const replay = replayStoredTurn(store, turn.turnId);
assert.equal(replay.actions.length > 0, true);
assert.equal(
    replay.operations.some((operation) => operation.kind === "llm.complete"),
    true,
);
db.close();
console.log("\x1b[32m✓\x1b[0m turn snapshot persists session/actions/operations");
console.log("\x1b[32m✓\x1b[0m persisted turn replays a valid action/operation graph");
console.log("\n1 passed, 0 failed");
