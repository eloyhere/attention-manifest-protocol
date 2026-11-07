/**
 * Mind-map view validation.
 *
 * A mind map is a center-rooted hierarchy plus cross-branch association edges.
 * The graph is a projection, never the truth: this module validates the hard
 * structural constraints deterministically and reports soft warnings without
 * turning them into failures. The structure stays outside model context
 * (§13.5); only a short node summary may later enter L4 context.
 */

/** Role a node plays in the map. */
export type MindMapNodeType = "topic" | "subtopic" | "leaf" | "reference";

/** Visual/attention state of a node. */
export type MindMapNodeState = "expanded" | "collapsed" | "stale" | "forbidden";

/** Cross-branch association kinds; parent-child edges live in `children`. */
export type MindMapEdgeKind =
    | "supports"
    | "depends"
    | "related"
    | "conflicts"
    | "refines"
    | "evidences"
    | "references";

/** Stable reference from a node to a host object. */
export interface MindMapAnchor {
    readonly objectType: string;
    readonly objectId: string;
    readonly versionHash?: string;
}

/** One topic, subtopic, leaf or reference in the map. */
export interface MindMapNode {
    readonly id: string;
    readonly topic: string;
    readonly summary?: string;
    readonly type: MindMapNodeType;
    readonly anchor?: MindMapAnchor;
    /** Child node ids; the parent-child hierarchy must stay acyclic. */
    readonly children?: readonly string[];
    readonly score?: number;
    readonly state?: MindMapNodeState;
}

/** One association edge between two nodes, possibly across branches. */
export interface MindMapEdge {
    readonly from: string;
    readonly to: string;
    readonly kind: MindMapEdgeKind;
    readonly weight?: number;
    /** Why the association exists; it is mandatory and never empty. */
    readonly reason: string;
}

/** Center-rooted hierarchy plus association edges. */
export interface MindMapGraph {
    /** Id of the single center node. */
    readonly center: string;
    readonly nodes: readonly MindMapNode[];
    readonly edges: readonly MindMapEdge[];
    /** Projection freshness from 0 (stale) to 1 (fresh); omitted for legacy graphs. */
    readonly freshness?: number;
}

/** Hard bounds applied by the validator. */
export interface MindMapLimits {
    readonly maxDepth: number;
    readonly maxSiblings: number;
    readonly maxEdges: number;
}

/** One failed or advisory rule. */
export interface MindMapViolation {
    readonly rule: string;
    readonly subject: string;
    readonly message: string;
}

/** Frozen validation result; `ok` reflects hard constraints only. */
export interface MindMapValidation {
    readonly ok: boolean;
    readonly violations: readonly MindMapViolation[];
}

type Severity = "hard" | "soft";

interface PendingViolation extends MindMapViolation {
    readonly severity: Severity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireLimit(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`mind map ${label} must be a non-negative safe integer`);
    }
    return value;
}

function hard(rule: string, subject: string, message: string): PendingViolation {
    return { rule, subject, message, severity: "hard" };
}

function soft(rule: string, subject: string, message: string): PendingViolation {
    return { rule, subject, message, severity: "soft" };
}

