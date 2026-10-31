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
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits, WorkspaceWriter } from "../src/context/workspaceService.ts";
import { deprecatedToolAliases, ToolIds, verifyCatalog } from "../src/naming/index.ts";
import type { ToolCatalog } from "../src/naming/index.ts";
import { WorkspaceServiceId } from "../src/protocol/workspace.ts";
import type { WorkspaceResponse } from "../src/protocol/workspace.ts";
import { GlobalAgentService } from "../src/global/service.ts";
import type { GlobalResponse } from "../src/protocol/global.ts";
import type { Frame } from "../src/frame/frame.ts";
import type { Receipt } from "../src/receipt/receipt.ts";
import { McpClient } from "../src/module/mcp/client.ts";
import { ProtocolVersion, textOf } from "../src/module/mcp/protocol.ts";
import type { JsonRpcResponse } from "../src/module/mcp/protocol.ts";

/**
 * Size of the registered tool surface, derived from the naming table.
 *
 * A hard-coded 7 turned every added tool into six failures with a bare count
 * mismatch; deriving the count means a new tool updates every assertion at once
 * while the per-tool checks below still verify what each one does.
 */
const ToolCount: number = Object.values(ToolIds).filter((id: string): boolean => id.startsWith("amp_tool_workspace_")).length;
import { MemoryTransport } from "../src/module/mcp/transport.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import type { WorkspaceRpcResponse } from "../src/module/mcp/workspaceServer.ts";
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
const service: (limits?: Partial<WorkspaceServiceLimits>, store?: ContentStore) => WorkspaceAgentService = (
    limits?: Partial<WorkspaceServiceLimits>,
    store: ContentStore = Store,
): WorkspaceAgentService => new WorkspaceAgentService({ snapshot: Snapshot, agentId: "a.test", projectIds: ["project:app"], store, limits });
const call: (host: WorkspaceAgentService, operation: string, args?: Record<string, unknown>) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    operation: string,
    args: Record<string, unknown> = {},
): WorkspaceResponse => host.call(`amp_tool_workspace_${operation}`, { revision: Revision, ...args });
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

/**
 * Import-graph fixture for the impact and write tests.
 *
 * `c.ts <- a.ts <- d.ts` is the direction the two fields are defined by: for
 * `a.ts`, `importation` is c.ts and `exportation` is d.ts. `e.ts` covers a bare
 * package specifier and an unresolved relative import.
 */
const GraphStore: MemoryContentStore = new MemoryContentStore();
const ContentC: string = "export const xx = 1;\n";
const ContentA: string = 'import { xx } from "./c.ts";\nexport const xxx = xx;\n';
const ContentD: string = 'import { xxx } from "./a.ts";\nconsole.log(xxx);\n';
const ContentUnicode: string = "h\u00e9llo\nw\u00f6rld\n";
const ContentAccent: string = "\u00e9\n";
const GraphSnapshot: WorkspaceSnapshot = scanStructuredWorkspace(
    [
        { path: "package.json", content: '{"name":"graph"}' },
        { path: "c.ts", content: ContentC },
        { path: "a.ts", content: ContentA },
        { path: "d.ts", content: ContentD },
        { path: "e.ts", content: 'import "node:fs";\nimport "./missing.ts";\n' },
        { path: "unicode.ts", content: ContentUnicode },
        { path: "accent.ts", content: ContentAccent },
    ],
    GraphStore,
);
const GraphRevision: string = GraphSnapshot.revision;
const GraphTarget: string = "file:a.ts";
const graphService: (writer?: WorkspaceWriter) => WorkspaceAgentService = (writer?: WorkspaceWriter): WorkspaceAgentService =>
    new WorkspaceAgentService({
        agentId: "a.test",
        projectIds: ["project:."],
        snapshot: GraphSnapshot,
        store: GraphStore,
        ...(writer === (void 0) ? {} : { writer }),
    });
const graphCall: (host: WorkspaceAgentService, operation: string, args?: Record<string, unknown>) => WorkspaceResponse = (
    host: WorkspaceAgentService,
    operation: string,
    args: Record<string, unknown> = {},
): WorkspaceResponse => host.call(`amp_tool_workspace_${operation}`, { revision: GraphRevision, ...args });
const graphSymbol: (label: string) => string = (label: string): string => {
    const found: WorkspaceEntity | undefined = GraphSnapshot.entities.find((item: WorkspaceEntity): boolean => item.kind === "symbol" && item.label === label);
    assert.ok(found, `symbol ${label} must exist`);
    return found!.id;
};
const linkPaths: (impact: unknown) => string[] = (impact: unknown): string[] =>
    ((impact as { files: Array<{ path: string }> }).files ?? []).map((item: { path: string }): string => item.path);

