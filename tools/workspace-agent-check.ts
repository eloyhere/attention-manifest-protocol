#!/usr/bin/env node
/**
 * Exercise real adapters, host authorization, budget accounting and stdio.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { ContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits } from "../src/context/workspaceService.ts";
import type { WorkspaceResponse } from "../src/protocol/workspace.ts";
import type { Frame } from "../src/frame/frame.ts";
import type { Receipt } from "../src/receipt/receipt.ts";
import { McpClient } from "../src/module/mcp/client.ts";
import { ProtocolVersion, textOf } from "../src/module/mcp/protocol.ts";
import type { JsonRpcResponse } from "../src/module/mcp/protocol.ts";
import { MemoryTransport } from "../src/module/mcp/transport.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import { registerMcpTools, McpToolExecutor } from "../src/module/tool/mcpExecutor.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import { registerWorkspaceTools, WorkspaceToolExecutor } from "../src/module/tool/workspaceExecutor.ts";
import { scanStructuredWorkspace } from "./support/documentScanner.ts";
import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { CognitiveRuntime, MemoryReceiptSink } from "../src/runtime/cognitiveRuntime.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/module/llm/llm.ts";

const Store: MemoryContentStore = new MemoryContentStore();
const Snapshot: WorkspaceSnapshot = scanStructuredWorkspace(
    [
        { path: "app/package.json", content: '{"name":"app"}' },
        { path: "app/main.ts", content: 'import { hidden } from "../private/secret.ts"; export const shown = hidden;' },
        { path: "app/guide.md", content: `# Guide\nCHOSEN BODY ${"x".repeat(10000)}\n## Unallocated\nSIBLING BODY` },
        { path: "app/paper.tex", content: "\\documentclass{article}\n\\begin{document}\n\\section{Result}\nResult text\n\\end{document}" },
        { path: "private/package.json", content: '{"name":"private"}' },
        { path: "private/secret.ts", content: "export const hidden = 'PRIVATE BODY';" },
    ],
    Store,
);
const Revision: string = Snapshot.revision;
const Target: string = "knowledge:app/guide.md#L1";
const frame: (id?: string, ids?: string[], tokens?: number) => Frame = (id: string = "f.agent", ids: string[] = [Target], tokens: number = 2000): Frame => ({
    amp: "0.1",
    kind: "frame",
    id,
    agent: "a.test",
    cycle: 0,
    ts: "2026-10-29T00:00:00Z",
    digest: "0".repeat(64),
    mode: "explore",
    slots: ids.map((nodeId: string): Frame["slots"][number] => ({
        target: { kind: "other", id: nodeId },
        role: "artifact",
        salience: 1,
        cost: {},
        why: "host selected this target",
        state: "active",
    })),
    budget: { allocated: { tokens }, spent: {} },
});
const service: (limits?: Partial<WorkspaceServiceLimits>, store?: ContentStore) => WorkspaceAgentService = (limits?: Partial<WorkspaceServiceLimits>, store: ContentStore = Store): WorkspaceAgentService => new WorkspaceAgentService({ snapshot: Snapshot, agentId: "a.test", projectIds: ["project:app"], store, limits });
const call: (host: WorkspaceAgentService, operation: string, args?: Record<string, unknown>) => WorkspaceResponse = (host: WorkspaceAgentService, operation: string, args: Record<string, unknown> = {}): WorkspaceResponse => host.call(`amp_workspace_${operation}`, { revision: Revision, ...args });
const data: (response: WorkspaceResponse) => Record<string, unknown> = (response: WorkspaceResponse): Record<string, unknown> => {
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) {
        throw new Error("expected success");
    }
    return response.data;
};
const code: (response: WorkspaceResponse) => string = (response: WorkspaceResponse): string => {
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!("error" in response)) {
        throw new Error("expected error");
    }
    return response.error.code;
};

test("discovery and graph/tree navigation reveal only the host scope without content bodies", (): void => {
    const host: WorkspaceAgentService = service();
    const discovered: Record<string, unknown> = data(host.call("amp_workspace_capabilities", {}));
    assert.deepEqual(discovered.projectIds, ["project:app"]);
    assert.equal((discovered.tools as string[]).length, 16);
    const tree: Record<string, unknown> = data(call(host, "tree", { parentId: "project:app", limit: 1 }));
    assert.equal((tree.items as unknown[]).length, 1);
    assert.equal(tree.nextOffset, 1);
    assert.doesNotMatch(JSON.stringify(tree), /CHOSEN BODY|PRIVATE BODY|"summary"|"detailRef"/);
    const next: Record<string, unknown> = data(call(host, "tree", { parentId: "project:app", offset: 1, limit: 1 }));
    assert.notDeepEqual(next.items, tree.items);
    assert.equal(code(call(host, "tree", { parentId: "project:private" })), "not_available");
    assert.equal(code(call(host, "tree", { parentId: "unknown" })), "not_available");
    const found: Record<string, unknown> = data(call(host, "query", { text: "PRIVATE BODY", maxDepth: 0 }));
    assert.deepEqual(found.candidates, []);
    assert.deepEqual(data(call(host, "query", { seedIds: [Target], projectIds: [] })).candidates, []);
    const edges: Record<string, unknown> = data(call(host, "relations", { nodeId: "file:app/main.ts", direction: "outgoing" }));
    assert.doesNotMatch(JSON.stringify(edges), /private/);
    const definitions: ReturnType<WorkspaceAgentService["tools"]> = host.tools();
    definitions[0].inputSchema.type = "tampered";
    assert.equal(host.tools()[0].inputSchema.type, "object");
});

test("argument validation is enforced on direct service calls and failures do not mutate allocations", (): void => {
    const host: WorkspaceAgentService = service();
    host.registerFrame(frame(), Revision);
    const invalid: [string, Record<string, unknown>][] = [
        ["query", { direction: "sideways" }],
        ["query", { limit: 101 }],
        ["query", { relationKinds: ["depends"] }],
        ["read", { contextId: "x", nodeId: Target, offset: -1 }],
        ["materialize", { frameId: "f.agent", budgetTokens: 0 }],
        ["tree", { includeDetails: true }],
        ["materialize", { frameId: "f.agent", budgetTokens: 200, frame: frame() }],
    ];
    invalid.forEach(([operation, args]: [string, Record<string, unknown>]): void => {
        assert.equal(code(call(host, operation, args)), "invalid_arguments");
    });
    assert.equal(code(call(host, "query", { revision: "old" })), "revision_mismatch");
    assert.equal(code(host.call("amp_workspace_query", null)), "invalid_arguments");
    assert.equal(code(host.call("amp_workspace_missing", {})), "unknown_tool");
    assert.equal(code(call(host, "materialize", { frameId: "unregistered", budgetTokens: 200 })), "frame_unavailable");
    data(call(host, "materialize", { frameId: "f.agent", budgetTokens: 200 }));
});

test("only explicitly allocated materialized targets allow detail; replay and release cannot reset budgets", (): void => {
    const host: WorkspaceAgentService = service({ maxReadChars: 16 });
    const allocated: Frame = frame();
    host.registerFrame(allocated, Revision);
    allocated.slots[0].target.id = "file:app/guide.md";
    const view: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.agent", budgetTokens: 500 }));
    const contextId: string = view.contextId as string;
    assert.deepEqual(view.readableIds, [Target]);
    assert.equal(code(call(host, "read", { contextId, nodeId: "file:app/guide.md" })), "not_available");
    assert.equal(code(call(host, "read", { contextId, nodeId: "knowledge:app/guide.md#L3" })), "not_available");
    const read: Record<string, unknown> = data(call(host, "read", { contextId, nodeId: Target, maxChars: 100 }));
    assert.equal((read.text as string).length, 16);
    assert.equal(read.nextOffset, 16);
    assert.equal(read.remainingTokens, (view.remainingTokens as number) - 4);
    const second: Record<string, unknown> = data(call(host, "read", { contextId, nodeId: Target, offset: 16 }));
    assert.notEqual(second.text, read.text);
    const replay: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.agent", budgetTokens: 500 }));
    assert.equal(replay.contextId, contextId);
    assert.equal(replay.remainingTokens, second.remainingTokens);
    assert.equal(code(call(host, "materialize", { frameId: "f.agent", budgetTokens: 1000 })), "invalid_arguments");
    assert.equal(code(call(service(), "read", { contextId, nodeId: Target })), "not_available");
    data(call(host, "release", { contextId }));
    assert.equal(host.pendingSettlements()[0].contextId, contextId);
    const archived: ReturnType<WorkspaceAgentService["settle"]> = host.settle(contextId, {
        amp: "0.1",
        kind: "receipt",
        id: "r.released",
        op: "read",
        at: "2026-10-29T00:00:00Z",
        usage: {},
        outcome: "success",
    });
    assert.equal(archived.phase, "archived");
    assert.deepEqual(archived.receiptIds, ["r.released"]);
    assert.deepEqual(host.pendingSettlements(), []);
    assert.equal(code(call(host, "read", { contextId, nodeId: Target })), "not_available");
    assert.equal(code(call(host, "materialize", { frameId: "f.agent", budgetTokens: 500 })), "frame_unavailable");
    assert.throws((): void => host.registerFrame(frame(), Revision));
});

test("tight budgets deny deferred detail and cumulative pages cannot exceed a Frame's remainder", (): void => {
    const host: WorkspaceAgentService = service();
    host.registerFrame(frame("f.tight", [Target], 1), Revision);
    const tiny: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.tight", budgetTokens: 1 }));
    assert.deepEqual(tiny.readableIds, []);
    assert.equal(code(call(host, "read", { contextId: tiny.contextId, nodeId: Target })), "not_available");
    host.registerFrame(frame("f.pages", [Target], 500), Revision);
    const view: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.pages", budgetTokens: 300 }));
    let used: number = view.tokens as number;
    let response: WorkspaceResponse;
    do {
        response = call(host, "read", { contextId: view.contextId, nodeId: Target, maxChars: 16000 });
        if (response.ok) {
            used += response.data.tokens as number;
        }
    } while (response.ok);
    assert.equal(code(response), "budget_exhausted");
    assert.equal(used, 500);
});

test("CAS corruption is caught even for a custom store, and errors do not leak host paths", (): void => {
    let corrupt: boolean = true;
    const store: ContentStore = {
        put: (text: string): string => Store.put(text),
        get: (ref: string): string | undefined => (corrupt ? "C:\\private\\credential" : Store.get(ref)),
    };
    const host: WorkspaceAgentService = service({}, store);
    host.registerFrame(frame(), Revision);
    const view: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.agent", budgetTokens: 500 }));
    const failed: WorkspaceResponse = call(host, "read", { contextId: view.contextId, nodeId: Target });
    assert.equal(code(failed), "integrity_failure");
    assert.doesNotMatch(JSON.stringify(failed), /credential/);
    corrupt = false;
    const page: Record<string, unknown> = data(call(host, "read", { contextId: view.contextId, nodeId: Target, maxChars: 16 }));
    assert.equal(page.remainingTokens, (view.remainingTokens as number) - 4);
});

test("host-only registration, revocation, settlement and bounded sessions preserve authority", (): void => {
    const host: WorkspaceAgentService = service({ maxFrames: 2, maxContexts: 1 });
    assert.throws((): void => host.registerFrame(frame("f.foreign", ["file:private/secret.ts"]), Revision));
    assert.throws((): void => host.registerFrame({ ...frame(), agent: "a.other" }, Revision));
    assert.throws((): void => host.registerFrame(frame(), "old"));
    host.registerFrame(frame(), Revision);
    host.registerFrame(frame("f.second"), Revision);
    assert.throws((): void => host.registerFrame(frame("f.third"), Revision));
    const view: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.agent", budgetTokens: 500 }));
    assert.equal(code(call(host, "materialize", { frameId: "f.second", budgetTokens: 500 })), "capacity_exceeded");
    host.revokeFrame("f.agent");
    assert.equal(host.pendingSettlements()[0].contextId, view.contextId);
    assert.equal(code(call(host, "read", { contextId: view.contextId, nodeId: Target })), "not_available");
    const second: Record<string, unknown> = data(call(host, "materialize", { frameId: "f.second", budgetTokens: 500 }));
    const receipt: Receipt = { amp: "0.1", kind: "receipt", id: "r.host", op: "read", at: "2026-10-29T00:00:00Z", usage: {}, outcome: "success" };
    host.settle(second.contextId as string, receipt);
    assert.equal(code(call(host, "read", { contextId: second.contextId, nodeId: Target })), "not_available");
    const bounded: WorkspaceAgentService = service({ maxToolCalls: 1 });
    data(bounded.call("amp_workspace_capabilities", {}));
    assert.equal(code(bounded.call("amp_workspace_capabilities", {})), "budget_exhausted");
});

test("oversized replies do not consume Frame state, and empty project scope stays empty", (): void => {
    const host: WorkspaceAgentService = service({ maxResponseChars: 300 });
    host.registerFrame(frame(), Revision);
    assert.equal(code(call(host, "materialize", { frameId: "f.agent", budgetTokens: 500 })), "response_too_large");
    host.revokeFrame("f.agent");
    const empty: WorkspaceAgentService = new WorkspaceAgentService({ snapshot: Snapshot, projectIds: [], agentId: "a.test", store: Store });
    assert.deepEqual(data(call(empty, "tree")).items, []);
    assert.deepEqual(data(call(empty, "query", { seedIds: [Target], text: "Guide" })).candidates, []);
    assert.throws((): void => empty.registerFrame(frame(), Revision));
});

test("registered tools work through the actual local executor and existing MCP client/executor", async (): Promise<void> => {
    const host: WorkspaceAgentService = service();
    host.registerFrame(frame(), Revision);
    const registry: ToolRegistry = new ToolRegistry();
    assert.equal(registerWorkspaceTools(registry, host).length, 16);
    assert.equal(registry.list().filter((tool): boolean => tool.risk === "read").length, 12);
    assert.equal(registry.list().filter((tool): boolean => tool.risk === "write").length, 4);
    assert.throws(() => registerWorkspaceTools(registry, host));
    assert.equal(registry.size, 16);
    const local: WorkspaceToolExecutor = new WorkspaceToolExecutor(host, {
        execute: async (): Promise<{ ok: boolean; content: string; }> => ({ ok: true, content: "fallback" }),
    });
    assert.equal((await local.execute({ tool: "other", args: {} })).content, "fallback");
    const localResult: Awaited<ReturnType<WorkspaceToolExecutor["execute"]>> = await local.execute({ tool: "amp_workspace_capabilities", args: {} });
    assert.equal(localResult.ok, true);
    const server: WorkspaceMcpServer = new WorkspaceMcpServer(host);
    const client: McpClient = new McpClient(new MemoryTransport((request): JsonRpcResponse => server.handle(request) as JsonRpcResponse));
    assert.equal((await client.negotiate()).mode, "stateless");
    const remoteRegistry: ToolRegistry = new ToolRegistry();
    await registerMcpTools(remoteRegistry, client);
    assert.equal(remoteRegistry.size, 16);
    const remote: McpToolExecutor = new McpToolExecutor(client);
    const result: Awaited<ReturnType<McpToolExecutor["execute"]>> = await remote.execute({
        tool: "amp_tool_workspace_materialize",
        args: { revision: Revision, frameId: "f.agent", budgetTokens: 500 },
    });
    assert.equal(result.ok, true);
    const view: Record<string, unknown> = data(JSON.parse(result.content) as WorkspaceResponse);
    assert.equal(
        (await remote.execute({ tool: "amp_tool_workspace_read", args: { revision: Revision, contextId: view.contextId, nodeId: Target, maxChars: 16 } })).ok,
        true,
    );
    assert.equal(
        (await remote.execute({ tool: "amp_tool_workspace_read", args: { revision: Revision, contextId: view.contextId, nodeId: "file:private/secret.ts" } })).ok,
        false,
    );
    assert.match(textOf(await client.callTool("amp_workspace_capabilities", {})), /amp.workspace/);
});

test("MCP handshake, string IDs, notifications and malformed messages obey wire boundaries", (): void => {
    const host: WorkspaceAgentService = service({ maxToolCalls: 1 });
    const server: WorkspaceMcpServer = new WorkspaceMcpServer(host);
    assert.equal(server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })!.error!.code, -32002);
    assert.equal(server.handle({ jsonrpc: "2.0", id: "hello", method: "initialize", params: { protocolVersion: "2025-11-25" } })!.id, "hello");
    assert.equal(server.handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "amp_workspace_capabilities", arguments: {} } }), (void 0));
    assert.equal(
        server.handle({ jsonrpc: "2.0", id: "cap", method: "tools/call", params: { name: "amp_workspace_capabilities", arguments: {} } })!.error,
        (void 0),
    );
    assert.equal(
        server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "unsupported" } } })!.error!
            .code,
        -32602,
    );
    assert.equal(server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "unknown" } })!.error!.code, -32602);
    assert.equal(server.handle({ jsonrpc: "2.0", id: 4, method: "missing" })!.error!.code, -32601);
    assert.equal(server.handle([{}])!.error!.code, -32600);
    assert.equal(server.handle({ jsonrpc: "2.0", id: {}, method: "tools/list" })!.error!.code, -32600);
    assert.equal(server.handle({ jsonrpc: "2.0", id: 5, method: "tools/list", params: [] })!.error!.code, -32600);
    const other: WorkspaceMcpServer = new WorkspaceMcpServer(service());
    other.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    const nullArgs: { content: Array<{ text: string; }>; isError: boolean; } = other.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amp_workspace_capabilities", arguments: null },
    })!.result as { content: Array<{ text: string; }>; isError: boolean; };
    assert.equal(nullArgs.isError, true);
    assert.equal(code(JSON.parse(nullArgs.content[0].text) as WorkspaceResponse), "invalid_arguments");
});

test("the real CognitiveRuntime advertises and executes workspace tools, returning results to the model", async (): Promise<void> => {
    const host: WorkspaceAgentService = service();
    host.registerFrame(frame(), Revision);
    const registry: ToolRegistry = new ToolRegistry();
    registerWorkspaceTools(registry, host);
    const agent: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    agent.createAgent({
        pid: 1,
        id: "a.test",
        name: "Workspace agent",
        values: [],
        constraints: [],
        narrative: "Inspect scoped documents.",
        at: "2026-10-29T00:00:00Z",
    });
    let round: number = 0;
    const llm: LlmClient = {
        complete: async (request: LlmRequest): Promise<LlmResponse> => {
            assert.equal(request.tools!.length, 16);
            round += 1;
            const toolMessages: typeof request.messages = request.messages.filter((message): boolean => message.role === "tool");
            if (round === 1) {
                return {
                    text: "",
                    finishReason: "tool_call",
                    usage: { inputTokens: 10, outputTokens: 10 },
                    toolCalls: [
                        {
                            id: "call.materialize",
                            name: "amp_tool_workspace_materialize",
                            arguments: JSON.stringify({ revision: Revision, frameId: "f.agent", budgetTokens: 500 }),
                        },
                    ],
                };
            }
            const first: { ok: boolean; content: string; } = JSON.parse(toolMessages[0].content) as { ok: boolean; content: string; };
            assert.equal(first.ok, true);
            const view: Record<string, unknown> = data(JSON.parse(first.content) as WorkspaceResponse);
            if (round === 2) {
                return {
                    text: "",
                    finishReason: "tool_call",
                    usage: { inputTokens: 10, outputTokens: 10 },
                    toolCalls: [
                        {
                            id: "call.read",
                            name: "amp_tool_workspace_read",
                            arguments: JSON.stringify({ revision: Revision, contextId: view.contextId, nodeId: Target, maxChars: 6000 }),
                        },
                    ],
                };
            }
            const last: { content: string; } = JSON.parse(toolMessages[1].content) as { content: string; };
            assert.ok(toolMessages[1].content.length > 4000);
            assert.match(data(JSON.parse(last.content) as WorkspaceResponse).text as string, /CHOSEN BODY/);
            return { text: "Read the allocated guide.", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10 } };
        },
    };
    const sink: MemoryReceiptSink = new MemoryReceiptSink();
    const runtime: CognitiveRuntime = new CognitiveRuntime({
        pid: 1,
        agent: agent.agents,
        social: agent.social,
        llm,
        tools: registry,
        toolExecutor: new WorkspaceToolExecutor(host),
        receiptSink: sink,
        useContext: false,
        maxToolRounds: 3,
    });
    const result: Awaited<ReturnType<CognitiveRuntime["respond"]>> = await runtime.respond("Inspect the registered workspace guide.");
    assert.equal(result.toolCalls!.length, 2);
    assert.ok(result.toolCalls!.every((item): boolean => item.ok));
    assert.equal(result.answer, "Read the allocated guide.");
    assert.equal(sink.receipts.length, 1);
});

test("runtime size limits return complete parseable errors rather than truncated tool JSON", async (): Promise<void> => {
    const agent: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    agent.createAgent({ pid: 1, id: "a.limit", name: "Limit agent", values: [], constraints: [], narrative: "Inspect tools.", at: "2026-10-29T00:00:00Z" });
    const registry: ToolRegistry = new ToolRegistry().register({ name: "large.read", description: "Read data", risk: "read", inputSchema: { type: "object" } });
    let round: number = 0;
    const llm: LlmClient = {
        complete: async (request: LlmRequest): Promise<LlmResponse> => {
            round += 1;
            if (round === 1) {
                return {
                    text: "",
                    usage: { inputTokens: 1, outputTokens: 1 },
                    finishReason: "tool_call",
                    toolCalls: [{ id: "large.1", name: "large.read", arguments: "{}" }],
                };
            }
            const message: { ok: boolean; error: string; } = JSON.parse(request.messages.at(-1)!.content) as { ok: boolean; error: string; };
            assert.equal(message.ok, false);
            assert.match(message.error, /tool_result_too_large/);
            assert.ok(request.messages.at(-1)!.content.length <= 128);
            return { text: "Please request a smaller page.", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
        },
    };
    [0, 127, 1024 * 1024 + 1, NaN, 200.5].forEach((limit: number): void => {
        assert.throws(() => new CognitiveRuntime({ pid: 1, agent: agent.agents, social: agent.social, llm, maxToolResultChars: limit }), RangeError);
    });
    const runtime: CognitiveRuntime = new CognitiveRuntime({
        pid: 1,
        agent: agent.agents,
        social: agent.social,
        llm,
        tools: registry,
        toolExecutor: { execute: async (): Promise<{ ok: boolean; content: string; }> => ({ ok: true, content: "x".repeat(5000) }) },
        maxToolResultChars: 128,
        useContext: false,
    });
    const result: Awaited<ReturnType<CognitiveRuntime["respond"]>> = await runtime.respond("Inspect the file.");
    assert.equal(result.toolCalls![0].ok, false);
    assert.match(result.toolCalls![0].error!, /tool_result_too_large/);
});

test("real stdio process handles malformed/oversized lines, legacy initialization and stateless calls", (): void => {
    const directory: string = mkdtempSync(join(tmpdir(), "amp-agent-"));
    try {
        const contents: Record<string, string> = Object.fromEntries(
            Snapshot.entities
                .filter((entity): boolean => entity.detailRef !== (void 0))
                .map((entity): [string, string] => [entity.detailRef!, Store.get(entity.detailRef!)!]),
        );
        const path: string = join(directory, "host.json");
        writeFileSync(path, JSON.stringify({ version: 1, agentId: "a.test", projectIds: ["project:app"], snapshot: Snapshot, contents, frames: [frame()] }));
        const input: string = [
            "{",
            "x".repeat(1024 * 1024 + 1),
            JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18" } }),
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
            JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "amp_tool_workspace_materialize", arguments: { revision: Revision, frameId: "f.agent", budgetTokens: 500 } },
            }),
            JSON.stringify({
                jsonrpc: "2.0",
                id: 4,
                method: "server/discover",
                params: { _meta: { "io.modelcontextprotocol/protocolVersion": ProtocolVersion } },
            }),
        ].join("\n");
        const result: ReturnType<typeof spawnSync> = spawnSync(process.execPath, [resolve("tools/workspace-agent-server.ts"), "--config", path], {
            input,
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024,
        });
        assert.equal(result.status, 0, `${result.stderr}`);
        assert.equal(result.stderr, "");
        const replies: Array<{ id: number | string | null; error?: { code: number; }; result?: Record<string, unknown>; }> = `${result.stdout}`
            .trim()
            .split("\n")
            .map((line: string) => JSON.parse(line));
        assert.equal(replies.length, 6);
        assert.equal(replies[0].error!.code, -32700);
        assert.equal(replies[1].error!.code, -32600);
        assert.equal(replies[2].id, "init");
        assert.equal((replies[3].result!.tools as unknown[]).length, 16);
        assert.equal(replies[4].result!.isError, false);
        assert.deepEqual(replies[5].result!.supportedVersions, [ProtocolVersion]);
        contents[Object.keys(contents)[0]] = "tampered";
        writeFileSync(path, JSON.stringify({ version: 1, agentId: "a.test", projectIds: [], snapshot: Snapshot, contents, frames: [] }));
        const corrupt: ReturnType<typeof spawnSync> = spawnSync(process.execPath, [resolve("tools/workspace-agent-server.ts"), "--config", path], {
            encoding: "utf8",
            timeout: 15000,
        });
        assert.equal(corrupt.status, 1);
        assert.equal(corrupt.stdout, "");
        assert.match(`${corrupt.stderr}`, /integrity/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
