import test from "node:test";
import assert from "node:assert/strict";
import { proposeNextStep } from "./index.ts";
import type { ModelRequest } from "./index.ts";
import { compileContext } from "../attention.ts";

const request = (): ModelRequest => ({
    context: { tenantId: "tenant", principalId: "user", agentId: "agent", sessionId: "session", operationId: "op",
        attemptId: "attempt", executionId: "execution", policyVersion: "p1", cancellationEpoch: 0 },
    compiled: compileContext([], { now: "2026-11-06T00:00:00Z", scope: {
        tenantId: "tenant", principalId: "user", sessionId: "session", turnId: "turn",
    }, budget: { tokens: 1000 }, currentVersion: () => undefined }),
    allowedToolIds: ["read"],
});

test("model port proposes actions without modifying workflow or granting new tools", async () => {
    const input = request();
    const result = await proposeNextStep({ propose: async value => {
        value.compiled.scope.tenantId = "mutated";
        return { kind: "action", toolId: "read", arguments: {}, reason: "Read current version" };
    } }, input);
    assert.equal(result.kind, "action");
    assert.deepEqual(input.allowedToolIds, ["read"]);
    await assert.rejects(() => proposeNextStep({ propose: async () => ({ kind: "action", toolId: "write", arguments: {}, reason: "write" }) }, input), /unavailable/);
});

test("model port rejects scope mismatch and already aborted requests", async () => {
    let calls = 0;
    const port = { propose: async () => { calls += 1; return { kind: "response" as const, text: "done", evidenceIds: [] }; } };
    const foreign = request();
    foreign.context = { ...foreign.context, tenantId: "other" };
    await assert.rejects(() => proposeNextStep(port, foreign), /scope mismatch/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => proposeNextStep(port, request(), controller.signal));
    assert.equal(calls, 0);
});
