/**
 * Frozen naming table.
 *
 * This is the only file allowed to spell a canonical workspace protocol, service
 * or tool name literally. Every other module derives names through `grammar.ts`
 * or imports these constants, which is what keeps a rename from scattering
 * across dispatch branches, pin records and documentation.
 */

/**
 * The closed identity layers.
 *
 * Keeping the kind inside the name (instead of in a side table) is what makes
 * a protocol id, a service id and a tool id impossible to confuse after they
 * have been serialized.
 */
export type IdKind = "protocol" | "service" | "tool";

/**
 * A parsed identity: the original text plus the fields the grammar extracted.
 *
 * The fields are redundant with `text` on purpose. Consumers dispatch and audit
 * on the structured parts, while the string is what goes on the wire; keeping
 * both means a caller never has to re-parse and can never hand a mismatched
 * pair to the transport.
 */
export interface Id {
    /**
     * The exact source string. Parsing rejects everything outside the grammar,
     * so a parsed id is already canonical and needs no normalization.
     */
    readonly text: string;
    /**
     * The closed kind enum. It is a token in the id itself, not metadata, so a
     * consumer can never disagree with the name it was given.
     */
    readonly kind: IdKind;
    /**
     * Namespace segment that keeps `workspace` tools from colliding with a
     * future `fingerprint` component.
     */
    readonly component: string;
    /**
     * Zero to two trailing segments. Tools carry at least one; protocol and
     * service ids carry none so their wire identity stays stable.
     */
    readonly leaf: readonly string[];
}

/**
 * Fixed protocol namespace.
 *
 * Hosts isolate tools by MCP server, so `amp` only has to be unique within one
 * host, and the shorter prefix leaves room for the wrapping budget expressed
 * by `MaxWireLength`.
 */
export const Namespace: string = "amp";

/**
 * Hard id ceiling.
 *
 * Kept at 48 so the longest id plus a service id plus an MCP-style
 * `mcp__<server>__<tool>` wrapper still fits the 64-character tool-name limit.
 */
export const MaxIdLength: number = 48;

/**
 * Component ceiling; the remaining id budget belongs to the leaf so the
 * differentiating suffix stays visible to a model instead of being buried in a
 * long shared prefix.
 */
export const MaxComponentLength: number = 16;

/**
 * Leaf ceiling. A third segment means the name needs a new component, not a
 * longer shared prefix, because prompt caches key on prefixes.
 */
export const MaxLeafSegments: number = 2;

/**
 * Wrapped-name ceiling: `mcp__<server>__<tool>` must stay within the common
 * 64-character host limit or a name that is valid in isolation becomes invalid
 * in the most common client.
 */
export const MaxWireLength: number = 64;

/**
 * Protocol identity. It has no leaf because a protocol is a whole surface, not
 * a single operation.
 */
export const ProtocolIds: { readonly workspace: string; readonly global: string; readonly filesystem: string; readonly globalfs: string; } = Object.freeze({
    workspace: "amp_protocol_workspace",
    global: "amp_protocol_global",
    filesystem: "amp_protocol_filesystem",
    globalfs: "amp_protocol_globalfs",
});

/**
 * Service identity published as `serverInfo.name`; it has no leaf because
 * routing is per server, not per operation.
 */
export const ServiceIds: { readonly workspace: string; readonly global: string; readonly filesystem: string; readonly globalfs: string; } = Object.freeze({
    workspace: "amp_service_workspace",
    global: "amp_service_global",
    filesystem: "amp_service_filesystem",
    globalfs: "amp_service_globalfs",
});

/**
 * Canonical operation names. Dispatch, audit and pin records must all use these
 * values; legacy `amp_workspace_*` strings survive only as input aliases in
 * `aliases.ts`.
 */
