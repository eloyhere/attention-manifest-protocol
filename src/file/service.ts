/**
 * Agent-facing filesystem service.
 *
 * One handle is bound to exactly one session. The service authenticates the
 * bearer token on every call, resolves paths through that session's sandbox and
 * keeps all trees, annotations, graph caches and write journals per session.
 * The token is never part of a tool schema, so a model cannot forward or widen
 * it; the host that opens the session is the only party that ever sees it.
 *
 * Read methods are synchronous because the underlying filesystem APIs are; only
 * `write` and the tool dispatcher are async. The JSON-RPC adapter awaits the
 * same `call` entry point, so a future async parser does not need a second wire
 * contract.
 */
import { Buffer } from "node:buffer";

import { parseToolCall } from "../boundary/toolCall.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";
import { isSessionError } from "../session/errors.ts";
import { SessionRegistry } from "../session/registry.ts";
import type { SessionDescriptor } from "../session/types.ts";
import { filesystemToolDefinitions, filesystemToolLeaves, FilesystemProtocol, FilesystemProtocolVersion } from "../protocol/filesystem.ts";
import type { FilesystemResponse, FilesystemToolDefinition } from "../protocol/filesystem.ts";
import { buildOutline } from "../outline/outline.ts";
import { filterOutline, wireOutline } from "../outline/outlineIndex.ts";
import { listDirectory } from "./directory.ts";
import { wireNode, wireTree } from "./file.ts";
import { extractImports } from "./importGraph.ts";
import { extractExports } from "./exportGraph.ts";
import { isOfficeFile, officeExports, officeReferences, parseOffice } from "../outline/office.ts";
import { buildSyntaxTree } from "./syntaxTree.ts";
import { wireSyntaxTree } from "../syntax/syntaxTree.ts";
import type { SyntaxTree } from "../syntax/syntaxTree.ts";
import { buildDependencyReport, graphFromImports } from "./dependency.ts";
import type { DependencyGraph } from "./dependency.ts";
import { isFilesystemError } from "./errors.ts";
import { readPage } from "./read.ts";
import { writeFile } from "./write.ts";
import { SessionRuntime } from "./runtime.ts";
import type { AnnotationMap } from "./runtime.ts";
import type { DependencyReport, ExportReport, ExportSymbol, ImportEdge, ImportReport, ReadPage, TreeNode, WriteResult } from "./types.ts";
import type { OutlineResult } from "../outline/types.ts";

/**
 * Service-wide ceilings. A session's own permissions can only lower them.
 */
export interface FilesystemServiceLimits {
    readonly maxTreeNodes: number;
    readonly maxReadBytes: number;
    readonly maxWriteBytes: number;
    readonly maxResponseChars: number;
    readonly maxToolCalls: number;
    readonly maxGraphFiles: number;
    readonly maxGraphBytes: number;
}

const Defaults: FilesystemServiceLimits = {
    maxTreeNodes: 20_000,
    maxReadBytes: 8 * 1024 * 1024,
    maxWriteBytes: 4 * 1024 * 1024,
    maxResponseChars: 262_144,
    maxToolCalls: 5000,
    maxGraphFiles: 2000,
    maxGraphBytes: 32 * 1024 * 1024,
};

/**
 * Options for the service. `registry` is the only authority source; there is no
 * path or root input on any tool.
 */
export interface FilesystemServiceOptions {
    readonly registry: SessionRegistry;
    readonly store?: import("./types.ts").FilesystemStore;
    readonly annotations?: AnnotationMap;
    readonly limits?: Partial<FilesystemServiceLimits>;
    readonly timeZone?: "local" | "utc";
    readonly followSymlinks?: boolean;
    readonly includeHidden?: boolean;
}

/**
 * Graph cache entry for one root. It is invalidated by the tree revision, not
 * by time, so a write followed by a query cannot observe stale edges.
 */
interface GraphCache {
    readonly revision: string;
    readonly graph: DependencyGraph;
    readonly reports: ReadonlyMap<string, ImportReport>;
}

/**
 * Outline query input accepted by the typed convenience method.
 */
export interface OutlineRequest {
    readonly path: string;
    readonly maxNodes?: number;
    readonly maxDepth?: number;
    readonly symbols?: boolean;
    readonly query?: string;
    readonly startLine?: number;
    readonly endLine?: number;
}

