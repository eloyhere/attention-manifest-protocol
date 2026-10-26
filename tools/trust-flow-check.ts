#!/usr/bin/env node
/**
 * Cross-domain: domain A's bundle endorses domain B's card, then B accepts a delegation.
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer } from "node:http";

import { TeamRuntime } from "../src/delegate/team.ts";
import type { Delegation } from "../src/delegate/team.ts";
import type { AgentCard } from "../src/manifest/agentCard.ts";
import { signCard } from "../src/manifest/cardSign.ts";
import type { CardSignature } from "../src/manifest/cardSign.ts";
import { attest, exportBundle } from "../src/manifest/federation.ts";
import type { Attestation, ManifestBundle } from "../src/manifest/federationTypes.ts";
import type { Manifest } from "../src/manifest/manifest.ts";
import { generateSigningKey, KeyRegistry, signManifest } from "../src/manifest/sign.ts";
import type { KeyPair } from "../src/manifest/sign.ts";
import { fetchTrustedAgent } from "../src/manifest/trust.ts";
import type { TrustResult } from "../src/manifest/trust.ts";
import { channelFromCard } from "../src/protocol/a2a.ts";
import type { A2AChannel } from "../src/protocol/a2a.ts";
import { delegateOver } from "../src/protocol/channel.ts";
import { listen, portOf } from "./_helpers.ts";

type TestFn = () => Promise<void>;

type Test = (name: string, fn: TestFn) => Promise<void>;

let Passed: number = 0;
let Failed: number = 0;

const test: Test = async (name: string, fn: TestFn): Promise<void> => {
    try {
        await fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

/**
 * Domain B: the worker agent, its card and its A2A endpoint.
 */
const WorkerKey: KeyPair = await generateSigningKey("worker#1");
let Port: number = 0;
const Calls: Record<string, unknown>[] = [];
const HttpServer: Server = createServer((req, res) => {
    let body: string = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
        if (req.url === "/.well-known/agent-card.json") {
            const card: AgentCard = { name: "worker-agent", supportedInterfaces: [{ url: `http://127.0.0.1:${Port}/a2a` }] };
            const signature: CardSignature = await signCard(card, WorkerKey);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ...card, signatures: [signature] }));
            return;
        }
        Calls.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { kind: "task", id: "task-1", status: { state: "submitted" } } }));
    });
});
await listen(HttpServer);
Port = portOf(HttpServer);
const DomainB: string = `http://127.0.0.1:${Port}`;

/**
 * Domain A: the worker's own organization signs a manifest and endorses it.
 */
const ManifestDoc: Manifest = await signManifest(
    {
        amp: "0.1",
        kind: "manifest",
        agent: { id: "a.worker" },
        issued: "2026-10-24T07:00:00Z",
        expires: "2026-10-25T07:00:00Z",
        capabilities: [{ id: "tool.logs.query", kind: "tool", confidence: 0.9, tier: "T2" }],
        attention: { policy_digest: `sha256:${"0".repeat(64)}`, budget: { tokens: 1000 } },
        self: { calibration: { ece: 0.1, buckets: [] } },
    },
    WorkerKey,
);
const OrgKey: KeyPair = await generateSigningKey("org.acme#1");
const AttestationRecord: Attestation = await attest({
    id: "at.1",
    issuer: { kind: "org", id: "org.acme" },
    manifest: ManifestDoc,
    scope: ["reviewed", "tool.logs.query"],
    issued: "2026-10-24T07:05:00Z",
    expires: "2027-01-24T07:05:00Z",
    key: OrgKey,
});
const ValidWindow: Pick<Manifest, "issued" | "expires"> = { issued: "2026-10-24T07:00:00Z", expires: "2026-10-26T07:00:00Z" };
const Bundle: ManifestBundle = await exportBundle(ManifestDoc, WorkerKey, { ...ValidWindow, attestations: [AttestationRecord] });

const IssuerKeys: KeyRegistry = new KeyRegistry();
IssuerKeys.add(OrgKey.kid, OrgKey.publicKey);

await test("discovery + policy accept the endorsed card", async () => {
    const trusted: TrustResult = await fetchTrustedAgent(DomainB, {
        bundle: Bundle,
        policy: { requiredScopes: ["reviewed"] },
        issuerKeys: IssuerKeys,
    });
    assert.equal(trusted.ok, true, trusted.reasons.join("; "));
    assert.equal(trusted.endpoint, `http://127.0.0.1:${Port}/a2a`);
    assert.ok(trusted.scopes.includes("reviewed"));
});

await test("delegation flows to the discovered endpoint over A2A", async () => {
    const trusted: TrustResult = await fetchTrustedAgent(DomainB, {
        bundle: Bundle,
        policy: { requiredScopes: ["reviewed"] },
        issuerKeys: IssuerKeys,
    });
    const channel: A2AChannel = channelFromCard(trusted);
    const delegation: Delegation = new TeamRuntime({ now: () => "2026-10-24T10:00:00Z" }).createDelegation({
        granter: "a.lead",
        delegatee: "a.worker",
        goalDigest: `sha256:${"a".repeat(64)}`,
        scope: [],
        budget: { tokens: 10 },
        deadline: "2026-10-24T12:00:00Z",
        mayRedelegate: false,
        depth: 0,
    });
    await delegateOver(channel, delegation);
    assert.equal(Calls.at(-1).method, "message/send");
});

await test("a missing scope fails the policy gate", async () => {
    const trusted: TrustResult = await fetchTrustedAgent(DomainB, {
        bundle: Bundle,
        policy: { requiredScopes: ["admin"] },
        issuerKeys: IssuerKeys,
    });
    assert.equal(trusted.ok, false);
    assert.ok(trusted.reasons.some((reason) => reason.includes("missing required scope: admin")));
});

await test("an untrusted issuer key is rejected, not silently ignored", async () => {
    const trusted: TrustResult = await fetchTrustedAgent(DomainB, {
        bundle: Bundle,
        policy: { requiredScopes: ["reviewed"] },
        issuerKeys: new KeyRegistry(),
    });
    assert.equal(trusted.ok, false);
    assert.ok(trusted.reasons.some((reason) => reason.includes("unknown issuer key")));
});

HttpServer.close();
console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
