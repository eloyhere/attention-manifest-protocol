#!/usr/bin/env node
/**
 * Exec profile checks: stateless MCP framing, TTL caching, digest pinning,
 * approval policy, budget enforcement and handle shaping.
 */
import assert from "node:assert/strict";

import { BudgetExceeded, Dispatcher } from "../src/attention/budget.ts";
import { ApprovalRequired, DriftDetected, ExecProfile, PolicyDenied } from "../src/execution/exec.ts";
import { HandleStore } from "../src/execution/handles.ts";
import { McpClient } from "../src/module/mcp/client.ts";
import { DemoServer } from "../src/module/mcp/server.ts";
import { MemoryTransport } from "../src/module/mcp/transport.ts";
import type { Budget, Claim } from "../src/types/index.ts";

const heldClaim = (tier: Claim["tier"] = "T3"): Claim => ({
    amp: "0.1",
    kind: "claim",
    id: `cl.${tier}`,
    statement: "the deployment is the best reversible action available",
    tier,
    confidence: 0.9,
    status: "held",
    warrant: { evidence: [], inference: "deduction", strength: 0.9 },
    provenance: { source: "a.lead" },
    created: "2026-10-24T01:00:00Z",
});

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
}

function setup(options: { budget?: Budget } = {}) {
    const server = new DemoServer();
    const transport = new MemoryTransport((request) => server.handle(request));
    const client = new McpClient(transport);
    const handles = new HandleStore();
    const receipts = [];
    let tick = 0;
    const now = () => new Date(Date.parse("2026-10-24T01:00:00Z") + ++tick * 1000).toISOString();
    const exec = new ExecProfile(client, {
        budget: options.budget ?? { calls: 5, ms: 60_000 },
        handles,
        now,
        maxResultTokens: 1200,
        requireApproval: true,
        onReceipt: (receipt) => receipts.push(receipt),
    });
    return { server, transport, client, handles, receipts, exec };
}

await test("server rejects requests without _meta protocolVersion (-32602)", async () => {
    const { transport } = setup();
    const raw = await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(raw.error?.code, -32602);
});

await test("client sends version and capabilities in _meta", async () => {
    const { transport, client } = setup();
    await client.discover();
    const meta = (transport.history[0]?.params?._meta ?? {}) as Record<string, unknown>;
    assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    assert.ok("io.modelcontextprotocol/clientCapabilities" in meta);
});

await test("connect discovers tools and pins a stable digest", async () => {
    const { exec, receipts } = setup();
    const snapshot = await exec.connect();
    assert.equal(snapshot.tools.length, 3);
    assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(snapshot.ttlMs, 60_000);
    assert.equal(receipts.length, 0);
});

await test("tools/list is cached within ttlMs", async () => {
    const { exec, server } = setup();
    await exec.connect();
    assert.equal(server.listCalls, 1);
    await exec.ensureFresh();
    await exec.ensureFresh();
    assert.equal(server.listCalls, 1);
});

await test("small results stay inline", async () => {
    const { exec, receipts } = setup();
    await exec.connect();
    const out = await exec.call("metrics.query", { metric: "5xx_rate" });
    assert.ok(out.inline?.includes("5xx_rate"));
    assert.equal(out.handle, undefined);
    assert.equal(out.receipt.outcome, "success");
    assert.equal(out.receipt.usage.calls, 1);
    assert.equal(receipts.length, 1);
});

await test("oversized results become handles, not truncation", async () => {
    const { exec, handles } = setup();
    await exec.connect();
    const out = await exec.call("logs.query", { window: "post" });
    assert.ok(out.handle, "expected handle");
    assert.ok(out.tokens > 1200, `expected >1200 tokens, got ${out.tokens}`);
    assert.equal(out.receipt.handle?.id, out.handle);
    const page = handles.read(out.handle, 0, 100);
    assert.ok(page.text.length > 0);
    assert.equal(page.next, 400);
});

await test("handle paging rejects non-progressing or invalid numeric windows", async () => {
    const handles = new HandleStore();
    const handle = handles.put("abcdefgh", "text", 2);
    for (const cursor of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
        assert.throws(() => handles.read(handle.id, cursor, 1), RangeError);
    }
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 0.5]) {
        assert.throws(() => handles.read(handle.id, 0, limit), RangeError);
    }
    assert.deepEqual(handles.read(handle.id, 0, 1), { text: "abcd", next: 4, totalPages: 2, tokens: 1 });
});

await test("tool arguments are validated against inputSchema before dispatch", async () => {
    const { exec, server, receipts } = setup();
    await exec.connect();
    await assert.rejects(
        () => exec.call("logs.query", { window: "mid" }),
        (error) => error instanceof PolicyDenied,
    );
    assert.equal(server.calls, 0);
    assert.equal(receipts.at(-1)?.outcome, "blocked");
    assert.match(receipts.at(-1)?.note ?? "", /invalid_tool_args/);

    const good = await exec.call("logs.query", { window: "post" });
    assert.equal(good.receipt.outcome, "success");
    assert.equal(server.calls, 1);
});

