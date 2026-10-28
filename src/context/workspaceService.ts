/**
 * One trusted host scope per service instance. Agent calls cannot register
 * Frames, supply snapshots, read arbitrary hashes or expand project scope.
 */
import { createHash, randomUUID } from "node:crypto";
import { parseToolCall } from "../boundary/toolCall.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";
import type { Frame } from "../frame/frame.ts";
import type { Receipt } from "../receipt/receipt.ts";
import { estimateTokens } from "./agentContext.ts";
import type { ContentStore } from "./contentStore.ts";
import type { Context, ContextSnapshot, ContextView } from "./lifecycle.ts";
import { WorkspaceIndex } from "./workspace.ts";
import type { WorkspaceEntity, WorkspaceQuery, WorkspaceRelationKind, WorkspaceSnapshot } from "./workspace.ts";
import { WorkspaceProtocol, WorkspaceProtocolVersion, workspaceToolDefinitions } from "./workspaceProtocol.ts";
import type { WorkspaceErrorCode, WorkspaceResponse, WorkspaceToolDefinition } from "./workspaceProtocol.ts";

export interface WorkspaceServiceLimits {
    maxFrames: number;
    maxContexts: number;
    maxViewTokens: number;
    maxReadChars: number;
    maxResponseChars: number;
    maxToolCalls: number;
}

export interface WorkspaceServiceOptions {
    agentId: string;
    projectIds: readonly string[];
    snapshot: WorkspaceSnapshot;
    store: ContentStore;
    limits?: Partial<WorkspaceServiceLimits>;
}

interface Allocation {
    frame: Frame;
    state: "available" | "materialized" | "released" | "revoked";
    contextId?: string;
    remainingTokens: number;
}

interface Materialization {
    context: Context;
    allocation: Allocation;
    readable: Set<string>;
    response: WorkspaceResponse;
    requestedTokens: number;
}

const Defaults: WorkspaceServiceLimits = {
    maxFrames: 128,
    maxContexts: 32,
    maxViewTokens: 8000,
    maxReadChars: 8000,
    maxResponseChars: 131072,
    maxToolCalls: 1000,
};

class WorkspaceServiceError extends Error {
    readonly code: WorkspaceErrorCode;

    constructor(code: WorkspaceErrorCode) {
        super(code);
        this.code = code;
    }
}

const fail: (code: WorkspaceErrorCode) => never = (code: WorkspaceErrorCode): never => {
    throw new WorkspaceServiceError(code);
};

export class WorkspaceAgentService {
    private readonly agentId: string;
    private readonly index: WorkspaceIndex;
    private readonly limits: WorkspaceServiceLimits;
    private readonly frames: Map<string, Allocation> = new Map();
    private readonly contexts: Map<string, Materialization> = new Map();
    private readonly retired: Map<string, Materialization> = new Map();
    private readonly roots: WorkspaceEntity[];
    private readonly definitions: WorkspaceToolDefinition[] = workspaceToolDefinitions();
    private calls: number = 0;

    constructor(options: WorkspaceServiceOptions) {
        if (!options.agentId || !Array.isArray(options.projectIds)) {
            throw new Error("workspace service requires a host agent and explicit project scope");
        }
        this.agentId = options.agentId;
        this.limits = { ...Defaults, ...options.limits };
        Object.entries(this.limits).forEach(([key, value]: [string, number]): void => {
            if (!Number.isSafeInteger(value) || value < 1 || value > Defaults[key as keyof WorkspaceServiceLimits]) {
                throw new Error(`invalid workspace service limit ${key}`);
            }
        });
        const projects: Set<string> = new Set(options.projectIds);
        projects.forEach((id: string): void => {
            if (!options.snapshot.entities.some((entity: WorkspaceEntity): boolean => entity.id === id && entity.kind === "project")) {
                throw new Error("unknown authorized project");
            }
        });
        const entities: WorkspaceEntity[] = options.snapshot.entities.filter((entity: WorkspaceEntity): boolean => projects.has(entity.projectId));
        const ids: Set<string> = new Set(entities.map((entity: WorkspaceEntity): string => entity.id));
        const store: ContentStore = options.store;
        const verifiedStore: ContentStore = {
            put: (): never => fail("internal_error"),
            get: (ref: string): string | undefined => {
                try {
                    if (!/^sha256:[0-9a-f]{64}$/.test(ref)) {
                        return fail("integrity_failure");
                    }
                    const content: string | undefined = store.get(ref);
                    if (content !== (void 0) && `sha256:${createHash("sha256").update(content).digest("hex")}` !== ref) {
                        return fail("integrity_failure");
                    }
                    return content;
                } catch {
                    return fail("integrity_failure");
                }
            },
        };
        this.index = new WorkspaceIndex(
            {
                version: options.snapshot.version,
                revision: options.snapshot.revision,
                entities,
                relations: options.snapshot.relations.filter((edge): boolean => ids.has(edge.from) && ids.has(edge.to)),
                diagnostics: [],
            },
            verifiedStore,
        );
        this.roots = this.index.snapshot().entities.filter((entity: WorkspaceEntity): boolean => entity.kind === "project");
    }

