/**
 * AMP workspace extension v1. Local entity IDs are opaque workspace keys, not
 * paths or global AMP object IDs. JSON Schemas are shared by all adapters.
 *
 * The file lives outside `src/context` because a protocol is a wire contract,
 * not a domain concept: direct executors and MCP bridges both need the same
 * identities and schemas, and a domain directory must not own a public protocol
 * surface. Every name comes from the frozen naming table, so this file adds no
 * second spelling of an id.
 */
import { MaxLeafSegments, parseId, ProtocolIds, ServiceIds, ToolIds } from "../naming/index.ts";
import type { Id } from "../naming/index.ts";
import { ComponentKinds, DiscoveryScopes, ModuleKinds } from "../discover/kinds.ts";

/**
 * Literal spellings owned by this module.
 *
 * The frozen naming table is typed `string` today, so the casts below are the
 * only place this file narrows a table value to its literal; once the table
 * carries literal types the casts disappear without changing any consumer.
 */
type WorkspaceProtocolName = "amp_protocol_workspace";
type WorkspaceVersion = 1;
type WorkspaceServiceName = "amp_service_workspace";

/**
 * Wire protocol value. The literal type is intentional: `WorkspaceResponse` is
 * constrained by it, so a widened `string` would let a response advertise a
 * protocol this service does not implement.
 */
export const WorkspaceProtocol: WorkspaceProtocolName = ProtocolIds.workspace as WorkspaceProtocolName;

/**
 * Envelope version. Kept as the literal `1` because the response type embeds
 * it; changing it is a breaking wire change rather than a routine edit.
 */
export const WorkspaceProtocolVersion: WorkspaceVersion = 1;

/**
 * Service identity published as `serverInfo.name` and repeated as `serviceId`.
 * Hosts route per server, so the namespace must be stable across every
 * transport instead of being derived from whatever process happens to run it.
 */
export const WorkspaceServiceId: WorkspaceServiceName = ServiceIds.workspace as WorkspaceServiceName;

/**
 * Legacy protocol spellings kept for lenient hosts. Exporting them here lets a
 * host compare an old `amp.workspace` value without hard-coding it, while the
 * server itself writes only `WorkspaceProtocol`.
 */
export { WorkspaceProtocolAliases } from "../naming/index.ts";

/**
 * Error taxonomy callers branch on.
 *
 * The set is closed and the strings are part of the wire contract, so a new
 * failure mode needs a new code rather than a free-form message; that is what
 * lets an adapter map a failure without parsing prose.
 */
export type WorkspaceErrorCode =
    | "invalid_arguments"
    | "unknown_tool"
    | "revision_mismatch"
    | "not_available"
    | "frame_unavailable"
    | "write_unavailable"
    | "run_unavailable"
    | "unsupported_action"
    | "fingerprint_mismatch"
    | "stale_detail"
    | "budget_exhausted"
    | "capacity_exceeded"
    | "response_too_large"
    | "integrity_failure"
    | "internal_error";

/**
 * Success or failure envelope.
 *
 * `protocol`, `version` and `revision` stay on both branches so a host can
 * reject a stale or foreign response before inspecting `ok`; `data` and `error`
 * are mutually exclusive so a caller never has to decide which half to trust.
 */
export type WorkspaceResponse = {
    protocol: typeof WorkspaceProtocol;
    version: typeof WorkspaceProtocolVersion;
    revision: string;
} & ({ ok: true; data: Record<string, unknown>; } | { ok: false; error: { code: WorkspaceErrorCode; message: string; }; });

/**
 * Advertised tool descriptor.
 *
 * Kept structural instead of importing an MCP type so the same definition can
 * feed `tools/list`, the direct registry and the catalog digest without the
 * protocol module depending on any adapter.
 */
export interface WorkspaceToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    /**
     * Side-effect class. `read` covers discovery and detail reads; `write`
     * covers the one tool that asks the host to persist new project content.
     * The field is carried on the descriptor so the registry, the MCP
     * annotations and the catalog digest cannot disagree about a tool.
     */
    risk: WorkspaceRisk;
}

/**
 * Closed side-effect classes for workspace tools.
 */
