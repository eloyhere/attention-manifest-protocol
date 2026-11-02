#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { catalogSnapshotFixture } from "./helpers/catalogSnapshotFixture.ts";

test("stdio host persists and synchronizes before async multi-hit discovery", async (t) => {
    const remote = catalogSnapshotFixture();
    const requests = remote.requests;
    remote.setSearch((index, request) => {
        const hits = [...index.documents.values()].filter(doc => doc.kind === "tool").slice(0, 2)
            .map(doc => ({ _index: request.path.split("/")[1], _id: doc.id, _score: 1.5, _source: doc }));
        return { took: 1, timed_out: false, _shards: { total: 1, successful: 1, skipped: 0, failed: 0 }, hits: { total: { value: hits.length, relation: "eq" }, max_score: 1.5, hits } };
    });
    const es = createServer(remote.http);
    es.listen(0, "127.0.0.1");
    await once(es, "listening");
    const address = es.address();
    assert.ok(address && typeof address !== "string");
    const directory = await mkdtemp(join(tmpdir(), "amp-workspace-search-"));
    t.after(async () => {
        es.closeAllConnections();
        await new Promise<void>((resolveClose, reject) => es.close((error) => error ? reject(error) : resolveClose()));
        await rm(directory, { recursive: true, force: true });
    });
    const config = join(directory, "host.json");
    await writeFile(config, JSON.stringify({
        version: 1, agentId: "a.search", projectIds: [],
        snapshot: { version: 1, revision: "rev.search", entities: [], relations: [], diagnostics: [] },
        contents: {}, frames: [],
        search: { node: `http://127.0.0.1:${address.port}`, index: "workspace", namespace: "stdio-test", databasePath: "catalog.sqlite" },
    }));
    const child = spawn(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", config], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.stdin.end(`${JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "amp_tool_workspace_discover", arguments: { revision: "rev.search", queries: "workspace tool" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    })}\n`);
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
    assert.equal(signal, null);
    const responses = Buffer.concat(stdout).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.length, 1);
    const outer = responses[0] as { error?: unknown; result?: { content?: { text?: string }[]; isError?: boolean } };
    assert.equal(outer.error, undefined);
    assert.equal(outer.result?.isError, false);
    const wire = JSON.parse(outer.result?.content?.[0]?.text ?? "{}") as { ok?: boolean; data?: { trees?: unknown[] } };
    assert.equal(wire.ok, true);
    assert.equal(wire.data?.trees?.length, 2);
    assert.ok(requests.some(item => item.path.endsWith("/_bulk")));
    assert.ok(requests.some(item => item.path.endsWith("/_search")));
    assert.ok(requests.some(item => item.path.endsWith("/_block/write")));
    assert.ok([...remote.indices.values()].every(index => index.blocked));
});
