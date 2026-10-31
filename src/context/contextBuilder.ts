/**
 * Read-only agent context assembly over one filesystem session.
 *
 * `ContextBuilder` turns a small, explicit set of host requests (a file, a
 * directory, an outline, import/export facts, a dependency closure, a note)
 * into one immutable `ContextPackage`. It never writes, never resolves host
 * paths itself, and never caches across instances: every method delegates path
 * validation to the session, and `build()` derives the selection from the
 * drafts and the session revision alone.
 *
 * Selection is deterministic. Candidates are scored (anchor provenance, anchor
 * path prefix, outline depth, graph distance, note), admitted by a
 * `PriorityQueue` under a token budget and an item ceiling, deduplicated by
 * canonical item identity, and finally sorted by score, path and id. Relations
 * are emitted only between selected items; a relation endpoint that the session
 * scope cannot contain becomes an explicit omission instead of a dangling edge.
 *
 * Token accounting is conservative by construction: each admitted line is
 * charged with `estimateTokens` before the next candidate is considered, so an
 * item that does not fit is omitted whole rather than silently shortened.
 */
import type { DependencyQuery, ExportRequest, ImportRequest, OutlineRequest } from "../file/service.ts";
import { buildOutlineIndex } from "../outline/outlineIndex.ts";
import type { OutlineIndex } from "../outline/outlineIndex.ts";
import type { DependencyEdge, DependencyMode, DependencyNode, DependencyReport, DirectoryNode, ExportReport, ExportSymbol, FileNode, ImportEdge, ImportReport, ReadPage, ReadRequest } from "../file/types.ts";
import type { OutlineNode, OutlineResult } from "../outline/types.ts";
import type { SessionDescriptor } from "../session/types.ts";
import { AbstractSyntaxTree } from "../structure/abstractSyntaxTree.ts";
import type { AstNode } from "../structure/abstractSyntaxTree.ts";
import { PriorityQueue } from "../structure/priority.ts";
import { estimateTokens } from "./agentContext.ts";
import { ContextAst } from "./ast.ts";
import type { ContextAstNode, ContextNodeKind } from "./ast.ts";
import { clampSummary, ContextBuilderError, freezeContextPackage, renderContextPackageText, renderContextRelation, toContextRange } from "./contextPackage.ts";
import type {
    ContextBuilderErrorCode,
    ContextItem,
    ContextItemKind,
    ContextOmission,
    ContextOmissionReason,
    ContextPackage,
    ContextProvenance,
    ContextRelation,
    ContextRelationKind,
} from "./contextPackage.ts";
import { compareScoredDrafts, draftTokens, PathPrefixIndex, provenanceRank, resolveContextWeights, scoreDraft } from "./relevance.ts";
import type { ContextItemDraft, ContextWeights, ScoredDraft, TokenEstimator } from "./relevance.ts";

/**
 * The structural, read-only session surface the builder requires.
 *
 * `FilesystemSession` satisfies it directly, so a host can pass a bound handle
 * without an adapter. The interface deliberately excludes `write`, `dispatch`
 * and tool envelopes: a builder can read, outline and query graphs, nothing
 * more. Paths stay root-relative; the session owns sandboxing and error codes.
 */
export interface ContextBuilderSession {
    readonly sessionId: string;
    readonly descriptor: SessionDescriptor;
    read(request: ReadRequest): ReadPage;
    outline(request: OutlineRequest): OutlineResult;
    imports(request: ImportRequest): ImportReport;
    exports(request: ExportRequest): ExportReport;
    dependency(request: DependencyQuery): DependencyReport;
    revision(): string;
}

/**
 * Per-file knobs for {@link ContextBuilder.addFile}.
 */
export interface AddFileOptions {
    /**
     * Host-authored summary. When omitted, a bounded preview of the first
     * non-empty line plus charset/line/byte facts is used.
     */
    readonly summary?: string;
    /**
     * Opaque host detail handle. The builder never dereferences it.
     */
    readonly detailRef?: string;
    /**
     * Maximum preview lines read for the summary. Defaults to 2.
     */
    readonly maxLines?: number;
    /**
     * Maximum preview bytes read for the summary. Defaults to 1024.
     */
    readonly maxBytes?: number;
}

/**
 * Outline filters accepted by {@link ContextBuilder.addOutline}.
 */
export interface AddOutlineOptions {
    /**
     * Case-insensitive symbol label prefix.
     */
    readonly query?: string;
    /**
     * 1-based inclusive line window.
     */
    readonly startLine?: number;
    /**
     * 1-based inclusive line window end.
     */
    readonly endLine?: number;
    /**
     * Maximum symbols scanned and admitted from this outline. Defaults to 256.
     */
    readonly maxNodes?: number;
}

/**
 * Import traversal direction.
 */
export type ImportDirection = "outgoing" | "incoming" | "both";

/**
 * Knobs for {@link ContextBuilder.addImports}.
 */
export interface AddImportsOptions {
    /**
     * `outgoing` (what this file imports), `incoming` (what imports it), or
     * `both`. Defaults to `outgoing`.
     */
    readonly direction?: ImportDirection;
    /**
     * Bounded hop count from the anchor. Defaults to 1 and never exceeds the
     * builder's `maxDepth`.
     */
    readonly depth?: number;
}

/**
 * Knobs for {@link ContextBuilder.addExports}.
 */
export interface AddExportsOptions {
    /**
     * Also represent the exporting file as a module item, so `contains` edges
     * close even when the caller never called `addFile`. Defaults to false for
     * budget predictability.
     */
    readonly anchor?: boolean;
}

/**
 * Knobs for {@link ContextBuilder.addDependency}.
 */
export interface AddDependencyOptions {
    readonly mode: DependencyMode;
    /**
     * Root-relative starting paths. Empty means "the bounded report roots".
     */
    readonly roots?: readonly string[];
    /**
     * Bounded hop count for the graph query; defaults to `min(2, maxDepth)`.
     */
    readonly depth?: number;
}

/**
 * Construction options.
 */
export interface ContextBuilderOptions {
    readonly session: ContextBuilderSession;
    readonly budgetTokens: number;
    /**
     * Maximum admitted items. Defaults to 256.
     */
    readonly maxItems?: number;
    /**
     * Hard traversal ceiling for imports, dependencies and directory expansion.
     * Defaults to 4.
     */
    readonly maxDepth?: number;
    /**
     * Whether graph edges are rendered. Defaults to true.
     */
    readonly includeRelations?: boolean;
    /**
     * Partial scoring overrides; omitted signals keep their defaults.
     */
    readonly weights?: Partial<ContextWeights>;
    /**
     * Optional token estimator. Defaults to the shared `estimateTokens`
     * heuristic; a host with a real tokenizer injects it here so a CJK-heavy
     * prompt is not budgeted at four characters per token.
     */
    readonly tokenEstimator?: TokenEstimator;
}

/**
 * One relation endpoint: a concrete item id, or a module path resolved against
 * the selection. Path endpoints make edges stable across provenance promotion:
 * the same module keeps one identity however it was discovered.
 */
interface EndpointItem {
    readonly itemId: string;
}

/**
 * A module path endpoint.
 */
interface EndpointPath {
    readonly path: string;
}

/**
 * Union of the two endpoint forms.
 */
type ContextEndpoint = EndpointItem | EndpointPath;

/**
 * One edge waiting for endpoint resolution at build time.
 */
interface PendingRelation {
    readonly from: ContextEndpoint;
    readonly to: ContextEndpoint;
    readonly kind: ContextRelationKind;
}

/**
 * A scope or resolution miss discovered during expansion.
 *
 * The omission is materialized only when the item that required it is itself
 * selected, so the package never reports a gap nobody in the prompt asked for.
 */
interface EndpointRequirement {
    readonly id: string;
    readonly reason: ContextOmissionReason;
    /**
     * Item id that requires the endpoint. Keeping the id instead of a path lets
     * an export item (which has no module item of its own) own its omission.
     */
    readonly viaId: string;
}

/**
 * One outline node plus the identity its item will receive.
 */
interface OutlineEntry {
    readonly node: OutlineNode;
    readonly itemId: string;
    readonly parentItemId?: string;
}

