import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionContext, JsonValue } from "../shared.ts";
import { BudgetError, BudgetLedger } from "../budget/ledger.ts";
import { Executor, UnknownOutcomeRetryError, assertRetrySafe } from "../execution/executor.ts";
import { ManifestStore } from "../manifest/store.ts";
import type { ChildCall, Manifest, ToolDefinition } from "../tool/types.ts";

const context: ExecutionContext = {
    tenantId: "tenant", principalId: "principal", agentId: "agent", sessionId: "session",
    operationId: "operation", attemptId: "attempt", executionId: "execution", policyVersion: "p1", cancellationEpoch: 0,
};
const tool: ToolDefinition = {
    toolId: "lookup", version: "1", digest: "tool-digest", summary: "lookup", inputSchema: {},
    risk: "read", effect: "read_only", policyScope: "scope-a",
};
const manifest: Manifest = {
    manifestId: "manifest", tenantId: "tenant", endpointId: "endpoint", endpointIdentity: "local:test",
    serverVersion: "1", digest: "manifest-digest", policyScope: "scope-a", issuedAt: "2026-01-01T00:00:00Z", tools: [tool],
};

function setup(allowed = true, failUnknown = false) {
    let id = 0;
    const store = new ManifestStore<JsonValue>();
    store.put(manifest);
    const ledger = new BudgetLedger();
    ledger.configure("run", { calls: 4, tokens: 100, milliseconds: 1000, bytes: 1000 });
    let policyChecks = 0;
    let bindingOperationIds: string[] = [];
    const executor = new Executor(
        store,
        { authorize: async (request) => {
            policyChecks += 1;
            assert.equal(request.action, "execute");
            assert.equal(request.object.id, "lookup");
            if (!allowed) throw new Error("denied");
            return { allowed: true, policyVersion: "p1", reason: "test" };
        } },
        ledger,
        async (_input, _definition, bindingContext) => {
            bindingOperationIds.push(bindingContext.operationId);
            if (failUnknown) throw new UnknownOutcomeRetryError("remote-effect");
            return { ok: true };
        },
        { id: () => `id-${++id}`, now: () => "2026-01-01T00:00:00Z", measure: () => ({ tokens: 1, bytes: 1 }) },
    );
    return { executor, ledger, policyChecks: () => policyChecks, bindingOperationIds: () => bindingOperationIds };
}

function call(id: string): ChildCall {
    return { id, tool: { kind: "tool", tenantId: "tenant", endpointId: "endpoint", toolId: "lookup", version: "1", digest: "manifest-digest", toolVersion: "1", toolDigest: "tool-digest", policyScope: "scope-a" }, arguments: {}, budget: { calls: 1, tokens: 10, milliseconds: 100, bytes: 10 } };
}

test("manifest handles pin manifest and tool digests and reject expired manifests", () => {
    const store = new ManifestStore<JsonValue>(() => "2026-01-02T00:00:00Z");
    const expiring = { ...manifest, expiresAt: "2026-01-01T00:00:00Z" };
    store.put(expiring);
    const handle = store.createHandle(expiring, "lookup");
    assert.ok(handle);
    assert.equal(handle.version, manifest.serverVersion);
    assert.equal(handle.digest, manifest.digest);
    assert.equal(handle.toolDigest, tool.digest);
    assert.equal(store.resolveTool(handle), undefined);
});

test("budget rejects negative and non-finite amounts", () => {
    const ledger = new BudgetLedger();
    ledger.configure("k", { calls: 2 });
    assert.throws(() => ledger.reserve("negative", "k", { calls: -1 }), (error: unknown) => error instanceof BudgetError && error.code === "invalid_amount");
    assert.throws(() => ledger.reserve("nan", "k", { tokens: Number.NaN }), (error: unknown) => error instanceof BudgetError && error.code === "invalid_amount");
});

test("budget snapshots and reservations are deeply frozen and unknown budgets reject reservations", () => {
    const ledger = new BudgetLedger();
    assert.throws(() => ledger.reserve("unknown", "missing", { calls: 1 }), (error: unknown) => error instanceof BudgetError && error.code === "budget_not_configured");
    ledger.configure("k", { calls: 2 });
    const reservation = ledger.reserve("a", "k", { calls: 1 });
    assert.throws(() => { reservation.amount.calls = 999; }, TypeError);
    const snapshot = ledger.snapshot("k");
    assert.throws(() => { snapshot.reserved.calls = 999; }, TypeError);
    const stored = ledger.getReservation("a");
    assert.equal(stored?.amount.calls, 1);
    assert.equal(ledger.snapshot("k").reserved.calls, 1);
});

test("budget reservations account concurrently against the same last quota", () => {
    const ledger = new BudgetLedger();
    ledger.configure("k", { calls: 2 });
    ledger.reserve("a", "k", { calls: 1 });
    ledger.reserve("b", "k", { calls: 1 });
    assert.throws(() => ledger.reserve("c", "k", { calls: 1 }), (error: unknown) => error instanceof BudgetError && error.code === "limit_exceeded");
    ledger.settle("a", { calls: 1 });
    assert.throws(() => ledger.settle("a", { calls: 1 }), (error: unknown) => error instanceof BudgetError && error.code === "reservation_not_open");
});

test("executor invokes PEP for every child call", async () => {
    const state = setup();
    const result = await state.executor.run([call("a"), call("b")], context, "run");
    assert.equal(state.policyChecks(), 4);
    assert.equal(result.children.length, 2);
    assert.equal(state.bindingOperationIds().length, 2);
    assert.notEqual(state.bindingOperationIds()[0], state.bindingOperationIds()[1]);
    assert.equal(result.completed, true, result.children.map((child) => child.failure).join("; "));
});

test("executor rejects duplicate ChildCall IDs before execution", async () => {
    const state = setup();
    await assert.rejects(state.executor.run([call("duplicate"), call("duplicate")], context, "run"), /Duplicate ChildCall id/);
    assert.equal(state.policyChecks(), 0);
});

test("unknown effect is recorded and blocked from retry", async () => {
    const state = setup(true, true);
    const result = await state.executor.run([call("a")], context, "run");
    assert.equal(result.children[0]?.observation.status, "unknown");
    const childOperationId = JSON.stringify([context.tenantId, context.principalId, context.sessionId, context.operationId, "a"]);
    assert.throws(() => assertRetrySafe(childOperationId, (id) => state.executor.canRetry(id)), UnknownOutcomeRetryError);
    state.executor.markReconciled(childOperationId);
    assert.doesNotThrow(() => assertRetrySafe(childOperationId, (id) => state.executor.canRetry(id)));
});
