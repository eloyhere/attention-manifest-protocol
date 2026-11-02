import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { MemoryContentStore } from "../src/context/contentStore.ts";
import type { WorkspaceSnapshot } from "../src/context/workspace.ts";
import { WorkspaceAgentService } from "../src/context/workspaceService.ts";
import type { WorkspaceServiceLimits } from "../src/context/workspaceService.ts";
import type { CatalogRecord } from "../src/database/entity/catalog.ts";
import type { SkillEntry } from "../src/skill/registry.ts";
import type { KnowledgeEntry } from "../src/knowledge/registry.ts";
import type { ProtocolEntry } from "../src/protocol/registry.ts";
import type { EnvironmentEntry } from "../src/environment/catalog.ts";
import { Database } from "../src/database/service/database.ts";
import { HostCatalog } from "../src/discover/host.ts";
import type { HostComponent, HostProject } from "../src/discover/types.ts";
import type { Frame } from "../src/frame/frame.ts";
import { WorkspaceMcpServer } from "../src/module/mcp/workspaceServer.ts";
import type { WorkspaceRpcResponse } from "../src/module/mcp/workspaceServer.ts";
import { workspaceToolDefinitions, WorkspaceServiceId } from "../src/protocol/workspace.ts";
import { CatalogSearch } from "../src/search/catalogSearch.ts";
import { projectSearchRecords } from "../src/search/projection.ts";
import { applyControlRegistry } from "../src/control/search.ts";
import type { ControlPort } from "../src/control/types.ts";
import { digestOf } from "../src/semantic/canonical.ts";

export interface WorkspaceServerBootstrap {
    version: 1;
    agentId: string;
    projectIds: string[];
    snapshot: WorkspaceSnapshot;
    contents: Record<string, string>;
    frames: Frame[];
    limits?: Partial<WorkspaceServiceLimits>;
    discovery?: {
        projects?: HostProject[]; components?: HostComponent[]; skills?: SkillEntry[]; knowledge?: KnowledgeEntry[];
        protocols?: ProtocolEntry[]; environments?: EnvironmentEntry[]; records?: CatalogRecord[];
    };
    /** Host-owned catalog/index. The index must be exclusive to this namespace. */
    search?: { node: string; index: string; namespace: string; databasePath: string; };
    /** Trusted local host configuration; never accepted from tools/call arguments. */
    control?: { databasePath: string; workspaceId?: string; };
}