    /**
     * Host-only registration. Frames bind to this snapshot revision explicitly;
     * their digest remains the AMP Frame digest, not a workspace revision field.
     */
    registerFrame(frame: Frame, revision: string): void {
        if (revision !== this.index.revision) {
            fail("revision_mismatch");
        }
        const tokens: number | undefined = frame.budget?.allocated?.tokens;
        const spent: number = frame.budget?.spent?.tokens ?? 0;
        if (
            frame.amp !== "0.1" ||
            frame.kind !== "frame" ||
            !frame.id ||
            frame.agent !== this.agentId ||
            !Array.isArray(frame.slots) ||
            frame.slots.length > 9 ||
            !Number.isSafeInteger(tokens) ||
            tokens! < 1 ||
            !Number.isSafeInteger(spent) ||
            spent < 0 ||
            spent > tokens! ||
            frame.slots.some(
                (slot): boolean =>
                    !slot.target?.id ||
                    !this.index.entity(slot.target.id) ||
                    !["active", "released", "evicted", "done"].includes(slot.state) ||
                    !slot.why?.trim(),
            )
        ) {
            fail("invalid_arguments");
        }
        if (this.frames.has(frame.id) || this.frames.size >= this.limits.maxFrames) {
            fail("capacity_exceeded");
        }
        this.frames.set(frame.id, { frame: structuredClone(frame), state: "available", remainingTokens: tokens! - spent });
    }

    /**
     * Revocation destroys any live handle and cannot be reversed by an agent.
     */
    revokeFrame(frameId: string): void {
        const allocation: Allocation | undefined = this.frames.get(frameId);
        if (allocation === (void 0)) {
            fail("frame_unavailable");
        }
        if (allocation.contextId !== (void 0)) {
            const item: Materialization | undefined = this.contexts.get(allocation.contextId);
            if (item !== (void 0)) {
                this.retired.set(allocation.contextId, item);
            }
            this.contexts.delete(allocation.contextId);
        }
        allocation.state = "revoked";
    }

    /**
     * Only the host can attest actual outcomes and settle an action Receipt.
     * Settlement removes the model's detail handle; release alone is not settlement.
     */
    settle(contextId: string, receipt: Receipt): ContextSnapshot {
        const item: Materialization | undefined = this.contexts.get(contextId) ?? this.retired.get(contextId);
        if (item === (void 0)) {
            fail("not_available");
        }
        item.context.settle(receipt);
        item.context.compact();
        item.context.archive();
        const snapshot: ContextSnapshot = item.context.snapshot();
        if (item.allocation.state !== "revoked") {
            item.allocation.state = "released";
        }
        this.contexts.delete(contextId);
        this.retired.delete(contextId);
        return snapshot;
    }

    /**
     * Host reconciliation survives agent release/revocation within this process.
     * Estimated text tokens are separate from actual model usage in Receipts.
     */
    pendingSettlements(): Array<{ contextId: string; frameId: string; estimatedTokens: number; }> {
        return [...this.contexts.entries(), ...this.retired.entries()].map(
            ([contextId, item]: [string, Materialization]): { contextId: string; frameId: string; estimatedTokens: number; } => ({
                contextId,
                frameId: item.allocation.frame.id,
                estimatedTokens:
                    item.allocation.frame.budget.allocated.tokens! - (item.allocation.frame.budget.spent.tokens ?? 0) - item.allocation.remainingTokens,
            }),
        );
    }

