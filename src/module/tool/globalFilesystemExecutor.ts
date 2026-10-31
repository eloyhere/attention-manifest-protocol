/**
 * Direct integration for the global filesystem surface.
 *
 * Mirrors `filesystemExecutor.ts`, but accepts only `amp_tool_globalfs_*` ids.
 * The global adapter is a naming layer over an authenticated session; this
 * executor keeps the namespace boundary so a local call cannot be widened by
 * routing it through the global registry.
 */
import type { GlobalFilesystemSession } from "../../global/filesystem.ts";
import type { FilesystemToolDefinition } from "../../protocol/filesystem.ts";
import type { GlobalFilesystemResponse } from "../../protocol/globalFilesystem.ts";
import { resolveToolName } from "../../naming/index.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

export const registerGlobalFilesystemTools: (registry: ToolRegistry, session: GlobalFilesystemSession) => ToolDescriptor[] = (
    registry: ToolRegistry,
    session: GlobalFilesystemSession,
): ToolDescriptor[] => {
    const descriptors: ToolDescriptor[] = session.tools().map((tool: FilesystemToolDefinition): ToolDescriptor => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        risk: tool.risk,
    }));
    if (descriptors.some((tool: ToolDescriptor): boolean => registry.get(tool.name) !== (void 0))) {
        throw new Error("global filesystem tools already registered");
    }
    descriptors.forEach((tool: ToolDescriptor): void => {
        registry.register(tool);
    });
    return descriptors;
};

export class GlobalFilesystemToolExecutor implements ToolExecutor {
    private readonly session: GlobalFilesystemSession;
    private readonly fallback?: ToolExecutor;

    constructor(session: GlobalFilesystemSession, fallback?: ToolExecutor) {
        this.session = session;
        this.fallback = fallback;
    }

    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        const canonical: string | undefined = resolveToolName(invocation.tool);
        if (canonical === (void 0) || !canonical.startsWith("amp_tool_globalfs_")) {
            if (this.fallback !== (void 0)) {
                return this.fallback.execute(invocation);
            }
            return { ok: false, content: JSON.stringify(this.error()), error: "unknown_tool" };
        }
        const response: GlobalFilesystemResponse = await this.session.call(canonical, invocation.args);
        return {
            ok: response.ok,
            content: JSON.stringify(response),
            ...("error" in response ? { error: response.error.code } : {}),
        };
    }

    private error(): GlobalFilesystemResponse {
        return {
            protocol: "amp_protocol_globalfs",
            version: 1,
            ok: false,
            revision: "unknown",
            session: this.session.sessionId,
            error: { code: "unknown_tool", message: "unknown_tool" },
        };
    }
}
