#!/usr/bin/env node
/** Opt-in real-cluster faults. ES_TEST_URL must identify a disposable test cluster. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { Client } from "@elastic/elasticsearch";
import { Database } from "../src/database/service/database.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import { CatalogSearch, catalogSearchId } from "../src/search/catalogSearch.ts";
import { ElasticsearchSearch } from "../src/search/elasticsearch.ts";

const node = process.env.ES_TEST_URL;
const entry = (id: string): CatalogRecord => ({ id, kind: "knowledge", name: `boundary ${id}`, summary: "real cluster test", projectId: "p", revision: "r1", tags: [], searchTerms: [], payload: { content: `boundary ${id}` } });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test("real Elasticsearch: immutable snapshots, write block, late bulk, recovery and hostile mutation", { skip: node === undefined ? "Set ES_TEST_URL to an isolated Elasticsearch test endpoint" : false, timeout: 120_000 }, async t => {
    assert.ok(node);
    const client = new Client({ node, maxRetries: 0, requestTimeout: 15_000 });
    const prefix = `amp-fault-${randomUUID()}`;
    const namespace = "real-fault/中文";
    const directory = await mkdtemp(join(tmpdir(), "amp-real-es-"));
    const dbPath = join(directory, "catalog.sqlite");
    let db = new Database(dbPath);
    const make = (database = db, connection = client, ns = namespace) => new CatalogSearch({ namespace: ns, catalog: database.catalogService, search: new ElasticsearchSearch({ client: connection, index: prefix }) });
    let catalog = make();
    const created = new Set<string>();
    const remember = () => { const index = db.catalogService.publication(namespace).index; if (index) created.add(index); return index!; };
    t.after(async () => {
        await catalog.close(); db.close();
        // Only this run's UUID prefix can be removed; never delete an unrelated name.
        const resolution = await client.indices.resolveIndex({ name: `${prefix}*` });
        for (const index of resolution.indices) {
            assert.ok(index.name.startsWith(prefix));
            await client.indices.delete({ index: index.name });
        }
        await client.close(); await rm(directory, { recursive: true, force: true });
    });
    await t.test("connects to a real 9.x node", async () => {
        const info = await client.info();
        assert.match(info.version.number, /^9\./);
        console.log(`REAL_ES_VERSION=${info.version.number} CLUSTER=${info.cluster_name}`);
    });
    await t.test("shared configured prefix and alias are untouched; namespaces publish separate indices", async () => {
        await client.indices.create({ index: prefix, settings: { number_of_replicas: 0 }, mappings: { properties: { note: { type: "keyword" } } } });
        await client.index({ index: prefix, id: "external", document: { note: "must survive" }, refresh: true });
        await client.indices.putAlias({ index: prefix, name: `${prefix}-alias` });
        catalog.replaceSnapshot([entry("first")]); await catalog.sync();
        const first = remember(); assert.notEqual(first, prefix);
        const other = make(db, client, "another-namespace");
        other.replaceSnapshot([entry("other")]); await other.sync();
        assert.notEqual(db.catalogService.publication("another-namespace").index, first);
        await other.close();
        assert.equal((await client.get<{ note: string }>({ index: `${prefix}-alias`, id: "external" }))._source?.note, "must survive");
        assert.equal((await catalog.discover({ projectIds: ["p"] }, "first")).trees[0].tree.id, "first");
    });
    await t.test("published index rejects direct external index, update and delete writes", async () => {
        const index = remember();
        const id = catalogSearchId(namespace, "knowledge", "first");
        await assert.rejects(() => client.index({ index, id: "attacker", document: { id: "attacker" } }), /cluster_block_exception/);
        await assert.rejects(() => client.update({ index, id, doc: { title: "poison" } }), /cluster_block_exception/);
        await assert.rejects(() => client.delete({ index, id }), /cluster_block_exception/);
    });
    await t.test("admin removing write block or overwriting content fails closed, then full sync recovers", async () => {
        const index = remember();
        await client.indices.putSettings({ index, settings: { "index.blocks.write": false } });
        await assert.rejects(() => catalog.discover({ projectIds: ["p"] }, "first"), /write-blocked/);
        const id = catalogSearchId(namespace, "knowledge", "first");
        await client.update({ index, id, doc: { title: "poison", content: "poison" }, refresh: true });
        await client.indices.addBlock({ index, block: "write" });
        await assert.rejects(() => catalog.discover({ projectIds: ["p"] }, "poison"), /digest mismatch/);
        await catalog.sync(); remember();
        assert.equal((await catalog.discover({ projectIds: ["p"] }, "first")).trees[0].tree.label, "boundary first");
    });
    await t.test("real bulk accepted before coordinator timeout; immediate retry wins and late completion cannot publish", async () => {
        const accepted = deferred(); const release = deferred();
        let gated = false;
        const proxy = createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const path = req.url ?? "/";
            const upstream = httpRequest(new URL(path, node), { method: req.method, headers: { ...req.headers, host: new URL(node).host } }, response => {
                const result: Buffer[] = [];
                response.on("data", (chunk: Buffer) => result.push(chunk));
                response.on("end", () => { void (async () => {
                    if (path.includes("_bulk") && !gated) { gated = true; accepted.resolve(); await release.promise; }
                    res.writeHead(response.statusCode ?? 500, response.headers); res.end(Buffer.concat(result));
                })(); });
            });
            upstream.on("error", error => { res.writeHead(502); res.end(String(error)); });
            upstream.end(Buffer.concat(chunks));
        });
        proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
        const address = proxy.address(); assert.ok(address && typeof address !== "string");
        const delayed = new Client({ node: `http://127.0.0.1:${address.port}`, maxRetries: 0, requestTimeout: 15_000 });
        const old = make(db, delayed);
        const abort = new AbortController();
        const pending = old.sync({ signal: abort.signal });
        const failure = assert.rejects(pending, /test timeout/);
        try {
            await accepted.promise;
            abort.abort(new Error("test timeout after real server bulk completion")); await failure;
            catalog.replaceSnapshot([entry("fresh")]); await catalog.sync(); const fresh = remember();
            release.resolve(); await old.close();
            assert.equal(db.catalogService.publication(namespace).index, fresh);
            assert.equal((await catalog.discover({ projectIds: ["p"] }, "fresh")).trees[0].tree.id, "fresh");
        } finally {
            release.resolve(); await delayed.close(); proxy.closeAllConnections();
            await new Promise<void>(resolve => proxy.close(() => resolve()));
        }
    });
    await t.test("unpublished abandoned epoch survives SQLite reopen and requires no manual lock recovery", async () => {
        db.catalogService.beginPublication(namespace); // Same durable state as process death before publish.
        await catalog.close(); db.close(); db = new Database(dbPath); catalog = make();
        await catalog.sync(); remember();
        assert.equal((await catalog.discover({ projectIds: ["p"] }, "fresh")).trees[0].tree.id, "fresh");
    });
    await t.test("real closed-index failure is observable and rebuilding in another index restores discovery", async () => {
        const index = remember(); await client.indices.close({ index });
        await assert.rejects(() => catalog.discover({ projectIds: ["p"] }, "fresh"));
        await catalog.sync(); remember();
        assert.equal((await catalog.discover({ projectIds: ["p"] }, "fresh")).trees[0].tree.id, "fresh");
    });
    await t.test("raw SQL cannot dirty catalog silently, forge publication or acknowledge generation", () => {
        for (const sql of ["UPDATE catalog_entries SET name='poison'", "DELETE FROM catalog_entries", "UPDATE catalog_sync_state SET synced_generation=generation", "UPDATE catalog_search_publication SET index_name='foreign'"]) {
            assert.throws(() => db.db.exec(sql), /CatalogService/);
        }
    });
});