test("detail reads report the file's importation and exportation, including through a symbol", (): void => {
    const host: WorkspaceAgentService = graphService();
    host.registerFrame(frame("f.graph", [GraphTarget], 8000), GraphRevision);
    const view: Record<string, unknown> = data(graphCall(host, "materialize", { frameId: "f.graph", budgetTokens: 8000 }));
    assert.ok((view.readableIds as string[]).includes(GraphTarget));
    const page: Record<string, unknown> = data(graphCall(host, "read", { contextId: view.contextId, nodeId: GraphTarget, maxChars: 4000 }));
    assert.equal((page.importation as Record<string, unknown>).path, "a.ts");
    assert.deepEqual(linkPaths(page.importation), ["c.ts"]);
    assert.equal((page.exportation as Record<string, unknown>).path, "a.ts");
    assert.deepEqual(linkPaths(page.exportation), ["d.ts"]);
    assert.deepEqual(
        (page.importation as { files: Array<{ id: string }> }).files.map((item): string => item.id),
        ["file:c.ts"],
    );
    assert.deepEqual(
        (page.exportation as { files: Array<{ id: string }> }).files.map((item): string => item.id),
        ["file:d.ts"],
    );
    const symbol: string = graphSymbol("xxx");
    const symbolHost: WorkspaceAgentService = graphService();
    symbolHost.registerFrame(frame("f.symbol", [symbol], 8000), GraphRevision);
    const symbolView: Record<string, unknown> = data(graphCall(symbolHost, "materialize", { frameId: "f.symbol", budgetTokens: 8000 }));
    const symbolPage: Record<string, unknown> = data(graphCall(symbolHost, "read", { contextId: symbolView.contextId, nodeId: symbol, maxChars: 4000 }));
    assert.deepEqual(linkPaths(symbolPage.importation), ["c.ts"]);
    assert.deepEqual(linkPaths(symbolPage.exportation), ["d.ts"]);
    assert.equal((symbolPage.importation as Record<string, unknown>).path, "a.ts");
    const externalHost: WorkspaceAgentService = graphService();
    externalHost.registerFrame(frame("f.external", ["file:e.ts"], 8000), GraphRevision);
    const externalView: Record<string, unknown> = data(graphCall(externalHost, "materialize", { frameId: "f.external", budgetTokens: 8000 }));
    const externalPage: Record<string, unknown> = data(
        graphCall(externalHost, "read", { contextId: externalView.contextId, nodeId: "file:e.ts", maxChars: 4000 }),
    );
    assert.deepEqual((externalPage.importation as Record<string, unknown>).external, ["node:fs"]);
    assert.deepEqual(linkPaths(externalPage.importation), []);
});

