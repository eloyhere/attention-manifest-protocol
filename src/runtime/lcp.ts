import { Optional, SynchronousOrderedMap } from "semantic-typescript";
import { retrieve, RetrievalHandleStore } from "../retrieval/index.ts";
import type { HandleReadRequest, Page, RetrievalDataHandle, RetrievalOptions, RetrievalResult } from "../retrieval/index.ts";
import type { ManifestStore } from "../manifest/index.ts";
import type { Executor } from "../execution/index.ts";
import type { ChildCall, Manifest, PolicyEnforcementPoint, RunResult, ToolDefinition, ToolHandle } from "../tool/index.ts";
import type { ExecutionContext, JsonValue } from "../shared.ts";
import { PolicyDeniedError } from "../policy/index.ts";

export interface LcpHost {
    manifests: ManifestStore<JsonValue>;
    executor: Executor<JsonValue, JsonValue>;
    policy: PolicyEnforcementPoint;
    handles: RetrievalHandleStore<JsonValue>;
    catalog: () => Iterable<Manifest>;
    toolStatus?: (definition: ToolDefinition, context: ExecutionContext) => "available" | "missing_precondition" | "disabled";
}

/** Four capability entry points. `run` accepts typed child calls, never evaluates arbitrary code. */
export class LcpService {
    private readonly host: LcpHost;
    constructor(host: LcpHost) { this.host = host; }

    async findTools(context: ExecutionContext, options: Omit<RetrievalOptions, "tenantId" | "authorizedToolIds">): Promise<RetrievalResult> {
        const authorized: Manifest[] = [];
        const statuses = new SynchronousOrderedMap<string, "available" | "missing_precondition" | "disabled">();
        const ids: string[] = [];
        for (const manifest of this.host.catalog()) {
            if (manifest.tenantId !== context.tenantId) { continue; }
            const tools: ToolDefinition[] = [];
            for (const definition of manifest.tools) {
                const object = { kind: "tool" as const, id: definition.toolId, tenantId: manifest.tenantId,
                    endpointId: manifest.endpointId, policyScope: definition.policyScope, version: definition.version,
                    digest: definition.digest, risk: definition.risk };
                try {
                    const decision = await this.host.policy.authorize({ action: "find", context, object });
                    if (!decision.allowed || decision.approvalRequired === true || decision.policyVersion !== context.policyVersion) { continue; }
                    const handle = this.host.manifests.createHandle(manifest, definition.toolId);
                    if (!handle || this.host.manifests.findTool(handle).isEmpty()) { continue; }
                    const stored = this.host.manifests.findTool(handle).get();
                    tools.push({ ...stored, inputSchema: null, outputSchema: null });
                    ids.push(stored.toolId);
                    const status = Optional.ofNullable(this.host.toolStatus)
                        .map(resolve => resolve(stored, context)).get(stored.preconditions?.length ? "missing_precondition" : "available");
                    statuses.put(stored.toolId, status);
                } catch (error) {
                    if (!(error instanceof PolicyDeniedError)) { throw error; }
                }
            }
            if (tools.length > 0) { authorized.push({ ...manifest, tools }); }
        }
        return retrieve({ manifests: authorized, statusByToolId: statuses }, { ...options, tenantId: context.tenantId, authorizedToolIds: ids });
    }

    async inspectTool(context: ExecutionContext, handle: ToolHandle): Promise<ToolDefinition> {
        if (handle.tenantId !== context.tenantId) { throw new Error("Tool tenant mismatch"); }
        const found = this.host.manifests.findTool(handle);
        if (found.isEmpty()) { throw new Error("Tool is absent, stale, expired or revoked"); }
        const definition = found.get();
        const decision = await this.host.policy.authorize({ action: "inspect", context, object: {
            kind: "tool", id: definition.toolId, tenantId: handle.tenantId, endpointId: handle.endpointId,
            version: definition.version, digest: definition.digest, policyScope: definition.policyScope, risk: definition.risk,
        } });
        if (!decision.allowed || decision.approvalRequired === true || decision.policyVersion !== context.policyVersion) {
            throw new PolicyDeniedError(decision);
        }
        const latest = this.host.manifests.findTool(handle);
        if (latest.isEmpty()) { throw new Error("Tool changed during authorization"); }
        return structuredClone(latest.get());
    }

    run(context: ExecutionContext, calls: readonly ChildCall[], budgetKey: string): Promise<RunResult> {
        return this.host.executor.run(calls, context, budgetKey);
    }

    readHandle(context: ExecutionContext, id: string, request: HandleReadRequest): Promise<Page<JsonValue>> {
        if (request.tenantId !== context.tenantId || request.sessionId !== context.sessionId || request.ownerId !== context.principalId) {
            return Promise.reject(new Error("Handle execution scope mismatch"));
        }
        return this.host.handles.read(id, request, async (handle: RetrievalDataHandle) => {
            const decision = await this.host.policy.authorize({ action: "read_handle", context, object: {
                kind: "data_handle", id: handle.id, tenantId: handle.tenantId, ownerId: handle.ownerId,
            } });
            return decision.allowed && decision.approvalRequired !== true && decision.policyVersion === context.policyVersion;
        });
    }
}
