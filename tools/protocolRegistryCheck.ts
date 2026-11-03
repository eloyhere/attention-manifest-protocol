/**
 * Protocols are registered in the protocol registry; MCP is one of them.
 *
 * MCP is a concrete wire protocol, so it belongs in the same read-write
 * registry as A2A and every other protocol a host speaks — not in a second,
 * MCP-only registry. This check drives the protocol registry's own CRUD, binds
 * an MCP implementation to an `mcp` entry, resolves it back through the type
 * guard, and mirrors the advertised tools into a tool registry. The MCP client
 * runs over the real in-process transport.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { McpClient } from "../src/module/mcp/client.ts";
import { isMcpProtocol, mcpListTools, mcpProtocolEntry, mcpSyncTools, mcpToolDescriptor, mcpToolRisk, mcpWithdrawTools } from "../src/module/mcp/binding.ts";
import type { McpProtocol } from "../src/module/mcp/binding.ts";
import { MemoryTransport } from "../src/module/mcp/transport.ts";
import { ProtocolRegistry } from "../src/protocol/registry.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import type { JsonRpcRequest, JsonRpcResponse, McpTool } from "../src/module/mcp/protocol.ts";

/**
 * An in-process MCP server whose advertised tools the test controls.
 */
const mcpServer = (tools: () => McpTool[], version = "2026-07-28") => {
    const transport = new MemoryTransport((request: JsonRpcRequest): JsonRpcResponse => {
        const id = request.id ?? 0;
        const meta = request.params?._meta as Record<string, unknown> | undefined;
        if (meta === (void 0) || typeof(meta["io.modelcontextprotocol/protocolVersion"]) !== "string") {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "missing protocol version" } };
        }
        if (request.method === "server/discover") {
            return { jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: [version], capabilities: { tools: {} }, ttlMs: 1000, cacheScope: "public" } };
        }
        if (request.method === "tools/list") {
            return { jsonrpc: "2.0", id, result: { resultType: "complete", tools: tools(), ttlMs: 1000, cacheScope: "public" } };
        }
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
    });
    return { transport, client: new McpClient(transport, "audit") };
};

