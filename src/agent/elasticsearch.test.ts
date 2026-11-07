import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@elastic/elasticsearch";
import { createElasticsearchDiscoveryProvider } from "./elasticsearch.ts";
import type { ElasticsearchDiscoveryDocument } from "./elasticsearch.ts";
import { AgentGateway } from "./gateway.ts";
import { DISCOVER_TOOL_NAME } from "./surface.ts";
import type { DiscoveryResult } from "./discovery.ts";

const binding = { tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 } as const;

function fakeClient(hits: readonly { _source?: unknown; _score?: number }[]): { client: Client; requests: Record<string, unknown>[] } {
    const requests: Record<string, unknown>[] = [];
    const client = {
        search: async (request: Record<string, unknown>) => {
            requests.push(request);
            return { hits: { hits } };
        },
    } as unknown as Client;
    return { client, requests };
}

const fileDocument: ElasticsearchDiscoveryDocument = {
    id: "file-1", source: "session_files", kind: "content", module: "src/a.ts",
    name: "src/a.ts:1", summary: "export function read", searchText: "export function read() {}",
    target: { kind: "content", path: "src/a.ts", startLine: "1" },
    tenantId: "t", principalId: "p", sessionId: "s", semantic: 0.2,
};

interface RequestShape {
    index?: string;
    size?: number;
    query?: { bool?: { filter?: { term?: Record<string, string> }[]; must?: { multi_match?: { query?: string; fields?: string[] } }[] } };
}

test("Elasticsearch session provider adds scope filters and maps hits", async () => {
    const { client, requests } = fakeClient([{ _source: fileDocument, _score: 3 }]);
    const provider = createElasticsearchDiscoveryProvider({ client, index: "amp-discovery", source: "session_files" });
    const candidates = await provider.search("read", binding);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source, "session_files");
    assert.equal(candidates[0].kind, "content");
    assert.deepEqual(candidates[0].scope, { tenantId: "t", principalId: "p", sessionId: "s" });
    assert.deepEqual(candidates[0].target, { kind: "content", path: "src/a.ts", startLine: "1" });
    assert.equal(candidates[0].signals?.semantic, 0.2);

    const request = requests[0] as RequestShape;
    assert.equal(request.index, "amp-discovery");
    assert.equal(request.size, 50);
    const terms = (request.query?.bool?.filter ?? []).map(entry => Object.entries(entry.term ?? {})[0]);
    assert.deepEqual(terms, [["source", "session_files"], ["tenantId", "t"], ["principalId", "p"], ["sessionId", "s"]]);
    assert.equal(request.query?.bool?.must?.[0].multi_match?.query, "read");
    assert.deepEqual(request.query?.bool?.must?.[0].multi_match?.fields, ["name^4", "keywords^3", "module^2", "summary", "searchText"]);
});

test("Elasticsearch host modules use tenant scope and network is global", async () => {
    const host = fakeClient([{ _source: { ...fileDocument, source: "host_modules", kind: "tool" } }]);
    await createElasticsearchDiscoveryProvider({ client: host.client, index: "host", source: "host_modules" }).search("read", binding);
    const hostTerms = ((host.requests[0] as RequestShape).query?.bool?.filter ?? []).map(entry => Object.keys(entry.term ?? {})[0]);
    assert.deepEqual(hostTerms, ["source", "tenantId"]);

    const web = fakeClient([{ _source: { id: "https://example.com", source: "network", kind: "web", module: "example.com",
        name: "Example", summary: "Read", target: { kind: "web", url: "https://example.com" } } }]);
    const candidates = await createElasticsearchDiscoveryProvider({ client: web.client, index: "web", source: "network" }).search("read", binding);
    assert.equal(candidates[0].scope, undefined);
    const webTerms = ((web.requests[0] as RequestShape).query?.bool?.filter ?? []).map(entry => Object.keys(entry.term ?? {})[0]);
    assert.deepEqual(webTerms, ["source"]);
});

test("Elasticsearch can fold BM25 score into a normalized signal", async () => {
    const { client } = fakeClient([{ _source: fileDocument, _score: 3 }]);
    const provider = createElasticsearchDiscoveryProvider({ client, index: "i", source: "session_files", scoreSignal: "context" });
    const candidates = await provider.search("read", binding);
    assert.equal(candidates[0].signals?.context, 0.75);
    assert.equal(candidates[0].signals?.semantic, 0.2);
});

test("Elasticsearch rejects documents that escape their declared scope", async () => {
    const wrongSource = fakeClient([{ _source: { ...fileDocument, source: "host_modules" } }]);
    await assert.rejects(async () => {
        await createElasticsearchDiscoveryProvider({ client: wrongSource.client, index: "i", source: "session_files" }).search("read", binding);
    }, /source/);

    const wrongSession = fakeClient([{ _source: { ...fileDocument, sessionId: "other" } }]);
    await assert.rejects(async () => {
        await createElasticsearchDiscoveryProvider({ client: wrongSession.client, index: "i", source: "session_files" }).search("read", binding);
    }, /session/);

    const badTarget = fakeClient([{ _source: { ...fileDocument, target: { path: 1 } } }]);
    await assert.rejects(async () => {
        await createElasticsearchDiscoveryProvider({ client: badTarget.client, index: "i", source: "session_files" }).search("read", binding);
    }, /target/);

    const missing = fakeClient([{}]);
    await assert.rejects(async () => {
        await createElasticsearchDiscoveryProvider({ client: missing.client, index: "i", source: "session_files" }).search("read", binding);
    }, /object/);
});

test("Elasticsearch provider participates in gateway discovery", async () => {
    const { client } = fakeClient([{ _source: fileDocument }]);
    const gateway = new AgentGateway({
        handlers: {}, authorize: () => true,
        discovery: { providers: [createElasticsearchDiscoveryProvider({ client, index: "session", source: "session_files" })] },
    });
    const result = await gateway.call(DISCOVER_TOOL_NAME, { query: "read", sources: ["session_files"] }, { binding }) as DiscoveryResult;
    assert.equal(result.returned, 1);
    assert.equal(result.tree.children[0].name, "session_files");
    assert.deepEqual(result.unavailableSources, []);
});

test("Elasticsearch options are bounded and cannot own the amp source", () => {
    const { client } = fakeClient([]);
    assert.throws(() => createElasticsearchDiscoveryProvider({ client, index: "i", source: "amp" as never }), /amp/);
    assert.throws(() => createElasticsearchDiscoveryProvider({ client, index: "", source: "host_modules" }), /index/);
    assert.throws(() => createElasticsearchDiscoveryProvider({ client, index: "i", source: "host_modules", size: 0 }), /size/);
    assert.throws(() => createElasticsearchDiscoveryProvider({ client, index: "i", source: "host_modules", size: 101 }), /size/);
    assert.throws(() => createElasticsearchDiscoveryProvider({ client, index: "i", source: "host_modules", fields: { name: "" } }), /field/);
    assert.throws(() => createElasticsearchDiscoveryProvider({ client, index: "i", source: "host_modules", scope: "world" as never }), /scope/);
});