test("detail reads page by 1-based lines and UTF-8 bytes and reject mixed addressing", (): void => {
    const host: WorkspaceAgentService = graphService();
    host.registerFrame(frame("f.graph", [GraphTarget], 8000), GraphRevision);
    const contextId: string = data(graphCall(host, "materialize", { frameId: "f.graph", budgetTokens: 8000 })).contextId as string;
    const first: Record<string, unknown> = data(graphCall(host, "read", { contextId, nodeId: GraphTarget, startLine: 1, maxLines: 1 }));
    assert.equal(first.text, 'import { xx } from "./c.ts";\n');
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 'import { xx } from "./c.ts";\n'.length);
    assert.equal(first.startLine, 1);
    assert.equal(first.endLine, 1);
    assert.equal(first.nextStartLine, 2);
    assert.equal(first.totalLines, 2);
    const second: Record<string, unknown> = data(graphCall(host, "read", { contextId, nodeId: GraphTarget, startLine: 2 }));
    assert.equal(second.text, "export const xxx = xx;\n");
    assert.equal(second.endLine, 2);
    assert.equal(second.nextStartLine, null);
    assert.equal(second.nextOffset, null);
    const eof: Record<string, unknown> = data(graphCall(host, "read", { contextId, nodeId: GraphTarget, startLine: 3 }));
    assert.equal(eof.text, "");
    assert.equal(eof.endLine, null);
    assert.equal(eof.nextStartLine, null);
    assert.equal(eof.totalLines, 2);
    assert.equal(code(graphCall(host, "read", { contextId, nodeId: GraphTarget, startLine: 4 })), "invalid_arguments");
    const bytes: Record<string, unknown> = data(graphCall(host, "read", { contextId, nodeId: GraphTarget, offsetBytes: 0, maxBytes: 6 }));
    assert.equal(bytes.text, "import");
    assert.equal(bytes.offsetBytes, 0);
    assert.equal(bytes.bytesRead, 6);
    assert.equal(bytes.nextOffsetBytes, 6);
    assert.equal(bytes.totalBytes, new TextEncoder().encode(ContentA).length);
    assert.equal(bytes.nextOffset, 6);
    assert.equal(code(graphCall(host, "read", { contextId, nodeId: GraphTarget, offset: 0, startLine: 1 })), "invalid_arguments");
    assert.equal(code(graphCall(host, "read", { contextId, nodeId: GraphTarget, startLine: 1, offsetBytes: 0 })), "invalid_arguments");
    const unicodeHost: WorkspaceAgentService = graphService();
    unicodeHost.registerFrame(frame("f.unicode", ["file:unicode.ts"], 8000), GraphRevision);
    const unicodeView: Record<string, unknown> = data(graphCall(unicodeHost, "materialize", { frameId: "f.unicode", budgetTokens: 8000 }));
    const unicodeContext: string = unicodeView.contextId as string;
    const partial: Record<string, unknown> = data(
        graphCall(unicodeHost, "read", { contextId: unicodeContext, nodeId: "file:unicode.ts", offsetBytes: 0, maxBytes: 6 }),
    );
    assert.equal(partial.text, "h\u00e9llo");
    assert.equal(partial.bytesRead, 6);
    assert.equal(partial.nextOffset, 5);
    const continued: Record<string, unknown> = data(graphCall(unicodeHost, "read", { contextId: unicodeContext, nodeId: "file:unicode.ts", offset: 5 }));
    assert.equal(continued.text, "\nw\u00f6rld\n");
    const snapped: Record<string, unknown> = data(
        graphCall(unicodeHost, "read", { contextId: unicodeContext, nodeId: "file:unicode.ts", offsetBytes: 2, maxBytes: 6 }),
    );
    assert.equal(snapped.offsetBytes, 3);
    assert.equal(snapped.text, "llo\nw");
    assert.equal(code(graphCall(unicodeHost, "read", { contextId: unicodeContext, nodeId: "file:unicode.ts", offsetBytes: 99 })), "invalid_arguments");
    const accentHost: WorkspaceAgentService = graphService();
    accentHost.registerFrame(frame("f.accent", ["file:accent.ts"], 8000), GraphRevision);
    const accentContext: string = data(graphCall(accentHost, "materialize", { frameId: "f.accent", budgetTokens: 8000 })).contextId as string;
    const accent: Record<string, unknown> = data(
        graphCall(accentHost, "read", { contextId: accentContext, nodeId: "file:accent.ts", offsetBytes: 0, maxBytes: 1 }),
    );
    assert.equal(accent.text, "\u00e9");
    assert.equal(accent.bytesRead, 2);
    assert.equal(accent.nextOffsetBytes, 2);
});

