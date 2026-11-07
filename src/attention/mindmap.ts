import type { MindMapAnchor, MindMapEdgeKind, MindMapGraph, MindMapNode } from "../project/mindmap.ts";

/**
 * L3 mind-map routing (§11.9).
 *
 * Routing starts at an explicit center, expands at most one or two layers and
 * ranks discovered nodes by their own score, preferring high-score anchors for
 * expansion. It returns candidates (`nodeId`) together with the exact path that
 * reached them and the association reason for every hop.
 *
 * The project mind-map types are imported type-only so this layer reads the
 * existing projection contract without depending on project runtime code and
 * without adding cross-directory changes.
 */

export interface MindMapRouteLimits {
    /** Layers below the center to expand; §11.9 allows only one or two. */
    readonly maxDepth: number;
    /** Maximum candidates returned after score ranking; omitted means all discovered. */
    readonly maxCandidates?: number;
    /** Maximum nodes whose neighbours are expanded. */
    readonly maxVisited?: number;
    /** Maximum neighbours considered per expanded node, highest score first. */
    readonly maxSiblings?: number;
    /** Maximum association edges inspected while expanding. */
    readonly maxEdges?: number;
    /** Candidates below this score are pruned after the walk. */
    readonly minScore?: number;
}

/** A hierarchy child hop or one of the project's cross-branch association kinds. */
export type MindMapRouteVia = "child" | MindMapEdgeKind;

export interface MindMapRouteCandidate {
    readonly nodeId: string;
    readonly topic: string;
    readonly summary?: string;
    readonly anchor?: MindMapAnchor;
    /** 1 or 2 (the center itself is not a candidate). */
    readonly depth: number;
    /** The node's own score; missing scores normalize to 0. */
    readonly score: number;
    /** Sum of node scores and association weights along `path`. */
    readonly pathScore: number;
    /** Center-to-node node ids, inclusive. */
    readonly path: readonly string[];
    readonly via: MindMapRouteVia;
    /** Hierarchy explanation or the association edge's mandatory reason. */
    readonly reason: string;
    readonly authorization: "not_granted";
}

export interface MindMapRouteStats {
    readonly expanded: number;
    readonly visited: number;
    readonly inspectedEdges: number;
    readonly prunedBySiblings: number;
    readonly prunedByScore: number;
    readonly prunedByCandidates: number;
}

export interface MindMapRoute {
    readonly version: "attention-mindmap-route/1";
    readonly center: string;
    readonly candidates: readonly MindMapRouteCandidate[];
    readonly visited: readonly string[];
    /** Path of the highest-scoring candidate, or `[center]` when nothing qualified. */
    readonly bestPath: readonly string[];
    readonly stoppedBy: "complete" | "candidates" | "visited" | "edges";
    readonly stats: MindMapRouteStats;
    readonly authorization: "not_granted";
}

interface Neighbor {
    readonly node: MindMapNode;
    readonly via: MindMapRouteVia;
    readonly reason: string;
    readonly weight: number;
}

interface Frame {
    readonly node: MindMapNode;
    readonly depth: number;
    readonly path: readonly string[];
    readonly pathScore: number;
}

function requireLimit(value: number | undefined, field: string): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError(`mind map route ${field} must be a nonnegative safe integer`);
    }
}

function nodeScore(node: MindMapNode): number {
    const score = node.score ?? 0;
    if (!Number.isFinite(score)) throw new TypeError(`mind map node ${node.id} score must be finite`);
    return score;
}

function edgeWeight(value: number | undefined, edge: string): number {
    if (value === undefined) return 0;
    if (!Number.isFinite(value)) throw new TypeError(`mind map edge ${edge} weight must be finite`);
    return value;
}

interface NeighborResult {
    readonly neighbors: readonly Neighbor[];
    readonly inspectedEdges: number;
    readonly truncated: boolean;
}

