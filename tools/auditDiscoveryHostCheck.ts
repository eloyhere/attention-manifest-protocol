#!/usr/bin/env node
/** Final module-4 audit. Stateful fixture only; no running Elasticsearch required. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import { Database } from "../src/database/service/database.ts";
import { catalogKey } from "../src/database/entity/catalog.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import type { DiscoverySearch, DiscoverySearchNode } from "../src/discover/types.ts";
import { GlobalAgentService } from "../src/global/service.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import { ToolIds } from "../src/naming/index.ts";
import { CatalogSearch } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import { projectSearchRecords } from "../src/search/projection.ts";
import { catalogSnapshotFixture } from "./helpers/catalogSnapshotFixture.ts";

const namespace = "final-host-audit";
const revision = "r1";
const snapshot: WorkspaceSnapshot = { version: 1, revision, entities: ["p-a", "p-b"].map(id => ({
    id, kind: "project", projectId: id, label: id, summary: "", source: { uri: id, revision },
})), relations: [], diagnostics: [] };
const row = (id: string, projectId?: string, rev = revision, targets: string[] = []): CatalogRecord => ({
    id, kind: "file", name: id, summary: "metadata", ...(projectId === undefined ? {} : { projectId, revision: rev }),
    payload: { content: "PRIVATE_BODY" }, relations: targets.map(targetId => ({ relation: "ref", targetId })),
});
const nodes = (node: DiscoverySearchNode): DiscoverySearchNode[] => [node, ...node.children.flatMap(nodes)];
const serviceFor = (search: DiscoverySearch, maxToolCalls = 1000) => new WorkspaceAgentService({
    agentId: "audit", snapshot, projectIds: ["p-a"], store: new MemoryContentStore(), search, limits: { maxToolCalls },
});
const errorCode = (response: { ok: boolean; error?: { code: string } }) => response.error?.code;
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };

async function fixture(t: TestContext, records: CatalogRecord[]) {
    const db = new Database(":memory:");
    const wire = catalogSnapshotFixture();
    const catalog = new CatalogSearch({ namespace, catalog: db.catalogService, cache: db.catalogStore,
        search: new ElasticsearchSearch({ client: wire.fakeClient }) });
    catalog.replaceSnapshot(records);
    await catalog.sync();
    t.after(async () => { await catalog.close(); db.close(); });
    return { catalog, wire };
}

test("hostile wire hits and edges cannot widen project, revision, global or namespace scope", async t => {
    const foreign = catalogKey("foreign", "file", "outside");
    const records = [row("root", "p-a", revision, ["allowed", "private", "stale", "global", foreign]),
        row("allowed", "p-a"), row("private", "p-b"), row("stale", "p-a", "r0"), row("global"), row(foreign, "p-a")];
    const { catalog } = await fixture(t, records);
    const scoped = await catalog.discover({ projectIds: ["p-a"] }, "q", { revision });
    const root = scoped.trees.find(tree => tree.tree.id === "root")!;
    assert.deepEqual(nodes(root.tree).map(node => node.id), ["root", "allowed"]);
    assert.equal(root.truncated, true);
    assert.ok(scoped.trees.every(tree => nodes(tree.tree).every(node => node.projectId === "p-a")));
    const globalOnly = await catalog.discover({ projectIds: [], includeGlobal: true }, "q", { revision });
    assert.deepEqual(globalOnly.trees.map(tree => tree.tree.id), ["global"]);
    const response = await serviceFor(catalog).callAsync(ToolIds.workspaceDiscover, { revision, queries: "q" });
    assert.equal(response.ok, true);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_BODY|\"id\":\"private\"|\"id\":\"stale\"/);
});

test("cycle, diamond, depth zero and width obey per-tree budgets", async t => {
    const { catalog } = await fixture(t, [row("a", "p-a", revision, ["a", "b", "c"]),
        row("b", "p-a", revision, ["d"]), row("c", "p-a", revision, ["d"]), row("d", "p-a", revision, ["a"])]);
    for (const nodeLimit of [1, 2, 3, 5]) {
        const result = await catalog.discover({ projectIds: ["p-a"] }, "q", { revision, nodeLimit });
        assert.ok(result.trees.every(tree => nodes(tree.tree).length <= nodeLimit));
        assert.ok(result.trees.every(tree => tree.truncated));
        assert.ok(result.trees.every(tree => tree.tree.children.filter(child => child.id === "b").length <= 1));
    }
    const zero = await catalog.discover({ projectIds: ["p-a"] }, "q", { revision, maxDepth: 0 });
    assert.ok(zero.trees.every(tree => tree.tree.children.length === 0 && tree.truncated));
});

test("malformed discover arguments and authority injection fail before search", async () => {
    let calls = 0;
    const service = serviceFor({ async discover() { calls++; return { trees: [] }; } });
    const invalid = [null, [], {}, { queries: [] }, { queries: ["q", 42] }, { queries: " " },
        { queries: "q", projectIds: ["p-b"] }, { queries: "q", includeGlobal: true }, { queries: "q", scope: {} },
        { queries: "q", nodeLimit: 201 }, { queries: "q", maxDepth: 13 }, { queries: "q", limit: 0 },
        { queries: "q", kinds: [false] }, { queries: "q", tags: Array(33).fill("x") }];
    for (const args of invalid) {
        const raw = args !== null && !Array.isArray(args) ? { revision, ...args } : args;
        assert.equal(errorCode(await service.callAsync(ToolIds.workspaceDiscover, raw)), "invalid_arguments");
    }
    assert.equal(errorCode(await service.callAsync(ToolIds.workspaceDiscover, { revision: "r0", queries: "q" })), "revision_mismatch");
    assert.equal(calls, 0);
});

test("array-index accessors in tool arguments are rejected without execution", async () => {
    let getters = 0; let searches = 0;
    const queries: string[] = [];
    Object.defineProperty(queries, "0", { enumerable: true, get() { getters++; return "q"; } });
    const service = serviceFor({ async discover() { searches++; return { trees: [] }; } });
    assert.equal(errorCode(await service.callAsync(ToolIds.workspaceDiscover, { revision, queries })), "invalid_arguments");
    assert.equal(getters, 0);
    assert.equal(searches, 0);
});

test("Unicode query length is consistent with advertised schema", async t => {
    const { catalog, wire } = await fixture(t, []);
    const service = serviceFor(catalog);
    const response = await service.callAsync(ToolIds.workspaceDiscover, { revision, queries: "😀".repeat(300) });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(wire.requests.filter(request => request.path.endsWith("/_search")).length, 1);
    assert.equal(errorCode(await service.callAsync(ToolIds.workspaceDiscover, { revision, queries: "😀".repeat(513) })), "invalid_arguments");
});

test("whitespace metadata filters reject as invalid_arguments before search", async t => {
    const { catalog, wire } = await fixture(t, []);
    const service = serviceFor(catalog);
    const before = wire.requests.length;
    for (const filter of [{ kinds: [" "] }, { tags: ["\t"] }]) {
        assert.equal(errorCode(await service.callAsync(ToolIds.workspaceDiscover, { revision, queries: "q", ...filter })), "invalid_arguments");
    }
    assert.equal(wire.requests.length, before);
});

test("projection rejects lossy array properties and indexed accessors without getter execution", () => {
    let getters = 0;
    const indexed: unknown[] = [];
    Object.defineProperty(indexed, "0", { enumerable: true, get() { getters++; return "q"; } });
    const extra = Object.assign([1], { extra: "lost" });
    const extraGetter = [1];
    Object.defineProperty(extraGetter, "extra", { enumerable: true, get() { getters++; return "lost"; } });
    for (const invalid of [indexed, extra, extraGetter]) {
        assert.throws(() => projectSearchRecords({ namespace, records: [{ ...row("x"), payload: { invalid } }] }), TypeError);
    }
    assert.equal(getters, 0);
});

test("projection rejects duplicate source tuples and preserves allowed detached repeated arrays", () => {
    const shared = [1];
    const source = row("x"); source.payload = { a: shared, b: shared };
    const output = projectSearchRecords({ namespace, records: [source] });
    assert.notEqual(output[0].payload.a, output[0].payload.b);
    assert.throws(() => projectSearchRecords({ namespace, records: [source, { ...source, projectId: "p-b" }] }), /duplicate/);
    assert.deepEqual(shared, [1]);
});

test("global wrapper narrows projects and keeps async call budget and sanitized failures", async () => {
    const calls: unknown[] = [];
    const global = new GlobalAgentService({ agentId: "global", snapshot, projectIds: ["p-a"], store: new MemoryContentStore(),
        limits: { maxToolCalls: 2 }, search: { async discover(scope, _query, options) { calls.push({ scope, options }); throw new Error("https://user:secret@private.host"); } } });
    assert.equal(errorCode(await global.callAsync("amp_tool_global_discover", { revision, queries: "q", projectIds: ["p-b"] })), "invalid_arguments");
    const failed = await global.callAsync("amp_tool_global_discover", { revision, queries: "q" });
    assert.equal(errorCode(failed), "search_failed");
    assert.doesNotMatch(JSON.stringify(failed), /secret|private\.host/);
    assert.deepEqual(calls, [{ scope: { projectIds: ["p-a"], includeGlobal: true }, options: { revision } }]);
    assert.equal(errorCode(await global.callAsync("amp_tool_global_discover", { revision, queries: "q" })), "budget_exhausted");
});

test("MCP notifications and malformed envelopes do not execute or spend tool calls", async () => {
    let calls = 0;
    const server = new WorkspaceMcpServer(serviceFor({ async discover() { calls++; return { trees: [] }; } }, 1));
    const params = { name: ToolIds.workspaceDiscover, arguments: { revision, queries: "q" }, _meta: meta };
    assert.equal(await server.handleAsync({ jsonrpc: "2.0", method: "tools/call", params }), undefined);
    for (const raw of [[], null, { jsonrpc: "2.0", id: null, method: "ping" }, { jsonrpc: "2.0", id: 1.5, method: "ping" },
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: [] }]) {
        assert.equal((await server.handleAsync(raw))?.error?.code, -32600);
    }
    assert.equal(calls, 0);
    const valid = await server.handleAsync({ jsonrpc: "2.0", id: 2, method: "tools/call", params });
    assert.equal((valid?.result as { isError: boolean }).isError, false);
    assert.equal(calls, 1);
});

async function stdio(t: TestContext, config: unknown, input: string) {
    const directory = await mkdtemp(join(tmpdir(), "amp-final-discovery-"));
    t.after(async () => { await rm(directory, { recursive: true, force: true }); });
    const configPath = join(directory, "host.json");
    await writeFile(configPath, JSON.stringify(config));
    const child = spawn(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => child.kill(), 15_000);
    t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
    child.stdin.end(input);
    const [code] = await once(child, "close");
    clearTimeout(timer);
    return { code, stderr: Buffer.concat(stderr).toString("utf8"), responses: Buffer.concat(stdout).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

test("stdio recovers after oversized and malformed lines and handles final unterminated request", async t => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping", params: { _meta: meta } });
    const result = await stdio(t, { version: 1, agentId: "audit", projectIds: [], snapshot: { ...snapshot, entities: [] }, contents: {}, frames: [] },
        `${"x".repeat(1024 * 1024 + 1)}\n{bad\n${JSON.stringify({ jsonrpc: "2.0", method: "ping" })}\n${ping}`);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.responses.map(response => response.error?.code ?? response.id), [-32600, -32700, 7]);
    assert.equal(result.stderr, "");
});

test("stdio bootstrap errors are sanitized and malformed authority is rejected", async t => {
    const result = await stdio(t, { version: 1, agentId: "audit", projectIds: ["PRIVATE_AUTHORITY"], snapshot, contents: {}, frames: [],
        search: { node: "file:///SECRET_ENDPOINT", index: "index", namespace, databasePath: "catalog.sqlite" } }, "");
    assert.equal(result.code, 1);
    assert.deepEqual(result.responses, []);
    assert.match(result.stderr, /workspace server failed/);
    assert.doesNotMatch(result.stderr, /SECRET_ENDPOINT|PRIVATE_AUTHORITY|file:/);
});

test("stdio async backend errors remain sanitized and retain response ordering", async t => {
    const remote = catalogSnapshotFixture();
    remote.setSearch(() => { throw new Error("SECRET_BACKEND_CREDENTIAL"); });
    const server = createServer(remote.http);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const lines = [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: meta, name: ToolIds.workspaceDiscover, arguments: { revision, queries: "q" } } },
        { jsonrpc: "2.0", id: 2, method: "ping", params: { _meta: meta } },
    ].map(line => JSON.stringify(line)).join("\n") + "\n";
    const result = await stdio(t, { version: 1, agentId: "audit", projectIds: [], snapshot: { ...snapshot, entities: [] }, contents: {}, frames: [],
        search: { node: `http://127.0.0.1:${address.port}`, index: "audit", namespace, databasePath: "catalog.sqlite" } }, lines);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.responses.map(response => response.id), [1, 2]);
    assert.equal(JSON.parse(result.responses[0].result.content[0].text).error.code, "search_failed");
    assert.doesNotMatch(JSON.stringify(result), /SECRET_BACKEND_CREDENTIAL/);
    assert.ok(remote.requests.some(request => request.path.endsWith("/_search")));
});
