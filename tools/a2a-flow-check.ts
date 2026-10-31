#!/usr/bin/env node
/**
 * Closed loop: discover an Agent Card, then send a real A2A delegation to it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { channelFromCard } from "../src/protocol/a2a.ts";
import type { A2AChannel } from "../src/protocol/a2a.ts";
import { fetchAgentCard } from "../src/manifest/agentCard.ts";
import type { CardResult } from "../src/manifest/agentCard.ts";
import { delegateOver } from "../src/protocol/channel.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation } from "../src/delegate/team.ts";
import { listen, portOf } from "./_helpers.ts";

/**
 * A JSON-RPC request recorded by the fake A2A server.
 */
type RecordedRequest = {
    id: string;
    method: string;
    params: {
        message: {
            metadata: Record<string, string>;
        };
    };
};

const Calls: RecordedRequest[] = [];
let Port: number = 0;
const HttpServer: Server = createServer((req, res) => {
    let body: string = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
        if (req.url === "/.well-known/agent-card.json") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    name: "worker-agent",
                    supportedInterfaces: [{ url: `http://127.0.0.1:${Port}/a2a`, protocolBinding: "JSONRPC" }],
                }),
            );
            return;
        }
        const request: RecordedRequest = JSON.parse(body);
        Calls.push(request);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { kind: "task", id: "task-7", status: { state: "submitted" } } }));
    });
});
await listen(HttpServer);
Port = portOf(HttpServer);

const Goal: string = `sha256:${"a".repeat(64)}`;
const Card: CardResult = await fetchAgentCard(`http://127.0.0.1:${Port}`);
assert.equal(Card.ok, true, Card.reasons.join("; "));

const Channel: A2AChannel = channelFromCard(Card);
const Grant: Delegation = new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" }).createDelegation({
    granter: "a.lead",
    delegatee: "a.worker",
    goalDigest: Goal,
    scope: [],
    budget: { tokens: 10 },
    deadline: "2026-10-24T12:00:00Z",
    mayRedelegate: false,
    depth: 0,
});
await delegateOver(Channel, Grant);

assert.equal(Calls.length, 1);
assert.equal(Calls[0].method, "message/send");
assert.equal(Calls[0].params.message.metadata["io.amp/version"], "0.1");

await new Promise((resolve) => HttpServer.close(resolve));
console.log("✓ discover → channelFromCard → message/send accepted");
