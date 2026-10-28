/**
 * Versioned project/code/knowledge facts and rebuildable indexes. Discovery
 * returns candidates; only the caller's Frame grants prompt/detail visibility.
 * Code dependency edges are descriptive and may contain cycles.
 */
import { ContextAst } from "./ast.ts";
import type { ContextAstNode } from "./ast.ts";
import type { ContentStore } from "./contentStore.ts";
import { Context } from "./lifecycle.ts";
import type { Frame } from "../frame/frame.ts";
import type { DocumentLocator, DocumentSourceRevision, SummaryProvenance } from "./document.ts";

export type WorkspaceEntityKind = "project" | "directory" | "file" | "symbol" | "package" | "knowledge";
export type WorkspaceRelationKind = "project_depends_on" | "imports" | "calls" | "references" | "documents";

export interface WorkspaceSource {
    uri: string;
    revision: string;
    startLine?: number;
    endLine?: number;
    locator?: DocumentLocator;
}

export interface WorkspaceEntity {
    id: string;
    kind: WorkspaceEntityKind;
    projectId: string;
    parentId?: string;
    label: string;
    summary: string;
    source: WorkspaceSource;
    detailRef?: string;
    tags?: string[];
    searchTerms?: string[];
    structureKind?: "document" | "section" | "paragraph" | "table" | "sheet" | "slide" | "environment";
    summaryProvenance?: SummaryProvenance;
}

/**
 * from is the consumer/caller/document, to is the dependency/callee/subject.
 * Method describes extraction, not a confidence or an authorization grant.
 */
export interface WorkspaceRelation {
    from: string;
    to: string;
    kind: WorkspaceRelationKind;
    source: WorkspaceSource;
    method: "manifest" | "compiler" | "explicit";
}

export interface WorkspaceDiagnostic {
    uri: string;
    code: string;
    message: string;
}

export interface WorkspaceSnapshot {
    version: 1;
    revision: string;
    entities: WorkspaceEntity[];
    relations: WorkspaceRelation[];
    diagnostics: WorkspaceDiagnostic[];
}

export interface WorkspaceQuery {
    seedIds?: readonly string[];
    text?: string;
    projectIds?: readonly string[];
    relationKinds?: readonly WorkspaceRelationKind[];
    direction?: "incoming" | "outgoing" | "both";
    maxDepth?: number;
    limit?: number;
}

export interface WorkspaceCandidate {
    id: string;
    why: "seed" | "text" | WorkspaceRelationKind;
    hops: number;
}

export interface WorkspaceQueryResult {
    revision: string;
    candidates: WorkspaceCandidate[];
    unknownIds: string[];
    truncated: boolean;
}

