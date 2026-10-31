#!/usr/bin/env node
/**
 * Turn persistence: session-linked turn snapshots with actions/operations.
 */
import assert from "node:assert/strict";

import type { ProcessEntity } from "../src/database/entity/process.ts";
import { Database } from "../src/database/service/database.ts";
import { SqliteTurnStore } from "../src/database/adapter/turnStore.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import type { RuntimeTurn } from "../src/runtime/cognitiveRuntime.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";
import type { ReplayedTurn } from "../src/runtime/replay.ts";
import { replayStoredTurn } from "../src/runtime/replay.ts";

const At: string = "2026-10-24T00:00:00.000Z";
const Db: Database = new Database(":memory:");
const Agent: ProcessEntity = Db.processService.create({ id: "a.turn", name: "Turn Agent" }, At);
const Service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
Service.createAgent({ pid: Agent.pid, id: "a.turn", name: "Turn Agent", at: At });
const Store: SqliteTurnStore = new SqliteTurnStore(Db.adapters.turns);
const Runtime: CognitiveRuntime = new CognitiveRuntime({
    pid: Agent.pid,
    agent: Service.agents,
    social: Service.social,
    llm: new ScriptedLlm([{ text: "answer", usage: { inputTokens: 8, outputTokens: 2 }, finishReason: "stop" }]),
    now: () => At,
    session: new RuntimeSession({ id: "session.check" }),
    turnStore: Store,
});
const Turn: RuntimeTurn = await Runtime.respond("question");
assert.equal(Turn.sessionId, "session.check");
assert.equal(Turn.actions !== (void 0), true);
assert.equal(Turn.operations !== (void 0), true);
const Stored: RuntimeTurn | undefined = Store.get(Turn.turnId);
assert.ok(Stored);
assert.equal(Stored.turnId, Turn.turnId);
assert.equal(Stored.sessionId, "session.check");
assert.equal(Stored.actions?.[0].intent !== (void 0), true);
assert.equal(
    Stored.operations?.some((operation) => operation.kind === "llm.complete"),
    true,
);
assert.equal(Store.list(Agent.pid).length, 1);
const Replay: ReplayedTurn = replayStoredTurn(Store, Turn.turnId);
assert.equal(Replay.actions.length > 0, true);
assert.equal(
    Replay.operations.some((operation) => operation.kind === "llm.complete"),
    true,
);
Db.close();
console.log("\x1b[32m✓\x1b[0m turn snapshot persists session/actions/operations");
console.log("\x1b[32m✓\x1b[0m persisted turn replays a valid action/operation graph");
console.log("\n1 passed, 0 failed");