/**
 * Import query input accepted by the typed convenience method.
 */
export interface ImportRequest {
    readonly path: string;
    readonly direction?: "outgoing" | "incoming" | "both";
    readonly depth?: number;
    readonly includeExternal?: boolean;
    readonly limit?: number;
}

/**
 * Export query input.
 */
export interface ExportRequest {
    readonly path: string;
    readonly includeReexports?: boolean;
}

/**
 * Syntax tree query. Bounds are passed through to `buildSyntaxTree`.
 */
export interface AstRequest {
    readonly path: string;
    readonly maxBytes?: number;
    readonly maxTokens?: number;
    readonly maxNodes?: number;
}

/**
 * Dependency query input. Roots are root-relative paths, converted to graph ids
 * inside the service.
 */
export interface DependencyQuery {
    readonly mode: import("./types.ts").DependencyMode;
    readonly roots?: readonly string[];
    readonly direction?: "dependencies" | "dependents";
    readonly depth?: number;
    readonly limit?: number;
    readonly includeExternal?: boolean;
}

const base64Pattern: RegExp = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const decodeBase64: (text: string) => Uint8Array = (text: string): Uint8Array => {
    if (!base64Pattern.test(text) || text.length % 4 !== 0) {
        throw new FilesystemArgumentError();
    }
    return new Uint8Array(Buffer.from(text, "base64"));
};

/**
 * Internal marker for a shape error that the schema could not express; mapped
 * to `invalid_arguments` at the boundary.
 */
class FilesystemArgumentError extends Error {}

export class FilesystemService {
    private readonly registry: SessionRegistry;
    private readonly store?: import("./types.ts").FilesystemStore;
    private readonly annotations?: AnnotationMap;
    private readonly limits: FilesystemServiceLimits;
    private readonly timeZone: "local" | "utc";
    private readonly followSymlinks: boolean;
    private readonly includeHidden: boolean;
    private readonly runtimes: Map<string, SessionRuntime> = new Map<string, SessionRuntime>();
    private readonly graphs: Map<string, GraphCache> = new Map<string, GraphCache>();
    private calls: number = 0;

    constructor(options: FilesystemServiceOptions) {
        if (options === null || typeof(options) !== "object" || options.registry === (void 0)) {
            throw new Error("filesystem service requires a session registry");
        }
        this.registry = options.registry;
        this.store = options.store;
        this.annotations = options.annotations;
        this.limits = { ...Defaults, ...options.limits };
        for (const key of Object.keys(options.limits ?? {})) {
            const value: number = this.limits[key as keyof FilesystemServiceLimits];
            if (!Number.isSafeInteger(value) || value < 1) {
                throw new Error(`invalid filesystem service limit ${key}`);
            }
        }
        this.timeZone = options.timeZone === "utc" ? "utc" : "local";
        this.followSymlinks = options.followSymlinks === true;
        this.includeHidden = options.includeHidden === true;
    }

    /**
     * Authenticate one session and return its handle. A new handle for the same
     * session shares the runtime so two UI components do not build two trees.
     */
    bind(sessionId: string, token: string): FilesystemSession {
        const authentication = this.registry.authenticate(sessionId, token);
        let runtime: SessionRuntime | undefined = this.runtimes.get(sessionId);
        if (runtime === (void 0)) {
            runtime = new SessionRuntime(authentication.descriptor, {
                ...(this.store === (void 0) ? {} : { store: this.store }),
                ...(this.annotations === (void 0) ? {} : { annotations: this.annotations }),
                timeZone: this.timeZone,
                followSymlinks: this.followSymlinks,
                includeHidden: this.includeHidden,
            });
            this.runtimes.set(sessionId, runtime);
        }
        return new FilesystemSession(this, runtime, token);
    }

    /**
     * Drop one session's caches. Hosts call this after revoke/expiry; a later
     * `bind` recreates the runtime, but the tree is rebuilt from disk rather
     * than inherited from the previous identity.
     */
    /**
     * Public descriptor view for the `session` tool. Keeps the registry field
     * private instead of reaching through an index signature from the handle.
     */
    summary(sessionId: string): import("../session/types.ts").SessionSummary {
        return this.registry.summary(sessionId);
    }

