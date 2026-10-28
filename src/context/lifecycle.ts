/**
 * The single Context lifecycle object.
 *
 * Frame allocates; Context materializes; Receipt settles. Context never selects
 * new targets and never mutates the Frame. This file is the target public API;
 * AgentContext/ContextWindow are adapters during migration.
 */
import type { Frame, Slot } from "../frame/frame.ts";
import type { Receipt } from "../receipt/receipt.ts";
import type { Ref } from "../types/common.ts";
import { ContextAst } from "./ast.ts";
import type { ContextAstEdge, ContextAstNode, ContextAstView, ContextOmission } from "./ast.ts";
import type { ContentStore } from "./contentStore.ts";

export type ContextPhase = "created" | "materialized" | "active" | "settled" | "compacted" | "archived";

export interface ContextView {
    frameId: string;
    nodes: ContextAstNode[];
    tokens: number;
    budgetTokens: number;
    missingRefs: Ref[];
    deferred: ContextAstNode[];
    refs: string[];
    relations: ContextAstEdge[];
    unresolvedDependencies: ContextAstEdge[];
    omissions: ContextOmission[];
    text: string;
}

export interface ContextSnapshot {
    id: string;
    frameId: string;
    phase: ContextPhase;
    createdAt: string;
    materializedAt?: string;
    settledAt?: string;
    compactedAt?: string;
    archivedAt?: string;
    receiptIds: string[];
    view?: ContextView;
}

export interface ContextOptions {
    now?: () => string;
    store: ContentStore;
}

const missing: (slot: Slot) => Ref = (slot: Slot): Ref => ({ ...slot.target });

export class Context {
    readonly id: string;
    private readonly allocatedFrame: Frame;
    readonly graph: ContextAst;
    phase: ContextPhase = "created";
    readonly createdAt: string;
    materializedAt?: string;
    settledAt?: string;
    compactedAt?: string;
    archivedAt?: string;
    view?: ContextView;
    readonly receiptIds: string[] = [];
    private readonly store: ContentStore;
    private readonly now: () => string;
    private readonly expansionRefs: Map<string, string> = new Map<string, string>();

    constructor(id: string, frame: Frame, graph: ContextAst, options: ContextOptions) {
        if (frame.id.length === 0) {
            throw new Error("context requires a frame id");
        }
        this.id = id;
        this.allocatedFrame = structuredClone(frame);
        this.graph = graph;
        this.store = options.store;
        this.now = options.now ?? (() => new Date().toISOString());
        this.createdAt = this.now();
    }

    static create(frame: Frame, graph: ContextAst, options: ContextOptions & { id?: string }): Context {
        return new Context(options.id ?? `ctx.${frame.id}`, frame, graph, options);
    }

    /**
     * Expose a copy so callers cannot change the captured allocation.
     */
    get frame(): Frame {
        return structuredClone(this.allocatedFrame);
    }

    /**
     * Materialize only active frame targets and structural ancestors under budget.
     */
    materialize(options: { budgetTokens: number }): ContextView {
        if (this.phase !== "created") {
            throw new Error(`cannot materialize context in phase ${this.phase}`);
        }
        if (!Number.isSafeInteger(options.budgetTokens) || options.budgetTokens <= 0) {
            throw new RangeError("budgetTokens must be positive");
        }
        const activeSlots: Slot[] = this.allocatedFrame.slots.filter((slot) => slot.state === "active");
        const activeIds: Set<string> = new Set(activeSlots.map((slot) => slot.target.id));
        const raw: ContextAstView = this.graph.view(options.budgetTokens, [...activeIds]);
        const missingRefs: Ref[] = activeSlots.filter((slot) => this.graph.node(slot.target.id) === (void 0)).map(missing);
        const included: Set<string> = new Set(raw.nodes.map((node) => node.id));
        const pending: ContextAstNode[] = raw.nodes.filter((node) => activeIds.has(node.id));
        const visited: Set<string> = new Set<string>();
        raw.nodes.forEach((node: ContextAstNode): void => {
            if (node.detailRef !== (void 0)) {
                this.expansionRefs.set(node.id, node.detailRef);
            }
        });
        while (pending.length > 0) {
            const node: ContextAstNode | undefined = pending.pop();
            if (node === (void 0) || visited.has(node.id)) {
                continue;
            }
            visited.add(node.id);
            if (node.detailRef !== (void 0)) {
                this.expansionRefs.set(node.id, node.detailRef);
            }
            this.graph.children(node.id).forEach((child: ContextAstNode): void => {
                if (child.kind === "detail" || included.has(child.id)) {
                    pending.push(child);
                }
            });
        }
        this.view = {
            frameId: this.allocatedFrame.id,
            nodes: raw.nodes,
            tokens: raw.tokens,
            budgetTokens: options.budgetTokens,
            missingRefs,
            deferred: raw.excluded,
            refs: raw.refs,
            relations: raw.relations,
            unresolvedDependencies: raw.unresolvedDependencies,
            omissions: raw.omissions,
            text: raw.text,
        };
        this.phase = "materialized";
        this.materializedAt = this.now();
        return this.view;
    }

    /**
     * Mark the view as used by a prompt/action.
     */
    activate(): void {
        if (this.phase !== "materialized") {
            throw new Error(`cannot activate context in phase ${this.phase}`);
        }
        this.phase = "active";
    }

    /**
     * Expand captured refs for visible nodes or their selected targets' detail chains.
     */
    expand(nodeId: string): string | undefined {
        if (this.phase === "created" || this.phase === "archived") {
            throw new Error(`cannot expand context in phase ${this.phase}`);
        }
        const ref: string | undefined = this.expansionRefs.get(nodeId);
        if (ref === (void 0)) {
            return undefined;
        }
        return this.store.get(ref);
    }

    /**
     * Settle with the receipt that describes the actual operation/outcome.
     */
    settle(receipt: Receipt): void {
        if (this.receiptIds.includes(receipt.id)) {
            throw new Error(`receipt ${receipt.id} already attached`);
        }
        if (this.phase !== "active" && this.phase !== "materialized") {
            throw new Error(`cannot settle context in phase ${this.phase}`);
        }
        this.receiptIds.push(receipt.id);
        this.phase = "settled";
        this.settledAt = this.now();
    }

    /**
     * Drop view-only material; captured content refs remain readable until archive.
     */
    compact(): void {
        if (this.phase !== "settled") {
            throw new Error(`cannot compact context in phase ${this.phase}`);
        }
        this.phase = "compacted";
        this.compactedAt = this.now();
    }

    archive(): void {
        if (this.phase !== "compacted") {
            throw new Error(`cannot archive context in phase ${this.phase}`);
        }
        this.phase = "archived";
        this.archivedAt = this.now();
    }

    snapshot(): ContextSnapshot {
        return {
            id: this.id,
            frameId: this.allocatedFrame.id,
            phase: this.phase,
            createdAt: this.createdAt,
            ...(this.materializedAt === (void 0) ? {} : { materializedAt: this.materializedAt }),
            ...(this.settledAt === (void 0) ? {} : { settledAt: this.settledAt }),
            ...(this.compactedAt === (void 0) ? {} : { compactedAt: this.compactedAt }),
            ...(this.archivedAt === (void 0) ? {} : { archivedAt: this.archivedAt }),
            receiptIds: [...this.receiptIds],
            ...(this.view === (void 0)
                ? {}
                : {
                      view: structuredClone(this.view),
                  }),
        };
    }
}
