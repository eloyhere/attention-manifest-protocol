#!/usr/bin/env node
/** Focused fail-closed boundary probes for the Elasticsearch SDK adapter. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { Client } from "@elastic/elasticsearch";

import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";
import type { SearchDocument } from "../src/search/types.ts";

type Reply = { status?: number; body?: unknown };
type Request = { method: string; path: string; body: unknown; text: string; query: URLSearchParams };
const doc: SearchDocument = { id: "d1", kind: "note", title: "Title", summary: "", projectId: "p1", revision: "r1" };

async function fixture(t: import("node:test").TestContext, respond: (request: Request) => Reply, resolution?: Reply, mappingMeta: Record<string, unknown> = { amp_search: { version: 1, namespace: "boundary-test" } }) {
    const requests: Request[] = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        const url = new URL(request.url ?? "/", "http://localhost");
        const path = url.pathname;
        let body: unknown = {};
        if (text && !String(request.headers["content-type"]).includes("ndjson")) body = JSON.parse(text);
        const captured = { method: request.method ?? "", path, body, text, query: url.searchParams };
        requests.push(captured);
        const result = captured.method === "GET" && path.startsWith("/_resolve/index/")
            ? resolution ?? { body: { indices: [{ name: decodeURIComponent(path.slice("/_resolve/index/".length)), attributes: ["open"] }], aliases: [], data_streams: [] } }
            : captured.method === "GET" && path.endsWith("/_mapping")
                ? { body: { "amp-search": { mappings: { _meta: mappingMeta } } } }
                : respond(captured);
        response.writeHead(result.status ?? 200, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
        response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client({ node: `http://127.0.0.1:${address.port}`, maxRetries: 0, requestTimeout: 1000 });
    const adapter = new ElasticsearchSearch({ client, namespace: "boundary-test" });
    t.after(async () => {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return { adapter, client, requests };
}

const searchResponse = (patch: Record<string, unknown> = {}) => ({
    took: 5, timed_out: false, _shards: { total: 2, successful: 2, skipped: 0, failed: 0 },
    hits: { total: { value: 1, relation: "eq" }, max_score: 1, hits: [{ _id: "d1", _score: 1, _source: doc }] },
    ...patch,
});

test("partial shard failure is rejected rather than returned as complete search success", async t => {
    const { adapter } = await fixture(t, () => ({ body: searchResponse({
        _shards: { total: 3, successful: 2, skipped: 0, failed: 1 },
        timed_out: false,
    }) }));
    await assert.rejects(() => adapter.search({ projectIds: ["p1"] }, { text: "title" }), /1 shard.*failed/);
});

test("a malformed successful bulk item without status fails the request", async t => {
    const { adapter } = await fixture(t, () => ({ body: { errors: false, items: [{ index: { _id: "d1" } }] } }));
    await assert.rejects(() => adapter.indexDocuments([doc]), /invalid item status/);
});

test("delete distinguishes missing documents from missing indexes", async t => {
    const { adapter, requests } = await fixture(t, () => ({ status: 404, body: {
        error: { type: "index_not_found_exception", reason: "no such index [amp-search]" }, status: 404,
    } }));
    await assert.rejects(() => adapter.deleteDocument("d1"), /index_not_found_exception/);
    assert.deepEqual(requests.map(request => [request.method, request.path]), [
        ["GET", "/_resolve/index/amp-search"], ["GET", "/amp-search/_mapping"], ["DELETE", "/amp-search/_doc/d1"],
    ]);
});

test("bound operations reject aliases, data streams and ambiguous resolutions before reading or mutating documents", async t => {
    const concrete = { name: "amp-search", attributes: ["open"] };
    for (const [name, resolution] of [
        ["alias", { indices: [], aliases: [{ name: "amp-search", indices: ["shared-000001"] }], data_streams: [] }],
        ["data stream", { indices: [], aliases: [], data_streams: [{ name: "amp-search", backing_indices: [".ds-amp-search-000001"], timestamp_field: "@timestamp" }] }],
        ["alias alongside same-name index", { indices: [concrete], aliases: [{ name: "shared", indices: ["amp-search"] }], data_streams: [] }],
        ["data stream alongside same-name index", { indices: [concrete], aliases: [], data_streams: [{ name: "shared", backing_indices: ["amp-search"], timestamp_field: "@timestamp" }] }],
        ["different concrete index", { indices: [{ name: "shared-000001", attributes: ["open"] }], aliases: [], data_streams: [] }],
        ["multiple concrete indexes", { indices: [concrete, { name: "shared-000001", attributes: ["open"] }], aliases: [], data_streams: [] }],
        ["no concrete index", { indices: [], aliases: [], data_streams: [] }],
        ["missing resolution fields", {}],
    ] as const) {
        await t.test(name, async t => {
            const { adapter, requests } = await fixture(t, request => {
                assert.equal(request.method, "HEAD", "invalid resolution must stop before document reads and mutations");
                assert.equal(request.path, "/amp-search");
                return { body: {} };
            }, { body: resolution });
            const operations = [
                ["ensure", () => adapter.ensureIndex()],
                ["search", () => adapter.search({ projectIds: ["p1"] })],
                ["index", () => adapter.indexDocument(doc)],
                ["bulk", () => adapter.indexDocuments([doc])],
                ["delete", () => adapter.deleteDocument(doc.id)],
            ] as const;
            for (const [operation, run] of operations) {
                const start = requests.length;
                await assert.rejects(run, /exactly one concrete index/, operation);
                const expected = [["GET", "/_resolve/index/amp-search"]];
                if (operation === "ensure") expected.unshift(["HEAD", "/amp-search"]);
                assert.deepEqual(requests.slice(start).map(request => [request.method, request.path]), expected, operation);
            }
            for (const request of requests.filter(request => request.method === "GET")) {
                assert.equal(request.query.get("expand_wildcards"), "all");
            }
        });
    }
});

test("resolve-index HTTP failure stops every bound operation before document access", async t => {
    const { adapter, requests } = await fixture(t, request => {
        assert.equal(request.method, "HEAD", "failed resolve must stop before document access");
        return { body: {} };
    }, {
        status: 403, body: { error: { type: "security_exception", reason: "resolve forbidden" }, status: 403 },
    });
    const operations = [
        ["ensure", () => adapter.ensureIndex()],
        ["search", () => adapter.search({ projectIds: ["p1"] })],
        ["index", () => adapter.indexDocument(doc)],
        ["bulk", () => adapter.indexDocuments([doc])],
        ["delete", () => adapter.deleteDocument(doc.id)],
    ] as const;
    for (const [operation, run] of operations) {
        const start = requests.length;
        await assert.rejects(run, /security_exception/, operation);
        const expected = [["GET", "/_resolve/index/amp-search"]];
        if (operation === "ensure") expected.unshift(["HEAD", "/amp-search"]);
        assert.deepEqual(requests.slice(start).map(request => [request.method, request.path]), expected, operation);
    }
});

test("namespace binding is exclusive and an existing unmarked or foreign-owned index is never adopted", async t => {
    for (const [name, mappingMeta] of [
        ["unmarked", {}], ["foreign", { amp_search: { version: 1, namespace: "other" } }],
    ] as const) {
        await t.test(name, async t => {
            const { adapter, requests } = await fixture(t, () => ({ body: {} }), undefined, mappingMeta);
            adapter.bindNamespace("boundary-test");
            assert.throws(() => adapter.bindNamespace("other"), /another namespace/);
            assert.equal(requests.length, 0, "binding must be network-free");
            const operations = [
                ["ensure", () => adapter.ensureIndex()],
                ["index", () => adapter.indexDocument(doc)],
                ["bulk", () => adapter.indexDocuments([doc])],
                ["delete", () => adapter.deleteDocument(doc.id)],
                ["search", () => adapter.search({ projectIds: ["p1"] })],
            ] as const;
            for (const [operation, run] of operations) {
                const start = requests.length;
                await assert.rejects(run, /ownership marker/, operation);
                const expected = [["GET", "/_resolve/index/amp-search"], ["GET", "/amp-search/_mapping"]];
                if (operation === "ensure") expected.unshift(["HEAD", "/amp-search"]);
                assert.deepEqual(requests.slice(start).map(request => [request.method, request.path]), expected, operation);
                assert.equal(requests[start + (operation === "ensure" ? 1 : 0)].query.get("expand_wildcards"), "all");
            }
        });
    }
});

test("search rejects a wire identity that differs from otherwise valid source metadata", async t => {
    const { adapter, requests } = await fixture(t, () => ({ body: searchResponse({
        hits: { total: { value: 1, relation: "eq" }, hits: [{ _id: "foreign-id", _score: 1, _source: doc }] },
    }) }));
    await assert.rejects(() => adapter.search({ projectIds: ["p1"] }), /hit identity mismatch/);
    assert.deepEqual(requests.map(request => [request.method, request.path]), [
        ["GET", "/_resolve/index/amp-search"], ["GET", "/amp-search/_mapping"], ["POST", "/amp-search/_search"],
    ]);
});

test("controls: validation is network-free and revision scope admits only matching project or global entries", async t => {
    const { adapter, requests } = await fixture(t, () => ({ body: searchResponse() }));
    await assert.rejects(() => adapter.search({ projectIds: [" "] }));
    await assert.rejects(() => adapter.indexDocument({ ...doc, tags: [""] }));
    assert.equal(requests.length, 0);
    const result = await adapter.search({ projectIds: ["p1"], includeGlobal: true }, { revision: "r1", offset: 0, limit: 1 });
    assert.equal(result.hits.length, 1);
    assert.deepEqual(requests.map(request => [request.method, request.path]), [
        ["GET", "/_resolve/index/amp-search"], ["GET", "/amp-search/_mapping"], ["POST", "/amp-search/_search"],
    ]);
    assert.equal(requests[0].query.get("expand_wildcards"), "all");
});
