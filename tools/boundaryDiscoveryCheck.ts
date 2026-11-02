#!/usr/bin/env node
/** Adversarial boundary probes for Elasticsearch-backed discover; implementation is read-only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client } from "@elastic/elasticsearch";
import { Database } from "../src/database/service/database.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { CatalogSearch, catalogSearchId } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import type { SearchScope } from "../src/search/types.ts";
import { parseToolCall } from "../src/boundary/toolCall.ts";
import { ToolIds } from "../src/naming/index.ts";
import { workspaceToolDefinitions } from "../src/protocol/workspace.ts";
import { catalogSnapshotFixture } from "./helpers/catalogSnapshotFixture.ts";

interface Json { [key: string]: any; }
const NS = "boundary";
const projectScope: SearchScope = { projectIds: ["p-a"] };
const entry = (id: string, projectId = "p-a", relations: CatalogRecord["relations"] = [], kind = "file"): CatalogRecord => ({
    id, kind, name: `${projectId}:${id}`, summary: "summary", projectId, revision: "r1", payload: {}, tags: [], searchTerms: [], relations,
});
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};

async function fixture(t: TestContext) {
    const db = new Database(":memory:");
    const remote = catalogSnapshotFixture();
    const wire = remote.requests;
    let rawHits: Json[] = [];
    let total: unknown = { value: 0, relation: "eq" };
    let searchReplyGate: (() => Promise<void>) | undefined;
    remote.setSearch(async () => {
        await searchReplyGate?.();
        return { took: 3, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total, hits: rawHits } };
    });
    const server = createServer(remote.http);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client({ node: `http://127.0.0.1:${address.port}`, maxRetries: 0, requestTimeout: 3000 });
    const adapter = new ElasticsearchSearch({ client });
    const catalog = new CatalogSearch({ namespace: NS, catalog: db.catalogService, cache: db.catalogStore, search: adapter });
    t.after(async () => {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        db.close();
    });
    const hit = (record: CatalogRecord, overrides: Json = {}): Json => ({ _id: catalogSearchId(NS, record.kind, record.id), _score: 1,
        _source: { id: catalogSearchId(NS, record.kind, record.id), kind: record.kind, title: record.name, summary: record.summary,
            ...(record.projectId === undefined ? {} : { projectId: record.projectId }), ...(record.revision === undefined ? {} : { revision: record.revision }), ...overrides } });
    const sync = async (records: CatalogRecord[]): Promise<void> => { catalog.replaceSnapshot(records); await catalog.sync(); };
    return { db, catalog, adapter, wire, hit, sync,
        setHits(hits: Json[], count: unknown = { value: hits.length, relation: "eq" }) { rawHits = hits; total = count; },
        gateSearch(gate?: () => Promise<void>) { searchReplyGate = gate; } };
}

test("ambiguous raw relation ID across authorized projects is not expanded", async (t) => {
    const f = await fixture(t);
    const root = entry("root", "p-a", [{ relation: "references", targetId: "same" }]);
    const a = entry("same", "p-a", [], "file");
    const b = entry("same", "p-b", [], "symbol");
    await f.sync([root, a, b]);
    f.setHits([f.hit(root)]);
    const result = await f.catalog.discover({ projectIds: ["p-a", "p-b"] }, "root");
    assert.deepEqual(result.trees[0].tree.children, []);
    assert.equal(result.trees[0].truncated, true, "ambiguous raw target is not resolved to either project");
});

test("foreign composite relation targets are not reinterpreted as raw IDs", async (t) => {
    const f = await fixture(t);
    const encodedForeign = JSON.stringify(["some-other-namespace", "file", "victim"]);
    const root = entry("root", "p-a", [{ relation: "references", targetId: encodedForeign }]);
    const victim = entry("victim", "p-a");
    const coincidentalRawId = entry(encodedForeign, "p-a");
    await f.sync([root, victim, coincidentalRawId]);
    f.setHits([f.hit(root)]);
    const result = await f.catalog.discover(projectScope, "root");
    assert.deepEqual(result.trees[0].tree.children, []);
    assert.equal(result.trees[0].truncated, true);
});

test("same namespace and kind duplicate business ID is rejected across projects", async (t) => {
    const f = await fixture(t);
    assert.throws(() => f.catalog.replaceSnapshot([entry("same", "p-a"), entry("same", "p-b")]), /duplicate catalog record/);
});

test("discover schema and CatalogSearch reject whitespace text before Elasticsearch", async (t) => {
    const definition = workspaceToolDefinitions().find((tool) => tool.name === ToolIds.workspaceDiscover)!;
    for (const queries of ["   ", ["ok", "\t\n"]]) assert.throws(() => parseToolCall(definition, { revision: "r1", queries }));
    const f = await fixture(t);
    await f.sync([entry("one")]);
    const before = f.wire.length;
    await assert.rejects(() => f.catalog.discover(projectScope, "   "), /nonempty queries/);
    assert.equal(f.wire.length, before);
});

test("hostile ES totals and excess hits fail closed", async (t) => {
    const f = await fixture(t);
    const records = Array.from({ length: 4 }, (_, i) => entry(`doc-${i}`));
    await f.sync(records);
    for (const total of [{ value: -19, relation: "eq" }, { value: 4, relation: "bogus" }]) {
        f.setHits([f.hit(records[0])], total);
        await assert.rejects(() => f.catalog.discover(projectScope, "q", { limit: 1 }), /invalid total/);
    }
    f.setHits(records.map((record) => f.hit(record)), { value: 4, relation: "eq" });
    await assert.rejects(() => f.catalog.discover(projectScope, "q", { limit: 1 }), /hit limit/);
});

test("SQLite remains authoritative for hit labels and hostile metadata bodies", async (t) => {
    const f = await fixture(t);
    const doc = entry("doc");
    await f.sync([doc]);
    f.setHits([f.hit(doc, { title: "attacker label", summary: "attacker summary", content: "secret body", projectId: "p-a", revision: "r1" })]);
    const result = await f.catalog.discover(projectScope, "q");
    assert.equal(result.trees[0].tree.label, doc.name);
    assert.equal(result.trees[0].tree.summary, doc.summary);
    assert.doesNotMatch(JSON.stringify(result), /attacker|secret body/);
});

test("wide adjacency stays bounded per tree and deep chains honor requested depth", async (t) => {
    const f = await fixture(t);
    const leaves = Array.from({ length: 8 }, (_, i) => entry(`leaf-${i}`));
    const root = entry("root", "p-a", leaves.map((leaf) => ({ relation: "child", targetId: leaf.id })));
    const chain = [entry("d0", "p-a", [{ relation: "child", targetId: "d1" }]), entry("d1", "p-a", [{ relation: "child", targetId: "d2" }]), entry("d2")];
    await f.sync([root, ...leaves, ...chain]);
    f.setHits([f.hit(root), f.hit(chain[0])]);
    const result = await f.catalog.discover(projectScope, "q", { nodeLimit: 3, maxDepth: 1 });
    assert.deepEqual(result.trees.map((tree) => tree.tree.id), ["root", "d0"]);
    assert.ok(result.trees.every((tree) => flatten(tree.tree).length <= 3));
    assert.equal(flatten(result.trees[1].tree).length, 2);
    assert.equal(result.trees[1].truncated, true);
});

const flatten = (node: { children: any[] }): any[] => [node, ...node.children.flatMap(flatten)];

test("replace during query rejects stale result; close queues behind operation and blocks later calls", async (t) => {
    const f = await fixture(t);
    const a = entry("a");
    await f.sync([a]);
    f.setHits([f.hit(a)]);
    const entered = deferred();
    const release = deferred();
    f.gateSearch(async () => { entered.resolve(); await release.promise; });
    const discovery = f.catalog.discover(projectScope, "q");
    await entered.promise;
    f.catalog.replaceSnapshot([entry("b")]);
    release.resolve();
    await assert.rejects(discovery, /changed during discovery/);
    f.gateSearch();
    await f.catalog.sync();
    const holdClose = deferred();
    const closeEntered = deferred();
    f.gateSearch(async () => { closeEntered.resolve(); await holdClose.promise; });
    const running = f.catalog.discover(projectScope, "close race");
    await closeEntered.promise;
    const closeResult = f.catalog.close();
    const queuedAfterClose = assert.rejects(f.catalog.discover(projectScope, "after close queued"), /closed/);
    holdClose.resolve();
    await running;
    await closeResult;
    await queuedAfterClose;
    await assert.rejects(f.catalog.discover(projectScope, "after close"), /closed/);
});

test("scope is explicit, empty scopes are transport-free, and project IDs are not widened", async (t) => {
    const f = await fixture(t);
    const a = entry("a");
    const b = entry("b", "p-b");
    await f.sync([a, b]);
    f.setHits([f.hit(a), f.hit(b)]);
    const before = f.wire.length;
    const empty = await f.catalog.discover({ projectIds: [] }, "q");
    assert.deepEqual(empty.trees, []);
    assert.equal(f.wire.length, before);
    const scoped = await f.catalog.discover(projectScope, "q");
    assert.deepEqual(scoped.trees.map((tree) => tree.tree.id), ["a"]);
    const request = f.wire.findLast((item) => item.path.endsWith("/_search"))!;
    assert.deepEqual(request.body.query.bool.filter[0].bool.should[0].terms.projectId, ["p-a"]);
});

test("stdio preserves response order and sends only service-derived project/global scope", async (t) => {
    const remote = catalogSnapshotFixture();
    const requests = remote.requests;
    remote.setSearch(() => ({ took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: 0, relation: "eq" }, hits: [] } }));
    const es = createServer(remote.http);
    es.listen(0, "127.0.0.1");
    await once(es, "listening");
    const address = es.address();
    assert.ok(address && typeof address !== "string");
    const directory = await mkdtemp(join(tmpdir(), "amp-boundary-discover-"));
    t.after(async () => {
        es.closeAllConnections();
        await new Promise<void>((resolveClose, reject) => es.close((error) => error ? reject(error) : resolveClose()));
        await rm(directory, { recursive: true, force: true });
    });
    const config = join(directory, "host.json");
    await writeFile(config, JSON.stringify({ version: 1, agentId: "a.boundary", projectIds: [],
        snapshot: { version: 1, revision: "r1", entities: [], relations: [], diagnostics: [] }, contents: {}, frames: [],
        search: { node: `http://127.0.0.1:${address.port}`, index: "boundary", namespace: "stdio", databasePath: "catalog.sqlite" } }));
    const child = spawn(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", config], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    const stateless = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const lines = [
        { jsonrpc: "2.0", id: 1, method: "ping", params: stateless },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { ...stateless, name: "amp_tool_workspace_discover", arguments: { revision: "r1", queries: "q" } } },
        { jsonrpc: "2.0", id: 3, method: "ping", params: stateless },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
    child.stdin.end(lines);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
    assert.equal(signal, null);
    const responses = Buffer.concat(stdout).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(responses.map((response) => response.id), [1, 2, 3]);
    const search = requests.find((request) => request.path.endsWith("/_search"))!;
    const dsl = JSON.stringify(search.body.query);
    assert.match(dsl, /must_not/);
    assert.doesNotMatch(dsl, /projectIdsFromInput|p-b/);
});
