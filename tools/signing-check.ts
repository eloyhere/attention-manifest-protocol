#!/usr/bin/env node
/**
 * Ed25519 governance-signature checks.
 *
 * The governance sign-off and the cryptographic signature are separate
 * evidence layers: these tests prove the crypto layer binds signer, subject,
 * id, version and digest, survives a keyring reload, and fails closed on
 * tampering, transplants and revocation.
 */
import assert from "node:assert/strict";

import type { AttentionManifestDraft } from "../src/governance/index.ts";
import { generateSigningKey } from "../src/manifest/sign.ts";
import {
    GovernanceKeyring,
    constraintsFor,
    createAttentionManifest,
    generateGovernanceSigners,
    issueCredential,
    signGovernanceObject,
    verifyGovernanceBundle,
} from "../src/governance/index.ts";

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

const signerNames: readonly string[] = ["general-manager", "legal", "finance"];

const signers = await generateGovernanceSigners(signerNames);

const keyring = (revoked: string[] = []): GovernanceKeyring => {
    const ring: GovernanceKeyring = new GovernanceKeyring();
    for (const signer of signers) {
        ring.add(signer.signer, signer.key.publicKey);
    }
    for (const signer of revoked) {
        ring.revoke(signer);
    }
    return ring;
};

const draft: AttentionManifestDraft = {
    id: "mft.sign.1",
    perspective: "technology",
    scenario: "engineering",
    focus: [{ target: { kind: "goal", id: "goal.sign" }, category: "goal", priority: 0.9, depth: 2 }],
    budget: { scope: "perspective", perspective: "technology", cap: { tokens: 1000 }, elasticity: "high" },
    constraints: constraintsFor("engineering"),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
};

const governanceSigners = [
    { role: "issuer" as const, by: "general-manager" as const, at: At },
    { role: "legal" as const, by: "legal" as const, at: At },
    { role: "finance" as const, by: "finance" as const, at: At },
];

const manifest = createAttentionManifest(draft, governanceSigners);
const credential = issueCredential(
    {
        from: "general-manager",
        to: "technology",
        reason: "signed handoff",
        visibleScope: [{ kind: "goal", id: "goal.sign" }],
        payloadRefs: [],
        budget: { quota: { tokens: 1000 }, elasticity: "high" },
        constraints: constraintsFor("engineering"),
        manifest: { id: manifest.id, version: manifest.version },
        scenario: "engineering",
        issuedAt: At,
    },
    governanceSigners,
);

await test("three signers bind a manifest digest and verify", async () => {
    const bundle = await signGovernanceObject({
        subject: "attention-manifest",
        subjectId: manifest.id,
        subjectVersion: manifest.version,
        digest: manifest.digest,
        signers,
    });
    const verdict = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
        keyring: keyring(),
        requiredSigners: signerNames,
    });
    assert.deepEqual(verdict, { ok: true, reasons: [] });
    assert.equal(bundle.signatures.length, 3);
    assert.equal(new Set(bundle.signatures.map((signature) => signature.signer)).size, 3);
});

await test("a credential signature binds to its own subject", async () => {
    const bundle = await signGovernanceObject({
        subject: "switch-credential",
        subjectId: credential.id,
        digest: credential.digest,
        signers,
    });
    const ok = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "switch-credential", subjectId: credential.id, digest: credential.digest },
        keyring: keyring(),
        requiredSigners: signerNames,
    });
    assert.equal(ok.ok, true);
    const wrongSubject = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "attention-manifest", subjectId: credential.id, digest: credential.digest },
        keyring: keyring(),
    });
    assert.equal(wrongSubject.ok, false);
    assert.equal(wrongSubject.reasons.some((reason) => reason.includes("subject mismatch")), true);
    const wrongId = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "switch-credential", subjectId: "crd.other", digest: credential.digest },
        keyring: keyring(),
    });
    assert.equal(wrongId.ok, false);
});

await test("tampering, missing signers, duplicates and revocation fail closed", async () => {
    const bundle = await signGovernanceObject({
        subject: "attention-manifest",
        subjectId: manifest.id,
        subjectVersion: manifest.version,
        digest: manifest.digest,
        signers,
    });
    const tampered = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: "sha256:deadbeef" },
        keyring: keyring(),
    });
    assert.equal(tampered.ok, false);
    const missing = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
        keyring: keyring(),
        requiredSigners: [...signerNames, "board"],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reasons.some((reason) => reason.includes("missing required signer board")), true);
    const revoked = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
        keyring: keyring(["legal"]),
        requiredSigners: signerNames,
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.reasons.some((reason) => reason.includes("unknown or revoked")), true);
    await assert.rejects(
        () =>
            signGovernanceObject({
                subject: "attention-manifest",
                subjectId: manifest.id,
                digest: manifest.digest,
                signers: [signers[0], signers[0]],
            }),
        /signed twice/,
    );
});

await test("a signature cannot be transplanted onto another manifest", async () => {
    const other = createAttentionManifest({ ...draft, id: "mft.sign.2" }, governanceSigners);
    const bundle = await signGovernanceObject({
        subject: "attention-manifest",
        subjectId: manifest.id,
        subjectVersion: manifest.version,
        digest: manifest.digest,
        signers,
    });
    const transplanted = await verifyGovernanceBundle({
        bundle,
        expected: { subject: "attention-manifest", subjectId: other.id, subjectVersion: other.version, digest: other.digest },
        keyring: keyring(),
        requiredSigners: signerNames,
    });
    assert.equal(transplanted.ok, false);
});

await test("key rotation keeps the overlap window and revokes the old kid after it", async () => {
    const oldSigner = { signer: "rotator", key: await generateSigningKey("old.rotator") };
    const newSigner = { signer: "rotator", key: await generateSigningKey("new.rotator") };
    const ring = new GovernanceKeyring();
    ring.add("rotator", oldSigner.key.publicKey, { kid: oldSigner.key.kid });
    const oldBundle = await signGovernanceObject({
        subject: "attention-manifest",
        subjectId: manifest.id,
        subjectVersion: manifest.version,
        digest: manifest.digest,
        signers: [oldSigner],
    });
    assert.equal(
        (
            await verifyGovernanceBundle({
                bundle: oldBundle,
                expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
                keyring: ring,
            })
        ).ok,
        true,
    );
    ring.rotate("rotator", newSigner.key.publicKey, { kid: newSigner.key.kid, at: Date.now(), overlapMs: 60_000 });
    assert.equal(
        (
            await verifyGovernanceBundle({
                bundle: oldBundle,
                expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
                keyring: ring,
            })
        ).ok,
        true,
    );
    const newBundle = await signGovernanceObject({
        subject: "attention-manifest",
        subjectId: manifest.id,
        subjectVersion: manifest.version,
        digest: manifest.digest,
        signers: [newSigner],
    });
    assert.equal(
        (
            await verifyGovernanceBundle({
                bundle: newBundle,
                expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
                keyring: ring,
            })
        ).ok,
        true,
    );
    ring.revokeKid("rotator", oldSigner.key.kid);
    assert.equal(
        (
            await verifyGovernanceBundle({
                bundle: oldBundle,
                expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
                keyring: ring,
            })
        ).ok,
        false,
    );
    ring.prune(Date.now() + 120_000);
    assert.equal(
        (
            await verifyGovernanceBundle({
                bundle: newBundle,
                expected: { subject: "attention-manifest", subjectId: manifest.id, subjectVersion: manifest.version, digest: manifest.digest },
                keyring: ring,
            })
        ).ok,
        true,
    );
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
