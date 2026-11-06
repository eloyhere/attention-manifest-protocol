import { BudgetLedger, DefaultPolicyEnforcementPoint, Executor, ManifestStore } from "../src/tooling.ts";
import { EvidenceLedger } from "../src/provenance.ts";
import { ExecutionCoordinator, MemoryReceiptSink } from "../src/runtime.ts";
import type { ExecutionContext, JsonValue } from "../src/shared.ts";
import type { Manifest } from "../src/tooling.ts";

const now = (): string => new Date().toISOString();
const manifests = new ManifestStore<JsonValue>(now);
const manifest: Manifest = {
    manifestId: "demo", tenantId: "local", endpointId: "memory", endpointIdentity: "host:demo",
    serverVersion: "1", digest: "demo-manifest", policyScope: "read:demo", issuedAt: now(),
    tools: [{ toolId: "sum", version: "1", digest: "demo-sum", summary: "Add two local numbers",
        inputSchema: {}, risk: "read", effect: "read_only", policyScope: "read:demo" }],
};
manifests.put(manifest);
const handle = manifests.createHandle(manifest, "sum");
if (!handle) { throw new Error("Demo tool missing"); }
const budget = new BudgetLedger();
budget.configure("session", { tokens: 100, bytes: 1000, calls: 2, milliseconds: 10000 });
let sequence = 0;
const executor = new Executor<JsonValue, JsonValue>(manifests,
    new DefaultPolicyEnforcementPoint(request => ({
        allowed: request.context.tenantId === request.object.tenantId && request.object.policyScope === "read:demo",
        policyVersion: "demo-policy/1", reason: "Local read-only demonstration",
    })), budget, async () => ({ result: 42 }),
    { id: () => `demo-${++sequence}`, now, measure: () => ({ tokens: 5, bytes: 20 }) });
const context: ExecutionContext = {
    tenantId: "local", principalId: "user", agentId: "demo", sessionId: "session", originTurnId: "turn",
    operationId: "op", attemptId: "attempt", executionId: "execution", policyVersion: "demo-policy/1", cancellationEpoch: 0,
};
const evidence = new EvidenceLedger();
const receipts = new MemoryReceiptSink();
const runtime = new ExecutionCoordinator({ executor, evidence, receipts, clock: now });
const result = await runtime.execute([{ id: "sum-call", tool: handle, arguments: { a: 20, b: 22 },
    budget: { tokens: 10, bytes: 100, calls: 1, milliseconds: 1000 } }], context, "session", {
    version: "sum-criteria/1", environmentVersion: "memory/1", claims: ["sum result is 42"],
    evaluate: observation => JSON.stringify(observation.value) === JSON.stringify({ result: 42 }),
});
console.log(JSON.stringify({ completed: result.execution.completed, acceptance: result.acceptance,
    receiptCount: receipts.list().length, budget: budget.snapshot("session") }, null, 2));
if (!result.acceptance?.valid) { process.exitCode = 1; }
