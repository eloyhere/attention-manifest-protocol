/**
 * AMP global extension v1.
 *
 * The global surface is the same operation set as `amp.workspace`, but its
 * workspace is the host's complete authorized project set rather than one
 * caller-selected subset. It exists so an agent can discover and navigate
 * across every registered project without a workspace-specific tool name.
 */
import { ProtocolIds, ServiceIds, ToolIds } from "../naming/index.ts";
import { workspaceToolDefinitions, workspaceToolLeaves } from "./workspace.ts";
import type { WorkspaceErrorCode, WorkspaceToolDefinition } from "./workspace.ts";

type GlobalProtocolName = "amp_protocol_global";
type GlobalServiceName = "amp_service_global";

export const GlobalProtocol: GlobalProtocolName = ProtocolIds.global as GlobalProtocolName;
export const GlobalProtocolVersion: 1 = 1;
export const GlobalServiceId: GlobalServiceName = ServiceIds.global as GlobalServiceName;

export type GlobalResponse = {
    protocol: typeof GlobalProtocol;
    version: typeof GlobalProtocolVersion;
    revision: string;
} & ({ ok: true; data: Record<string, unknown>; } | { ok: false; error: { code: WorkspaceErrorCode; message: string; }; });

const GlobalIdByLeaf: Record<string, string> = {
    capabilities: ToolIds.globalCapabilities,
    tree: ToolIds.globalTree,
    query: ToolIds.globalQuery,
    relations: ToolIds.globalRelations,
    materialize: ToolIds.globalMaterialize,
    read: ToolIds.globalRead,
    release: ToolIds.globalRelease,
    discover: ToolIds.globalDiscover,
    write: ToolIds.globalWrite,
    project: ToolIds.globalProject,
    outline: ToolIds.globalOutline,
    dependency: ToolIds.globalDependency,
    reactive_read: ToolIds.globalReactiveRead,
    reactive_write: ToolIds.globalReactiveWrite,
    diff_read: ToolIds.globalDiffRead,
    diff_write: ToolIds.globalDiffWrite,
};

/**
 * Global descriptors are derived from the workspace descriptors so a schema
 * change cannot land on one surface and be forgotten on the other. Only the
 * name and the scope wording differ.
 */
export const globalToolDefinitions: () => WorkspaceToolDefinition[] = (): WorkspaceToolDefinition[] =>
    workspaceToolDefinitions().map((tool: WorkspaceToolDefinition): WorkspaceToolDefinition => {
        const leaf: string | undefined = workspaceToolLeaves.get(tool.name);
        const globalName: string | undefined = leaf === (void 0) ? undefined : GlobalIdByLeaf[leaf];
        if (leaf === (void 0) || globalName === (void 0)) {
            throw new Error(`workspace tool ${tool.name} has no global counterpart`);
        }
        return { ...tool, name: globalName, description: `Global scope: ${tool.description}` };
    });

/**
 * Global id to the workspace leaf it forwards to.
 *
 * Derived from the workspace descriptors, not from the global ones: a global
 * descriptor's name is already the renamed id, so looking it up in the
 * workspace leaf table would always miss. Rebuilding the pair from the
 * workspace side is what keeps `amp_tool_global_*` dispatchable.
 *
 * The local binding stays PascalCase because it is module-level data, matching
 * the alias convention in `workspace.ts`.
 */
const GlobalToolLeaves: ReadonlyMap<string, string> = new Map<string, string>(
    workspaceToolDefinitions().map((tool: WorkspaceToolDefinition): readonly [string, string] => {
        const leaf: string = workspaceToolLeaves.get(tool.name) ?? "";
        return [GlobalIdByLeaf[leaf] ?? "", leaf];
    }),
);

/**
 * Frozen-contract alias for the leaf index.
 */
export { GlobalToolLeaves as globalToolLeaves };
