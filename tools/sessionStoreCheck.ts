#!/usr/bin/env node
/**
 * Session persistence: SQLite snapshot, restore, and monotonic turn IDs.
 */
import assert from "node:assert/strict";

import type { ProcessEntity } from "../src/database/entity/process.ts";
import { Database } from "../src/database/service/database.ts";
import { SqliteSessionStore } from "../src/database/adapter/sessionStore.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import type { RuntimeTurn } from "../src/runtime/cognitiveRuntime.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";
import type { SessionSnapshot } from "../src/runtime/session.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const Db: Database = new Database(":memory:");
const Agent: ProcessEntity = Db.processService.create({ id: "a.session", name: "Session Agent" }, At);
const Service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
Service.createAgent({ pid: Agent.pid, id: "a.session", name: "Session Agent", at: At });
const Store: SqliteSessionStore = new SqliteSessionStore(Db.adapters.sessions);

const reply: (text: string) => LlmResponse = (text: string): LlmResponse => ({ text, usage: { inputTokens: 5, outputTokens: 2 }, finishReason: "stop" });

const First: CognitiveRuntime = new CognitiveRuntime({
    pid: Agent.pid,
    agent: Service.agents,
    social: Service.social,
    llm: new ScriptedLlm([reply("one"), reply("two")]),
    now: () => At,
    sessionStore: Store,
});
const Turn1: RuntimeTurn = await First.respond("first");
const Turn2: RuntimeTurn = await First.respond("second");
assert.equal(Turn1.turnId, "rt.1");
assert.equal(Turn2.turnId, "rt.2");
const Snapshot: SessionSnapshot | undefined = Store.load(Agent.pid);
assert.ok(Snapshot);
assert.equal(Snapshot.history.length, 2);
assert.equal(Snapshot.turnCounter, 2);
assert.equal(Snapshot.version, 2);
assert.equal(Snapshot.state.cyclesSinceRest, 2);

const Restored: RuntimeSession = RuntimeSession.restore(Snapshot);
assert.equal(Restored.history.length, 2);
assert.equal(Restored.nextTurnId(), "rt.3");

const Second: CognitiveRuntime = new CognitiveRuntime({
    pid: Agent.pid,
    agent: Service.agents,
    social: Service.social,
    llm: new ScriptedLlm([reply("three")]),
    now: () => At,
    sessionStore: Store,
});
const Turn3: RuntimeTurn = await Second.respond("third");
assert.equal(Turn3.turnId, "rt.3");
const After: SessionSnapshot | undefined = Store.load(Agent.pid);
assert.ok(After);
assert.equal(After.history.length, 3);
assert.equal(After.turnCounter, 3);
assert.equal(Store.archive(Agent.pid, At), true);
assert.equal(Store.load(Agent.pid)?.archivedAt, At);
assert.equal(Store.delete(Agent.pid), true);
assert.equal(Store.load(Agent.pid), (void 0));

Db.close();
console.log("\x1b[32m✓\x1b[0m session state, priors, history and turn IDs persist");
console.log("\x1b[32m✓\x1b[0m session snapshot can be archived and deleted");
console.log("\n2 passed, 0 failed");
