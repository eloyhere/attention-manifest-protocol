/**
 * Direct integration for CognitiveRuntime's existing registry/executor ports.
 */
import type { WorkspaceAgentService } from "../../context/workspaceService.ts";
import { resolveToolName } from "../../naming/index.ts";
import type { WorkspaceResponse, WorkspaceToolDefinition } from "../../protocol/workspace.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

export const registerWorkspaceTools: (registry: ToolRegistry, service: WorkspaceAgentService) => ToolDescriptor[] = (registry: ToolRegistry, service: WorkspaceAgentService): ToolDescriptor[] => {
    const descriptors: ToolDescriptor[] = service
        .tools()
        .map((tool: WorkspaceToolDefinition): ToolDescriptor => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk }));
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

    /**
     * Route a call to the workspace service only when its name resolves to a
     * registered workspace tool; everything else belongs to the fallback.
     *
     * Resolution happens before dispatch so a legacy `amp_workspace_*` alias is
     * forwarded as its canonical id and the service never has to know the old
     * spelling. With no fallback the unresolved name is still passed through,
     * which produces the service's structured `unknown_tool` envelope.
     */
    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        const canonical: string | undefined = resolveToolName(invocation.tool);
        if (canonical === (void 0) && this.fallback !== (void 0)) {
            return this.fallback.execute(invocation);
        }
        const response: WorkspaceResponse = this.service.call(canonical ?? invocation.tool, invocation.args);
        return { ok: response.ok, content: JSON.stringify(response), ...("error" in response ? { error: response.error.code } : {}) };
    }
}
