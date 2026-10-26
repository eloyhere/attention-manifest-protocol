#!/usr/bin/env node
/**
 * A2A v1.0 binding: request shape, task acceptance, RPC error handling.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { toA2ARequest, A2AChannel } from "../src/protocol/a2a.ts";
import type { A2ARequest } from "../src/protocol/a2a.ts";
import type { DelegationDoc } from "../src/cooperation/collaboration.ts";
import { delegateOver } from "../src/protocol/channel.ts";
import { digestOf } from "../src/semantic/canonical.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation } from "../src/delegate/team.ts";
import { toDelegationDoc } from "../src/protocol/wire.ts";
import { listen, portOf } from "./_helpers.ts";

type ReceivedRequest = {
    request: A2ARequest;
    version: string | string[] | undefined;
};

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => Promise<void> = async (name: string, fn: () => void): Promise<void> => {
    try {
        await fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Goal: string = `sha256:${"a".repeat(64)}`;
const delegation: () => Delegation = (): Delegation =>
    new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" }).createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: [],
        budget: { tokens: 10 },
        deadline: "2026-10-24T12:00:00Z",
        mayRedelegate: false,
        depth: 0,
    });

const Received: ReceivedRequest[] = [];
let Mode: string = "task";
const HttpServer: Server = createServer((req, res) => {
    let body: string = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
        const request: A2ARequest = JSON.parse(body);
        Received.push({ request, version: req.headers["a2a-version"] });
        res.writeHead(200, { "content-type": "application/json" });
        if (Mode === "error") {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "Task not found" } }));
        } else if (Mode === "task") {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { kind: "task", id: "task-1", status: { state: "submitted" } } }));
        } else {
            res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { kind: "message", messageId: "m-1", role: "agent", parts: [] } }));
        }
    });
});
await listen(HttpServer);
const Url: string = `http://127.0.0.1:${portOf(HttpServer)}/a2a`;

await test("request is a real A2A message/send envelope", () => {
    const doc: DelegationDoc = toDelegationDoc(delegation());
    const request: A2ARequest = toA2ARequest(doc);
    assert.equal(request.method, "message/send");
    assert.equal(request.params.message.kind, "message");
    assert.equal(request.params.message.role, "user");
    assert.equal(request.params.message.parts.length, 2);
    assert.equal(request.params.message.parts[1].kind, "data");
    assert.equal(request.params.message.metadata["io.amp/delegation_digest"], digestOf(doc));
});

await test("task result means accepted, with the A2A state surfaced", async () => {
    Mode = "task";
    const channel: A2AChannel = new A2AChannel({ url: Url });
    await delegateOver(channel, delegation());
    const last: ReceivedRequest = Received.at(-1);
    assert.equal(last.request.method, "message/send");
    assert.equal(last.version, "1.0");
});

await test("agent message result is also accepted", async () => {
    Mode = "message";
    const channel: A2AChannel = new A2AChannel({ url: Url });
    await delegateOver(channel, delegation());
    assert.equal(channel.requests.length, 1);
});

await test("JSON-RPC error fails closed with the code", async () => {
    Mode = "error";
    const channel: A2AChannel = new A2AChannel({ url: Url });
    await assert.rejects(() => delegateOver(channel, delegation()), /A2A -32001/);
});

HttpServer.close();

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
