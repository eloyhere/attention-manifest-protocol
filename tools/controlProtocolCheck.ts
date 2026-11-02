#!/usr/bin/env node
/** Execute the eight registered canonical controls through their real adapters. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import { GlobalAgentService } from "../src/global/service.ts";
import { SessionControlService } from "../src/control/sessionService.ts";
import { ControlError } from "../src/control/types.ts";
import type { ControlPort, ControlScope, ControlDomain } from "../src/control/types.ts";
import { controlToolDefinitions } from "../src/protocol/control.ts";
import { ToolAliases, resolveToolName, ToolIds } from "../src/naming/index.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import { WorkspaceToolExecutor, registerWorkspaceTools } from "../src/module/tool/workspaceExecutor.ts";
import { GlobalToolExecutor, registerGlobalTools } from "../src/module/tool/globalExecutor.ts";
import { SessionControlToolExecutor, registerSessionControlTools } from "../src/module/tool/controlExecutor.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import { ProtocolVersion } from "../src/module/mcp/protocol.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { WorkspaceServiceLimits } from "../src/context/workspaceService.ts";

const snapshot: WorkspaceSnapshot = { version: 1, revision: "r.control", entities: [], relations: [], diagnostics: [] };
const workspace = (control?: ControlPort, limits?: Partial<WorkspaceServiceLimits>) => new WorkspaceAgentService({ agentId: "agent.control", snapshot, projectIds: [], store: new MemoryContentStore(), control, limits });
const global = (control?: ControlPort, limits?: Partial<WorkspaceServiceLimits>) => new GlobalAgentService({ agentId: "agent.control", snapshot, store: new MemoryContentStore(), control, limits });
const code = (response: unknown): unknown => (response as { error?: { code: string; }; }).error?.code;
const calls: Array<{ scope: ControlScope; domain: ControlDomain; args: Record<string, unknown>; }> = [];
const port: ControlPort = { call(scope, domain, args) { calls.push({ scope, domain, args }); return { scope, domain, args, version: 1 }; } };
const cases = [
    [ToolIds.workspaceAdjust, "workspace", "adjust", { action: "list", registry: "skills" }],
    [ToolIds.globalAdjust, "global", "adjust", { action: "list", registry: "skills", workspaceId: "authorized" }],
    [ToolIds.workspaceInteraction, "workspace", "interaction", { action: "set", mode: "think" }],
    [ToolIds.globalInteraction, "global", "interaction", { action: "set", mix: { think: 1 }, applyTo: "all", workspaceId: "authorized" }],
    [ToolIds.sessionInteraction, "session", "interaction", { action: "set", mode: "think" }],
    [ToolIds.workspaceScenario, "workspace", "scenario", { action: "set", scenario: "engineering" }],
    [ToolIds.globalScenario, "global", "scenario", { action: "set", mix: { research: 1 }, applyTo: "existing" }],
    [ToolIds.sessionScenario, "session", "scenario", { action: "set", scenario: "engineering" }],
] as const;

test("all eight canonical tools register and execute with fixed host scope across a composed executor", async () => {
    const registry = new ToolRegistry();
    const ws = workspace(port), gs = global(port), ss = new SessionControlService({ control: port });
    registerWorkspaceTools(registry, ws); registerGlobalTools(registry, gs); registerSessionControlTools(registry, ss);
    const executor = new WorkspaceToolExecutor(ws, new GlobalToolExecutor(gs, new SessionControlToolExecutor(ss)));
    for (const [tool, scope, domain, args] of cases) {
        const descriptor = registry.get(tool);
        assert.ok(descriptor, tool); assert.equal(descriptor.risk, "write");
        assert.equal(resolveToolName(tool), tool);
        assert.equal([...ToolAliases.values()].includes(tool), false);
        assert.equal(resolveToolName(tool.replace("amp_tool_", "amp_")), undefined);
        const result = await executor.execute({ tool, args });
        assert.equal(result.ok, true, result.content);
        const actual = calls.at(-1)!;
        assert.equal(actual.scope, scope); assert.equal(actual.domain, domain);
        assert.deepEqual(actual.args, args);
        assert.equal(Object.hasOwn(actual.args, "scope"), false);
    }
});

test("all tools fail closed without a host control port", () => {
    const services = { workspace: workspace(), global: global(), session: new SessionControlService() };
    for (const [tool, scope, , args] of cases) assert.equal(code(services[scope].call(tool, args)), "control_unavailable", tool);
});

test("schemas reject forged identity, unsupported fields and action combinations before calling the host", () => {
    const services = { workspace: workspace(port), global: global(port), session: new SessionControlService({ control: port }) };
    for (const [tool, scope, , args] of cases) {
        for (const extra of [{ scope: "global" }, { sessionId: "other" }, { allowGlobal: true }, { authenticate: "host" }, { identity: {} }, ...(scope === "global" ? [] : [{ workspaceId: "other" }]), ...(scope === "session" ? [{ applyTo: "defaults" }] : [])]) {
            const count = calls.length;
            assert.equal(code(services[scope].call(tool, { ...args, ...extra })), "invalid_arguments", `${tool} ${JSON.stringify(extra)}`);
            assert.equal(calls.length, count);
        }
    }
    const ss = services.session;
    for (const args of [
        { action: "get", mode: "think" }, { action: "reset", mix: { think: 1 } }, { action: "set" },
        { action: "set", mode: "think", mix: { think: 1 } }, { action: "set", scenario: "engineering" },
        { action: "set", mix: { unknown: 1 } }, { action: "set", mix: { think: -1 } },
        { action: "set", mix: { think: Infinity } }, { action: "set", mix: {} },
        { action: "set", mode: "think", expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    ]) assert.equal(code(ss.call(ToolIds.sessionInteraction, args)), "invalid_arguments");
    for (const args of [
        { action: "register", registry: "skills", id: "a" },
        { action: "register", registry: "skills", id: "a", value: { execute() {} } },
        { action: "get", registry: "skills", id: "a", value: {} },
        { action: "list", registry: "unknown" },
        { action: "default_set", registry: "skills", key: "a" },
        { action: "link", registry: "skills", id: "a", targetId: "b" },
    ]) assert.equal(code(services.workspace.call(ToolIds.workspaceAdjust, args)), "invalid_arguments");
});

test("all adjust discriminants execute and preserve strict data metadata", () => {
    const ws = workspace(port);
    const base = { registry: "skills" };
    for (const args of [
        { action: "list" }, { action: "get", id: "a" },
        { action: "register", id: "a", value: { name: "A", metadata: { tags: ["data"], enabled: true } }, dryRun: true },
        { action: "update", id: "a", value: { description: "A" }, expectedVersion: 1 },
        { action: "remove", id: "a" }, { action: "default_get", key: "favorite" },
        { action: "default_set", key: "favorite", value: "a" }, { action: "default_reset", key: "favorite" },
        { action: "link", id: "a", targetId: "b", relation: "depends" },
        { action: "unlink", id: "a", targetId: "b", relation: "depends" },
    ]) assert.equal(ws.call(ToolIds.workspaceAdjust, { ...base, ...args }).ok, true, JSON.stringify(args));
});

test("control errors map exactly, other exceptions are redacted, global target authorization remains at the port", () => {
    for (const errorCode of ["invalid_arguments", "not_available", "permission_denied", "version_conflict", "control_unavailable"] as const) {
        const deny: ControlPort = { call() { throw new ControlError(errorCode); } };
        for (const response of [workspace(deny).call(ToolIds.workspaceInteraction, { action: "get" }), global(deny).call(ToolIds.globalInteraction, { action: "get" }), new SessionControlService({ control: deny }).call(ToolIds.sessionInteraction, { action: "get" })]) assert.equal(code(response), errorCode);
    }
    const secret: ControlPort = { call() { throw new Error("private path credential detail"); } };
    for (const response of [workspace(secret).call(ToolIds.workspaceInteraction, { action: "get" }), global(secret).call(ToolIds.globalInteraction, { action: "get" }), new SessionControlService({ control: secret }).call(ToolIds.sessionInteraction, { action: "get" })]) {
        assert.equal(code(response), "internal_error"); assert.equal(JSON.stringify(response).includes("private"), false);
    }
    const authorize: ControlPort = { call(scope, _domain, args) { assert.equal(scope, "global"); if (args.workspaceId !== "authorized") throw new ControlError("permission_denied"); return {}; } };
    assert.equal(code(global(authorize).call(ToolIds.globalInteraction, { action: "get", workspaceId: "other" })), "permission_denied");
    assert.equal(global(authorize).call(ToolIds.globalInteraction, { action: "get", workspaceId: "authorized" }).ok, true);
});

test("revision convention and call/response budgets remain enforced on control paths", () => {
    const ws = workspace(port, { maxToolCalls: 2 });
    assert.equal(ws.call(ToolIds.workspaceInteraction, { action: "get" }).ok, true);
    assert.equal(code(ws.call(ToolIds.workspaceInteraction, { action: "get", revision: "wrong" })), "revision_mismatch");
    assert.equal(code(ws.call(ToolIds.workspaceInteraction, { action: "get" })), "budget_exhausted");
    const gs = global(port, { maxToolCalls: 1 });
    assert.equal(gs.call(ToolIds.globalScenario, { action: "get", revision: snapshot.revision }).ok, true);
    assert.equal(code(gs.call(ToolIds.globalScenario, { action: "get" })), "budget_exhausted");
    const ss = new SessionControlService({ control: port, limits: { maxToolCalls: 1 } });
    assert.equal(code(ss.call(ToolIds.sessionScenario, { action: "get", workspaceId: "other" })), "invalid_arguments");
    assert.equal(code(ss.call(ToolIds.sessionScenario, { action: "get" })), "budget_exhausted");
    const large: ControlPort = { call() { return { text: "x".repeat(1000) }; } };
    for (const response of [workspace(large, { maxResponseChars: 256 }).call(ToolIds.workspaceScenario, { action: "get" }), global(large, { maxResponseChars: 256 }).call(ToolIds.globalScenario, { action: "get" }), new SessionControlService({ control: large, limits: { maxResponseChars: 256 } }).call(ToolIds.sessionScenario, { action: "get" })]) assert.equal(code(response), "response_too_large");
});

test("MCP workspace descriptors derive control schemas and write risk from service", () => {
    const server = new WorkspaceMcpServer(workspace(port));
    const response = server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": ProtocolVersion } } });
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean; destructiveHint: boolean; }; }>; }).tools;
    for (const tool of controlToolDefinitions("workspace")) {
        const actual = tools.find((item) => item.name === tool.name)!;
        assert.ok(actual); assert.deepEqual(actual.inputSchema, tool.inputSchema);
        assert.equal(actual.annotations.readOnlyHint, false); assert.equal(actual.annotations.destructiveHint, true);
    }
});
