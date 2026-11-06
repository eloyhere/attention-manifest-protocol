import assert from "node:assert/strict";
import test from "node:test";
import { createInvocation, createObservation, createReceiptCore, verifyBusinessSemantics, verifyReceiptIntegrity } from "./core.ts";
import { EvidenceLedger } from "./evidence.ts";
import type { ExecutionContext } from "../shared.ts";

const context = (tenantId: string): ExecutionContext => ({ tenantId, principalId: "p", agentId: "a", sessionId: "s", operationId: "op", attemptId: "attempt", executionId: "exec", policyVersion: "1", cancellationEpoch: 0 });
const now = "2026-01-01T00:00:00.000Z";

async function fixture(tenantId = "tenant-a") {
    const invocation = createInvocation({ id: "inv-1", context: context(tenantId), toolId: "tool", arguments: { query: "read" }, createdAt: now });
    const observation = createObservation({ id: "obs-1", invocationId: invocation.id, status: "success", value: { result: "ok" }, observedAt: now });
    const receipt = createReceiptCore({ id: "receipt-1", invocation, observation, issuedAt: now, payloadDigest: "digest", hashAlgorithm: "test" });
    const integrity = await verifyReceiptIntegrity(receipt, { digest: () => "digest", verifier: "integrity-checker", verifiedAt: now });
    const verification = await verifyBusinessSemantics(receipt, integrity, { id: "verification-1", verifier: "business-checker", verifiedAt: now, criteriaVersion: "criteria-v1" }, () => true, ["claim"]);
    return { invocation, observation, receipt, integrity, verification };
}

const add = (ledger: EvidenceLedger, tenantId: string, evidenceId: string, facts: Awaited<ReturnType<typeof fixture>>, dependsOn?: readonly string[]) => ledger.add({ id: evidenceId, tenantId, claim: "claim", polarity: "supports", receipt: facts.receipt, integrity: facts.integrity, verification: facts.verification, criteriaVersion: "criteria-v1", environmentVersion: "env-v1", createdAt: now, dependsOn });

test("receipt facts are created before independent integrity and semantic verification", async () => {
    const invocation = createInvocation({ id: "inv", context: context("tenant-a"), toolId: "tool", arguments: null, createdAt: now });
    const observation = createObservation({ id: "obs", invocationId: "inv", status: "unknown", observedAt: now });
    const receipt = createReceiptCore({ id: "receipt", invocation, observation, issuedAt: now, payloadDigest: "hash", hashAlgorithm: "sha256" });
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.invocation.context), true);
    const integrity = await verifyReceiptIntegrity(receipt, { digest: () => "hash", verifier: "integrity", verifiedAt: now });
    assert.equal(integrity.status, "integrity_verified");
    const semantic = await verifyBusinessSemantics(receipt, integrity, { id: "v", verifier: "business", verifiedAt: now, criteriaVersion: "v1" }, () => false, ["claim"]);
    assert.equal(semantic.status, "semantic_rejected");
});

test("digest or signature failures cannot become integrity verified", async () => {
    const { receipt } = await fixture();
    const digestFailure = await verifyReceiptIntegrity(receipt, { digest: () => "wrong", verifier: "v", verifiedAt: now });
    assert.equal(digestFailure.status, "integrity_rejected");
    const signatureFailure = await verifyReceiptIntegrity(receipt, { digest: () => "digest", verifySignature: () => false, verifier: "v", verifiedAt: now });
    assert.equal(signatureFailure.status, "integrity_rejected");
    const signedReceipt = createReceiptCore({ ...receipt, signature: "signed", signerKeyId: "key-1" });
    const uncheckedSignature = await verifyReceiptIntegrity(signedReceipt, { digest: () => "digest", verifier: "v", verifiedAt: now });
    assert.equal(uncheckedSignature.status, "integrity_rejected");
    assert.equal(uncheckedSignature.reasons.includes("signature_not_checked"), true);
});

test("receipt core rejects incomplete execution identity", async () => {
    const facts = await fixture();
    assert.throws(() => createReceiptCore({ ...facts.receipt, invocation: { ...facts.invocation, context: { ...facts.invocation.context, tenantId: "" } } }), /identity/);
});

test("revocation invalidates dependent evidence transitively", async () => {
    const facts = await fixture();
    const ledger = new EvidenceLedger();
    add(ledger, "tenant-a", "root", facts);
    add(ledger, "tenant-a", "child", facts, ["root"]);
    add(ledger, "tenant-a", "grandchild", facts, ["child"]);
    const changed = ledger.revoke("root", "tenant-a", "source withdrawn", now);
    assert.deepEqual([...changed].sort(), ["child", "grandchild", "root"]);
    assert.equal(ledger.get("root", "tenant-a")?.status, "revoked");
    assert.equal(ledger.get("child", "tenant-a")?.status, "pending_revalidation");
    assert.equal(ledger.getConsumable("grandchild", "tenant-a", now), undefined);
    assert.equal(ledger.auditEvents().length >= 5, true);
});

test("evidence reads and dependency creation are tenant scoped", async () => {
    const factsA = await fixture("tenant-a");
    const factsB = await fixture("tenant-b");
    const ledger = new EvidenceLedger();
    add(ledger, "tenant-a", "private", factsA);
    assert.equal(ledger.get("private", "tenant-b"), undefined);
    assert.throws(() => add(ledger, "tenant-b", "cross", factsB, ["private"]), /cross-tenant/);
    assert.throws(() => ledger.add({ ...factsB, id: "wrong-tenant", tenantId: "tenant-a", claim: "claim", polarity: "supports", receipt: factsB.receipt, integrity: factsB.integrity, verification: factsB.verification, criteriaVersion: "criteria-v1", environmentVersion: "env-v1", createdAt: now }), /Receipt tenant/);
});

test("expired dependencies make descendants non-consumable", async () => {
    const facts = await fixture();
    const ledger = new EvidenceLedger();
    ledger.add({ id: "expiring", tenantId: "tenant-a", claim: "claim", polarity: "supports", receipt: facts.receipt, integrity: facts.integrity, verification: facts.verification, criteriaVersion: "criteria-v1", environmentVersion: "env-v1", createdAt: now, expiresAt: "2026-01-02T00:00:00.000Z" });
    add(ledger, "tenant-a", "dependent", facts, ["expiring"]);
    assert.equal(ledger.getConsumable("dependent", "tenant-a", "2026-01-03T00:00:00.000Z"), undefined);
    assert.equal(ledger.getConsumable("dependent", "tenant-a", "not-a-date"), undefined);
    assert.equal(ledger.findConsumable("dependent", "tenant-a", "not-a-date").isPresent(), false);
    assert.throws(() => ledger.add({ id: "bad-date", tenantId: "tenant-a", claim: "claim", polarity: "supports", receipt: facts.receipt, integrity: facts.integrity, verification: facts.verification, criteriaVersion: "criteria-v1", environmentVersion: "env-v1", createdAt: "not-a-date" }), /createdAt/);
    assert.throws(() => ledger.add({ id: "bad-expiry", tenantId: "tenant-a", claim: "claim", polarity: "supports", receipt: facts.receipt, integrity: facts.integrity, verification: facts.verification, criteriaVersion: "criteria-v1", environmentVersion: "env-v1", createdAt: now, expiresAt: now }), /expiresAt/);
});
