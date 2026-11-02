/** Canonical control schemas shared by direct registries and MCP descriptors. */
import { InteractionKinds } from "../interaction/interaction.ts";
import { ScenarioKinds } from "../scenario/scenario.ts";
import { ProtocolIds, ToolIds } from "../naming/index.ts";
import type { ControlDomain, ControlScope } from "../control/types.ts";
import type { WorkspaceErrorCode, WorkspaceToolDefinition } from "./workspace.ts";

export const SessionControlProtocol: string = ProtocolIds.session;
export type SessionControlResponse = {
    protocol: typeof SessionControlProtocol;
    version: 1;
} & ({ ok: true; data: Record<string, unknown>; } | { ok: false; error: { code: WorkspaceErrorCode; message: string; }; });

const Key: Record<string, unknown> = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" };
const Version: Record<string, unknown> = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const Mutations: Record<string, unknown> = { expectedVersion: Version, dryRun: { type: "boolean" } };
const Registry: Record<string, unknown> = { type: "string", enum: ["modules", "skills", "knowledge", "protocols", "environments", "concepts"] };

/** Values contain JSON data only; no host callbacks, credentials or scope controls. */
const DataDefinitions: Record<string, unknown> = {
    data: {
        anyOf: [
            { type: ["null", "boolean", "string", "number"] },
            { type: "array", items: { $ref: "#/$defs/data" }, maxItems: 1000 },
            { type: "object", additionalProperties: { $ref: "#/$defs/data" }, maxProperties: 1000 },
        ],
    },
};
const Value: Record<string, unknown> = { type: "object", additionalProperties: { $ref: "#/$defs/data" }, maxProperties: 1000 };
const branch = (action: string, common: Record<string, unknown>, properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: "object", properties: { action: { const: action }, ...common, ...properties }, required: ["action", ...required], additionalProperties: false,
});

/** Scope is a host choice. Only global tools accept an explicitly authorized workspace target. */
const buildControlInputSchema = (scope: ControlScope, domain: ControlDomain): Record<string, unknown> => {
    const common: Record<string, unknown> = {
        ...(scope === "session" ? {} : { revision: Key }),
        ...(scope === "global" ? { workspaceId: Key } : {}),
    };
    if (domain === "adjust") {
        const registry: Record<string, unknown> = { ...common, registry: Registry };
        return { type: "object", $defs: DataDefinitions, oneOf: [
            branch("list", registry, {}, ["registry"]),
            branch("get", registry, { id: Key }, ["registry", "id"]),
            branch("register", registry, { id: Key, value: Value, ...Mutations }, ["registry", "id", "value"]),
            branch("update", registry, { id: Key, value: Value, ...Mutations }, ["registry", "id", "value"]),
            branch("remove", registry, { id: Key, ...Mutations }, ["registry", "id"]),
            branch("default_get", registry, { key: Key }, ["registry", "key"]),
            branch("default_set", registry, { key: Key, value: { $ref: "#/$defs/data" }, ...Mutations }, ["registry", "key", "value"]),
            branch("default_reset", registry, { key: Key, ...Mutations }, ["registry", "key"]),
            branch("link", registry, { id: Key, targetId: Key, relation: Key, ...Mutations }, ["registry", "id", "targetId", "relation"]),
            branch("unlink", registry, { id: Key, targetId: Key, relation: Key, ...Mutations }, ["registry", "id", "targetId", "relation"]),
        ] };
    }
    const kinds: readonly string[] = domain === "interaction" ? InteractionKinds : ScenarioKinds;
    const field: string = domain === "interaction" ? "mode" : "scenario";
    const setting: Record<string, unknown> = {
        [field]: { type: "string", enum: [...kinds] },
        mix: { type: "object", properties: Object.fromEntries(kinds.map((kind): [string, unknown] => [kind, { type: "number", minimum: 0 }])), minProperties: 1, additionalProperties: false },
    };
    const mutations: Record<string, unknown> = {
        ...Mutations,
        ...(scope === "session" ? {} : { applyTo: { type: "string", enum: ["defaults", "existing", "all"], default: "defaults" } }),
    };
    const set: Record<string, unknown> = branch("set", common, { ...setting, ...mutations });
    set.oneOf = [{ required: [field] }, { required: ["mix"] }];
    return { type: "object", oneOf: [branch("get", common, {}), set, branch("reset", common, mutations)] };
};

/** Each caller owns its schema graph, including nested $defs and constraints. */
export const controlInputSchema = (scope: ControlScope, domain: ControlDomain): Record<string, unknown> => structuredClone(buildControlInputSchema(scope, domain));

const Names: Record<ControlScope, Partial<Record<ControlDomain, string>>> = {
    workspace: { adjust: ToolIds.workspaceAdjust, interaction: ToolIds.workspaceInteraction, scenario: ToolIds.workspaceScenario },
    global: { adjust: ToolIds.globalAdjust, interaction: ToolIds.globalInteraction, scenario: ToolIds.globalScenario },
    session: { interaction: ToolIds.sessionInteraction, scenario: ToolIds.sessionScenario },
};
export const controlToolDefinitions = (scope: ControlScope): WorkspaceToolDefinition[] =>
    (Object.entries(Names[scope]) as Array<[ControlDomain, string]>).map(([domain, name]): WorkspaceToolDefinition => ({
        name, risk: "write", description: `Manage ${scope} ${domain} through the host-authorized control port. Scope and identity are fixed by the host.`, inputSchema: controlInputSchema(scope, domain),
    }));
export const controlToolDomain = (name: string): ControlDomain | undefined => {
    for (const tools of Object.values(Names)) {
        for (const [domain, id] of Object.entries(tools)) {
            if (id === name) return domain as ControlDomain;
        }
    }
    return undefined;
};
