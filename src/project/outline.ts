import { isObject, isString, Optional, SynchronousOrderedMap, SynchronousOrderedSet, SynchronousRootedForest, useFrom } from "semantic-typescript";
import { useLazyProxy } from "../reactive/proxy.ts";
import type { ProjectScope } from "./types.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { emptyRange, freezeRange, isRange, type Range } from "../file/range.ts";

export type OutlineNodeType = "directory" | "file" | "module" | "summary" | "pointer";

export interface OutlineSourceRef {
    readonly id: string;
    readonly version: number;
    readonly hash: string;
}

export interface LazyProjectNode extends OutlineNode {
    readonly children: readonly LazyProjectNode[];
    toJSON(): OutlineNode;
}

export interface OutlineNode extends ProjectScope {
    readonly path: string;
    readonly type: OutlineNodeType;
    readonly name: string;
    readonly summary: string;
    readonly version: number;
    readonly hash: string;
    readonly sourceRef?: string;
    readonly sourceVersion?: number;
    readonly parentPath?: string;
    readonly ruleIds?: readonly string[];
    /** Source span for text-backed nodes; empty for purely structural entries. */
    readonly range: Range;
    /** True when the entry or its cached projection no longer matches its sources. */
    readonly dirty: boolean;
    readonly stale: boolean;
    readonly staleReasons: readonly string[];
}

export type OutlineNodeInput = Omit<OutlineNode, "version" | "stale" | "staleReasons" | "dirty" | "range">
    & { readonly version?: number; readonly expectedVersion?: number; readonly range?: Range };
export interface OutlineNodePatch extends Omit<OutlineNodeInput, "expectedVersion"> { readonly expectedVersion?: number }
export interface OutlineBatchInput extends ProjectScope {
    readonly expectedVersion: number;
    readonly upsert: readonly OutlineNodeInput[];
    readonly remove?: readonly string[];
}
export interface OutlineOptions extends ProjectScope {
    readonly projectVersion: number;
}

export interface OutlineDependency extends ProjectScope {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
    readonly reason: string;
}
export interface OutlineCandidate {
    readonly node: OutlineNode;
    readonly depth: number;
    readonly via?: string;
    readonly reason: string;
    readonly authorization: "not_granted";
}
export interface OutlineQueryResult {
    readonly candidates: readonly OutlineCandidate[];
    readonly visited: readonly string[];
    readonly stoppedBy: "complete" | "depth" | "candidates" | "visited";
    readonly authorization: "not_granted";
}
export interface OutlineProjection extends ProjectScope {
    readonly id: string;
    readonly sourcePaths: readonly string[];
    readonly sourceRuleIds: readonly string[];
    readonly payload: unknown;
    readonly version: number;
    readonly stale: boolean;
    readonly staleReasons: readonly string[];
}
export interface OutlineProjectionInput extends ProjectScope {
    readonly id: string;
    readonly sourcePaths: readonly string[];
    readonly sourceRuleIds?: readonly string[];
    readonly payload: unknown;
    readonly expectedVersion?: number;
}
export interface HostSourceSummary extends ProjectScope {
    readonly path: string;
    readonly sourceRef: string;
    readonly version: number;
    readonly hash: string;
    readonly summary: string;
    readonly range?: Range;
}
export interface CandidateLimits {
    readonly maxDepth: number;
    readonly maxCandidates: number;
    readonly maxVisited: number;
}

const clone = <T>(value: T): T => isObject(value) ? structuredClone(value) as T : value;

function requireText(value: unknown, label: string): asserts value is string {
    if (!isString(value) || !value.trim()) throw new WorkspaceError("invalid_project", `${label} must be nonempty text`);
}
function requireVersion(value: unknown, label: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new WorkspaceError("invalid_project", `${label} must be a positive safe integer`);
}
function normalizePath(path: string): string {
    requireText(path, "path");
    if (path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) throw new WorkspaceError("invalid_path", "outline paths must be relative POSIX paths");
    if (path === ".") return path;
    const parts = path.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) throw new WorkspaceError("invalid_path", "outline path is not canonical or escapes its root");
    return path;
}
function parentPathOf(path: string): string | undefined {
    if (path === ".") return undefined;
    const index = path.lastIndexOf("/");
    return index < 0 ? "." : path.slice(0, index);
}
function requireLimit(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new WorkspaceError("invalid_project", `${label} must be a nonnegative safe integer`);
}

