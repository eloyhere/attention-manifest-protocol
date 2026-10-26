/**
 * Context AST: tree structure + precedence edges, summaries in the prompt,
 * detailed content behind local refs. This is a view over context, not a new
 * runtime. It can be rendered to text or paged through the existing window.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { estimateTokens } from "./agentContext.ts";

export type ContextNodeKind = "goal" | "frame" | "turn" | "observation" | "evidence" | "hypothesis" | "decision" | "detail";

export interface ContextAstNode {
    id: string;
    parentId?: string;
    kind: ContextNodeKind;
    summary: string;
    detailRef?: string;
    detailTokens?: number;
    order: number;
    salience?: number;
    createdAt?: string;
}

export type ContextEdgeKind = "before" | "after" | "depends" | "supports" | "contradicts";

export interface ContextAstEdge {
    from: string;
    to: string;
    kind: ContextEdgeKind;
}

export interface ContextAstView {
    nodes: ContextAstNode[];
    tokens: number;
    budgetTokens: number;
    excluded: ContextAstNode[];
    refs: string[];
    text: string;
}

export interface DetailStore {
    put(id: string, content: string): string;
    get(ref: string): string | undefined;
}

export class MemoryDetailStore implements DetailStore {
    private readonly details = new Map<string, string>();

    put(id: string, content: string): string {
        this.details.set(id, content);
        return id;
    }

    get(ref: string): string | undefined {
        return this.details.get(ref);
    }
}

const safeName = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_");

export class FileDetailStore implements DetailStore {
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
        mkdirSync(dir, { recursive: true });
    }

    put(id: string, content: string): string {
        const ref = `${this.dir}/${safeName(id)}.txt`;
        writeFileSync(ref, content, "utf8");
        return ref;
    }

    get(ref: string): string | undefined {
        if (!ref.startsWith(`${this.dir}/`) || !existsSync(ref)) return undefined;
        return readFileSync(ref, "utf8");
    }
}

export class ContextAst {
    private readonly nodes = new Map<string, ContextAstNode>();
    private readonly edges: ContextAstEdge[] = [];
    private readonly childrenOf = new Map<string, string[]>();

    add(node: ContextAstNode): this {
        if (this.nodes.has(node.id)) throw new Error(`duplicate context node ${node.id}`);
        this.nodes.set(node.id, { ...node });
        if (node.parentId !== undefined) {
            const children = this.childrenOf.get(node.parentId) ?? [];
            children.push(node.id);
            this.childrenOf.set(node.parentId, children);
        }
        return this;
    }

    link(edge: ContextAstEdge): this {
        if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) throw new Error(`edge references unknown node: ${edge.from}->${edge.to}`);
        this.edges.push({ ...edge });
        return this;
    }

    node(id: string): ContextAstNode | undefined {
        return this.nodes.get(id);
    }

    children(id: string): ContextAstNode[] {
        return (this.childrenOf.get(id) ?? []).map((child) => this.nodes.get(child)).filter((node): node is ContextAstNode => node !== undefined);
    }

    ancestors(id: string): ContextAstNode[] {
        const result: ContextAstNode[] = [];
        let current = this.nodes.get(id)?.parentId;
        const seen = new Set<string>();
        while (current !== undefined && !seen.has(current)) {
            seen.add(current);
            const node = this.nodes.get(current);
            if (node === undefined) break;
            result.push(node);
            current = node.parentId;
        }
        return result.reverse();
    }

    descendants(id: string): ContextAstNode[] {
        const result: ContextAstNode[] = [];
        const stack = [...(this.childrenOf.get(id) ?? [])];
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === undefined) continue;
            const node = this.nodes.get(current);
            if (node === undefined) continue;
            result.push(node);
            stack.push(...(this.childrenOf.get(current) ?? []));
        }
        return result;
    }

    /** Precedence order; `before`/`depends` constrain the order. */
    order(): ContextAstNode[] {
        const indegree = new Map<string, number>();
        const outgoing = new Map<string, string[]>();
        for (const id of this.nodes.keys()) {
            indegree.set(id, 0);
            outgoing.set(id, []);
        }
        for (const edge of this.edges) {
            if (edge.kind !== "before" && edge.kind !== "depends") continue;
            outgoing.get(edge.from)?.push(edge.to);
            indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
        }
        const queue = [...this.nodes.keys()].filter((id) => (indegree.get(id) ?? 0) === 0);
        const result: ContextAstNode[] = [];
        while (queue.length > 0) {
            const id = queue.shift() as string;
            const node = this.nodes.get(id);
            if (node !== undefined) result.push(node);
            for (const next of outgoing.get(id) ?? []) {
                indegree.set(next, (indegree.get(next) ?? 0) - 1);
                if ((indegree.get(next) ?? 0) === 0) queue.push(next);
            }
        }
        if (result.length !== this.nodes.size) throw new Error("context precedence graph contains a cycle");
        return result;
    }

    /** Select summaries under a token budget; details stay behind refs. */
    view(budgetTokens: number): ContextAstView {
        if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) throw new RangeError("budgetTokens must be positive");
        const ordered = this.order();
        const ranked = [...ordered].sort((left, right) => (right.salience ?? 0) - (left.salience ?? 0) || left.order - right.order);
        const selected = new Set<string>();
        let used = 0;
        const add = (node: ContextAstNode): boolean => {
            if (selected.has(node.id)) return true;
            const cost = estimateTokens(node.summary) + 6;
            if (used + cost > budgetTokens) return false;
            selected.add(node.id);
            used += cost;
            return true;
        };
        for (const node of ranked) {
            if (!add(node)) continue;
            for (const ancestor of this.ancestors(node.id)) add(ancestor);
        }
        const nodes = ordered.filter((node) => selected.has(node.id));
        const excluded = ordered.filter((node) => !selected.has(node.id));
        const lines = nodes.map((node) => {
            const depth = this.ancestors(node.id).length;
            const ref = node.detailRef === undefined ? "" : ` ref=${node.detailRef}`;
            return `${"  ".repeat(depth)}- [${node.kind}] ${node.id}: ${node.summary}${ref}`;
        });
        return {
            nodes,
            tokens: used,
            budgetTokens,
            excluded,
            refs: nodes.map((node) => node.detailRef).filter((ref): ref is string => ref !== undefined),
            text: lines.join("\n"),
        };
    }

    /** Baseline: summaries plus all details, no retrieval. */
    flat(store: DetailStore): { text: string; tokens: number } {
        const parts: string[] = [];
        for (const node of this.order()) {
            parts.push(`[${node.kind}] ${node.id}: ${node.summary}`);
            if (node.detailRef !== undefined) {
                const detail = store.get(node.detailRef);
                if (detail !== undefined) parts.push(detail);
            }
        }
        const text = parts.join("\n");
        return { text, tokens: estimateTokens(text) };
    }

    expand(nodeId: string, store: DetailStore): string | undefined {
        const node = this.nodes.get(nodeId);
        if (node?.detailRef === undefined) return undefined;
        return store.get(node.detailRef);
    }

    serialize(): { nodes: ContextAstNode[]; edges: ContextAstEdge[] } {
        return { nodes: [...this.nodes.values()], edges: [...this.edges] };
    }

    static restore(input: { nodes: readonly ContextAstNode[]; edges: readonly ContextAstEdge[] }): ContextAst {
        const ast = new ContextAst();
        for (const node of input.nodes) ast.add(node);
        for (const edge of input.edges) ast.link(edge);
        return ast;
    }
}
