import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../src/database/service/database.ts";
import { applyControlRegistry } from "../src/control/search.ts";
import { catalogSnapshotFixture } from "./helpers/catalogSnapshotFixture.ts";
import { SessionRegistry } from "../src/session/registry.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { SessionControlService } from "../src/control/sessionService.ts";

test("registry overlays update data discovery, preserve executable metadata, and isolate workspaces", () => {
    const db = new Database(":memory:");
    try {
        db.controlService.createWorkspace("other", "Other");
        const global = db.controlService.bind({ workspaceId: "default", allowGlobal: true });
        const workspace = db.controlService.bind({ workspaceId: "default" });
        global.call("global", "adjust", { action: "register", registry: "modules", id: "module.one", value: { name: "Global module" } });
        workspace.call("workspace", "adjust", { action: "update", registry: "modules", id: "module.one", value: { name: "Local module", projectId: "forged", namespace: "forged" } });
        const base = [{ id: "amp_tool_workspace_adjust", kind: "tool", name: "Trusted executable", summary: "Host descriptor", payload: {} }];
        const local = applyControlRegistry(db.controlService, "default", "host-namespace", base, "revision", "host-project");
        assert.equal(local.find(record => record.id === "module.one")?.name, "Local module");
        assert.equal(local.find(record => record.id === "module.one")?.projectId, "host-project");
        assert.equal(local.find(record => record.kind === "tool")?.name, "Trusted executable");
        assert.equal(applyControlRegistry(db.controlService, "other", "other", [], "revision")[0].name, "Global module");
        workspace.call("workspace", "adjust", { action: "remove", registry: "modules", id: "module.one" });
        assert.equal(applyControlRegistry(db.controlService, "default", "host-namespace", local).some(record => record.id === "module.one"), false);
        assert.equal(applyControlRegistry(db.controlService, "other", "other", []).length, 1);
    } finally { db.close(); }
});

test("persisted session tool settings drive the next runtime turn and revocation stops model calls", async () => {
    const db = new Database(":memory:");
    try {
        const identities = new SessionRegistry({ store: db.workspaceSessions });
        const opened = identities.open({ agentId: "runtime", roots: [{ id: "runtime-root", path: process.cwd(), writable: false, exclude: [] }] });
        const control = db.controlService.bind({ workspaceId: opened.descriptor.workspaceId!, sessionId: opened.descriptor.id,
            authenticate: () => { identities.verify(opened.credential.sessionId, opened.credential.token); } });
        const sessionTools = new SessionControlService({ control });
        const agents = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
        agents.createAgent({ pid: 1, id: "runtime", name: "Runtime", values: [], constraints: [], narrative: "Test", at: new Date().toISOString() });
        let requests = 0;
        const runtime = new CognitiveRuntime({ pid: 1, agent: agents.agents, social: agents.social, control,
            llm: { async complete() { requests++; return { text: "Accepted.", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }; } } });
        assert.equal(sessionTools.call("amp_tool_session_interaction", { action: "set", mode: "think" }).ok, true);
        assert.equal(sessionTools.call("amp_tool_session_scenario", { action: "set", scenario: "engineering" }).ok, true);
        const first = await runtime.respond("Please evaluate this design.");
        assert.equal(first.interaction.primary, "think"); assert.deepEqual(first.scenario.active, ["engineering"]);
        assert.equal(sessionTools.call("amp_tool_session_interaction", { action: "set", mode: "converge" }).ok, true);
        const second = await runtime.respond("Please evaluate this design.");
        assert.equal(second.interaction.primary, "converge");
        identities.revoke(opened.descriptor.id);
        await assert.rejects(runtime.respond("Please evaluate this design."), /permission_denied/);
        assert.equal(requests, 2);
    } finally { db.close(); }
});

