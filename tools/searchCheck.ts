#!/usr/bin/env node
/** Real Elasticsearch 9 SDK wire checks. Run: node --test tools/searchCheck.ts */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Client, errors } from "@elastic/elasticsearch";

import { ElasticsearchSearch } from "../src/search/index.ts";
import type { SearchDocument } from "../src/search/index.ts";

type Json = Record<string, any>;
type WireRequest = { method: string; url: URL; headers: IncomingHttpHeaders; text: string; body: Json };
type Reply = { status?: number; body?: unknown };
type Scope = { projectIds: readonly string[]; includeGlobal?: boolean };

const metadataFields = ["id", "kind", "title", "summary", "projectId", "revision", "sourceUri", "tags", "searchTerms"];
const document: SearchDocument = {
    id: "doc/中文 ?#", kind: "knowledge", title: "Scoped search", summary: "",
    projectId: "project-a", revision: "r1", sourceUri: "workspace:notes/search.md",
    tags: ["search", "architecture"], searchTerms: ["elasticsearch", "索引"], content: "private full text",
};

/** Every request crosses the actual SDK transport and localhost socket. */
async function fixture(t: TestContext, reply: (request: WireRequest, index: number) => Reply = () => ({ body: {} }), namespace?: string) {
    const requests: WireRequest[] = [];
    let actualRequestIndex = 0;
    const server = createServer(async (req, res: ServerResponse) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const request: WireRequest = {
                method: req.method ?? "", url: new URL(req.url ?? "/", "http://localhost"), headers: req.headers,
                text, body: text && !req.headers["content-type"]?.includes("ndjson") ? JSON.parse(text) : {},
            };
            requests.push(request);
            const response = request.method === "GET" && request.url.pathname.startsWith("/_resolve/index/")
                ? { body: { indices: [{ name: decodeURIComponent(request.url.pathname.slice("/_resolve/index/".length)), attributes: ["open"] }], aliases: [], data_streams: [] } }
                : request.method === "GET" && request.url.pathname.endsWith("/_mapping")
                    ? { body: { [request.url.pathname.slice(1, -"/_mapping".length)]: { mappings: { _meta: { amp_search: { version: 1, namespace: namespace ?? "test-namespace" } } } } } }
                    : reply(request, actualRequestIndex++);
            res.writeHead(response.status ?? 200, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
            res.end(response.body === undefined ? undefined : JSON.stringify(response.body));
        } catch (error) {
            res.writeHead(500, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
            res.end(JSON.stringify({ error: { type: "stub_error", reason: String(error) }, status: 500 }));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connection = { node: `http://127.0.0.1:${address.port}`, maxRetries: 0, requestTimeout: 2_000 };
    const client = new Client(connection);
    const search = new ElasticsearchSearch({ client });
    if (namespace !== undefined) search.bindNamespace(namespace);
    t.after(async () => {
        await client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    return { requests, client, search, connection };
}

/** Keep metadata probes visible while asserting the exact operation sequence separately. */
function actualRequests(requests: WireRequest[]): WireRequest[] {
    return requests.filter(request => !(request.method === "GET" && (
        request.url.pathname.startsWith("/_resolve/index/") || request.url.pathname.endsWith("/_mapping")
    )));
}

function assertBoundSequence(requests: WireRequest[], operations: Array<[string, string]>): WireRequest[] {
    assert.deepEqual(requests.map(request => [request.method, request.url.pathname]), operations.flatMap(operation => [
        ["GET", "/_resolve/index/amp-search"], ["GET", "/amp-search/_mapping"], operation,
    ]));
    for (const request of requests.filter(request => request.url.pathname.startsWith("/_resolve/index/"))) {
        assert.equal(request.url.searchParams.get("expand_wildcards"), "all");
    }
    const actual = actualRequests(requests);
    assert.equal(actual.length, operations.length);
    return actual;
}

function esError(status: number, type: string, reason = type): Reply {
    return { status, body: { error: { type, reason, root_cause: [{ type, reason }] }, status } };
}

function searchReply(hits: unknown[] = [], total: unknown = { value: hits.length, relation: "eq" }): Reply {
    return { body: { took: 7, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total, max_score: null, hits } } };
}

/** Walk clauses without imposing an adapter's choice of bool nesting. */
function clauses(value: unknown, key: string): any[] {
    if (Array.isArray(value)) return value.flatMap(item => clauses(item, key));
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([name, child]) => [...(name === key ? [child] : []), ...clauses(child, key)]);
}

function fieldValues(query: Json, field: string): unknown[] {
    return [...clauses(query, "term"), ...clauses(query, "terms")]
        .filter(value => Object.hasOwn(value, field)).flatMap(value => Array.isArray(value[field]) ? value[field] : [value[field]]);
}

/** Evaluate only the filtering DSL against representative scope documents. */
function matches(query: Json, source: Json): boolean {
    if (query.match_all) return true;
    if (query.term) return Object.entries(query.term).every(([field, value]) => source[field] === value);
    if (query.terms) return Object.entries(query.terms).every(([field, values]) => {
        const actual = Array.isArray(source[field]) ? source[field] : [source[field]];
        return actual.some(value => (values as unknown[]).includes(value));
    });
    if (query.exists) return source[query.exists.field] !== undefined && source[query.exists.field] !== null;
    if (query.bool) {
        const list = (value: Json | Json[] | undefined): Json[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
        const bool = query.bool;
        const must = [...list(bool.must), ...list(bool.filter)];
        const should = list(bool.should);
        const minimum = bool.minimum_should_match === undefined ? (must.length ? 0 : should.length ? 1 : 0) : Number(bool.minimum_should_match);
        return must.every(item => matches(item, source)) && list(bool.must_not).every(item => !matches(item, source))
            && should.filter(item => matches(item, source)).length >= minimum;
    }
    assert.fail(`Unexpected scope DSL: ${JSON.stringify(query)}`);
}

test("constructor is lazy; ensureIndex uses HEAD and writes a strict namespace marker with SDK 9 headers", async t => {
    const { search, requests } = await fixture(t, request => request.method === "HEAD" ? { status: 404 } : { body: { acknowledged: true } }, "test-namespace");
    assert.equal(requests.length, 0);
    await search.ensureIndex();
    assert.deepEqual(requests.map(request => [request.method, request.url.pathname]), [["HEAD", "/amp-search"], ["PUT", "/amp-search"], ["GET", "/_resolve/index/amp-search"], ["GET", "/amp-search/_mapping"]]);
    const request = requests[1];
    assert.match(String(request.headers.accept), /compatible-with=9/);
    assert.match(String(request.headers["content-type"]), /compatible-with=9/);
    assert.deepEqual(request.body.mappings._meta.amp_search, { version: 1, namespace: "test-namespace" });
    assert.equal(request.body.mappings.dynamic, "strict");
    const properties = request.body.mappings.properties;
    assert.deepEqual(Object.keys(properties).sort(), [...metadataFields, "content"].sort());
    for (const field of ["id", "kind", "projectId", "revision", "sourceUri", "tags"]) assert.equal(properties[field].type, "keyword", field);
    for (const field of ["title", "summary", "searchTerms", "content"]) assert.equal(properties[field].type, "text", field);
});

test("ensureIndex leaves an existing index alone and tolerates only the duplicate-create race", async t => {
    await t.test("existing", async t => {
        const { search, requests } = await fixture(t);
        await search.ensureIndex();
        assert.deepEqual(requests.map(request => request.method), ["HEAD"]);
    });
    await t.test("another caller creates the index after HEAD", async t => {
        const { search, requests } = await fixture(t, request => request.method === "HEAD" ? { status: 404 } : esError(400, "resource_already_exists_exception"));
        await search.ensureIndex();
        assert.equal(requests.length, 2);
    });
    for (const [status, type] of [[403, "security_exception"], [400, "mapper_parsing_exception"], [503, "unavailable_shards_exception"]] as const) {
        await t.test(`create ${type} propagates`, async t => {
            const { search } = await fixture(t, request => request.method === "HEAD" ? { status: 404 } : esError(status, type));
            await assert.rejects(() => search.ensureIndex(), error => error instanceof errors.ResponseError && error.statusCode === status);
        });
    }
    await t.test("HEAD failure propagates without attempting create", async t => {
        const { search, requests } = await fixture(t, () => esError(403, "security_exception"));
        await assert.rejects(() => search.ensureIndex(), error => error instanceof errors.ResponseError && error.statusCode === 403);
        assert.equal(requests.length, 1);
    });
});

test("indexDocument encodes IDs, preserves searchable content, drops unknown input and forwards refresh", async t => {
    const { search, requests } = await fixture(t, () => ({ status: 201, body: { result: "created", _id: document.id } }));
    await search.indexDocument({ ...document, unexpected: "must not enter strict mapping" } as SearchDocument, { refresh: "wait_for" });
    const request = requests[0];
    assert.equal(request.method, "PUT");
    assert.equal(request.url.pathname, `/amp-search/_doc/${encodeURIComponent(document.id)}`);
    assert.equal(request.url.searchParams.get("refresh"), "wait_for");
    assert.deepEqual(request.body, document);
    await search.indexDocument({ ...document, id: "second" }, { refresh: false });
    assert.equal(requests[1].url.searchParams.get("refresh"), "false");
    await search.indexDocument({ ...document, id: "third" }, { refresh: true });
    assert.equal(requests[2].url.searchParams.get("refresh"), "true");
});

test("bulk writes use NDJSON and report each partial failure without throwing away successful items", async t => {
    const docs = [document, { ...document, id: "bad-mapping" }, { ...document, id: "busy" }];
    const { search, requests } = await fixture(t, () => ({ body: { took: 2, errors: true, items: [
        { index: { _id: document.id, status: 201, result: "created" } },
        { index: { _id: "bad-mapping", status: 400, error: { type: "mapper_parsing_exception", reason: "invalid field" } } },
        { index: { _id: "busy", status: 429, error: { type: "es_rejected_execution_exception", reason: "queue full" } } },
    ] } }));
    assert.deepEqual(await search.indexDocuments(docs, { refresh: "wait_for" }), {
        indexed: 1, failures: [{ id: "bad-mapping", status: 400, reason: "invalid field" }, { id: "busy", status: 429, reason: "queue full" }],
    });
    const request = requests[0];
    assert.equal(request.method, "POST");
    assert.match(request.url.pathname, /\/_bulk$/);
    assert.equal(request.url.searchParams.get("refresh"), "wait_for");
    assert.match(String(request.headers["content-type"]), /(?:x-ndjson|ndjson).*compatible-with=9/);
    assert.ok(request.text.endsWith("\n"));
    const lines = request.text.trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 6);
    for (let i = 0; i < docs.length; i++) {
        assert.equal(lines[i * 2].index._id, docs[i].id);
        assert.equal(lines[i * 2].index._index ?? request.url.pathname.split("/")[1], "amp-search");
        assert.deepEqual(lines[i * 2 + 1], docs[i]);
    }
});

test("bulk HTTP 200 can still mean every document failed", async t => {
    const { search } = await fixture(t, () => ({ body: { errors: true, items: [
        { index: { _id: document.id, status: 403, error: { type: "security_exception", reason: "write forbidden" } } },
    ] } }));
    assert.deepEqual(await search.indexDocuments([document]), {
        indexed: 0, failures: [{ id: document.id, status: 403, reason: "write forbidden" }],
    });
});

test("bulk empty input avoids transport; validation is atomic across all batch entries", async t => {
    const { search, requests } = await fixture(t);
    assert.deepEqual(await search.indexDocuments([]), { indexed: 0, failures: [] });
    await assert.rejects(async () => search.indexDocuments([document, { ...document, title: " " }]));
    await assert.rejects(async () => search.indexDocuments(Array.from({ length: 1001 }, (_, i) => ({ ...document, id: String(i) }))));
    assert.equal(requests.length, 0);
});

test("delete maps found and missing documents to booleans, encodes IDs and preserves other errors", async t => {
    const { search, requests } = await fixture(t, (_request, i) => i === 0 ? { body: { result: "deleted" } }
        : i === 1 ? esError(404, "document_missing_exception") : esError(403, "security_exception"));
    assert.equal(await search.deleteDocument(document.id, { refresh: "wait_for" }), true);
    assert.equal(requests[0].method, "DELETE");
    assert.equal(requests[0].url.pathname, `/amp-search/_doc/${encodeURIComponent(document.id)}`);
    assert.equal(requests[0].url.searchParams.get("refresh"), "wait_for");
    assert.equal(await search.deleteDocument("absent"), false);
    await assert.rejects(() => search.deleteDocument("denied"), error => error instanceof errors.ResponseError && error.statusCode === 403);
});

test("empty scope is network-free; scope is mandatory even for an omitted query", async t => {
    const { search, requests } = await fixture(t);
    assert.deepEqual(await search.search({ projectIds: [] }), { hits: [], total: 0, totalRelation: "eq", took: 0, timedOut: false });
    await assert.rejects(async () => search.search(undefined as unknown as Scope));
    assert.equal(requests.length, 0);
});

test("wire scope excludes other hosts and includes global documents only when explicitly requested", async t => {
    for (const [scope, expected] of [
        [{ projectIds: ["project-a", "project-b"] }, [true, true, false, false]],
        [{ projectIds: ["project-a"], includeGlobal: true }, [true, false, false, true]],
        [{ projectIds: [], includeGlobal: true }, [false, false, false, true]],
    ] as Array<[Scope, boolean[]]>) {
        await t.test(JSON.stringify(scope), async t => {
            const { search, requests } = await fixture(t, () => searchReply());
            await search.search(scope);
            const request = requests[0];
            assert.equal(request.method, "POST");
            assert.equal(request.url.pathname, "/amp-search/_search");
            assert.equal(request.body.from, 0);
            assert.equal(request.body.size, 20);
            assert.deepEqual([
                { projectId: "project-a" }, { projectId: "project-b" }, { projectId: "other-host" }, {},
            ].map(source => matches(request.body.query, source)), expected);
            if (scope.includeGlobal) {
                assert.ok(clauses(request.body.query, "must_not").some(value => clauses({ value }, "exists").some(exists => exists.field === "projectId")));
            }
        });
    }
});

test("text, filters and pagination travel in the request and cannot replace mandatory scope", async t => {
    const { search, requests } = await fixture(t, () => searchReply());
    await search.search({ projectIds: ["project-a"], includeGlobal: true }, {
        text: "scope isolation", kinds: ["skill", "knowledge"], tags: ["search", "trusted"], revision: "r2", offset: 11, limit: 37,
    });
    const body = requests[0].body;
    assert.equal(body.from, 11);
    assert.equal(body.size, 37);
    assert.deepEqual(clauses(body.query, "multi_match"), [{ query: "scope isolation", fields: ["title^3", "summary^2", "searchTerms", "content"], operator: "and" }]);
    assert.deepEqual([...new Set(fieldValues(body.query, "kind"))].sort(), ["knowledge", "skill"]);
    assert.deepEqual([...new Set(fieldValues(body.query, "tags"))].sort(), ["search", "trusted"]);
    assert.deepEqual(fieldValues(body.query, "revision"), ["r2"]);
    assert.deepEqual(fieldValues(body.query, "projectId"), ["project-a"]);
    // Evaluate the filter context separately from text scoring: no filter may be an optional should.
    const filters = body.query.bool?.filter;
    assert.ok(filters, "scope and exact filters must be in filter context");
    const filterQuery = { bool: { filter: filters } };
    const allowed = { projectId: "project-a", kind: "knowledge", tags: ["search"], revision: "r2" };
    assert.equal(matches(filterQuery, allowed), true);
    assert.equal(matches(filterQuery, { ...allowed, projectId: "other-host" }), false);
    assert.equal(matches(filterQuery, { ...allowed, kind: "unselected" }), false);
    assert.equal(matches(filterQuery, { ...allowed, tags: ["unselected"] }), false);
    assert.equal(matches(filterQuery, { ...allowed, revision: "r1" }), false);
    const { projectId: _projectId, revision: _revision, ...global } = allowed;
    assert.equal(matches(filterQuery, global), true, "global registries are independent of workspace revision");
    assert.equal(matches(filterQuery, { ...global, revision: "registry-v1" }), true);
});

test("search requests explicit metadata and defensively strips full text and unknown response fields", async t => {
    const { search, requests } = await fixture(t, () => ({ body: {
        took: 17, timed_out: true, hits: { total: { value: 10_000, relation: "gte" }, hits: [
            { _id: document.id, _score: 3.25, _source: { ...document, unknown: "secret", nested: { content: "secret" } } },
            { _id: "global", _score: null, _source: { id: "global", kind: "skill", title: "Global", summary: "Public", content: "secret" } },
        ] },
    } }));
    const result = await search.search({ projectIds: ["project-a"], includeGlobal: true });
    const selection = requests[0].body._source;
    const includes = Array.isArray(selection) ? selection : selection?.includes;
    assert.ok(Array.isArray(includes), "must use an explicit source allowlist");
    assert.deepEqual([...includes].sort(), [...metadataFields].sort());
    const { content: _content, ...metadata } = document;
    assert.deepEqual(result, {
        hits: [{ document: metadata, score: 3.25 }, { document: { id: "global", kind: "skill", title: "Global", summary: "Public" }, score: null }],
        total: 10_000, totalRelation: "gte", took: 17, timedOut: true,
    });
    assert.ok(!JSON.stringify(result).includes("secret"));
});

test("search rejects missing or different wire IDs even when source metadata is valid", async t => {
    for (const id of [undefined, "different-document", ""]) {
        await t.test(`_id ${JSON.stringify(id)}`, async t => {
            const { search, requests } = await fixture(t, () => searchReply([{ _id: id, _score: 1, _source: document }]), "test-namespace");
            await assert.rejects(() => search.search({ projectIds: ["project-a"] }), /hit identity mismatch/);
            assertBoundSequence(requests, [["POST", "/amp-search/_search"]]);
        });
    }
});

test("bound operations recheck resolution and ownership before every read and write", async t => {
    const { search, requests } = await fixture(t, request => {
        if (request.url.pathname.endsWith("/_search")) return searchReply();
        if (request.url.pathname.endsWith("/_bulk")) return { body: { errors: false, items: [{ index: { _id: document.id, status: 201 } }] } };
        return { body: { result: request.method === "DELETE" ? "deleted" : "created" } };
    }, "test-namespace");
    for (let attempt = 0; attempt < 2; attempt++) {
        await search.indexDocument(document);
        assert.deepEqual(await search.indexDocuments([document]), { indexed: 1, failures: [] });
        assert.equal(await search.deleteDocument(document.id), true);
        assert.equal((await search.search({ projectIds: ["project-a"] })).total, 0);
    }
    const operations: Array<[string, string]> = [
        ["PUT", `/amp-search/_doc/${encodeURIComponent(document.id)}`], ["POST", "/amp-search/_bulk"],
        ["DELETE", `/amp-search/_doc/${encodeURIComponent(document.id)}`], ["POST", "/amp-search/_search"],
    ];
    assertBoundSequence(requests, [...operations, ...operations]);
});

test("invalid index names, IDs, document fields and query windows never reach the server", async t => {
    const { client, search, requests } = await fixture(t, () => searchReply());
    for (const index of ["", "UPPER", "a*", "a?", "a,b", "../escape", "a/b", "_hidden", "a b", ".", "..", "é".repeat(128)]) {
        assert.throws(() => new ElasticsearchSearch({ client, index }), undefined, `index ${JSON.stringify(index)}`);
    }
    for (const patch of [
        { id: "" }, { id: " " }, { id: "界".repeat(171) }, { kind: " " }, { title: "" },
        { summary: undefined }, { tags: ["ok", " "] }, { searchTerms: [""] },
    ]) await assert.rejects(async () => search.indexDocument({ ...document, ...patch } as SearchDocument), undefined, JSON.stringify(patch));
    for (const id of ["", " ", "界".repeat(171)]) await assert.rejects(async () => search.deleteDocument(id));
    for (const query of [
        { offset: -1 }, { offset: 0.5 }, { limit: -1 }, { limit: 101 }, { limit: 1.5 }, { offset: 9_999, limit: 2 }, { offset: Infinity }, { limit: NaN },
        { kinds: [""] }, { tags: [" "] },
    ]) await assert.rejects(async () => search.search({ projectIds: ["project-a"] }, query));
    await assert.rejects(async () => search.search({ projectIds: [" "] }));
    assert.equal(requests.length, 0);
});

test("UTF-8 ID byte boundary, maximum batch and last valid result window are accepted", async t => {
    const { search, requests } = await fixture(t, request => request.url.pathname.endsWith("/_search") ? searchReply()
        : request.url.pathname.endsWith("/_bulk") ? { body: { errors: false, items: Array.from({ length: 1000 }, (_, i) => ({ index: { _id: String(i), status: 201 } })) } }
        : { body: { result: "created" } });
    const id = "界".repeat(170) + "ab";
    assert.equal(Buffer.byteLength(id), 512);
    await search.indexDocument({ ...document, id });
    assert.equal((await search.indexDocuments(Array.from({ length: 1000 }, (_, i) => ({ ...document, id: String(i) })))).indexed, 1000);
    await search.search({ projectIds: ["project-a"] }, { offset: 9_900, limit: 100 });
    assert.equal(requests[2].body.from, 9_900);
    assert.equal(requests[2].body.size, 100);
});

test("HTTP failures from indexing, bulk and search stay observable as real SDK errors", async t => {
    const { search } = await fixture(t, () => esError(503, "unavailable_shards_exception", "shards unavailable"));
    for (const operation of [
        () => search.indexDocument(document), () => search.indexDocuments([document]), () => search.search({ projectIds: ["project-a"] }),
    ]) await assert.rejects(operation, error => error instanceof errors.ResponseError && error.statusCode === 503 && error.message.includes("shards unavailable"));
});

test("a disconnected real SDK transport rejects instead of reporting successful empty results", async t => {
    const { search, client, requests } = await fixture(t, () => searchReply());
    await client.close();
    for (const operation of [
        () => search.ensureIndex(), () => search.indexDocument(document), () => search.indexDocuments([document]),
        () => search.deleteDocument("missing"), () => search.search({ projectIds: ["project-a"] }),
    ]) await assert.rejects(operation);
    assert.equal(requests.length, 0);
});

test("replaceDocuments validates every input before the disabled migration error without network", async t => {
    for (const namespace of [undefined, "test-namespace"]) {
        await t.test(namespace ?? "unbound", async t => {
            const { search, requests } = await fixture(t, () => esError(503, "unavailable_shards_exception"), namespace);
            await assert.rejects(() => search.replaceDocuments(null as unknown as SearchDocument[]), /documents must be an array/);
            await assert.rejects(() => search.replaceDocuments([document, { ...document, id: "invalid", title: " " }]), /title/);
            await assert.rejects(() => search.replaceDocuments([document, { ...document }]), /duplicate document id/);
            await assert.rejects(() => search.replaceDocuments([document], { refresh: "invalid" as "wait_for" }), /refresh/);
            for (const [snapshot, options] of [
                [[], undefined], [[document], { refresh: "wait_for" }],
                [Array.from({ length: 1001 }, (_, i) => ({ ...document, id: String(i) })), { refresh: true }],
            ] as const) {
                await assert.rejects(() => search.replaceDocuments(snapshot, options), /^Error: destructive replacement is disabled; use buildSnapshot$/);
            }
            assert.equal(requests.length, 0, "disabled replacement must never resolve, map, delete, or index");
        });
    }
});

test("close respects client ownership; an injected real client remains usable", async t => {
    const { search, client, requests, connection } = await fixture(t, () => searchReply());
    const owned = new ElasticsearchSearch({ connection, index: "custom-search" });
    assert.equal(requests.length, 0);
    await owned.search({ projectIds: ["project-a"] });
    assert.equal(requests[0].url.pathname, "/custom-search/_search");
    await owned.close();
    await assert.rejects(() => owned.search({ projectIds: ["project-a"] }));
    assert.equal(requests.length, 1);
    await search.close();
    await client.search({ index: "amp-search", query: { match_all: {} } });
    assert.equal(requests.length, 2);
});
