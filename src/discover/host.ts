/**
 * Host-owned discovery catalog. Only the host can register projects, plugins,
 * services, tools and modules; agents see what this catalog exposes.
 */
import { EnvironmentAvailabilities, EnvironmentCategories } from "../environment/types.ts";
import { InMemoryRegistry } from "../registry/memory.ts";
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

const ComponentArrayFields = ["capabilities", "platforms", "extensions", "relatedIds", "skillIds", "knowledgeIds", "toolIds", "protocolIds"] as const;

const cloneComponent: (component: HostComponent) => HostComponent = (component: HostComponent): HostComponent => {
    const clone: HostComponent = { ...component };
    for (const field of ComponentArrayFields) {
        const values: string[] | undefined = component[field];
        if (values !== (void 0)) {
            clone[field] = [...values];
        }
    }
    return clone;
};

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
    if (component.category !== (void 0) && !EnvironmentCategories.includes(component.category)) {
        throw new Error(`unknown discovery component category ${component.category}`);
    }
    if (component.availability !== (void 0) && !EnvironmentAvailabilities.includes(component.availability)) {
        throw new Error(`unknown discovery component availability ${component.availability}`);
    }
    for (const field of ComponentArrayFields) {
        const values: string[] | undefined = component[field];
        if (values !== (void 0) && (!Array.isArray(values) || [...values].some((item: string): boolean => typeof(item) !== "string" || item.trim().length === 0))) {
            throw new Error(`discovery component ${field} must be non-empty strings`);
        }
    }
    if (component.endpoint !== (void 0)) {
        requireText(component.endpoint, "component endpoint");
    }
};

export class HostCatalog {
    private readonly projectRegistry: InMemoryRegistry<HostProject> = new InMemoryRegistry<HostProject>(cloneProject, (id: string): Error => new Error(`project ${id} is already registered`));
    private readonly componentRegistry: InMemoryRegistry<HostComponent> = new InMemoryRegistry<HostComponent>(cloneComponent, (id: string): Error => new Error(`component ${id} is already registered`));

    addProject(project: HostProject): HostProject {
        validateProject(project);
        return this.projectRegistry.register(project);
    }

    addComponent(component: HostComponent): HostComponent {
        validateComponent(component);
        return this.componentRegistry.register(component);
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
        return this.projectRegistry.list();
    }

    components(kind?: ComponentKind): HostComponent[] {
        return this.componentRegistry.list({ filter: (component: HostComponent): boolean => kind === (void 0) || component.kind === kind });
    }

    getComponent(id: string): HostComponent | undefined {
        return this.componentRegistry.get(id);
    }

    hasProject(id: string): boolean {
        return this.projectRegistry.has(id);
    }

    hasComponent(id: string): boolean {
        return this.componentRegistry.has(id);
    }
}