test("search-only stdio host cannot take over a namespace bound to another workspace", async (t) => {
    let requests = 0;
    const es = createServer((_request, response) => { requests++; response.writeHead(500); response.end("unexpected backend access"); });
    es.listen(0, "127.0.0.1"); await once(es, "listening");
    const address = es.address(); assert.ok(address && typeof address !== "string");
    const directory = await mkdtemp(join(tmpdir(), "amp-control-owner-"));
    t.after(async () => { es.closeAllConnections(); await new Promise<void>(done => es.close(() => done())); await rm(directory, { recursive: true, force: true }); });
    const path = join(directory, "host.sqlite");
    const database = new Database(path);
    database.controlService.createWorkspace("other", "Other");
    database.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("control_search_workspace:owned", "other");
    database.catalogService.replaceSnapshot("owned", [{ id: "keep", kind: "knowledge", name: "Keep", summary: "Owned data", payload: {} }]);
    const generation = database.catalogService.state("owned").generation;
    database.close();
    const config = join(directory, "host.json");
    await writeFile(config, JSON.stringify({ version: 1, agentId: "host-agent", projectIds: [],
        snapshot: { version: 1, revision: "revision", entities: [], relations: [], diagnostics: [] }, contents: {}, frames: [],
        search: { node: `http://127.0.0.1:${address.port}`, index: "control", namespace: "owned", databasePath: "host.sqlite" } }));
    const child = spawn(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", config], { stdio: ["pipe", "ignore", "pipe"] });
    const errors: Buffer[] = []; child.stderr.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
    child.stdin.end();
    const [code] = await once(child, "exit");
    assert.equal(code, 1, Buffer.concat(errors).toString("utf8"));
    const restored = new Database(path);
    try { assert.equal(restored.catalogService.state("owned").generation, generation); }
    finally { restored.close(); }
    assert.equal(requests, 0);
});

test("stdio adjust persists across restart and discovery reflects register/update/remove", async (t) => {
    const remote = catalogSnapshotFixture();
    remote.setSearch((index, request) => {
        const hits = [...index.documents.values()].filter(doc => doc.kind === "module")
            .map(doc => ({ _index: request.path.split("/")[1], _id: doc.id, _score: 1, _source: doc }));
        return { took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: hits.length, relation: "eq" }, max_score: hits.length ? 1 : null, hits } };
    });
    const es = createServer(remote.http);
    es.listen(0, "127.0.0.1"); await once(es, "listening");
    const address = es.address(); assert.ok(address && typeof address !== "string");
    const directory = await mkdtemp(join(tmpdir(), "amp-control-integration-"));
    t.after(async () => { es.closeAllConnections(); await new Promise<void>((done, reject) => es.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); });
    const config = join(directory, "host.json");
    await writeFile(config, JSON.stringify({ version: 1, agentId: "host-agent", projectIds: [],
        snapshot: { version: 1, revision: "revision", entities: [], relations: [], diagnostics: [] }, contents: {}, frames: [],
        control: { databasePath: "host.sqlite" }, search: { node: `http://127.0.0.1:${address.port}`, index: "control", namespace: "control-workspace", databasePath: "host.sqlite" } }));
    const request = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    const run = async (requests: unknown[]): Promise<Array<{ ok: boolean; data: Record<string, any>; error?: unknown }>> => {
        const child = spawn(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", config], { stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk))); child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
        child.stdin.end(requests.map(item => JSON.stringify(item)).join("\n") + "\n");
        const [code] = await once(child, "exit"); assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
        return Buffer.concat(stdout).toString("utf8").trim().split("\n").map(line => { const outer = JSON.parse(line); assert.equal(outer.error, undefined); return JSON.parse(outer.result.content[0].text); });
    };
    const discover = (id: number) => request(id, "amp_tool_workspace_discover", { revision: "revision", queries: "module" });
    const first = await run([
        request(1, "amp_tool_workspace_adjust", { action: "register", registry: "modules", id: "module.test", value: { name: "First module" }, expectedVersion: 0 }),
        discover(2),
        request(3, "amp_tool_workspace_adjust", { action: "update", registry: "modules", id: "module.test", value: { name: "Updated module" }, expectedVersion: 1 }),
        discover(4),
    ]);
    assert.ok(first.every(item => item.ok), JSON.stringify(first));
    assert.equal(first[1].data.trees[0].tree.label, "First module");
    assert.equal(first[3].data.trees[0].tree.label, "Updated module");
    const second = await run([discover(1), request(2, "amp_tool_workspace_adjust", { action: "remove", registry: "modules", id: "module.test", expectedVersion: 2 }), discover(3)]);
    assert.ok(second.every(item => item.ok), JSON.stringify(second));
    assert.equal(second[0].data.trees[0].tree.label, "Updated module");
    assert.deepEqual(second[2].data.trees, []);
});
