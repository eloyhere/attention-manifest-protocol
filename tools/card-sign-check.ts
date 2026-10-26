#!/usr/bin/env node
/**
 * Agent Card signatures: sign, verify, tamper, wrong key.
 */
import assert from "node:assert/strict";

import { signCard, verifyCardSignature } from "../src/manifest/cardSign.ts";
import type { CardSignature } from "../src/manifest/cardSign.ts";
import { generateSigningKey } from "../src/manifest/sign.ts";
import type { KeyPair } from "../src/manifest/sign.ts";
import type { AgentCard } from "../src/manifest/agentCard.ts";

type CardVerification = {
    ok: boolean;
    reasons: string[];
};

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => Promise<void>) => Promise<void> = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
        await fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const card: () => AgentCard = (): AgentCard => ({
    name: "worker-agent",
    version: "1.0.0",
    supportedInterfaces: [{ url: "https://worker.example/a2a", protocolBinding: "JSONRPC" }],
});

await test("signed card verifies", async () => {
    const key: KeyPair = await generateSigningKey("worker#1");
    const signature: CardSignature = await signCard(card(), key);
    const result: CardVerification = await verifyCardSignature(card(), signature, key.publicKey);
    assert.equal(result.ok, true, result.reasons.join("; "));
});

await test("tampering with the endpoint fails", async () => {
    const key: KeyPair = await generateSigningKey("worker#1");
    const signature: CardSignature = await signCard(card(), key);
    const tampered: AgentCard = { ...card(), supportedInterfaces: [{ url: "https://evil.example/a2a" }] };
    const result: CardVerification = await verifyCardSignature(tampered, signature, key.publicKey);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes("signature")));
});

await test("a different key fails", async () => {
    const signer: KeyPair = await generateSigningKey("worker#1");
    const other: KeyPair = await generateSigningKey("worker#2");
    const signature: CardSignature = await signCard(card(), signer);
    assert.equal((await verifyCardSignature(card(), signature, other.publicKey)).ok, false);
});

await test("malformed protected header is rejected", async () => {
    const key: KeyPair = await generateSigningKey("worker#1");
    const result: CardVerification = await verifyCardSignature(card(), { protected: "not-base64-json", signature: "AA" }, key.publicKey);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes("protected")));
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
