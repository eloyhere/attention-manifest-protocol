/**
 * Dependency graph algorithms for the agent workspace.
 *
 * The graph is an adjacency-list view over `DependencyNode`/`DependencyEdge`
 * records. Nodes and edges keep insertion order, so every traversal and every
 * report is stable across runs for the same input. Cycles are legal: the graph
 * reports them as strongly connected components instead of deleting edges.
 *
 * The algorithms are iterative on purpose. A module graph can be deeper than the
 * JavaScript call stack, and a stack overflow while answering "what is the
 * topological order?" would turn a descriptive tool into an availability bug.
 */
import { Queue } from "../structure/queue.ts";
import { Stack } from "../structure/stack.ts";
import type { DependencyEdge, DependencyEdgeKind, DependencyMode, DependencyNode, DependencyReport, ImportEdge, ImportReport } from "./types.ts";

const DefaultClosureDepth: number = 3;
const DefaultClosureLimit: number = 500;
const MaxGraphLimit: number = 2000;
const MaxDepth: number = 10;

interface TarjanFrame {
    readonly id: string;
    next: number;
}

interface ClosureEntry {
    readonly id: string;
    readonly level: number;
}

type ClampInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number) => number;

type GraphViewFn = (graph: DependencyGraph, includeExternal: boolean) => DependencyGraph;

type ScopedGraphFn = (source: DependencyGraph, nodeIds: readonly string[], edges: readonly DependencyEdge[]) => DependencyGraph;

type ExternalCollector = (graph: DependencyGraph, selected: ReadonlySet<string>) => string[];

type BuildReportFn = (graph: DependencyGraph, revision: string, request: DependencyRequest) => DependencyReport;

type GraphFromImportsFn = (revision: string, files: readonly ImportReport[], includeExternal: boolean) => DependencyGraph;

/**
 * Result of a bounded graph closure.
 */
export interface DependencyClosure {
    readonly nodes: string[];
    readonly edges: DependencyEdge[];
    readonly truncated: boolean;
}

/**
 * Result of an induced subgraph selection.
 */
export interface DependencySubgraph {
    readonly nodes: DependencyNode[];
    readonly edges: DependencyEdge[];
}

/**
 * Result of a topological ordering. `order` is the emittable prefix; `cycles`
 * lists the cyclic components that blocked the rest of the graph.
 */
export interface TopologicalResult {
    readonly order: string[];
    readonly cycles: string[][];
}

/**
 * Dependency query request. `roots` are node ids; for `cycles`/`topological` an
 * empty list means the whole graph. `includeExternal` controls whether package
 * nodes appear as report nodes; package names are still listed in `external`.
 */
export interface DependencyRequest {
    readonly mode: DependencyMode;
    readonly roots?: readonly string[];
    readonly direction?: "dependencies" | "dependents";
    readonly depth?: number;
    readonly limit?: number;
    readonly includeExternal?: boolean;
}

const compareStrings: (left: string, right: string) => number = (left: string, right: string): number => {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
};