test("writes replace the node, a line range or a byte range and return both impact directions", (): void => {
    const written: Array<{ uri: string; content: string; previousRevision: string }> = [];
    const writer: WorkspaceWriter = {
        write: (request): { ok: true; revision: string; bytes: number } => {
            written.push({ uri: request.uri, content: request.content, previousRevision: request.previousRevision });
            return { ok: true, revision: `rev.${written.length}`, bytes: new TextEncoder().encode(request.content).length };
        },
    };
    const host: WorkspaceAgentService = graphService(writer);
    host.registerFrame(frame("f.graph", [GraphTarget], 8000), GraphRevision);
    const contextId: string = data(graphCall(host, "materialize", { frameId: "f.graph", budgetTokens: 8000 })).contextId as string;
    const before: Record<string, unknown> = data(graphCall(host, "read", { contextId, nodeId: GraphTarget, maxChars: 4000 }));
    const sourceRevision: string = (before.source as { revision: string }).revision;
    const whole: Record<string, unknown> = data(
        graphCall(host, "write", { contextId, nodeId: GraphTarget, content: "export const xxx = 2;\n", expectRevision: sourceRevision }),
    );
    assert.equal(whole.mode, "node");
    assert.equal(whole.dryRun, false);
    assert.equal(whole.previousRevision, sourceRevision);
    assert.equal(whole.revision, "rev.1");
    assert.equal(whole.path, "a.ts");
    assert.deepEqual(
        written.map((item): string => item.uri),
        ["a.ts"],
    );
    assert.equal(written[0].content, "export const xxx = 2;\n");
    assert.equal(written[0].previousRevision, sourceRevision);
    assert.deepEqual(linkPaths(whole.importation), ["c.ts"]);
    assert.deepEqual(linkPaths(whole.exportation), ["d.ts"]);
    const reread: Record<string, unknown> = data(graphCall(host, "read", { contextId, nodeId: GraphTarget, maxChars: 4000 }));
    assert.equal(reread.text, "export const xxx = 2;\n");
    assert.equal((reread.source as { revision: string }).revision, "rev.1");
    assert.equal(code(graphCall(host, "write", { contextId, nodeId: GraphTarget, content: "x", expectRevision: sourceRevision })), "fingerprint_mismatch");
    const line: Record<string, unknown> = data(
        graphCall(host, "write", { contextId, nodeId: GraphTarget, content: "export const xxx = 3;", startLine: 1, endLine: 1, expectRevision: "rev.1" }),
    );
    assert.equal(line.mode, "lines");
    assert.equal(line.revision, "rev.2");
    assert.equal(written[1].content, "export const xxx = 3;\n");
    const bytes: Record<string, unknown> = data(
        graphCall(host, "write", { contextId, nodeId: GraphTarget, content: "EXPORT", offsetBytes: 0, endBytes: 6, expectRevision: "rev.2" }),
    );
    assert.equal(bytes.mode, "bytes");
    assert.equal(bytes.revision, "rev.3");
    assert.equal(written[2].content, "EXPORT const xxx = 3;\n");
    const deleted: Record<string, unknown> = data(
        graphCall(host, "write", { contextId, nodeId: GraphTarget, content: "", startLine: 1, endLine: 1, expectRevision: "rev.3" }),
    );
    assert.equal(deleted.lines, 0);
    assert.equal(written[3].content, "");
    const dry: Record<string, unknown> = data(graphCall(host, "write", { contextId, nodeId: GraphTarget, content: "preview", dryRun: true }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.revision, null);
    assert.equal(written.length, 4);
    assert.equal(data(graphCall(host, "read", { contextId, nodeId: GraphTarget, maxChars: 4000 })).text, "");
});

test("writes are host-gated, file-only, allocation-bound and range-validated", (): void => {
    const plain: WorkspaceAgentService = graphService();
    plain.registerFrame(frame("f.plain", [GraphTarget], 8000), GraphRevision);
    const plainContext: string = data(graphCall(plain, "materialize", { frameId: "f.plain", budgetTokens: 8000 })).contextId as string;
    assert.equal(code(graphCall(plain, "write", { contextId: plainContext, nodeId: GraphTarget, content: "x" })), "write_unavailable");
    assert.equal(data(graphCall(plain, "write", { contextId: plainContext, nodeId: GraphTarget, content: "x", dryRun: true })).dryRun, true);
    const host: WorkspaceAgentService = graphService({ write: (): { ok: true; revision: string } => ({ ok: true, revision: "rev" }) });
    const symbol: string = graphSymbol("xxx");
    host.registerFrame(frame("f.symbol", [symbol], 8000), GraphRevision);
    const symbolContext: string = data(graphCall(host, "materialize", { frameId: "f.symbol", budgetTokens: 8000 })).contextId as string;
    assert.equal(code(graphCall(host, "write", { contextId: symbolContext, nodeId: symbol, content: "x" })), "invalid_arguments");
    host.registerFrame(frame("f.graph", [GraphTarget], 8000), GraphRevision);
    const contextId: string = data(graphCall(host, "materialize", { frameId: "f.graph", budgetTokens: 8000 })).contextId as string;
    assert.equal(code(graphCall(host, "write", { contextId, nodeId: "file:c.ts", content: "x" })), "not_available");
    const invalid: Record<string, unknown>[] = [
        { content: "x", startLine: 1, endLine: 1, offsetBytes: 0, endBytes: 1 },
        { content: "x", endLine: 2 },
        { content: "x", startLine: 2, endLine: 1 },
        { content: "x", startLine: 9, endLine: 9 },
        { content: "x", offsetBytes: 0, endBytes: 9999 },
        { content: "x", offsetBytes: 2, endBytes: 1 },
    ];
    for (let index: number = 0; index < invalid.length; index += 1) {
        assert.equal(
            code(graphCall(host, "write", { contextId, nodeId: GraphTarget, ...invalid[index] })),
            "invalid_arguments",
            JSON.stringify(invalid[index]),
        );
    }
    host.registerFrame(frame("f.unicode", ["file:unicode.ts"], 8000), GraphRevision);
    const unicodeContext: string = data(graphCall(host, "materialize", { frameId: "f.unicode", budgetTokens: 8000 })).contextId as string;
    assert.equal(
        code(graphCall(host, "write", { contextId: unicodeContext, nodeId: "file:unicode.ts", content: "x", offsetBytes: 2, endBytes: 3 })),
        "invalid_arguments",
    );
    assert.equal(
        data(graphCall(host, "write", { contextId: unicodeContext, nodeId: "file:unicode.ts", content: "H", offsetBytes: 0, endBytes: 1 })).mode,
        "bytes",
    );
});

test("discovery and graph/tree navigation reveal only the host scope without content bodies", (): void => {
    const host: WorkspaceAgentService = service();
    const discovered: Record<string, unknown> = data(host.call("amp_tool_workspace_capabilities", {}));
    assert.deepEqual(discovered.projectIds, ["project:app"]);
    assert.equal((discovered.tools as string[]).length, ToolCount);
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
    assert.equal(code(host.call("amp_tool_workspace_query", null)), "invalid_arguments");
    assert.equal(code(host.call("amp_tool_workspace_missing", {})), "unknown_tool");
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
    data(bounded.call("amp_tool_workspace_capabilities", {}));
    assert.equal(code(bounded.call("amp_tool_workspace_capabilities", {})), "budget_exhausted");
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
    assert.equal(registerWorkspaceTools(registry, host).length, ToolCount);
    const writeRisk: string[] = registry
        .list()
        .filter((tool): boolean => tool.risk === "write")
        .map((tool): string => tool.name);
    /**
     * `ToolRegistry` is backed by an unordered map, so only membership is
     * stable; sorting keeps this assertion independent of hash order.
     */
    assert.deepEqual(writeRisk.sort(), [ToolIds.workspaceWrite, ToolIds.workspaceProject, ToolIds.workspaceReactiveWrite, ToolIds.workspaceDiffWrite].sort());
    assert.throws(() => registerWorkspaceTools(registry, host));
    assert.equal(registry.size, ToolCount);
    const local: WorkspaceToolExecutor = new WorkspaceToolExecutor(host, {
        execute: async (): Promise<{ ok: boolean; content: string }> => ({ ok: true, content: "fallback" }),
    });
    assert.equal((await local.execute({ tool: "other", args: {} })).content, "fallback");
    const localResult: Awaited<ReturnType<WorkspaceToolExecutor["execute"]>> = await local.execute({ tool: "amp_tool_workspace_capabilities", args: {} });
    assert.equal(localResult.ok, true);
    const server: WorkspaceMcpServer = new WorkspaceMcpServer(host);
    const client: McpClient = new McpClient(new MemoryTransport((request): JsonRpcResponse => server.handle(request) as JsonRpcResponse));
    assert.equal((await client.negotiate()).mode, "stateless");
    const remoteRegistry: ToolRegistry = new ToolRegistry();
    await registerMcpTools(remoteRegistry, client);
    assert.equal(remoteRegistry.size, ToolCount);
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
        (await remote.execute({ tool: "amp_tool_workspace_read", args: { revision: Revision, contextId: view.contextId, nodeId: "file:private/secret.ts" } }))
            .ok,
        false,
    );
    assert.match(textOf(await client.callTool("amp_tool_workspace_capabilities", {})), /amp_protocol_workspace/);
});

