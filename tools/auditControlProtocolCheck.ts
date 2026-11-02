#!/usr/bin/env node
/** 独立协议边界审计：只使用 stub ControlPort，不导入底层 control/service.ts。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import { GlobalAgentService } from "../src/global/service.ts";
import { SessionControlService } from "../src/control/sessionService.ts";
import { ControlError } from "../src/control/types.ts";
import type { ControlPort, ControlScope, ControlDomain } from "../src/control/types.ts";
import { controlToolDefinitions } from "../src/protocol/control.ts";
import { workspaceToolDefinitions } from "../src/protocol/workspace.ts";
import { globalToolDefinitions } from "../src/protocol/global.ts";
import { ToolAliases, resolveToolName, ToolIds } from "../src/naming/index.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import { registerWorkspaceTools, WorkspaceToolExecutor } from "../src/module/tool/workspaceExecutor.ts";
import { registerGlobalTools, GlobalToolExecutor } from "../src/module/tool/globalExecutor.ts";
import { registerSessionControlTools, SessionControlToolExecutor } from "../src/module/tool/controlExecutor.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import { ProtocolVersion } from "../src/module/mcp/protocol.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import type { WorkspaceToolDefinition } from "../src/protocol/workspace.ts";

const snapshot: WorkspaceSnapshot = { version: 1, revision: "audit.rev", entities: [], relations: [], diagnostics: [] };
const options = (control?: ControlPort, limits = {}) => ({ agentId: "audit.host", snapshot, projectIds: [], store: new MemoryContentStore(), control, limits });
const ws = (control?: ControlPort, limits = {}) => new WorkspaceAgentService(options(control, limits));
const gs = (control?: ControlPort, limits = {}) => new GlobalAgentService(options(control, limits));
const ss = (control?: ControlPort, limits = {}) => new SessionControlService({ control, limits });
const errorCode = (r: any) => r.error?.code;
const records: Array<{ scope: ControlScope; domain: ControlDomain; args: Record<string, unknown> }> = [];
const port: ControlPort = { call(scope, domain, args) { records.push({ scope, domain, args }); return { scope, domain, args }; } };
const names = {
    workspace: [ToolIds.workspaceAdjust, ToolIds.workspaceInteraction, ToolIds.workspaceScenario],
    global: [ToolIds.globalAdjust, ToolIds.globalInteraction, ToolIds.globalScenario],
    session: [ToolIds.sessionInteraction, ToolIds.sessionScenario],
};
const services = () => ({ workspace: ws(port), global: gs(port), session: ss(port) });
const input = (name: string): Record<string, unknown> => name.endsWith("adjust") ? { action: "list", registry: "skills" } : { action: "get" };
const evidence = (id: string, value: unknown) => console.log(`EVIDENCE ${id} ${JSON.stringify(value)}`);

// These tests assert actual observations; findings are explicitly marked and are not acceptance tests.
test("eight canonical descriptors, no alias, registry clone isolation, composed executor routing", async () => {
    const svc = services(); const registry = new ToolRegistry();
    registerWorkspaceTools(registry, svc.workspace); registerGlobalTools(registry, svc.global); registerSessionControlTools(registry, svc.session);
    const executor = new WorkspaceToolExecutor(svc.workspace, new GlobalToolExecutor(svc.global, new SessionControlToolExecutor(svc.session)));
    assert.equal(Object.values(names).flat().length, 8);
    for (const [scope, tools] of Object.entries(names)) for (const name of tools) {
        assert.equal(resolveToolName(name), name); assert.ok(registry.get(name));
        assert.equal([...ToolAliases.values()].includes(name), false);
        for (const alias of [name.replace("amp_tool_", "amp_"), name.replaceAll("_", "."), name.toUpperCase(), ` ${name}`, `${name} `]) {
            assert.equal(resolveToolName(alias), undefined);
            assert.equal((await executor.execute({ tool: alias, args: input(name) })).error, "unknown_tool");
        }
        const result = await executor.execute({ tool: name, args: input(name) });
        assert.equal(result.ok, true, result.content); assert.equal(records.at(-1)!.scope, scope);
        const count = records.length;
        registry.get(name)!.inputSchema = { type: "object" };
        const bad = await executor.execute({ tool: name, args: { ...input(name), scope: "global" } });
        assert.equal(bad.error, "invalid_arguments"); assert.equal(records.length, count);
    }
});

test("unknown keys, getters, symbols, arrays, non-JSON and identity injection are rejected before the port", () => {
    const svc = services(); let getterCalls = 0;
    const keyGetter = Object.defineProperty({}, "action", { enumerable: true, get() { getterCalls++; return "get"; } });
    const nestedGetter = Object.defineProperty({}, "x", { enumerable: true, get() { getterCalls++; return 1; } });
    const arrayGetter = Object.defineProperty([0], "0", { enumerable: true, get() { getterCalls++; return 1; } });
    const arraySymbol = Object.assign([1], { [Symbol("hidden")]: "x" });
    const arrayExtra = Object.assign([1], { extra: 1 });
    const cycle: any = {}; cycle.self = cycle;
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const [scope, tools] of Object.entries(names)) for (const name of tools) {
        const service = svc[scope as keyof typeof svc];
        const rawCases: unknown[] = [[], null, "{}", keyGetter, revoked.proxy,
            ...["scope", "sessionId", "agentId", "identity", "allowGlobal", "authorizedWorkspaceIds", "authenticate", "__proto__", "constructor", "prototype", "unknown"].map(k => ({ ...input(name), [k]: "spoofed" })),
            ...(scope === "global" ? [] : [{ ...input(name), workspaceId: "spoofed" }]),
            ...(scope === "session" ? [{ ...input(name), revision: snapshot.revision }, { ...input(name), applyTo: "all" }] : []),
            { ...input(name), [Symbol("x")]: 1 }];
        for (const raw of rawCases) {
            const count = records.length;
            assert.equal(errorCode(service.call(name, raw)), "invalid_arguments", `${name}`);
            assert.equal(records.length, count);
        }
        if (name.endsWith("adjust")) for (const value of [nestedGetter, { x: undefined }, { x: NaN }, { x: Infinity }, { x: 1n }, { x() {} }, { x: Symbol("x") }, { x: new Date() }, { x: new Map() }, { x: new Set() }, { x: [, 1] }, { x: arrayGetter }, { x: arraySymbol }, { x: arrayExtra }, cycle]) {
            const count = records.length;
            assert.equal(errorCode(service.call(name, { action: "register", registry: "skills", id: "x", value })), "invalid_arguments");
            assert.equal(records.length, count);
        }
    }
    assert.equal(getterCalls, 0);
});

test("all discriminants enforce required fields, mutation limits, enum and exclusive setting", () => {
    const svc = services();
    const adjustCases: Record<string, unknown>[] = [
        { action: "list" }, { action: "get", id: "x" }, { action: "register", id: "x", value: { constructor: { name: "data" }, nested: [null, false, 1, "x"] } },
        { action: "update", id: "x", value: {}, expectedVersion: 0 }, { action: "remove", id: "x", dryRun: true },
        { action: "default_get", key: "x" }, { action: "default_set", key: "x", value: [null, { a: 1 }] }, { action: "default_reset", key: "x" },
        { action: "link", id: "x", targetId: "y", relation: "depends" }, { action: "unlink", id: "x", targetId: "y", relation: "depends" },
    ];
    for (const scope of ["workspace", "global"] as const) {
        const name = names[scope][0];
        for (const args of adjustCases) assert.equal(svc[scope].call(name, { registry: "skills", ...args }).ok, true);
        for (const args of [{ action: "register", id: "x" }, { action: "get" }, { action: "link", id: "x", targetId: "y" }, { action: "list", dryRun: true }, { action: "default_set", key: "x" }, { action: "register", id: " ", value: {} }, { action: "register", id: "x", value: [] }, { action: "remove", id: "x", expectedVersion: -1 }, { action: "remove", id: "x", expectedVersion: 1.5 }, { action: "remove", id: "x", expectedVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
            assert.equal(errorCode(svc[scope].call(name, { registry: "skills", ...args })), "invalid_arguments");
        }
    }
    for (const [scope, tools] of Object.entries(names)) for (const name of tools.filter(n => !n.endsWith("adjust"))) {
        const service = svc[scope as keyof typeof svc]; const field = name.endsWith("interaction") ? "mode" : "scenario"; const mode = field === "mode" ? "think" : "research";
        for (const args of [{ action: "set", [field]: mode }, { action: "set", mix: { [mode]: 1 }, dryRun: true, expectedVersion: 0 }, { action: "reset" }]) assert.equal(service.call(name, args).ok, true);
        for (const args of [{ action: "get", [field]: mode }, { action: "set" }, { action: "set", [field]: mode, mix: { [mode]: 1 } }, { action: "set", [field]: "unknown" }, { action: "set", mix: {} }, { action: "set", mix: { unknown: 1 } }, { action: "set", mix: { [mode]: -1 } }, { action: "reset", [field]: mode }]) assert.equal(errorCode(service.call(name, args)), "invalid_arguments");
    }
});

test("fixed global scope and authorized target pass-through, workspace/session cannot choose identity", () => {
    const authorize: ControlPort = { call(scope, domain, args) { assert.equal(scope, "global"); if (args.workspaceId !== "allowed") throw new ControlError("permission_denied"); return { scope, domain, args }; } };
    const service = gs(authorize);
    assert.equal(service.call(ToolIds.globalInteraction, { action: "get", workspaceId: "allowed" }).ok, true);
    assert.equal(errorCode(service.call(ToolIds.globalInteraction, { action: "get", workspaceId: "other" })), "permission_denied");
    assert.equal(errorCode(service.call(ToolIds.workspaceInteraction, { action: "get" })), "unknown_tool");
    assert.equal(errorCode(ws(port).call(ToolIds.globalInteraction, { action: "get" })), "unknown_tool");
    assert.equal(errorCode(ss(port).call(ToolIds.globalInteraction, { action: "get" })), "unknown_tool");
});

test("revision budget, unavailable and sanitization on all eight tools, sync and async", async () => {
    for (const [scope, tools] of Object.entries(names)) for (const name of tools) {
        const make = scope === "workspace" ? ws : scope === "global" ? gs : ss;
        assert.equal(errorCode(make().call(name, input(name))), "control_unavailable");
        const limited = make(port, { maxToolCalls: 2 });
        assert.equal(errorCode(limited.call(name, { ...input(name), forged: true })), "invalid_arguments");
        assert.equal(limited.call(name, input(name)).ok, true);
        assert.equal(errorCode(limited.call(name, input(name))), "budget_exhausted");
        for (const code of ["invalid_arguments", "not_available", "permission_denied", "version_conflict", "control_unavailable"] as const) {
            assert.equal(errorCode(make({ call() { throw new ControlError(code); } }).call(name, input(name))), code);
        }
        for (const secret of [new Error("SECRET/path/token"), "SECRET", { message: "SECRET" }]) {
            const r = make({ call() { throw secret; } }).call(name, input(name));
            assert.equal(errorCode(r), "internal_error"); assert.equal(JSON.stringify(r).includes("SECRET"), false);
        }
        const large: ControlPort = { call() { return { x: "x".repeat(1000) }; } };
        assert.equal(errorCode(make(large, { maxResponseChars: 256 }).call(name, input(name))), "response_too_large");
        if (scope !== "session") {
            const service = make(port) as WorkspaceAgentService | GlobalAgentService;
            assert.equal(errorCode(service.call(name, { ...input(name), revision: "stale" })), "revision_mismatch");
            assert.equal(service.call(name, { ...input(name), revision: snapshot.revision }).ok, true);
            assert.equal(await service.callAsync(name, input(name)).then(r => r.ok), true);
            assert.equal(Object.hasOwn(records.at(-1)!.args, "revision"), false);
        }
    }
});

test("workspace MCP advertises canonical schemas; sync/async tools/call reject forged arguments without port effects", async () => {
    const service = ws(port); const server = new WorkspaceMcpServer(service);
    const meta = { "io.modelcontextprotocol/protocolVersion": ProtocolVersion };
    const listed: any = server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } });
    for (const descriptor of controlToolDefinitions("workspace")) {
        const tool = listed.result.tools.find((t: any) => t.name === descriptor.name);
        assert.deepEqual(tool.inputSchema, descriptor.inputSchema); assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, true);
        for (const asynchronous of [false, true]) {
            const count = records.length;
            const request = { jsonrpc: "2.0" as const, id: 2, method: "tools/call", params: { _meta: meta, name: descriptor.name, arguments: { ...input(descriptor.name), workspaceId: "forged" } } };
            const r: any = asynchronous ? await server.handleAsync(request) : server.handle(request);
            assert.equal(r.result.isError, true); assert.equal(errorCode(JSON.parse(r.result.content[0].text)), "invalid_arguments"); assert.equal(records.length, count);
        }
        const ok: any = server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: meta, name: descriptor.name, arguments: input(descriptor.name) } });
        assert.equal(ok.result.isError, false);
    }
    const count = records.length;
    assert.equal(server.handle({ jsonrpc: "2.0", method: "tools/call", params: { _meta: meta, name: ToolIds.workspaceInteraction, arguments: { action: "get" } } }), undefined);
    assert.equal(records.length, count);
    const alias: any = server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { _meta: meta, name: "amp_workspace_interaction", arguments: { action: "get" } } });
    assert.equal(alias.error.code, -32602);
});

test("F1 regression: public control descriptor cannot mutate live or future control schemas", () => {
    const service = ss(port); const raw = { action: "set", mode: "think", expectedVersion: -1 };
    const before = service.call(ToolIds.sessionInteraction, raw); assert.equal(errorCode(before), "invalid_arguments");
    const descriptor: any = controlToolDefinitions("session")[0];
    descriptor.inputSchema.oneOf[1].properties.expectedVersion.minimum = -10;
    const count = records.length;
    const after = service.call(ToolIds.sessionInteraction, raw);
    const workspaceResult = ws(port).call(ToolIds.workspaceInteraction, raw);
    const globalResult = gs(port).call(ToolIds.globalInteraction, raw);
    evidence("F1-fixed", { before: errorCode(before), after: errorCode(after), workspace: errorCode(workspaceResult), global: errorCode(globalResult) });
    assert.equal(errorCode(after), "invalid_arguments"); assert.equal(errorCode(workspaceResult), "invalid_arguments"); assert.equal(errorCode(globalResult), "invalid_arguments");
    assert.equal(records.length, count);
    const copied = workspaceToolDefinitions(); (copied[0].inputSchema as any).oneOf[0].properties.registry.enum.push("tamper-copy");
    assert.equal(JSON.stringify(workspaceToolDefinitions()).includes("tamper-copy"), false);
    assert.equal(JSON.stringify(globalToolDefinitions()).includes("tamper-copy"), false);
});

test("F2 regression: hidden toJSON cannot rewrite checked arguments", () => {
    const svc = services();
    for (const [scope, tools] of Object.entries(names)) {
        const name = tools.find(n => n.endsWith("interaction"))!; let invoked = 0;
        const raw = Object.defineProperty({ action: "get" }, "toJSON", { value() { invoked++; return { action: "set", mode: "think", scope: "global", sessionId: "forged", workspaceId: "forged" }; } });
        const count = records.length; const result = svc[scope as keyof typeof svc].call(name, raw);
        evidence("F2-fixed", { scope, invoked, error: errorCode(result), portUnchanged: records.length === count });
        assert.equal(errorCode(result), "invalid_arguments"); assert.equal(invoked, 0); assert.equal(records.length, count);
    }
});

test("F2 regression: hidden toJSON getter, executor and in-process MCP fail closed", async () => {
    let getterReads = 0;
    const raw = Object.defineProperty({ action: "get" }, "toJSON", { get() { getterReads++; return () => ({ action: "set", scenario: "research", sessionId: "forged" }); } });
    const count = records.length;
    const result = await new SessionControlToolExecutor(ss(port)).execute({ tool: ToolIds.sessionScenario, args: raw });
    assert.equal(result.error, "invalid_arguments"); assert.equal(getterReads, 0); assert.equal(records.length, count);
    evidence("F2-getter-executor-fixed", { getterReads, error: result.error, portUnchanged: records.length === count });
    const meta = { "io.modelcontextprotocol/protocolVersion": ProtocolVersion };
    const server = new WorkspaceMcpServer(ws(port));
    let invoked = 0;
    const args = Object.defineProperty({ action: "get" }, "toJSON", { value() { invoked++; return { action: "get", workspaceId: "forged" }; } });
    const request = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { _meta: meta, name: ToolIds.workspaceInteraction, arguments: args } };
    const inProcess: any = await server.handleAsync(request);
    assert.equal(inProcess.result.isError, true); assert.equal(errorCode(JSON.parse(inProcess.result.content[0].text)), "invalid_arguments");
    assert.equal(records.length, count); assert.equal(invoked, 0);
    const wire: any = await server.handleAsync(JSON.parse(JSON.stringify(request)));
    assert.equal(wire.result.isError, true); assert.equal(errorCode(JSON.parse(wire.result.content[0].text)), "invalid_arguments");
    assert.equal(records.length, count); assert.equal(invoked, 1);
    evidence("F2-MCP-fixed", { inProcess: errorCode(JSON.parse(inProcess.result.content[0].text)), wire: errorCode(JSON.parse(wire.result.content[0].text)), portUnchanged: records.length === count });
});

test("D1 host-only constructor override intentionally changes workspace schema but cannot change port scope", () => {
    const custom: WorkspaceToolDefinition[] = controlToolDefinitions("global");
    const service = new WorkspaceAgentService(options(port), custom);
    const r = service.call(ToolIds.workspaceInteraction, { action: "get", workspaceId: "host-selected" });
    assert.equal(r.ok, true); assert.equal(records.at(-1)!.scope, "workspace");
    assert.equal(records.at(-1)!.args.workspaceId, "host-selected");
    evidence("D1", { result: r, explanation: "requires host constructor override; ordinary tool arguments cannot install schemas" });
});

test("D2 regression: global port is captured at construction and scope stays global", () => {
    const hostOptions = options(port); const service = new GlobalAgentService(hostOptions); let rebound = 0;
    hostOptions.control = { call(scope) { rebound++; return { rebound, scope }; } };
    const count = records.length;
    const result = service.call(ToolIds.globalInteraction, { action: "get" });
    assert.equal(result.ok, true); assert.equal(rebound, 0); assert.equal(records.length, count + 1);
    assert.equal(records.at(-1)!.scope, "global");
    evidence("D2-fixed", { rebound, originalCalled: records.length === count + 1, scope: records.at(-1)!.scope });
});