export const runWorkspaceServer = async (args: string[]): Promise<void> => {
    let database: Database | undefined;
    let search: CatalogSearch | undefined;
    try {
        if (args.length !== 2 || args[0] !== "--config" || statSync(args[1]).size > 64 * 1024 * 1024) throw new Error("invalid bootstrap arguments");
        const configPath = resolve(args[1]);
        const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkspaceServerBootstrap;
        if (config.version !== 1 || !config.contents || !Array.isArray(config.frames)) throw new Error("invalid host bootstrap");
        const store = new MemoryContentStore();
        for (const [ref, content] of Object.entries(config.contents)) {
            if (typeof content !== "string" || store.put(content) !== ref) throw new Error("bootstrap content integrity mismatch");
        }
        if (config.control !== undefined) {
            if (config.control === null || typeof config.control !== "object" || Array.isArray(config.control)
                || Object.keys(config.control).some(key => !["databasePath", "workspaceId"].includes(key))
                || typeof config.control.databasePath !== "string" || !config.control.databasePath.trim()
                || (config.control.workspaceId !== undefined && (typeof config.control.workspaceId !== "string" || !config.control.workspaceId.trim()))) {
                throw new Error("invalid control configuration");
            }
            database = new Database(resolve(dirname(configPath), config.control.databasePath));
        }
        const workspaceId = config.control === undefined ? undefined : config.control.workspaceId ?? database!.controlService.defaultWorkspace().workspaceId;
        const control = workspaceId === undefined ? undefined : database!.controlService.bind({ workspaceId });
        let projectionDigest: string | undefined;
        let baseRecords: CatalogRecord[] = [];
        const refreshRegistrySnapshot = (): void => {
            if (search === undefined || workspaceId === undefined || database === undefined || config.search === undefined) return;
            const records = applyControlRegistry(database.controlService, workspaceId, config.search.namespace, baseRecords, config.snapshot.revision);
            const digest = digestOf(records);
            if (digest !== projectionDigest) { search.replaceSnapshot(records); projectionDigest = digest; }
        };
        const host = new HostCatalog();
        for (const project of config.discovery?.projects ?? []) host.addProject(project);
        for (const component of config.discovery?.components ?? []) host.addComponent(component);
        const registered = new Set(host.components().map((component) => component.id));
        if (!registered.has(WorkspaceServiceId)) host.addComponent({ id: WorkspaceServiceId, kind: "service", name: "amp.workspace", description: "Authorized metadata search, context materialization and bounded detail reads." });
        for (const tool of workspaceToolDefinitions()) {
            if (!registered.has(tool.name)) host.addComponent({ id: tool.name, kind: "tool", name: tool.name, description: tool.description });
        }
        if (config.search !== undefined) {
            const settings = config.search;
            if ([settings.node, settings.index, settings.namespace, settings.databasePath].some((value) => typeof value !== "string" || !value.trim())) throw new Error("invalid search configuration");
            const endpoint = new URL(settings.node);
            if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("invalid search endpoint");
            const searchDatabasePath = resolve(dirname(configPath), settings.databasePath);
            if (config.control !== undefined && searchDatabasePath !== resolve(dirname(configPath), config.control.databasePath)) {
                throw new Error("search and control must share the host database");
            }
            database ??= new Database(searchDatabasePath);
            database.transaction(() => {
                const key = `control_search_workspace:${settings.namespace}`;
                const binding = database!.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
                if (binding !== undefined && binding.value !== workspaceId) throw new Error("search namespace belongs to another workspace");
                if (workspaceId !== undefined) database!.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key, workspaceId);
            });
            search = CatalogSearch.create({ namespace: settings.namespace, catalog: database.catalogService, cache: database.catalogStore,
                elasticsearch: { connection: { node: settings.node }, index: settings.index } });
            baseRecords = projectSearchRecords({ namespace: settings.namespace, revision: config.snapshot.revision,
                workspace: config.snapshot.entities, relations: config.snapshot.relations, projects: host.projects(), host: host.components(),
                skills: config.discovery?.skills, knowledge: config.discovery?.knowledge, protocols: config.discovery?.protocols,
                environments: config.discovery?.environments, records: config.discovery?.records });
            if (control === undefined) search.replaceSnapshot(baseRecords);
            else refreshRegistrySnapshot();
            await search.sync();
        }
        const liveControl: ControlPort | undefined = control === undefined ? undefined : { call(scope, domain, parameters) {
            const result = control.call(scope, domain, parameters);
            if (domain === "adjust" && parameters.dryRun !== true && !["list", "get", "default_get"].includes(String(parameters.action))) refreshRegistrySnapshot();
            return result;
        } };
        const liveSearch = search === undefined ? undefined : control === undefined ? search : { discover: async (...parameters: Parameters<CatalogSearch["discover"]>) => {
            refreshRegistrySnapshot();
            await search!.sync();
            return search!.discover(...parameters);
        } };
        const service = new WorkspaceAgentService({ agentId: config.agentId, snapshot: config.snapshot, projectIds: config.projectIds,
            ...(config.limits === undefined ? {} : { limits: config.limits }), store, host, ...(liveSearch === undefined ? {} : { search: liveSearch }),
            ...(liveControl === undefined ? {} : { control: liveControl }) });
        for (const frame of config.frames) service.registerFrame(frame, config.snapshot.revision);
        const server = new WorkspaceMcpServer(service);
        await serveLines(server);
    } catch (error: unknown) {
        // Configuration and backend errors may contain credentials or connection URLs.
        const message = error instanceof Error && error.message === "bootstrap content integrity mismatch"
            ? error.message
            : "workspace server failed to initialize or process input";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    } finally {
        try { if (search !== undefined) await search.close(); } catch { process.exitCode = 1; }
        database?.close();
    }
};

const serveLines = async (server: WorkspaceMcpServer): Promise<void> => {
    const emit = (response: WorkspaceRpcResponse): void => { process.stdout.write(`${JSON.stringify(response)}\n`); };
    const maxInputBytes = 1024 * 1024;
    let pending = Buffer.alloc(0);
    let dropping = false;
    const consume = async (line: Buffer): Promise<void> => {
        if (!line.toString("utf8").trim()) return;
        let raw: unknown;
        try { raw = JSON.parse(line.toString("utf8")); }
        catch { emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
        try {
            const response = await server.handleAsync(raw);
            if (response !== undefined) emit(response);
        } catch {
            const id = typeof raw === "object" && raw !== null && "id" in raw ? (raw as { id: unknown }).id : null;
            emit({ jsonrpc: "2.0", id: typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)) ? id : null,
                error: { code: -32603, message: "internal error" } });
        }
    };
    // Async iteration applies backpressure and preserves request and error order.
    for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        while (start < buffer.length) {
            const newline = buffer.indexOf(10, start);
            const end = newline < 0 ? buffer.length : newline;
            const part = buffer.subarray(start, end);
            if (!dropping && pending.length + part.length > maxInputBytes) {
                dropping = true;
                pending = Buffer.alloc(0);
                emit({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "request exceeds 1 MiB" } });
            }
            if (!dropping) pending = Buffer.concat([pending, part]);
            if (newline < 0) break;
            if (!dropping) await consume(pending);
            pending = Buffer.alloc(0);
            dropping = false;
            start = newline + 1;
        }
    }
    if (!dropping && pending.length > 0) await consume(pending);
};
