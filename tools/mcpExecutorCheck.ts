#!/usr/bin/env node
/**
 * MCP ToolExecutor adapter check: MCP client -> ToolExecutor.
 */
import assert from "node:assert/strict";

import { McpClient } from "../src/module/mcp/client.ts";
import { DemoServer } from "../src/module/mcp/server.ts";
import { MemoryTransport } from "../src/module/mcp/transport.ts";
import { McpToolExecutor, registerMcpTools } from "../src/module/tool/mcpExecutor.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";

const server = new DemoServer();
const transport = new MemoryTransport((request) => server.handle(request));
const client = new McpClient(transport, "test");
const executor = new McpToolExecutor(client);
const registry = new ToolRegistry();
const descriptors = await registerMcpTools(registry, client);
assert.equal(descriptors.length, 3);
assert.equal(registry.get("logs.query")?.risk, "read");
assert.equal(registry.get("deploy.rollback")?.risk, "destructive");

const result = await executor.execute({ tool: "metrics.query", args: { metric: "5xx_rate" } });
assert.equal(result.ok, true);
assert.equal(result.content.includes("5xx_rate"), true);
assert.equal(server.calls, 1);

const unknown = await executor.execute({ tool: "missing.tool", args: {} });
assert.equal(unknown.ok, false);
assert.equal(typeof(unknown.error), "string");

console.log("\x1b[32m✓\x1b[0m MCP tool execution maps to ToolResult");
console.log("\n2 passed, 0 failed");