const EntityKinds: Set<string> = new Set(["project", "directory", "file", "symbol", "package", "knowledge"]);
const RelationKinds: Set<string> = new Set(["project_depends_on", "imports", "calls", "references", "documents"]);
export const workspaceTerms: (text: string) => string[] = (text: string): string[] => [
    ...new Set(
        text
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
];
const cloneEntity: (entity: WorkspaceEntity) => WorkspaceEntity = (entity: WorkspaceEntity): WorkspaceEntity => ({
    ...entity,
    source: structuredClone(entity.source),
    ...(entity.summaryProvenance === (void 0) ? {} : { summaryProvenance: structuredClone(entity.summaryProvenance) }),
    ...(entity.tags === (void 0) ? {} : { tags: [...entity.tags] }),
    ...(entity.searchTerms === (void 0) ? {} : { searchTerms: [...entity.searchTerms] }),
});
const cloneRelation: (edge: WorkspaceRelation) => WorkspaceRelation = (edge: WorkspaceRelation): WorkspaceRelation => ({
    ...edge,
    source: structuredClone(edge.source),
});
const checkSource: (source: WorkspaceSource) => void = (source: WorkspaceSource): void => {
    if (!source || !source.uri || !source.revision) {
        throw new Error("workspace facts require source URI and revision");
    }
    if (
        (source.startLine !== (void 0) && (!Number.isSafeInteger(source.startLine) || source.startLine < 1)) ||
        (source.endLine !== (void 0) && (!Number.isSafeInteger(source.endLine) || source.endLine < (source.startLine ?? 1)))
    ) {
        throw new Error("invalid workspace source range");
    }
    const locator: DocumentLocator | undefined = source.locator;
    if (locator !== (void 0)) {
        if (
            !locator.part ||
            !["part", "cells", "slide"].includes(locator.kind) ||
            (locator.kind === "cells" && (!locator.sheet || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(locator.range))) ||
            (locator.kind === "slide" && (!Number.isSafeInteger(locator.slide) || locator.slide < 1))
        ) {
            throw new Error("invalid document source locator");
        }
    }
};

export class WorkspaceIndex {
    readonly revision: string;
    private readonly entities: Map<string, WorkspaceEntity> = new Map();
    private readonly edges: WorkspaceRelation[] = [];
    private readonly childrenById: Map<string, string[]> = new Map();
    private readonly outgoing: Map<string, WorkspaceRelation[]> = new Map();
    private readonly incoming: Map<string, WorkspaceRelation[]> = new Map();
    private readonly postings: Map<string, Set<string>> = new Map();
    private readonly sourceRevisions: Map<string, Set<string>> = new Map();
    private readonly summaryStates: Map<string, "fresh" | "stale"> = new Map();
    private readonly diagnostics: WorkspaceDiagnostic[];
    private readonly store: ContentStore;

    constructor(snapshot: WorkspaceSnapshot, store: ContentStore) {
        if (snapshot.version !== 1 || !snapshot.revision) {
            throw new Error("unsupported or unversioned workspace snapshot");
        }
        this.revision = snapshot.revision;
        this.store = store;
        this.diagnostics = snapshot.diagnostics.map((item: WorkspaceDiagnostic): WorkspaceDiagnostic => ({ ...item }));
        snapshot.entities.forEach((entity: WorkspaceEntity): void => {
            if (!entity.id || !EntityKinds.has(entity.kind) || this.entities.has(entity.id)) {
                throw new Error(`invalid or duplicate workspace entity ${entity.id}`);
            }
            checkSource(entity.source);
            const provenance: SummaryProvenance | undefined = entity.summaryProvenance;
            if (
                provenance !== (void 0) &&
                (provenance.method !== "extractive-v1" ||
                    !Array.isArray(provenance.sources) ||
                    provenance.sources.length === 0 ||
                    provenance.sources.some((item): boolean => !item.uri || !item.revision) ||
                    !Array.isArray(provenance.children))
            ) {
                throw new Error("invalid summary provenance");
            }
            this.entities.set(entity.id, cloneEntity(entity));
            const revisions: Set<string> = this.sourceRevisions.get(entity.source.uri) ?? new Set();
            revisions.add(entity.source.revision);
            this.sourceRevisions.set(entity.source.uri, revisions);
        });
        this.entities.forEach((entity: WorkspaceEntity): void => {
            const project: WorkspaceEntity | undefined = this.entities.get(entity.projectId);
            const parent: WorkspaceEntity | undefined = entity.parentId === (void 0) ? (void 0) : this.entities.get(entity.parentId);
            if (project?.kind !== "project" || (entity.kind === "project" && (entity.projectId !== entity.id || entity.parentId !== (void 0)))) {
                throw new Error(`invalid project owner for ${entity.id}`);
            }
            if (entity.kind !== "project" && (parent === (void 0) || parent.projectId !== entity.projectId)) {
                throw new Error(`invalid structural parent for ${entity.id}`);
            }
            if (parent !== (void 0)) {
                const children: string[] = this.childrenById.get(parent.id) ?? [];
                children.push(entity.id);
                this.childrenById.set(parent.id, children);
            }
            if (entity.summaryProvenance?.children.some((id: string): boolean => this.entities.get(id)?.parentId !== entity.id)) {
                throw new Error("summary dependencies must be direct structural children");
            }
        });
        const complete: Set<string> = new Set();
        this.entities.forEach((entity: WorkspaceEntity): void => {
            const path: Set<string> = new Set();
            let current: WorkspaceEntity | undefined = entity;
            while (current !== (void 0) && !complete.has(current.id)) {
                if (path.has(current.id)) {
                    throw new Error("workspace hierarchy contains a cycle");
                }
                path.add(current.id);
                current = current.parentId === (void 0) ? (void 0) : this.entities.get(current.parentId);
            }
            path.forEach((id: string): void => {
                complete.add(id);
            });
        });
        this.entities.forEach((entity: WorkspaceEntity): void => {
            workspaceTerms(
                `${entity.label} ${this.summaryState(entity.id) === "stale" ? "" : entity.summary} ${entity.source.uri} ${(entity.tags ?? []).join(" ")} ${(entity.searchTerms ?? []).join(" ")}`,
            ).forEach((term: string): void => {
                const ids: Set<string> = this.postings.get(term) ?? new Set();
                ids.add(entity.id);
                this.postings.set(term, ids);
            });
        });
        const seen: Set<string> = new Set();
        snapshot.relations.forEach((edge: WorkspaceRelation): void => {
            if (!this.entities.has(edge.from) || !this.entities.has(edge.to) || !RelationKinds.has(edge.kind)) {
                throw new Error(`invalid workspace relation ${edge.from}->${edge.to}`);
            }
            checkSource(edge.source);
            if (!["manifest", "compiler", "explicit"].includes(edge.method)) {
                throw new Error("unknown workspace extraction method");
            }
            const key: string = JSON.stringify(edge);
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            const stored: WorkspaceRelation = cloneRelation(edge);
            this.edges.push(stored);
            this.appendEdge(this.outgoing, stored.from, stored);
            this.appendEdge(this.incoming, stored.to, stored);
        });
    }

    private appendEdge(index: Map<string, WorkspaceRelation[]>, id: string, edge: WorkspaceRelation): void {
        const edges: WorkspaceRelation[] = index.get(id) ?? [];
        edges.push(edge);
        index.set(id, edges);
    }

    entity(id: string): WorkspaceEntity | undefined {
        const entity: WorkspaceEntity | undefined = this.entities.get(id);
        return entity === (void 0) ? (void 0) : cloneEntity(entity);
    }

    /**
     * Missing or changed source revisions invalidate summaries that use them.
     */
    summaryState(id: string, currentSources?: readonly DocumentSourceRevision[]): "untracked" | "fresh" | "stale" {
        const entity: WorkspaceEntity | undefined = this.entities.get(id);
        if (!entity?.summaryProvenance) {
            return "untracked";
        }
        const cached: "fresh" | "stale" | undefined = currentSources === (void 0) ? this.summaryStates.get(id) : (void 0);
        if (cached !== (void 0)) {
            return cached;
        }
        const sources: Map<string, Set<string>> = currentSources === (void 0) ? this.sourceRevisions : new Map();
        currentSources?.forEach((source): void => {
            const revisions: Set<string> = sources.get(source.uri) ?? new Set();
            revisions.add(source.revision);
            sources.set(source.uri, revisions);
        });
        /**
         * The validated hierarchy is acyclic. Postorder caches every descendant,
         * so constructing postings walks each summary dependency only once.
         * Explicit source revisions get an isolated cache for this query.
         */
        const states: Map<string, "fresh" | "stale"> = currentSources === (void 0) ? this.summaryStates : new Map();
        const pending: { id: string; visited: boolean }[] = [{ id, visited: false }];
        while (pending.length > 0) {
            const next: { id: string; visited: boolean } = pending.pop()!;
            if (states.has(next.id)) {
                continue;
            }
            const provenance: SummaryProvenance | undefined = this.entities.get(next.id)?.summaryProvenance;
            if (
                !provenance ||
                provenance.sources.some((source): boolean => sources.get(source.uri)?.size !== 1 || !sources.get(source.uri)?.has(source.revision))
            ) {
                states.set(next.id, "stale");
                continue;
            }
            if (next.visited) {
                states.set(next.id, provenance.children.some((child: string): boolean => states.get(child) !== "fresh") ? "stale" : "fresh");
                continue;
            }
            pending.push({ id: next.id, visited: true });
            provenance.children.forEach((child: string): void => {
                if (!states.has(child)) {
                    pending.push({ id: child, visited: false });
                }
            });
        }
        return states.get(id)!;
    }

    children(id: string): WorkspaceEntity[] {
        return (this.childrenById.get(id) ?? []).map((child: string): WorkspaceEntity => cloneEntity(this.entities.get(child)!));
    }

    relations(id: string, direction: "incoming" | "outgoing", kind?: WorkspaceRelationKind): WorkspaceRelation[] {
        return ((direction === "incoming" ? this.incoming : this.outgoing).get(id) ?? [])
            .filter((edge: WorkspaceRelation): boolean => kind === (void 0) || edge.kind === kind)
            .map(cloneRelation);
    }

    /**
     * Exact lexical AND retrieval plus bounded graph navigation. Project scope
     * is checked before traversal; unknown/outside seeds never widen it.
     */
    query(query: WorkspaceQuery): WorkspaceQueryResult {
        const limit: number = query.limit ?? 32;
        const depth: number = query.maxDepth ?? 1;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(depth) || depth < 0 || depth > 100) {
            throw new RangeError("workspace query requires limit 1..1000 and depth 0..100");
        }
        const projects: Set<string> | undefined = query.projectIds === (void 0) ? (void 0) : new Set(query.projectIds);
        const allowed: (id: string) => boolean = (id: string): boolean => {
            const entity: WorkspaceEntity | undefined = this.entities.get(id);
            return entity !== (void 0) && (projects === (void 0) || projects.has(entity.projectId));
        };
        const candidates: WorkspaceCandidate[] = [];
        const visited: Set<string> = new Set();
        let truncated: boolean = false;
        const admit: (id: string, why: WorkspaceCandidate["why"], hops: number) => void = (id: string, why: WorkspaceCandidate["why"], hops: number): void => {
            if (visited.has(id) || !allowed(id)) {
                return;
            }
            visited.add(id);
            if (candidates.length >= limit) {
                truncated = true;
                return;
            }
            candidates.push({ id, why, hops });
        };
        (query.seedIds ?? []).forEach((id: string): void => {
            admit(id, "seed", 0);
        });
        const words: string[] = workspaceTerms(query.text ?? "");
        if (words.length > 0) {
            const lists: Set<string>[] = words.map((word: string): Set<string> => this.postings.get(word) ?? new Set());
            lists.sort((left: Set<string>, right: Set<string>): number => left.size - right.size);
            [...lists[0]]
                .filter((id: string): boolean => lists.every((list: Set<string>): boolean => list.has(id)))
                .sort()
                .forEach((id: string): void => {
                    admit(id, "text", 0);
                });
        }
        const kinds: Set<WorkspaceRelationKind> | undefined = query.relationKinds === (void 0) ? (void 0) : new Set(query.relationKinds);
        const direction: WorkspaceQuery["direction"] = query.direction ?? "both";
        for (let index: number = 0; index < candidates.length; index += 1) {
            const candidate: WorkspaceCandidate = candidates[index];
            if (candidate.hops >= depth) {
                continue;
            }
            const adjacent: WorkspaceRelation[] = [
                ...(direction !== "incoming" ? (this.outgoing.get(candidate.id) ?? []) : []),
                ...(direction !== "outgoing" ? (this.incoming.get(candidate.id) ?? []) : []),
            ];
            adjacent.forEach((edge: WorkspaceRelation): void => {
                if (kinds === (void 0) || kinds.has(edge.kind)) {
                    admit(edge.from === candidate.id ? edge.to : edge.from, edge.kind, candidate.hops + 1);
                }
            });
        }
        return {
            revision: this.revision,
            candidates,
            unknownIds: [...new Set(query.seedIds ?? [])].filter((id: string): boolean => !this.entities.has(id)),
            truncated,
        };
    }

    /**
     * A disposable AST projection; source facts and indexes stay isolated from
     * live AST mutations. Descriptive dependency cycles remain legal.
     */
    project(): ContextAst {
        const graph: ContextAst = new ContextAst();
        this.entities.forEach((entity: WorkspaceEntity): void => {
            const location: string =
                entity.source.locator === (void 0)
                    ? entity.source.startLine === (void 0)
                        ? entity.source.uri
                        : `${entity.source.uri}:${entity.source.startLine}`
                    : `${entity.source.uri}#${JSON.stringify(entity.source.locator)}`;
            const node: ContextAstNode = {
                id: entity.id,
                parentId: entity.parentId,
                kind: entity.kind,
                summary: `${this.summaryState(entity.id) === "stale" ? `${entity.label} [summary stale; read detail]` : entity.summary} | source=${JSON.stringify(location)} revision=${JSON.stringify(entity.source.revision)}`,
                detailRef: entity.detailRef,
                order: graph.size,
                salience: entity.kind === "project" || entity.kind === "directory" ? 0 : 1,
            };
            graph.add(node);
        });
        this.edges.forEach((edge: WorkspaceRelation): void => {
            graph.link({ from: edge.from, to: edge.to, kind: edge.kind });
        });
        return graph;
    }

    context(frame: Frame, budgetTokens: number): Context {
        const context: Context = Context.create(frame, this.project(), { store: this.store });
        context.materialize({ budgetTokens });
        return context;
    }

    snapshot(): WorkspaceSnapshot {
        return {
            version: 1,
            revision: this.revision,
            entities: [...this.entities.values()].map(cloneEntity),
            relations: this.edges.map(cloneRelation),
            diagnostics: this.diagnostics.map((item: WorkspaceDiagnostic): WorkspaceDiagnostic => ({ ...item })),
        };
    }
}
