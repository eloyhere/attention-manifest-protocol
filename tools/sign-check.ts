#!/usr/bin/env node
/**
 * Signature checks: digest coverage, tamper detection, key revocation.
 */
import assert from "node:assert/strict";

import { generateSigningKey, KeyRegistry, signManifest, verifyManifest, verifyWithRegistry } from "../src/manifest/sign.ts";
import type { KeyPair, VerifyResult } from "../src/manifest/sign.ts";
import type { Manifest } from "../src/types/index.ts";

type UnsignedManifest = Omit<Manifest, "digest" | "signatures">;
type TestCase = () => Promise<void>;

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: TestCase) => Promise<void> = async (name: string, fn: TestCase): Promise<void> => {
    try {
        await fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const unsignedManifest: () => UnsignedManifest = (): UnsignedManifest => {
    return {
        amp: "0.1",
        kind: "manifest",
        agent: { id: "a.gamma", name: "Gamma", version: "0.1.0", role: "analyst" },
        issued: "2026-10-24T07:00:00Z",
        expires: "2026-10-25T07:00:00Z",
        capabilities: [{ id: "logs.query", kind: "tool", confidence: 0.9, tier: "T2" }],
        attention: {
            policy_digest: `sha256:${"0".repeat(64)}`,
            budget: { tokens: 24000 },
        },
        self: { calibration: { ece: 0.1, buckets: [] }, limits: [], state: { load: 0.4, mode: "exploit" } },
    };
};

await test("signed manifest verifies", async () => {
    const key: KeyPair = await generateSigningKey("a.gamma#1");
    const manifest: Manifest = await signManifest(unsignedManifest(), key);
    assert.ok(manifest.digest.startsWith("sha256:"));
    const result: VerifyResult = await verifyManifest(manifest, key.publicKey);
    assert.equal(result.ok, true, result.reasons.join("; "));
});

await test("tampering with an agent field fails the digest check", async () => {
    const key: KeyPair = await generateSigningKey("a.gamma#1");
    const manifest: Manifest = await signManifest(unsignedManifest(), key);
    const tampered: Manifest = { ...manifest, agent: { ...manifest.agent, role: "admin" } };
    const result: VerifyResult = await verifyManifest(tampered, key.publicKey);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes("digest")));
});

await test("a different key cannot verify the signature", async () => {
    const signer: KeyPair = await generateSigningKey("a.gamma#1");
    const other: KeyPair = await generateSigningKey("a.gamma#2");
    const manifest: Manifest = await signManifest(unsignedManifest(), signer);
    const result: VerifyResult = await verifyManifest(manifest, other.publicKey);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes("signature")));
});

await test("re-signing picks up a new digest", async () => {
    const key: KeyPair = await generateSigningKey("a.gamma#1");
    const first: Manifest = await signManifest(unsignedManifest(), key);
    const changed: UnsignedManifest = { ...unsignedManifest(), expires: "2026-10-26T07:00:00Z" };
    const second: Manifest = await signManifest(changed, key);
    assert.notEqual(first.digest, second.digest);
    assert.equal((await verifyManifest(second, key.publicKey)).ok, true);
});

await test("revoked keys stop verifying", async () => {
    const key: KeyPair = await generateSigningKey("a.gamma#1");
    const registry: KeyRegistry = new KeyRegistry();
    registry.add(key.kid, key.publicKey);
    const manifest: Manifest = await signManifest(unsignedManifest(), key);
    assert.equal((await verifyWithRegistry(manifest, registry)).ok, true);

    registry.revoke(key.kid);
    const after: VerifyResult = await verifyWithRegistry(manifest, registry);
    assert.equal(after.ok, false);
    assert.ok(after.reasons.some((reason) => reason.includes("revoked")));
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