await test("destructive tools need a claim, host approval and one-time consumption", async () => {
    const { exec, server, receipts } = setup();
    await exec.connect();
    const args = { version: "v41" };

    await assert.rejects(
        () => exec.call("deploy.rollback", args, { claim: heldClaim() }),
        (error) => error instanceof ApprovalRequired,
    );
    assert.equal(server.calls, 0);
    assert.equal(receipts.at(-1)?.outcome, "blocked");
    assert.match(receipts.at(-1)?.note ?? "", /approval_required/);

    await assert.rejects(
        () => exec.call("deploy.rollback", args, { claim: heldClaim("T2") }),
        (error) => error instanceof PolicyDenied,
    );
    assert.equal(server.calls, 0);

    const approval = exec.approveTool("deploy.rollback", args, "host.operator", 60_000);
    const approved = await exec.call("deploy.rollback", args, { claim: heldClaim(), approval });
    assert.ok(approved.inline?.includes("v41"));
    assert.equal(server.calls, 1);

    await assert.rejects(
        () => exec.call("deploy.rollback", args, { claim: heldClaim(), approval }),
        (error) => error instanceof PolicyDenied,
    );
    assert.equal(server.calls, 1);

    const wrongArgsApproval = exec.approveTool("deploy.rollback", args, "host.operator", 60_000);
    await assert.rejects(
        () => exec.call("deploy.rollback", { version: "v42" }, { claim: heldClaim(), approval: wrongArgsApproval }),
        (error) => error instanceof PolicyDenied,
    );
    assert.equal(server.calls, 1);
});

await test("Dispatcher rejects invalid costs and charges dimensions atomically", async () => {
    const dispatcher = new Dispatcher({ tokens: 10, calls: 1, ms: 100 });
    let ran = false;
    assert.throws(() => dispatcher.run(() => (ran = true), { tokens: Number.NaN }), RangeError);
    assert.throws(() => dispatcher.run(() => (ran = true), { tokens: -1 }), RangeError);
    assert.throws(() => dispatcher.run(() => (ran = true), { ms: Number.POSITIVE_INFINITY }), RangeError);
    assert.equal(ran, false);
    assert.deepEqual(dispatcher.usage(), { tokens: 0, calls: 0, ms: 0 });

    assert.throws(() => dispatcher.run(() => (ran = true), { tokens: 5, calls: 2 }), BudgetExceeded);
    assert.equal(ran, false);
    assert.deepEqual(dispatcher.usage(), { tokens: 0, calls: 0, ms: 0 });
    dispatcher.run(() => (ran = true), { tokens: 5, calls: 1, ms: 20 });
    assert.equal(ran, true);
    assert.deepEqual(dispatcher.usage(), { tokens: 5, calls: 1, ms: 20 });
    assert.throws(() => new Dispatcher({ tokens: Number.NaN }), RangeError);
    const suppliedLease: Budget = { tokens: 1 };
    const isolated = new Dispatcher(suppliedLease);
    suppliedLease.tokens = 100;
    isolated.run(() => {}, { tokens: 1, calls: 0 });
    assert.throws(() => isolated.run(() => {}, { tokens: 1, calls: 0 }), BudgetExceeded);
});

await test("nested budget exhaustion blocks before the call", async () => {
    const { exec, server } = setup({ budget: { calls: 1, ms: 10_000 } });
    await exec.connect();
    await exec.call("metrics.query", { metric: "a" });
    await assert.rejects(
        () => exec.call("metrics.query", { metric: "b" }),
        (error) => error instanceof BudgetExceeded,
    );
    assert.equal(server.calls, 1);
});

await test("catalog drift fails closed", async () => {
    const { exec, server } = setup();
    await exec.connect();
    server.mutateDescription();

    const verdict = await exec.verify();
    assert.equal(verdict.ok, false);
    await assert.rejects(
        () => exec.refresh(),
        (error) => error instanceof DriftDetected,
    );
});

await test("call-time pin catches a change inside the TTL window", async () => {
    const { exec, server, receipts } = setup();
    await exec.connect();
    server.mutateDescription();
    await assert.rejects(
        () => exec.call("logs.query", { window: "post" }),
        (error) => error instanceof DriftDetected,
    );
    assert.equal(server.calls, 0);
    assert.equal(receipts.at(-1)?.outcome, "blocked");
});

await test("clock is injected so receipts share one timeline", async () => {
    const { exec } = setup();
    await exec.connect();
    const out = await exec.call("metrics.query", { metric: "x" });
    assert.equal(out.receipt.at, "2026-10-24T01:00:01.000Z");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