test("MCP handshake, string IDs, notifications and malformed messages obey wire boundaries", (): void => {
    const host: WorkspaceAgentService = service({ maxToolCalls: 1 });
    const server: WorkspaceMcpServer = new WorkspaceMcpServer(host);
    assert.equal(server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })!.error!.code, -32002);
    assert.equal(server.handle({ jsonrpc: "2.0", id: "hello", method: "initialize", params: { protocolVersion: "2025-11-25" } })!.id, "hello");
    assert.equal(server.handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "amp_tool_workspace_capabilities", arguments: {} } }), (void 0));
    assert.equal(
        server.handle({ jsonrpc: "2.0", id: "cap", method: "tools/call", params: { name: "amp_tool_workspace_capabilities", arguments: {} } })!.error,
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
    const nullArgs: { content: Array<{ text: string }>; isError: boolean } = other.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "amp_tool_workspace_capabilities", arguments: null },
    })!.result as { content: Array<{ text: string }>; isError: boolean };
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
            assert.equal(request.tools!.length, ToolCount);
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
            const first: { ok: boolean; content: string } = JSON.parse(toolMessages[0].content) as { ok: boolean; content: string };
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
            const last: { content: string } = JSON.parse(toolMessages[1].content) as { content: string };
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
            const message: { ok: boolean; error: string } = JSON.parse(request.messages.at(-1)!.content) as { ok: boolean; error: string };
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
        toolExecutor: { execute: async (): Promise<{ ok: boolean; content: string }> => ({ ok: true, content: "x".repeat(5000) }) },
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
        const result: ReturnType<typeof spawnSync> = spawnSync(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", path], {
            input,
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 4 * 1024 * 1024,
        });
        assert.equal(result.status, 0, `${result.stderr}`);
        assert.equal(result.stderr, "");
        const replies: Array<{ id: number | string | null; error?: { code: number }; result?: Record<string, unknown> }> = `${result.stdout}`
            .trim()
            .split("\n")
            .map((line: string) => JSON.parse(line));
        assert.equal(replies.length, 6);
        assert.equal(replies[0].error!.code, -32700);
        assert.equal(replies[1].error!.code, -32600);
        assert.equal(replies[2].id, "init");
        assert.equal((replies[3].result!.tools as unknown[]).length, ToolCount);
        assert.equal(replies[4].result!.isError, false);
        assert.deepEqual(replies[5].result!.supportedVersions, [ProtocolVersion]);
        contents[Object.keys(contents)[0]] = "tampered";
        writeFileSync(path, JSON.stringify({ version: 1, agentId: "a.test", projectIds: [], snapshot: Snapshot, contents, frames: [] }));
        const corrupt: ReturnType<typeof spawnSync> = spawnSync(process.execPath, [resolve("tools/workspaceAgentServer.ts"), "--config", path], {
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

test("the global mirror dispatches capabilities, reactive and diff tools", (): void => {
    const global: GlobalAgentService = new GlobalAgentService({
        agentId: "a.test",
        projectIds: ["project:."],
        snapshot: GraphSnapshot,
        store: GraphStore,
        writer: { write: (): { ok: true; revision: string } => ({ ok: true, revision: "rev.global" }) },
        runner: { run: (): { ok: true; exitCode: number } => ({ ok: true, exitCode: 0 }) },
    });
    assert.equal(global.tools().length, ToolCount);
    const catalog = global.catalog() as unknown as { digest: string; entries: Array<{ id: string }> };
    catalog.digest = "tampered";
    const catalogEntries = catalog.entries as unknown as Array<{ id: string }>;
    catalogEntries[0].id = "tampered";
    assert.notEqual(global.catalog().digest, "tampered");
    assert.notEqual((global.catalog().entries as unknown as Array<{ id: string }>)[0].id, "tampered");
    const capabilities: GlobalResponse = global.call(ToolIds.globalCapabilities, {});
    assert.equal(capabilities.ok, true);
    const reactive: GlobalResponse = global.call(ToolIds.globalReactiveRead, { revision: GraphRevision, nodeId: GraphTarget, maxDepth: 2 });
    assert.equal(reactive.ok, true);
    const roots: Array<Record<string, unknown>> = (reactive as { ok: true; data: Record<string, unknown> }).data.roots as Array<Record<string, unknown>>;
    assert.equal(roots[0].id, GraphTarget);
    global.registerFrame(frame("f.global", [GraphTarget], 8000), GraphRevision);
    const view: GlobalResponse = global.call(ToolIds.globalMaterialize, { revision: GraphRevision, frameId: "f.global", budgetTokens: 8000 });
    assert.equal(view.ok, true);
    const contextId: string = (view as { ok: true; data: Record<string, unknown> }).data.contextId as string;
    const written: GlobalResponse = global.call(ToolIds.globalDiffWrite, {
        revision: GraphRevision,
        contextId,
        nodeId: GraphTarget,
        content: "export const xxx = 6;\n",
    });
    assert.equal(written.ok, true);
    const payload: Record<string, unknown> = (written as { ok: true; data: Record<string, unknown> }).data;
    assert.equal(payload.revision, "rev.global");
    assert.equal(payload.strategy, "whole");
    assert.equal(global.call(ToolIds.globalDiffRead, { revision: GraphRevision }).ok, true);
    assert.equal(global.call(ToolIds.globalProject, { revision: GraphRevision, projectId: "project:.", action: "build", dryRun: true }).ok, true);
});

test("legacy tool aliases still dispatch as their canonical workspace tool", (): void => {
    const host: WorkspaceAgentService = service();
    const legacy: Record<string, unknown> = data(host.call("amp_workspace_capabilities", {}));
    const canonical: Record<string, unknown> = data(host.call(ToolIds.workspaceCapabilities, {}));
    assert.deepEqual(legacy.tools, canonical.tools);
});

test("capabilities advertises exactly the canonical ids and no legacy names", (): void => {
    const host: WorkspaceAgentService = service();
    const discovered: Record<string, unknown> = data(host.call(ToolIds.workspaceCapabilities, {}));
    const listed: string[] = discovered.tools as string[];
    assert.equal(listed.length, ToolCount);
    assert.deepEqual(
        [...listed].sort(),
        Object.values(ToolIds)
            .filter((id: string): boolean => id.startsWith("amp_tool_workspace_"))
            .sort(),
    );
    for (let index: number = 0; index < deprecatedToolAliases.length; index += 1) {
        assert.equal(listed.includes(deprecatedToolAliases[index]), false, deprecatedToolAliases[index]);
    }
});

test("capabilities publishes deprecated aliases and a catalog summary digest", (): void => {
    const host: WorkspaceAgentService = service();
    const discovered: Record<string, unknown> = data(host.call(ToolIds.workspaceCapabilities, {}));
    const aliases: string[] = discovered.deprecatedAliases as string[];
    assert.equal(aliases.length, 7);
    assert.deepEqual(aliases, [...deprecatedToolAliases]);
    const summary: Record<string, unknown> = discovered.catalog as Record<string, unknown>;
    assert.match(summary.digest as string, /^sha256:/);
    assert.equal(summary.sortedBy, "id");
    assert.equal(summary.ttlMs, 0);
});

test("the service catalog is memoized and verifies against its own entries", (): void => {
    const host: WorkspaceAgentService = service();
    const first: ToolCatalog = host.catalog();
    const second: ToolCatalog = host.catalog();
    assert.equal(first.digest, second.digest);
    assert.equal(verifyCatalog(first, second.entries).ok, true);
    assert.equal(first.entries.length, ToolCount);
});

test("unregistered tool ids fail with unknown_tool", (): void => {
    const host: WorkspaceAgentService = service();
    assert.equal(code(host.call("amp_tool_workspace_missing", {})), "unknown_tool");
    assert.equal(code(host.call("nonsense", {})), "unknown_tool");
});

test("server discovery publishes the workspace service id and catalog summary", (): void => {
    const host: WorkspaceAgentService = service();
    const server: WorkspaceMcpServer = new WorkspaceMcpServer(host);
    const discovered: WorkspaceRpcResponse = server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": ProtocolVersion } },
    })!;
    assert.equal(discovered.error, (void 0));
    const result: Record<string, unknown> = discovered.result as Record<string, unknown>;
    assert.equal(result.serviceId, WorkspaceServiceId);
    assert.equal((result.serverInfo as Record<string, unknown>).serviceId, WorkspaceServiceId);
    assert.match((result.catalog as Record<string, unknown>).digest as string, /^sha256:/);
});