/** A scoped project tree. Discovery and association produce candidates only, never permission. */
export class ProjectOutline {
    readonly tenantId: string;
    readonly rootId: string;
    private currentProjectVersion: number;
    private nodes = new SynchronousOrderedMap<string, OutlineNode>();
    private dependencies = new SynchronousOrderedMap<string, readonly OutlineDependency[]>();
    private projections = new SynchronousOrderedMap<string, OutlineProjection>();
    private rules = new SynchronousOrderedMap<string, number>();
    private forest = new SynchronousRootedForest<OutlineNode>();
    private lazyNodes = new SynchronousOrderedMap<string, LazyProjectNode>();
    constructor(options: OutlineOptions) {
        requireText(options.tenantId, "tenantId");
        requireText(options.rootId, "rootId");
        requireVersion(options.projectVersion, "projectVersion");
        this.tenantId = options.tenantId;
        this.rootId = options.rootId;
        this.currentProjectVersion = options.projectVersion;
    }

    get version(): number { return this.currentProjectVersion; }

    lazyTree(): Optional<LazyProjectNode> {
        return this.lazyNode(".");
    }

    lazyNode(path: string): Optional<LazyProjectNode> {
        const normalized = normalizePath(path);
        if (this.nodes.get(normalized).isEmpty()) return Optional.empty();
        return Optional.of(this.getLazyNode(normalized));
    }

    find(path: string): Optional<OutlineNode> {
        const normalized = normalizePath(path);
        return this.nodes.get(normalized).map(node => clone(node));
    }

    list(): OutlineNode[] {
        return useFrom(this.forest.breadthFirst()).map(node => node.getElement().get()).map(node => clone(node)).toCollectable().toArray();
    }

    subtree(path: string): OutlineNode[] {
        const root = normalizePath(path);
        if (this.nodes.get(root).isEmpty()) return [];
        const output: OutlineNode[] = [];
        for (const node of this.forest.breadthFirst()) {
            const value = node.getElement().get();
            if (root === "." || value.path === root || value.path.startsWith(`${root}/`)) output.push(clone(value));
        }
        return output;
    }

    candidates(query: string, maxCandidates = 20): OutlineCandidate[] {
        requireText(query, "query");
        requireLimit(maxCandidates, "maxCandidates");
        const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const result: OutlineCandidate[] = [];
        for (const node of this.forest.breadthFirst()) {
            if (result.length >= maxCandidates) break;
            const value = node.getElement().get();
            if (value.stale) continue;
            const haystack = `${value.path} ${value.type} ${value.name} ${value.summary}`.toLocaleLowerCase();
            if (terms.every(term => haystack.includes(term))) result.push({ node: clone(value), depth: value.path === "." ? 0 : value.path.split("/").length, reason: "keyword match", authorization: "not_granted" });
        }
        return result;
    }