const readTool: McpTool = { name: "logs.query", description: "query logs", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
const writeTool: McpTool = { name: "deploy.rollback", description: "roll back", inputSchema: { type: "object" }, annotations: { destructiveHint: true } };

test("the protocol registry itself is read-write and lists protocols by family", (): void => {
    const protocols: ProtocolRegistry = new ProtocolRegistry();
    protocols.register({ id: "a2a", name: "A2A", version: "1.0", description: "agent to agent", family: "a2a" });
    protocols.register(mcpProtocolEntry("mcp.local", "Local MCP", { endpoint: "stdio" }));
    assert.deepEqual(protocols.list().map((entry) => entry.id).sort(), ["a2a", "mcp.local"]);
    protocols.update({ ...protocols.get("a2a")!, status: "deprecated" });
    assert.equal(protocols.get("a2a")?.status, "deprecated");
    assert.equal(protocols.list().filter((entry) => entry.family === "mcp").length, 1);
    assert.throws(() => protocols.register({ id: "mcp.local", name: "Dup", version: "1", description: "d" }), /already registered/);
    assert.throws(() => protocols.update({ id: "ghost", name: "G", version: "1", description: "d" }), /not registered/);
    assert.equal(protocols.remove("a2a"), true);
    assert.equal(protocols.remove("a2a"), false);
});

test("an MCP endpoint is registered as a protocol entry with its version and capabilities", (): void => {
    const entry = mcpProtocolEntry("mcp.remote", "Remote MCP", { endpoint: "https://example.test/mcp", capabilities: ["tools", "resources"] });
    assert.equal(entry.family, "mcp");
    assert.equal(entry.version, "2026-07-28");
    assert.deepEqual(entry.capabilities, ["tools", "resources"]);
    assert.equal(entry.endpoint, "https://example.test/mcp");
    assert.equal(mcpProtocolEntry("x", "X", { version: "2025-06-18" }).version, "2025-06-18");
});

test("binding an implementation keeps discovery metadata separate and resolves by family", (): void => {
    const protocols: ProtocolRegistry = new ProtocolRegistry();
    const { transport, client } = mcpServer(() => [readTool]);
    protocols.register(mcpProtocolEntry("mcp.one", "One"));
    const implementation: McpProtocol = { family: "mcp", client, transport, tools: ["logs.query"] };
    protocols.bind("mcp.one", implementation);
    assert.equal(protocols.implementation("mcp.one"), implementation);
    assert.deepEqual(protocols.bound(), ["mcp.one"]);
    // Discovery output carries no implementation.
    assert.equal("client" in protocols.get("mcp.one")!, false);
    // A family mismatch or a foreign object does not resolve.
    assert.equal(protocols.resolveImplementation("mcp.one", isMcpProtocol, "a2a"), (void 0));
    protocols.bind("mcp.one", { not: "mcp" });
    assert.equal(protocols.resolveImplementation("mcp.one", isMcpProtocol, "mcp"), (void 0));
    protocols.bind("mcp.one", implementation);
    assert.equal(protocols.resolveImplementation("mcp.one", isMcpProtocol, "mcp")?.client, client);
    assert.throws(() => protocols.bind("ghost", implementation), /not registered/);
});

test("removing a protocol drops its implementation with it", (): void => {
    const protocols: ProtocolRegistry = new ProtocolRegistry();
    const { transport, client } = mcpServer(() => [readTool]);
    protocols.register(mcpProtocolEntry("mcp.one", "One"));
    protocols.bind("mcp.one", { family: "mcp", client, transport });
    assert.equal(protocols.remove("mcp.one"), true);
    assert.equal(protocols.implementation("mcp.one"), (void 0));
    assert.deepEqual(protocols.bound(), []);
    protocols.register(mcpProtocolEntry("mcp.two", "Two"));
    protocols.bind("mcp.two", { family: "mcp", client, transport });
    assert.equal(protocols.clear(), 1);
    assert.deepEqual(protocols.bound(), []);
});

test("an MCP protocol lists its tools and mirrors them into the tool registry", async (): Promise<void> => {
    let advertised: McpTool[] = [readTool];
    const { transport, client } = mcpServer(() => advertised);
    const protocols: ProtocolRegistry = new ProtocolRegistry();
    const tools: ToolRegistry = new ToolRegistry();
    protocols.register(mcpProtocolEntry("mcp.one", "One"));
    const protocol: McpProtocol = { family: "mcp", client, transport, tools: [] };
    protocols.bind("mcp.one", protocol);

    assert.deepEqual((await mcpListTools(protocol)).map((tool) => tool.name), ["logs.query"]);
    const first = await mcpSyncTools(protocol, tools);
    assert.deepEqual(first.added.map((descriptor) => descriptor.name), ["logs.query"]);
    assert.equal(tools.get("logs.query")?.risk, "read");

    advertised = [{ ...readTool, description: "query logs v2" }, writeTool];
    const second = await mcpSyncTools({ ...protocol, tools: ["logs.query"] }, tools);
    assert.deepEqual(second.added.map((descriptor) => descriptor.name), ["deploy.rollback"]);
    assert.deepEqual(second.updated.map((descriptor) => descriptor.name), ["logs.query"]);
    assert.equal(tools.get("deploy.rollback")?.risk, "destructive");

    advertised = [readTool];
    const third = await mcpSyncTools({ ...protocol, tools: ["logs.query", "deploy.rollback"] }, tools);
    assert.deepEqual(third.removed, ["deploy.rollback"]);
    assert.equal(tools.get("deploy.rollback"), (void 0));
});

test("withdrawing one endpoint's tools leaves host tools and other protocols alone", async (): Promise<void> => {
    const { transport, client } = mcpServer(() => [readTool]);
    const tools: ToolRegistry = new ToolRegistry();
    tools.register({ name: "host.local", description: "host tool", inputSchema: {} });
    const protocol: McpProtocol = { family: "mcp", client, transport, tools: ["logs.query"] };
    await mcpSyncTools(protocol, tools);
    assert.deepEqual(mcpWithdrawTools(protocol, tools), ["logs.query"]);
    assert.deepEqual(mcpWithdrawTools(protocol, tools), []);
    assert.ok(tools.get("host.local"));
});

test("risk and descriptors derive only from annotations", (): void => {
    assert.equal(mcpToolRisk({ name: "a", inputSchema: {} }), "write");
    assert.equal(mcpToolRisk({ name: "b", inputSchema: {}, annotations: { readOnlyHint: true } }), "read");
    assert.equal(mcpToolRisk({ name: "c", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: true } }), "destructive");
    const descriptor = mcpToolDescriptor({ name: "d", title: "D title", inputSchema: { type: "object" } });
    assert.equal(descriptor.description, "D title");
    assert.equal(descriptor.risk, "write");
});

test("a registered MCP protocol still enforces the stateless protocol version", async (): Promise<void> => {
    const { transport, client } = mcpServer(() => [readTool]);
    const protocols: ProtocolRegistry = new ProtocolRegistry();
    protocols.register(mcpProtocolEntry("mcp.one", "One"));
    protocols.bind("mcp.one", { family: "mcp", client, transport } satisfies McpProtocol);
    const resolved = protocols.resolveImplementation("mcp.one", isMcpProtocol, "mcp");
    assert.ok(resolved);
    const raw = await transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} } as JsonRpcRequest);
    assert.equal((raw.error as { code: number }).code, -32602);
    assert.deepEqual((await mcpListTools(resolved)).map((tool) => tool.name), ["logs.query"]);
});
