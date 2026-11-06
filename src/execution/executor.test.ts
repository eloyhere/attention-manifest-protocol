import test from "node:test";
import assert from "node:assert/strict";
import { Executor, childOperationKey } from "./executor.ts";
import type { ExecutorOptions } from "./executor.ts";
import { ManifestStore } from "../manifest/index.ts";
import { BudgetLedger } from "../budget/index.ts";
import type { ChildCall, Manifest } from "../tool/index.ts";
import type { ExecutionContext, JsonValue } from "../shared.ts";

const now = "2026-11-06T00:00:00Z";
const context: ExecutionContext = { tenantId: "t", principalId: "p", agentId: "a", sessionId: "s", operationId: "business-op",
    attemptId: "attempt", executionId: "execution", policyVersion: "1", cancellationEpoch: 0 };
const fixture = (binding: () => Promise<JsonValue>, overrides: Partial<ExecutorOptions> = {}) => {
    const manifests = new ManifestStore<JsonValue>(() => now);
    const manifest: Manifest = { manifestId: "m", tenantId: "t", endpointId: "e", endpointIdentity: "host:test", serverVersion: "1", digest: "m-digest",
        issuedAt: now, expiresAt: "2027-01-01T00:00:00Z", policyScope: "write", tools: [{ toolId: "write", version: "1", digest: "tool-digest", summary: "write",
            inputSchema: {}, risk: "write", effect: "side_effect", policyScope: "write" }] };
    manifests.put(manifest);
    const tool = manifests.createHandle(manifest, "write");
    assert.ok(tool);
    const ledger = new BudgetLedger();
    ledger.configure("s", { calls: 10, tokens: 100, bytes: 1000, milliseconds: 10000 });
    let sequence = 0;
    let allowed = true;
    let invoked = 0;
    const executor = new Executor<JsonValue, JsonValue>(manifests, { authorize: async request => {
        assert.equal(request.object.endpointId, "e");
        assert.equal(request.object.risk, "write");
        return { allowed, policyVersion: "1", reason: "host policy" };
    } }, ledger, async () => { invoked++; return binding(); }, {
        id: () => `r-${++sequence}`, now: () => now, measure: () => ({ tokens: 1, bytes: 1 }), ...overrides,
    });
    const call: ChildCall = { id: "write-once", tool, arguments: { value: 1 }, budget: { calls: 1, tokens: 10, bytes: 100, milliseconds: 1000 } };
    return { executor, manifests, manifest, ledger, call, invoked: () => invoked, deny: () => { allowed = false; } };
};

test("concurrent attempts and a changed execution ID produce one external write", async () => {
    let finish!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>(resolve => { finish = resolve; });
    const state = fixture(() => pending);
    const first = state.executor.run([state.call], context, "s");
    const second = state.executor.run([state.call], { ...context, executionId: "new-attempt" }, "s");
    finish({ written: true });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(state.invoked(), 1);
    assert.equal(a.completed && b.completed, true);
    assert.equal(a.children[0].invocation.id, b.children[0].invocation.id);
    const collision = await state.executor.run([{ ...state.call, arguments: { value: 2 } }], context, "s");
    assert.equal(collision.children[0].observation.status, "failure");
    state.deny();
    const revoked = await state.executor.run([state.call], context, "s");
    assert.equal(revoked.completed, false);
    assert.equal(state.invoked(), 1);
});

test("an external timeout retains budget and cannot repeat the business effect", async () => {
    const state = fixture(async () => { throw new Error("remote connection lost after write"); });
    const result = await state.executor.run([state.call], context, "s");
    assert.equal(result.children[0].observation.status, "unknown");
    assert.equal(state.ledger.snapshot("s").reserved.calls, 1);
    const again = await state.executor.run([state.call], { ...context, executionId: "retry" }, "s");
    assert.equal(again.children[0].observation.status, "unknown");
    assert.equal(state.invoked(), 1);
    assert.equal(state.executor.canRetry(childOperationKey(context, state.call.id)), false);
});

test("journal failure and manifest revocation during the journal prevent invocation", async () => {
    const journalFailure = fixture(async () => ({ written: true }), { beforeInvoke: () => { throw new Error("journal unavailable"); } });
    const result = await journalFailure.executor.run([journalFailure.call], context, "s");
    assert.equal(result.children[0].observation.status, "failure");
    assert.equal(journalFailure.invoked(), 0);
    assert.equal(journalFailure.ledger.snapshot("s").reserved.calls, 0);
    let revoke = (): void => {};
    const revoked = fixture(async () => ({ written: true }), { beforeInvoke: () => revoke() });
    revoke = () => revoked.manifests.revoke({ tenantId: "t", endpointId: "e", version: "1", digest: "m-digest", policyScope: "write" });
    const blocked = await revoked.executor.run([revoked.call], context, "s");
    assert.equal(blocked.completed, false);
    assert.equal(revoked.invoked(), 0);
});

test("manifest rejects malformed expiry and immutable key replacement", () => {
    const state = fixture(async () => null);
    assert.throws(() => state.manifests.put({ ...state.manifest, expiresAt: "invalid" }), /Invalid/);
    assert.throws(() => state.manifests.put({ ...state.manifest, endpointIdentity: "changed" }), /immutable/);
    const invalidClock = new ManifestStore<JsonValue>(() => "invalid");
    invalidClock.put(state.manifest);
    assert.throws(() => invalidClock.findTool(state.call.tool), /Invalid/);
});
