#!/usr/bin/env node
/**
 * End-to-end HTTP cooperation check: a real localhost server, an authenticated
 * client, and the transport verdict on 401/200.
 */
import assert from "node:assert/strict";

import type { AttentionManifestDraft } from "../src/governance/index.ts";
import {
    CooperationBus,
    GovernanceKeyring,
    HttpCooperationTransport,
    constraintsFor,
    createAttentionManifest,
    generateGovernanceSigners,
    issueCredential,
    startCooperationServer,
} from "../src/governance/index.ts";
import type { RunningCooperationServer } from "../src/governance/index.ts";

const At: string = "2026-10-28T00:00:00.000Z";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => Promise<void>) => Promise<void> = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const signers = [
    { role: "issuer" as const, by: "general-manager" as const, at: At },
    { role: "legal" as const, by: "legal" as const, at: At },
    { role: "finance" as const, by: "finance" as const, at: At },
];

const draft: (perspective: AttentionManifestDraft["perspective"], scenario: AttentionManifestDraft["scenario"], id: string) => AttentionManifestDraft = (
    perspective,
    scenario,
    id,
) => ({
    id,
    perspective,
    scenario,
    focus: [{ target: { kind: "goal", id: `goal.${id}` }, category: "goal", priority: 0.9, depth: 2 }],
    budget: { scope: "perspective", perspective, cap: { tokens: 1000 }, elasticity: "medium" },
    constraints: constraintsFor(scenario),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
});

const technology = createAttentionManifest(draft("technology", "engineering", "mft.http.tech"), signers);
const marketing = createAttentionManifest(draft("marketing", "office", "mft.http.mkt"), signers);
const credential = issueCredential(
    {
        from: "general-manager",
        to: "marketing",
        reason: "http handoff",
        visibleScope: [{ kind: "goal", id: "goal.mft.http.mkt" }],
        payloadRefs: [],
        budget: { quota: { tokens: 1000 }, elasticity: "medium" },
        constraints: constraintsFor("office"),
        manifest: { id: marketing.id, version: marketing.version },
        scenario: "office",
        issuedAt: At,
    },
    signers,
);

const makeBus = (): CooperationBus => {
    const bus: CooperationBus = new CooperationBus({ now: () => At });
    bus.register({ agentId: "a.tech", perspective: "technology", manifest: technology, budget: { scope: "agent", id: "agt.tech" }, reliability: { alpha: 2, beta: 1 } });
    bus.register({ agentId: "a.mkt", perspective: "marketing", manifest: marketing, budget: { scope: "agent", id: "agt.mkt" }, reliability: { alpha: 2, beta: 1 } });
    return bus;
};

const source: CooperationBus = makeBus();
const target: CooperationBus = makeBus();
const sent = source.handoff("a.tech", "a.mkt", credential, [{ kind: "goal", id: "goal.mft.http.mkt" }], At, "over http");
assert.equal(sent.ok, true);

const transportSigners = await generateGovernanceSigners(["transport"]);
const keyring = new GovernanceKeyring();
keyring.add("transport", transportSigners[0].key.publicKey);
const running: RunningCooperationServer = await startCooperationServer(target, { keyring });

await test("an authenticated localhost client delivers one message", async () => {
    const transport = new HttpCooperationTransport({
        endpoint: running.url,
        auth: { signer: "transport", key: transportSigners[0].key },
    });
    const result = await transport.deliver(sent.message as never);
    assert.equal(result.ok, true);
    assert.equal(target.inbox("a.mkt", At).length, 1);
});

await test("a client without authentication is rejected", async () => {
    const transport = new HttpCooperationTransport({ endpoint: running.url });
    const result = await transport.deliver(sent.message as never);
    assert.equal(result.ok, false);
    assert.equal(result.code, "transport-error");
});

await test("a client with an unknown signing key is rejected", async () => {
    const stranger = await generateGovernanceSigners(["stranger"]);
    const transport = new HttpCooperationTransport({
        endpoint: running.url,
        auth: { signer: "stranger", key: stranger[0].key },
    });
    const result = await transport.deliver(sent.message as never);
    assert.equal(result.ok, false);
});

await running.close();
console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
