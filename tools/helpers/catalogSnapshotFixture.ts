import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "@elastic/elasticsearch";

export type Json = Record<string, any>;
export interface SnapshotRequest { method: string; path: string; body: Json; lines: Json[]; }
export interface SnapshotIndex { mappings: Json; documents: Map<string, Json>; blocked: boolean; }
export const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};

/** Stateful wire/SDK fixture: every attempt owns a separate physical index. */
export function catalogSnapshotFixture(indices = new Map<string, SnapshotIndex>()) {
    const requests: SnapshotRequest[] = [];
    let before: ((request: SnapshotRequest) => Promise<void>) | undefined;
    let search: ((index: SnapshotIndex, request: SnapshotRequest) => Json | Promise<Json>) | undefined;
    let failBulk = false;
    const shards = { total: 1, successful: 1, skipped: 0, failed: 0 };
    const execute = async (request: SnapshotRequest): Promise<Json> => {
        requests.push(request);
        await before?.(request);
        const parts = request.path.split("/").filter(Boolean).map(decodeURIComponent);
        if (parts[0] === "_resolve") {
            const name = parts[2];
            return { indices: indices.has(name) ? [{ name, attributes: ["open"] }] : [], aliases: [], data_streams: [] };
        }
        const name = parts[0];
        if (request.method === "PUT" && parts.length === 1) {
            assert.ok(!indices.has(name), "snapshot creation must never adopt an existing index");
            indices.set(name, { mappings: structuredClone(request.body.mappings ?? {}), documents: new Map(), blocked: false });
            return { acknowledged: true, shards_acknowledged: true, index: name };
        }
        if (request.method === "HEAD") return { exists: indices.has(name) };
        const state = indices.get(name);
        if (!state && parts.at(-1) === "_search") return { took: 1, timed_out: false, _shards: shards, hits: { total: { value: 0, relation: "eq" }, hits: [] } };
        assert.ok(state, `unknown fixture index ${name}`);
        if (parts[1] === "_mapping") return { [name]: { mappings: structuredClone(state.mappings) } };
        if (parts[1] === "_settings") return { [name]: { settings: { index: { blocks: { write: state.blocked } } } } };
        if (parts[1] === "_refresh") return { _shards: shards };
        if (parts[1] === "_block" && parts[2] === "write") {
            state.blocked = true;
            return { acknowledged: true, shards_acknowledged: true, indices: [{ name, blocked: true }] };
        }
        if (parts[1] === "_bulk") {
            assert.equal(state.blocked, false, "write-blocked snapshots reject further writes");
            const items = [];
            for (let i = 0; i < request.lines.length; i += 2) {
                const action = request.lines[i].index;
                const source = request.lines[i + 1];
                assert.equal(action._index ?? name, name);
                assert.equal(action._id, source.id);
                if (!failBulk) state.documents.set(action._id, structuredClone(source));
                items.push({ index: { _id: action._id, status: failBulk ? 429 : 201,
                    ...(failBulk ? { error: { type: "es_rejected_execution_exception", reason: "queue full" } } : {}) } });
            }
            return { errors: failBulk, items };
        }
        if (parts[1] === "_count") return { count: state.documents.size, _shards: shards };
        if (parts[1] === "_mget") return { docs: request.body.ids.map((id: string) => {
            const source = state.documents.get(id);
            return { _index: name, _id: id, found: source !== undefined, ...(source === undefined ? {} : { _source: structuredClone(source) }) };
        }) };
        if (parts[1] === "_search") {
            if (search) return search(state, request);
            const hits = [...state.documents.entries()].map(([id, source]) => ({ _index: name, _id: id, _score: 1, _source: structuredClone(source) }));
            return { took: 1, timed_out: false, _shards: shards, hits: { total: { value: hits.length, relation: "eq" }, hits } };
        }
        throw new Error(`unexpected fixture route ${request.method} ${request.path}`);
    };
    const http = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const ndjson = String(req.headers["content-type"]).includes("ndjson");
            const request: SnapshotRequest = { method: req.method ?? "", path: new URL(req.url ?? "/", "http://fixture").pathname,
                body: text && !ndjson ? JSON.parse(text) : {}, lines: text && ndjson ? text.trimEnd().split("\n").map(line => JSON.parse(line)) : [] };
            const body = await execute(request);
            res.writeHead(request.method === "HEAD" && !body.exists ? 404 : 200, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
            res.end(request.method === "HEAD" ? undefined : JSON.stringify(body));
        } catch (error) {
            res.writeHead(500, { "content-type": "application/json", "x-elastic-product": "Elasticsearch" });
            res.end(JSON.stringify({ error: { type: "fixture_error", reason: String(error) }, status: 500 }));
        }
    };
    const call = (method: string, path: string, body: Json = {}, lines: Json[] = []) => execute({ method, path, body, lines });
    const fakeClient = {
        indices: {
            create: (input: Json) => call("PUT", `/${input.index}`, input),
            exists: async (input: Json) => (await call("HEAD", `/${input.index}`)).exists,
            resolveIndex: (input: Json) => call("GET", `/_resolve/index/${input.name}`),
            getMapping: (input: Json) => call("GET", `/${input.index}/_mapping`),
            getSettings: (input: Json) => call("GET", `/${input.index}/_settings`),
            refresh: (input: Json) => call("POST", `/${input.index}/_refresh`),
            addBlock: (input: Json) => call("PUT", `/${input.index}/_block/${input.block}`),
        },
        bulk: (input: Json) => call("POST", `/${input.index}/_bulk`, {}, input.operations),
        count: (input: Json) => call("POST", `/${input.index}/_count`),
        mget: (input: Json) => call("POST", `/${input.index}/_mget`, input),
        search: (input: Json) => call("POST", `/${input.index}/_search`, input),
        close: async () => {},
    } as unknown as Client;
    return { indices, requests, http, fakeClient,
        intercept(value?: (request: SnapshotRequest) => Promise<void>) { before = value; },
        setSearch(value?: (index: SnapshotIndex, request: SnapshotRequest) => Json | Promise<Json>) { search = value; },
        setFailBulk(value: boolean) { failBulk = value; },
    };
}
