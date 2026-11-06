import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionCoordinator, MemoryReceiptSink } from "./runtime.ts";
import { EvidenceLedger } from "./provenance.ts";
import { BudgetLedger, DefaultPolicyEnforcementPoint, Executor, ManifestStore } from "./tooling.ts";
import type { ChildCall, Manifest } from "./tooling.ts";
import type { ExecutionContext, JsonValue } from "./shared.ts";

const now = "2026-11-06T12:00:00Z";
const context: ExecutionContext = {
    tenantId: "tenant", principalId: "user", agentId: "agent", sessionId: "session",
    originTurnId: "turn", operationId: "operation", attemptId: "attempt", executionId: "execution",
    policyVersion: "policy/1", cancellationEpoch: 0,
};

const fixture = (valid: boolean) => {
    const manifests = new ManifestStore<JsonValue>();
    const manifest: Manifest = {
        manifestId: "manifest", tenantId: "tenant", endpointId: "local", endpointIdentity: "host:test",
        serverVersion: "server/1", digest: "manifest-digest", policyScope: "read:test", issuedAt: now,
        tools: [{ toolId: "answer", version: "tool/1", digest: "tool-digest", summary: "read test value",
            inputSchema: {}, risk: "read", effect: "read_only", policyScope: "read:test" }],
    };
    manifests.put(manifest);
    const handle = manifests.createHandle(manifest, "answer");
    assert.ok(handle);
    const ledger = new BudgetLedger();
    ledger.configure("session", { tokens: 100, bytes: 1000, milliseconds: 10000, calls: 10 });
    let sequence = 0;
    const executor = new Executor<JsonValue, JsonValue>(manifests,
        new DefaultPolicyEnforcementPoint(request => ({ allowed: request.context.tenantId === request.object.tenantId,
            policyVersion: "policy/1", reason: "test read policy" })), ledger,
        async () => ({ answer: valid ? 42 : 0 }),
        { id: () => `record-${++sequence}`, now: () => now, measure: () => ({ tokens: 5, bytes: 20 }) });
    const evidence = new EvidenceLedger();
    const receipts = new MemoryReceiptSink();
    const coordinator = new ExecutionCoordinator({ executor, evidence, receipts, clock: () => now });
    const calls: ChildCall[] = [{ id: "child", tool: handle, arguments: {}, budget: { tokens: 10, bytes: 100, milliseconds: 1000, calls: 1 } }];
    return { coordinator, evidence, receipts, ledger, calls };
};

test("tool execution produces immutable facts before business acceptance and revocable evidence", async () => {
    const state = fixture(true);
    const result = await state.coordinator.execute(state.calls, context, "session", {
        version: "criteria/1", environmentVersion: "environment/1", claims: ["answer is 42"],
        evaluate: observation => JSON.stringify(observation.value) === JSON.stringify({ answer: 42 }),
    });
    assert.equal(result.execution.completed, true);
    assert.equal(result.acceptance?.valid, true);
    assert.equal(result.evidenceIds.length, 1);
    assert.equal(state.receipts.list().length, 1);
    assert.ok(Object.isFrozen(result.receipts[0]));
    assert.equal(state.ledger.snapshot("session").settled.calls, 1);
    const evidenceId = result.evidenceIds[0];
    assert.ok(state.evidence.getConsumable(evidenceId, "tenant", now));
    assert.equal(state.evidence.getConsumable(evidenceId, "other", now), undefined);
    state.evidence.revoke(evidenceId, "tenant", "environment changed", now);
    assert.equal(state.evidence.getConsumable(evidenceId, "tenant", now), undefined);
    assert.equal(state.receipts.list().length, 1);
});

test("successful tool status does not bypass an independent false business assertion", async () => {
    const state = fixture(false);
    const result = await state.coordinator.execute(state.calls, context, "session", {
        version: "criteria/1", environmentVersion: "environment/1", claims: ["answer is 42"],
        evaluate: () => false,
    });
    assert.equal(result.execution.completed, true);
    assert.equal(result.verification[0].status, "semantic_rejected");
    assert.equal(result.acceptance, undefined);
    assert.equal(result.evidenceIds.length, 0);
});
