/**
 * Direct integration for the filesystem tool surface.
 *
 * The executor forwards only canonical `amp_tool_filesystem_*` ids to the bound
 * session. A name outside that namespace belongs to a fallback executor, so a
 * workspace or global call cannot be silently served by the filesystem handle
 * and inherit its writable roots.
 */
import type { FilesystemSession } from "../../file/service.ts";
import type { FilesystemResponse, FilesystemToolDefinition } from "../../protocol/filesystem.ts";
import { resolveToolName } from "../../naming/index.ts";
import type { ToolDescriptor, ToolExecutor, ToolInvocation, ToolRegistry, ToolResult } from "./tool.ts";

export const registerFilesystemTools: (registry: ToolRegistry, session: FilesystemSession) => ToolDescriptor[] = (
    registry: ToolRegistry,
    session: FilesystemSession,
): ToolDescriptor[] => {
    const descriptors: ToolDescriptor[] = session.tools().map((tool: FilesystemToolDefinition): ToolDescriptor => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        risk: tool.risk,
    }));
    if (descriptors.some((tool: ToolDescriptor): boolean => registry.get(tool.name) !== (void 0))) {
        throw new Error("filesystem tools already registered");
    }
    descriptors.forEach((tool: ToolDescriptor): void => {
        registry.register(tool);
    });
    return descriptors;
};

export class FilesystemToolExecutor implements ToolExecutor {
    private readonly session: FilesystemSession;
    private readonly fallback?: ToolExecutor;

    constructor(session: FilesystemSession, fallback?: ToolExecutor) {
        this.session = session;
        this.fallback = fallback;
    }

    async execute(invocation: ToolInvocation): Promise<ToolResult> {
        const canonical: string | undefined = resolveToolName(invocation.tool);
        if (canonical === (void 0) || !canonical.startsWith("amp_tool_filesystem_")) {
            if (this.fallback !== (void 0)) {
                return this.fallback.execute(invocation);
            }
            return { ok: false, content: JSON.stringify(this.error("unknown_tool")), error: "unknown_tool" };
        }
        const response: FilesystemResponse = await this.session.dispatch(canonical, invocation.args);
        return {
            ok: response.ok,
            content: JSON.stringify(response),
            ...("error" in response ? { error: response.error.code } : {}),
        };
    }

    private error(code: string): FilesystemResponse {
        return {
            protocol: "amp_protocol_filesystem",
            version: 1,
            ok: false,
            revision: "unknown",
            session: this.session.sessionId,
            error: { code: "unknown_tool", message: code },
        };
    }
}
