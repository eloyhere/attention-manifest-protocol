import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../src/database/service/database.ts";
import { applyControlRegistry } from "../src/control/search.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { SessionControlService } from "../src/control/sessionService.ts";

import { ToolRegistry } from "../src/module/tool/tool.ts";
import type { LlmClient, LlmResponse } from "../src/module/llm/llm.ts";
import { catalogKey } from "../src/database/entity/catalog.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";

const answer = (): LlmResponse => ({ text: "Accepted.", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" });
const fixture = () => {
    const db = new Database(":memory:");
    const identities = new SessionRegistry({ store: db.workspaceSessions });
    const opened = identities.open({ agentId: "audit-runtime", roots: [{ id: "audit-root", path: process.cwd(), writable: false, exclude: [] }] });
    const control = db.controlService.bind({ workspaceId: opened.descriptor.workspaceId!, sessionId: opened.descriptor.id,
        authenticate: () => { identities.verify(opened.credential.sessionId, opened.credential.token); } });
    const sessionTools = new SessionControlService({ control });
    const agents = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    agents.createAgent({ pid: 1, id: "audit-runtime", name: "Audit", values: [], constraints: [], narrative: "Test", at: new Date().toISOString() });
    return { db, control, sessionTools, agents };
};

test("SQLite controls: explicit runtime override wins for one turn; reset restores workspace then global inheritance", async () => {
    const { db, control, sessionTools, agents } = fixture();
    try {
        const global = db.controlService.bind({ workspaceId: "default", allowGlobal: true });
        global.call("global", "interaction", { action: "set", mode: "inspire" });
        global.call("global", "scenario", { action: "set", scenario: "research" });
        control.call("workspace", "interaction", { action: "set", mode: "think" });
        control.call("workspace", "scenario", { action: "set", scenario: "engineering" });
        assert.equal(sessionTools.call("amp_tool_session_interaction", { action: "set", mode: "converge" }).ok, true);
        assert.equal(sessionTools.call("amp_tool_session_scenario", { action: "set", scenario: "writing" }).ok, true);
        const runtime = new CognitiveRuntime({ pid: 1, agent: agents.agents, social: agents.social, control,
            interactionMix: { affect: 1 }, scenarioMix: { chat: 1 }, llm: { async complete() { return answer(); } } });
        const explicit = await runtime.respond("Evaluate this design.", { interactionMix: { orchestrate: 1 }, scenarioMix: { office: 1 } });
        assert.equal(explicit.interaction.primary, "orchestrate");
        assert.deepEqual(explicit.scenario.active, ["office"]);
        const selected = await runtime.respond("Evaluate this design.");
        assert.equal(selected.interaction.primary, "converge");
        assert.deepEqual(selected.scenario.active, ["writing"]);
        for (const name of ["amp_tool_session_interaction", "amp_tool_session_scenario"]) {
            const reset = sessionTools.call(name, { action: "reset" });
            assert.equal(reset.ok, true);
            if (reset.ok) assert.equal(reset.data.source, "workspace");
        }
        const workspace = await runtime.respond("Evaluate this design.");
        assert.equal(workspace.interaction.primary, "think");
        assert.deepEqual(workspace.scenario.active, ["engineering"]);
        for (const domain of ["interaction", "scenario"] as const) {
            control.call("workspace", domain, { action: "reset" });
            assert.equal(control.call("session", domain, { action: "get" }).source, "global");
        }
        const inherited = await runtime.respond("Evaluate this design.");
        assert.equal(inherited.interaction.primary, "inspire");
        assert.deepEqual(inherited.scenario.active, ["research"]);
        for (const domain of ["interaction", "scenario"] as const) global.call("global", domain, { action: "reset" });
        const fallback = await runtime.respond("Evaluate this design.");
        assert.equal(fallback.interaction.primary, "affect");
        assert.deepEqual(fallback.scenario.active, ["chat"]);
    } finally { db.close(); }
});

test("settings changed through session tools during a pending model request or model tool round apply on the next turn", { timeout: 10_000 }, async () => {
    const { db, control, sessionTools, agents } = fixture();
    // Explicit barriers avoid sleeps and establish that mutation happens after
    // the runtime has taken its turn snapshot and entered the model request.
    let entered!: () => void, release!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const prompts: string[] = [];
    let requests = 0;
    try {
        assert.equal(sessionTools.call("amp_tool_session_interaction", { action: "set", mode: "think" }).ok, true);
        assert.equal(sessionTools.call("amp_tool_session_scenario", { action: "set", scenario: "engineering" }).ok, true);
        const tools = new ToolRegistry();
        for (const tool of sessionTools.tools()) tools.register(tool);
        const llm: LlmClient = { async complete(request) {
            prompts.push(request.messages[0].content);
            if (++requests === 1) {
                entered();
                await resume;
                return { ...answer(), text: "", finishReason: "tool_call", toolCalls: [{ id: "set-scenario", name: "amp_tool_session_scenario",
                    arguments: JSON.stringify({ action: "set", scenario: "writing" }) }] };
            }
            return answer();
        } };
        const runtime = new CognitiveRuntime({ pid: 1, agent: agents.agents, social: agents.social, control, llm, tools,
            toolExecutor: { async execute(invocation) {
                const result = sessionTools.call(invocation.tool, invocation.args);
                return { ok: result.ok, content: JSON.stringify(result) };
            } } });
        const pending = runtime.respond("Evaluate this design.");
        await requested;
        assert.equal(sessionTools.call("amp_tool_session_interaction", { action: "set", mode: "converge" }).ok, true);
        release();
        const first = await pending;
        assert.equal(first.interaction.primary, "think");
        assert.deepEqual(first.scenario.active, ["engineering"]);
        assert.equal(first.toolCalls?.length, 1);
        assert.equal(first.toolCalls?.[0].ok, true);
        assert.equal(prompts[0], prompts[1], "tool continuation must retain this turn's system prompt");
        const next = await runtime.respond("Evaluate this design.");
        assert.equal(next.interaction.primary, "converge");
        assert.deepEqual(next.scenario.active, ["writing"]);
        assert.notEqual(prompts[2], prompts[0]);
        assert.equal(requests, 3);
    } finally { release(); db.close(); }
});

test("registry disabled entries, tombstones and links stay isolated by workspace, kind and host namespace", () => {
    const db = new Database(":memory:");
    try {
        db.controlService.createWorkspace("other", "Other");
        const global = db.controlService.bind({ workspaceId: "default", allowGlobal: true });
        const local = db.controlService.bind({ workspaceId: "default" });
        for (const id of ["disabled", "removed", "source", "target"]) {
            global.call("global", "adjust", { action: "register", registry: "modules", id, value: { name: `Global ${id}` } });
        }
        global.call("global", "adjust", { action: "link", registry: "modules", id: "source", relation: "depends", targetId: "target" });
        local.call("workspace", "adjust", { action: "update", registry: "modules", id: "disabled", value: { status: "disabled" } });
        local.call("workspace", "adjust", { action: "remove", registry: "modules", id: "removed" });
        local.call("workspace", "adjust", { action: "unlink", registry: "modules", id: "source", relation: "depends", targetId: "target" });
        // Even a fully formed foreign catalog key must be treated as a literal
        // registry ID, and then wrapped in this host's namespace and kind.
        const foreign = catalogKey("other-namespace", "tool", "target");
        local.call("workspace", "adjust", { action: "link", registry: "modules", id: "source", relation: "depends", targetId: foreign });
        local.call("workspace", "adjust", { action: "update", registry: "modules", id: "source",
            value: { name: "Local source", namespace: "forged", projectId: "forged", relations: [{ relation: "depends", targetId: foreign }] } });
        const base: CatalogRecord[] = [
            { id: "disabled", kind: "module", name: "Base disabled", summary: "", payload: {} },
            { id: "removed", kind: "module", name: "Base removed", summary: "", payload: {} },
            { id: "source", kind: "tool", name: "Trusted executable", summary: "Host descriptor", payload: { host: true } },
        ];
        const before = structuredClone(base);
        const projected = applyControlRegistry(db.controlService, "default", "host-namespace", base, "revision", "host-project");
        assert.equal(projected.some(record => record.kind === "module" && ["disabled", "removed"].includes(record.id)), false);
        assert.deepEqual(projected.find(record => record.kind === "tool"), before[2]);
        const source = projected.find(record => record.kind === "module" && record.id === "source")!;
        assert.equal(source.name, "Local source");
        assert.equal(source.projectId, "host-project");
        assert.equal(source.revision, "revision");
        assert.deepEqual(source.relations, [{ relation: "depends", targetId: catalogKey("host-namespace", "module", foreign) }]);
        const other = applyControlRegistry(db.controlService, "other", "other-namespace", []);
        assert.equal(other.find(record => record.id === "disabled")?.name, "Global disabled");
        assert.equal(other.find(record => record.id === "removed")?.name, "Global removed");
        assert.deepEqual(other.find(record => record.id === "source")?.relations,
            [{ relation: "depends", targetId: catalogKey("other-namespace", "module", "target") }]);
        assert.deepEqual(base, before, "projection must not mutate host records");
        // Re-projecting an already materialized snapshot must not resurrect
        // entries hidden by disabled overlays or removal tombstones.
        assert.deepEqual(applyControlRegistry(db.controlService, "default", "host-namespace", projected, "revision", "host-project"), projected);
    } finally { db.close(); }
});