    upsertBatch(input: OutlineBatchInput): { readonly version: number; readonly nodes: readonly OutlineNode[] } {
        this.assertScope(input);
        if (input.expectedVersion !== this.currentProjectVersion) throw new WorkspaceError("version_conflict", "project outline version changed");
        const candidate = new SynchronousOrderedMap<string, OutlineNode>();
        this.nodes.forEach((path, node) => candidate.put(path, clone(node)));
        const removals = new SynchronousOrderedSet<string>();
        for (const rawPath of input.remove ?? []) {
            const path = normalizePath(rawPath);
            if (removals.contains(path)) throw new WorkspaceError("duplicate", `duplicate removal ${path}`);
            removals.add(path);
        }
        for (const item of input.upsert) if (removals.contains(normalizePath(item.path))) throw new WorkspaceError("invalid_project", `node ${item.path} cannot be removed and upserted together`);
        for (const path of removals.toArray()) candidate.remove(path);

        const seen = new SynchronousOrderedSet<string>();
        for (const item of input.upsert) {
            this.assertScope(item);
            const path = normalizePath(item.path);
            if (seen.contains(path)) throw new WorkspaceError("duplicate", `duplicate upsert ${path}`);
            seen.add(path);
            requireText(item.name, "name");
            requireText(item.summary, "summary");
            if (item.version !== undefined) requireVersion(item.version, "node version");
            requireText(item.hash, "hash");
            if (!["directory", "file", "module", "summary", "pointer"].includes(item.type)) throw new WorkspaceError("invalid_project", "unsupported outline node type");
            const parentPath = item.parentPath === undefined ? parentPathOf(path) : normalizePath(item.parentPath);
            if (path === "." ? parentPath !== undefined || item.type !== "directory" : parentPath === undefined) throw new WorkspaceError("invalid_project", "outline requires one directory root at '.'");
            const previous = candidate.get(path).orElse(undefined);
            const original = this.nodes.get(path).orElse(undefined);
            if (original && item.expectedVersion !== original.version) throw new WorkspaceError("version_conflict", `node ${path} version changed`);
            if (!original && item.expectedVersion !== undefined) throw new WorkspaceError("version_conflict", `new node ${path} cannot carry expectedVersion`);
            if (previous && removals.contains(path)) throw new WorkspaceError("invalid_project", `node ${path} cannot be removed and upserted together`);
            if (item.range !== undefined && !isRange(item.range)) throw new WorkspaceError("invalid_project", `node ${path} has an invalid range`);
            const node: OutlineNode = {
                tenantId: this.tenantId, rootId: this.rootId, path, type: item.type, name: item.name,
                summary: item.summary, version: original ? original.version + 1 : 1, hash: item.hash,
                sourceRef: item.sourceRef, sourceVersion: item.sourceVersion, parentPath,
                ruleIds: item.ruleIds ? [...new SynchronousOrderedSet(item.ruleIds).toArray()] : undefined,
                range: freezeRange(item.range ?? emptyRange),
                dirty: false,
                stale: false, staleReasons: [],
            };
            candidate.put(path, clone(node));
        }
        this.validateTree(candidate);
        const nextForest = this.buildForest(candidate);
        const nextVersion = this.currentProjectVersion + 1;
        const changedPaths = new SynchronousOrderedSet<string>();
        for (const item of input.upsert) {
            const path = normalizePath(item.path);
            const before = this.nodes.get(path).orElse(null);
            const after = candidate.get(path).orElse(null);
            if (before && after && (before.hash !== after.hash || before.sourceVersion !== after.sourceVersion || before.summary !== after.summary)) changedPaths.add(path);
        }
        for (const path of removals.toArray()) changedPaths.add(path);
        this.nodes = candidate;
        this.currentProjectVersion = nextVersion;
        this.lazyNodes.clear();
        this.forest = nextForest;
        for (const path of changedPaths.toArray()) this.propagateStale(path, `node:${path}@${nextVersion}`);
        this.invalidateProjectionsForMissingSources();
        return { version: nextVersion, nodes: this.list() };
    }

    addDependencies(edges: readonly OutlineDependency[], expectedVersion = this.currentProjectVersion): void {
        if (expectedVersion !== this.currentProjectVersion) throw new WorkspaceError("version_conflict", "project outline version changed");
        const next = new SynchronousOrderedMap<string, readonly OutlineDependency[]>();
        this.dependencies.forEach((key, values) => next.put(key, values.map(clone)));
        for (const edge of edges) {
            this.assertScope(edge);
            const from = normalizePath(edge.from), to = normalizePath(edge.to);
            if (this.nodes.get(from).isEmpty() || this.nodes.get(to).isEmpty()) throw new WorkspaceError("not_found", "dependency endpoint is absent from this outline");
            requireText(edge.kind, "dependency kind");
            requireText(edge.reason, "dependency reason");
            const normalized = { ...edge, from, to };
            const existing = next.get(from).get([]);
            if (existing.some(value => value.to === to && value.kind === edge.kind)) continue;
            next.put(from, [...existing, normalized]);
        }
        if (edges.length > 0) {
            this.dependencies = next;
            this.currentProjectVersion++;
            this.lazyNodes.clear();
        }
    }

