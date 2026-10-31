/**
 * Discovery types: a host catalog plus a bounded structural tree over the
 * authorized workspace snapshot.
 */
import type { WorkspaceEntity, WorkspaceEntityKind } from "../context/workspace.ts";
import type { ComponentKind, ComponentStatus, DiscoveryScope, ModuleKind } from "./kinds.ts";

/**
 * Host-registered project metadata. The workspace snapshot already carries a
 * label and summary; this record lets the host add the description, purpose and
 * longer introduction that agents should see when they discover a project.
 */
export interface HostProject {
    id: string;
    name: string;
    description: string;
    purpose: string;
    summary: string;
    /**
     * Workspace project entity id. Omit when the project has no workspace tree.
     */
    rootId?: string;
    tags?: string[];
}

/**
 * Host-registered plugin, service, tool or module. Discovery never invents
 * these: the host catalog is the only source.
 */
export interface HostComponent {
    id: string;
    kind: ComponentKind;
    name: string;
    description: string;
    purpose?: string;
    version?: string;
    status?: ComponentStatus;
    endpoint?: string;
    capabilities?: string[];
    projectId?: string;
}

export interface DiscoveryMatch {
    line: number;
    text: string;
}

export type DiscoveryNodeKind = "host" | "group" | WorkspaceEntityKind | ComponentKind;

/**
 * One node of the discovery tree. Project nodes carry description, purpose and
 * summary; file nodes carry module classification, extension and bounded
 * content matches.
 */
export interface DiscoveryNode {
    id: string;
    kind: DiscoveryNodeKind;
    label: string;
    description?: string;
    purpose?: string;
    summary?: string;
    moduleKind?: ModuleKind;
    extension?: string;
    sourceUri?: string;
    version?: string;
    status?: ComponentStatus;
    endpoint?: string;
    capabilities?: string[];
    projectId?: string;
    matched: boolean;
    truncated?: boolean;
    contentMatches?: DiscoveryMatch[];
    children: DiscoveryNode[];
}

export interface DiscoveryQuery {
    text?: string;
    scope?: DiscoveryScope;
    moduleKind?: ModuleKind;
    componentKind?: ComponentKind;
    extension?: string;
    pathPrefix?: string;
    /**
     * Search file content for `text` and return at most three snippets per file.
     * Off by default because content reads are more expensive than metadata.
     */
    content?: boolean;
    maxDepth?: number;
    limit?: number;
}

export interface DiscoverySummary {
    projects: number;
    modules: number;
    files: number;
    matches: number;
    plugins: number;
    services: number;
    tools: number;
    nodes: number;
    truncated: boolean;
}

export interface DiscoveryTree {
    revision: string;
    query: DiscoveryQuery;
    tree: DiscoveryNode;
    summary: DiscoverySummary;
    moduleCounts: Partial<Record<ModuleKind, number>>;
}

export interface DiscoveryInput {
    revision: string;
    entities: readonly WorkspaceEntity[];
    projects: readonly HostProject[];
    components: readonly HostComponent[];
    /**
     * Components supplied by the serving process itself, such as the
     * `amp.workspace` service and its tools. Host components win on id clashes.
     */
    builtIn?: readonly HostComponent[];
    query?: DiscoveryQuery;
    contentOf?: (entity: WorkspaceEntity) => string | undefined;
}