function neighborsOf(
    id: string,
    nodes: ReadonlyMap<string, MindMapNode>,
    children: ReadonlyMap<string, readonly string[]>,
    associations: ReadonlyMap<string, readonly { readonly target: string; readonly kind: MindMapEdgeKind; readonly reason: string; readonly weight: number }[]>,
    maxAssociationEdges: number,
): NeighborResult {
    const neighbors: Neighbor[] = [];
    const seen = new Set<string>();
    for (const child of children.get(id) ?? []) {
        const node = nodes.get(child);
        if (node === undefined) continue;
        seen.add(child);
        neighbors.push({ node, via: "child", reason: `hierarchy child of ${id}`, weight: 0 });
    }
    let inspectedEdges = 0;
    let truncated = false;
    for (const association of associations.get(id) ?? []) {
        if (inspectedEdges >= maxAssociationEdges) {
            truncated = true;
            break;
        }
        inspectedEdges += 1;
        if (seen.has(association.target)) continue;
        const node = nodes.get(association.target);
        if (node === undefined) continue;
        seen.add(association.target);
        neighbors.push({ node, via: association.kind, reason: association.reason, weight: association.weight });
    }
    return { neighbors: Object.freeze(neighbors), inspectedEdges, truncated };
}

/**
 * Expands a center-rooted mind map one or two layers, follows hierarchy and
 * association edges, and returns a deterministic score-ranked candidate set.
 *
 * Pruning is explicit: `maxSiblings` keeps only the highest-scoring neighbours
 * of each expanded node, `maxVisited`/`maxEdges` bound traversal, `minScore`
 * drops weak candidates, and `maxCandidates` caps the returned set.
 */
