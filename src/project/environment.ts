/**
 * Declarative environment of a project: environment variables, workspace-relative
 * paths and external dependencies.
 *
 * An environment never reads the file system, executes a command, resolves a
 * package or solves a version constraint. It states what a project expects so a
 * host or agent can prepare, prompt or report on it later.
 */

import { SynchronousUnorderedSet } from "semantic-typescript";

/** A default value for an environment variable. */
export type EnvironmentVariableValue = string;

/** One external tool, runtime or package a project depends on. */
export interface EnvironmentDependency {
    /** Stable dependency identifier, for example "go", "latexmk" or "photoshop". */
    readonly id: string;
    /** Optional version constraint such as ">=1.22"; it is never resolved here. */
    readonly version?: string;
    /** Package manager or toolchain that owns the dependency, for example "tlmgr". */
    readonly manager?: string;
    /** Role the dependency plays for the project. */
    readonly scope: "runtime" | "build" | "dev" | "tool";
    /** True when the project works without the dependency. */
    readonly optional?: boolean;
}

/** Frozen, declarative environment attached to a project. */
export interface ProjectEnvironment {
    /** Environment variable name to default value. Empty string means "declared but unset". */
    readonly variables: Readonly<Record<string, string>>;
    /** Workspace-relative POSIX paths such as sources, assets, output or templates. */
    readonly paths: readonly string[];
    readonly dependencies: readonly EnvironmentDependency[];
}

/** Partial environment used to overlay a base environment. */
export interface EnvironmentPatch {
    readonly variables?: Readonly<Record<string, string>>;
    readonly paths?: readonly string[];
    readonly dependencies?: readonly EnvironmentDependency[];
}

/** One thing the agent still has to configure. */
export interface EnvironmentGap {
    readonly kind: "variable" | "path" | "dependency";
    /** Variable name, path or `<id>@<scope>` dependency key. */
    readonly id: string;
    readonly reason: string;
    readonly guidance: string;
}

/** Environment plus the concrete configuration steps it still needs. */
export interface EnvironmentPlan {
    readonly kind?: string;
    readonly version: number;
    readonly environment: ProjectEnvironment;
    readonly gaps: readonly EnvironmentGap[];
    /** Host or agent supplied instructions, deduplicated and ordered. */
    readonly guidance: readonly string[];
    readonly ready: boolean;
}

export interface EnvironmentPlanOptions {
    readonly kind?: string;
    readonly version?: number;
    readonly guidance?: readonly string[];
    /** Workspace paths that already exist (e.g. project metadata paths); defaults to none. */
    readonly presentPaths?: readonly string[];
}

const VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SCOPES = new SynchronousUnorderedSet<string>(["runtime", "build", "dev", "tool"]);

