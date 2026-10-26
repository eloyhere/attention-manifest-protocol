/**
 * MCP-backed ToolExecutor.
 *
 * The runtime/tool loop sees only `ToolExecutor`; MCP is one adapter behind it.
 */
import type { McpClient } from "../mcp/client.ts";
import { textOf } from "../mcp/protocol.ts";
import type { CallToolResult, ListToolsResult, McpTool } from "../mcp/protocol.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

type RegisterMcpTools = (registry: ToolRegistry, client: McpClient) => Promise<ToolDescriptor[]>;

/**
 * Register MCP tools with a risk tier derived from annotations.
 */
export const registerMcpTools: RegisterMcpTools = async (registry: ToolRegistry, client: McpClient): Promise<ToolDescriptor[]> => {
    const listed: ListToolsResult = await client.listTools();
    const registered: ToolDescriptor[] = [];
    for (let index: number = 0; index < listed.tools.length; index += 1) {
        const tool: McpTool = listed.tools[index];
        const destructive: boolean = tool.annotations?.destructiveHint === true;
        const readOnly: boolean = tool.annotations?.readOnlyHint === true;
        const descriptor: ToolDescriptor = {
            name: tool.name,
            description: tool.description ?? tool.title ?? tool.name,
            inputSchema: tool.inputSchema,
            risk: destructive ? "destructive" : readOnly ? "read" : "write",
        };
        registry.register(descriptor);
        registered.push(descriptor);
    }
    return registered;
};

export class McpToolExecutor implements ToolExecutor {
    private readonly client: McpClient;

    constructor(client: McpClient) {
        this.client = client;
    }

    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        try {
            const result: CallToolResult = await this.client.callTool(invocation.tool, invocation.args);
            return {
                ok: result.isError !== true,
                content: textOf(result),
                ...(result.isError === true ? { error: textOf(result) } : {}),
            };
        } catch (error) {
            return { ok: false, content: "", error: error instanceof Error ? error.message : `${error}` };
        }
    }
}