export function mindmapRoute(center: string, graph: MindMapGraph, limits: MindMapRouteLimits): MindMapRoute {
    if (typeof center !== "string" || center.trim() === "") throw new TypeError("mind map route center is required");
    if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1 || limits.maxDepth > 2) {
        throw new TypeError("mind map route maxDepth must be 1 or 2");
    }
    requireLimit(limits.maxCandidates, "maxCandidates");
    requireLimit(limits.maxVisited, "maxVisited");
    requireLimit(limits.maxSiblings, "maxSiblings");
    requireLimit(limits.maxEdges, "maxEdges");
    if (limits.minScore !== undefined && !Number.isFinite(limits.minScore)) {
        throw new TypeError("mind map route minScore must be finite");
    }
    if (limits.maxVisited === 0) throw new TypeError("mind map route maxVisited must allow the center");
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new TypeError("mind map graph must declare node and edge arrays");
    const nodes = new Map<string, MindMapNode>();
    for (const node of graph.nodes) {
        if (typeof node.id !== "string" || node.id.trim() === "") throw new TypeError("mind map node id is required");
        if (nodes.has(node.id)) throw new TypeError(`duplicate mind map node id: ${node.id}`);
        nodeScore(node);
        nodes.set(node.id, node);
    }
    const centerNode = nodes.get(center);
    if (centerNode === undefined) throw new TypeError(`mind map route center does not exist: ${center}`);
    const children = new Map<string, readonly string[]>();
    for (const node of nodes.values()) {
        const listed: string[] = [];
        for (const child of node.children ?? []) {
            if (!nodes.has(child)) throw new TypeError(`mind map child ${child} does not exist`);
            if (!listed.includes(child)) listed.push(child);
        }
        children.set(node.id, Object.freeze(listed));
    }
    const associations = new Map<string, { target: string; kind: MindMapEdgeKind; reason: string; weight: number }[]>();
    for (const edge of graph.edges) {
        if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
            throw new TypeError(`mind map association ${edge.from} -> ${edge.to} references a missing node`);
        }
        if (typeof edge.reason !== "string" || edge.reason.trim() === "") {
            throw new TypeError(`mind map association ${edge.from} -> ${edge.to} must carry a reason`);
        }
        const weight = edgeWeight(edge.weight, `${edge.from}->${edge.to}`);
        const forward = associations.get(edge.from) ?? [];
        forward.push({ target: edge.to, kind: edge.kind, reason: edge.reason, weight });
        associations.set(edge.from, forward);
        const backward = associations.get(edge.to) ?? [];
        backward.push({ target: edge.from, kind: edge.kind, reason: edge.reason, weight });
        associations.set(edge.to, backward);
    }

    const maxVisited = limits.maxVisited ?? Number.MAX_SAFE_INTEGER;
    const maxSiblings = limits.maxSiblings ?? Number.MAX_SAFE_INTEGER;
    const maxEdges = limits.maxEdges ?? Number.MAX_SAFE_INTEGER;
    const maxCandidates = limits.maxCandidates ?? Number.MAX_SAFE_INTEGER;
    const minScore = limits.minScore ?? -Infinity;
    const visited = new Set<string>([center]);
    const queue: Frame[] = [{
        node: centerNode,
        depth: 0,
        path: Object.freeze([center]),
        pathScore: nodeScore(centerNode),
    }];
    const raw: MindMapRouteCandidate[] = [];
    let expanded = 0;
    let inspectedEdges = 0;
    let prunedBySiblings = 0;
    let stoppedBy: MindMapRoute["stoppedBy"] = "complete";

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const frame = queue[cursor]!;
        if (frame.depth >= limits.maxDepth) continue;
        if (expanded >= maxVisited) {
            stoppedBy = "visited";
            break;
        }
        expanded += 1;
        const neighborSet = neighborsOf(frame.node.id, nodes, children, associations, maxEdges - inspectedEdges);
        inspectedEdges += neighborSet.inspectedEdges;
        if (neighborSet.truncated) stoppedBy = "edges";
        const candidates = neighborSet.neighbors
            .filter(neighbor => !visited.has(neighbor.node.id))
            .sort((left, right) =>
                nodeScore(right.node) - nodeScore(left.node)
                || right.weight - left.weight
                || left.node.id.localeCompare(right.node.id));
        if (candidates.length > maxSiblings) {
            prunedBySiblings += candidates.length - maxSiblings;
            candidates.length = maxSiblings;
        }
        for (const neighbor of candidates) {
            const depth = frame.depth + 1;
            const path = Object.freeze([...frame.path, neighbor.node.id]);
            const pathScore = frame.pathScore + nodeScore(neighbor.node) + neighbor.weight;
            visited.add(neighbor.node.id);
            raw.push(Object.freeze({
                nodeId: neighbor.node.id,
                topic: neighbor.node.topic,
                ...(neighbor.node.summary === undefined ? {} : { summary: neighbor.node.summary }),
                ...(neighbor.node.anchor === undefined ? {} : { anchor: neighbor.node.anchor }),
                depth,
                score: nodeScore(neighbor.node),
                pathScore,
                path,
                via: neighbor.via,
                reason: neighbor.reason,
                authorization: "not_granted",
            }));
            queue.push({ node: neighbor.node, depth, path, pathScore });
        }
    }

    const eligible = raw.filter(candidate => candidate.score >= minScore);
    const prunedByScore = raw.length - eligible.length;
    eligible.sort((left, right) =>
        right.score - left.score
        || right.pathScore - left.pathScore
        || left.depth - right.depth
        || left.nodeId.localeCompare(right.nodeId));
    const candidates = Object.freeze(eligible.slice(0, maxCandidates));
    const prunedByCandidates = eligible.length - candidates.length;
    if (prunedByCandidates > 0) stoppedBy = "candidates";
    return Object.freeze({
        version: "attention-mindmap-route/1",
        center,
        candidates,
        visited: Object.freeze([...visited]),
        bestPath: candidates[0]?.path ?? Object.freeze([center]),
        stoppedBy,
        stats: Object.freeze({
            expanded,
            visited: visited.size,
            inspectedEdges,
            prunedBySiblings,
            prunedByScore,
            prunedByCandidates,
        }),
        authorization: "not_granted",
    });
}