/**
 * One pending node in the outline hierarchy walk.
 */
interface OutlineWork {
    readonly node: OutlineNode;
    readonly target: AstNode<OutlineEntry>;
    readonly parentItemId?: string;
}

/**
 * Hierarchy projection of one outline result.
 */
interface OutlineHierarchy {
    readonly root: AstNode<OutlineEntry>;
    readonly parents: Map<string, string | undefined>;
}

/**
 * One directory still to expand.
 */
interface DirectoryWork {
    readonly path: string;
    readonly level: number;
    readonly parentPath?: string;
}

/**
 * One file still to expand during an import traversal.
 */
interface ImportWork {
    readonly path: string;
    readonly hop: number;
}

/**
 * Inputs for one discovered module item.
 *
 * A spec object keeps the discovery helper's signature short enough for the
 * project's single-line parameter rule while still naming every fact.
 */
interface DiscoverySpec {
    readonly path: string;
    readonly kind: ContextItemKind;
    readonly provenance: ContextProvenance;
    readonly graphDistance: number;
    readonly why: string;
    readonly detailRef?: string;
}

/**
 * The session methods the builder calls. A handle missing one of these is a
 * host wiring bug, not a degraded session.
 */
const SessionMethods: readonly string[] = ["read", "outline", "imports", "exports", "dependency", "revision"];

/**
 * Default item ceiling and hard maximum.
 */
const DefaultMaxItems: number = 256;
const HardMaxItems: number = 4096;

/**
 * Default traversal ceiling and hard maximum.
 */
const DefaultMaxDepth: number = 4;
const HardMaxDepth: number = 8;

/**
 * Upper bound on nodes read from one directory expansion.
 */
const DirectoryScanNodes: number = 256;

/**
 * Upper bound on nodes read from one outline expansion.
 */
const OutlineScanNodes: number = 256;

/**
 * Upper bound on edges read from one import query.
 */
const ImportScanLimit: number = 256;

/**
 * Upper bound on nodes and edges read from one dependency query.
 */
const DependencyScanLimit: number = 1000;

/**
 * Preview limits for a discovered module; explicit `addFile` can raise them.
 */
const DiscoveryReadLines: number = 2;
const DiscoveryReadBytes: number = 1024;

/**
 * Preview length for the first summary line.
 */
const FilePreviewChars: number = 160;

/**
 * Bound for the `why` field after evidence merging.
 */
const WhyLimit: number = 512;

/**
 * Omission ordering used for stable output.
 */
const OmissionOrder: readonly ContextOmissionReason[] = ["duplicate", "budget", "missing", "outside_scope"];

/**
 * Relation ordering used for stable output.
 */
const RelationOrder: readonly ContextRelationKind[] = ["contains", "import", "export", "dependency"];

/**
 * Throw one classified builder error.
 *
 * @param code - Closed failure code.
 */
const fail: (code: ContextBuilderErrorCode) => never = (code: ContextBuilderErrorCode): never => {
    throw new ContextBuilderError(code);
};

/**
 * Pick the first non-empty string.
 *
 * @param values - Candidate strings.
 * @returns The first trimmed non-empty value, or `""`.
 */
const firstText: (values: readonly string[]) => string = (values: readonly string[]): string => {
    for (let index: number = 0; index < values.length; index += 1) {
        const value: string = values[index].trim();
        if (value.length > 0) {
            return value;
        }
    }
    return "";
};

/**
 * Keep the first non-empty source line, bounded for a summary.
 *
 * @param text - Page text.
 * @param limit - Maximum characters kept.
 * @returns The bounded line, or `""` when the page has no text.
 */
const firstLine: (text: string, limit: number) => string = (text: string, limit: number): string => {
    const lines: string[] = text.split(/\r?\n/u).map((line: string): string => line.trim());
    for (let index: number = 0; index < lines.length; index += 1) {
        const line: string = lines[index];
        if (line.length > 0) {
            return line.length <= limit ? line : `${line.slice(0, limit - 3)}...`;
        }
    }
    return "";
};

/**
 * Build a one-line summary from a bounded read page.
 *
 * @param page - Page returned by the session.
 * @returns A summary of at most `ContextSummaryLimit` characters.
 */
const readPageSummary: (page: ReadPage) => string = (page: ReadPage): string => {
    const preview: string = firstLine(page.text, FilePreviewChars);
    const facts: string = `${page.charset}, ${page.totalLines} lines, ${page.totalBytes} bytes`;
    return clampSummary(preview.length === 0 ? `empty file | ${facts}` : `${preview} | ${facts}`);
};

/**
 * Build a one-line summary from a file node's metadata.
 *
 * @param node - File node supplied by the session.
 * @returns A summary of at most `ContextSummaryLimit` characters.
 */
const fileNodeSummary: (node: FileNode) => string = (node: FileNode): string => {
    const detail: string = firstText([node.description, node.summary, node.purpose]);
    const facts: string = `${node.charset}, ${node.lines} lines, ${node.bytes} bytes`;
    return clampSummary(detail.length === 0 ? facts : `${detail} | ${facts}`);
};

/**
 * Build a one-line summary from a directory node's metadata.
 *
 * @param node - Directory node supplied by the session.
 * @returns A summary of at most `ContextSummaryLimit` characters.
 */
const directoryNodeSummary: (node: DirectoryNode) => string = (node: DirectoryNode): string => {
    const detail: string = firstText([node.description, node.summary, node.purpose]);
    const facts: string = `${node.children.length} entries, ${node.lines} lines, ${node.bytes} bytes`;
    return clampSummary(detail.length === 0 ? facts : `${detail} | ${facts}`);
};

/**
 * Whether a dependency node lives outside the workspace scope.
 *
 * @param node - Dependency graph node.
 * @returns True for package nodes and `external:` ids.
 */
const isExternalDependency: (node: DependencyNode) => boolean = (node: DependencyNode): boolean => {
    return node.kind === "package" || node.id.startsWith("external:");
};

/**
 * Map an item kind to the context AST's closed node kinds.
 *
 * @param kind - Item kind.
 * @returns A hierarchy node kind.
 */
const contextNodeKind: (kind: ContextItemKind) => ContextNodeKind = (kind: ContextItemKind): ContextNodeKind => {
    switch (kind) {
        case "file": {
            return "file";
        }
        case "directory": {
            return "directory";
        }
        case "outline": {
            return "symbol";
        }
        case "import": {
            return "package";
        }
        case "export": {
            return "detail";
        }
        case "dependency": {
            return "package";
        }
        default: {
            return "knowledge";
        }
    }
};

/**
 * Canonical item id for a module path.
 *
 * Module items keep the same id whatever their kind: a file reached first
 * through imports and later added as an anchor is one item, promoted in place.
 *
 * @param path - Root-relative path.
 * @param directory - Whether the path is a directory.
 * @returns The canonical item id.
 */
const moduleId: (path: string, directory: boolean) => string = (path: string, directory: boolean): string => {
    return `${directory ? "directory" : "file"}:${path}`;
};

/**
 * Compare two relations in canonical order.
 *
 * @param left - Left relation.
 * @param right - Right relation.
 * @returns Negative when `left` sorts first.
 */
const compareRelations: (left: ContextRelation, right: ContextRelation) => number = (left: ContextRelation, right: ContextRelation): number => {
    const leftKind: number = RelationOrder.indexOf(left.kind);
    const rightKind: number = RelationOrder.indexOf(right.kind);
    if (leftKind !== rightKind) {
        return leftKind - rightKind;
    }
    if (left.from !== right.from) {
        return left.from < right.from ? -1 : 1;
    }
    if (left.to !== right.to) {
        return left.to < right.to ? -1 : 1;
    }
    return 0;
};

/**
 * Merge omission records with the same reason and id, unioning required IDs.
 *
 * @param omissions - Omissions accumulated by the builder.
 * @returns Sorted, deduplicated omissions.
 */
