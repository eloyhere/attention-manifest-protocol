/**
 * Bounded discovery tree over the host-authorized workspace snapshot and the
 * host's component catalog.
 *
 * The tree is descriptive: it never widens the project scope, and content
 * matches are short snippets used as discovery evidence rather than a detail
 * read. The caller owns the response-size budget; this builder owns the node,
 * depth, content-read and snippet caps.
 */
import type { WorkspaceEntity } from "../context/workspace.ts";
import { classifyModule, extensionOf, normalizeExtension } from "./classify.ts";
import type { ComponentKind, DiscoveryScope, ModuleKind } from "./kinds.ts";
import { ComponentKinds, DiscoveryScopes, ModuleKinds } from "./kinds.ts";
import type {
    DiscoveryInput,
    DiscoveryMatch,
    DiscoveryNode,
    DiscoveryQuery,
    DiscoverySummary,
    DiscoveryTree,
    HostComponent,
    HostProject,
} from "./types.ts";

interface NormalizedQuery {
    text: string;
    scope: DiscoveryScope;
    moduleKind?: ModuleKind;
    componentKind?: ComponentKind;
    extension?: string;
    pathPrefix?: string;
    content: boolean;
    maxDepth: number;
    limit: number;
}

interface WalkState {
    used: number;
    truncated: boolean;
    projects: number;
    modules: number;
    files: number;
    matches: number;
    plugins: number;
    services: number;
    tools: number;
    moduleCounts: Partial<Record<ModuleKind, number>>;
    contentReads: number;
    contentCache: Map<string, DiscoveryMatch[]>;
    matchMemo: Map<string, boolean>;
}

interface WalkResult {
    node: DiscoveryNode | null;
    matched: boolean;
    cut: boolean;
}

const DefaultLimit: number = 100;
const MaxLimit: number = 200;
const DefaultDepth: number = 6;
const MaxDepth: number = 12;
const MaxContentChars: number = 65_536;
const MaxContentFiles: number = 50;
const MaxSnippets: number = 3;
const SnippetChars: number = 160;

const isModuleKind: (value: string) => value is ModuleKind = (value: string): value is ModuleKind => (ModuleKinds as readonly string[]).includes(value);

const isComponentKind: (value: string) => value is ComponentKind = (value: string): value is ComponentKind =>
    (ComponentKinds as readonly string[]).includes(value);

const normalizeQuery: (input?: DiscoveryQuery) => NormalizedQuery = (input: DiscoveryQuery = {}): NormalizedQuery => {
    const text: string = (input.text ?? "").trim();
    const scope: DiscoveryScope = input.scope ?? "all";
    if (!DiscoveryScopes.includes(scope)) {
        throw new RangeError(`unknown discovery scope ${scope}`);
    }
    if (input.moduleKind !== (void 0) && !isModuleKind(input.moduleKind)) {
        throw new RangeError(`unknown discovery module kind ${input.moduleKind}`);
    }
    if (input.componentKind !== (void 0) && !isComponentKind(input.componentKind)) {
        throw new RangeError(`unknown discovery component kind ${input.componentKind}`);
    }
    const maxDepth: number = input.maxDepth ?? DefaultDepth;
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MaxDepth) {
        throw new RangeError(`discovery maxDepth must be 0..${MaxDepth}`);
    }
    const limit: number = input.limit ?? DefaultLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MaxLimit) {
        throw new RangeError(`discovery limit must be 1..${MaxLimit}`);
    }
    return {
        text,
        scope,
        ...(input.moduleKind === (void 0) ? {} : { moduleKind: input.moduleKind }),
        ...(input.componentKind === (void 0) ? {} : { componentKind: input.componentKind }),
        ...(input.extension === (void 0) ? {} : { extension: normalizeExtension(input.extension) }),
        ...(input.pathPrefix === (void 0) ? {} : { pathPrefix: input.pathPrefix }),
        content: input.content === true,
        maxDepth,
        limit,
    };
};

const metadataText: (entity: WorkspaceEntity) => string = (entity: WorkspaceEntity): string =>
    `${entity.label} ${entity.source.uri} ${entity.summary} ${(entity.tags ?? []).join(" ")} ${(entity.searchTerms ?? []).join(" ")}`.toLowerCase();

const componentText: (component: HostComponent) => string = (component: HostComponent): string =>
    `${component.id} ${component.name} ${component.description} ${component.purpose ?? ""} ${component.version ?? ""} ${component.endpoint ?? ""} ${(component.capabilities ?? []).join(" ")}`.toLowerCase();