    tools(): WorkspaceToolDefinition[] {
        return structuredClone(this.definitions);
    }

    call(name: string, raw: unknown): WorkspaceResponse {
        try {
            if (this.calls >= this.limits.maxToolCalls) {
                return fail("budget_exhausted");
            }
            this.calls += 1;
            const tool: WorkspaceToolDefinition | undefined = this.definitions.find((item: WorkspaceToolDefinition): boolean => item.name === name);
            if (tool === (void 0)) {
                return fail("unknown_tool");
            }
            const args: Record<string, unknown> = parseToolCall(tool, raw).args;
            if (name !== "amp_workspace_capabilities" && args.revision !== this.index.revision) {
                return fail("revision_mismatch");
            }
            return this.dispatch(name, args);
        } catch (error: unknown) {
            const code: WorkspaceErrorCode =
                error instanceof WorkspaceServiceError ? error.code : error instanceof BoundaryRejection ? "invalid_arguments" : "internal_error";
            return { protocol: WorkspaceProtocol, version: WorkspaceProtocolVersion, revision: this.index.revision, ok: false, error: { code, message: code } };
        }
    }

    private reply(data: Record<string, unknown>): WorkspaceResponse {
        const result: WorkspaceResponse = { protocol: WorkspaceProtocol, version: WorkspaceProtocolVersion, revision: this.index.revision, ok: true, data };
        if (JSON.stringify(result).length > this.limits.maxResponseChars) {
            fail("response_too_large");
        }
        return result;
    }

    private requireEntity(id: string): WorkspaceEntity {
        return this.index.entity(id) ?? fail("not_available");
    }

    private dispatch(name: string, args: Record<string, unknown>): WorkspaceResponse {
        if (name === "amp_workspace_capabilities") {
            return this.reply({
                agentId: this.agentId,
                projectIds: this.roots.map((entity: WorkspaceEntity): string => entity.id),
                frames: [...this.frames.values()]
                    .filter((item: Allocation): boolean => item.state === "available" || item.state === "materialized")
                    .map((item: Allocation): Record<string, unknown> => ({ frameId: item.frame.id, state: item.state, remainingTokens: item.remainingTokens })),
                limits: { ...this.limits },
                remainingToolCalls: this.limits.maxToolCalls - this.calls,
                tools: this.definitions.map((tool: WorkspaceToolDefinition): string => tool.name),
                tokenAccounting: "character-estimate; summary text and detail pages only; discovery and JSON envelope excluded",
            });
        }
        if (name === "amp_workspace_tree") {
            const parentId: string | undefined = args.parentId as string | undefined;
            if (parentId !== (void 0)) {
                this.requireEntity(parentId);
            }
            const all: WorkspaceEntity[] = parentId === (void 0) ? this.roots : this.index.children(parentId);
            const offset: number = (args.offset as number | undefined) ?? 0;
            const end: number = Math.min(all.length, offset + ((args.limit as number | undefined) ?? 32));
            return this.reply({
                items: all.slice(offset, end).map((entity: WorkspaceEntity): Record<string, unknown> => ({
                    id: entity.id,
                    kind: entity.kind,
                    label: entity.label,
                    parentId: entity.parentId,
                    structureKind: entity.structureKind,
                    source: entity.source,
                    hasDetail: entity.detailRef !== (void 0),
                    summaryState: this.index.summaryState(entity.id),
                })),
                total: all.length,
                nextOffset: end < all.length ? end : null,
            });
        }
        if (name === "amp_workspace_query") {
            const query: Record<string, unknown> = { ...args };
            delete query.revision;
            const result: ReturnType<WorkspaceIndex["query"]> = this.index.query(query as WorkspaceQuery);
            return this.reply({ ...result });
        }
        if (name === "amp_workspace_relations") {
            this.requireEntity(args.nodeId as string);
            const all: ReturnType<WorkspaceIndex["relations"]> = this.index.relations(
                args.nodeId as string,
                args.direction as "incoming" | "outgoing",
                args.relationKind as WorkspaceRelationKind | undefined,
            );
            const offset: number = (args.offset as number | undefined) ?? 0;
            const end: number = Math.min(all.length, offset + ((args.limit as number | undefined) ?? 32));
            return this.reply({ items: all.slice(offset, end), total: all.length, nextOffset: end < all.length ? end : null });
        }
        if (name === "amp_workspace_materialize") {
            return this.materialize(args.frameId as string, args.budgetTokens as number);
        }
        const item: Materialization | undefined = this.contexts.get(args.contextId as string);
        if (item === (void 0)) {
            return fail("not_available");
        }
        if (name === "amp_workspace_release") {
            const response: WorkspaceResponse = this.reply({
                released: true,
                frameId: item.allocation.frame.id,
                remainingTokens: item.allocation.remainingTokens,
            });
            this.contexts.delete(args.contextId as string);
            this.retired.set(args.contextId as string, item);
            item.allocation.state = "released";
            return response;
        }
        return this.read(item, args);
    }

