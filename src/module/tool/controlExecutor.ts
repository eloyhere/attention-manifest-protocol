/** Direct registry/executor integration for host-bound session controls. */
import type { SessionControlService } from "../../control/sessionService.ts";
import { resolveToolName } from "../../naming/index.ts";
import { SessionControlProtocol } from "../../protocol/control.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

export const registerSessionControlTools = (registry: ToolRegistry, service: SessionControlService): ToolDescriptor[] => {
    const descriptors: ToolDescriptor[] = service.tools();
    if (descriptors.some((tool) => registry.get(tool.name) !== undefined)) throw new Error("session control tools already registered");
    for (const tool of descriptors) registry.register(tool);
    return descriptors;
};
export class SessionControlToolExecutor implements ToolExecutor {
    private readonly service: SessionControlService;
    private readonly fallback?: ToolExecutor;
    constructor(service: SessionControlService, fallback?: ToolExecutor) { this.service = service; this.fallback = fallback; }
    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        const canonical = resolveToolName(invocation.tool);
        if (canonical === undefined || !canonical.startsWith("amp_tool_session_")) {
            if (this.fallback !== undefined) return this.fallback.execute(invocation);
            return { ok: false, content: JSON.stringify({ protocol: SessionControlProtocol, version: 1, ok: false, error: { code: "unknown_tool", message: "unknown_tool" } }), error: "unknown_tool" };
        }
        const response = this.service.call(canonical, invocation.args);
        return { ok: response.ok, content: JSON.stringify(response), ...("error" in response ? { error: response.error.code } : {}) };
    }
}