export type WorkspaceRisk = "read" | "write";

/**
 * One relative file reached through an `imports` relation.
 *
 * `id` is the opaque workspace key the caller can re-query, while `path` is the
 * project-relative source URI a human reads. `line` is the 1-based line of the
 * extraction site and `method` records how the edge was produced.
 */
export interface WorkspaceFileLink {
    id: string;
    path: string;
    line?: number;
    method: "manifest" | "compiler" | "explicit";
}

/**
 * Files that import the node's file: the consumers of its exports.
 *
 * `path` is the node's containing file (or `null` when the node is not inside a
 * file). `files` is bounded by the service's `maxFileLinks`; `total` is the
 * untruncated count and `truncated` says whether `files` is a prefix.
 */
export interface WorkspaceExportation {
    path: string | null;
    files: WorkspaceFileLink[];
    total: number;
    truncated: boolean;
}

/**
 * Files the node's file imports, plus the bare package specifiers it depends on.
 *
 * Only relative workspace files appear in `files`; declarations outside the
 * indexed snapshot stay in `external` because there is no relative path to
 * report for them. Missing edges are extraction gaps, not proof of independence.
 */
export interface WorkspaceImportation {
    path: string | null;
    files: WorkspaceFileLink[];
    external: string[];
    /**
     * Untruncated external-specifier count and whether `external` was cut by
     * `maxFileLinks`. Kept separate from `total`/`truncated`, which describe
     * the relative-file list.
     */
    externalTotal: number;
    externalTruncated: boolean;
    total: number;
    truncated: boolean;
}

/**
 * Dependency/impact facts attached to detail reads and writes.
 */
export interface WorkspaceImpacts {
    exportation: WorkspaceExportation;
    importation: WorkspaceImportation;
}

/**
 * Actions the project tool accepts. `detect` only inspects the snapshot; the
 * other four are handed to the host runner, which owns the decision to execute.
 */
export type WorkspaceProjectAction = "detect" | "build" | "compile" | "run" | "test";

/**
 * The manifest file that made a brand recognisable.
 */
export interface WorkspaceProjectManifest {
    id: string;
    path: string;
}

/**
 * One detected project brand with the conventional commands for it.
 *
 * Commands are suggestions for the host runner, not a shell grammar: the agent
 * cannot supply one, and the runner may reject or rewrite any of them.
 */
export interface WorkspaceProjectBrand {
    brand: string;
    language: string;
    manifest: WorkspaceProjectManifest;
    actions: WorkspaceProjectAction[];
    commands: Partial<Record<WorkspaceProjectAction, string>>;
}

/**
 * One project's detection result. `brand`/`manifest`/`commands` are the primary
 * (most specific) evidence; `detected` keeps every brand found so a caller can
 * choose when a repository mixes toolchains.
 */
export interface WorkspaceProjectSummary {
    projectId: string;
    label: string;
    cwd: string;
    brand: string;
    language: string;
    manifest: WorkspaceProjectManifest | null;
    actions: WorkspaceProjectAction[];
    commands: Partial<Record<WorkspaceProjectAction, string>>;
    detected: WorkspaceProjectBrand[];
}

/**
 * One node in the cascading project outline.
 *
 * `children` nests project → directory → file → symbol/knowledge, and
 * `childCount` is the untruncated number of children so a caller can tell a
 * leaf from a node the `limit` cut.
 */
export interface WorkspaceOutlineNode {
    id: string;
    kind: "project" | "directory" | "file" | "symbol" | "knowledge";
    label: string;
    path: string;
    structureKind?: string;
    startLine?: number;
    endLine?: number;
    childCount: number;
    children: WorkspaceOutlineNode[];
}

/**
 * One project dependency edge with the declaration that produced it.
 */
export interface WorkspaceDependencyEdge {
    id: string;
    kind: string;
    label: string;
    path: string;
    method: "manifest" | "compiler" | "explicit";
    line?: number;
}

/**
 * One project's dependencies and dependents.
 */
export interface WorkspaceProjectDependency {
    projectId: string;
    label: string;
    dependencies: WorkspaceDependencyEdge[];
    dependents: WorkspaceDependencyEdge[];
}