    dispose(sessionId: string): void {
        const runtime: SessionRuntime | undefined = this.runtimes.get(sessionId);
        if (runtime !== (void 0)) {
            runtime.dispose();
            this.runtimes.delete(sessionId);
        }
        this.graphs.clear();
    }

    /**
     * JSON-RPC / registry entry. Returns a complete envelope; it never throws.
     */
    async call(session: FilesystemSession, name: string, raw: unknown): Promise<FilesystemResponse> {
        try {
            return await session.dispatch(name, raw);
        } catch (error: unknown) {
            return session.errorResponse(this.mapError(error));
        }
    }

    /**
     * Count one business call and enforce the service-wide ceiling.
     */
    admit(): void {
        if (this.calls >= this.limits.maxToolCalls) {
            throw new FilesystemArgumentError();
        }
        this.calls += 1;
    }

    limitsFor(): FilesystemServiceLimits {
        return { ...this.limits };
    }

    /**
     * Import facts for one file. Office containers are not source text, so they
     * go through `office.ts` and expose hyperlinks, external workbook links and
     * embedded objects as external edges instead of failing as binary.
     */
    private importReport(runtime: SessionRuntime, path: string): ImportReport {
        if (!isOfficeFile(path)) {
            return extractImports(runtime.sandbox, path);
        }
        const document = parseOffice(runtime.sandbox, path);
        const imports: ImportEdge[] = [];
        const external: string[] = [];
        const seen: Set<string> = new Set<string>();
        const targets: string[] = [...document.imports];
        for (const reference of officeReferences(document)) {
            if (reference.kind === "hyperlink" || reference.kind === "external-link" || reference.kind === "embedded" || reference.kind === "formula") {
                targets.push(reference.target);
            }
        }
        for (const specifier of targets) {
            if (specifier.length === 0 || seen.has(specifier)) {
                continue;
            }
            seen.add(specifier);
            imports.push({
                from: path,
                to: specifier,
                specifier,
                kind: "static",
                line: 1,
                resolved: false,
                external: true,
            });
            external.push(specifier);
        }
        return {
            path,
            fingerprint: document.fingerprint,
            imports,
            importedBy: [],
            external,
            unresolved: [],
            truncated: false,
        };
    }

    /**
     * Export facts for one file. Office exports are named ranges, bookmarks and
     * tables; their kind is intentionally generic because the container does not
     * distinguish a symbol the way a source file does.
     */
    private exportReport(runtime: SessionRuntime, path: string): ExportReport {
        if (!isOfficeFile(path)) {
            return extractExports(runtime.sandbox, path);
        }
        const document = parseOffice(runtime.sandbox, path);
        const exports: ExportSymbol[] = officeExports(document).map((name: string): ExportSymbol => ({
            name,
            kind: "const",
            line: 1,
            signature: "office export",
        }));
        return {
            path,
            fingerprint: document.fingerprint,
            exports,
            reexports: [],
            truncated: false,
        };
    }

    /**
     * Build or reuse the dependency graph for one root. The tree revision is the
     * cache key; a write refreshes the tree and therefore invalidates the graph.
     */
    graphFor(runtime: SessionRuntime, rootId: string): GraphCache {
        const tree = runtime.treeFor(runtime.descriptor.roots.find((root) => root.id === rootId)!);
        const revision: string = tree.revision();
        const cached: GraphCache | undefined = this.graphs.get(rootId);
        if (cached !== (void 0) && cached.revision === revision) {
            return cached;
        }
        const reports: ImportReport[] = [];
        let bytes: number = 0;
        const files: TreeNode[] = [];
        for (const child of tree.snapshot().root.children) {
            files.push(child);
        }
        const stack: TreeNode[] = [...files].reverse();
        while (stack.length > 0 && reports.length < this.limits.maxGraphFiles) {
            const node: TreeNode = stack.pop()!;
            if (node.type === "Directory") {
                for (let index: number = node.children.length - 1; index >= 0; index -= 1) {
                    stack.push(node.children[index]);
                }
                continue;
            }
            if (bytes + Number(node.bytes) > this.limits.maxGraphBytes) {
                break;
            }
            bytes += Number(node.bytes);
            try {
                reports.push(this.importReport(runtime, node.path));
            } catch {
                continue;
            }
        }
        const graph: DependencyGraph = graphFromImports(revision, reports, true);
        const byPath: Map<string, ImportReport> = new Map<string, ImportReport>(reports.map((report): [string, ImportReport] => [report.path, report]));
        const entry: GraphCache = { revision, graph, reports: byPath };
        this.graphs.set(rootId, entry);
        return entry;
    }

