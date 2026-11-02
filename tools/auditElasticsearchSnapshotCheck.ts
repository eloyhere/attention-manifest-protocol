#!/usr/bin/env node
/** Snapshot lifecycle and ownership boundary audit for the Elasticsearch adapter. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { Client } from "@elastic/elasticsearch";

import { ElasticsearchSearch, snapshotDigest } from "../src/search/elasticsearch.ts";
import type { SearchDocument } from "../src/search/types.ts";

type Request = { method: string; path: string; query: URLSearchParams; body: any; text: string };
type Reply = { status?: number; body?: unknown; delayMs?: number };
const namespace = "snapshot-audit/中文";
const doc: SearchDocument = { id: "doc-1", kind: "note", title: "Snapshot title", summary: "", projectId: "p1", revision: "r1", content: "private" };

async function fixture(t: import("node:test").TestContext, respond: (request: Request) => Reply, options: { timeout?: number } = {}) {
    const requests: Request[] = [];
    const server = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        const url = new URL(incoming.url ?? "/", "http://localhost");
        const request: Request = { method: incoming.method ?? "", path: decodeURIComponent(url.pathname), query: url.searchParams,
            text, body: text && !String(incoming.headers["content-type"]).includes("ndjson") ? JSON.parse(text) : {} };
        requests.push(request);
        const reply = respond(request);
        if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
        outgoing.writeHead(reply.status ?? 200, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
        outgoing.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client({ node: `http://127.0.0.1:${address.port}`, maxRetries: 0, requestTimeout: options.timeout ?? 2_000 });
    const adapter = new ElasticsearchSearch({ client, index: "audit-search", namespace });
    t.after(async () => {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return { adapter, client, requests };
}

function snapshotResponse(request: Request): Reply {
    const index = request.path.split("/")[1];
    if (request.path.startsWith("/_resolve/index/")) return { body: { indices: [{ name: request.path.slice("/_resolve/index/".length), attributes: ["open"] }], aliases: [], data_streams: [] } };
    if (request.path.endsWith("/_mapping")) return { body: { [index]: { mappings: { _meta: { amp_search: { version: 1, namespace } } } } } };
    if (request.path.endsWith("/_settings")) return { body: { [index]: { settings: { index: { blocks: { write: true } } } } } };
    if (request.path.endsWith("/_count")) return { body: { count: 1, _shards: { total: 1, successful: 1, failed: 0 } } };
    if (request.path.endsWith("/_mget")) return { body: { docs: request.body.ids.map((id: string) => ({ _index: index, _id: id, found: true, _source: doc })) } };
    if (request.path.endsWith("/_bulk")) return { body: { errors: false, items: [{ index: { _id: doc.id, status: 201 } }] } };
    return { body: { acknowledged: true, shards_acknowledged: true } };
}

test("buildSnapshot uses a namespace-scoped UUID index, strict identity mapping, one bulk, refresh, block and digest verification", async t => {
    const { adapter, requests } = await fixture(t, snapshotResponse);
    const result = await adapter.buildSnapshot(namespace, [doc]);
    const prefix = `audit-search-ns-${(await import("node:crypto")).createHash("sha256").update(namespace).digest("hex").slice(0, 24)}-`;
    assert.match(result.index, new RegExp(`^${prefix}[a-f0-9-]{36}$`));
    assert.equal(result.digest, snapshotDigest([doc]));
    const create = requests.find(request => request.method === "PUT" && request.path === `/${result.index}`);
    assert.ok(create, "snapshot index must be created, never adopted");
    assert.equal(create.body.mappings.dynamic, "strict");
    assert.deepEqual(create.body.mappings._meta.amp_search, { version: 1, namespace });
    assert.equal(create.body.settings.number_of_shards, 1);
    assert.equal(create.body.settings.number_of_replicas, 0);
    const properties = create.body.mappings.properties;
    for (const field of ["id", "kind", "projectId", "revision", "sourceUri", "tags"]) assert.equal(properties[field].type, "keyword");
    for (const field of ["title", "summary", "searchTerms", "content"]) assert.equal(properties[field].type, "text");
    assert.deepEqual(requests.map(request => request.path), [
        `/${result.index}`, `/_resolve/index/${result.index}`, `/${result.index}/_mapping`, `/${result.index}/_bulk`,
        `/${result.index}/_refresh`, `/${result.index}/_block/write`, `/_resolve/index/${result.index}`,
        `/${result.index}/_mapping`, `/${result.index}/_settings`, `/${result.index}/_count`, `/${result.index}/_mget`,
    ]);
    const bulk = requests[3];
    assert.equal(bulk.text.endsWith("\n"), true);
    const lines = bulk.text.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(lines, [{ index: { _index: result.index, _id: doc.id } }, doc]);
});

test("snapshot partial bulk failure is surfaced and does not refresh or seal", async t => {
    const { adapter, requests } = await fixture(t, request => request.path.endsWith("/_bulk")
        ? { body: { errors: true, items: [{ index: { _id: doc.id, status: 429, error: { type: "es_rejected_execution_exception", reason: "busy" } } }] } }
        : snapshotResponse(request));
    await assert.rejects(() => adapter.buildSnapshot(namespace, [doc]), /indexing was incomplete/);
    assert.equal(requests.filter(request => request.path.endsWith("/_bulk")).length, 1);
    assert.equal(requests.some(request => request.path.endsWith("/_refresh") || request.path.endsWith("/_block/write")), false);
});

test("post-search verification rejects alias replacement during search", async t => {
    const expectedPrefix = `audit-search-ns-${(await import("node:crypto")).createHash("sha256").update(namespace).digest("hex").slice(0, 24)}-`;
    const index = `${expectedPrefix}12345678-1234-4234-8234-123456789abc`;
    const digest = snapshotDigest([doc]);
    let aliasInstalled = false;
    const { adapter, requests } = await fixture(t, request => {
        if (request.path === `/_resolve/index/${index}`) return { body: aliasInstalled
            ? { indices: [], aliases: [{ name: index, indices: ["foreign-backing"] }], data_streams: [] }
            : { indices: [{ name: index, attributes: ["open"] }], aliases: [], data_streams: [] } };
        if (request.path.endsWith("/_mapping")) return { body: { [index]: { mappings: { _meta: { amp_search: { version: 1, namespace } } } } } };
        if (request.path.endsWith("/_settings")) return { body: { [index]: { settings: { index: { blocks: { write: true } } } } } };
        if (request.path.endsWith("/_count")) return { body: { count: 1, _shards: { failed: 0 } } };
        if (request.path.endsWith("/_mget")) return { body: { docs: [{ _index: aliasInstalled ? "foreign-backing" : index, _id: doc.id, found: true, _source: doc }] } };
        if (request.path.endsWith("/_search")) {
            aliasInstalled = true;
            return { body: { took: 1, timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: doc.id, _score: 1, _source: doc }] } } };
        }
        assert.fail(`unexpected request ${request.method} ${request.path}`);
    });
    await assert.rejects(() => adapter.searchSnapshot(namespace, { index, digest }, [doc], { projectIds: ["p1"] }, { text: "title" }), /exactly one concrete index/);
    assert.equal(requests.filter(request => request.path === `/_resolve/index/${index}`).length, 3,
        "ownership/concrete identity must be rechecked after search");
});

test("post-search verification rejects a changed namespace marker", async t => {
    const expectedPrefix = `audit-search-ns-${(await import("node:crypto")).createHash("sha256").update(namespace).digest("hex").slice(0, 24)}-`;
    const index = `${expectedPrefix}12345678-1234-4234-8234-123456789abc`;
    const digest = snapshotDigest([doc]);
    let markerChanged = false;
    const { adapter, requests } = await fixture(t, request => {
        if (request.path === `/_resolve/index/${index}`) return { body: { indices: [{ name: index, attributes: ["open"] }], aliases: [], data_streams: [] } };
        if (request.path.endsWith("/_mapping")) return { body: { [index]: { mappings: { _meta: { amp_search: { version: 1, namespace: markerChanged ? "foreign" : namespace } } } } } };
        if (request.path.endsWith("/_settings")) return { body: { [index]: { settings: { index: { blocks: { write: true } } } } } };
        if (request.path.endsWith("/_count")) return { body: { count: 1, _shards: { failed: 0 } } };
        if (request.path.endsWith("/_mget")) return { body: { docs: [{ _index: index, _id: doc.id, found: true, _source: doc }] } };
        if (request.path.endsWith("/_search")) {
            markerChanged = true;
            return { body: { took: 1, timed_out: false, _shards: { failed: 0 }, hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: doc.id, _score: 1, _source: doc }] } } };
        }
        assert.fail(`unexpected request ${request.method} ${request.path}`);
    });
    await assert.rejects(() => adapter.searchSnapshot(namespace, { index, digest }, [doc], { projectIds: ["p1"] }, { text: "title" }), /ownership marker/);
    assert.equal(requests.filter(request => request.path.endsWith("/_mapping")).length, 3,
        "initial verification, pre-search ownership and post-search verification must check marker identity");
});

test("buildSnapshot rejects a changed namespace marker after sealing", async t => {
    let markerChanged = false;
    const { adapter, requests } = await fixture(t, request => {
        if (request.path.startsWith("/_resolve/index/")) return { body: { indices: [{ name: request.path.slice("/_resolve/index/".length), attributes: ["open"] }], aliases: [], data_streams: [] } };
        if (request.path.endsWith("/_bulk")) return { body: { errors: false, items: [{ index: { _id: doc.id, status: 201 } }] } };
        if (request.path.endsWith("/_block/write")) { markerChanged = true; return { body: { acknowledged: true } }; }
        if (request.path.endsWith("/_settings")) return { body: { [request.path.split("/")[1]]: { settings: { index: { blocks: { write: true } } } } } };
        if (request.path.endsWith("/_count")) return { body: { count: 1, _shards: { failed: 0 } } };
        if (request.path.endsWith("/_mget")) return { body: { docs: [{ _index: request.path.split("/")[1], _id: doc.id, found: true, _source: doc }] } };
        if (request.path.endsWith("/_mapping")) return { body: { [request.path.split("/")[1]]: { mappings: { _meta: { amp_search: { version: 1, namespace: markerChanged ? "foreign" : namespace } } } } } };
        return { body: { acknowledged: true } };
    });
    await assert.rejects(() => adapter.buildSnapshot(namespace, [doc]), /ownership marker/);
    assert.equal(markerChanged, true);
    assert.equal(requests.some(request => request.path.endsWith("/_mapping")), true,
        "buildSnapshot must verify ownership after sealing");
});