/**
 * Node properties the reactive surface may write.
 *
 * `summary`/`label`/`tags` are service-local annotations: they change what the
 * reactive tree (and later reads of the node card) report without touching the
 * host. `content` is the guarded file write and needs the same materialized
 * allocation and host write port as `amp_tool_workspace_write`.
 */
export type WorkspaceReactiveProperty = "summary" | "label" | "tags" | "content";

/**
 * Plain projection of a reactive node. The in-process value is a Proxy whose
 * `children`/`content` properties materialize lazily; `toJSON` produces this
 * shape, bounded by the call's `maxDepth`/`limit`.
 */
export interface WorkspaceReactiveNode {
    id: string;
    kind: string;
    label: string;
    path: string;
    summary: string;
    tags: string[];
    structureKind?: string;
    startLine?: number;
    endLine?: number;
    revision: string;
    childCount: number;
    children: WorkspaceReactiveNode[];
    truncated?: boolean;
}

/**
 * One comparable file node from `diff_read`. `revision` is the content revision
 * the snapshot records, so two calls over different revisions can be compared
 * without fetching bodies; `bytes`/`lines` are derived from the stored detail
 * and stay `null` when the host did not provide it.
 */
export interface WorkspaceDiffNode {
    id: string;
    kind: "project" | "directory" | "file";
    label: string;
    path: string;
    revision: string;
    bytes: number | null;
    lines: number | null;
    content: string | null;
    contentOmitted: boolean;
    /**
     * True when `content` is a prefix of the file rather than the whole body
     * (the service caps it at `maxReadChars`). `bytes`/`lines` always describe
     * the whole file, so a truncated body is never mistaken for a short one.
     */
    contentTruncated: boolean;
    childCount: number;
    children: WorkspaceDiffNode[];
}

/**
 * One changed region reported by `diff_write`.
 */
export interface WorkspaceDiffHunk {
    beforeStart: number;
    beforeLines: number;
    afterStart: number;
    afterLines: number;
}

const Key: Record<string, unknown> = { type: "string", minLength: 1, maxLength: 4096 };
const Keys: Record<string, unknown> = { type: "array", items: Key, maxItems: 100 };
const Kinds: string[] = ["project_depends_on", "imports", "calls", "references", "documents"];
const Page: Record<string, unknown> = {
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: "integer", minimum: 1, maximum: 100 },
};
/**
 * Line-addressed page bounds. The ceiling matches the filesystem read tool so a
 * host can map one addressing model onto both surfaces without a second limit.
 */
const LineNumber: Record<string, unknown> = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const MaxPageBytes: number = 262144;
/**
 * Largest single write this protocol accepts. The service enforces the same
 * ceiling on the resulting content, because line/byte splices can grow a file
 * beyond the length of the replacement text.
 */
const MaxWriteChars: number = 1048576;
/**
 * One line splice for `diff_write`. The validator understands nested object
 * schemas, so the change list stays strictly typed without free-form patches.
 */
const LineChangeSchema: Record<string, unknown> = {
    type: "object",
    properties: {
        startLine: LineNumber,
        endLine: LineNumber,
        content: { type: "string", maxLength: MaxWriteChars },
    },
    required: ["startLine", "endLine", "content"],
    additionalProperties: false,
};
/**
 * One UTF-8 byte splice for `diff_write`.
 */
const ByteChangeSchema: Record<string, unknown> = {
    type: "object",
    properties: {
        offsetBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        endBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        content: { type: "string", maxLength: MaxWriteChars },
    },
    required: ["offsetBytes", "endBytes", "content"],
    additionalProperties: false,
};

/**
 * Build one descriptor from its canonical id.
 *
 * The caller supplies a `ToolIds` value rather than a leaf, so a definition
 * cannot silently invent a name that the naming table and the alias resolver do
 * not know about. Schema field order is fixed here because the catalog digest
 * covers the schema as canonical JSON, not as a reordered authoring choice.
 * `risk` is part of the descriptor rather than a side table so the digest, the
 * registry and the MCP annotations cannot disagree about a side effect.
 */