    /**
     * Typed helpers used by the hook layer and direct embedders. They throw the
     * classified error instead of returning an envelope; the tool surface wraps
     * them below.
     */
    read(runtime: SessionRuntime, request: import("./types.ts").ReadRequest): ReadPage {
        return readPage(runtime.sandbox, request, { maxBytes: Math.min(runtime.descriptor.permissions.maxReadBytes, this.limits.maxReadBytes) });
    }

    async write(runtime: SessionRuntime, request: import("./types.ts").WriteRequest): Promise<WriteResult> {
        const { rooted, tree } = runtime.resolve(request.path, request.mode === "create" ? "create" : "write");
        const settings = {
            maxBytes: Math.min(runtime.descriptor.permissions.maxWriteBytes, this.limits.maxWriteBytes),
            journal: (entry: import("./types.ts").WriteJournalEntry): void => runtime.journal(entry),
            tree,
            timeZone: this.timeZone,
        };
        const result: WriteResult = await writeFile(runtime.sandbox, runtime.descriptor.id, request, settings);
        runtime.persist(rooted.root, tree.snapshot());
        return result;
    }

    outline(runtime: SessionRuntime, request: OutlineRequest): OutlineResult {
        const { rooted, node, tree } = runtime.node(request.path, "read");
        const cached: OutlineResult | undefined =
            this.store === (void 0) ? (void 0) : this.store.loadOutline(rooted.root.id, rooted.relative, node.fingerprint);
        const result: OutlineResult =
            cached ??
            buildOutline(
                runtime.sandbox,
                rooted.relative,
                {
                    maxNodes: request.maxNodes,
                    maxDepth: request.maxDepth,
                    symbols: request.symbols,
                    ...(node.type === "File" ? { anchor: { file: node } } : { anchor: { directory: node } }),
                },
                node.type === "File" ? { file: node } : { directory: node },
            );
        if (cached === (void 0) && this.store !== (void 0)) {
            this.store.saveOutline(rooted.root.id, result);
        }
        const filtered: OutlineResult =
            request.query === (void 0) && request.startLine === (void 0) && request.endLine === (void 0)
                ? result
                : filterOutline(result, {
                      ...(request.query === (void 0) ? {} : { prefix: request.query }),
                      ...(request.startLine === (void 0) ? {} : { startLine: request.startLine }),
                      ...(request.endLine === (void 0) ? {} : { endLine: request.endLine }),
                      limit: 200,
                  });
        void tree;
        return filtered;
    }

