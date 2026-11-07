import assert from "node:assert/strict";
import test from "node:test";
import { AgentGateway, GatewayError } from "./gateway.ts";
import { DISCOVER_TOOL_NAME, SURFACE_PREFIX, createAgentSurface } from "./surface.ts";
import { InMemoryFileStorage } from "../file/core.ts";
import { Workspace } from "../workspace/core.ts";
import type { GatewayCallRecord } from "./gateway.ts";
import type { DiscoveryBranch, DiscoveryLeaf, DiscoveryResult } from "./discovery.ts";
import type { FileDiff } from "../file/types.ts";

const binding = { tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 } as const;
const readName = `${SURFACE_PREFIX}_workspace.read`;
const writeName = `${SURFACE_PREFIX}_workspace.write`;
const diffName = `${SURFACE_PREFIX}_workspace.diff`;
const budgetName = `${SURFACE_PREFIX}_budget.remaining`;

function setup(options: Record<string, unknown> = {}) {
    const calls: GatewayCallRecord[] = [];
    const gateway = new AgentGateway({
        handlers: {
            [readName]: (_parameters, context) => `${context.tool.verb}:content`,
            [writeName]: parameters => ({ written: parameters.expectedHash }),
            [budgetName]: () => 42,
        },
        onCall: record => calls.push(record),
        ...options,
    });
    return { gateway, calls };
}

function failure(code: GatewayError["code"]) {
    return (error: unknown): boolean => error instanceof GatewayError && error.code === code;
}

test("a read tool dispatches with the bound context and journals once", () => {
    const { gateway, calls } = setup();
    const result = gateway.call(readName, { path: "src/a.ts" }, { binding });
    assert.equal(result, "read:content");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, readName);
    assert.equal(calls[0]?.mutating, false);
    assert.equal(calls[0]?.ok, true);
    assert.equal(typeof calls[0]?.durationMs, "number");
    assert.equal(Object.isFrozen(calls[0]), true);
});

test("a workspace.diff handler returns structured hunks and journals once", () => {
    const storage = new InMemoryFileStorage();
    storage.put({ tenantId: "t", rootId: "r", path: "notes.md" }, "alpha\nbeta\ngamma\n");
    const file = new Workspace({ tenantId: "t", rootId: "r", storage }).mount("notes.md", { mode: "writable", owner: "agent" });
    file.write("alpha\nBETA\ngamma\n");
    const calls: GatewayCallRecord[] = [];
    const verbs: string[] = [];
    const gateway = new AgentGateway({
        handlers: { [diffName]: (_parameters, context) => { verbs.push(context.tool.verb); return file.diffStructured(); } },
        onCall: record => calls.push(record),
    });
    const result = gateway.call(diffName, {}, { binding }) as FileDiff;
    assert.equal(result.base, "disk");
    assert.equal(result.baseHash, file.snapshot().baseHash);
    assert.equal(result.bufferVersion, 1);
    assert.deepEqual(result.hunks, [{ startLine: 1, endLine: 2, removed: 1, added: 1 }]);
    assert.deepEqual(result.summary, { added: 1, removed: 1, changed: 1 });
    assert.equal(result.truncated, false);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(verbs, ["diff"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, diffName);
    assert.equal(calls[0]?.mutating, false);
    assert.equal(calls[0]?.ok, true);
});

test("unknown and filtered tools are rejected", () => {
    const { gateway } = setup();
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workflow.transition`, {}, { binding }), failure("unknown_tool"));

    const restricted = setup({ surface: createAgentSurface({ only: ["workspace"] }) }).gateway;
    assert.throws(() => restricted.call(budgetName, {}, { binding }), failure("not_exposed"));
});

test("model arguments cannot carry host context", () => {
    const { gateway, calls } = setup();
    assert.throws(() => gateway.call(readName, { tenantId: "evil" }, { binding }), failure("invalid_parameters"));
    assert.throws(() => gateway.call(readName, { nested: { fence: 3 } }, { binding }), failure("invalid_parameters"));
    assert.equal(calls.at(-1)?.ok, false);
    assert.equal(calls.at(-1)?.error, "invalid_parameters");
});

test("mutating tools require an idempotency key", () => {
    const { gateway, calls } = setup();
    assert.throws(() => gateway.call(writeName, { expectedHash: "h" }, { binding }), failure("mutating_requires_idempotency_key"));
    const result = gateway.call(writeName, { expectedHash: "h" }, { binding, idempotencyKey: "op-1" });
    assert.deepEqual(result, { written: "h" });
    assert.equal(calls.at(-1)?.idempotencyKey, "op-1");
    assert.equal(calls.at(-1)?.mutating, true);
});

test("the host authorization hook can deny authorities", () => {
    const deny = setup({ authorize: () => false }).gateway;
    assert.throws(() => deny.call(readName, {}, { binding }), failure("unauthorized"));

    const seen: string[][] = [];
    const allow = setup({ authorize: (authority: readonly string[]) => { seen.push([...authority]); return true; } }).gateway;
    assert.equal(allow.call(readName, {}, { binding }), "read:content");
    assert.deepEqual(seen, [["workspace:read"]]);
});

test("missing handlers and handler exceptions map to typed gateway errors", () => {
    const { gateway, calls } = setup({ handlers: { [readName]: () => { throw new Error("boom"); } } });
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workspace.outline`, {}, { binding }), failure("handler_missing"));
    assert.throws(() => gateway.call(readName, {}, { binding }), failure("handler_failed"));
    assert.equal(calls.at(-1)?.error, "handler_failed");
});

