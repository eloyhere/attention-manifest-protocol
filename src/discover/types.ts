/**
 * Discovery types: a host catalog plus a bounded structural tree over the
 * authorized workspace snapshot.
 */
import type { WorkspaceEntity, WorkspaceEntityKind } from "../context/workspace.ts";
import type { EnvironmentAvailability, EnvironmentCategory } from "../environment/types.ts";
import type { KnowledgeEntry, KnowledgeRegistry } from "../knowledge/registry.ts";
import type { ProtocolEntry, ProtocolRegistry } from "../protocol/registry.ts";
import type { SkillEntry, SkillRegistry } from "../skill/registry.ts";
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
    category?: EnvironmentCategory;
    availability?: EnvironmentAvailability;
    platforms?: string[];
    extensions?: string[];
    relatedIds?: string[];
    skillIds?: string[];
    knowledgeIds?: string[];
    toolIds?: string[];
    protocolIds?: string[];
}

export interface DiscoveryMatch {
    line: number;
    text: string;
}

export type DiscoveryNodeKind = "host" | "group" | WorkspaceEntityKind | ComponentKind | "skill" | "knowledge" | "protocol";

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
    category?: EnvironmentCategory;
    availability?: EnvironmentAvailability;
    platforms?: string[];
    extensions?: string[];
    relatedIds?: string[];
    tags?: string[];
    skillIds?: string[];
    knowledgeIds?: string[];
    toolIds?: string[];
    protocolIds?: string[];
    protocolStatus?: "active" | "deprecated" | "disabled";
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
    /** Restricts discovery to host components declaring this environment category. */
    category?: EnvironmentCategory;
    /** Restricts discovery to host components declaring this availability. */
    availability?: EnvironmentAvailability;
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
    /** Optional for consumers constructing pre-registry discovery summaries. */
    skills?: number;
    knowledge?: number;
    protocols?: number;
    /** Returned host components with a declared environment category. */
    environments?: number;
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

export interface DiscoverySearchOptions {
    revision?: string;
    limit?: number;
    kinds?: readonly string[];
    tags?: readonly string[];
    maxDepth?: number;
    nodeLimit?: number;
}

export interface DiscoverySearchNode {
    id: string;
    kind: string;
    label: string;
    summary?: string;
    projectId?: string;
    sourceUri?: string;
    score?: number | null;
    matched: boolean;
    children: DiscoverySearchNode[];
}

export interface DiscoverySearchTree {
    query: string;
    tree: DiscoverySearchNode;
    total: number;
    totalRelation: "eq" | "gte";
    took: number;
    timedOut: boolean;
    truncated: boolean;
}

export interface DiscoverySearchResult {
    trees: DiscoverySearchTree[];
}

/** Host-owned asynchronous search port. Project scope comes only from the service. */
export interface DiscoverySearch {
    discover(
        scope: { projectIds: readonly string[]; includeGlobal?: boolean },
        queries: string | readonly string[],
        options?: DiscoverySearchOptions,
    ): Promise<DiscoverySearchResult>;
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
    skills?: readonly SkillEntry[] | SkillRegistry;
    knowledge?: readonly KnowledgeEntry[] | KnowledgeRegistry;
    protocols?: readonly ProtocolEntry[] | ProtocolRegistry;
    query?: DiscoveryQuery;
    contentOf?: (entity: WorkspaceEntity) => string | undefined;
}