    related(path: string, limits: CandidateLimits): OutlineQueryResult {
        const start = normalizePath(path);
        for (const [key, value] of Object.entries(limits)) requireLimit(value, key);
        const candidates: OutlineCandidate[] = [];
        const visited = new SynchronousOrderedSet<string>();
        let stoppedBy: OutlineQueryResult["stoppedBy"] = "complete";
        if (limits.maxVisited < 1) throw new WorkspaceError("invalid_project", "maxVisited must include the starting node");
        const root = this.nodes.get(start).orElse(undefined);
        if (!root || root.stale) return { candidates, visited: [], stoppedBy, authorization: "not_granted" };
        const queue = new SynchronousOrderedMap<number, { path: string; depth: number }>();
        visited.add(start);
        queue.put(0, { path: start, depth: 0 });
        let head = 0, tail = 1;
        while (head < tail) {
            const current = queue.get(head++).get();
            const edges = this.dependencies.get(current.path).get([]);
            if (current.depth >= limits.maxDepth) {
                if (edges.length && stoppedBy === "complete") stoppedBy = "depth";
                continue;
            }
            for (const edge of edges) {
                if (candidates.length >= limits.maxCandidates) { stoppedBy = "candidates"; return { candidates, visited: visited.toArray(), stoppedBy, authorization: "not_granted" }; }
                if (Number(visited.size()) >= limits.maxVisited) { stoppedBy = "visited"; return { candidates, visited: visited.toArray(), stoppedBy, authorization: "not_granted" }; }
                if (visited.contains(edge.to)) continue;
                visited.add(edge.to);
                const target = this.nodes.get(edge.to).orElse(undefined);
                if (!target || target.stale) continue;
                candidates.push({ node: clone(target), depth: current.depth + 1, via: current.path, reason: edge.reason, authorization: "not_granted" });
                queue.put(tail++, { path: target.path, depth: current.depth + 1 });
            }
        }
        return { candidates, visited: visited.toArray(), stoppedBy, authorization: "not_granted" };
    }

    updateSource(summary: HostSourceSummary): OutlineNode | undefined {
        this.assertScope(summary);
        const path = normalizePath(summary.path);
        requireText(summary.sourceRef, "sourceRef");
        requireVersion(summary.version, "source version");
        requireText(summary.hash, "source hash");
        requireText(summary.summary, "source summary");
        const existing = this.nodes.get(path).orElse(undefined);
        if (!existing) return undefined;
        if (existing.sourceRef !== summary.sourceRef) throw new WorkspaceError("invalid_scope", "source reference does not match outline node");
        if (existing.sourceVersion !== undefined && summary.version < existing.sourceVersion) throw new WorkspaceError("version_conflict", "source version cannot move backwards");
        if (summary.version === existing.sourceVersion && summary.hash === existing.hash) return clone(existing);
        const updated: OutlineNode = { ...existing, summary: summary.summary, hash: summary.hash, sourceVersion: summary.version, version: existing.version + 1, range: freezeRange(summary.range ?? existing.range), dirty: true, stale: true, staleReasons: [...new SynchronousOrderedSet([...existing.staleReasons, `source:${summary.sourceRef}@${summary.version}`]).toArray()] };
        const nextNodes = new SynchronousOrderedMap<string, OutlineNode>();
        this.nodes.forEach((nodePath, node) => nextNodes.put(nodePath, nodePath === path ? clone(updated) : clone(node)));
        const nextForest = this.buildForest(nextNodes);
        this.nodes = nextNodes;
        this.currentProjectVersion++;
        this.lazyNodes.clear();
        this.forest = nextForest;
        this.propagateStale(path, `source:${summary.sourceRef}@${summary.version}`);
        return clone(this.nodes.get(path).get());
    }

