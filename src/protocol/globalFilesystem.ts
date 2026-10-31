/**
 * Global filesystem wire contract.
 *
 * The global surface exposes the same operations as `amp_tool_filesystem_*`
 * under `amp_tool_globalfs_*`. "Global" means the host may route it across every
 * authorized session/root; it does not grant a new root. A bound session is
 * still the authority boundary, so the global adapter is a naming layer, not a
 * second implementation and not an escalation path.
 */
import { ProtocolIds, ServiceIds, ToolIds } from "../naming/index.ts";
import type { FilesystemToolDefinition } from "./filesystem.ts";
import { filesystemToolDefinitions, filesystemToolLeaves } from "./filesystem.ts";
import type { FilesystemToolErrorCode } from "./filesystem.ts";

type GlobalFilesystemProtocolName = "amp_protocol_globalfs";
type GlobalFilesystemServiceName = "amp_service_globalfs";

export const GlobalFilesystemProtocol: GlobalFilesystemProtocolName = ProtocolIds.globalfs as GlobalFilesystemProtocolName;
export const GlobalFilesystemProtocolVersion: 1 = 1;
export const GlobalFilesystemServiceId: GlobalFilesystemServiceName = ServiceIds.globalfs as GlobalFilesystemServiceName;

export type GlobalFilesystemResponse = {
    protocol: typeof GlobalFilesystemProtocol;
    version: typeof GlobalFilesystemProtocolVersion;
    ok: true;
    revision: string;
    session: string;
    data: Record<string, unknown>;
} | {
    protocol: typeof GlobalFilesystemProtocol;
    version: typeof GlobalFilesystemProtocolVersion;
    ok: false;
    revision: string;
    session: string;
    error: { code: FilesystemToolErrorCode; message: string; };
};

const GlobalIdByLeaf: Record<string, string> = {
    session: ToolIds.globalfsSession,
    file: ToolIds.globalfsFile,
    directory: ToolIds.globalfsDirectory,
    read: ToolIds.globalfsRead,
    write: ToolIds.globalfsWrite,
    outline: ToolIds.globalfsOutline,
    import: ToolIds.globalfsImport,
    export: ToolIds.globalfsExport,
    dependency: ToolIds.globalfsDependency,
    ast: ToolIds.globalfsAst,
};

/**
 * Global descriptors are derived from the local descriptors, so a schema change
 * cannot land on one surface and be forgotten on the other.
 */
const LocalDefinitions: readonly FilesystemToolDefinition[] = filesystemToolDefinitions();

export const globalFilesystemToolDefinitions: () => FilesystemToolDefinition[] = (): FilesystemToolDefinition[] =>
    LocalDefinitions.map((tool: FilesystemToolDefinition): FilesystemToolDefinition => {
        const leaf: string | undefined = filesystemToolLeaves.get(tool.name);
        const globalName: string | undefined = leaf === (void 0) ? (void 0) : GlobalIdByLeaf[leaf];
        if (leaf === (void 0) || globalName === (void 0)) {
            throw new Error(`filesystem tool ${tool.name} has no global counterpart`);
        }
        return { ...tool, name: globalName, description: `Global workspace scope: ${tool.description}` };
    });

/**
 * Canonical global id to the local leaf it forwards to.
 */
export const globalFilesystemLeaves: ReadonlyMap<string, string> = new Map<string, string>(
    LocalDefinitions.map((tool: FilesystemToolDefinition): readonly [string, string] => {
        const leaf: string = filesystemToolLeaves.get(tool.name) ?? "";
        const globalName: string = GlobalIdByLeaf[leaf] ?? "";
        return [globalName, leaf];
    }),
);

/**
 * Global id to the local canonical id it forwards to.
 */
export const globalFilesystemLocalIds: ReadonlyMap<string, string> = new Map<string, string>(
    LocalDefinitions.map((tool: FilesystemToolDefinition): readonly [string, string] => {
        const leaf: string = filesystemToolLeaves.get(tool.name) ?? "";
        return [GlobalIdByLeaf[leaf] ?? "", tool.name];
    }),
);

/**
 * Local canonical id for a global id. A caller may want to reuse an existing
 * executor rather than the wrapper, so the mapping is exported.
 */
export const localFilesystemId: (globalId: string) => string | undefined = (globalId: string): string | undefined =>
    globalFilesystemLocalIds.get(globalId);
