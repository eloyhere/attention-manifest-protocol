import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ExecutionCoordinator, MemoryReceiptSink, executionFactDigest } from "./index.ts";
import { EvidenceLedger } from "../provenance.ts";
import { BudgetLedger, DefaultPolicyEnforcementPoint, Executor, ManifestStore } from "../tooling.ts";
import { safeStringify } from "../serialization/index.ts";
import type { ChildCall, Manifest } from "../tooling.ts";
import type { ExecutionContext, JsonValue } from "../shared.ts";

const now = "2026-11-07T00:00:00Z";
const context: ExecutionContext = {
    tenantId: "tenant", principalId: "user", agentId: "agent", sessionId: "session",
    originTurnId: "turn", operationId: "operation", attemptId: "attempt", executionId: "execution",
    policyVersion: "policy/1", cancellationEpoch: 0,
};

function fixture() {
    const manifests = new ManifestStore<JsonValue>();
    const manifest: Manifest = {
        manifestId: "manifest", tenantId: "tenant", endpointId: "local", endpointIdentity: "host:test",
        serverVersion: "server/1", digest: "manifest-digest", policyScope: "read:test", issuedAt: now,
        tools: [{
            toolId: "answer", version: "tool/1", digest: "tool-digest", summary: "read test value",
            inputSchema: {}, risk: "read", effect: "read_only", policyScope: "read:test",
        }],
    };
    manifests.put(manifest);
    const handle = manifests.createHandle(manifest, "answer");
    assert.ok(handle);
    const ledger = new BudgetLedger();
    ledger.configure("session", { tokens: 100, bytes: 1000, milliseconds: 10000, calls: 10 });
    let sequence = 0;
    const executor = new Executor<JsonValue, JsonValue>(manifests,
        new DefaultPolicyEnforcementPoint(request => ({
            allowed: request.context.tenantId === request.object.tenantId,
            policyVersion: "policy/1", reason: "test read policy",
        })), ledger, async () => ({ answer: 42 }),
        { id: () => `record-${++sequence}`, now: () => now, measure: () => ({ tokens: 5, bytes: 20 }) });
    const receipts = new MemoryReceiptSink();
    const coordinator = new ExecutionCoordinator({ executor, evidence: new EvidenceLedger(), receipts, clock: () => now });
    const calls: ChildCall[] = [{
        id: "child", tool: handle, arguments: {},
        budget: { tokens: 10, bytes: 100, milliseconds: 1000, calls: 1 },
    }];
    return { coordinator, receipts, calls };
}

test("execution receipts use the sha256-json-execution-facts/2 algorithm", async () => {
    const state = fixture();
    const result = await state.coordinator.execute(state.calls, context, "session", {
        version: "criteria/1", environmentVersion: "environment/1", claims: ["answer is 42"],
        evaluate: observation => JSON.stringify(observation.value) === JSON.stringify({ answer: 42 }),
    });
    const receipt = result.receipts[0];
    assert.ok(receipt);
    assert.equal(receipt.hashAlgorithm, "sha256-json-execution-facts/2");
    assert.equal(state.receipts.list()[0]?.hashAlgorithm, "sha256-json-execution-facts/2");
    assert.equal(receipt.payloadDigest, executionFactDigest(receipt.invocation, receipt.observation));
    const expected = `sha256:${createHash("sha256")
        .update(safeStringify({ invocation: receipt.invocation, observation: receipt.observation }, { stableKeys: true }), "utf8")
        .digest("hex")}`;
    assert.equal(receipt.payloadDigest, expected);
    assert.equal(result.integrity[0]?.status, "integrity_verified");
});

test("executionFactDigest ignores property insertion order", () => {
    const invocation = {
        id: "invocation", context: { ...context }, toolId: "answer", arguments: { a: 1, b: 2 }, createdAt: now,
    };
    const observation = { id: "observation", invocationId: "invocation", status: "success" as const, observedAt: now };
    const reordered = {
        invocation: {
            createdAt: now, arguments: { b: 2, a: 1 }, toolId: "answer",
            context: { ...context }, id: "invocation",
        },
        observation: { observedAt: now, status: "success" as const, invocationId: "invocation", id: "observation" },
    };
    assert.equal(
        executionFactDigest(invocation, observation),
        executionFactDigest(reordered.invocation, reordered.observation),
    );
});
