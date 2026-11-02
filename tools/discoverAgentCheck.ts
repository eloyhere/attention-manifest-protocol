#!/usr/bin/env node
/**
 * Agent-callable discovery: the `amp_tool_workspace_discover` tool must return
 * one structural tree, include project descriptions and host components, and
 * never expose a project outside the host's authorized `projectIds`.
 */
import assert from "node:assert/strict";

import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceEntity, WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import { GlobalAgentService } from "../src/global/service.ts";
import { HostCatalog } from "../src/discover/host.ts";
import { KnowledgeRegistry } from "../src/knowledge/registry.ts";
import { SkillRegistry } from "../src/skill/registry.ts";
import { ProtocolRegistry } from "../src/protocol/registry.ts";
import { ToolIds } from "../src/naming/index.ts";
import type { WorkspaceResponse } from "../src/protocol/workspace.ts";
import type { GlobalResponse } from "../src/protocol/global.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import type { DiscoverySearch, DiscoverySearchResult } from "../src/discover/types.ts";

let Passed: number = 0;
let Failed: number = 0;

let pending: Promise<void> = Promise.resolve();
const test = (name: string, fn: () => void | Promise<void>): void => {
    pending = pending.then(async (): Promise<void> => {
        try {
            await fn();
            Passed++;
            console.log(`\x1b[32m✓\x1b[0m ${name}`);
        } catch (err: unknown) {
            Failed++;
            console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${(err as Error).message}`);
        }
    });
};

const Store: MemoryContentStore = new MemoryContentStore();
const Guide: string = "# Guide\nCHOSEN BODY\n## Details\nbounded discovery snippet";
const GuideRef: string = Store.put(Guide);
const Revision: string = "rev.discover-agent";

const entity: (id: string, kind: WorkspaceEntity["kind"], projectId: string, label: string, uri: string, parentId?: string, detailRef?: string) => WorkspaceEntity = (
    id: string,
    kind: WorkspaceEntity["kind"],
    projectId: string,
    label: string,
    uri: string,
    parentId?: string,
    detailRef?: string,
): WorkspaceEntity => ({
    id,
    kind,
    projectId,
    ...(parentId === (void 0) ? {} : { parentId }),
    label,
    summary: kind === "project" ? "Application project workspace" : "",
    source: { uri, revision: Revision },
    ...(detailRef === (void 0) ? {} : { detailRef }),
});

const Snapshot: WorkspaceSnapshot = {
    version: 1,
    revision: Revision,
    entities: [
        entity("project:app", "project", "project:app", "App", "project:app"),
        entity("dir:src", "directory", "project:app", "src", "src/", "project:app"),
        entity("file:app.service.ts", "file", "project:app", "app.service.ts", "src/app.service.ts", "dir:src"),
        entity("file:guide.md", "file", "project:app", "guide.md", "src/guide.md", "dir:src", GuideRef),
        entity("project:private", "project", "project:private", "Private", "project:private"),
    ],
    relations: [],
    diagnostics: [],
};

const Skills: SkillRegistry = new SkillRegistry();
Skills.register({ id: "skill:lookup", name: "Look up knowledge", description: "Find protocol notes", instructions: "Private skill instructions", tags: ["protocol"] });
const Knowledge: KnowledgeRegistry = new KnowledgeRegistry();
Knowledge.register({ id: "knowledge:notes", title: "Protocol notes", summary: "Public metadata", content: "Private knowledge body", sourceUri: "docs/notes.md" });
const Protocols: ProtocolRegistry = new ProtocolRegistry();
Protocols.register({ id: "protocol:demo", name: "Demo protocol", version: "1.0", description: "Public protocol metadata", status: "deprecated", capabilities: ["discover"] });
Protocols.register({ id: "protocol:disabled", name: "Disabled protocol", version: "1.0", description: "Never exposed", status: "disabled" });

const Catalog: HostCatalog = new HostCatalog();
Catalog.addProject({
    id: "project:app",
    name: "App",
    description: "Application project",
    purpose: "Serve the demo app",
    summary: "A small authorized application project.",
});
Catalog.addProject({
    id: "project:private",
    name: "Private",
    description: "Should never be visible",
    purpose: "Hidden",
    summary: "Hidden",
});
Catalog.addPlugin({ id: "plugin:audit", name: "audit", description: "Audit plugin", purpose: "Record actions", status: "active" });
Catalog.addComponent({
    id: "service:private",
    kind: "service",
    name: "private",
    description: "Hidden service",
    purpose: "Hidden",
    projectId: "project:private",
});

const calls: Array<{ scope: { projectIds: readonly string[]; includeGlobal?: boolean }; queries: string | readonly string[]; options?: { revision?: string; limit?: number; kinds?: readonly string[]; tags?: readonly string[]; maxDepth?: number; nodeLimit?: number; }; }> = [];
const Search: DiscoverySearch = {
    async discover(scope, queries, options): Promise<DiscoverySearchResult> {
        calls.push({ scope, queries, options });
        const values: readonly string[] = typeof queries === "string" ? [queries] : queries;
        return {
            trees: values.flatMap((query) => ["file:guide.md", "file:app.service.ts"].map((id) => ({
                query,
                tree: { id, kind: "file", label: id === "file:guide.md" ? "guide.md" : "app.service.ts", projectId: "project:app", matched: true, children: [] },
                total: 2, totalRelation: "eq", took: 2, timedOut: false, truncated: false,
            }))),
        };
    },
};

const Service: WorkspaceAgentService = new WorkspaceAgentService({
    agentId: "a.discover",
    projectIds: ["project:app"],
    snapshot: Snapshot,
    store: Store,
    host: Catalog,
    search: Search,
    skills: Skills,
    knowledge: Knowledge,
    protocols: Protocols,
});

const data: (response: WorkspaceResponse | GlobalResponse) => Record<string, unknown> = (response: WorkspaceResponse | GlobalResponse): Record<string, unknown> => {
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) {
        throw new Error("expected success");
    }
    return response.data;
};

const findNode: (nodes: unknown[], label: string) => Record<string, unknown> | undefined = (nodes: unknown[], label: string): Record<string, unknown> | undefined => {
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: Record<string, unknown> = nodes[index] as Record<string, unknown>;
        if (node.label === label) {
            return node;
        }
        const nested: Record<string, unknown> | undefined = findNode((node.children as unknown[]) ?? [], label);
        if (nested !== (void 0)) {
            return nested;
        }
    }
    return undefined;
};

test("discover supports batches and returns one tree per matching root", async () => {
    const result: Record<string, unknown> = data(await Service.callAsync(ToolIds.workspaceDiscover, {
        revision: Revision, queries: ["guide", "service"], kinds: ["file"], tags: ["docs"], limit: 20, maxDepth: 3, nodeLimit: 12,
    }));
    const trees = result.trees as Array<Record<string, unknown>>;
    assert.equal(trees.length, 4);
    assert.deepEqual(trees.map((tree) => tree.query), ["guide", "guide", "service", "service"]);
    assert.deepEqual(calls.at(-1)?.scope, { projectIds: ["project:app"], includeGlobal: true });
    assert.equal((calls.at(-1)?.options as Record<string, unknown>).revision, Revision);
    assert.equal((calls.at(-1)?.options as Record<string, unknown>).nodeLimit, 12);
});

test("discover rejects missing queries and sync calls require async", async () => {
    const sync = Service.call(ToolIds.workspaceDiscover, { revision: Revision, queries: "guide" });
    assert.equal("error" in sync ? sync.error.code : undefined, "async_required");
    const invalid = await Service.callAsync(ToolIds.workspaceDiscover, { revision: Revision });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "invalid_arguments");
    const stale = Service.call(ToolIds.workspaceDiscover, { revision: "stale", queries: "guide" });
    assert.equal("error" in stale ? stale.error.code : undefined, "revision_mismatch");
});

test("global async discover forwards trees and scope", async () => {
    const global = new GlobalAgentService({ agentId: "a.global", projectIds: ["project:app"], snapshot: Snapshot, store: Store, search: Search });
    const response = await global.callAsync("amp_tool_global_discover", { revision: Revision, queries: "protocol" });
    const trees = data(response).trees as unknown[];
    assert.equal(trees.length, 2);
    assert.deepEqual(calls.at(-1)?.scope, { projectIds: ["project:app"], includeGlobal: true });
});

test("discover sanitizes search errors and enforces response size", async () => {
    const broken = new WorkspaceAgentService({ agentId: "a.broken", projectIds: ["project:app"], snapshot: Snapshot, store: Store, search: { async discover() { throw new Error("secret endpoint credential"); } } });
    const failed = await broken.callAsync(ToolIds.workspaceDiscover, { revision: Revision, queries: "guide" });
    assert.equal(failed.ok, false);
    assert.equal(JSON.stringify(failed).includes("credential"), false);
    const bounded = new WorkspaceAgentService({ agentId: "a.bounded", projectIds: ["project:app"], snapshot: Snapshot, store: Store, search: Search, limits: { maxResponseChars: 300 } });
    const boundedResponse = await bounded.callAsync(ToolIds.workspaceDiscover, { revision: Revision, queries: "guide" });
    assert.equal("error" in boundedResponse ? boundedResponse.error.code : undefined, "response_too_large");
    const unavailable = new WorkspaceAgentService({ agentId: "a.none", projectIds: ["project:app"], snapshot: Snapshot, store: Store });
    const unavailableResponse = await unavailable.callAsync(ToolIds.workspaceDiscover, { revision: Revision, queries: "guide" });
    assert.equal("error" in unavailableResponse ? unavailableResponse.error.code : undefined, "search_unavailable");
});

test("async discover shares call budget and MCP awaits the search response", async () => {
    const bounded = new WorkspaceAgentService({
        agentId: "a.calls", projectIds: ["project:app"], snapshot: Snapshot, store: Store, search: Search, limits: { maxToolCalls: 1 },
    });
    assert.equal((await bounded.callAsync(ToolIds.workspaceDiscover, { revision: Revision, queries: "guide" })).ok, true);
    const exhausted = await bounded.callAsync(ToolIds.workspaceDiscover, { revision: Revision, queries: "guide" });
    assert.equal("error" in exhausted ? exhausted.error.code : undefined, "budget_exhausted");

    const server = new WorkspaceMcpServer(Service);
    const response = await server.handleAsync({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
            name: ToolIds.workspaceDiscover,
            arguments: { revision: Revision, queries: "mcp" },
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
    });
    assert.equal(response?.error, undefined);
    const result = response?.result as Record<string, unknown>;
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result), /\\"trees\\"/);
});

test("discover schema requires one to eight bounded queries and no legacy filters", () => {
    const schema = JSON.stringify(Service.tools().find((tool) => tool.name === ToolIds.workspaceDiscover)?.inputSchema);
    assert.match(schema, /queries/);
    assert.match(schema, /maxItems/);
    assert.doesNotMatch(schema, /scope|category|pathPrefix|text/);
});

await pending;
console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
