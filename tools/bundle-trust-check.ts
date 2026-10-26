#!/usr/bin/env node
/**
 * Bundle → trust registry → card verification.
 */
import assert from "node:assert/strict";

import type { AgentCard } from "../src/manifest/agentCard.ts";
import { signCard, verifyCardWithRegistry } from "../src/manifest/cardSign.ts";
import type { CardSignature } from "../src/manifest/cardSign.ts";
import { exportBundle, registryFromBundle } from "../src/manifest/federation.ts";
import type { ManifestBundle } from "../src/manifest/federationTypes.ts";
import type { Manifest as ManifestRecord } from "../src/manifest/manifest.ts";
import { generateSigningKey, signManifest } from "../src/manifest/sign.ts";
import type { KeyPair, KeyRegistry } from "../src/manifest/sign.ts";
import type { Timestamp } from "../src/types/common.ts";

/**
 * A single asynchronous check: the name printed in the report and its body.
 */
type Test = (name: string, fn: () => Promise<void>) => Promise<void>;

/**
 * Validity window handed to the bundle exporter.
 */
type ExportWindow = {
    issued: Timestamp;
    expires: Timestamp;
    revoked?: string[];
};

/**
 * Outcome of verifying a card against a registry.
 */
type CardVerdict = {
    ok: boolean;
    reasons: string[];
};

let Passed: number = 0;
let Failed: number = 0;

const test: Test = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed += 1;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const Key: KeyPair = await generateSigningKey("worker#1");
const Manifest: ManifestRecord = await signManifest(
    {
        amp: "0.1",
        kind: "manifest",
        agent: { id: "a.worker" },
        issued: "2026-10-24T07:00:00Z",
        expires: "2026-10-25T07:00:00Z",
        capabilities: [{ id: "tool.x", kind: "tool", confidence: 0.9, tier: "T2" }],
        attention: { policy_digest: `sha256:${"0".repeat(64)}`, budget: { tokens: 1000 } },
        self: { calibration: { ece: 0.1, buckets: [] } },
    },
    Key,
);
const Window: ExportWindow = { issued: "2026-10-24T07:00:00Z", expires: "2026-10-26T07:00:00Z" };
const Card: AgentCard = { name: "worker-agent", supportedInterfaces: [{ url: "https://worker.example/a2a" }] };

await test("bundle keys populate the registry and verify a card", async () => {
    const bundle: ManifestBundle = await exportBundle(Manifest, Key, Window);
    const registry: KeyRegistry = await registryFromBundle(bundle);
    const signature: CardSignature = await signCard(Card, Key);
    const result: CardVerdict = await verifyCardWithRegistry(Card, signature, registry);
    assert.equal(result.ok, true, result.reasons.join("; "));
});

await test("revoked kids in the bundle stay revoked", async () => {
    const bundle: ManifestBundle = await exportBundle(Manifest, Key, { ...Window, revoked: [Key.kid] });
    const registry: KeyRegistry = await registryFromBundle(bundle);
    assert.equal(registry.get(Key.kid), undefined);
});

await test("a bundle without the signing key cannot verify the card", async () => {
    const other: KeyPair = await generateSigningKey("worker#2");
    const bundle: ManifestBundle = await exportBundle(Manifest, other, Window);
    const registry: KeyRegistry = await registryFromBundle(bundle);
    const signature: CardSignature = await signCard(Card, Key);
    const result: CardVerdict = await verifyCardWithRegistry(Card, signature, registry);
    assert.equal(result.ok, false);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
