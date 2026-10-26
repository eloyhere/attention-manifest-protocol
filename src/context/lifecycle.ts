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
import type { ContextAstNode, ContextAstView } from "./ast.ts";
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

const missing = (slot: Slot): Ref => slot.target;

export class Context {
    readonly id: string;
    readonly frame: Frame;
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

    constructor(id: string, frame: Frame, graph: ContextAst, options: ContextOptions) {
        if (frame.id.length === 0) throw new Error("context requires a frame id");
        this.id = id;
        this.frame = frame;
        this.graph = graph;
        this.store = options.store;
        this.now = options.now ?? (() => new Date().toISOString());
        this.createdAt = this.now();
    }

    static create(frame: Frame, graph: ContextAst, options: ContextOptions & { id?: string }): Context {
        return new Context(options.id ?? `ctx.${frame.id}`, frame, graph, options);
    }

    /** Materialize only the frame's slots, under the token budget. */
    materialize(options: { budgetTokens: number }): ContextView {
        if (this.phase !== "created") throw new Error(`cannot materialize context in phase ${this.phase}`);
        if (!Number.isSafeInteger(options.budgetTokens) || options.budgetTokens <= 0) throw new RangeError("budgetTokens must be positive");
        const raw: ContextAstView = this.graph.view(options.budgetTokens);
        const missingRefs = this.frame.slots.filter((slot) => this.graph.node(slot.target.id) === undefined).map(missing);
        this.view = {
            frameId: this.frame.id,
            nodes: raw.nodes,
            tokens: raw.tokens,
            budgetTokens: options.budgetTokens,
            missingRefs,
            deferred: raw.excluded,
            refs: raw.refs,
            text: raw.text,
        };
        this.phase = "materialized";
        this.materializedAt = this.now();
        return this.view;
    }

    /** Mark the view as used by a prompt/action. */
    activate(): void {
        if (this.phase !== "materialized") throw new Error(`cannot activate context in phase ${this.phase}`);
        this.phase = "active";
    }

    /** Expand a detail ref on demand; never mutates the frame. */
    expand(nodeId: string): string | undefined {
        if (this.phase === "created" || this.phase === "archived") throw new Error(`cannot expand context in phase ${this.phase}`);
        const node = this.graph.node(nodeId);
        if (node?.detailRef === undefined) return undefined;
        return this.store.get(node.detailRef);
    }

    /** Settle with the receipt that describes the actual operation/outcome. */
    settle(receipt: Receipt): void {
        if (this.receiptIds.includes(receipt.id)) throw new Error(`receipt ${receipt.id} already attached`);
        if (this.phase !== "active" && this.phase !== "materialized") throw new Error(`cannot settle context in phase ${this.phase}`);
        this.receiptIds.push(receipt.id);
        this.phase = "settled";
        this.settledAt = this.now();
    }

    /** Drop view-only material; content refs remain readable until archive. */
    compact(): void {
        if (this.phase !== "settled") throw new Error(`cannot compact context in phase ${this.phase}`);
        this.phase = "compacted";
        this.compactedAt = this.now();
    }

    archive(): void {
        if (this.phase !== "compacted") throw new Error(`cannot archive context in phase ${this.phase}`);
        this.phase = "archived";
        this.archivedAt = this.now();
    }

    snapshot(): ContextSnapshot {
        return {
            id: this.id,
            frameId: this.frame.id,
            phase: this.phase,
            createdAt: this.createdAt,
            ...(this.materializedAt === undefined ? {} : { materializedAt: this.materializedAt }),
            ...(this.settledAt === undefined ? {} : { settledAt: this.settledAt }),
            ...(this.compactedAt === undefined ? {} : { compactedAt: this.compactedAt }),
            ...(this.archivedAt === undefined ? {} : { archivedAt: this.archivedAt }),
            receiptIds: [...this.receiptIds],
            ...(this.view === undefined ? {} : { view: { ...this.view, nodes: [...this.view.nodes], deferred: [...this.view.deferred], missingRefs: [...this.view.missingRefs], refs: [...this.view.refs] } }),
        };
    }
}
