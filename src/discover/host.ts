/**
 * Host-owned discovery catalog. Only the host can register projects, plugins,
 * services, tools and modules; agents see what this catalog exposes.
 */
import type { ComponentKind } from "./kinds.ts";
import { ComponentKinds, ComponentStatuses } from "./kinds.ts";
import type { HostComponent, HostProject } from "./types.ts";

const requireText: (value: string, field: string) => void = (value: string, field: string): void => {
    if (typeof(value) !== "string" || value.trim().length === 0) {
        throw new Error(`discovery ${field} must be a non-empty string`);
    }
};

const cloneProject: (project: HostProject) => HostProject = (project: HostProject): HostProject => ({
    ...project,
    ...(project.tags === (void 0) ? {} : { tags: [...project.tags] }),
});

const cloneComponent: (component: HostComponent) => HostComponent = (component: HostComponent): HostComponent => ({
    ...component,
    ...(component.capabilities === (void 0) ? {} : { capabilities: [...component.capabilities] }),
});

const validateProject: (project: HostProject) => void = (project: HostProject): void => {
    requireText(project.id, "project id");
    requireText(project.name, "project name");
    requireText(project.description, "project description");
    requireText(project.purpose, "project purpose");
    requireText(project.summary, "project summary");
    if (project.rootId !== (void 0)) {
        requireText(project.rootId, "project rootId");
    }
    if (project.tags !== (void 0) && (!Array.isArray(project.tags) || project.tags.some((tag: string): boolean => typeof(tag) !== "string" || tag.trim().length === 0))) {
        throw new Error("discovery project tags must be non-empty strings");
    }
};

const validateComponent: (component: HostComponent) => void = (component: HostComponent): void => {
    requireText(component.id, "component id");
    requireText(component.name, "component name");
    requireText(component.description, "component description");
    if (!ComponentKinds.includes(component.kind)) {
        throw new Error(`unknown discovery component kind ${component.kind}`);
    }
    if (component.status !== (void 0) && !ComponentStatuses.includes(component.status)) {
        throw new Error(`unknown discovery component status ${component.status}`);
    }
    if (component.capabilities !== (void 0) && (!Array.isArray(component.capabilities) || component.capabilities.some((item: string): boolean => typeof(item) !== "string" || item.trim().length === 0))) {
        throw new Error("discovery component capabilities must be non-empty strings");
    }
    if (component.endpoint !== (void 0)) {
        requireText(component.endpoint, "component endpoint");
    }
};

export class HostCatalog {
    private readonly projectMap: Map<string, HostProject> = new Map<string, HostProject>();
    private readonly componentMap: Map<string, HostComponent> = new Map<string, HostComponent>();

    addProject(project: HostProject): HostProject {
        validateProject(project);
        if (this.projectMap.has(project.id)) {
            throw new Error(`project ${project.id} is already registered`);
        }
        this.projectMap.set(project.id, cloneProject(project));
        return cloneProject(project);
    }

    addComponent(component: HostComponent): HostComponent {
        validateComponent(component);
        if (this.componentMap.has(component.id)) {
            throw new Error(`component ${component.id} is already registered`);
        }
        this.componentMap.set(component.id, cloneComponent(component));
        return cloneComponent(component);
    }

    addPlugin(component: Omit<HostComponent, "kind">): HostComponent {
        return this.addComponent({ ...component, kind: "plugin" });
    }

    addService(component: Omit<HostComponent, "kind">): HostComponent {
        return this.addComponent({ ...component, kind: "service" });
    }

    addTool(component: Omit<HostComponent, "kind">): HostComponent {
        return this.addComponent({ ...component, kind: "tool" });
    }

    addModule(component: Omit<HostComponent, "kind">): HostComponent {
        return this.addComponent({ ...component, kind: "module" });
    }

    projects(): HostProject[] {
        return [...this.projectMap.values()].map(cloneProject);
    }

    components(kind?: ComponentKind): HostComponent[] {
        const all: HostComponent[] = [...this.componentMap.values()].map(cloneComponent);
        return kind === (void 0) ? all : all.filter((component: HostComponent): boolean => component.kind === kind);
    }

    hasProject(id: string): boolean {
        return this.projectMap.has(id);
    }

    hasComponent(id: string): boolean {
        return this.componentMap.has(id);
    }
}
