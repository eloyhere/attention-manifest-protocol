/**
 * Context AST: tree structure + precedence edges, summaries in the prompt,
 * detailed content behind local refs. This is a view over context, not a new
 * runtime. It can be rendered to text or paged through the existing window.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { estimateTokens } from "./agentContext.ts";
import { PriorityQueue } from "../structure/priority.ts";
import { Queue } from "../structure/queue.ts";
import { storedFile } from "./fileStorePath.ts";

export type ContextNodeKind =
    | "goal"
    | "frame"
    | "turn"
    | "observation"
    | "evidence"
    | "hypothesis"
    | "decision"
    | "detail"
    | "project"
    | "directory"
    | "file"
    | "symbol"
    | "package"
    | "knowledge";

export interface ContextAstNode {
    readonly id: string;
    readonly parentId?: string;
    kind: ContextNodeKind;
    summary: string;
    detailRef?: string;
    detailTokens?: number;
    order: number;
    salience?: number;
    createdAt?: string;
}

export type ContextEdgeKind =
    "before" | "after" | "depends" | "supports" | "contradicts" | "project_depends_on" | "imports" | "calls" | "references" | "documents";

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
    relations: ContextAstEdge[];
    unresolvedDependencies: ContextAstEdge[];
    omissions: ContextOmission[];
    text: string;
}

export interface ContextOmission {
    id: string;
    reason: "budget" | "missing_parent";
    requiredIds: string[];
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

export class FileDetailStore implements DetailStore {
    private readonly dir: string;

    constructor(dir: string) {
        mkdirSync(dir, { recursive: true });
        this.dir = realpathSync(dir);
    }

    put(id: string, content: string): string {
        const hash: string = createHash("sha256").update(id).digest("hex");
        const ref: string = join(this.dir, `${hash}.txt`);
        if (storedFile(this.dir, ref) === (void 0)) {
            writeFileSync(ref, content, { encoding: "utf8", flag: "wx" });
            return ref;
        }
        writeFileSync(ref, content, "utf8");
        return ref;
    }

    get(ref: string): string | undefined {
        const path: string | undefined = storedFile(this.dir, ref);
        if (path === (void 0)) {
            return undefined;
        }
        return readFileSync(path, "utf8");
    }
}

export class ContextAst {
    private readonly nodes = new Map<string, ContextAstNode>();
    private readonly edges: ContextAstEdge[] = [];
    private readonly childrenOf = new Map<string, string[]>();
    private readonly incoming = new Map<string, Map<ContextEdgeKind, ContextAstEdge[]>>();
    private readonly outgoing = new Map<string, Map<ContextEdgeKind, ContextAstEdge[]>>();
    private readonly precedenceOutgoing = new Map<string, ContextAstEdge[]>();
    private readonly insertionOrder = new Map<string, number>();

    get size(): number {
        return this.nodes.size;
    }

    add(node: ContextAstNode): this {
        if (this.nodes.has(node.id)) {
            throw new Error(`duplicate context node ${node.id}`);
        }
        /**
         * Parents may arrive later (including during restore), but never close a cycle.
         */
        let parent: string | undefined = node.parentId;
        const seen: Set<string> = new Set<string>();
        while (parent !== (void 0) && !seen.has(parent)) {
            if (parent === node.id) {
                throw new Error("context hierarchy contains a cycle");
            }
            seen.add(parent);
            parent = this.nodes.get(parent)?.parentId;
        }
        this.insertionOrder.set(node.id, this.nodes.size);
        const storedNode: ContextAstNode = { ...node };
        Object.defineProperties(storedNode, {
            id: { value: node.id, enumerable: true, writable: false, configurable: false },
            parentId: { value: node.parentId, enumerable: true, writable: false, configurable: false },
        });
        this.nodes.set(node.id, storedNode);
        if (node.parentId !== (void 0)) {
            const children = this.childrenOf.get(node.parentId) ?? [];
            children.push(node.id);
            this.childrenOf.set(node.parentId, children);
        }
        return this;
    }

    link(edge: ContextAstEdge): this {
        if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
            throw new Error(`edge references unknown node: ${edge.from}->${edge.to}`);
        }
        const stored: ContextAstEdge = { ...edge };
        this.edges.push(stored);
        this.indexEdge(this.outgoing, stored.from, stored);
        this.indexEdge(this.incoming, stored.to, stored);
        if (stored.kind === "before" || stored.kind === "depends") {
            const successors: ContextAstEdge[] = this.precedenceOutgoing.get(stored.from) ?? [];
            successors.push(stored);
            this.precedenceOutgoing.set(stored.from, successors);
        }
        return this;
    }

    /**
     * Indexed one-hop relations; results cannot mutate the stored edges.
     */
    relations(id: string, direction: "incoming" | "outgoing", kind?: ContextEdgeKind): ContextAstEdge[] {
        const groups: Map<ContextEdgeKind, ContextAstEdge[]> | undefined = (direction === "incoming" ? this.incoming : this.outgoing).get(id);
        const edges: ContextAstEdge[] = kind === (void 0) ? [...(groups?.values() ?? [])].flat() : (groups?.get(kind) ?? []);
        return edges.map((edge: ContextAstEdge): ContextAstEdge => ({ ...edge }));
    }

    private indexEdge(index: Map<string, Map<ContextEdgeKind, ContextAstEdge[]>>, id: string, edge: ContextAstEdge): void {
        let groups: Map<ContextEdgeKind, ContextAstEdge[]> | undefined = index.get(id);
        if (groups === (void 0)) {
            groups = new Map<ContextEdgeKind, ContextAstEdge[]>();
            index.set(id, groups);
        }
        const edges: ContextAstEdge[] = groups.get(edge.kind) ?? [];
        edges.push(edge);
        groups.set(edge.kind, edges);
    }

    node(id: string): ContextAstNode | undefined {
        return this.nodes.get(id);
    }

    children(id: string): ContextAstNode[] {
        return (this.childrenOf.get(id) ?? []).map((child) => this.nodes.get(child)).filter((node): node is ContextAstNode => node !== (void 0));
    }

    ancestors(id: string): ContextAstNode[] {
        const result: ContextAstNode[] = [];
        let current = this.nodes.get(id)?.parentId;
        const seen = new Set<string>();
        while (current !== (void 0) && !seen.has(current)) {
            seen.add(current);
            const node = this.nodes.get(current);
            if (node === (void 0)) {
                break;
            }
            result.push(node);
            current = node.parentId;
        }
        return result.reverse();
    }

    descendants(id: string): ContextAstNode[] {
        const result: ContextAstNode[] = [];
        const stack = [...(this.childrenOf.get(id) ?? [])];
        const seen: Set<string> = new Set<string>([id]);
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === (void 0) || seen.has(current)) {
                continue;
            }
            seen.add(current);
            const node = this.nodes.get(current);
            if (node === (void 0)) {
                continue;
            }
            result.push(node);
            stack.push(...(this.childrenOf.get(current) ?? []));
        }
        return result;
    }

    /**
     * Precedence order; `before`/`depends` constrain the order (from -> to).
     * Optional IDs induce a subgraph: external dependencies do not widen scope.
     * Initial ready nodes use node insertion order; released nodes use link order.
     */
    order(nodeIds?: readonly string[]): ContextAstNode[] {
        const candidates: string[] =
            nodeIds === (void 0)
                ? [...this.nodes.keys()]
                : [...new Set(nodeIds)]
                      .filter((id: string): boolean => this.nodes.has(id))
                      .sort((left: string, right: string): number => this.insertionOrder.get(left)! - this.insertionOrder.get(right)!);
        const indegree: Map<string, number> = new Map<string, number>();
        for (let index: number = 0; index < candidates.length; index += 1) {
            const id: string = candidates[index];
            indegree.set(id, 0);
        }
        const kinds: ContextEdgeKind[] = ["before", "depends"];
        for (let index: number = 0; index < candidates.length; index += 1) {
            const id: string = candidates[index];
            for (let kindIndex: number = 0; kindIndex < kinds.length; kindIndex += 1) {
                const edges: ContextAstEdge[] = this.incoming.get(id)?.get(kinds[kindIndex]) ?? [];
                for (let edgeIndex: number = 0; edgeIndex < edges.length; edgeIndex += 1) {
                    const edge: ContextAstEdge = edges[edgeIndex];
                    if (!indegree.has(edge.from)) {
                        continue;
                    }
                    indegree.set(edge.to, indegree.get(edge.to)! + 1);
                }
            }
        }
        const queue: Queue<string> = new Queue(candidates.filter((id: string): boolean => indegree.get(id) === 0));
        const result: ContextAstNode[] = [];
        while (!queue.isEmpty) {
            const id: string = queue.dequeue() as string;
            const node: ContextAstNode | undefined = this.nodes.get(id);
            if (node !== (void 0)) {
                result.push(node);
            }
            const edges: ContextAstEdge[] = this.precedenceOutgoing.get(id) ?? [];
            for (let edgeIndex: number = 0; edgeIndex < edges.length; edgeIndex += 1) {
                const edge: ContextAstEdge = edges[edgeIndex];
                const next: string = edge.to;
                if (!indegree.has(next)) {
                    continue;
                }
                indegree.set(next, (indegree.get(next) ?? 0) - 1);
                if ((indegree.get(next) ?? 0) === 0) {
                    queue.enqueue(next);
                }
            }
        }
        if (result.length !== candidates.length) {
            throw new Error("context precedence graph contains a cycle");
        }
        return result;
    }

    /**
     * Select ancestor/dependency bundles under a token budget; details stay in CAS.
     * Targets restrict eligibility; dependencies outside it are reported, not read.
     * Nodes and explicit relation lines are charged before a bundle is committed,
     * so admission never relies on the final text length. The returned `tokens`
     * is the rendered-text estimate (0 when nothing was selected); it never
     * exceeds the admission charge or the budget.
     */
    view(budgetTokens: number, targetIds?: readonly string[]): ContextAstView {
        if (!Number.isSafeInteger(budgetTokens) || budgetTokens <= 0) {
            throw new RangeError("budgetTokens must be positive");
        }
        const eligible: Set<string> | undefined = targetIds === (void 0) ? (void 0) : new Set<string>();
        (targetIds ?? []).forEach((id: string): void => {
            let current: string | undefined = id;
            while (current !== (void 0) && !eligible!.has(current)) {
                eligible!.add(current);
                current = this.nodes.get(current)?.parentId;
            }
        });
        const ordered: ContextAstNode[] = this.order(eligible === (void 0) ? (void 0) : [...eligible]);
        /**
         * Per-view caches observe current summaries/refs without long-lived invalidation.
         */
        const depths: Map<string, number> = new Map<string, number>();
        const rendered: Map<string, string> = new Map<string, string>();
        const depthOf: (node: ContextAstNode) => number = (node: ContextAstNode): number => {
            const path: ContextAstNode[] = [];
            const seen: Set<string> = new Set<string>();
            let current: ContextAstNode | undefined = node;
            while (current !== (void 0) && !depths.has(current.id)) {
                if (seen.has(current.id)) {
                    throw new Error("context hierarchy contains a cycle");
                }
                seen.add(current.id);
                path.push(current);
                current = current.parentId === (void 0) ? (void 0) : this.nodes.get(current.parentId);
            }
            let depth: number = current === (void 0) ? -1 : depths.get(current.id)!;
            while (path.length > 0) {
                depth += 1;
                depths.set(path.pop()!.id, depth);
            }
            return depths.get(node.id)!;
        };
        const render: (node: ContextAstNode) => string = (node: ContextAstNode): string => {
            const cached: string | undefined = rendered.get(node.id);
            if (cached !== (void 0)) {
                return cached;
            }
            const ref: string = node.detailRef === (void 0) ? "" : ` ref=${node.detailRef}`;
            const line: string = `${"  ".repeat(depthOf(node))}- [${node.kind}] ${node.id}: ${node.summary}${ref}`;
            rendered.set(node.id, line);
            return line;
        };
        const queue: PriorityQueue<ContextAstNode> = new PriorityQueue<ContextAstNode>({
            values: ordered,
            compare: (left, right) => (left.salience ?? 0) - (right.salience ?? 0),
        });
        const candidates: Set<string> = new Set(ordered.map((node: ContextAstNode): string => node.id));
        const selected: Set<string> = new Set<string>();
        const relations: Map<string, ContextAstEdge> = new Map<string, ContextAstEdge>();
        const gaps: Map<string, ContextAstEdge> = new Map<string, ContextAstEdge>();
        const omissions: Map<string, ContextOmission> = new Map<string, ContextOmission>();
        const edgeKey: (edge: ContextAstEdge) => string = (edge: ContextAstEdge): string => JSON.stringify([edge.kind, edge.from, edge.to]);
        const renderEdge: (edge: ContextAstEdge, unresolved?: boolean) => string = (edge: ContextAstEdge, unresolved: boolean = false): string =>
            `- [relation:${edge.kind}] ${JSON.stringify(edge.from)} -> ${JSON.stringify(edge.to)}${unresolved ? " (outside_scope; prerequisite unavailable)" : ""}`;
        let used: number = 0;
        while (!queue.isEmpty) {
            const node: ContextAstNode | undefined = queue.dequeue();
            if (node === (void 0)) {
                break;
            }
            if (selected.has(node.id)) {
                continue;
            }
            const bundle: Map<string, ContextAstNode> = new Map<string, ContextAstNode>();
            const missingParents: Set<string> = new Set<string>();
            const pending: string[] = [node.id];
            while (pending.length > 0) {
                const id: string = pending.pop() as string;
                if (selected.has(id) || bundle.has(id)) {
                    continue;
                }
                const member: ContextAstNode | undefined = this.nodes.get(id);
                if (member === (void 0)) {
                    missingParents.add(id);
                    continue;
                }
                bundle.set(id, member);
                if (member.parentId !== (void 0)) {
                    pending.push(member.parentId);
                }
                (this.incoming.get(id)?.get("depends") ?? []).forEach((edge: ContextAstEdge): void => {
                    if (candidates.has(edge.from)) {
                        pending.push(edge.from);
                    }
                });
            }
            if (missingParents.size > 0) {
                omissions.set(node.id, { id: node.id, reason: "missing_parent", requiredIds: [...missingParents] });
                continue;
            }
            const newRelations: Map<string, ContextAstEdge> = new Map<string, ContextAstEdge>();
            const newGaps: Map<string, ContextAstEdge> = new Map<string, ContextAstEdge>();
            const included: (id: string) => boolean = (id: string): boolean => selected.has(id) || bundle.has(id);
            let cost: number = 0;
            bundle.forEach((member: ContextAstNode): void => {
                cost += estimateTokens(`${render(member)}\n`);
                const adjacent: ContextAstEdge[] = [
                    ...(this.incoming.get(member.id)?.values() ?? []),
                    ...(this.outgoing.get(member.id)?.values() ?? []),
                ].flat();
                adjacent.forEach((edge: ContextAstEdge): void => {
                    const key: string = edgeKey(edge);
                    if (included(edge.from) && included(edge.to)) {
                        if (!relations.has(key) && !newRelations.has(key)) {
                            newRelations.set(key, edge);
                            cost += estimateTokens(`${renderEdge(edge)}\n`);
                        }
                    } else if (edge.kind === "depends" && included(edge.to) && !candidates.has(edge.from) && !gaps.has(key) && !newGaps.has(key)) {
                        newGaps.set(key, edge);
                        cost += estimateTokens(`${renderEdge(edge, true)}\n`);
                    }
                });
            });
            if (used + cost > budgetTokens) {
                omissions.set(node.id, { id: node.id, reason: "budget", requiredIds: [...bundle.keys()] });
                continue;
            }
            bundle.forEach((member: ContextAstNode): void => {
                selected.add(member.id);
            });
            newRelations.forEach((edge: ContextAstEdge, key: string): void => {
                relations.set(key, edge);
            });
            newGaps.forEach((edge: ContextAstEdge, key: string): void => {
                gaps.set(key, edge);
            });
            used += cost;
        }
        const nodes: ContextAstNode[] = ordered.filter((node) => selected.has(node.id));
        const excluded: ContextAstNode[] = ordered.filter((node) => !selected.has(node.id));
        const lines: string[] = [
            ...nodes.map(render),
            ...[...relations.values()].map((edge: ContextAstEdge): string => renderEdge(edge)),
            ...[...gaps.values()].map((edge: ContextAstEdge): string => renderEdge(edge, true)),
        ];
        const text: string = lines.join("\n");
        return {
            nodes,
            /**
             * Admission still uses the conservative per-line charge in `used`;
             * the reported figure is the rendered text's estimate, so a caller
             * that budgets by `view.tokens` is not over-charged for the
             * trailing separator each line was charged for.
             */
            tokens: text.length === 0 ? 0 : estimateTokens(text),
            budgetTokens,
            excluded,
            refs: nodes.map((node) => node.detailRef).filter((ref): ref is string => ref !== (void 0)),
            relations: [...relations.values()].map((edge: ContextAstEdge): ContextAstEdge => ({ ...edge })),
            unresolvedDependencies: [...gaps.values()].map((edge: ContextAstEdge): ContextAstEdge => ({ ...edge })),
            omissions: excluded.map((node: ContextAstNode): ContextOmission => omissions.get(node.id) as ContextOmission),
            text,
        };
    }

    /**
     * Baseline: summaries plus all details, no retrieval.
     */
    flat(store: DetailStore): { text: string; tokens: number } {
        const parts: string[] = [];
        for (const node of this.order()) {
            parts.push(`[${node.kind}] ${node.id}: ${node.summary}`);
            if (node.detailRef !== (void 0)) {
                const detail = store.get(node.detailRef);
                if (detail !== (void 0)) {
                    parts.push(detail);
                }
            }
        }
        const text = parts.join("\n");
        return { text, tokens: estimateTokens(text) };
    }

    expand(nodeId: string, store: DetailStore): string | undefined {
        const node = this.nodes.get(nodeId);
        if (node?.detailRef === (void 0)) {
            return undefined;
        }
        return store.get(node.detailRef);
    }

    serialize(): { nodes: ContextAstNode[]; edges: ContextAstEdge[] } {
        return {
            nodes: [...this.nodes.values()].map((node: ContextAstNode): ContextAstNode => ({ ...node })),
            edges: this.edges.map((edge: ContextAstEdge): ContextAstEdge => ({ ...edge })),
        };
    }

    static restore(input: { nodes: readonly ContextAstNode[]; edges: readonly ContextAstEdge[] }): ContextAst {
        const ast = new ContextAst();
        for (const node of input.nodes) {
            ast.add(node);
        }
        for (const edge of input.edges) {
            ast.link(edge);
        }
        return ast;
    }
}