const definition: (id: string, risk: WorkspaceRisk, description: string, properties: Record<string, unknown>, required?: string[]) => WorkspaceToolDefinition = (id: string, risk: WorkspaceRisk, description: string, properties: Record<string, unknown>, required: string[] = []): WorkspaceToolDefinition => ({
    name: id,
    risk,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
});

const Definitions: WorkspaceToolDefinition[] = [
    definition(ToolIds.workspaceCapabilities, "read", "Discover authorized workspace projects, revision, registered Frame IDs and service limits. Does not grant new access.", {}),
    definition(
        ToolIds.workspaceTree,
        "read",
        "List project roots or direct structural children with native source locations; no summary or detail bodies. Use offset for pagination.",
        { revision: Key, parentId: Key, ...Page },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceQuery,
        "read",
        "Find candidate IDs using lexical AND search and bounded graph traversal. Candidates need host Frame allocation before content reads.",
        {
            revision: Key,
            text: { type: "string", maxLength: 4096 },
            seedIds: Keys,
            projectIds: Keys,
            relationKinds: { type: "array", items: { type: "string", enum: Kinds }, maxItems: 5 },
            direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
            maxDepth: { type: "integer", minimum: 0, maximum: 10 },
            limit: Page.limit,
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceRelations,
        "read",
        "Page descriptive dependency/call/reference edges for one authorized node. Does not materialize either endpoint.",
        {
            revision: Key,
            nodeId: Key,
            direction: { type: "string", enum: ["incoming", "outgoing"] },
            relationKind: { type: "string", enum: Kinds },
            ...Page,
        },
        ["revision", "nodeId", "direction"],
    ),
    definition(
        ToolIds.workspaceDiscover,
        "read",
        "Discover authorized projects, internal modules (service/tool/...), file names and bounded content matches, plus host-registered plugins/services/tools, as one structural tree. Project nodes carry description, purpose and summary. Read-only; snippets are discovery evidence, not a detail grant.",
        {
            revision: Key,
            text: { type: "string", maxLength: 512 },
            scope: { type: "string", enum: DiscoveryScopes },
            moduleKind: { type: "string", enum: ModuleKinds },
            componentKind: { type: "string", enum: ComponentKinds },
            extension: { type: "string", maxLength: 16 },
            pathPrefix: { type: "string", maxLength: 1024 },
            content: { type: "boolean" },
            maxDepth: { type: "integer", minimum: 0, maximum: 12 },
            limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceMaterialize,
        "read",
        "Materialize a host-registered Frame once. Repeated calls reuse its Context. Only summaries fitting the requested and host/Frame budgets are returned.",
        {
            revision: Key,
            frameId: Key,
            budgetTokens: { type: "integer", minimum: 1, maximum: 32000 },
        },
        ["revision", "frameId", "budgetTokens"],
    ),
    definition(
        ToolIds.workspaceRead,
        "read",
        "Read a bounded page of CAS-verified detail from an explicitly allocated, materialized target. Structural ancestors alone do not grant detail access. Page by character offset (default), by 1-based lines (startLine/maxLines) or by UTF-8 bytes (offsetBytes/maxBytes); the char `offset`/`nextOffset` pair continues any page, a byte offset inside a character advances to the next boundary, and one line longer than the page budget is returned whole. The reply also carries the containing file's `exportation` (relative files that import it) and `importation` (relative files it imports, plus truncated `external` package specifiers) from the indexed snapshot, so an edit can be scoped without a second query. A symbol or knowledge page whose containing file was written through this service answers `stale_detail` until the host refreshes the snapshot.",
        {
            revision: Key,
            contextId: Key,
            nodeId: Key,
            offset: Page.offset,
            maxChars: { type: "integer", minimum: 1, maximum: 16000 },
            startLine: LineNumber,
            maxLines: { type: "integer", minimum: 1, maximum: 2000 },
            offsetBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            maxBytes: { type: "integer", minimum: 1, maximum: MaxPageBytes },
        },
        ["revision", "contextId", "nodeId"],
    ),
    definition(
        ToolIds.workspaceWrite,
        "write",
        "Replace project content for one explicitly allocated, materialized file target. Address the whole node (default), a 1-based line range (startLine/endLine) or a UTF-8 byte range (offsetBytes/endBytes); `content` is inserted in place of that span. Line mode keeps the file's line-terminator shape: a missing final terminator is supplied and empty `content` deletes the selected lines. Byte offsets must fall on a UTF-8 character boundary. `expectRevision` is compare-and-swap against the content revision a previous read returned; `dryRun` validates and previews without asking the host to persist. The reply carries the same `exportation`/`importation` edges as `read`; the indexed snapshot is not re-parsed, so those lists describe the snapshot rather than the new text.",
        {
            revision: Key,
            contextId: Key,
            nodeId: Key,
            content: { type: "string", maxLength: MaxWriteChars },
            startLine: LineNumber,
            endLine: LineNumber,
            offsetBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            endBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            expectRevision: { type: "string", minLength: 1, maxLength: 256 },
            dryRun: { type: "boolean" },
        },
        ["revision", "contextId", "nodeId", "content"],
    ),
    definition(
        ToolIds.workspaceProject,
        "write",
        "Detect a project's brand from manifest and lockfile evidence (npm/pnpm/yarn/bun, Maven, Gradle, CMake, Cargo, Go, Python, Make, Composer, .NET, Bundler, Swift, sbt) with its conventional build/compile/run/test commands. `action: \"detect\"` only reads the snapshot; any other action hands exactly one host-chosen command to the runner port, so an agent can never author a command string. Without `brand` the first detected brand that defines the requested action is used; a pinned `brand` that lacks it fails `unsupported_action`. Execution is host-gated: without a runner the call fails `run_unavailable`. `dryRun` returns the command without running it.",
        {
            revision: Key,
            projectId: Key,
            action: { type: "string", enum: ["detect", "build", "compile", "run", "test"] },
            brand: { type: "string", minLength: 1, maxLength: 32 },
            dryRun: { type: "boolean" },
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceOutline,
        "read",
        "Return one cascading outline for a project: project → directories → files → symbol/knowledge nodes, each with its project-relative path and 1-based source range. File bodies and summaries are not returned. `maxDepth` and `limit` bound the tree, and each node's `childCount` reports how many children it has before truncation. Use `pathPrefix`/`extension` to keep the outline focused and `includeSymbols: false` for directories and files only.",
        {
            revision: Key,
            projectId: Key,
            pathPrefix: { type: "string", maxLength: 1024 },
            extension: { type: "string", maxLength: 16 },
            maxDepth: { type: "integer", minimum: 0, maximum: 12 },
            limit: { type: "integer", minimum: 1, maximum: 2000 },
            includeSymbols: { type: "boolean" },
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceDependency,
        "read",
        "Report project-level dependencies and dependents from manifest/compiler `project_depends_on` edges, with the declaring source and extraction method. File-level imports stay on `read` and `relations`. `direction` selects outgoing, incoming or both; `offset`/`limit` page the project list.",
        {
            revision: Key,
            projectId: Key,
            direction: { type: "string", enum: ["outgoing", "incoming", "both"] },
            offset: Page.offset,
            limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceReactiveRead,
        "read",
        "Return a reactive workspace tree. In process every node is a Proxy whose `label`, `summary`, `tags`, `revision`, `childCount` and `children` are materialized on first access and cached; `toJSON` (and therefore the wire response) is a bounded plain projection of the same tree. Structural metadata only: no file bodies. Use `reactive_write` to change a cached property; the reply reports the cache version and the invalidated ancestors.",
        {
            revision: Key,
            projectId: Key,
            nodeId: Key,
            maxDepth: { type: "integer", minimum: 0, maximum: 12 },
            limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceReactiveWrite,
        "write",
        "Set one property on a reactive node and refresh the affected cache. `summary`, `label` and `tags` update the service-local annotation overlay and are immediately visible to the next `reactive_read`; they are not persisted to the host. `content` replaces a file's text and is the guarded write path: it needs a materialized Context, the same readable target as `write`, compare-and-swap and the host write port. The reply lists the invalidated node ids and the new cache version, plus the write payload for `content`.",
        {
            revision: Key,
            nodeId: Key,
            property: { type: "string", enum: ["summary", "label", "tags", "content"] },
            value: {
                anyOf: [
                    { type: "string", minLength: 1, maxLength: 4096 },
                    { type: "array", items: Key, maxItems: 32 },
                ],
            },
            contextId: Key,
            expectRevision: { type: "string", minLength: 1, maxLength: 256 },
            dryRun: { type: "boolean" },
        },
        ["revision", "nodeId", "property", "value"],
    ),
    definition(
        ToolIds.workspaceDiffRead,
        "read",
        "Return a comparable tree for diffing: project → directory → file, where every node carries its content `revision` and each file reports `bytes`/`lines` derived from the stored detail. Because the identity and revision fields are stable, two calls over different snapshots can be compared directly. `includeContent` additionally returns bounded file text, and only for targets readable in the supplied materialized Context; every other file reports `content: null, contentOmitted: true`.",
        {
            revision: Key,
            projectId: Key,
            pathPrefix: { type: "string", maxLength: 1024 },
            extension: { type: "string", maxLength: 16 },
            contextId: Key,
            includeContent: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        ["revision"],
    ),
    definition(
        ToolIds.workspaceDiffWrite,
        "write",
        "Write one file from a diff decision. Supply exactly one of `content` (whole file), `changes` (1-based line splices) or `byteChanges` (UTF-8 byte splices); line and byte changes apply bottom-up so ranges stay valid, then the whole result is persisted through the host write port. The reply reports the strategy, the line diff (`added`/`removed`/`unchanged` and bounded hunks), the content revision, and the same `exportation`/`importation` facts as `read`. Auth, CAS (`expectRevision`) and `dryRun` match `write`.",
        {
            revision: Key,
            contextId: Key,
            nodeId: Key,
            content: { type: "string", maxLength: MaxWriteChars },
            changes: { type: "array", items: LineChangeSchema, maxItems: 100 },
            byteChanges: { type: "array", items: ByteChangeSchema, maxItems: 100 },
            contextLines: { type: "integer", minimum: 0, maximum: 20 },
            expectRevision: { type: "string", minLength: 1, maxLength: 256 },
            dryRun: { type: "boolean" },
        },
        ["revision", "contextId", "nodeId"],
    ),
    definition(
        ToolIds.workspaceRelease,
        "read",
        "Release this service's Context handle. Does not create an action Receipt or refund/reopen its Frame budget.",
        { revision: Key, contextId: Key },
        ["revision", "contextId"],
    ),
];

/**
 * Return fresh copies of the descriptors.
 *
 * The definitions are module-level state; handing out the originals would let
 * one adapter's tampering change what another adapter advertises. The clone
 * keeps every caller's mutations local without duplicating the source table.
 */
export const workspaceToolDefinitions: () => WorkspaceToolDefinition[] = (): WorkspaceToolDefinition[] => structuredClone(Definitions);

/**
 * Canonical tool id to its single leaf segment.
 *
 * Dispatch needs the operation token, and parsing it once here means the
 * service never slices a name by hand or re-derives a convention the grammar
 * already owns. Deriving from `Definitions` rather than a second literal table
 * keeps the map and the advertised tools from drifting apart; a descriptor that
 * stops being a single-leaf workspace tool fails at module load instead of at
 * the first call.
 */
const WorkspaceToolLeaves: ReadonlyMap<string, string> = new Map<string, string>(
    Definitions.map((tool: WorkspaceToolDefinition): readonly [string, string] => {
        const parsed: Id = parseId(tool.name);
        if (parsed.kind !== "tool" || parsed.component !== "workspace" || parsed.leaf.length < 1 || parsed.leaf.length > MaxLeafSegments) {
            throw new Error(`workspace tool id must be a one- or two-leaf tool in the workspace component: "${tool.name}"`);
        }
        /**
         * Two-segment leaves (`reactive_read`, `diff_write`) keep their full
         * spelling so the dispatcher can switch on one stable token. The
         * grammar already caps the segment count, so joining is unambiguous.
         */
        return [tool.name, parsed.leaf.join("_")];
    }),
);

/**
 * Frozen-contract alias for the leaf index; the local binding stays PascalCase
 * because it is module-level data, matching the alias convention in naming.
 */
export { WorkspaceToolLeaves as workspaceToolLeaves };
