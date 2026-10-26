#!/usr/bin/env node
/**
 * Session persistence: SQLite snapshot, restore, and monotonic turn IDs.
 */
import assert from "node:assert/strict";

import { Database } from "../src/database/service/database.ts";
import { SqliteSessionStore } from "../src/database/adapter/sessionStore.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";

const At = "2026-10-24T00:00:00.000Z";
const db = new Database(":memory:");
const agent = db.processService.create({ id: "a.session", name: "Session Agent" }, At);
const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
service.createAgent({ pid: agent.pid, id: "a.session", name: "Session Agent", at: At });
const store = new SqliteSessionStore(db.adapters.sessions);

const reply = (text: string): LlmResponse => ({ text, usage: { inputTokens: 5, outputTokens: 2 }, finishReason: "stop" });

const first = new CognitiveRuntime({
    pid: agent.pid,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm([reply("one"), reply("two")]),
    now: () => At,
    sessionStore: store,
});
const turn1 = await first.respond("first");
const turn2 = await first.respond("second");
assert.equal(turn1.turnId, "rt.1");
assert.equal(turn2.turnId, "rt.2");
const snapshot = store.load(agent.pid);
assert.ok(snapshot);
assert.equal(snapshot.history.length, 2);
assert.equal(snapshot.turnCounter, 2);
assert.equal(snapshot.version, 2);
assert.equal(snapshot.state.cyclesSinceRest, 2);

const restored = RuntimeSession.restore(snapshot);
assert.equal(restored.history.length, 2);
assert.equal(restored.nextTurnId(), "rt.3");

const second = new CognitiveRuntime({
    pid: agent.pid,
    agent: service.agents,
    social: service.social,
    llm: new ScriptedLlm([reply("three")]),
    now: () => At,
    sessionStore: store,
});
const turn3 = await second.respond("third");
assert.equal(turn3.turnId, "rt.3");
const after = store.load(agent.pid);
assert.ok(after);
assert.equal(after.history.length, 3);
assert.equal(after.turnCounter, 3);
assert.equal(store.archive(agent.pid, At), true);
assert.equal(store.load(agent.pid)?.archivedAt, At);
assert.equal(store.delete(agent.pid), true);
assert.equal(store.load(agent.pid), (void 0));

db.close();
console.log("\x1b[32m✓\x1b[0m session state, priors, history and turn IDs persist");
console.log("\x1b[32m✓\x1b[0m session snapshot can be archived and deleted");
console.log("\n2 passed, 0 failed");