const EMPTY_VARIABLES: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_PATHS: readonly string[] = Object.freeze([]);
const EMPTY_DEPENDENCIES: readonly EnvironmentDependency[] = Object.freeze([]);

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isRecord(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a workspace-relative POSIX path.
 *
 * Canonical paths use "/" separators, contain no empty or dot segments and
 * never escape the workspace. The workspace root itself (".") is accepted only
 * when `allowRoot` is true, because a project environment may name it.
 */
function requireWorkspacePath(value: unknown, label: string, allowRoot: boolean): string {
    if (!isString(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty workspace-relative path`);
    if (value.trim() !== value) throw new TypeError(`${label} must not have surrounding whitespace`);
    if (/[\0\r\n]/.test(value)) throw new TypeError(`${label} must not contain control characters`);
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) throw new TypeError(`${label} must be workspace-relative`);
    if (value.includes("\\")) throw new TypeError(`${label} must use POSIX separators`);
    if (allowRoot && value === ".") return value;
    const segments = value.split("/");
    if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) throw new TypeError(`${label} must be a canonical workspace-relative path`);
    return value;
}

function validateVariables(value: unknown): void {
    if (!isRecord(value)) throw new TypeError("project environment variables must be an object");
    for (const [name, variableValue] of Object.entries(value as Record<string, unknown>)) {
        if (!VARIABLE_NAME_PATTERN.test(name)) throw new TypeError(`invalid environment variable name: ${name}`);
        if (!isString(variableValue)) throw new TypeError(`environment variable ${name} must be a string`);
    }
}

function validatePaths(value: unknown): void {
    if (!Array.isArray(value)) throw new TypeError("project environment paths must be an array");
    for (let index = 0; index < value.length; index += 1) requireWorkspacePath(value[index], `environment path at index ${index}`, true);
}

function validateDependency(value: unknown, index: number): void {
    const label = `environment dependency at index ${index}`;
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    const dependency = value as Partial<EnvironmentDependency>;
    if (!isString(dependency.id) || dependency.id.trim().length === 0) throw new TypeError(`${label} id must be a non-empty string`);
    if (dependency.version !== undefined && (!isString(dependency.version) || dependency.version.trim().length === 0)) throw new TypeError(`${label} version must be a non-empty string when present`);
    if (dependency.manager !== undefined && (!isString(dependency.manager) || dependency.manager.trim().length === 0)) throw new TypeError(`${label} manager must be a non-empty string when present`);
    if (!isString(dependency.scope) || !SCOPES.contains(dependency.scope)) throw new TypeError(`${label} scope must be runtime, build, dev or tool`);
    if (dependency.optional !== undefined && typeof dependency.optional !== "boolean") throw new TypeError(`${label} optional must be a boolean when present`);
}

function validateDependencies(value: unknown): void {
    if (!Array.isArray(value)) throw new TypeError("project environment dependencies must be an array");
    for (let index = 0; index < value.length; index += 1) validateDependency(value[index], index);
}

/** A frozen environment that declares nothing. */
export function emptyEnvironment(): ProjectEnvironment {
    return Object.freeze({ variables: EMPTY_VARIABLES, paths: EMPTY_PATHS, dependencies: EMPTY_DEPENDENCIES });
}

/**
 * Validate an environment without touching it.
 *
 * Variable names must match ^[A-Z_][A-Z0-9_]*$, paths must be canonical
 * workspace-relative POSIX paths (with "." allowed as the workspace root),
 * scopes must be runtime, build, dev or tool, and dependency strings must be
 * non-empty when present.
 */
export function validateEnvironment(value: ProjectEnvironment): void {
    if (!isRecord(value)) throw new TypeError("project environment must be an object");
    const environment = value as Partial<ProjectEnvironment>;
    validateVariables(environment.variables);
    validatePaths(environment.paths);
    validateDependencies(environment.dependencies);
}

function dependencyKey(dependency: EnvironmentDependency): string {
    return `${dependency.id}@${dependency.scope}`;
}

/**
 * Pure overlay of an environment patch on a base environment.
 *
 * Variables are replaced by name (a patch value of "" declares it unset), paths
 * are deduplicated while preserving base-then-patch order, and dependencies are
 * deduplicated by "id + scope" with a patch entry replacing the matching base
 * entry in place. Neither input is modified; the result and all nested values
 * are frozen.
 */
export function mergeEnvironment(base: ProjectEnvironment, patch: EnvironmentPatch): ProjectEnvironment {
    validateEnvironment(base);
    if (!isRecord(patch)) throw new TypeError("project environment patch must be an object");
    const candidate = patch as EnvironmentPatch;
    if (candidate.variables !== undefined) validateVariables(candidate.variables);
    if (candidate.paths !== undefined) validatePaths(candidate.paths);
    if (candidate.dependencies !== undefined) validateDependencies(candidate.dependencies);

    const names: string[] = Object.keys(base.variables);
    const values: string[] = names.map(name => base.variables[name] ?? "");
    for (const [name, variableValue] of Object.entries(candidate.variables ?? {})) {
        const index = names.indexOf(name);
        if (index >= 0) values[index] = variableValue;
        else {
            names.push(name);
            values.push(variableValue);
        }
    }
    const variables: Record<string, string> = {};
    for (let index = 0; index < names.length; index += 1) variables[names[index]!] = values[index]!;

    const pathValues: string[] = [];
    const seenPaths = new SynchronousUnorderedSet<string>();
    for (const path of [...base.paths, ...(candidate.paths ?? [])]) {
        if (seenPaths.contains(path)) continue;
        seenPaths.add(path);
        pathValues.push(path);
    }

    const dependencyValues: EnvironmentDependency[] = [...base.dependencies];
    const dependencyIndex = new SynchronousUnorderedSet<string>();
    for (let index = 0; index < dependencyValues.length; index += 1) dependencyIndex.add(dependencyKey(dependencyValues[index]!));
    for (const dependency of candidate.dependencies ?? []) {
        const key = dependencyKey(dependency);
        const existing = dependencyValues.findIndex(candidateValue => dependencyKey(candidateValue) === key);
        const frozen = Object.freeze({ ...dependency });
        if (existing >= 0) dependencyValues[existing] = frozen;
        else {
            dependencyValues.push(frozen);
            dependencyIndex.add(key);
        }
    }

    return Object.freeze({
        variables: Object.freeze(variables),
        paths: Object.freeze(pathValues),
        dependencies: Object.freeze(dependencyValues),
    });
}

function pathCovered(path: string, presentPaths: readonly string[]): boolean {
    if (path === ".") return true;
    return presentPaths.some(present => present === path || present.startsWith(`${path}/`));
}

/**
 * Computes what still has to be configured for the environment to be usable.
 *
 * A variable with an empty value is "unset"; a declared path with no matching
 * project path is "missing"; a required dependency without a version is
 * "unpinned". Nothing is executed or resolved.
 */
export function planEnvironment(environment: ProjectEnvironment, options: EnvironmentPlanOptions = {}): EnvironmentPlan {
    validateEnvironment(environment);
    const presentPaths = options.presentPaths ?? [];
    const gaps: EnvironmentGap[] = [];

    for (const [name, value] of Object.entries(environment.variables)) {
        if (value.trim() === "") {
            gaps.push(Object.freeze({ kind: "variable", id: name, reason: "declared but unset",
                guidance: `Set environment variable ${name} to the value this project requires.` }));
        }
    }
    for (const path of environment.paths) {
        if (!pathCovered(path, presentPaths)) {
            gaps.push(Object.freeze({ kind: "path", id: path, reason: "no project entry under this path",
                guidance: `Create or register the path ${path} in the project.` }));
        }
    }
    for (const dependency of environment.dependencies) {
        if (dependency.optional !== true && dependency.version === undefined) {
            gaps.push(Object.freeze({ kind: "dependency", id: dependencyKey(dependency), reason: "required dependency has no version",
                guidance: `Pin ${dependency.id} (${dependency.scope}) to a version constraint.` }));
        }
    }

    const guidance: string[] = [];
    const seenGuidance = new SynchronousUnorderedSet<string>();
    for (const line of [...(options.guidance ?? []), ...gaps.map(gap => gap.guidance)]) {
        const trimmed = line.trim();
        if (trimmed === "" || seenGuidance.contains(trimmed)) continue;
        seenGuidance.add(trimmed);
        guidance.push(trimmed);
    }

    return Object.freeze({
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        version: options.version ?? 0,
        environment,
        gaps: Object.freeze(gaps),
        guidance: Object.freeze(guidance),
        ready: gaps.length === 0,
    });
}

function renderDependency(dependency: EnvironmentDependency): string {
    const parts: string[] = [dependency.scope];
    if (dependency.manager !== undefined) parts.push(`manager: ${dependency.manager}`);
    if (dependency.optional === true) parts.push("optional");
    return `- ${dependency.id}${dependency.version === undefined ? "" : ` ${dependency.version}`} (${parts.join(", ")})`;
}

/** Renders a deterministic, agent-facing configuration brief. */
export function describeEnvironment(plan: EnvironmentPlan): string {
    const lines: string[] = [];
    lines.push("# Project environment");
    lines.push(`kind: ${plan.kind ?? "unconfigured"}`);
    lines.push(`version: ${plan.version}`);
    lines.push(`ready: ${plan.ready ? "yes" : `no (${plan.gaps.length} gap${plan.gaps.length === 1 ? "" : "s"})`}`);
    lines.push("");
    lines.push("## Variables");
    const variables = Object.entries(plan.environment.variables);
    if (variables.length === 0) lines.push("- (none declared)");
    for (const [name, value] of variables) lines.push(`- ${name} = ${value === "" ? "(unset)" : value}`);
    lines.push("");
    lines.push("## Paths");
    if (plan.environment.paths.length === 0) lines.push("- (none declared)");
    for (const path of plan.environment.paths) lines.push(`- ${path}`);
    lines.push("");
    lines.push("## Dependencies");
    if (plan.environment.dependencies.length === 0) lines.push("- (none declared)");
    for (const dependency of plan.environment.dependencies) lines.push(renderDependency(dependency));
    lines.push("");
    lines.push("## Next steps");
    if (plan.guidance.length === 0) lines.push("1. Nothing to configure.");
    else for (const [index, line] of plan.guidance.entries()) lines.push(`${index + 1}. ${line}`);
    return lines.join("\n");
}
