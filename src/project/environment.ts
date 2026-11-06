/**
 * Declarative environment of a project kind: variables, workspace-relative
 * paths and external dependencies.
 *
 * An environment never reads the file system, executes a command, resolves a
 * package or solves a version constraint. It only states what a project kind
 * expects so a host can prepare, prompt or report on it later.
 */

/** A default value for an environment variable. */
export type EnvironmentVariableValue = string;

/** One external tool, runtime or package a project kind depends on. */
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

/** Frozen, declarative environment attached to a project kind. */
export interface ProjectEnvironment {
    /** Environment variable name to default value. */
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

const VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SCOPES: ReadonlySet<string> = new Set(["runtime", "build", "dev", "tool"]);

const EMPTY_VARIABLES: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_PATHS: readonly string[] = Object.freeze([]);
const EMPTY_DEPENDENCIES: readonly EnvironmentDependency[] = Object.freeze([]);

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

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isRecord(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (!isString(dependency.scope) || !SCOPES.has(dependency.scope)) throw new TypeError(`${label} scope must be runtime, build, dev or tool`);
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

/**
 * Pure overlay of an environment patch on a base environment.
 *
 * Variables are replaced by name, paths are deduplicated while preserving
 * base-then-patch order, and dependencies are deduplicated by "id + scope"
 * with a patch entry replacing the matching base entry in place. Neither
 * input is modified; the result and all of its nested values are frozen.
 */
export function mergeEnvironment(base: ProjectEnvironment, patch: EnvironmentPatch): ProjectEnvironment {
    validateEnvironment(base);
    if (!isRecord(patch)) throw new TypeError("project environment patch must be an object");
    const candidate = patch as EnvironmentPatch;
    if (candidate.variables !== undefined) validateVariables(candidate.variables);
    if (candidate.paths !== undefined) validatePaths(candidate.paths);
    if (candidate.dependencies !== undefined) validateDependencies(candidate.dependencies);

    const variableEntries = new Map<string, string>(Object.entries(base.variables));
    for (const [name, variableValue] of Object.entries(candidate.variables ?? {})) variableEntries.set(name, variableValue);
    const variables = Object.freeze(Object.fromEntries(variableEntries));

    const pathValues: string[] = [];
    const seenPaths = new Set<string>();
    for (const path of [...base.paths, ...(candidate.paths ?? [])]) {
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        pathValues.push(path);
    }
    const paths = Object.freeze(pathValues);

    const dependenciesByKey = new Map<string, EnvironmentDependency>();
    for (const dependency of base.dependencies) dependenciesByKey.set(`${dependency.id}\0${dependency.scope}`, dependency);
    for (const dependency of candidate.dependencies ?? []) dependenciesByKey.set(`${dependency.id}\0${dependency.scope}`, dependency);
    const dependencies = Object.freeze([...dependenciesByKey.values()].map(dependency => Object.freeze({ ...dependency })));

    return Object.freeze({ variables, paths, dependencies });
}