    updateRuleVersion(ruleId: string, version: number): void {
        requireText(ruleId, "ruleId");
        requireVersion(version, "rule version");
        const previous = this.rules.get(ruleId);
        if (previous.isPresent() && version < previous.get()) throw new WorkspaceError("version_conflict", "rule version cannot move backwards");
        this.rules.put(ruleId, version);
        if (previous.isPresent() && version !== previous.get()) {
            this.currentProjectVersion++;
            this.lazyNodes.clear();
            const reason = `rule:${ruleId}@${version}`;
            for (const node of this.list()) if (node.ruleIds?.includes(ruleId)) this.propagateStale(node.path, reason);
            this.projections.forEach((id, projection) => {
                if (projection.sourceRuleIds.includes(ruleId)) this.projections.put(id, { ...projection, stale: true, staleReasons: [...new SynchronousOrderedSet([...projection.staleReasons, reason]).toArray()] });
            });
        }
    }

    putProjection(input: OutlineProjectionInput): OutlineProjection {
        this.assertScope(input);
        requireText(input.id, "projection id");
        const previous = this.projections.get(input.id).orElse(undefined);
        if (previous && input.expectedVersion !== previous.version) throw new WorkspaceError("version_conflict", "projection version changed");
        if (!previous && input.expectedVersion !== undefined) throw new WorkspaceError("version_conflict", "new projection cannot carry expectedVersion");
        for (const path of input.sourcePaths) if (this.nodes.get(normalizePath(path)).isEmpty()) throw new WorkspaceError("not_found", `projection source ${path} is absent`);
        for (const ruleId of input.sourceRuleIds ?? []) if (this.rules.get(ruleId).isEmpty()) throw new WorkspaceError("not_found", `projection rule ${ruleId} has no observed version`);
        const projection: OutlineProjection = {
            tenantId: this.tenantId, rootId: this.rootId, id: input.id,
            sourcePaths: [...new SynchronousOrderedSet(input.sourcePaths.map(normalizePath)).toArray()],
            sourceRuleIds: [...new SynchronousOrderedSet(input.sourceRuleIds ?? []).toArray()], payload: clone(input.payload),
            version: previous ? previous.version + 1 : 1, stale: false, staleReasons: [],
        };
        this.projections.put(input.id, clone(projection));
        return clone(projection);
    }

    findProjection(id: string): Optional<OutlineProjection> {
        return this.projections.get(id).map(projection => clone(projection));
    }

    currentProjection(id: string): Optional<OutlineProjection> {
        return this.findProjection(id).filter(projection => !projection.stale && projection.sourcePaths.every(path => !this.nodes.get(path).map(node => node.stale).get(true)));
    }

    invalidateRule(ruleId: string, version: number): void { this.updateRuleVersion(ruleId, version); }

    private getLazyNode(path: string): LazyProjectNode {
        const cached = this.lazyNodes.get(path).orElse(null);
        if (cached) return cached;
        const node = this.nodes.get(path).orElse(null);
        if (!node) throw new WorkspaceError("not_found", `outline node ${path} does not exist`);
        const capturedProjectVersion = this.currentProjectVersion;
        const assertCurrent = (): void => {
            if (capturedProjectVersion !== this.currentProjectVersion) throw new WorkspaceError("stale", "lazy outline node belongs to an older project version");
            if (this.nodes.get(path).map(current => current.stale).get(true)) throw new WorkspaceError("stale", `outline node ${path} is stale`);
        };
        const metadata = clone(node);
        if (metadata.ruleIds) Object.freeze(metadata.ruleIds);
        Object.freeze(metadata.staleReasons);
        const lazyValue = { ...metadata, toJSON: () => { assertCurrent(); return clone(metadata); } };
        const proxy = useLazyProxy<LazyProjectNode & { toJSON(): OutlineNode }, "children">(lazyValue, {
            load: { children: () => {
                assertCurrent();
                const children: LazyProjectNode[] = [];
                this.nodes.forEach((childPath, child) => {
                    if (child.parentPath === path) children.push(this.getLazyNode(childPath));
                });
                return Object.freeze(children.slice());
            } },
            assertCurrent,
        }).value as LazyProjectNode;
        this.lazyNodes.put(path, proxy);
        return proxy;
    }

