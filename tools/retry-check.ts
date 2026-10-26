#!/usr/bin/env node
/**
 * Retry behaviour: safe because the same idempotency key is reused.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { listen } from "./_helpers.ts";

import { digestOf } from "../src/semantic/canonical.ts";
import { delegateOver } from "../src/protocol/channel.ts";
import { HttpTeamChannel } from "../src/protocol/httpChannel.ts";
import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation } from "../src/delegate/team.ts";

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
const delegation: () => Delegation = () =>
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

let FailuresLeft: number = 2;
const Keys: (string | string[])[] = [];
const HttpServer: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        Keys.push(req.headers["idempotency-key"]);
        if (FailuresLeft > 0) {
            FailuresLeft -= 1;
            res.writeHead(503);
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
    });
});
const Port: number = await listen(HttpServer);
const Url: string = `http://127.0.0.1:${Port}/delegate`;

await test("retries 5xx then succeeds with the same key", async () => {
    const channel: HttpTeamChannel = new HttpTeamChannel({ url: Url, retries: 3, backoffMs: 5 });
    await delegateOver(channel, delegation());
    assert.equal(channel.attempts, 3);
    assert.equal(new Set(Keys).size, 1);
    assert.equal(Keys[0], digestOf(channel.sent[0].envelope.delegation));
});

await test("exhausted retries fail closed", async () => {
    FailuresLeft = 5;
    const channel: HttpTeamChannel = new HttpTeamChannel({ url: Url, retries: 1, backoffMs: 5 });
    await assert.rejects(() => delegateOver(channel, delegation()), /HTTP 503/);
    assert.equal(channel.attempts, 2);
    FailuresLeft = 0;
});

HttpServer.close();

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