test("an invalid binding never reaches a handler", () => {
    const { gateway, calls } = setup();
    assert.throws(() => gateway.call(readName, {}, { binding: { ...binding, sessionId: "" } }), failure("binding_invalid"));
    assert.throws(() => gateway.call(readName, {}, { binding: { ...binding, cancellationEpoch: -1 } }), failure("binding_invalid"));
    assert.equal(calls.length, 2);
    assert.equal(calls.every(record => record.error === "binding_invalid"), true);
});

test("the gateway exposes exactly the surface tools", () => {
    const { gateway } = setup();
    assert.ok(gateway.tools.length > 30);
    assert.equal(gateway.tools.every(tool => tool.name.startsWith(`${SURFACE_PREFIX}_`)), true);
});

const discoveryProvider = {
    source: "session_files" as const,
    search: () => [{
        id: "file-1", source: "session_files" as const, kind: "content" as const, module: "src/a.ts",
        scope: { tenantId: "t", principalId: "p", sessionId: "s" },
        name: "src/a.ts:1", summary: "export function read()", searchText: "export function read()",
        target: { kind: "content", path: "src/a.ts", startLine: "1" },
    }],
};

test("discovery bootstraps one tool and journals its asynchronous result", async () => {
    const calls: GatewayCallRecord[] = [];
    const gateway = new AgentGateway({
        handlers: { [readName]: () => "content" },
        authorize: () => true,
        onCall: record => calls.push(record),
        discovery: { providers: [discoveryProvider] },
    });
    assert.deepEqual(gateway.tools.map(tool => tool.name), [DISCOVER_TOOL_NAME]);
    assert.ok(gateway.catalog.length > 30);
    const result = await gateway.call(DISCOVER_TOOL_NAME, { query: "read", sources: ["amp", "session_files"] }, { binding }) as DiscoveryResult;
    assert.ok(result.returned >= 2);
    assert.equal(result.unavailableSources.length, 0);
    assert.equal(result.tree.children.every(branch => branch.kind === "source"), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, DISCOVER_TOOL_NAME);
    assert.equal(calls[0]?.ok, true);
});

test("discovery requires authorization for each requested source", async () => {
    const gateway = new AgentGateway({
        handlers: {},
        authorize: authority => !authority.includes("discovery:network"),
        discovery: { providers: [discoveryProvider] },
    });
    await assert.rejects(gateway.call(DISCOVER_TOOL_NAME, { query: "read", sources: ["network"] }, { binding }) as Promise<unknown>,
        failure("unauthorized"));
    await assert.rejects(gateway.call(DISCOVER_TOOL_NAME, { query: "read", sources: [] }, { binding }) as Promise<unknown>,
        failure("invalid_parameters"));
});

