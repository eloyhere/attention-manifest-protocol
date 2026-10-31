/**
 * Direct integration for the global agent surface.
 *
 * Mirrors `workspaceExecutor.ts`: the registry advertises the global
 * descriptors, and the executor accepts only `amp_tool_global_*` ids so a
 * workspace call cannot be silently widened to every project.
 */
import type { GlobalAgentService } from "../../global/service.ts";
import { resolveToolName } from "../../naming/index.ts";
import type { GlobalResponse } from "../../protocol/global.ts";
import type { WorkspaceToolDefinition } from "../../protocol/workspace.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

export const registerGlobalTools: (registry: ToolRegistry, service: GlobalAgentService) => ToolDescriptor[] = (
    registry: ToolRegistry,
    service: GlobalAgentService,
): ToolDescriptor[] => {
    const descriptors: ToolDescriptor[] = service.tools().map((tool: WorkspaceToolDefinition): ToolDescriptor => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk }));
    if (descriptors.some((tool: ToolDescriptor): boolean => registry.get(tool.name) !== (void 0))) {
        throw new Error("global tools already registered");
    }
    descriptors.forEach((tool: ToolDescriptor): void => {
        registry.register(tool);
    });
    return descriptors;
};

export class GlobalToolExecutor implements ToolExecutor {
    private readonly service: GlobalAgentService;
    private readonly fallback?: ToolExecutor;

    constructor(service: GlobalAgentService, fallback?: ToolExecutor) {
        this.service = service;
        this.fallback = fallback;
    }

    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        const canonical: string | undefined = resolveToolName(invocation.tool);
        if (canonical === (void 0) || !canonical.startsWith("amp_tool_global_")) {
            if (this.fallback !== (void 0)) {
                return this.fallback.execute(invocation);
            }
            return { ok: false, content: JSON.stringify(this.error("unknown_tool")), error: "unknown_tool" };
        }
        const response: GlobalResponse = this.service.call(canonical, invocation.args);
        return { ok: response.ok, content: JSON.stringify(response), ...("error" in response ? { error: response.error.code } : {}) };
    }

    private error(code: "unknown_tool"): GlobalResponse {
        return {
            protocol: "amp_protocol_global",
            version: 1,
            revision: "unknown",
            ok: false,
            error: { code, message: code },
        };
    }
}
