/**
 * Global agent service: the `amp.workspace` operation set over every
 * host-authorized project, exposed under the `amp_tool_global_*` names.
 *
 * This is a thin adapter, not a second implementation. The underlying
 * `WorkspaceAgentService` receives the complete project set; the adapter
 * rewrites names, the protocol envelope and the capabilities catalog so a
 * client sees the global surface consistently.
 */
import { buildCatalog } from "../naming/index.ts";
import type { CatalogEntry, ToolCatalog } from "../naming/index.ts";
import { digestOf } from "../semantic/canonical.ts";
import { WorkspaceAgentService } from "../context/workspaceService.ts";
import type { WorkspaceRunner, WorkspaceServiceLimits, WorkspaceWriter } from "../context/workspaceService.ts";
import type { ContentStore } from "../context/contentStore.ts";
import type { WorkspaceSnapshot } from "../context/workspace.ts";
import type { HostCatalog } from "../discover/host.ts";
import type { Frame } from "../frame/frame.ts";
import type { ContextSnapshot } from "../context/lifecycle.ts";
import type { Receipt } from "../receipt/receipt.ts";
import { GlobalProtocol, GlobalProtocolVersion, globalToolDefinitions, globalToolLeaves } from "../protocol/global.ts";
import type { GlobalResponse } from "../protocol/global.ts";
import type { WorkspaceToolDefinition } from "../protocol/workspace.ts";

export interface GlobalServiceOptions {
    agentId: string;
    snapshot: WorkspaceSnapshot;
    store: ContentStore;
    /**
     * Optional narrower project set. Omitted means every project in `snapshot`.
     */
    projectIds?: readonly string[];
    host?: HostCatalog;
    limits?: Partial<WorkspaceServiceLimits>;
    /**
     * Optional persistence port forwarded to the underlying workspace service.
     * Without it the global write tool answers `write_unavailable`, exactly as
     * the workspace-scoped surface does.
     */
    writer?: WorkspaceWriter;
    /**
     * Optional execution port forwarded to the underlying workspace service.
     * Without it `build`/`compile`/`run`/`test` answer `run_unavailable`.
     */
    runner?: WorkspaceRunner;
}

export class GlobalAgentService {
    private readonly workspace: WorkspaceAgentService;
    private readonly definitions: WorkspaceToolDefinition[] = globalToolDefinitions();
    private readonly revision: string;
    private cachedCatalog: ToolCatalog | undefined;

    constructor(options: GlobalServiceOptions) {
        const projectIds: readonly string[] =
            options.projectIds ?? options.snapshot.entities.filter((entity): boolean => entity.kind === "project").map((entity): string => entity.id);
        this.revision = options.snapshot.revision;
        this.workspace = new WorkspaceAgentService({
            agentId: options.agentId,
            snapshot: options.snapshot,
            projectIds,
            store: options.store,
            ...(options.host === (void 0) ? {} : { host: options.host }),
            ...(options.limits === (void 0) ? {} : { limits: options.limits }),
            ...(options.writer === (void 0) ? {} : { writer: options.writer }),
            ...(options.runner === (void 0) ? {} : { runner: options.runner }),
        });
    }

    tools(): WorkspaceToolDefinition[] {
        return structuredClone(this.definitions);
    }

    catalog(): ToolCatalog {
        if (this.cachedCatalog === (void 0)) {
            const entries: CatalogEntry[] = this.definitions.map((tool: WorkspaceToolDefinition): CatalogEntry => ({
                id: tool.name,
                digest: digestOf({ description: tool.description, inputSchema: tool.inputSchema, risk: tool.risk }),
                risk: tool.risk,
            }));
            this.cachedCatalog = buildCatalog(entries, { version: "1.0.0", ttlMs: 0, cacheScope: "private" });
        }
        return structuredClone(this.cachedCatalog);
    }

    call(name: string, raw: unknown): GlobalResponse {
        const leaf: string | undefined = globalToolLeaves.get(name);
        if (leaf === (void 0)) {
            return this.error("unknown_tool", "unknown_tool");
        }
        const response = this.workspace.call(`amp_tool_workspace_${leaf}`, raw);
        if ("error" in response) {
            return {
                protocol: GlobalProtocol,
                version: GlobalProtocolVersion,
                revision: response.revision,
                ok: false,
                error: response.error,
            };
        }
        const data: Record<string, unknown> = { ...response.data };
        if (leaf === "capabilities") {
            data.tools = this.definitions.map((tool: WorkspaceToolDefinition): string => tool.name);
            const catalog: ToolCatalog = this.catalog();
            data.catalog = { version: catalog.version, digest: catalog.digest, sortedBy: catalog.sortedBy, ttlMs: catalog.ttlMs };
            data.deprecatedAliases = [];
        }
        return {
            protocol: GlobalProtocol,
            version: GlobalProtocolVersion,
            revision: response.revision,
            ok: true,
            data,
        };
    }

    registerFrame(frame: Frame, revision: string): void {
        this.workspace.registerFrame(frame, revision);
    }

    revokeFrame(frameId: string): void {
        this.workspace.revokeFrame(frameId);
    }

    settle(contextId: string, receipt: Receipt): ContextSnapshot {
        return this.workspace.settle(contextId, receipt);
    }

    pendingSettlements(): Array<{ contextId: string; frameId: string; estimatedTokens: number }> {
        return this.workspace.pendingSettlements();
    }

    private error(code: "unknown_tool", message: string): GlobalResponse {
        return {
            protocol: GlobalProtocol,
            version: GlobalProtocolVersion,
            revision: this.revision,
            ok: false,
            error: { code, message },
        };
    }
}