    private markStale(path: string, reason: string): void {
        const node = this.nodes.get(path).orElse(null);
        if (!node) return;
        this.nodes.put(path, { ...node, dirty: true, stale: true, staleReasons: [...new SynchronousOrderedSet([...node.staleReasons, reason]).toArray()] });
        this.invalidateProjectionsForPath(path, reason);
    }

    private propagateStale(path: string, reason: string): void {
        const pending = new SynchronousOrderedSet<string>([path]);
        const visited = new SynchronousOrderedSet<string>();
        while (pending.size() > 0n) {
            const current = pending.toArray()[0];
            pending.remove(current);
            if (visited.contains(current)) continue;
            visited.add(current);
            this.markStale(current, reason);
            const parent = this.nodes.get(current).map(node => node.parentPath).orElse(null);
            if (parent) pending.add(parent);
            this.nodes.forEach((childPath, child) => { if (child.parentPath === current) pending.add(childPath); });
            this.dependencies.forEach((from, edges) => { if (edges.some(edge => edge.to === current)) pending.add(from); });
        }
    }

    private invalidateProjectionsForPath(path: string, reason: string): void {
        this.projections.forEach((id, projection) => {
            if (projection.sourcePaths.includes(path)) this.projections.put(id, { ...projection, stale: true, staleReasons: [...new SynchronousOrderedSet([...projection.staleReasons, reason]).toArray()] });
        });
    }

    private invalidateProjectionsForMissingSources(): void {
        this.projections.forEach((id, projection) => {
            const absent = projection.sourcePaths.find(path => this.nodes.get(path).isEmpty());
            if (absent) this.projections.put(id, { ...projection, stale: true, staleReasons: [...new SynchronousOrderedSet([...projection.staleReasons, `missing:${absent}`]).toArray()] });
        });
    }

    private validateTree(nodes: SynchronousOrderedMap<string, OutlineNode>): void {
        const roots = nodes.values().toArray().filter(node => node.path === ".");
        if (roots.length !== 1) throw new WorkspaceError("invalid_project", "outline must contain exactly one root directory");
        for (const node of nodes.values().toArray()) {
            if (node.path === ".") continue;
            const parentPath = node.parentPath ?? parentPathOf(node.path);
            const parent = nodes.get(parentPath).orElse(undefined);
            if (!parent || (parent.type !== "directory" && parent.type !== "module")) throw new WorkspaceError("invalid_project", `invalid parent for ${node.path}`);
            if (parentPathOf(node.path) !== parentPath) throw new WorkspaceError("invalid_path", `parent is not the canonical path parent for ${node.path}`);
        }
        try { this.buildForest(nodes); }
        catch (error) { throw new WorkspaceError("invalid_project", `outline topology must be a single acyclic rooted tree: ${String(error)}`); }
    }

    private buildForest(nodes: SynchronousOrderedMap<string, OutlineNode>): SynchronousRootedForest<OutlineNode> {
        const values = nodes.values().toArray();
        const lookup = new SynchronousOrderedMap<string, OutlineNode>();
        for (const node of values) lookup.put(node.path, node);
        return new SynchronousRootedForest(values, { parentOf: node => node.parentPath === undefined ? undefined : lookup.get(node.parentPath).orElse(null) ?? undefined });
    }

    private assertScope(value: ProjectScope): void {
        if (!value || value.tenantId !== this.tenantId || value.rootId !== this.rootId) throw new WorkspaceError("invalid_scope", "tenant and root scope mismatch");
    }
}

