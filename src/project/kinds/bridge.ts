import { Project } from "../core.ts";
import { mergeEnvironment, type ProjectEnvironment } from "../environment.ts";
import type { ProjectScope } from "../types.ts";
import type { ProjectKindDefinition } from "./types.ts";

export interface ProjectFromKindOptions extends ProjectScope {
    readonly clock?: () => string;
    /** Extra agent-facing instructions merged with the kind's notes. */
    readonly guidance?: readonly string[];
}

/**
 * Creates a project whose environment starts from the kind defaults.
 *
 * The kind remains the source of the defaults; the project owns and versions
 * the resulting environment afterwards, so configuration changes never mutate
 * the shared definition.
 */
export function createProjectFromKind(definition: ProjectKindDefinition, options: ProjectFromKindOptions): Project {
    const guidance = [...(options.guidance ?? []), ...(definition.notes === undefined ? [] : [definition.notes])];
    return new Project({
        tenantId: options.tenantId,
        rootId: options.rootId,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        kind: definition.id,
        environment: definition.environment,
        ...(guidance.length === 0 ? {} : { guidance }),
    });
}

/**
 * Applies a kind's defaults to an existing project while preserving the
 * project's own overrides: the project value wins, empty strings still mean
 * "declared but unset".
 */
export function applyProjectKind(
    project: Project,
    definition: ProjectKindDefinition,
    options: { readonly expectedVersion?: number } = {},
): ProjectEnvironment {
    const current = project.environment;
    const merged = mergeEnvironment(definition.environment, {
        variables: current.variables,
        paths: current.paths,
        dependencies: current.dependencies,
    });
    return project.setEnvironment(merged, options);
}