test("a failing provider is reported as unavailable without hiding local matches", async () => {
    const gateway = new AgentGateway({
        handlers: {},
        authorize: () => true,
        discovery: { providers: [
            discoveryProvider,
            { source: "conversation", search: () => { throw new Error("index down"); } },
        ] },
    });
    const result = await gateway.call(DISCOVER_TOOL_NAME, { query: "read", sources: ["session_files", "conversation"] }, { binding }) as DiscoveryResult;
    assert.ok(result.returned >= 1);
    assert.deepEqual([...result.unavailableSources], ["conversation"]);
});

test("discovery configuration is validated at construction", () => {
    assert.throws(() => new AgentGateway({ handlers: {}, discovery: {} }), /authorize/);
    assert.throws(() => new AgentGateway({ handlers: {}, authorize: () => true, discovery: { providers: [discoveryProvider, discoveryProvider] } }),
        /duplicate discovery provider/);
    assert.throws(() => new AgentGateway({ handlers: {}, authorize: () => true, discovery: { providers: [{
        source: "amp" as never, search: () => [],
    }] } }), /invalid discovery provider/);
});

test("discover is unavailable when the gateway is not configured for discovery", () => {
    const { gateway } = setup();
    assert.throws(() => gateway.call(DISCOVER_TOOL_NAME, { query: "read" }, { binding }), failure("not_exposed"));
});

function leafIds(nodes: readonly (DiscoveryBranch | DiscoveryLeaf)[]): string[] {
    return nodes.flatMap(node => "children" in node ? leafIds(node.children) : [node.id]);
}

test("discovery filters amp candidates by surface, handler and host authorization", async () => {
    const gateway = new AgentGateway({
        handlers: { [readName]: () => "content" },
        surface: createAgentSurface({ only: ["workspace"] }),
        authorize: authority => !authority.includes("workspace:write"),
        discovery: {},
    });
    const result = await gateway.call(DISCOVER_TOOL_NAME, { query: "workspace read write" }, { binding }) as DiscoveryResult;
    assert.deepEqual(leafIds(result.tree.children), [readName]);
    assert.equal(result.considered, 1);
    assert.equal(result.returned, 1);
    assert.equal(result.authorization, "not_granted");
});

test("discovery uses module summaries and host keywords for local intent", async () => {
    const environmentName = `${SURFACE_PREFIX}_project.environment`;
    const gateway = new AgentGateway({
        handlers: { [readName]: () => "content", [writeName]: () => "ok", [environmentName]: () => ({}) },
        authorize: () => true,
        discovery: { keywords: tool => tool.module === "project" ? ["环境", "配置"] : [] },
    });
    const file = await gateway.call(DISCOVER_TOOL_NAME, { query: "file" }, { binding }) as DiscoveryResult;
    const fileIds = leafIds(file.tree.children);
    assert.ok(fileIds.includes(readName));
    assert.ok(fileIds.includes(writeName));

    const edit = await gateway.call(DISCOVER_TOOL_NAME, { query: "edit file" }, { binding }) as DiscoveryResult;
    assert.equal(leafIds(edit.tree.children)[0], writeName);

    const environment = await gateway.call(DISCOVER_TOOL_NAME, { query: "环境" }, { binding }) as DiscoveryResult;
    assert.deepEqual(leafIds(environment.tree.children), [environmentName]);
});

test("discover returns an empty tree without granting authorization", async () => {
    const gateway = new AgentGateway({ handlers: {}, authorize: () => true, discovery: {} });
    const result = await gateway.call(DISCOVER_TOOL_NAME, { query: "nonexistent" }, { binding }) as DiscoveryResult;
    assert.deepEqual(result.tree.children, []);
    assert.equal(result.considered, 0);
    assert.equal(result.returned, 0);
    assert.equal(result.authorization, "not_granted");
});
