#!/usr/bin/env node
/**
 * Real DeepSeek A/B: flat context vs AST summaries vs AST + on-demand detail.
 * Requires DEEPSEEK_API_KEY. Writes docs/probes/context-ast-deepseek.json and
 * viz/context-ast.json for the browser.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { ContextAst, MemoryDetailStore } from "../src/context/ast.ts";
import type { ContextAstNode } from "../src/context/ast.ts";
import { DeepSeekLlm } from "../src/module/llm/deepseek.ts";
import type { LlmMessage, LlmResponse } from "../src/module/llm/llm.ts";

const key = process.env.DEEPSEEK_API_KEY;
if (key === undefined || key.trim().length === 0) {
    console.error("DEEPSEEK_API_KEY is not set");
    process.exit(1);
}

const ast = new ContextAst();
const details = new MemoryDetailStore();
const add = (node: ContextAstNode): void => {
    ast.add(node);
};

add({
    id: "incident",
    kind: "goal",
    summary: "payment API p99 2.8s, 5xx 8%, thread/pool saturated, DB CPU 92%, 12m after release",
    order: 0,
    salience: 1,
});
const layers = ["thread_pool", "connection_pool", "connect", "database", "queue", "application", "release"] as const;
for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
    const layer = layers[layerIndex];
    const layerId = `layer.${layer}`;
    add({
        id: layerId,
        parentId: "incident",
        kind: "frame",
        summary: `${layer}: USE checklist pending; correlate with version and queue`,
        order: layerIndex + 1,
        salience: 0.9 - layerIndex * 0.04,
    });
    for (let probe = 0; probe < 20; probe += 1) {
        const id = `${layerId}.probe.${probe}`;
        const special = layer === "database" && probe === 3;
        const detail = special
            ? "pg_locks: blocking_pid=4711, blocked_pid=4820, lock_mode=ShareLock, wait_event=Lock, transaction_age=94s"
            : `${layer} probe ${probe}: ` + "raw metric, stack sample, dependency span ".repeat(10);
        const ref = details.put(id, detail);
        add({
            id,
            parentId: layerId,
            kind: "observation",
            summary: special
                ? "database lock-wait: critical; blocking chain found; query plan pending"
                : `${layer} probe ${probe}: ${probe % 3 === 0 ? "warn" : "normal"} signal`,
            detailRef: ref,
            detailTokens: Math.ceil(detail.length / 4),
            order: layerIndex * 100 + probe + 10,
            salience: special ? 1 : 0.4,
        });
    }
}
for (let index = 0; index < layers.length - 1; index += 1) ast.link({ from: `layer.${layers[index]}`, to: `layer.${layers[index + 1]}`, kind: "before" });

const view = ast.view(1800);
const flat = ast.flat(details);
const llm = new DeepSeekLlm({ apiKey: key, model: "deepseek-flash", timeoutMs: 60_000, retries: 0 });

const summaryQuestion =
    "Which layer is best supported by the incident? Answer exactly: LAYER=<one of thread_pool,connection_pool,connect,database,queue,application,release> followed by one short reason.";
const detailQuestion =
    "From the database lock-wait probe, what are blocking_pid and lock_mode? If the detail is not in context, answer PID=UNKNOWN LOCK=UNKNOWN. If a read_detail tool is available, use it with nodeId=layer.database.probe.3. Format: PID=<n> LOCK=<mode>.";

const call = async (messages: LlmMessage[], tools = false): Promise<{ response: LlmResponse; ms: number; toolCalls: string[] }> => {
    const started = Date.now();
    const response = await llm.complete({
        model: "deepseek-flash",
        messages,
        maxTokens: 160,
        temperature: 0,
        ...(tools
            ? {
                  tools: [
                      {
                          name: "read_detail",
                          description: "Read the detailed local content behind an AST node summary.",
                          inputSchema: {
                              type: "object",
                              properties: { nodeId: { type: "string" } },
                              required: ["nodeId"],
                          },
                      },
                  ],
              }
            : {}),
    });
    return { response, ms: Date.now() - started, toolCalls: (response.toolCalls ?? []).map((tool) => tool.name) };
};

const system = "You are an incident diagnostician. Be concise. Do not invent facts absent from the provided context.";
const flatMessages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `CONTEXT:\n${flat.text}\n\nQUESTION: ${summaryQuestion}` },
];
const astMessages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `CONTEXT (summaries only; details behind refs):\n${view.text}\n\nQUESTION: ${summaryQuestion}` },
];
const flatSummary = await call(flatMessages);
const astSummary = await call(astMessages);

const flatDetail = await call([
    { role: "system", content: system },
    { role: "user", content: `CONTEXT:\n${flat.text}\n\nQUESTION: ${detailQuestion}` },
]);
const astDetail = await call([
    { role: "system", content: system },
    { role: "user", content: `CONTEXT (summaries only; details behind refs):\n${view.text}\n\nQUESTION: ${detailQuestion}` },
]);

const toolBase: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `CONTEXT (summaries only; details behind refs):\n${view.text}\n\nQUESTION: ${detailQuestion}` },
];
let toolResult: { response: LlmResponse; ms: number; toolCalls: string[] } | undefined;
const first = await call(toolBase, true);
if (first.response.toolCalls !== undefined && first.response.toolCalls.length > 0) {
    const toolCall = first.response.toolCalls[0];
    let payload: { nodeId?: string } = {};
    try {
        payload = JSON.parse(toolCall.arguments) as { nodeId?: string };
    } catch {
        payload = {};
    }
    const nodeId = payload.nodeId ?? "layer.database.probe.3";
    const detail = ast.expand(nodeId, details) ?? "detail_not_found";
    toolResult = await call(
        [
            ...toolBase,
            { role: "assistant", content: first.response.text, toolCalls: [toolCall] },
            { role: "tool", content: detail, toolCallId: toolCall.id, name: "read_detail" },
        ],
        false,
    );
    toolResult.toolCalls = [...first.toolCalls, ...toolResult.toolCalls];
    toolResult.ms += first.ms;
} else {
    toolResult = first;
}

const layer = (text: string): string | null =>
    /\b(thread_pool|connection_pool|connect|database|queue|application|release)\b/i.exec(text)?.[1].toLowerCase() ?? null;
const pid = (text: string): string | null => (/\b4711\b/.exec(text) ? "4711" : null);
const lock = (text: string): string | null => (/\bShareLock\b/i.exec(text) ? "ShareLock" : null);

const conditions = [
    {
        id: "flat",
        label: "flat summaries+details",
        summary: flatSummary,
        detail: flatDetail,
        inputTokens: flatSummary.response.usage.inputTokens + flatDetail.response.usage.inputTokens,
    },
    {
        id: "ast-summary",
        label: "AST summaries only",
        summary: astSummary,
        detail: astDetail,
        inputTokens: astSummary.response.usage.inputTokens + astDetail.response.usage.inputTokens,
    },
    {
        id: "ast-tool",
        label: "AST summaries + read_detail",
        summary: astSummary,
        detail: toolResult,
        inputTokens: astSummary.response.usage.inputTokens + (toolResult?.response.usage.inputTokens ?? 0),
    },
];

const report = {
    generatedAt: new Date().toISOString(),
    model: "deepseek-flash",
    context: {
        nodes: ast.order().length,
        viewTokens: view.tokens,
        flatTokens: flat.tokens,
        refs: view.refs.length,
        budgetTokens: view.budgetTokens,
    },
    conditions: conditions.map((condition) => ({
        id: condition.id,
        label: condition.label,
        inputTokens: condition.inputTokens,
        summary: {
            text: condition.summary?.response.text ?? "",
            layer: layer(condition.summary?.response.text ?? ""),
            expectedLayer: "database",
            latencyMs: condition.summary?.ms ?? 0,
            toolCalls: condition.summary?.toolCalls ?? [],
        },
        detail: {
            text: condition.detail?.response.text ?? "",
            pid: pid(condition.detail?.response.text ?? ""),
            lock: lock(condition.detail?.response.text ?? ""),
            expectedPid: "4711",
            expectedLock: "ShareLock",
            latencyMs: condition.detail?.ms ?? 0,
            toolCalls: condition.detail?.toolCalls ?? [],
        },
    })),
    tree: ast.order().map((node) => ({
        id: node.id,
        parentId: node.parentId,
        kind: node.kind,
        summary: node.summary,
        detailRef: node.detailRef,
        depth: ast.ancestors(node.id).length,
        order: node.order,
    })),
    edges: ast.serialize().edges,
    details: Object.fromEntries(
        ast
            .order()
            .filter((node) => node.detailRef !== undefined)
            .map((node) => [node.id, details.get(node.detailRef as string) ?? ""]),
    ),
};
mkdirSync("viz", { recursive: true });
writeFileSync("docs/probes/context-ast-deepseek.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync("viz/context-ast.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const condition of report.conditions) {
    console.log(
        `${condition.id.padEnd(12)} in=${condition.inputTokens} layer=${condition.summary.layer} pid=${condition.detail.pid ?? "null"} lock=${condition.detail.lock ?? "null"} tools=${condition.detail.toolCalls.join(",") || "none"}`,
    );
}
console.log(`nodes=${report.context.nodes} viewTokens=${report.context.viewTokens} flatTokens=${report.context.flatTokens}`);