const projectText: (project: HostProject) => string = (project: HostProject): string =>
    `${project.id} ${project.name} ${project.description} ${project.purpose} ${project.summary} ${(project.tags ?? []).join(" ")}`.toLowerCase();

const passesStructuralFilters: (entity: WorkspaceEntity, query: NormalizedQuery) => boolean = (entity: WorkspaceEntity, query: NormalizedQuery): boolean => {
    if (entity.kind !== "file") {
        return true;
    }
    if (query.moduleKind !== (void 0) && classifyModule(entity) !== query.moduleKind) {
        return false;
    }
    if (query.extension !== (void 0) && extensionOf(entity.source.uri) !== query.extension) {
        return false;
    }
    if (query.pathPrefix !== (void 0) && !entity.source.uri.startsWith(query.pathPrefix)) {
        return false;
    }
    return true;
};

const structuralFiltersActive: (query: NormalizedQuery) => boolean = (query: NormalizedQuery): boolean =>
    query.moduleKind !== (void 0) || query.extension !== (void 0) || query.pathPrefix !== (void 0);

const contentMatches: (entity: WorkspaceEntity, query: NormalizedQuery, state: WalkState, contentOf?: (entity: WorkspaceEntity) => string | undefined) => DiscoveryMatch[] = (
    entity: WorkspaceEntity,
    query: NormalizedQuery,
    state: WalkState,
    contentOf?: (entity: WorkspaceEntity) => string | undefined,
): DiscoveryMatch[] => {
    if (!query.content || query.text === "" || entity.kind !== "file" || contentOf === (void 0)) {
        return [];
    }
    const cached: DiscoveryMatch[] | undefined = state.contentCache.get(entity.id);
    if (cached !== (void 0)) {
        return cached;
    }
    if (state.contentReads >= MaxContentFiles) {
        state.truncated = true;
        return [];
    }
    state.contentReads += 1;
    const content: string | undefined = contentOf(entity);
    if (content === (void 0)) {
        state.contentCache.set(entity.id, []);
        return [];
    }
    const limited: string = content.length > MaxContentChars ? content.slice(0, MaxContentChars) : content;
    const needle: string = query.text.toLowerCase();
    const lines: string[] = limited.split("\n");
    const matches: DiscoveryMatch[] = [];
    for (let index: number = 0; index < lines.length && matches.length < MaxSnippets; index += 1) {
        const line: string = lines[index].trim();
        if (line.toLowerCase().includes(needle)) {
            matches.push({ line: index + 1, text: line.length > SnippetChars ? `${line.slice(0, SnippetChars)}…` : line });
        }
    }
    state.contentCache.set(entity.id, matches);
    return matches;
};

const makeEntityNode: (
    entity: WorkspaceEntity,
    query: NormalizedQuery,
    state: WalkState,
    matched: boolean,
    matches: DiscoveryMatch[],
    children: DiscoveryNode[],
    truncated: boolean,
    hostProjectByRoot: ReadonlyMap<string, HostProject>,
    usedHostProjects: Set<string>,
) => DiscoveryNode | undefined = (
    entity: WorkspaceEntity,
    query: NormalizedQuery,
    state: WalkState,
    matched: boolean,
    matches: DiscoveryMatch[],
    children: DiscoveryNode[],
    truncated: boolean,
    hostProjectByRoot: ReadonlyMap<string, HostProject>,
    usedHostProjects: Set<string>,
): DiscoveryNode | undefined => {
    if (state.used >= query.limit) {
        state.truncated = true;
        return undefined;
    }
    state.used += 1;
    const hostProject: HostProject | undefined = entity.kind === "project" ? hostProjectByRoot.get(entity.id) : undefined;
    const node: DiscoveryNode = {
        id: entity.id,
        kind: entity.kind,
        label: hostProject?.name ?? entity.label,
        sourceUri: entity.source.uri,
        matched,
        children,
    };
    if (truncated) {
        node.truncated = true;
    }
    if (entity.kind === "file") {
        state.files += 1;
        const moduleKind: ModuleKind = classifyModule(entity);
        node.moduleKind = moduleKind;
        const extension: string | undefined = extensionOf(entity.source.uri);
        if (extension !== (void 0)) {
            node.extension = extension;
        }
        if (moduleKind !== "unknown") {
            state.modules += 1;
            state.moduleCounts[moduleKind] = (state.moduleCounts[moduleKind] ?? 0) + 1;
        }
        if (matches.length > 0) {
            node.contentMatches = matches.map((match: DiscoveryMatch): DiscoveryMatch => ({ ...match }));
            state.matches += matches.length;
        }
    } else if (entity.kind === "project") {
        state.projects += 1;
        const summary: string = entity.summary.trim().length > 0 ? entity.summary : `Project ${entity.label}`;
        node.description = hostProject?.description ?? summary;
        node.purpose = hostProject?.purpose ?? ((entity.tags ?? []).length > 0 ? (entity.tags ?? []).join(", ") : "not declared");
        node.summary = hostProject?.summary ?? summary;
        if (hostProject !== (void 0)) {
            usedHostProjects.add(hostProject.id);
        }
    }
    return node;
};

