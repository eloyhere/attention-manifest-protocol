#!/usr/bin/env node
/**
 * HTTP channel: real local round trip, idempotency key, timeout, rejection.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { digestOf } from "../src/semantic/canonical.ts";
import { delegateOver } from "../src/protocol/channel.ts";
import { HttpTeamChannel } from "../src/protocol/httpChannel.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation } from "../src/delegate/team.ts";
import type { DelegationDoc } from "../src/cooperation/collaboration.ts";
import type { Budget } from "../src/types/common.ts";
import { listen, portOf } from "./_helpers.ts";

let Passed: number = 0;
let Failed: number = 0;

type AsyncTest = (name: string, fn: () => Promise<void>) => Promise<void>;

const test: AsyncTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
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

type DelegationFactory = (budget?: Budget) => Delegation;

const delegation: DelegationFactory = (budget: Budget = { tokens: 100 }): Delegation =>
    new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" }).createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: Goal,
        scope: ["tool.logs.query"],
        budget,
        deadline: "2026-10-24T12:00:00Z",
        mayRedelegate: false,
        depth: 0,
    });

type EnvelopeBody = {
    kind?: string;
    delegation?: {
        budget?: {
            tokens?: number;
        };
    };
};

type SeenEntry = {
    key: string | string[];
    envelope: EnvelopeBody;
};

const Seen: SeenEntry[] = [];

const HttpServer: Server = createServer((req, res) => {
    let body: string = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
        const envelope: EnvelopeBody = JSON.parse(body || "{}");
        Seen.push({ key: req.headers["idempotency-key"], envelope });
        if (req.url === "/slow") {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ accepted: true }));
            }, 200);
            return;
        }
        const tooWide: boolean = (envelope.delegation?.budget?.tokens ?? 0) > 50;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(tooWide ? { accepted: false, reason: "peer ceiling" } : { accepted: true }));
    });
});

await listen(HttpServer);
const Port: number = portOf(HttpServer);
const Url: string = `http://127.0.0.1:${Port}/delegate`;

await test("accepted delegation crosses HTTP with an idempotency key", async () => {
    const channel: HttpTeamChannel = new HttpTeamChannel({ url: Url });
    const doc: DelegationDoc = await delegateOver(channel, delegation({ tokens: 40 }));
    assert.equal(doc.goal_digest, Goal);
    assert.equal(Seen.at(-1).key, digestOf(doc));
    assert.equal(Seen.at(-1).envelope.kind, "delegation-envelope");
});

await test("peer rejection is surfaced as a reason", async () => {
    const channel: HttpTeamChannel = new HttpTeamChannel({ url: Url });
    await assert.rejects(() => delegateOver(channel, delegation({ tokens: 100 })), /peer ceiling/);
});

await test("timeout fails closed instead of hanging", async () => {
    const channel: HttpTeamChannel = new HttpTeamChannel({ url: `http://127.0.0.1:${Port}/slow`, timeoutMs: 50 });
    await assert.rejects(() => delegateOver(channel, delegation({ tokens: 10 })), /timeout/);
});

await test("HTTP error status fails closed", async () => {
    const channel: HttpTeamChannel = new HttpTeamChannel({ url: `http://127.0.0.1:${Port}/missing` });
    const server404: Server = createServer((request, res) => {
        res.writeHead(503);
        res.end();
    });
    await listen(server404);
    const failing: HttpTeamChannel = new HttpTeamChannel({ url: `http://127.0.0.1:${portOf(server404)}/x` });
    void channel;
    await assert.rejects(() => delegateOver(failing, delegation({ tokens: 10 })), /HTTP 503/);
    await new Promise((resolve) => server404.close(resolve));
});

HttpServer.close();

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
