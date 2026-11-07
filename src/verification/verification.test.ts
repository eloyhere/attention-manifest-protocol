import assert from "node:assert/strict";
import test from "node:test";
import {
    verifyBusinessSemantics,
} from "./index.ts";
import { createInvocation, createObservation, createReceiptCore, verifyReceiptIntegrity } from "../receipt/index.ts";
import type { ReceiptCore } from "./index.ts";
import type { ExecutionContext } from "../shared.ts";

const now = "2026-01-01T00:00:00.000Z";
const context: ExecutionContext = {
    tenantId: "tenant-a",
    principalId: "principal",
    agentId: "agent",
    sessionId: "session",
    operationId: "operation",
    attemptId: "attempt",
    executionId: "execution",
    policyVersion: "policy/1",
    cancellationEpoch: 0,
};

function makeReceipt(digest = "extended-digest"): ReceiptCore {
    const invocation = createInvocation({ id: "invocation", context, toolId: "tool", arguments: { query: "read" }, createdAt: now });
    const observation = createObservation({ id: "observation", invocationId: invocation.id, status: "success", value: { result: "ok" }, observedAt: now });
    return createReceiptCore({
        id: "receipt",
        invocation,
        observation,
        issuedAt: now,
        payloadDigest: digest,
        hashAlgorithm: "sha256-test",
        kind: "action_receipt",
        agentId: "agent",
        sessionId: "session",
        turnId: "turn",
        workspaceAnchor: { workspaceId: "workspace", snapshotId: "snapshot", changeHash: "hash", affectedFiles: ["src/a.ts"] },
        executor: { professionId: "developer", tool: { id: "tool", version: "1.0.0" } },
        evidenceIds: ["evidence-1"],
    });
}

test("extended receipt fields still pass independent integrity and semantic verification", async () => {
    const receipt = makeReceipt();
    const integrity = await verifyReceiptIntegrity(receipt, { digest: () => "extended-digest", verifier: "integrity", verifiedAt: now });
    assert.equal(integrity.status, "integrity_verified");
    assert.equal(integrity.digestValid, true);
    assert.equal(receipt.kind, "action_receipt");
    assert.equal(receipt.lifecycle, "issued");
    assert.equal(Object.isFrozen(receipt.workspaceAnchor), true);
    const verification = await verifyBusinessSemantics(
        receipt,
        integrity,
        { id: "verification", verifier: "business", verifiedAt: now, criteriaVersion: "criteria-v1" },
        observation => observation.status === "success" && JSON.stringify(observation.value) === JSON.stringify({ result: "ok" }),
        ["claim"],
    );
    assert.equal(verification.status, "semantic_verified");
    assert.equal(verification.receiptId, receipt.id);
    assert.equal(verification.observationId, receipt.observation.id);
});

test("extended receipt fields participate in digest detection", async () => {
    const receipt = makeReceipt();
    const includeAnchor = (value: ReceiptCore) => `sha256:${JSON.stringify({ anchor: value.workspaceAnchor, kind: value.kind })}`;
    const digest = includeAnchor(receipt);
    const valid = await verifyReceiptIntegrity({ ...receipt, payloadDigest: digest }, { digest: includeAnchor, verifier: "integrity", verifiedAt: now });
    assert.equal(valid.status, "integrity_verified");
    const tampered = { ...receipt, payloadDigest: digest, workspaceAnchor: { ...receipt.workspaceAnchor, workspaceId: "other" } };
    const rejected = await verifyReceiptIntegrity(tampered, { digest: includeAnchor, verifier: "integrity", verifiedAt: now });
    assert.equal(rejected.status, "integrity_rejected");
    assert.equal(rejected.reasons.includes("payload_digest_mismatch"), true);
});
