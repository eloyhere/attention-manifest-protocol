import assert from "node:assert/strict";
import test from "node:test";
import {
    advanceReceipt,
    createInvocation,
    createObservation,
    createReceiptCore,
    receiptLifecycle,
    RECEIPT_TRANSITIONS,
} from "./index.ts";
import type {
    ReceiptCore,
    ReceiptKind,
    ReceiptLifecycle,
    WorkspaceAnchor,
} from "./index.ts";
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

function makeReceipt(overrides: Partial<ReceiptCore> = {}): ReceiptCore {
    const invocation = createInvocation({ id: "invocation", context, toolId: "tool", arguments: { query: "read" }, createdAt: now });
    const observation = createObservation({ id: "observation", invocationId: invocation.id, status: "success", value: { result: "ok" }, observedAt: now });
    return createReceiptCore({
        id: "receipt",
        invocation,
        observation,
        issuedAt: now,
        payloadDigest: "digest",
        hashAlgorithm: "sha256-test",
        ...overrides,
    });
}

test("receipt extensions carry kind and identity and default to issued", () => {
    const receipt = makeReceipt({
        kind: "action_receipt",
        parentId: "parent-receipt",
        agentId: "agent",
        sessionId: "session",
        turnId: "turn",
        evidenceIds: ["evidence-1", "evidence-2"],
    });
    assert.equal(receipt.kind, "action_receipt");
    assert.equal(receipt.parentId, "parent-receipt");
    assert.equal(receipt.agentId, "agent");
    assert.equal(receipt.sessionId, "session");
    assert.equal(receipt.turnId, "turn");
    assert.deepEqual(receipt.evidenceIds, ["evidence-1", "evidence-2"]);
    assert.equal(receipt.lifecycle, "issued");
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.evidenceIds), true);
});

test("workspace anchor and executor versions are deeply frozen", () => {
    const anchor: WorkspaceAnchor = {
        workspaceId: "workspace",
        snapshotId: "snapshot-1",
        changeHash: "hash-1",
        affectedFiles: ["src/a.ts", "src/b.ts"],
        affectedSymbols: ["A", "B"],
    };
    const receipt = makeReceipt({
        kind: "file_flush_receipt",
        workspaceAnchor: anchor,
        executor: {
            professionId: "developer",
            skill: { id: "skill", version: "1.0.0" },
            tool: { id: "tool", version: "2.0.0" },
            cognition: { id: "cognition", version: "1.2.0" },
            protocol: { id: "protocol", version: "3.0.0" },
            behavior: [{ id: "behavior", version: "4.0.0" }],
        },
    });
    assert.equal(Object.isFrozen(receipt.workspaceAnchor), true);
    assert.equal(Object.isFrozen(receipt.workspaceAnchor?.affectedFiles), true);
    assert.equal(Object.isFrozen(receipt.workspaceAnchor?.affectedSymbols), true);
    assert.equal(Object.isFrozen(receipt.executor), true);
    assert.equal(Object.isFrozen(receipt.executor?.skill), true);
    assert.equal(Object.isFrozen(receipt.executor?.behavior), true);
    assert.equal(Object.isFrozen(receipt.executor?.behavior?.[0]), true);
    assert.throws(() => {
        (receipt.workspaceAnchor as unknown as { workspaceId: string }).workspaceId = "other";
    }, TypeError);
    assert.throws(() => {
        (receipt.workspaceAnchor as unknown as { affectedFiles: string[] }).affectedFiles.push("src/c.ts");
    }, TypeError);
});

test("receipt lifecycle advances immutably from issued to archived", () => {
    const issued = makeReceipt();
    const signed = advanceReceipt(issued, "signed");
    const anchored = advanceReceipt(signed, "anchored");
    const verified = advanceReceipt(anchored, "verified");
    const archived = advanceReceipt(verified, "archived");
    assert.equal(issued.lifecycle, "issued");
    assert.equal(signed.lifecycle, "signed");
    assert.equal(anchored.lifecycle, "anchored");
    assert.equal(verified.lifecycle, "verified");
    assert.equal(archived.lifecycle, "archived");
    assert.notEqual(signed, issued);
    assert.equal(Object.isFrozen(archived), true);
    assert.equal(archived.kind, undefined);
});

test("receipt dispute, rollback and purge paths are explicit", () => {
    const disputed = advanceReceipt(makeReceipt(), "disputed");
    assert.equal(disputed.lifecycle, "disputed");
    assert.equal(advanceReceipt(disputed, "verified").lifecycle, "verified");
    const revoked = advanceReceipt(disputed, "revoked");
    assert.equal(revoked.lifecycle, "revoked");
    assert.equal(advanceReceipt(revoked, "purged").lifecycle, "purged");
    assert.equal(advanceReceipt("issued", "signed"), "signed");
    assert.throws(() => advanceReceipt("issued", "verified"), /invalid receipt transition/);
    assert.throws(() => advanceReceipt("purged", "issued"), /invalid receipt transition/);
    assert.throws(() => advanceReceipt("bogus" as ReceiptLifecycle, "signed"), /invalid receipt lifecycle/);
    assert.throws(() => advanceReceipt("issued", "bogus" as ReceiptLifecycle), /invalid receipt lifecycle/);
    assert.equal(Object.isFrozen(receiptLifecycle), true);
    assert.equal(Object.isFrozen(receiptLifecycle.issued), true);
    assert.throws(() => {
        (receiptLifecycle.issued as unknown as ReceiptLifecycle[]).push("archived");
    }, TypeError);
    assert.equal(RECEIPT_TRANSITIONS, receiptLifecycle);
});

test("receipt extension validation rejects unknown kinds, lifecycle and malformed anchors", () => {
    assert.throws(() => makeReceipt({ kind: "bogus" as ReceiptKind }), /invalid receipt kind/);
    assert.throws(() => makeReceipt({ lifecycle: "bogus" as ReceiptLifecycle }), /invalid receipt lifecycle/);
    assert.throws(() => makeReceipt({ parentId: "" }), /parentId/);
    assert.throws(() => makeReceipt({ workspaceAnchor: { workspaceId: "" } }), /workspaceId/);
    assert.throws(() => makeReceipt({ workspaceAnchor: {} as WorkspaceAnchor }), /workspaceId/);
    assert.throws(() => makeReceipt({ workspaceAnchor: { workspaceId: "workspace", affectedFiles: ["a", "a"] } }), /duplicate/);
    assert.throws(() => makeReceipt({ evidenceIds: ["evidence", "evidence"] }), /duplicate/);
    assert.throws(() => makeReceipt({ executor: { skill: { id: "skill", version: "" } } }), /executor.skill/);
    assert.throws(() => makeReceipt({ executor: { behavior: [{ id: "", version: "1" }] } }), /executor.behavior/);
});

test("every receipt kind is accepted while preserving legacy construction", () => {
    const legacy = makeReceipt();
    assert.equal(legacy.lifecycle, "issued");
    assert.equal(legacy.kind, undefined);
    const kinds: readonly ReceiptKind[] = ["task_receipt", "plan_receipt", "mission_receipt", "capability_receipt", "profession_switch_receipt", "delegation_receipt", "merge_receipt", "cooperation_receipt", "arbitration_receipt", "session_receipt", "turn_receipt", "session_resume_receipt", "turn_resume_receipt", "file_mount_receipt", "file_unmount_receipt"];
    for (const [index, kind] of kinds.entries()) {
        const receipt = makeReceipt({ id: `receipt-${index}`, kind });
        assert.equal(receipt.kind, kind);
    }
});