    imports(runtime: SessionRuntime, request: ImportRequest): ImportReport {
        const { rooted, node } = runtime.node(request.path, "read");
        if (node.type !== "File") {
            throw new FilesystemArgumentError();
        }
        const report: ImportReport = this.importReport(runtime, rooted.relative);
        const direction: "outgoing" | "incoming" | "both" = request.direction ?? "outgoing";
        if (direction === "outgoing") {
            return { ...report, importedBy: [] };
        }
        const graph: GraphCache = this.graphFor(runtime, rooted.root.id);
        const incoming: import("./types.ts").ImportEdge[] = [];
        const seen: Set<string> = new Set<string>();
        for (const source of graph.reports.values()) {
            for (const edge of source.imports) {
                if (edge.to !== rooted.relative || edge.external || !edge.resolved) {
                    continue;
                }
                const key: string = `${edge.from}|${edge.to}|${edge.line}|${edge.specifier}|${edge.kind}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                incoming.push(edge);
            }
        }
        return { ...report, importedBy: incoming.slice(0, Math.max(1, request.limit ?? 200)) };
    }

    exports(runtime: SessionRuntime, request: ExportRequest): ExportReport {
        const { rooted, node } = runtime.node(request.path, "read");
        if (node.type !== "File") {
            throw new FilesystemArgumentError();
        }
        const report: ExportReport = this.exportReport(runtime, rooted.relative);
        return request.includeReexports === true ? report : { ...report, reexports: [] };
    }

    /**
     * Lossless syntax tree. Read-only: the parser never imports or evaluates the
     * target file.
     */
    ast(runtime: SessionRuntime, request: AstRequest): SyntaxTree {
        return buildSyntaxTree(runtime.sandbox, request.path, {
            ...(request.maxBytes === (void 0) ? {} : { maxBytes: request.maxBytes }),
            ...(request.maxTokens === (void 0) ? {} : { maxTokens: request.maxTokens }),
            ...(request.maxNodes === (void 0) ? {} : { maxNodes: request.maxNodes }),
        });
    }

    dependency(runtime: SessionRuntime, request: DependencyQuery): DependencyReport {
        const root = runtime.descriptor.roots[0];
        const graph: GraphCache = this.graphFor(runtime, root.id);
        const roots: readonly string[] = (request.roots ?? []).map((entry: string): string => runtime.sandbox.resolve(entry, "read").relative);
        return buildDependencyReport(graph.graph, graph.revision, {
            mode: request.mode,
            ...(roots.length === 0 ? {} : { roots }),
            ...(request.direction === (void 0) ? {} : { direction: request.direction }),
            ...(request.depth === (void 0) ? {} : { depth: request.depth }),
            ...(request.limit === (void 0) ? {} : { limit: request.limit }),
            ...(request.includeExternal === (void 0) ? {} : { includeExternal: request.includeExternal }),
        });
    }

    mapError(error: unknown): import("../protocol/filesystem.ts").FilesystemToolErrorCode {
        if (isFilesystemError(error)) {
            return error.code;
        }
        if (isSessionError(error)) {
            if (error.code === "invalid_identity" || error.code === "session_forbidden") {
                return "permission_denied";
            }
            if (error.code === "invalid_arguments") {
                return "invalid_arguments";
            }
            return "session_unavailable";
        }
        if (error instanceof BoundaryRejection || error instanceof FilesystemArgumentError) {
            return "invalid_arguments";
        }
        return "internal_error";
    }
}

/**
 * Bound session handle. It is the only object a transport needs; the token stays
 * private and is re-checked on every call.
 */
export class FilesystemSession {
    readonly sessionId: string;
    private readonly service: FilesystemService;
    private readonly token: string;
    private readonly runtime: SessionRuntime;
    private calls: number = 0;

    constructor(service: FilesystemService, runtime: SessionRuntime, token: string) {
        this.service = service;
        this.runtime = runtime;
        this.sessionId = runtime.descriptor.id;
        this.token = token;
    }

    get descriptor(): SessionDescriptor {
        return this.runtime.descriptor;
    }

    tools(): FilesystemToolDefinition[] {
        return filesystemToolDefinitions();
    }

    /**
     * Typed read for direct embedders and the hook layer. It throws the
     * classified error instead of returning the JSON envelope.
     */
    read(request: import("./types.ts").ReadRequest): ReadPage {
        this.refresh();
        return this.service.read(this.runtime, request);
    }

    /**
     * Typed write. The only mutating operation in the whole filesystem surface.
     */
    async write(request: import("./types.ts").WriteRequest): Promise<WriteResult> {
        this.refresh();
        return this.service.write(this.runtime, request);
    }

    /**
     * Typed outline query.
     */
    outline(request: OutlineRequest): OutlineResult {
        this.refresh();
        return this.service.outline(this.runtime, request);
    }

    /**
     * Typed import report.
     */
    imports(request: ImportRequest): ImportReport {
        this.refresh();
        return this.service.imports(this.runtime, request);
    }

    /**
     * Typed export report.
     */
    exports(request: ExportRequest): ExportReport {
        this.refresh();
        return this.service.exports(this.runtime, request);
    }

    /**
     * Typed dependency query.
     */
    dependency(request: DependencyQuery): DependencyReport {
        this.refresh();
        return this.service.dependency(this.runtime, request);
    }

    /**
     * Typed syntax-tree query. Read-only; the parser never executes the file.
     */
    ast(request: AstRequest): SyntaxTree {
        this.refresh();
        return this.service.ast(this.runtime, request);
    }

    /**
     * Current root revision for cache keys and audit rows.
     */
    revision(): string {
        this.refresh();
        return this.revisionOf();
    }

    /**
     * Re-authenticate before each call. A host that revokes or expires a session
     * therefore does not need to reach into every live handle.
     */
    private refresh(): void {
        this.service.bind(this.sessionId, this.token);
    }

    async dispatch(name: string, raw: unknown): Promise<FilesystemResponse> {
        this.service.admit();
        if (this.calls >= this.service.limitsFor().maxToolCalls) {
            return this.errorResponse("quota_exceeded");
        }
        this.calls += 1;
        const leaf: string | undefined = filesystemToolLeaves.get(name);
        const tool: FilesystemToolDefinition | undefined = this.tools().find((entry: FilesystemToolDefinition): boolean => entry.name === name);
        if (leaf === (void 0) || tool === (void 0)) {
            return this.errorResponse("unknown_tool");
        }
        let args: Record<string, unknown>;
        try {
            args = parseToolCall(tool, raw).args;
        } catch (error: unknown) {
            if (error instanceof BoundaryRejection) {
                return this.errorResponse("invalid_arguments");
            }
            throw error;
        }
        try {
            this.refresh();
        } catch (error: unknown) {
            return this.errorResponse(this.service.mapError(error));
        }
        const data: Record<string, unknown> = await this.dataFor(leaf, args);
        const response: FilesystemResponse = {
            protocol: FilesystemProtocol,
            version: FilesystemProtocolVersion,
            ok: true,
            revision: this.revisionOf(),
            session: this.sessionId,
            data,
        };
        if (JSON.stringify(response).length > this.service.limitsFor().maxResponseChars) {
            return this.errorResponse("response_too_large");
        }
        return response;
    }

    private async dataFor(leaf: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
        switch (leaf) {
            case "session": {
                const summary = this.service.summary(this.sessionId);
                return {
                    agentId: summary.agentId,
                    label: summary.label,
                    roots: summary.roots,
                    permissions: this.runtime.descriptor.permissions,
                    createdAt: summary.createdAt,
                    expiresAt: summary.expiresAt,
                    remainingMs: summary.remainingMs,
                    revision: summary.revision,
                    limits: this.service.limitsFor(),
                };
            }
            case "file": {
                const { node, revision } = this.runtime.node(args.path, "read");
                const depth: number = typeof(args.depth) === "number" ? args.depth : 1;
                const offset: number = typeof(args.offset) === "number" ? args.offset : 0;
                const limit: number = typeof(args.limit) === "number" ? args.limit : 50;
                return { node: wireTree(node, depth, offset, limit), revision };
            }
            case "directory": {
                const { rooted, tree } = this.runtime.resolve(args.path, "read");
                const listing = listDirectory(
                    tree,
                    rooted.relative,
                    typeof(args.offset) === "number" ? args.offset : 0,
                    typeof(args.limit) === "number" ? args.limit : 50,
                );
                return { ...listing };
            }
            case "read": {
                const page: ReadPage = this.service.read(this.runtime, {
                    path: args.path as string,
                    ...(args.startLine === (void 0) ? {} : { startLine: args.startLine as number }),
                    ...(args.maxLines === (void 0) ? {} : { maxLines: args.maxLines as number }),
                    ...(args.maxBytes === (void 0) ? {} : { maxBytes: args.maxBytes as number }),
                    ...(args.includeLineNumbers === (void 0) ? {} : { includeLineNumbers: args.includeLineNumbers as boolean }),
                });
                return { ...page, totalLines: page.totalLines.toString(), totalBytes: page.totalBytes.toString() };
            }
            case "write": {
                const hasText: boolean = typeof(args.content) === "string";
                const hasBase64: boolean = typeof(args.contentBase64) === "string";
                if (hasText === hasBase64) {
                    return this.invalid();
                }
                const content: string | Uint8Array = hasText ? (args.content as string) : decodeBase64(args.contentBase64 as string);
                const request: import("./types.ts").WriteRequest = {
                    path: args.path as string,
                    content,
                    ...(args.encoding === (void 0) ? {} : { encoding: args.encoding as import("./types.ts").WriteRequest["encoding"] }),
                    ...(args.mode === (void 0) ? {} : { mode: args.mode as import("./types.ts").WriteRequest["mode"] }),
                    ...(args.expectFingerprint === (void 0) ? {} : { expectFingerprint: args.expectFingerprint as string | null }),
                    ...(args.createParents === (void 0) ? {} : { createParents: args.createParents as boolean }),
                    ...(args.dryRun === (void 0) ? {} : { dryRun: args.dryRun as boolean }),
                };
                const result: WriteResult = await this.service.write(this.runtime, request);
                return {
                    node: wireNode(result.node),
                    previousFingerprint: result.previousFingerprint,
                    created: result.created,
                    dryRun: result.dryRun,
                    bytesWritten: result.bytesWritten.toString(),
                    revision: result.revision,
                };
            }
            case "outline": {
                const result: OutlineResult = this.service.outline(this.runtime, {
                    path: args.path as string,
                    ...(args.maxNodes === (void 0) ? {} : { maxNodes: args.maxNodes as number }),
                    ...(args.maxDepth === (void 0) ? {} : { maxDepth: args.maxDepth as number }),
                    ...(args.query === (void 0) ? {} : { query: args.query as string }),
                    ...(args.startLine === (void 0) ? {} : { startLine: args.startLine as number }),
                    ...(args.endLine === (void 0) ? {} : { endLine: args.endLine as number }),
                });
                return { ...wireOutline(result) };
            }
            case "import": {
                const report: ImportReport = this.service.imports(this.runtime, {
                    path: args.path as string,
                    ...(args.direction === (void 0) ? {} : { direction: args.direction as "outgoing" | "incoming" | "both" }),
                    ...(args.depth === (void 0) ? {} : { depth: args.depth as number }),
                    ...(args.includeExternal === (void 0) ? {} : { includeExternal: args.includeExternal as boolean }),
                    ...(args.limit === (void 0) ? {} : { limit: args.limit as number }),
                });
                return { ...report };
            }
            case "export": {
                const report: ExportReport = this.service.exports(this.runtime, {
                    path: args.path as string,
                    ...(args.includeReexports === (void 0) ? {} : { includeReexports: args.includeReexports as boolean }),
                });
                return { ...report };
            }
            case "ast": {
                const tree: SyntaxTree = this.service.ast(this.runtime, {
                    path: args.path as string,
                    ...(args.maxBytes === (void 0) ? {} : { maxBytes: args.maxBytes as number }),
                    ...(args.maxTokens === (void 0) ? {} : { maxTokens: args.maxTokens as number }),
                    ...(args.maxNodes === (void 0) ? {} : { maxNodes: args.maxNodes as number }),
                });
                return { ...wireSyntaxTree(tree) };
            }
            case "dependency": {
                const report: DependencyReport = this.service.dependency(this.runtime, {
                    mode: args.mode as import("./types.ts").DependencyMode,
                    ...(args.roots === (void 0) ? {} : { roots: args.roots as string[] }),
                    ...(args.direction === (void 0) ? {} : { direction: args.direction as "dependencies" | "dependents" }),
                    ...(args.depth === (void 0) ? {} : { depth: args.depth as number }),
                    ...(args.limit === (void 0) ? {} : { limit: args.limit as number }),
                    ...(args.includeExternal === (void 0) ? {} : { includeExternal: args.includeExternal as boolean }),
                });
                return { ...report };
            }
            default: {
                return this.invalid();
            }
        }
    }

    private invalid(): never {
        throw new FilesystemArgumentError();
    }

    private revisionOf(): string {
        try {
            const root = this.runtime.descriptor.roots[0];
            return this.runtime.revisionFor(root);
        } catch {
            return `ses.${this.runtime.descriptor.revision}`;
        }
    }

    errorResponse(code: import("../protocol/filesystem.ts").FilesystemToolErrorCode): FilesystemResponse {
        return {
            protocol: FilesystemProtocol,
            version: FilesystemProtocolVersion,
            ok: false,
            revision: `ses.${this.runtime.descriptor.revision}`,
            session: this.sessionId,
            error: { code, message: code },
        };
    }
}

/**
 * Small helper for hosts that want one descriptor without a live handle.
 */
export const filesystemSessionSummary: (descriptor: SessionDescriptor) => Record<string, unknown> = (
    descriptor: SessionDescriptor,
): Record<string, unknown> => ({
    sessionId: descriptor.id,
    agentId: descriptor.agentId,
    label: descriptor.label,
    status: descriptor.status,
    roots: descriptor.roots.map((root): Record<string, unknown> => ({ id: root.id, writable: root.writable, excludes: root.exclude.length })),
    permissions: { ...descriptor.permissions },
    createdAt: descriptor.createdAt,
    expiresAt: descriptor.expiresAt,
    revision: descriptor.revision,
});
