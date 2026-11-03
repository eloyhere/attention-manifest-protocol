/**
 * MCP as one concrete protocol registered in the protocol registry.
 *
 * MCP is a specific wire protocol, not an extension of the tool registry: it
 * has its own version, its own capability set and its own transport. Rather
 * than a second registry, an MCP endpoint is an ordinary `ProtocolEntry`
 * (`family: "mcp"`) whose bound implementation is an `McpProtocol`. That keeps
 * "which protocols does this host speak" in one place, next to A2A, the
 * workspace protocol and anything else a host registers.
 *
 * The implementation owns the client the host already built. Nothing here turns
 * a URL string into a connection, so registering cannot widen what the agent
 * can reach.
 */
import type { McpClient } from "./client.ts";
import type { McpTool } from "./protocol.ts";
import { ProtocolVersion } from "./protocol.ts";
import type { Transport } from "./transport.ts";
import type { ProtocolEntry } from "../../protocol/registry.ts";
import type { ToolDescriptor, ToolRegistry } from "../tool/tool.ts";

/** Family tag every MCP entry carries. */
export const McpProtocolFamily: string = "mcp";

/**
 * Implementation bound to an `mcp` protocol entry.
 */
export interface McpProtocol {
    readonly family: typeof McpProtocolFamily;
    /** Client used for `listTools`/`callTool`. */
    readonly client: McpClient;
    /** Optional transport, kept so a host can inspect or close it. */
    readonly transport?: Transport;
    /** Tools last read from this endpoint, in advertised order. */
    readonly tools?: readonly string[];
}

/**
 * Type guard for `resolveImplementation`.
 */
export const isMcpProtocol: (value: unknown) => value is McpProtocol = (value: unknown): value is McpProtocol =>
    typeof(value) === "object" && value !== null && (value as { family?: unknown }).family === McpProtocolFamily
    && typeof((value as { client?: unknown }).client) === "object" && (value as { client?: unknown }).client !== null;

/**
 * Risk tier for one MCP tool, derived only from its declared annotations.
 * An unannotated tool is `write`: the safest assumption is that it may act.
 */
export const mcpToolRisk: (tool: McpTool) => ToolDescriptor["risk"] = (tool: McpTool): ToolDescriptor["risk"] => {
    if (tool.annotations?.destructiveHint === true) {
        return "destructive";
    }
    return tool.annotations?.readOnlyHint === true ? "read" : "write";
};

/**
 * Convert one advertised MCP tool into a tool descriptor. The executable name
 * is the bare MCP name, so a server cannot rename it into another namespace.
 */
export const mcpToolDescriptor: (tool: McpTool) => ToolDescriptor = (tool: McpTool): ToolDescriptor => ({
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    inputSchema: structuredClone(tool.inputSchema),
    risk: mcpToolRisk(tool),
});

/**
 * Protocol entry for one MCP endpoint.
 *
 * @param id - Host-chosen protocol id, unique in the protocol registry.
 * @param name - Human label.
 * @param options - Optional endpoint, version override, description and status.
 * @returns A validated `family: "mcp"` entry carrying the MCP capabilities.
 */
export const mcpProtocolEntry: (id: string, name: string, options?: { endpoint?: string; version?: string; description?: string; status?: ProtocolEntry["status"]; capabilities?: readonly string[]; }) => ProtocolEntry = (
    id: string, name: string,
    options: { endpoint?: string; version?: string; description?: string; status?: ProtocolEntry["status"]; capabilities?: readonly string[]; } = {},
): ProtocolEntry => ({
    id,
    name,
    version: options.version ?? ProtocolVersion,
    description: options.description ?? "Model Context Protocol endpoint",
    family: McpProtocolFamily,
    ...(options.status === (void 0) ? {} : { status: options.status }),
    ...(options.endpoint === (void 0) ? {} : { endpoint: options.endpoint }),
    capabilities: [...(options.capabilities ?? ["tools"])],
});

/**
 * Read one endpoint's advertised tool list again.
 *
 * @param protocol - Bound implementation.
 * @returns The advertised tools.
 */
export const mcpListTools: (protocol: McpProtocol) => Promise<McpTool[]> = async (protocol: McpProtocol): Promise<McpTool[]> =>
    (await protocol.client.listTools()).tools;

/**
 * Mirror one endpoint's tools into a tool registry.
 *
 * A new tool is registered, a changed schema/description/risk is updated in
 * place, and a tool the endpoint no longer advertises is removed. The reply
 * lists all three sets so a host can audit the change instead of diffing
 * silently.
 *
 * @param protocol - Bound implementation; `tools` is used as the previous set.
 * @param tools - Registry the runtime executes from.
 * @returns Added, updated and removed descriptors.
 */
export const mcpSyncTools: (protocol: McpProtocol, tools: ToolRegistry) => Promise<{ added: ToolDescriptor[]; updated: ToolDescriptor[]; removed: string[]; }> = async (
    protocol: McpProtocol, tools: ToolRegistry,
): Promise<{ added: ToolDescriptor[]; updated: ToolDescriptor[]; removed: string[]; }> => {
    const listed: McpTool[] = await mcpListTools(protocol);
    const descriptors: ToolDescriptor[] = listed.map(mcpToolDescriptor);
    const advertised: string[] = descriptors.map((descriptor: ToolDescriptor): string => descriptor.name);
    const added: ToolDescriptor[] = [];
    const updated: ToolDescriptor[] = [];
    for (const descriptor of descriptors) {
        if (tools.get(descriptor.name) === (void 0)) {
            tools.register(descriptor);
            added.push(descriptor);
        } else {
            tools.update(descriptor);
            updated.push(descriptor);
        }
    }
    const removed: string[] = [];
    for (const name of protocol.tools ?? []) {
        if (!advertised.includes(name) && tools.remove(name)) {
            removed.push(name);
        }
    }
    return { added, updated, removed };
};

/**
 * Withdraw one endpoint's tools from a tool registry.
 *
 * @param protocol - Bound implementation; `tools` is the last advertised set.
 * @param tools - Registry to withdraw from.
 * @returns Names actually removed.
 */
export const mcpWithdrawTools: (protocol: McpProtocol, tools: ToolRegistry) => string[] = (protocol: McpProtocol, tools: ToolRegistry): string[] =>
    (protocol.tools ?? []).filter((name: string): boolean => tools.remove(name));
