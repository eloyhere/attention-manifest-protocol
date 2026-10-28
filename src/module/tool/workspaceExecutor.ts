/**
 * Direct integration for CognitiveRuntime's existing registry/executor ports.
 */
import type { WorkspaceAgentService } from "../../context/workspaceService.ts";
import type { WorkspaceResponse, WorkspaceToolDefinition } from "../../context/workspaceProtocol.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

export const registerWorkspaceTools: (registry: ToolRegistry, service: WorkspaceAgentService) => ToolDescriptor[] = (registry: ToolRegistry, service: WorkspaceAgentService): ToolDescriptor[] => {
    const descriptors: ToolDescriptor[] = service.tools().map((tool: WorkspaceToolDefinition): ToolDescriptor => ({ ...tool, risk: "read" }));
    if (descriptors.some((tool: ToolDescriptor): boolean => registry.get(tool.name) !== (void 0))) {
        throw new Error("workspace tools already registered");
    }
    descriptors.forEach((tool: ToolDescriptor): void => {
        registry.register(tool);
    });
    return descriptors;
};

export class WorkspaceToolExecutor implements ToolExecutor {
    private readonly service: WorkspaceAgentService;
    private readonly fallback?: ToolExecutor;

    constructor(service: WorkspaceAgentService, fallback?: ToolExecutor) {
        this.service = service;
        this.fallback = fallback;
    }

    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        if (!invocation.tool.startsWith("amp_workspace_") && this.fallback !== (void 0)) {
            return this.fallback.execute(invocation);
        }
        const response: WorkspaceResponse = this.service.call(invocation.tool, invocation.args);
        return { ok: response.ok, content: JSON.stringify(response), ...("error" in response ? { error: response.error.code } : {}) };
    }
}