function nonEmptyText(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

/**
 * Validate a mind-map graph against hard limits.
 *
 * Hard rules: the center exists and is unique (node ids are unique), the
 * parent-child hierarchy is acyclic, depth and sibling counts stay within
 * limits, every node declares a complete anchor, association edges carry a
 * reason and existing endpoints, the edge count stays within its limit, a
 * declared freshness stays within 0..1, and nodes that reference the same
 * anchor agree on its version hash. Duplicate sibling summaries are a soft
 * warning: they are reported in `violations` but never make `ok` false.
 */
export function validateMindMap(graph: MindMapGraph, limits: MindMapLimits): MindMapValidation {
    if (!isRecord(graph)) throw new TypeError("mind map graph must be an object");
    if (!Array.isArray(graph.nodes)) throw new TypeError("mind map nodes must be an array");
    if (!Array.isArray(graph.edges)) throw new TypeError("mind map edges must be an array");
    if (!isRecord(limits)) throw new TypeError("mind map limits must be an object");
    const maxDepth = requireLimit(limits.maxDepth, "maxDepth");
    const maxSiblings = requireLimit(limits.maxSiblings, "maxSiblings");
    const maxEdges = requireLimit(limits.maxEdges, "maxEdges");

    const violations: PendingViolation[] = [];

    // Freshness is part of the unified view contract (§13.2); out-of-range
    // values are a hard violation rather than a warning.
    if (graph.freshness !== undefined) {
        if (typeof graph.freshness !== "number" || !Number.isFinite(graph.freshness) || graph.freshness < 0 || graph.freshness > 1) {
            violations.push(hard("freshness_invalid", "freshness", "freshness must be a finite number between 0 and 1"));
        }
    }

    // Index nodes in declaration order; duplicate ids break center uniqueness.
    const nodes = new Map<string, MindMapNode>();
    for (const [index, candidate] of graph.nodes.entries()) {
        if (!isRecord(candidate) || !nonEmptyText(candidate.id)) {
            violations.push(hard("node_invalid", `nodes[${index}]`, "a node must be an object with a non-empty id"));
            continue;
        }
        if (nodes.has(candidate.id)) {
            violations.push(hard("node_id_duplicate", candidate.id,
                `node id ${candidate.id} is declared more than once, so the center cannot be unique`));
            continue;
        }
        nodes.set(candidate.id, candidate as unknown as MindMapNode);
    }

    const center = typeof graph.center === "string" ? graph.center : "";
    const centerExists = center.trim() !== "" && nodes.has(center);
    if (!centerExists) {
        violations.push(hard("center_exists", center === "" ? "<empty>" : center,
            "the graph must name one existing center node"));
    }

    // Resolve parent-child edges once; unknown children are structural gaps.
    const children = new Map<string, readonly string[]>();
    for (const node of nodes.values()) {
        const declared = Array.isArray(node.children) ? node.children : [];
        const unique: string[] = [];
        for (const child of declared) {
            if (!nonEmptyText(child) || !nodes.has(child)) {
                violations.push(hard("child_missing", node.id,
                    `child ${typeof child === "string" ? child : String(child)} does not reference an existing node`));
                continue;
            }
            if (!unique.includes(child)) unique.push(child);
        }
        children.set(node.id, unique);
    }

    // Every node is an attention-object anchor: the anchor itself is mandatory,
    // and a declared versionHash (when present) must agree across nodes.
    const anchorHashes = new Map<string, { readonly hash: string; readonly nodeId: string }>();
    for (const node of nodes.values()) {
        const anchor = node.anchor;
        const record = isRecord(anchor) ? anchor : undefined;
        const objectType = record?.objectType;
        const objectId = record?.objectId;
        if (record === undefined || !nonEmptyText(objectType) || !nonEmptyText(objectId)) {
            violations.push(hard("anchor_missing", node.id,
                "every node must declare an anchor with non-empty objectType and objectId"));
            continue;
        }
        const versionHash = record?.versionHash;
        if (versionHash === undefined) continue;
        if (!nonEmptyText(versionHash)) {
            violations.push(hard("anchor_hash_invalid", node.id, "a declared anchor versionHash must be non-empty"));
            continue;
        }
        const key = `${objectType}\0${objectId}`;
        const previous = anchorHashes.get(key);
        if (previous === undefined) anchorHashes.set(key, { hash: versionHash, nodeId: node.id });
        else if (previous.hash !== versionHash) {
            violations.push(hard("anchor_hash_mismatch", `${objectType}:${objectId}`,
                `nodes ${previous.nodeId} and ${node.id} disagree on the version hash of the same anchor`));
        }
    }

    // Parent-child cycles, over every node so unreachable components are covered.
    const color = new Map<string, "grey" | "black">();
    for (const start of nodes.keys()) {
        if (color.has(start)) continue;
        color.set(start, "grey");
        const stack: { readonly id: string; index: number }[] = [{ id: start, index: 0 }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1]!;
            const list = children.get(frame.id) ?? [];
            if (frame.index >= list.length) {
                color.set(frame.id, "black");
                stack.pop();
                continue;
            }
            const child = list[frame.index]!;
            frame.index += 1;
            const state = color.get(child);
            if (state === "grey") {
                violations.push(hard("parent_child_cycle", `${frame.id}->${child}`,
                    `parent-child edge ${frame.id} -> ${child} closes a cycle`));
            } else if (state === undefined) {
                color.set(child, "grey");
                stack.push({ id: child, index: 0 });
            }
        }
    }

    // Depth is measured from the center; breadth-first keeps cyclic inputs finite.
    if (centerExists) {
        const depth = new Map<string, number>([[center, 0]]);
        const queue: string[] = [center];
        for (let index = 0; index < queue.length; index += 1) {
            const id = queue[index]!;
            const next = (depth.get(id) ?? 0) + 1;
            for (const child of children.get(id) ?? []) {
                if (depth.has(child)) continue;
                depth.set(child, next);
                queue.push(child);
            }
        }
        for (const [id, value] of depth) {
            if (value > maxDepth) {
                violations.push(hard("max_depth", id, `node ${id} sits at depth ${value}, exceeding maxDepth ${maxDepth}`));
            }
        }
    }

    // Sibling bounds and duplicate summaries under the same parent.
    for (const [parentId, childIds] of children) {
        if (childIds.length > maxSiblings) {
            violations.push(hard("max_siblings", parentId,
                `node ${parentId} has ${childIds.length} children, exceeding maxSiblings ${maxSiblings}`));
        }
        const seenSummaries = new Map<string, string>();
        for (const childId of childIds) {
            const summary = nodes.get(childId)?.summary;
            if (typeof summary !== "string") continue;
            const normalized = summary.trim();
            if (normalized === "") continue;
            const first = seenSummaries.get(normalized);
            if (first !== undefined) {
                violations.push(soft("sibling_summary_duplicate", parentId,
                    `siblings ${first} and ${childId} share the summary "${normalized}"`));
            } else {
                seenSummaries.set(normalized, childId);
            }
        }
    }

    if (graph.edges.length > maxEdges) {
        violations.push(hard("max_edges", String(graph.edges.length),
            `the graph has ${graph.edges.length} association edges, exceeding maxEdges ${maxEdges}`));
    }
    for (const [index, edge] of graph.edges.entries()) {
        const from = isRecord(edge) && typeof edge.from === "string" ? edge.from : "";
        const to = isRecord(edge) && typeof edge.to === "string" ? edge.to : "";
        const subject = `${from}->${to}`;
        if (!isRecord(edge) || !nonEmptyText(edge.reason)) {
            violations.push(hard("edge_reason_missing", subject, `association edge at index ${index} must carry a non-empty reason`));
        }
        if (!nodes.has(from) || !nodes.has(to)) {
            violations.push(hard("edge_endpoint_missing", subject, `association edge ${subject} must reference existing nodes`));
        }
    }

    const frozenViolations = Object.freeze(violations.map(item => Object.freeze({
        rule: item.rule,
        subject: item.subject,
        message: item.message,
    })));
    return Object.freeze({
        ok: !violations.some(item => item.severity === "hard"),
        violations: frozenViolations,
    });
}
