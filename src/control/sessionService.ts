/** Independent session controls: no project snapshot or workspace authority required. */
import { parseToolCall } from "../boundary/toolCall.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";
import { buildCatalog } from "../naming/index.ts";
import type { ToolCatalog } from "../naming/index.ts";
import { digestOf } from "../semantic/canonical.ts";
import { controlToolDefinitions, controlToolDomain, SessionControlProtocol } from "../protocol/control.ts";
import type { SessionControlResponse } from "../protocol/control.ts";
import type { WorkspaceErrorCode, WorkspaceToolDefinition } from "../protocol/workspace.ts";
import { ControlError } from "./types.ts";
import type { ControlPort } from "./types.ts";

export interface SessionControlServiceOptions {
    /** The authenticated host binds this port to one session identity. */
    control?: ControlPort;
    limits?: { maxToolCalls?: number; maxResponseChars?: number; };
}
const Defaults = { maxToolCalls: 1000, maxResponseChars: 131072 };
export class SessionControlService {
    private readonly control?: ControlPort;
    private readonly definitions = controlToolDefinitions("session");
    private readonly limits: typeof Defaults;
    private calls = 0;
    constructor(options: SessionControlServiceOptions = {}) {
        this.control = options.control;
        this.limits = { ...Defaults, ...options.limits };
        for (const [key, value] of Object.entries(this.limits)) {
            if (!Number.isSafeInteger(value) || value < 1 || value > Defaults[key as keyof typeof Defaults]) throw new Error(`invalid session control limit ${key}`);
        }
    }
    tools(): WorkspaceToolDefinition[] { return structuredClone(this.definitions); }
    catalog(): ToolCatalog {
        return buildCatalog(this.definitions.map((tool) => ({ id: tool.name, risk: tool.risk, digest: digestOf({ description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk }) })), { version: "1.0.0", ttlMs: 0, cacheScope: "private" });
    }
    call(name: string, raw: unknown): SessionControlResponse {
        try {
            if (this.calls >= this.limits.maxToolCalls) return this.error("budget_exhausted");
            this.calls += 1;
            const tool = this.definitions.find((item) => item.name === name);
            if (tool === undefined) return this.error("unknown_tool");
            const args = parseToolCall(tool, raw).args;
            if (this.control === undefined) return this.error("control_unavailable");
            const domain = controlToolDomain(tool.name)!;
            const data = this.control.call("session", domain, args);
            const response: SessionControlResponse = { protocol: SessionControlProtocol, version: 1, ok: true, data };
            if (JSON.stringify(response).length > this.limits.maxResponseChars) return this.error("response_too_large");
            return response;
        } catch (error: unknown) {
            return this.error(error instanceof ControlError ? error.code : error instanceof BoundaryRejection ? "invalid_arguments" : "internal_error");
        }
    }
    private error(code: WorkspaceErrorCode): SessionControlResponse {
        return { protocol: SessionControlProtocol, version: 1, ok: false, error: { code, message: code } };
    }
}