    private materialize(frameId: string, budgetTokens: number): WorkspaceResponse {
        const allocation: Allocation | undefined = this.frames.get(frameId);
        if (allocation === (void 0) || allocation.state === "released" || allocation.state === "revoked") {
            return fail("frame_unavailable");
        }
        if (allocation.contextId !== (void 0)) {
            const existing: Materialization = this.contexts.get(allocation.contextId)!;
            if (existing.requestedTokens !== budgetTokens) {
                return fail("invalid_arguments");
            }
            const response: WorkspaceResponse = structuredClone(existing.response);
            if (response.ok) {
                response.data.remainingTokens = allocation.remainingTokens;
            }
            return response;
        }
        if (this.contexts.size >= this.limits.maxContexts) {
            return fail("capacity_exceeded");
        }
        const cap: number = Math.min(budgetTokens, this.limits.maxViewTokens, allocation.remainingTokens);
        if (cap <= 0) {
            return fail("budget_exhausted");
        }
        const context: Context = this.index.context(allocation.frame, cap);
        const view: ContextView = context.view!;
        const included: Set<string> = new Set(view.nodes.map((node): string => node.id));
        const readable: Set<string> = new Set(
            allocation.frame.slots.filter((slot): boolean => slot.state === "active" && included.has(slot.target.id)).map((slot): string => slot.target.id),
        );
        const contextId: string = `ctx.${randomUUID()}`;
        const response: WorkspaceResponse = this.reply({
            contextId,
            frameId,
            text: view.text,
            tokens: view.tokens,
            budgetTokens: cap,
            remainingTokens: allocation.remainingTokens - view.tokens,
            includedIds: [...included],
            readableIds: [...readable],
            deferredIds: view.deferred.map((node): string => node.id),
            missingRefs: view.missingRefs,
            relations: view.relations,
            unresolvedDependencies: view.unresolvedDependencies,
            omissions: view.omissions,
        });
        allocation.remainingTokens -= view.tokens;
        allocation.state = "materialized";
        allocation.contextId = contextId;
        this.contexts.set(contextId, { context, allocation, readable, response: structuredClone(response), requestedTokens: budgetTokens });
        return response;
    }

    private read(item: Materialization, args: Record<string, unknown>): WorkspaceResponse {
        const nodeId: string = args.nodeId as string;
        if (!item.readable.has(nodeId)) {
            return fail("not_available");
        }
        const remaining: number = item.allocation.remainingTokens;
        if (remaining <= 0) {
            return fail("budget_exhausted");
        }
        const content: string | undefined = item.context.expand(nodeId);
        if (content === (void 0)) {
            return fail("not_available");
        }
        const offset: number = (args.offset as number | undefined) ?? 0;
        if (offset > content.length) {
            return fail("invalid_arguments");
        }
        const size: number = Math.min((args.maxChars as number | undefined) ?? this.limits.maxReadChars, this.limits.maxReadChars, remaining * 4);
        const text: string = content.slice(offset, offset + size);
        const tokens: number = text.length === 0 ? 0 : estimateTokens(text);
        const response: WorkspaceResponse = this.reply({
            nodeId,
            source: this.requireEntity(nodeId).source,
            offset,
            text,
            nextOffset: offset + text.length < content.length ? offset + text.length : null,
            totalChars: content.length,
            tokens,
            remainingTokens: remaining - tokens,
        });
        item.allocation.remainingTokens -= tokens;
        return response;
    }
}
