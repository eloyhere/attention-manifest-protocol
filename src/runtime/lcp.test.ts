import test from "node:test";
import assert from "node:assert/strict";
import { LcpService } from "./lcp.ts";
import { ManifestStore } from "../manifest/index.ts";
import { Executor } from "../execution/index.ts";
import { BudgetLedger } from "../budget/index.ts";
import { DefaultPolicyEnforcementPoint } from "../policy/index.ts";
import { RetrievalHandleStore } from "../retrieval/index.ts";
import type { Manifest } from "../tool/index.ts";
import type { ExecutionContext, JsonValue } from "../shared.ts";

const now = "2026-11-06T00:00:00Z";
const context: ExecutionContext = { tenantId: "t", principalId: "p", agentId: "a", sessionId: "s", operationId: "op",
    attemptId: "attempt", executionId: "exec", policyVersion: "v1", cancellationEpoch: 0 };

test("LCP discovers permitted tools, expands pinned schema and gates every handle read", async () => {
    const catalog: Manifest[] = [{ manifestId: "m", tenantId: "t", endpointId: "e", endpointIdentity: "host:test", serverVersion: "1",
        digest: "manifest-digest", issuedAt: now, policyScope: "test", tools: ["read", "secret"].map(toolId => ({
            toolId, version: "1", digest: `${toolId}-digest`, summary: `${toolId} document`, inputSchema: {}, risk: "read", effect: "read_only", policyScope: "test",
        })) }];
    const manifests = new ManifestStore<JsonValue>(() => now);
    manifests.put(catalog[0]);
    let readAllowed = true;
    const policy = new DefaultPolicyEnforcementPoint(request => ({ allowed: request.object.id !== "secret" && (request.action !== "read_handle" || readAllowed), policyVersion: "v1", reason: "scope" }));
    const ledger = new BudgetLedger();
    ledger.configure("s", { calls: 3, tokens: 100, bytes: 1000, milliseconds: 10000 });
    let sequence = 0;
    const executor = new Executor<JsonValue, JsonValue>(manifests, policy, ledger, async () => ({ ok: true }), {
        id: () => `i-${++sequence}`, now: () => now, measure: () => ({ tokens: 1, bytes: 1 }),
    });
    const handles = new RetrievalHandleStore<JsonValue>(() => now);
    handles.create({ id: "h", tenantId: "t", ownerId: "p", sessionId: "s", sourceDigest: "digest", ttlMilliseconds: 10000, revocationEpoch: 0, records: [{ item: 1 }] });
    const service = new LcpService({ manifests, executor, policy, handles, catalog: () => catalog });
    const candidates = await service.findTools(context, { query: "document", minimumScore: 0.1 });
    assert.deepEqual(candidates.tools.map(item => item.tool.toolId), ["read"]);
    assert.equal(candidates.tools[0].tool.inputSchema, null);
    const handle = manifests.createHandle(catalog[0], "read");
    assert.ok(handle);
    assert.equal((await service.inspectTool(context, handle)).toolId, "read");
    const request = { tenantId: "t", ownerId: "p", sessionId: "s", limit: 10, now, expectedRevocationEpoch: 0 };
    assert.equal((await service.readHandle(context, "h", request)).items.length, 1);
    readAllowed = false;
    await assert.rejects(() => service.readHandle(context, "h", request));
    await assert.rejects(() => service.inspectTool({ ...context, tenantId: "other" }, handle));
});
