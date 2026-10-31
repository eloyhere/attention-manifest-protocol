#!/usr/bin/env node
/**
 * Offline HTTP/MCP adapter boundary regressions. No paid API or external network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpClient } from "../src/module/mcp/client.ts";
import { HttpTransport } from "../src/module/mcp/http.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "../src/module/mcp/protocol.ts";
import { MemoryTransport } from "../src/module/mcp/transport.ts";
import { DeniedSandbox } from "../src/module/sandbox/sandbox.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import { RiskToolPolicy } from "../src/module/tool/policy.ts";
import { redactSecrets } from "../src/module/tool/redact.ts";

const Request: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const withFetch = async (fake: typeof fetch, run: () => Promise<void>): Promise<void> => {
    const original: typeof fetch = globalThis.fetch;
    globalThis.fetch = fake;
    try {
        await run();
    } finally {
        globalThis.fetch = original;
    }
};
const transport = (): HttpTransport => new HttpTransport({ url: "https://offline.invalid/mcp" });

test("HTTP status failures reject empty, JSON success, JSON error and plaintext bodies", async (): Promise<void> => {
    for (const body of ["", '{"jsonrpc":"2.0","id":1,"result":{}}', '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"missing"}}', "failure"]) {
        await withFetch((async () => new Response(body, { status: 500 })) as typeof fetch, async (): Promise<void> => {
            await assert.rejects(transport().send(Request), /HTTP 500/);
        });
    }
});

test("empty success is accepted for notifications and rejected for requests", async (): Promise<void> => {
    await withFetch((async () => new Response(null, { status: 202 })) as typeof fetch, async (): Promise<void> => {
        await assert.rejects(transport().send(Request), /empty HTTP response/);
        await transport().send({ jsonrpc: "2.0", method: "notifications/initialized" });
    });
});

test("SSE preserves event boundaries, ignores notifications, joins data lines with newline and matches id", async (): Promise<void> => {
    const body: string = ': heartbeat\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":99,"result":"other"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":1,\r\ndata: "result":{"tools":[]}}\r\n\r\n';
    await withFetch((async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch, async (): Promise<void> => {
        assert.deepEqual(await transport().send(Request), { jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });
});

test("SSE duplicate, missing, malformed events and malformed JSON reject", async (): Promise<void> => {
    const bodies: Array<[string, string]> = [
        ['data: {"jsonrpc":"2.0","id":1,"result":{}}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', "text/event-stream"],
        ['data: {"jsonrpc":"2.0","id":2,"result":{}}\n\n', "text/event-stream"],
        ["data: {bad}\n\n", "text/event-stream"],
        ["{bad}", "application/json"],
    ];
    for (const [body, contentType] of bodies) {
        await withFetch((async () => new Response(body, { headers: { "content-type": contentType } })) as typeof fetch, async (): Promise<void> => {
            await assert.rejects(transport().send(Request));
        });
    }
});

test("protocol headers cannot be overridden by custom headers with alternate casing", async (): Promise<void> => {
    await withFetch((async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers: Headers = new Headers(init?.headers);
        assert.equal(headers.get("mcp-protocol-version"), "2026-07-28");
        assert.equal(headers.get("mcp-method"), "tools/call");
        assert.equal(headers.get("mcp-name"), "example");
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(headers.get("authorization"), "Bearer offline");
        return new Response('{"jsonrpc":"2.0","id":1,"result":{}}');
    }) as typeof fetch, async (): Promise<void> => {
        await new HttpTransport({ url: "https://offline.invalid", headers: { "MCP-Protocol-Version": "bad", "MCP-Method": "bad", "MCP-Name": "bad", "Content-Type": "bad", Authorization: "Bearer offline" } }).send({ ...Request, method: "tools/call", params: { name: "example" } });
    });
});

test("HTTP timeout aborts the injected pending fetch", async (): Promise<void> => {
    await withFetch((async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject): void => {
        init?.signal?.addEventListener("abort", (): void => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch, async (): Promise<void> => {
        await assert.rejects(new HttpTransport({ url: "https://offline.invalid", timeoutMs: 5 }).send(Request), /aborted/);
    });
});

test("client rejects invalid JSON-RPC response object, version, id and result/error exclusivity", async (): Promise<void> => {
    const responses: unknown[] = [null, [], {}, { jsonrpc: "1.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: "1", result: {} }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "bad" } }, { jsonrpc: "2.0", id: 1, error: null }, { jsonrpc: "2.0", id: 1, error: { code: "bad", message: "bad" } }];
    for (const response of responses) {
        const client: McpClient = new McpClient(new MemoryTransport((): JsonRpcResponse => response as JsonRpcResponse));
        await assert.rejects(client.listTools());
    }
});

test("client correlates concurrent responses to the originating request", async (): Promise<void> => {
    const client: McpClient = new McpClient(new MemoryTransport(async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
        await Promise.resolve();
        return { jsonrpc: "2.0", id: request.id!, result: { tools: [request.id] } };
    }));
    const replies = await Promise.all([client.listTools(), client.listTools()]);
    assert.deepEqual(replies.map((reply) => reply.tools), [[1], [2]]);
});

test("tool policy allowlist, approval and secret redaction preserve deny boundaries", async (): Promise<void> => {
    const destructive = { name: "destroy", description: "destroy", inputSchema: {}, risk: "destructive" as const };
    const invocation = { tool: "destroy", args: {} };
    assert.equal((await new RiskToolPolicy().check(invocation, destructive)).allowed, false);
    assert.equal((await new RiskToolPolicy({ allowedTools: [] }).check(invocation, { ...destructive, risk: "read" })).allowed, false);
    assert.equal((await new RiskToolPolicy({ approve: async () => true }).check(invocation, destructive)).allowed, true);
    const redacted = redactSecrets("password=secretvalue sk-12345678901234567890");
    assert.equal(redacted.redacted, true);
    assert.doesNotMatch(redacted.text, /secretvalue|12345678901234567890/);
    assert.deepEqual(redactSecrets("ordinary text"), { text: "ordinary text", redacted: false });
});

test("sandbox denies without execution and scripted LLM fails on exhaustion", async (): Promise<void> => {
    await assert.rejects(new DeniedSandbox().run(), /sandbox_unavailable/);
    const llm: ScriptedLlm = new ScriptedLlm([{ text: "ok", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } }]);
    assert.equal((await llm.complete({ model: "fake", messages: [] })).text, "ok");
    await assert.rejects(llm.complete({ model: "fake", messages: [] }), /no response left/);
});
