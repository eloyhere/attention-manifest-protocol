/**
 * Gateway handlers that let the agent configure a project through tool calls.
 *
 * The module is a pure adapter. Each handler validates the tool parameter
 * envelope, forwards the domain input to `Project`, and returns the resulting
 * snapshot. Binding checks, authorization, exposure and idempotency stay with
 * `AgentGateway`; the handlers never read the call context, never re-check
 * authority and never swallow a domain error.
 *
 * Unknown parameter names are rejected with `TypeError` rather than ignored:
 * a typo such as `envVariables` would otherwise become a successful no-op
 * write. Domain failures thrown by `Project` (`version_conflict`,
 * `invalid_project`, ...) propagate unchanged for the gateway to journal.
 */

import type { GatewayHandler } from "../agent/gateway.ts";
import type { Project } from "./core.ts";
import type { EnvironmentDependency, EnvironmentPatch, ProjectEnvironment } from "./environment.ts";
import type { ProjectRule } from "./types.ts";

/** One parsed parameter object that passed the envelope checks. */
type ToolParameters = Readonly<Record<string, unknown>>;

/** Environment snapshot plus the project revision it belongs to. */
type ProjectEnvironmentResult = Readonly<{ readonly environment: ProjectEnvironment; readonly version: number }>;

const CONFIGURE_ENVIRONMENT_TOOL = "attention_manifest_protocol_project.configure_environment" as const;
const PUT_RULE_TOOL = "attention_manifest_protocol_project.put_rule" as const;
const DESCRIBE_ENVIRONMENT_TOOL = "attention_manifest_protocol_project.describe_environment" as const;

const CONFIGURE_ENVIRONMENT_PARAMETERS: readonly string[] = Object.freeze(["variables", "paths", "dependencies", "expectedVersion"]);
const PUT_RULE_PARAMETERS: readonly string[] = Object.freeze(["id", "text", "expectedVersion"]);
const DESCRIBE_ENVIRONMENT_PARAMETERS: readonly string[] = Object.freeze([]);

/** Full tool names provided by this module, in stable order. */
export const projectToolNames: readonly string[] = Object.freeze([
    CONFIGURE_ENVIRONMENT_TOOL,
    PUT_RULE_TOOL,
    DESCRIBE_ENVIRONMENT_TOOL,
]);

/**
 * Validate the shape every project tool shares: one plain parameter object with
 * only allowed keys. Returns the same object so callers can keep forwarding it.
 */
const readParameters = (value: unknown, allowed: readonly string[]): ToolParameters => {
    if (typeof(value) !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError("project tool parameters must be a single object");
    }
    const parameters: ToolParameters = value as ToolParameters;
    const unknownNames: string[] = Object.keys(parameters).filter(name => !allowed.includes(name));
    if (unknownNames.length > 0) {
        throw new TypeError(`unknown project tool parameters: ${unknownNames.join(", ")}`);
    }
    return parameters;
};

/**
 * Read the optional CAS revision. A missing value stays `undefined`; every
 * present value must be a nonnegative safe integer.
 */
const readExpectedVersion = (parameters: ToolParameters): number | undefined => {
    const value: unknown = parameters.expectedVersion;
    if (value === undefined) {
        return undefined;
    }
    if (typeof(value) !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("expectedVersion must be a nonnegative safe integer");
    }
    return value;
};

/**
 * Select the three environment dimensions from the raw parameters. Their
 * contents stay `unknown` on purpose: `Project.configureEnvironment` validates
 * them and reports `invalid_project`, so the handler adds no duplicate policy.
 */
const readEnvironmentPatch = (parameters: ToolParameters): EnvironmentPatch => {
    const patch: EnvironmentPatch = {
        ...(parameters.variables === undefined ? {} : { variables: parameters.variables as Readonly<Record<string, string>> }),
        ...(parameters.paths === undefined ? {} : { paths: parameters.paths as readonly string[] }),
        ...(parameters.dependencies === undefined ? {} : { dependencies: parameters.dependencies as readonly EnvironmentDependency[] }),
    };
    return patch;
};

/**
 * Overlay an environment patch with CAS.
 *
 * When the caller omits `expectedVersion`, the current revision is used, so
 * every write is guarded by an explicit expected version instead of silently
 * becoming an unconditional overwrite.
 */
const configureEnvironment = (project: Project, parameters: ToolParameters): ProjectEnvironmentResult => {
    const input: ToolParameters = readParameters(parameters, CONFIGURE_ENVIRONMENT_PARAMETERS);
    const expectedVersion: number = readExpectedVersion(input) ?? project.environmentVersion;
    const environment: ProjectEnvironment = project.configureEnvironment(readEnvironmentPatch(input), { expectedVersion });
    return Object.freeze({ environment, version: project.environmentVersion });
};

/**
 * Create or update a rule in the project scope.
 *
 * `expectedVersion` is forwarded verbatim: `Project.putRule` requires the
 * current version for updates and rejects it for new rules. The returned rule is
 * the detached clone `Project` already hands out, frozen as a response value.
 */
const putRule = (project: Project, parameters: ToolParameters): Readonly<ProjectRule> => {
    const input: ToolParameters = readParameters(parameters, PUT_RULE_PARAMETERS);
    const id: unknown = input.id;
    const text: unknown = input.text;
    if (typeof(id) !== "string") {
        throw new TypeError("project rule id must be a string");
    }
    if (typeof(text) !== "string") {
        throw new TypeError("project rule text must be a string");
    }
    const expectedVersion: number | undefined = readExpectedVersion(input);
    const rule: ProjectRule = project.putRule({
        tenantId: project.tenantId,
        rootId: project.rootId,
        id,
        text,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    return Object.freeze(rule);
};

/** Read-only forwarding of the deterministic configuration brief. */
const describeEnvironment = (project: Project, parameters: ToolParameters): string => {
    readParameters(parameters, DESCRIBE_ENVIRONMENT_PARAMETERS);
    return project.describeEnvironment();
};

/**
 * Build the handler map keyed by full gateway tool name.
 *
 * The map is frozen and every handler is synchronous. A host only registers the
 * handlers it intends to offer; the gateway still enforces surface exposure,
 * `project:write` / `project:read` authorization, idempotency keys for the
 * mutating verbs, and one journal record per call.
 */
export function createProjectToolHandlers(project: Project): Record<string, GatewayHandler> {
    const handlers: Record<string, GatewayHandler> = {
        [CONFIGURE_ENVIRONMENT_TOOL]: (parameters) => configureEnvironment(project, parameters),
        [PUT_RULE_TOOL]: (parameters) => putRule(project, parameters),
        [DESCRIBE_ENVIRONMENT_TOOL]: (parameters) => describeEnvironment(project, parameters),
    };
    return Object.freeze(handlers);
}