const mergeOmissions: (omissions: readonly ContextOmission[]) => ContextOmission[] = (omissions: readonly ContextOmission[]): ContextOmission[] => {
    const byKey: Map<string, ContextOmission> = new Map<string, ContextOmission>();
    omissions.forEach((omission: ContextOmission): void => {
        const key: string = `${omission.reason}:${omission.id}`;
        const existing: ContextOmission | undefined = byKey.get(key);
        const required: string[] = [...(existing?.requiredIds ?? []), ...(omission.requiredIds ?? [])];
        const unique: string[] = [...new Set<string>(required)].sort();
        byKey.set(key, {
            id: omission.id,
            reason: omission.reason,
            ...(unique.length === 0 ? {} : { requiredIds: unique }),
        });
    });
    return [...byKey.values()].sort((left: ContextOmission, right: ContextOmission): number => {
        const leftRank: number = OmissionOrder.indexOf(left.reason);
        const rightRank: number = OmissionOrder.indexOf(right.reason);
        if (leftRank !== rightRank) {
            return leftRank - rightRank;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
};

/**
 * Function shape of {@link dependencyDistances}, keeping its signature on one
 * line.
 */
type DependencyDistanceFn = (report: DependencyReport, maxDepth: number) => Map<string, number>;

/**
 * Breadth-first distance from the report roots over dependency edges.
 *
 * When a report has no explicit roots the whole bounded subgraph is treated as
 * the anchor, so every node is at distance 0. Nodes unreachable inside the
 * requested depth simply get no distance bonus.
 *
 * @param report - Dependency report.
 * @param maxDepth - Hop ceiling used for the query.
 * @returns Node id to hop count.
 */
const dependencyDistances: DependencyDistanceFn = (report: DependencyReport, maxDepth: number): Map<string, number> => {
    const distances: Map<string, number> = new Map<string, number>();
    const adjacency: Map<string, string[]> = new Map<string, string[]>();
    report.edges.forEach((edge: DependencyEdge): void => {
        const targets: string[] = adjacency.get(edge.from) ?? [];
        targets.push(edge.to);
        adjacency.set(edge.from, targets);
    });
    const roots: string[] = report.roots.length === 0 ? report.nodes.map((node: DependencyNode): string => node.id) : [...report.roots];
    const queue: string[] = [...roots];
    roots.forEach((id: string): void => {
        distances.set(id, 0);
    });
    for (let index: number = 0; index < queue.length; index += 1) {
        const current: string = queue[index];
        const distance: number = distances.get(current) ?? 0;
        if (distance >= maxDepth) {
            continue;
        }
        const targets: string[] = adjacency.get(current) ?? [];
        targets.forEach((target: string): void => {
            if (!distances.has(target)) {
                distances.set(target, distance + 1);
                queue.push(target);
            }
        });
    }
    return distances;
};

/**
 * Assemble immutable context packages from one session.
 *
 * The builder is single-session by construction: it stores the descriptor it
 * validated, never a host path, and never a token. It keeps no module-level
 * state, so two builders in one process cannot observe each other, and the same
 * input plus the same session revision always produces the same package.
 */
export class ContextBuilder {
    readonly sessionId: string;
    private readonly session: ContextBuilderSession;
    private readonly budgetTokens: number;
    private readonly maxItems: number;
    private readonly maxDepth: number;
    private readonly includeRelations: boolean;
    private readonly weights: ContextWeights;
    private readonly tokenEstimator: TokenEstimator;
    private readonly prefixes: PathPrefixIndex = new PathPrefixIndex();
    private readonly drafts: Map<string, ContextItemDraft> = new Map<string, ContextItemDraft>();
    private readonly moduleDrafts: Map<string, string> = new Map<string, string>();
    private readonly relations: Map<string, PendingRelation> = new Map<string, PendingRelation>();
    private readonly requirements: Map<string, EndpointRequirement> = new Map<string, EndpointRequirement>();
    private readonly omissions: Map<string, ContextOmission> = new Map<string, ContextOmission>();
    private readonly expansions: Map<string, string> = new Map<string, string>();
    private reportTruncated: boolean = false;

    /**
     * Validate the session shape, budget and bounds.
     *
     * @param options - Session handle and assembly bounds.
     * @throws ContextBuilderError for an unusable session, a non-positive
     * budget, an out-of-range item/depth ceiling, or an invalid weight.
     */
    constructor(options: ContextBuilderOptions) {
        if (options === null || typeof(options) !== "object" || options.session === null || typeof(options.session) !== "object") {
            fail("invalid_arguments");
        }
        const session: Record<string, unknown> = options.session as unknown as Record<string, unknown>;
        const missing: string[] = SessionMethods.filter((name: string): boolean => typeof(session[name]) !== "function");
        if (missing.length > 0) {
            fail("invalid_arguments");
        }
        const sessionId: unknown = session.sessionId;
        if (typeof(sessionId) !== "string" || sessionId.length === 0) {
            fail("invalid_arguments");
        }
        const descriptor: unknown = session.descriptor;
        if (descriptor === null || typeof(descriptor) !== "object") {
            fail("invalid_arguments");
        }
        const descriptorRecord: Record<string, unknown> = descriptor as Record<string, unknown>;
        const permissions: unknown = descriptorRecord.permissions;
        if (permissions === null || typeof(permissions) !== "object" || (permissions as Record<string, unknown>).read !== true) {
            fail("invalid_arguments");
        }
        if (descriptorRecord.id !== sessionId) {
            fail("invalid_arguments");
        }
        if (!Number.isSafeInteger(options.budgetTokens) || options.budgetTokens <= 0) {
            fail("invalid_arguments");
        }
        this.sessionId = sessionId;
        this.session = options.session;
        this.budgetTokens = options.budgetTokens;
        this.maxItems = options.maxItems === (void 0) ? DefaultMaxItems : ContextBuilder.requirePositive(options.maxItems, HardMaxItems);
        this.maxDepth = options.maxDepth === (void 0) ? DefaultMaxDepth : ContextBuilder.requireDepth(options.maxDepth);
        if (options.includeRelations !== (void 0) && typeof(options.includeRelations) !== "boolean") {
            fail("invalid_arguments");
        }
        this.includeRelations = options.includeRelations !== false;
        if (options.tokenEstimator !== (void 0) && typeof(options.tokenEstimator) !== "function") {
            fail("invalid_arguments");
        }
        this.tokenEstimator = options.tokenEstimator ?? estimateTokens;
        this.weights = resolveContextWeights(options.weights);
    }

    /**
     * Measure one rendered line with the configured estimator.
     *
     * A host-provided estimator is validated on every use: a non-integer or
     * negative result would silently corrupt the budget, so it is a caller
     * error rather than a clamped value.
     *
     * @param text - Rendered line or summary text.
     * @returns A non-negative safe integer token count.
     */
    private measureTokens(text: string): number {
        const tokens: number = this.tokenEstimator(text);
        if (!Number.isSafeInteger(tokens) || tokens < 0) {
            fail("invalid_arguments");
        }
        return tokens;
    }

    /**
     * Validate a positive integer bound.
     *
     * @param value - Candidate value.
     * @param max - Inclusive maximum.
     * @returns The value as a number.
     */
    private static requirePositive(value: unknown, max: number): number {
        if (typeof(value) !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
            fail("invalid_arguments");
        }
        return value as number;
    }

    /**
     * Validate a traversal depth.
     *
     * @param value - Candidate value.
     * @returns The value as a number.
     */
    private static requireDepth(value: unknown): number {
        if (typeof(value) !== "number" || !Number.isSafeInteger(value) || value < 0 || value > HardMaxDepth) {
            fail("invalid_arguments");
        }
        return value as number;
    }

    /**
     * Register one anchor path and its directory prefix for prefix scoring.
     *
     * @param path - Root-relative anchor path.
     */
    private anchorPath(path: string): void {
        this.prefixes.add(path);
        const slash: number = path.lastIndexOf("/");
        if (slash > 0) {
            this.prefixes.add(path.slice(0, slash + 1));
        }
    }

    /**
     * Record one omission, merging required IDs with an existing entry.
     *
     * @param id - Omitted candidate id.
     * @param reason - Closed reason.
     * @param requiredIds - Selected items that made the omission relevant.
     */
    private omit(id: string, reason: ContextOmissionReason, requiredIds?: readonly string[]): void {
        const key: string = `${reason}:${id}`;
        const existing: ContextOmission | undefined = this.omissions.get(key);
        const required: string[] = [...new Set<string>([...(existing?.requiredIds ?? []), ...(requiredIds ?? [])])].sort();
        this.omissions.set(key, {
            id,
            reason,
            ...(required.length === 0 ? {} : { requiredIds: required }),
        });
    }

    /**
     * Append one evidence sentence to a draft's `why`, ignoring repeats.
     *
     * The field is bounded because it is diagnostic metadata, not prompt text.
     *
     * @param draft - Draft to update.
     * @param note - Evidence to merge.
     */
    private mergeWhy(draft: ContextItemDraft, note: string): void {
        const text: string = note.trim();
        if (text.length === 0 || draft.why.includes(text) || draft.why.length >= WhyLimit) {
            return;
        }
        draft.why = draft.why.length === 0 ? text : `${draft.why}; ${text}`;
    }

    /**
     * Register a draft as the module representative for its path.
     *
     * @param draft - Draft just added or promoted.
     */
    private registerModule(draft: ContextItemDraft): void {
        const moduleKind: boolean = draft.kind === "file" || draft.kind === "import" || draft.kind === "dependency" || draft.kind === "directory";
        if (moduleKind && draft.path.length > 0) {
            this.moduleDrafts.set(draft.path, draft.id);
        }
    }

    /**
     * Insert a draft, promoting or merging an existing item with the same id.
     *
     * Promotion is how call order stops mattering: a file discovered through
     * imports and later anchored becomes the anchored item in place, and the
     * reverse order produces the same item because the weaker view is merged
     * instead of duplicated.
     *
     * @param draft - Draft to insert.
     * @param recordDuplicate - Whether a same-id, lower-or-equal rank draft is
     * reported as a duplicate omission.
     */
    private addDraft(draft: ContextItemDraft, recordDuplicate: boolean): void {
        const existing: ContextItemDraft | undefined = this.drafts.get(draft.id);
        if (existing !== (void 0)) {
            if (provenanceRank(draft.provenance) > provenanceRank(existing.provenance)) {
                this.mergeWhy(draft, existing.why);
                if (existing.graphDistance !== (void 0) && (draft.graphDistance === (void 0) || existing.graphDistance < draft.graphDistance)) {
                    draft.graphDistance = existing.graphDistance;
                }
                this.drafts.set(draft.id, draft);
                this.registerModule(draft);
                return;
            }
            this.mergeWhy(existing, draft.why);
            if (existing.graphDistance === (void 0) || (draft.graphDistance !== (void 0) && draft.graphDistance < existing.graphDistance)) {
                existing.graphDistance = draft.graphDistance;
            }
            if (recordDuplicate) {
                this.omit(draft.id, "duplicate", [existing.id]);
            }
            return;
        }
        this.drafts.set(draft.id, draft);
        this.registerModule(draft);
    }

    /**
     * Build a module draft from a best-effort preview read.
     *
     * Discovery reads are advisory: a binary, vanished or unreadable file still
     * appears as a module item with a path summary, because the edge that
     * discovered it is already established. An explicit `addFile` surfaces the
     * session error instead.
     *
     * @param spec - Path, kind, provenance, distance, evidence and detail handle.
     * @returns A draft with a path fallback summary on read failure.
     */
    private discoveryDraft(spec: DiscoverySpec): ContextItemDraft {
        let summary: string = `module ${spec.path}`;
        try {
            const page: ReadPage = this.session.read({ path: spec.path, maxLines: DiscoveryReadLines, maxBytes: DiscoveryReadBytes });
            summary = readPageSummary(page);
        } catch {
            /**
             * The edge proved the module exists; a preview failure must not
             * abort an otherwise valid package.
             */
        }
        return {
            id: moduleId(spec.path, false),
            kind: spec.kind,
            path: spec.path,
            summary: clampSummary(summary),
            provenance: spec.provenance,
            why: spec.why,
            graphDistance: spec.graphDistance,
            ...(spec.detailRef === (void 0) ? {} : { detailRef: spec.detailRef }),
        };
    }

    /**
     * Ensure one module path is represented, preserving the strongest view.
     *
     * @param spec - Path, kind, provenance, distance, evidence and detail handle.
     * @returns The canonical module item id.
     */
    private ensureModuleItem(spec: DiscoverySpec): string {
        const id: string = moduleId(spec.path, false);
        const existing: ContextItemDraft | undefined = this.drafts.get(id);
        if (existing !== (void 0)) {
            if (provenanceRank(spec.provenance) > provenanceRank(existing.provenance)) {
                this.addDraft(this.discoveryDraft(spec), false);
                return id;
            }
            this.mergeWhy(existing, spec.why);
            if (existing.graphDistance === (void 0) || spec.graphDistance < existing.graphDistance) {
                existing.graphDistance = spec.graphDistance;
            }
            return id;
        }
        this.addDraft(this.discoveryDraft(spec), false);
        return id;
    }

    /**
     * Add one explicitly requested file.
     *
     * The summary is the host's when supplied, otherwise a bounded preview plus
     * charset/line/byte facts. Path validity and sandbox checks belong to the
     * session, so their classified errors propagate unchanged.
     *
     * @param path - Root-relative file path.
     * @param options - Summary, detail handle and preview bounds.
     * @returns The canonical file item id.
     * @throws Error from the session for an unknown, binary or escaped path.
     * @throws ContextBuilderError for an invalid preview bound.
     */
    addFile(path: string, options?: AddFileOptions): string {
        if (typeof(path) !== "string" || path.length === 0) {
            fail("invalid_arguments");
        }
        const settings: AddFileOptions = options ?? {};
        if (
            settings.maxLines !== (void 0) &&
            (typeof(settings.maxLines) !== "number" || !Number.isSafeInteger(settings.maxLines) || settings.maxLines < 1 || settings.maxLines > 200)
        ) {
            fail("invalid_arguments");
        }
        if (
            settings.maxBytes !== (void 0) &&
            (typeof(settings.maxBytes) !== "number" || !Number.isSafeInteger(settings.maxBytes) || settings.maxBytes < 1 || settings.maxBytes > 65_536)
        ) {
            fail("invalid_arguments");
        }
        if (settings.summary !== (void 0) && typeof(settings.summary) !== "string") {
            fail("invalid_arguments");
        }
        if (settings.detailRef !== (void 0) && (typeof(settings.detailRef) !== "string" || settings.detailRef.length === 0)) {
            fail("invalid_arguments");
        }
        const page: ReadPage = this.session.read({
            path,
            maxLines: settings.maxLines ?? DiscoveryReadLines,
            maxBytes: settings.maxBytes ?? DiscoveryReadBytes,
        });
        const summary: string = settings.summary === (void 0) ? readPageSummary(page) : clampSummary(settings.summary);
        this.anchorPath(path);
        const draft: ContextItemDraft = {
            id: moduleId(path, false),
            kind: "file",
            path,
            summary,
            provenance: "anchor",
            why: "anchor: host-selected file",
            ...(settings.detailRef === (void 0) ? {} : { detailRef: settings.detailRef }),
        };
        this.addDraft(draft, true);
        return draft.id;
    }

    /**
     * Add one directory and, recursively, its entries.
     *
     * One session `outline` call per directory yields the direct child anchors;
     * deeper levels are separate calls bounded by the requested depth, the
     * builder's `maxDepth` and an internal scan ceiling. Every entry becomes a
     * `tree` item with a `contains` parent, and a directory whose scan is cut
     * short is reported as a budget omission rather than silently shortened.
     *
     * @param path - Root-relative directory path.
     * @param depth - Levels to expand; defaults to 1.
     * @returns The canonical directory item id.
     * @throws ContextBuilderError when the session reports a non-directory.
     */
    addDirectory(path: string, depth: number = 1): string {
        if (typeof(path) !== "string" || path.length === 0) {
            fail("invalid_arguments");
        }
        const requested: number = ContextBuilder.requireDepth(depth);
        const effective: number = Math.min(requested, this.maxDepth);
        const directoryId: string = moduleId(path, true);
        const key: string = `directory:${path}:${effective}`;
        const cached: string | undefined = this.expansions.get(key);
        if (cached !== (void 0)) {
            return cached;
        }
        this.anchorPath(path);
        const queue: DirectoryWork[] = [{ path, level: 0 }];
        const visited: Set<string> = new Set<string>([path]);
        let scanned: number = 0;
        for (let index: number = 0; index < queue.length; index += 1) {
            const work: DirectoryWork = queue[index];
            const result: OutlineResult = this.session.outline({ path: work.path, maxNodes: DirectoryScanNodes });
            if (result.truncated) {
                this.reportTruncated = true;
            }
            if (result.target !== "directory" || result.nodes.length === 0) {
                fail("not_directory");
            }
            const rootNode: OutlineNode = result.nodes[0];
            const rootDirectory: DirectoryNode | undefined = rootNode.directory;
            const rootSummary: string = rootDirectory === (void 0) ? clampSummary(`${work.path} directory`) : directoryNodeSummary(rootDirectory);
            const rootProvenance: ContextProvenance = work.level === 0 ? "anchor" : "tree";
            const rootWhy: string = work.level === 0 ? "anchor: host-selected directory" : `tree: directory under ${work.parentPath ?? ""}`;
            this.addDraft(
                {
                    id: moduleId(work.path, true),
                    kind: "directory",
                    path: work.path,
                    summary: rootSummary,
                    provenance: rootProvenance,
                    why: rootWhy,
                    ...(work.parentPath === (void 0) ? {} : { parentId: moduleId(work.parentPath, true) }),
                },
                false,
            );
            if (work.level >= effective) {
                continue;
            }
            for (let childIndex: number = 0; childIndex < rootNode.children.length; childIndex += 1) {
                const child: OutlineNode = rootNode.children[childIndex];
                scanned += 1;
                if (scanned > DirectoryScanNodes) {
                    this.reportTruncated = true;
                    this.omit(directoryId, "budget");
                    break;
                }
                const file: FileNode | undefined = child.file;
                const directory: DirectoryNode | undefined = child.directory;
                if (file === (void 0) && directory === (void 0)) {
                    /**
                     * A session may legitimately return a lean anchor without
                     * the full node payload. The entry still exists, so keep a
                     * path/label item instead of silently dropping it.
                     */
                    const leanDirectory: boolean = child.isDirectory;
                    this.addDraft(
                        {
                            id: moduleId(child.path, leanDirectory),
                            kind: leanDirectory ? "directory" : "file",
                            path: child.path,
                            summary: clampSummary(child.label.length === 0 ? child.path : child.label),
                            provenance: "tree",
                            why: `tree: entry of ${work.path}`,
                            parentId: moduleId(work.path, true),
                        },
                        false,
                    );
                    continue;
                }
                if (file !== (void 0)) {
                    this.addDraft(
                        {
                            id: moduleId(file.path, false),
                            kind: "file",
                            path: file.path,
                            summary: fileNodeSummary(file),
                            provenance: "tree",
                            why: `tree: entry of ${work.path}`,
                            parentId: moduleId(work.path, true),
                        },
                        false,
                    );
                    continue;
                }
                if (directory === (void 0)) {
                    continue;
                }
                this.addDraft(
                    {
                        id: moduleId(directory.path, true),
                        kind: "directory",
                        path: directory.path,
                        summary: directoryNodeSummary(directory),
                        provenance: "tree",
                        why: `tree: directory under ${work.path}`,
                        parentId: moduleId(work.path, true),
                    },
                    false,
                );
                if (work.level + 1 < effective && !visited.has(directory.path)) {
                    visited.add(directory.path);
                    queue.push({ path: directory.path, level: work.level + 1, parentPath: work.path });
                }
            }
        }
        this.expansions.set(key, directoryId);
        return directoryId;
    }

    /**
     * Build the AST hierarchy of one outline result.
     *
     * The AST is the hierarchy authority: every node stores the identity of its
     * item and the identity of its parent item, so a filtered selection can
     * recover ancestors without re-walking the raw tree and the builder can
     * emit `contains` relations from a validated structure.
     *
     * @param result - Outline result from the session.
     * @returns AST root and the per-id parent identity map.
     */
    private outlineHierarchy(result: OutlineResult): OutlineHierarchy {
        const root: AstNode<OutlineEntry> = { kind: "outline", children: [] };
        const parents: Map<string, string | undefined> = new Map<string, string | undefined>();
        const stack: OutlineWork[] = [];
        for (let index: number = result.nodes.length - 1; index >= 0; index -= 1) {
            stack.push({ node: result.nodes[index], target: root });
        }
        while (stack.length > 0) {
            const current: OutlineWork | undefined = stack.pop();
            if (current === (void 0)) {
                continue;
            }
            const anchorNode: boolean = current.node.isFile || current.node.isDirectory;
            const directory: boolean = current.node.isDirectory;
            const itemId: string = anchorNode ? moduleId(current.node.path, directory) : `outline:${current.node.path}@${current.node.range.startLine}`;
            const astNode: AstNode<OutlineEntry> = {
                kind: current.node.type,
                children: [],
                value: {
                    node: current.node,
                    itemId,
                    ...(current.parentItemId === (void 0) ? {} : { parentItemId: current.parentItemId }),
                },
            };
            current.target.children.push(astNode);
            parents.set(itemId, current.parentItemId);
            for (let index: number = current.node.children.length - 1; index >= 0; index -= 1) {
                stack.push({ node: current.node.children[index], target: astNode, parentItemId: itemId });
            }
        }
        return { root, parents };
    }

    /**
     * Resolve the ids an outline filter keeps, including ancestors.
     *
     * Label-prefix and line-window filters both come from the session's
     * `OutlineIndex`, which is the derived Trie/SegmentTree view over the
     * outline. Ancestors are added so a symbol never arrives without the path
     * that explains where it lives, and the anchor is always kept so a filter
     * that matches nothing still names the object it filtered.
     *
     * @param result - Outline result.
     * @param filter - Normalized query and line window.
     * @param parents - Parent identity map from the hierarchy.
     * @returns Selected ids, or `undefined` when no filter is active.
     */
    private outlineSelection(result: OutlineResult, filter: AddOutlineOptions, parents: Map<string, string | undefined>): Set<string> | undefined {
        if (filter.query === (void 0) && filter.startLine === (void 0) && filter.endLine === (void 0)) {
            return (void 0);
        }
        const index: OutlineIndex = buildOutlineIndex(result);
        const matches: OutlineNode[] = [];
        if (filter.query !== (void 0)) {
            matches.push(...index.find(filter.query, OutlineScanNodes));
        }
        if (filter.startLine !== (void 0) || filter.endLine !== (void 0)) {
            const start: number = filter.startLine ?? 1;
            const end: number = filter.endLine ?? Number.MAX_SAFE_INTEGER;
            matches.push(...index.range(start, end, OutlineScanNodes));
        }
        const selected: Set<string> = new Set<string>();
        const root: OutlineNode = result.nodes[0];
        const rootId: string = moduleId(root.path, root.isDirectory);
        selected.add(rootId);
        matches.forEach((node: OutlineNode): void => {
            const anchor: boolean = node.isFile || node.isDirectory;
            let current: string | undefined = anchor ? moduleId(node.path, node.isDirectory) : `outline:${node.path}@${node.range.startLine}`;
            while (current !== (void 0) && !selected.has(current)) {
                selected.add(current);
                current = parents.get(current);
            }
        });
        return selected;
    }

    /**
     * Add one outline: its anchor plus bounded symbol items.
     *
     * `query` and the line window are filters, not omissions: they define the
     * request, so symbols outside them are simply not candidates. A session
     * that clipped the outline sets `truncated` on the package.
     *
     * @param path - Root-relative file or directory path.
     * @param options - Query, line window and scan ceiling.
     * @returns The canonical anchor item id.
     * @throws Error from the session for an unknown or escaped path.
     */
    addOutline(path: string, options?: AddOutlineOptions): string {
        if (typeof(path) !== "string" || path.length === 0) {
            fail("invalid_arguments");
        }
        const settings: AddOutlineOptions = options ?? {};
        if (settings.query !== (void 0) && typeof(settings.query) !== "string") {
            fail("invalid_arguments");
        }
        if (
            (settings.startLine !== (void 0) &&
                (typeof(settings.startLine) !== "number" || !Number.isSafeInteger(settings.startLine) || settings.startLine < 1)) ||
            (settings.endLine !== (void 0) && (typeof(settings.endLine) !== "number" || !Number.isSafeInteger(settings.endLine) || settings.endLine < 1))
        ) {
            fail("invalid_arguments");
        }
        if (settings.startLine !== (void 0) && settings.endLine !== (void 0) && settings.endLine < settings.startLine) {
            fail("invalid_arguments");
        }
        const maxNodes: number = settings.maxNodes === (void 0) ? OutlineScanNodes : ContextBuilder.requirePositive(settings.maxNodes, HardMaxItems);
        const query: string | undefined = settings.query === (void 0) || settings.query.trim().length === 0 ? (void 0) : settings.query.trim();
        const filter: AddOutlineOptions = {
            ...(query === (void 0) ? {} : { query }),
            ...(settings.startLine === (void 0) ? {} : { startLine: settings.startLine }),
            ...(settings.endLine === (void 0) ? {} : { endLine: settings.endLine }),
        };
        const key: string = `outline:${path}:${query ?? ""}:${settings.startLine ?? 0}:${settings.endLine ?? 0}:${maxNodes}`;
        const cached: string | undefined = this.expansions.get(key);
        if (cached !== (void 0)) {
            return cached;
        }
        const result: OutlineResult = this.session.outline({ path, maxNodes });
        if (result.truncated) {
            this.reportTruncated = true;
        }
        if (result.nodes.length === 0) {
            fail("invalid_arguments");
        }
        this.anchorPath(path);
        const hierarchy: OutlineHierarchy = this.outlineHierarchy(result);
        const selected: Set<string> | undefined = this.outlineSelection(result, filter, hierarchy.parents);
        const rootNode: OutlineNode = result.nodes[0];
        const anchorId: string = moduleId(rootNode.path, rootNode.isDirectory);
        const tree: AbstractSyntaxTree<OutlineEntry> = new AbstractSyntaxTree<OutlineEntry>(hierarchy.root);
        const walk: AstNode<OutlineEntry>[] = [...tree.walk("preorder")];
        let emitted: number = 0;
        for (let index: number = 0; index < walk.length; index += 1) {
            const entry: OutlineEntry | undefined = walk[index].value;
            if (entry === (void 0)) {
                continue;
            }
            if (selected !== (void 0) && !selected.has(entry.itemId)) {
                continue;
            }
            const node: OutlineNode = entry.node;
            if (node.isFile || node.isDirectory) {
                const directory: boolean = node.isDirectory;
                const file: FileNode | undefined = node.file;
                const directoryNode: DirectoryNode | undefined = node.directory;
                const summary: string =
                    file !== (void 0) ? fileNodeSummary(file) : directoryNode !== (void 0) ? directoryNodeSummary(directoryNode) : clampSummary(node.label);
                this.addDraft(
                    {
                        id: entry.itemId,
                        kind: directory ? "directory" : "file",
                        path: node.path,
                        summary,
                        provenance: "outline",
                        why: `outline: anchor of ${path} (${result.strategy})`,
                        ...(entry.parentItemId === (void 0) ? {} : { parentId: entry.parentItemId }),
                    },
                    false,
                );
                continue;
            }
            if (emitted >= maxNodes) {
                this.reportTruncated = true;
                this.omit(`outline:${path}`, "budget");
                break;
            }
            emitted += 1;
            const hash: number = node.path.indexOf("#");
            const filePath: string = hash < 0 ? path : node.path.slice(0, hash);
            const detail: string = node.detail === (void 0) ? "" : ` — ${node.detail}`;
            const filterWhy: string =
                query !== (void 0)
                    ? `query ${query.slice(0, 80)}`
                    : settings.startLine !== (void 0)
                      ? `lines ${settings.startLine}-${settings.endLine ?? settings.startLine}`
                      : "symbol tree";
            this.addDraft(
                {
                    id: entry.itemId,
                    kind: "outline",
                    path: filePath,
                    summary: clampSummary(`${node.label}${detail}`),
                    range: toContextRange(node.range.startLine, node.range.endLine),
                    provenance: "outline",
                    why: `outline: ${filterWhy} at depth ${node.depth} in ${path}`,
                    outlineDepth: node.depth,
                    ...(entry.parentItemId === (void 0) ? {} : { parentId: entry.parentItemId }),
                },
                false,
            );
        }
        this.expansions.set(key, anchorId);
        return anchorId;
    }

    /**
     * Record a scope or resolution miss for a discovered endpoint.
     *
     * @param id - Endpoint id that cannot become an item.
     * @param reason - `missing` or `outside_scope`.
     * @param viaId - Item id that requires the endpoint (module or export item).
     */
    private requireEndpoint(id: string, reason: ContextOmissionReason, viaId: string): void {
        this.requirements.set(`${reason}:${id}:${viaId}`, { id, reason, viaId });
    }

    /**
     * Record one path-to-path relation.
     *
     * @param fromPath - Source module path.
     * @param toPath - Target module path.
     * @param kind - Relation kind.
     */
    private linkPaths(fromPath: string, toPath: string, kind: ContextRelationKind): void {
        this.relations.set(`${kind}:${fromPath}->${toPath}`, { from: { path: fromPath }, to: { path: toPath }, kind });
    }

    /**
     * Add one bounded import traversal.
     *
     * The anchor and every resolved neighbour become module items; each edge
     * becomes an `import` relation between the selected endpoint items. An
     * external specifier is an `outside_scope` omission and an unresolved
     * relative specifier a `missing` one, both tied to the item that required
     * them.
     *
     * @param path - Root-relative anchor file.
     * @param options - Direction and hop count.
     * @returns The canonical anchor item id.
     */
    addImports(path: string, options?: AddImportsOptions): string {
        if (typeof(path) !== "string" || path.length === 0) {
            fail("invalid_arguments");
        }
        const settings: AddImportsOptions = options ?? {};
        const direction: ImportDirection = settings.direction ?? "outgoing";
        if (direction !== "outgoing" && direction !== "incoming" && direction !== "both") {
            fail("invalid_arguments");
        }
        const requested: number = settings.depth === (void 0) ? 1 : ContextBuilder.requireDepth(settings.depth);
        const effective: number = Math.min(requested, this.maxDepth);
        const key: string = `imports:${path}:${direction}:${effective}`;
        const cached: string | undefined = this.expansions.get(key);
        if (cached !== (void 0)) {
            return cached;
        }
        const rootId: string = this.ensureModuleItem({
            path,
            kind: "import",
            provenance: "import",
            graphDistance: 0,
            why: `import: root of ${direction} traversal`,
        });
        const queue: ImportWork[] = [{ path, hop: 0 }];
        const visited: Set<string> = new Set<string>([path]);
        for (let index: number = 0; index < queue.length; index += 1) {
            const current: ImportWork = queue[index];
            if (current.hop >= effective) {
                continue;
            }
            const report: ImportReport = this.session.imports({
                path: current.path,
                direction,
                depth: 1,
                includeExternal: true,
                limit: ImportScanLimit,
            });
            if (report.truncated) {
                this.reportTruncated = true;
            }
            const outgoing: readonly ImportEdge[] = direction === "incoming" ? [] : report.imports;
            outgoing.forEach((edge: ImportEdge): void => {
                if (edge.external) {
                    this.requireEndpoint(`external:${edge.specifier}`, "outside_scope", moduleId(current.path, false));
                    return;
                }
                if (!edge.resolved) {
                    this.requireEndpoint(moduleId(edge.to, false), "missing", moduleId(current.path, false));
                    return;
                }
                if (edge.to === current.path) {
                    return;
                }
                this.ensureModuleItem({
                    path: edge.to,
                    kind: "import",
                    provenance: "import",
                    graphDistance: current.hop + 1,
                    why: `import: ${current.path} -> ${edge.to} at line ${edge.line} (${edge.kind})`,
                });
                this.linkPaths(current.path, edge.to, "import");
                if (current.hop + 1 < effective && !visited.has(edge.to)) {
                    visited.add(edge.to);
                    queue.push({ path: edge.to, hop: current.hop + 1 });
                }
            });
            const incoming: readonly ImportEdge[] = direction === "outgoing" ? [] : report.importedBy;
            incoming.forEach((edge: ImportEdge): void => {
                if (edge.external || !edge.resolved || edge.from === current.path) {
                    return;
                }
                this.ensureModuleItem({
                    path: edge.from,
                    kind: "import",
                    provenance: "import",
                    graphDistance: current.hop + 1,
                    why: `import: ${edge.from} -> ${current.path} at line ${edge.line} (${edge.kind})`,
                });
                this.linkPaths(edge.from, current.path, "import");
                if (current.hop + 1 < effective && !visited.has(edge.from)) {
                    visited.add(edge.from);
                    queue.push({ path: edge.from, hop: current.hop + 1 });
                }
            });
        }
        this.expansions.set(key, rootId);
        return rootId;
    }

    /**
     * Add one file's exported symbols and re-exports.
     *
     * Symbols are `export` items under the file's canonical id; a re-export to
     * an external package becomes an `outside_scope` omission owned by the
     * re-export item itself, so the omission survives even when the caller never
     * anchored the file. With `{ anchor: true }` the exporting file is also
     * represented, which closes the `contains` edge without a separate
     * `addFile`.
     *
     * @param path - Root-relative file path.
     * @param options - Optional anchor flag.
     * @returns The canonical file item id.
     */
    addExports(path: string, options?: AddExportsOptions): string {
        if (typeof(path) !== "string" || path.length === 0) {
            fail("invalid_arguments");
        }
        const settings: AddExportsOptions = options ?? {};
        if (settings.anchor !== (void 0) && typeof(settings.anchor) !== "boolean") {
            fail("invalid_arguments");
        }
        const fileId: string = moduleId(path, false);
        const key: string = `exports:${path}:${settings.anchor === true ? "anchor" : "plain"}`;
        const cached: string | undefined = this.expansions.get(key);
        if (cached !== (void 0)) {
            return cached;
        }
        if (settings.anchor === true) {
            this.ensureModuleItem({ path, kind: "file", provenance: "export", graphDistance: 0, why: `export: anchor for ${path}` });
        }
        const report: ExportReport = this.session.exports({ path, includeReexports: true });
        if (report.truncated) {
            this.reportTruncated = true;
        }
        report.exports.forEach((symbol: ExportSymbol): void => {
            const signature: string = symbol.signature.length === 0 ? "" : `: ${symbol.signature}`;
            this.addDraft(
                {
                    id: `export:${path}#${symbol.name}@${symbol.line}`,
                    kind: "export",
                    path,
                    summary: clampSummary(`${symbol.name}${signature} (${symbol.kind})`),
                    range: { startLine: symbol.line, endLine: symbol.line },
                    provenance: "export",
                    why: `export: declared by ${path}`,
                    parentId: fileId,
                },
                false,
            );
        });
        report.reexports.forEach((edge: ImportEdge): void => {
            const target: string = edge.external ? `external:${edge.specifier}` : edge.to;
            const reexportId: string = `export:${path}#reexport@${edge.line}`;
            this.addDraft(
                {
                    id: reexportId,
                    kind: "export",
                    path,
                    summary: clampSummary(`re-export ${edge.specifier} -> ${target} (${edge.kind})`),
                    range: { startLine: edge.line, endLine: edge.line },
                    provenance: "export",
                    why: `export: re-export in ${path}`,
                    parentId: fileId,
                },
                false,
            );
            if (edge.external) {
                this.requireEndpoint(`external:${edge.specifier}`, "outside_scope", reexportId);
            }
        });
        this.expansions.set(key, fileId);
        return fileId;
    }

    /**
     * Add one bounded dependency-graph view.
     *
     * File and directory nodes become module items (promoted in place when a
     * stronger view already exists); internal edges become `dependency`
     * relations; external packages and unknown endpoints become omissions tied
     * to the selected node that referenced them. Cycle and topological position
     * are recorded in the item's `why` and summary, not in extra fields.
     *
     * @param options - Mode, roots and bounded depth.
     * @returns The first node's canonical item id, or `""` for an empty report.
     */
    addDependency(options: AddDependencyOptions): string {
        if (options === null || typeof(options) !== "object" || typeof(options.mode) !== "string") {
            fail("invalid_arguments");
        }
        const modes: readonly DependencyMode[] = ["cycles", "topological", "dependencies", "dependents", "closure"];
        if (!modes.includes(options.mode)) {
            fail("invalid_arguments");
        }
        const roots: readonly string[] = options.roots ?? [];
        if (!Array.isArray(roots) || roots.some((root: string): boolean => typeof(root) !== "string" || root.length === 0)) {
            fail("invalid_arguments");
        }
        const requested: number = options.depth === (void 0) ? Math.min(2, this.maxDepth) : ContextBuilder.requireDepth(options.depth);
        const effective: number = Math.min(requested, this.maxDepth);
        const key: string = `dependency:${options.mode}:${effective}:${[...roots].sort().join("|")}`;
        const cached: string | undefined = this.expansions.get(key);
        if (cached !== (void 0)) {
            return cached;
        }
        const report: DependencyReport = this.session.dependency({
            mode: options.mode,
            ...(roots.length === 0 ? {} : { roots }),
            depth: effective,
            includeExternal: true,
            limit: DependencyScanLimit,
        });
        if (report.truncated) {
            this.reportTruncated = true;
        }
        const distances: Map<string, number> = dependencyDistances(report, effective);
        const nodeById: Map<string, DependencyNode> = new Map<string, DependencyNode>();
        report.nodes.forEach((node: DependencyNode): void => {
            nodeById.set(node.id, node);
        });
        report.nodes.forEach((node: DependencyNode): void => {
            if (isExternalDependency(node)) {
                return;
            }
            const distance: number = distances.get(node.id) ?? effective + 1;
            const cycleIndex: number = report.cycles.findIndex((cycle: readonly string[]): boolean => cycle.includes(node.id));
            const orderIndex: number = report.order.indexOf(node.id);
            const role: string = `${node.path} (${node.kind})${cycleIndex < 0 ? "" : ` [cycle ${cycleIndex + 1}]`}${orderIndex < 0 ? "" : ` [order ${orderIndex + 1}]`}`;
            const why: string[] = [`dependency: ${options.mode} node at depth ${distance}`];
            if (report.roots.includes(node.id)) {
                why.push("root");
            }
            if (cycleIndex >= 0) {
                why.push(`cycle ${cycleIndex + 1}`);
            }
            if (orderIndex >= 0) {
                why.push(`order ${orderIndex + 1}`);
            }
            const directory: boolean = node.kind === "directory";
            const id: string = moduleId(node.path, directory);
            const existing: ContextItemDraft | undefined = this.drafts.get(id);
            if (existing !== (void 0)) {
                this.mergeWhy(existing, why.join("; "));
                if (existing.graphDistance === (void 0) || distance < existing.graphDistance) {
                    existing.graphDistance = distance;
                }
                return;
            }
            this.addDraft(
                {
                    id,
                    kind: directory ? "directory" : "dependency",
                    path: node.path,
                    summary: clampSummary(role),
                    provenance: "dependency",
                    why: why.join("; "),
                    graphDistance: distance,
                },
                false,
            );
        });
        report.edges.forEach((edge: DependencyEdge): void => {
            const fromNode: DependencyNode | undefined = nodeById.get(edge.from);
            const toNode: DependencyNode | undefined = nodeById.get(edge.to);
            if (fromNode === (void 0) && toNode === (void 0)) {
                return;
            }
            if (fromNode === (void 0)) {
                this.requireEndpoint(edge.from, "missing", moduleId((toNode as DependencyNode).path, (toNode as DependencyNode).kind === "directory"));
                return;
            }
            if (toNode === (void 0)) {
                this.requireEndpoint(edge.to, "missing", moduleId(fromNode.path, fromNode.kind === "directory"));
                return;
            }
            if (isExternalDependency(toNode)) {
                this.requireEndpoint(edge.to, "outside_scope", moduleId(fromNode.path, fromNode.kind === "directory"));
                return;
            }
            if (isExternalDependency(fromNode)) {
                this.requireEndpoint(edge.from, "outside_scope", moduleId(toNode.path, toNode.kind === "directory"));
                return;
            }
            this.linkPaths(fromNode.path, toNode.path, "dependency");
        });
        const first: DependencyNode | undefined = report.nodes[0];
        const firstId: string = first === (void 0) ? "" : moduleId(first.path, first.kind === "directory");
        this.expansions.set(key, firstId);
        return firstId;
    }

    /**
     * Add one host note.
     *
     * A note is an anchor with no workspace path: it is trusted host input, its
     * text is collapsed to one bounded line, and its id is namespaced so it can
     * never collide with a file item.
     *
     * @param id - Host-assigned note id (non-empty, at most 200 characters).
     * @param text - Note body; whitespace is collapsed and the result bounded.
     * @returns The note item id.
     */
    addNote(id: string, text: string): string {
        if (typeof(id) !== "string" || id.length === 0 || id.length > 200 || typeof(text) !== "string" || text.trim().length === 0) {
            fail("invalid_arguments");
        }
        const summary: string = clampSummary(text);
        if (summary.length === 0) {
            fail("invalid_arguments");
        }
        const itemId: string = `note:${id}`;
        this.addDraft({ id: itemId, kind: "note", path: "", summary, provenance: "anchor", why: "note: host-provided" }, true);
        return itemId;
    }

    /**
     * Resolve one pending relation endpoint against the selection.
     *
     * @param endpoint - Item id or module path.
     * @param selectedIds - Selected item ids.
     * @returns The endpoint item id, or `undefined` when it is not selected.
     */
    private resolveEndpoint(endpoint: ContextEndpoint, selectedIds: Set<string>): string | undefined {
        if ("itemId" in endpoint) {
            return selectedIds.has(endpoint.itemId) ? endpoint.itemId : (void 0);
        }
        const winner: string | undefined = this.moduleDrafts.get(endpoint.path);
        return winner === (void 0) || !selectedIds.has(winner) ? (void 0) : winner;
    }

    /**
     * Emit `contains` edges for the selected hierarchy.
     *
     * The selected items are re-added to a `ContextAst`, with a parent link only
     * when that parent is also selected, and the AST's child index supplies the
     * edges. A budget-dropped parent therefore cannot leave a dangling child
     * edge, and the AST rejects an impossible hierarchy before output.
     *
     * @param selected - Selected drafts in selection order.
     * @param selectedIds - Selected item ids.
     * @returns `contains` relations in deterministic order.
     */
    private containsRelations(selected: readonly ScoredDraft[], selectedIds: Set<string>): ContextRelation[] {
        const hierarchy: ContextAst = new ContextAst();
        selected.forEach((entry: ScoredDraft, index: number): void => {
            const parentId: string | undefined = entry.draft.parentId;
            const node: ContextAstNode = {
                id: entry.draft.id,
                kind: contextNodeKind(entry.draft.kind),
                summary: entry.draft.summary,
                order: index,
                ...(parentId === (void 0) || !selectedIds.has(parentId) ? {} : { parentId }),
            };
            hierarchy.add(node);
        });
        const parentIds: string[] = [
            ...new Set<string>(
                selected
                    .map((entry: ScoredDraft): string | undefined => entry.draft.parentId)
                    .filter((id: string | undefined): id is string => id !== (void 0) && selectedIds.has(id)),
            ),
        ].sort();
        const relations: ContextRelation[] = [];
        parentIds.forEach((parentId: string): void => {
            hierarchy.children(parentId).forEach((child: ContextAstNode): void => {
                relations.push({ from: parentId, to: child.id, kind: "contains" });
            });
        });
        return relations;
    }

    /**
     * Build the immutable package for the requests added so far.
     *
     * The method is repeatable: it reads the session revision, scores the
     * drafts, admits items under budget and item ceilings, resolves relations
     * against the selection, charges relation lines, and freezes the result. It
     * never mutates accumulated drafts, so a second call on an unchanged
     * session returns an identical package.
     *
     * @returns The frozen package.
     * @throws ContextBuilderError when the session returns no usable revision.
     */
    build(): ContextPackage {
        const revision: string = this.session.revision();
        if (typeof(revision) !== "string" || revision.length === 0) {
            fail("session_unavailable");
        }
        const scored: ScoredDraft[] = [...this.drafts.values()].map((draft: ContextItemDraft): ScoredDraft => ({
            draft,
            score: scoreDraft(draft, this.weights, this.prefixes),
        }));
        const measure: TokenEstimator = (text: string): number => this.measureTokens(text);
        const queue: PriorityQueue<ScoredDraft> = new PriorityQueue<ScoredDraft>({ values: scored, compare: compareScoredDrafts });
        const selected: ScoredDraft[] = [];
        const selectedIds: Set<string> = new Set<string>();
        const budgetOmissions: ContextOmission[] = [];
        let used: number = 0;
        while (!queue.isEmpty) {
            const next: ScoredDraft | undefined = queue.dequeue();
            if (next === (void 0)) {
                break;
            }
            const cost: number = draftTokens(next.draft, measure);
            if (selected.length >= this.maxItems || used + cost > this.budgetTokens) {
                budgetOmissions.push({ id: next.draft.id, reason: "budget" });
                continue;
            }
            selected.push(next);
            selectedIds.add(next.draft.id);
            used += cost;
        }
        const items: ContextItem[] = selected.map((entry: ScoredDraft): ContextItem => {
            const draft: ContextItemDraft = entry.draft;
            return {
                id: draft.id,
                kind: draft.kind,
                path: draft.path,
                summary: draft.summary,
                ...(draft.detailRef === (void 0) ? {} : { detailRef: draft.detailRef }),
                ...(draft.range === (void 0) ? {} : { range: { startLine: draft.range.startLine, endLine: draft.range.endLine } }),
                tokens: draftTokens(draft, measure),
                score: entry.score,
                provenance: draft.provenance,
                why: draft.why,
            };
        });
        const relations: ContextRelation[] = this.includeRelations ? this.containsRelations(selected, selectedIds) : [];
        if (this.includeRelations) {
            this.relations.forEach((pending: PendingRelation): void => {
                const from: string | undefined = this.resolveEndpoint(pending.from, selectedIds);
                const to: string | undefined = this.resolveEndpoint(pending.to, selectedIds);
                if (from === (void 0) || to === (void 0) || from === to) {
                    return;
                }
                relations.push({ from, to, kind: pending.kind });
            });
        }
        const seen: Set<string> = new Set<string>();
        const ordered: ContextRelation[] = relations
            .filter((relation: ContextRelation): boolean => {
                const key: string = `${relation.kind}\u0000${relation.from}\u0000${relation.to}`;
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            })
            .sort(compareRelations);
        const emitted: ContextRelation[] = [];
        const relationOmissions: ContextOmission[] = [];
        ordered.forEach((relation: ContextRelation): void => {
            const cost: number = this.measureTokens(renderContextRelation(relation));
            if (used + cost > this.budgetTokens) {
                relationOmissions.push({
                    id: `relation:${relation.kind}:${relation.from}->${relation.to}`,
                    reason: "budget",
                    requiredIds: [relation.from, relation.to],
                });
                return;
            }
            emitted.push(relation);
            used += cost;
        });
        const requirementOmissions: ContextOmission[] = [];
        this.requirements.forEach((requirement: EndpointRequirement): void => {
            if (!selectedIds.has(requirement.viaId)) {
                return;
            }
            requirementOmissions.push({ id: requirement.id, reason: requirement.reason, requiredIds: [requirement.viaId] });
        });
        const omitted: ContextOmission[] = mergeOmissions([...this.omissions.values(), ...budgetOmissions, ...requirementOmissions, ...relationOmissions]);
        const truncated: boolean =
            this.reportTruncated ||
            omitted.some(
                (omission: ContextOmission): boolean => omission.reason === "budget" || omission.reason === "missing" || omission.reason === "outside_scope",
            );
        return freezeContextPackage({
            sessionId: this.sessionId,
            revision,
            budgetTokens: this.budgetTokens,
            usedTokens: used,
            items,
            omitted,
            relations: emitted,
            text: renderContextPackageText(items, emitted),
            truncated,
        });
    }
}

export { DefaultContextWeights } from "./relevance.ts";