export const ToolIds: {
    readonly workspaceCapabilities: string;
    readonly workspaceTree: string;
    readonly workspaceQuery: string;
    readonly workspaceRelations: string;
    readonly workspaceMaterialize: string;
    readonly workspaceRead: string;
    readonly workspaceRelease: string;
    readonly workspaceDiscover: string;
    readonly workspaceWrite: string;
    readonly workspaceProject: string;
    readonly workspaceOutline: string;
    readonly workspaceDependency: string;
    readonly workspaceReactiveRead: string;
    readonly workspaceReactiveWrite: string;
    readonly workspaceDiffRead: string;
    readonly workspaceDiffWrite: string;
    readonly filesystemSession: string;
    readonly filesystemFile: string;
    readonly filesystemDirectory: string;
    readonly filesystemRead: string;
    readonly filesystemWrite: string;
    readonly filesystemOutline: string;
    readonly filesystemImport: string;
    readonly filesystemExport: string;
    readonly filesystemDependency: string;
    readonly filesystemAst: string;
    readonly globalCapabilities: string;
    readonly globalTree: string;
    readonly globalQuery: string;
    readonly globalRelations: string;
    readonly globalMaterialize: string;
    readonly globalRead: string;
    readonly globalRelease: string;
    readonly globalDiscover: string;
    readonly globalWrite: string;
    readonly globalProject: string;
    readonly globalOutline: string;
    readonly globalDependency: string;
    readonly globalReactiveRead: string;
    readonly globalReactiveWrite: string;
    readonly globalDiffRead: string;
    readonly globalDiffWrite: string;
    readonly globalfsSession: string;
    readonly globalfsFile: string;
    readonly globalfsDirectory: string;
    readonly globalfsRead: string;
    readonly globalfsWrite: string;
    readonly globalfsOutline: string;
    readonly globalfsImport: string;
    readonly globalfsExport: string;
    readonly globalfsDependency: string;
    readonly globalfsAst: string;
} = Object.freeze({
    workspaceCapabilities: "amp_tool_workspace_capabilities",
    workspaceTree: "amp_tool_workspace_tree",
    workspaceQuery: "amp_tool_workspace_query",
    workspaceRelations: "amp_tool_workspace_relations",
    workspaceMaterialize: "amp_tool_workspace_materialize",
    workspaceRead: "amp_tool_workspace_read",
    workspaceRelease: "amp_tool_workspace_release",
    workspaceDiscover: "amp_tool_workspace_discover",
    workspaceWrite: "amp_tool_workspace_write",
    workspaceProject: "amp_tool_workspace_project",
    workspaceOutline: "amp_tool_workspace_outline",
    workspaceDependency: "amp_tool_workspace_dependency",
    workspaceReactiveRead: "amp_tool_workspace_reactive_read",
    workspaceReactiveWrite: "amp_tool_workspace_reactive_write",
    workspaceDiffRead: "amp_tool_workspace_diff_read",
    workspaceDiffWrite: "amp_tool_workspace_diff_write",
    filesystemSession: "amp_tool_filesystem_session",
    filesystemFile: "amp_tool_filesystem_file",
    filesystemDirectory: "amp_tool_filesystem_directory",
    filesystemRead: "amp_tool_filesystem_read",
    filesystemWrite: "amp_tool_filesystem_write",
    filesystemOutline: "amp_tool_filesystem_outline",
    filesystemImport: "amp_tool_filesystem_import",
    filesystemExport: "amp_tool_filesystem_export",
    filesystemDependency: "amp_tool_filesystem_dependency",
    filesystemAst: "amp_tool_filesystem_ast",
    globalCapabilities: "amp_tool_global_capabilities",
    globalTree: "amp_tool_global_tree",
    globalQuery: "amp_tool_global_query",
    globalRelations: "amp_tool_global_relations",
    globalMaterialize: "amp_tool_global_materialize",
    globalRead: "amp_tool_global_read",
    globalRelease: "amp_tool_global_release",
    globalDiscover: "amp_tool_global_discover",
    globalWrite: "amp_tool_global_write",
    globalProject: "amp_tool_global_project",
    globalOutline: "amp_tool_global_outline",
    globalDependency: "amp_tool_global_dependency",
    globalReactiveRead: "amp_tool_global_reactive_read",
    globalReactiveWrite: "amp_tool_global_reactive_write",
    globalDiffRead: "amp_tool_global_diff_read",
    globalDiffWrite: "amp_tool_global_diff_write",
    globalfsSession: "amp_tool_globalfs_session",
    globalfsFile: "amp_tool_globalfs_file",
    globalfsDirectory: "amp_tool_globalfs_directory",
    globalfsRead: "amp_tool_globalfs_read",
    globalfsWrite: "amp_tool_globalfs_write",
    globalfsOutline: "amp_tool_globalfs_outline",
    globalfsImport: "amp_tool_globalfs_import",
    globalfsExport: "amp_tool_globalfs_export",
    globalfsDependency: "amp_tool_globalfs_dependency",
    globalfsAst: "amp_tool_globalfs_ast",
});
