#!/usr/bin/env node
/**
 * DeepSeek LLM adapter checks with a fake fetch. No network, no real key.
 */
import assert from "node:assert/strict";

import { DeepSeekError, DeepSeekLlm } from "../src/module/llm/deepseek.ts";
import type { LlmRequest } from "../src/module/llm/llm.ts";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>): void => {
    tests.push([name, fn]);
};

const request: LlmRequest = {
    model: "deepseek-flash",
    messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
    ],
    maxTokens: 64,
    temperature: 0,
};

test("maps request and usage through the LlmClient port", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(
            JSON.stringify({
                choices: [{ message: { content: "14" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 21, completion_tokens: 3, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 16 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    }) as typeof fetch;
    const llm = new DeepSeekLlm({ apiKey: "test-key", baseUrl: "https://example.test", fetchImpl: fakeFetch });
    const response = await llm.complete(request);
    assert.equal(response.text, "14");
    assert.equal(response.usage.inputTokens, 21);
    assert.equal(response.usage.outputTokens, 3);
    assert.equal(response.usage.cacheHitTokens, 5);
    assert.equal(response.usage.cacheMissTokens, 16);
    assert.equal(response.usage.costUsd !== undefined, true);
    assert.equal(response.usage.costUsd !== undefined && response.usage.costUsd > 0, true);
    assert.equal(response.finishReason, "stop");
    assert.equal(capturedUrl, "https://example.test/chat/completions");
    assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer test-key");
    const body = JSON.parse(String(capturedInit?.body)) as {
        model: string;
        thinking: { type: string };
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.thinking.type, "disabled");
    assert.equal(body.max_tokens, 64);
    assert.equal(body.messages.length, 2);
});

test("retries retryable errors and then succeeds", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
        calls += 1;
        if (calls === 1) {
            return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    }) as typeof fetch;
    const llm = new DeepSeekLlm({ apiKey: "test-key", fetchImpl: fakeFetch, retries: 1 });
    const response = await llm.complete(request);
    assert.equal(response.text, "ok");
    assert.equal(calls, 2);
});

test("does not retry a 401 and does not leak the key", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 });
    }) as typeof fetch;
    const llm = new DeepSeekLlm({ apiKey: "secret-key", fetchImpl: fakeFetch, retries: 3 });
    await assert.rejects(
        () => llm.complete(request),
        (error: unknown) => error instanceof DeepSeekError && error.status === 401 && !error.message.includes("secret-key"),
    );
    assert.equal(calls, 1);
});

test("maps tool definitions and tool calls", async () => {
    let body: Record<string, unknown> | undefined;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
            JSON.stringify({
                choices: [
                    {
                        message: {
                            content: "",
                            tool_calls: [{ id: "call-1", type: "function", function: { name: "metrics.query", arguments: '{"metric":"5xx_rate"}' } }],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
                usage: { prompt_tokens: 12, completion_tokens: 2 },
            }),
            { status: 200 },
        );
    }) as typeof fetch;
    const llm = new DeepSeekLlm({ apiKey: "test-key", fetchImpl: fakeFetch });
    const response = await llm.complete({
        ...request,
        tools: [{ name: "metrics.query", description: "read metric", inputSchema: { type: "object" } }],
    });
    assert.equal(response.finishReason, "tool_call");
    assert.deepEqual(response.toolCalls?.[0], { id: "call-1", name: "metrics.query", arguments: '{"metric":"5xx_rate"}' });
    const tools = body?.tools as Array<{ type: string; function: { name: string } }>;
    assert.equal(tools[0].type, "function");
    assert.equal(tools[0].function.name, "metrics.query");
});

test("fromEnv requires a key", async () => {
    assert.throws(() => DeepSeekLlm.fromEnv({}), /DEEPSEEK_API_KEY/);
    const llm = DeepSeekLlm.fromEnv({ DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "deepseek-flash" });
    assert.equal(llm instanceof DeepSeekLlm, true);
});

for (const [name, fn] of tests) {
    try {
        await fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