const makeProjectNode: (project: HostProject, state: WalkState, query: NormalizedQuery) => DiscoveryNode | undefined = (
    project: HostProject,
    state: WalkState,
    query: NormalizedQuery,
): DiscoveryNode | undefined => {
    if (state.used >= query.limit) {
        state.truncated = true;
        return undefined;
    }
    state.used += 1;
    state.projects += 1;
    return {
        id: project.id,
        kind: "project",
        label: project.name,
        description: project.description,
        purpose: project.purpose,
        summary: project.summary,
        matched: true,
        children: [],
    };
};

const makeComponentNode: (component: HostComponent, query: NormalizedQuery, state: WalkState) => DiscoveryNode | undefined = (
    component: HostComponent,
    query: NormalizedQuery,
    state: WalkState,
): DiscoveryNode | undefined => {
    if (state.used >= query.limit) {
        state.truncated = true;
        return undefined;
    }
    state.used += 1;
    if (component.kind === "plugin") {
        state.plugins += 1;
    } else if (component.kind === "service") {
        state.services += 1;
    } else if (component.kind === "tool") {
        state.tools += 1;
    }
    const node: DiscoveryNode = {
        id: component.id,
        kind: component.kind,
        label: component.name,
        description: component.description,
        matched: true,
        children: [],
    };
    if (component.purpose !== (void 0)) {
        node.purpose = component.purpose;
    }
    if (component.version !== (void 0)) {
        node.version = component.version;
    }
    if (component.status !== (void 0)) {
        node.status = component.status;
    }
    if (component.endpoint !== (void 0)) {
        node.endpoint = component.endpoint;
    }
    if (component.capabilities !== (void 0)) {
        node.capabilities = [...component.capabilities];
    }
    if (component.projectId !== (void 0)) {
        node.projectId = component.projectId;
    }
    return node;
};

const componentMatches: (component: HostComponent, query: NormalizedQuery) => boolean = (component: HostComponent, query: NormalizedQuery): boolean => {
    if (query.componentKind !== (void 0) && component.kind !== query.componentKind) {
        return false;
    }
    return query.text === "" || componentText(component).includes(query.text.toLowerCase());
};

const projectMatches: (project: HostProject, query: NormalizedQuery) => boolean = (project: HostProject, query: NormalizedQuery): boolean =>
    query.text === "" || projectText(project).includes(query.text.toLowerCase());

/**
 * Build the bounded tree. The result is deterministic for a fixed input: roots
 * sort by label, children by kind and label, and the node budget stops in that
 * order.
 */
