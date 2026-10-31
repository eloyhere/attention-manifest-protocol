#!/usr/bin/env node
/**
 * Card trust: signature resolved through a registry, not the card itself.
 */
import assert from "node:assert/strict";

import { signCard, verifyCardWithRegistry } from "../src/manifest/cardSign.ts";
import type { CardSignature } from "../src/manifest/cardSign.ts";
import type { AgentCard } from "../src/manifest/agentCard.ts";
import { generateSigningKey, KeyRegistry } from "../src/manifest/sign.ts";
import type { KeyPair } from "../src/manifest/sign.ts";

/**
 * Outcome of a registry-backed card verification.
 */
type VerifyOutcome = {
    ok: boolean;
    reasons: string[];
};

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => Promise<void>) => Promise<void> = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed += 1;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const card: () => AgentCard = (): AgentCard => ({
    name: "worker-agent",
    supportedInterfaces: [{ url: "https://worker.example/a2a" }],
});

await test("registered key verifies the card", async () => {
    const key: KeyPair = await generateSigningKey("worker#1");
    const signature: CardSignature = await signCard(card(), key);
    const registry: KeyRegistry = new KeyRegistry();
    registry.add(key.kid, key.publicKey);
    const result: VerifyOutcome = await verifyCardWithRegistry(card(), signature, registry);
    assert.equal(result.ok, true, result.reasons.join("; "));
});

await test("unknown kid is rejected before verification", async () => {
    const key: KeyPair = await generateSigningKey("worker#1");
    const signature: CardSignature = await signCard(card(), key);
    const result: VerifyOutcome = await verifyCardWithRegistry(card(), signature, new KeyRegistry());
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes("unknown or revoked")));
});

await test("revoked kid is rejected even with a valid signature", async () => {
    const key: KeyPair = await generateSigningKey("worker#1");
    const signature: CardSignature = await signCard(card(), key);
    const registry: KeyRegistry = new KeyRegistry();
    registry.add(key.kid, key.publicKey);
    registry.revoke(key.kid);
    assert.equal((await verifyCardWithRegistry(card(), signature, registry)).ok, false);
});

await test("a card signed by a different key fails even if that key is trusted", async () => {
    const signer: KeyPair = await generateSigningKey("worker#1");
    const impostor: KeyPair = await generateSigningKey("worker#2");
    const signature: CardSignature = await signCard(card(), signer);
    const registry: KeyRegistry = new KeyRegistry();
    registry.add(impostor.kid, impostor.publicKey);
    assert.equal((await verifyCardWithRegistry(card(), signature, registry)).ok, false);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