const clampInteger: ClampInteger = (value, fallback, minimum, maximum): number => {
    if (value === (void 0) || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

/**
 * Directed dependency graph with deterministic traversal order.
 *
 * Edges whose endpoints are not graph nodes are retained by {@link edges} so a
 * caller can diagnose them, but every algorithm ignores them: in particular,
 * Kahn in-degree counts only graph nodes, which keeps dangling edges from
 * permanently blocking a topological order.
 */
export class DependencyGraph {
    private readonly nodeMap: Map<string, DependencyNode> = new Map<string, DependencyNode>();
    private readonly edgeList: DependencyEdge[] = [];
    private readonly outgoing: Map<string, DependencyEdge[]> = new Map<string, DependencyEdge[]>();
    private readonly incoming: Map<string, DependencyEdge[]> = new Map<string, DependencyEdge[]>();

    /**
     * Add or replace one node. Replacing metadata does not change its position
     * in insertion order.
     */
    addNode(node: DependencyNode): void {
        this.nodeMap.set(node.id, node);
        if (!this.outgoing.has(node.id)) {
            this.outgoing.set(node.id, []);
        }
        if (!this.incoming.has(node.id)) {
            this.incoming.set(node.id, []);
        }
    }

    /**
     * Add one directed edge. Endpoints need not exist yet; they can be added
     * later without losing the adjacency entry.
     */
    addEdge(edge: DependencyEdge): void {
        this.edgeList.push(edge);
        const out: DependencyEdge[] | undefined = this.outgoing.get(edge.from);
        if (out === (void 0)) {
            this.outgoing.set(edge.from, [edge]);
        } else {
            out.push(edge);
        }
        const into: DependencyEdge[] | undefined = this.incoming.get(edge.to);
        if (into === (void 0)) {
            this.incoming.set(edge.to, [edge]);
        } else {
            into.push(edge);
        }
    }

    /**
     * Whether the graph contains a node with this id.
     */
    hasNode(id: string): boolean {
        return this.nodeMap.has(id);
    }

    /**
     * Look up one node, or `undefined` when absent.
     */
    node(id: string): DependencyNode | undefined {
        return this.nodeMap.get(id);
    }

    /**
     * All nodes in insertion order.
     */
    nodes(): DependencyNode[] {
        return [...this.nodeMap.values()];
    }

    /**
     * All edges in insertion order, including dangling edges.
     */
    edges(): DependencyEdge[] {
        return [...this.edgeList];
    }

    private hasSelfLoop(id: string): boolean {
        const outgoing: DependencyEdge[] | undefined = this.outgoing.get(id);
        if (outgoing === (void 0)) {
            return false;
        }
        return outgoing.some((edge: DependencyEdge): boolean => edge.from === id && edge.to === id);
    }

    /**
     * Compute strongly connected components with iterative Tarjan.
     *
     * Every node belongs to exactly one component, including acyclic singletons.
     * Each component is sorted lexicographically and the components are sorted
     * by their first element, which makes the result independent of traversal
     * order. A self-loop appears as a singleton component; {@link cycles} is the
     * filtered view that keeps it.
     */
    scc(): string[][] {
        const ids: string[] = [...this.nodeMap.keys()];
        const nodeIds: Set<string> = new Set<string>(ids);
        const successors: Map<string, string[]> = new Map<string, string[]>();
        for (let index: number = 0; index < ids.length; index += 1) {
            const id: string = ids[index];
            const seen: Set<string> = new Set<string>();
            const list: string[] = [];
            const outgoing: DependencyEdge[] = this.outgoing.get(id) ?? [];
            for (let edgeIndex: number = 0; edgeIndex < outgoing.length; edgeIndex += 1) {
                const target: string = outgoing[edgeIndex].to;
                if (!nodeIds.has(target) || seen.has(target)) {
                    continue;
                }
                seen.add(target);
                list.push(target);
            }
            successors.set(id, list);
        }
        const indices: Map<string, number> = new Map<string, number>();
        const lowlinks: Map<string, number> = new Map<string, number>();
        const onStack: Set<string> = new Set<string>();
        const stack: string[] = [];
        const components: string[][] = [];
        let nextIndex: number = 0;
        const open: (id: string) => void = (id: string): void => {
            indices.set(id, nextIndex);
            lowlinks.set(id, nextIndex);
            nextIndex += 1;
            stack.push(id);
            onStack.add(id);
        };
        for (let rootIndex: number = 0; rootIndex < ids.length; rootIndex += 1) {
            const root: string = ids[rootIndex];
            if (indices.has(root)) {
                continue;
            }
            open(root);
            const frames: Stack<TarjanFrame> = new Stack<TarjanFrame>();
            frames.push({ id: root, next: 0 });
            while (!frames.isEmpty) {
                const frame: TarjanFrame | undefined = frames.peek();
                if (frame === (void 0)) {
                    break;
                }
                const targets: string[] = successors.get(frame.id) ?? [];
                if (frame.next < targets.length) {
                    const target: string = targets[frame.next];
                    frame.next += 1;
                    if (!indices.has(target)) {
                        open(target);
                        frames.push({ id: target, next: 0 });
                    } else if (onStack.has(target)) {
                        const targetIndex: number = indices.get(target) as number;
                        const currentLow: number = lowlinks.get(frame.id) as number;
                        if (targetIndex < currentLow) {
                            lowlinks.set(frame.id, targetIndex);
                        }
                    }
                    continue;
                }
                frames.pop();
                const parent: TarjanFrame | undefined = frames.peek();
                if (parent !== (void 0)) {
                    const parentLow: number = lowlinks.get(parent.id) as number;
                    const childLow: number = lowlinks.get(frame.id) as number;
                    if (childLow < parentLow) {
                        lowlinks.set(parent.id, childLow);
                    }
                }
                if (lowlinks.get(frame.id) === indices.get(frame.id)) {
                    const component: string[] = [];
                    while (stack.length > 0) {
                        const member: string = stack.pop() as string;
                        onStack.delete(member);
                        component.push(member);
                        if (member === frame.id) {
                            break;
                        }
                    }
                    component.sort(compareStrings);
                    components.push(component);
                }
            }
        }
        components.sort((left: string[], right: string[]): number => compareStrings(left[0], right[0]));
        return components;
    }

    /**
     * Strongly connected components that contain a cycle: more than one node,
     * or a singleton with a self-loop.
     */
    cycles(): string[][] {
        const result: string[][] = [];
        const components: string[][] = this.scc();
        for (let index: number = 0; index < components.length; index += 1) {
            const component: string[] = components[index];
            if (component.length > 1 || this.hasSelfLoop(component[0])) {
                result.push(component);
            }
        }
        return result;
    }

    /**
     * Deterministic Kahn ordering. In-degree counts only edges whose endpoints
     * are both graph nodes. When the graph is cyclic, `order` is the full prefix
     * that could be emitted and `cycles` lists the blocking components.
     */
    topological(): TopologicalResult {
        const ids: string[] = [...this.nodeMap.keys()];
        const inDegree: Map<string, number> = new Map<string, number>();
        for (let index: number = 0; index < ids.length; index += 1) {
            inDegree.set(ids[index], 0);
        }
        for (let index: number = 0; index < this.edgeList.length; index += 1) {
            const edge: DependencyEdge = this.edgeList[index];
            if (!this.nodeMap.has(edge.from) || !this.nodeMap.has(edge.to)) {
                continue;
            }
            inDegree.set(edge.to, (inDegree.get(edge.to) as number) + 1);
        }
        const ready: Queue<string> = new Queue<string>();
        for (let index: number = 0; index < ids.length; index += 1) {
            if (inDegree.get(ids[index]) === 0) {
                ready.enqueue(ids[index]);
            }
        }
        const order: string[] = [];
        while (!ready.isEmpty) {
            const id: string = ready.dequeue() as string;
            order.push(id);
            const outgoing: DependencyEdge[] = this.outgoing.get(id) ?? [];
            for (let index: number = 0; index < outgoing.length; index += 1) {
                const edge: DependencyEdge = outgoing[index];
                if (!this.nodeMap.has(edge.to)) {
                    continue;
                }
                const remaining: number = (inDegree.get(edge.to) as number) - 1;
                inDegree.set(edge.to, remaining);
                if (remaining === 0) {
                    ready.enqueue(edge.to);
                }
            }
        }
        return { order, cycles: order.length === ids.length ? [] : this.cycles() };
    }

    /**
     * Breadth-first closure from `roots`.
     *
     * Traversal follows outgoing edges for `dependencies` and incoming edges for
     * `dependents`. Nodes are emitted in discovery order; `limit` bounds the
     * node count (not edge count), and `truncated` is set when a reachable node
     * was left out. Only edges traversed from a node at depth `< depth` are
     * returned, so the result is the actual bounded BFS subgraph rather than an
     * unbounded induced subgraph. Unknown roots are ignored.
     */
    closure(roots: readonly string[], direction: "dependencies" | "dependents", depth: number, limit: number): DependencyClosure {
        const maxDepth: number = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : Number.POSITIVE_INFINITY;
        const maxNodes: number = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
        const selected: Set<string> = new Set<string>();
        const nodes: string[] = [];
        const edges: DependencyEdge[] = [];
        const queue: Queue<ClosureEntry> = new Queue<ClosureEntry>();
        let truncated: boolean = false;
        for (let index: number = 0; index < roots.length; index += 1) {
            const root: string = roots[index];
            if (!this.hasNode(root) || selected.has(root)) {
                continue;
            }
            if (nodes.length >= maxNodes) {
                truncated = true;
                continue;
            }
            selected.add(root);
            nodes.push(root);
            queue.enqueue({ id: root, level: 0 });
        }
        while (!queue.isEmpty) {
            const entry: ClosureEntry = queue.dequeue() as ClosureEntry;
            if (entry.level >= maxDepth) {
                continue;
            }
            const adjacency: DependencyEdge[] | undefined = direction === "dependencies" ? this.outgoing.get(entry.id) : this.incoming.get(entry.id);
            if (adjacency === (void 0)) {
                continue;
            }
            for (let index: number = 0; index < adjacency.length; index += 1) {
                const edge: DependencyEdge = adjacency[index];
                const target: string = direction === "dependencies" ? edge.to : edge.from;
                if (!this.hasNode(target)) {
                    continue;
                }
                if (!selected.has(target)) {
                    if (nodes.length >= maxNodes) {
                        truncated = true;
                        continue;
                    }
                    selected.add(target);
                    nodes.push(target);
                    queue.enqueue({ id: target, level: entry.level + 1 });
                }
                edges.push(edge);
            }
        }
        return { nodes, edges, truncated };
    }

    /**
     * Induced subgraph over the given ids. Unknown ids are ignored and duplicate
     * ids keep their first position; edges are returned in graph insertion order.
     */
    subgraph(nodeIds: readonly string[]): DependencySubgraph {
        const nodes: DependencyNode[] = [];
        const selected: Set<string> = new Set<string>();
        for (let index: number = 0; index < nodeIds.length; index += 1) {
            const id: string = nodeIds[index];
            if (selected.has(id)) {
                continue;
            }
            const node: DependencyNode | undefined = this.nodeMap.get(id);
            if (node === (void 0)) {
                continue;
            }
            selected.add(id);
            nodes.push(node);
        }
        const edges: DependencyEdge[] = [];
        for (let index: number = 0; index < this.edgeList.length; index += 1) {
            const edge: DependencyEdge = this.edgeList[index];
            if (selected.has(edge.from) && selected.has(edge.to)) {
                edges.push(edge);
            }
        }
        return { nodes, edges };
    }
}

const visibleGraph: GraphViewFn = (graph, includeExternal): DependencyGraph => {
    const view: DependencyGraph = new DependencyGraph();
    const nodes: DependencyNode[] = graph.nodes();
    for (let index: number = 0; index < nodes.length; index += 1) {
        const node: DependencyNode = nodes[index];
        if (includeExternal || node.kind !== "package") {
            view.addNode(node);
        }
    }
    const edges: DependencyEdge[] = graph.edges();
    for (let index: number = 0; index < edges.length; index += 1) {
        const edge: DependencyEdge = edges[index];
        if (view.hasNode(edge.from) && view.hasNode(edge.to)) {
            view.addEdge(edge);
        }
    }
    return view;
};

const scopedGraph: ScopedGraphFn = (source, nodeIds, edges): DependencyGraph => {
    const scoped: DependencyGraph = new DependencyGraph();
    for (let index: number = 0; index < nodeIds.length; index += 1) {
        const node: DependencyNode | undefined = source.node(nodeIds[index]);
        if (node !== (void 0)) {
            scoped.addNode(node);
        }
    }
    for (let index: number = 0; index < edges.length; index += 1) {
        scoped.addEdge(edges[index]);
    }
    return scoped;
};

const collectExternal: ExternalCollector = (graph, selected): string[] => {
    const values: string[] = [];
    const seen: Set<string> = new Set<string>();
    const add: (value: string) => void = (value: string): void => {
        if (value.length === 0 || seen.has(value)) {
            return;
        }
        seen.add(value);
        values.push(value);
    };
    const selectedIds: string[] = [...selected];
    for (let index: number = 0; index < selectedIds.length; index += 1) {
        const node: DependencyNode | undefined = graph.node(selectedIds[index]);
        if (node !== (void 0) && node.kind === "package") {
            add(node.path.length > 0 ? node.path : node.id);
        }
    }
    const edges: DependencyEdge[] = graph.edges();
    for (let index: number = 0; index < edges.length; index += 1) {
        const edge: DependencyEdge = edges[index];
        if (selected.has(edge.from)) {
            const target: DependencyNode | undefined = graph.node(edge.to);
            if (target !== (void 0) && target.kind === "package") {
                add(target.path.length > 0 ? target.path : target.id);
            }
        }
        if (selected.has(edge.to)) {
            const source: DependencyNode | undefined = graph.node(edge.from);
            if (source !== (void 0) && source.kind === "package") {
                add(source.path.length > 0 ? source.path : source.id);
            }
        }
    }
    values.sort(compareStrings);
    return values;
};

/**
 * Build a bounded dependency report for one request.
 *
 * `cycles` and `topological` operate on the whole graph when `roots` is empty,
 * and otherwise on the subgraph reachable from the roots. `dependencies`,
 * `dependents` and `closure` run a bounded BFS with a default depth of 3 and a
 * default node limit of 500. Package nodes are hidden unless
 * `includeExternal` is explicitly true, but their names remain in `external`.
 * `unresolved` is always empty: import extraction owns that list, because the
 * dependency graph only stores edges that were resolved enough to be nodes.
 *
 * @param graph - Dependency graph to query.
 * @param revision - Workspace revision copied into the report.
 * @param request - Query mode and bounds.
 * @returns Complete report with every field populated.
 */
export const buildDependencyReport: BuildReportFn = (graph, revision, request): DependencyReport => {
    const includeExternal: boolean = request.includeExternal === true;
    const view: DependencyGraph = visibleGraph(graph, includeExternal);
    const roots: string[] = [];
    const seenRoots: Set<string> = new Set<string>();
    const requestedRoots: readonly string[] = request.roots ?? [];
    for (let index: number = 0; index < requestedRoots.length; index += 1) {
        const root: string = requestedRoots[index];
        if (graph.hasNode(root) && !seenRoots.has(root)) {
            seenRoots.add(root);
            roots.push(root);
        }
    }
    const graphLimit: number = request.limit === (void 0) ? MaxGraphLimit : clampInteger(request.limit, MaxGraphLimit, 1, MaxGraphLimit);
    const closureLimit: number = clampInteger(request.limit, DefaultClosureLimit, 1, MaxGraphLimit);
    const selectedIds: string[] = [];
    const reportEdges: DependencyEdge[] = [];
    const order: string[] = [];
    const cycles: string[][] = [];
    let truncated: boolean = false;
    if (request.mode === "cycles" || request.mode === "topological") {
        if (requestedRoots.length === 0) {
            const visibleIds: string[] = view.nodes().map((node: DependencyNode): string => node.id);
            const take: number = Math.min(visibleIds.length, graphLimit);
            for (let index: number = 0; index < take; index += 1) {
                selectedIds.push(visibleIds[index]);
            }
            truncated = visibleIds.length > take;
        } else {
            const reachable: DependencyClosure = view.closure(roots, "dependencies", Number.POSITIVE_INFINITY, graphLimit);
            for (let index: number = 0; index < reachable.nodes.length; index += 1) {
                selectedIds.push(reachable.nodes[index]);
            }
            truncated = reachable.truncated;
        }
        const induced: DependencySubgraph = view.subgraph(selectedIds);
        for (let index: number = 0; index < induced.edges.length; index += 1) {
            reportEdges.push(induced.edges[index]);
        }
        const scoped: DependencyGraph = scopedGraph(view, selectedIds, reportEdges);
        if (request.mode === "cycles") {
            cycles.push(...scoped.cycles());
        } else {
            const topological: TopologicalResult = scoped.topological();
            order.push(...topological.order);
            cycles.push(...topological.cycles);
        }
    } else {
        const direction: "dependencies" | "dependents" =
            request.mode === "dependents" ? "dependents" : request.mode === "dependencies" ? "dependencies" : (request.direction ?? "dependencies");
        const depth: number = clampInteger(request.depth, DefaultClosureDepth, 0, MaxDepth);
        const result: DependencyClosure = view.closure(roots, direction, depth, closureLimit);
        for (let index: number = 0; index < result.nodes.length; index += 1) {
            selectedIds.push(result.nodes[index]);
        }
        for (let index: number = 0; index < result.edges.length; index += 1) {
            reportEdges.push(result.edges[index]);
        }
        truncated = result.truncated;
    }
    const reportNodes: DependencyNode[] = [];
    const selected: Set<string> = new Set<string>(selectedIds);
    for (let index: number = 0; index < selectedIds.length; index += 1) {
        const node: DependencyNode | undefined = graph.node(selectedIds[index]);
        if (node !== (void 0)) {
            reportNodes.push(node);
        }
    }
    return {
        revision,
        mode: request.mode,
        roots,
        nodes: reportNodes,
        edges: reportEdges,
        order,
        cycles,
        unresolved: [],
        external: collectExternal(graph, selected),
        truncated,
    };
};

/**
 * Build a graph from import reports.
 *
 * File nodes use the root-relative path as id. External imports become package
 * nodes with id `external:<specifier>` and the bare specifier as path, so two
 * files importing the same package share one node. Unresolved internal edges are
 * omitted: a missing target has no node to attach to, and the import report
 * already lists the specifier as unresolved. The revision argument is accepted
 * for symmetry with the service layer; graph identity itself is revision-free.
 *
 * @param revision - Workspace revision, reserved for the caller.
 * @param files - Import reports for the files in scope.
 * @param includeExternal - Whether package nodes and their edges are included.
 * @returns Populated dependency graph.
 */
export const graphFromImports: GraphFromImportsFn = (revision, files, includeExternal): DependencyGraph => {
    void revision;
    const graph: DependencyGraph = new DependencyGraph();
    for (let index: number = 0; index < files.length; index += 1) {
        const report: ImportReport = files[index];
        graph.addNode({ id: report.path, path: report.path, kind: "file", fingerprint: report.fingerprint });
    }
    for (let fileIndex: number = 0; fileIndex < files.length; fileIndex += 1) {
        const report: ImportReport = files[fileIndex];
        for (let edgeIndex: number = 0; edgeIndex < report.imports.length; edgeIndex += 1) {
            const edge: ImportEdge = report.imports[edgeIndex];
            const kind: DependencyEdgeKind = edge.kind === "export-from" ? "export" : "import";
            if (edge.external) {
                if (!includeExternal) {
                    continue;
                }
                const id: string = `external:${edge.specifier}`;
                if (!graph.hasNode(id)) {
                    graph.addNode({ id, path: edge.specifier, kind: "package", fingerprint: "" });
                }
                graph.addEdge({ from: report.path, to: id, kind, specifier: edge.specifier, line: edge.line });
                continue;
            }
            if (!edge.resolved) {
                continue;
            }
            graph.addEdge({ from: report.path, to: edge.to, kind, specifier: edge.specifier, line: edge.line });
        }
    }
    return graph;
};