export const buildDiscoveryTree: (input: DiscoveryInput) => DiscoveryTree = (input: DiscoveryInput): DiscoveryTree => {
    const query: NormalizedQuery = normalizeQuery(input.query);
    const state: WalkState = {
        used: 0,
        truncated: false,
        projects: 0,
        modules: 0,
        files: 0,
        matches: 0,
        plugins: 0,
        services: 0,
        tools: 0,
        moduleCounts: {},
        contentReads: 0,
        contentCache: new Map<string, DiscoveryMatch[]>(),
        matchMemo: new Map<string, boolean>(),
    };
    const childrenByParent: Map<string, WorkspaceEntity[]> = new Map<string, WorkspaceEntity[]>();
    const projectEntities: WorkspaceEntity[] = [];
    for (let index: number = 0; index < input.entities.length; index += 1) {
        const entity: WorkspaceEntity = input.entities[index];
        if (entity.kind === "project") {
            projectEntities.push(entity);
        }
        if (entity.parentId !== (void 0)) {
            const children: WorkspaceEntity[] = childrenByParent.get(entity.parentId) ?? [];
            children.push(entity);
            childrenByParent.set(entity.parentId, children);
        }
    }
    childrenByParent.forEach((children: WorkspaceEntity[]): void => {
        children.sort((left: WorkspaceEntity, right: WorkspaceEntity): number => {
            const leftRank: number = left.kind === "directory" ? 0 : 1;
            const rightRank: number = right.kind === "directory" ? 0 : 1;
            return leftRank - rightRank || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
        });
    });
    projectEntities.sort((left: WorkspaceEntity, right: WorkspaceEntity): number => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));

    const hostProjectByRoot: Map<string, HostProject> = new Map<string, HostProject>();
    for (let index: number = 0; index < input.projects.length; index += 1) {
        const project: HostProject = input.projects[index];
        hostProjectByRoot.set(project.id, project);
        if (project.rootId !== (void 0)) {
            hostProjectByRoot.set(project.rootId, project);
        }
    }
    const usedHostProjects: Set<string> = new Set<string>();
    const workspaceProjectIds: Set<string> = new Set<string>(projectEntities.map((entity: WorkspaceEntity): string => entity.id));
    const entityMatchText: (entity: WorkspaceEntity) => string = (entity: WorkspaceEntity): string => {
        const hostProject: HostProject | undefined = entity.kind === "project" ? hostProjectByRoot.get(entity.id) : undefined;
        return `${metadataText(entity)} ${hostProject === (void 0) ? "" : projectText(hostProject)}`.toLowerCase();
    };

    const hasMatchInSubtree: (entity: WorkspaceEntity) => boolean = (entity: WorkspaceEntity): boolean => {
        const cached: boolean | undefined = state.matchMemo.get(entity.id);
        if (cached !== (void 0)) {
            return cached;
        }
        const structural: boolean = passesStructuralFilters(entity, query);
        let result: boolean = false;
        if (structural) {
            if (entity.kind === "file") {
                result = query.text === "" || entityMatchText(entity).includes(query.text.toLowerCase()) || contentMatches(entity, query, state, input.contentOf).length > 0;
            } else {
                result = query.text !== "" && entityMatchText(entity).includes(query.text.toLowerCase());
                if (!result) {
                    const children: WorkspaceEntity[] = childrenByParent.get(entity.id) ?? [];
                    for (let index: number = 0; index < children.length && !result; index += 1) {
                        result = hasMatchInSubtree(children[index]);
                    }
                }
            }
        }
        state.matchMemo.set(entity.id, result);
        return result;
    };

    const walk: (entity: WorkspaceEntity, depth: number) => WalkResult = (entity: WorkspaceEntity, depth: number): WalkResult => {
        const structural: boolean = passesStructuralFilters(entity, query);
        const textMatched: boolean = structural && query.text !== "" && entityMatchText(entity).includes(query.text.toLowerCase());
        const matches: DiscoveryMatch[] =
            structural && entity.kind === "file" && query.content && query.text !== ""
                ? contentMatches(entity, query, state, input.contentOf)
                : [];
        const fileMatched: boolean = entity.kind === "file" && structural && (query.text === "" || textMatched || matches.length > 0);
        const projectMatched: boolean = entity.kind === "project" && query.text === "" && !structuralFiltersActive(query);
        const selfMatched: boolean = fileMatched || projectMatched || textMatched;
        const childEntities: WorkspaceEntity[] = childrenByParent.get(entity.id) ?? [];
        const children: DiscoveryNode[] = [];
        let childMatched: boolean = false;
        let cut: boolean = false;
        if (depth >= query.maxDepth) {
            for (let index: number = 0; index < childEntities.length && !cut; index += 1) {
                cut = hasMatchInSubtree(childEntities[index]);
            }
        } else {
            for (let index: number = 0; index < childEntities.length; index += 1) {
                const result: WalkResult = walk(childEntities[index], depth + 1);
                if (result.node !== null) {
                    children.push(result.node);
                }
                if (result.matched) {
                    childMatched = true;
                }
                if (result.cut) {
                    cut = true;
                }
            }
        }
        if (!selfMatched && !childMatched && !cut) {
            return { node: null, matched: false, cut: false };
        }
        if (cut) {
            state.truncated = true;
        }
        const node: DiscoveryNode | undefined = makeEntityNode(
            entity,
            query,
            state,
            selfMatched,
            matches,
            children,
            cut,
            hostProjectByRoot,
            usedHostProjects,
        );
        return node === (void 0) ? { node: null, matched: true, cut: true } : { node, matched: true, cut };
    };

    const projectNodes: DiscoveryNode[] = [];
    const includeProjects: boolean = query.scope !== "host" && query.componentKind === (void 0);
    const includeHost: boolean = query.scope !== "projects" && !structuralFiltersActive(query);
    if (includeProjects) {
        for (let index: number = 0; index < projectEntities.length; index += 1) {
            const result: WalkResult = walk(projectEntities[index], 0);
            if (result.node !== null) {
                projectNodes.push(result.node);
            }
        }
        for (let index: number = 0; index < input.projects.length; index += 1) {
            const project: HostProject = input.projects[index];
            const hasWorkspaceProject: boolean = workspaceProjectIds.has(project.id) || (project.rootId !== (void 0) && workspaceProjectIds.has(project.rootId));
            if (hasWorkspaceProject || usedHostProjects.has(project.id) || !projectMatches(project, query) || structuralFiltersActive(query)) {
                continue;
            }
            const node: DiscoveryNode | undefined = makeProjectNode(project, state, query);
            if (node !== (void 0)) {
                projectNodes.push(node);
            }
        }
    }

    const componentNodes: Map<ComponentKind, DiscoveryNode[]> = new Map<ComponentKind, DiscoveryNode[]>();
    if (includeHost) {
        const components: Map<string, HostComponent> = new Map<string, HostComponent>();
        for (let index: number = 0; index < (input.builtIn ?? []).length; index += 1) {
            const component: HostComponent = (input.builtIn ?? [])[index];
            components.set(component.id, component);
        }
        for (let index: number = 0; index < input.components.length; index += 1) {
            const component: HostComponent = input.components[index];
            components.set(component.id, component);
        }
        for (const component of components.values()) {
            if (!componentMatches(component, query)) {
                continue;
            }
            const node: DiscoveryNode | undefined = makeComponentNode(component, query, state);
            if (node === (void 0)) {
                break;
            }
            const group: DiscoveryNode[] = componentNodes.get(component.kind) ?? [];
            group.push(node);
            componentNodes.set(component.kind, group);
        }
    }

    const root: DiscoveryNode = {
        id: "discover:host",
        kind: "host",
        label: "host",
        description: "Authorized projects, internal modules, files and host-registered components.",
        matched: true,
        children: [],
    };
    projectNodes.sort((left: DiscoveryNode, right: DiscoveryNode): number => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    if (projectNodes.length > 0) {
        root.children.push({ id: "discover:projects", kind: "group", label: "projects", matched: true, children: projectNodes });
    }
    const groupLabels: Record<ComponentKind, string> = {
        plugin: "plugins",
        service: "services",
        tool: "tools",
        module: "modules",
    };
    for (let index: number = 0; index < ComponentKinds.length; index += 1) {
        const kind: ComponentKind = ComponentKinds[index];
        const nodes: DiscoveryNode[] | undefined = componentNodes.get(kind);
        if (nodes !== void 0 && nodes.length > 0) {
            nodes.sort((left: DiscoveryNode, right: DiscoveryNode): number => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
            root.children.push({ id: `discover:${groupLabels[kind]}`, kind: "group", label: groupLabels[kind], matched: true, children: nodes });
        }
    }

    const summary: DiscoverySummary = {
        projects: state.projects,
        modules: state.modules,
        files: state.files,
        matches: state.matches,
        plugins: state.plugins,
        services: state.services,
        tools: state.tools,
        nodes: state.used,
        truncated: state.truncated,
    };
    return {
        revision: input.revision,
        query: {
            text: query.text,
            scope: query.scope,
            ...(query.moduleKind === (void 0) ? {} : { moduleKind: query.moduleKind }),
            ...(query.componentKind === (void 0) ? {} : { componentKind: query.componentKind }),
            ...(query.extension === (void 0) ? {} : { extension: query.extension }),
            ...(query.pathPrefix === (void 0) ? {} : { pathPrefix: query.pathPrefix }),
            content: query.content,
            maxDepth: query.maxDepth,
            limit: query.limit,
        },
        tree: root,
        summary,
        moduleCounts: { ...state.moduleCounts },
    };
};
