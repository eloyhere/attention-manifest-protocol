import { safeStringify } from "../serialization/index.ts";
import type { AgentBinding } from "./surface.ts";
import type { DiscoveryCandidate, DiscoveryProvider, DiscoveryScope, DiscoverySignals } from "./discovery.ts";

export interface RegisteredDiscoveryModule {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly keywords?: readonly string[];
    readonly signals?: DiscoverySignals;
    readonly tools?: readonly {
        readonly id: string;
        readonly name: string;
        readonly summary: string;
        readonly keywords?: readonly string[];
        readonly signals?: DiscoverySignals;
    }[];
}

export interface SessionDiscoveryFile {
    readonly scope: DiscoveryScope;
    readonly id: string;
    readonly path: string;
    /** A hash or revision binding every content location to this snapshot. */
    readonly version: string;
    readonly summary?: string;
    /** Omit for binary files; their names remain searchable. */
    readonly content?: string;
}

export interface SessionDiscoveryMessage {
    readonly scope: DiscoveryScope;
    readonly id: string;
    readonly turnId: string;
    readonly role: string;
    readonly content: string;
}

export interface DiscoveryWebResult {
    readonly url: string;
    readonly title: string;
    readonly snippet: string;
    readonly signals?: DiscoverySignals;
}

export interface SessionDiscoveryOutline {
    readonly scope: DiscoveryScope;
    readonly id: string;
    readonly path: string;
    readonly version: string;
    readonly nodes: readonly {
        readonly id: string;
        readonly name: string;
        readonly summary: string;
        readonly parentId?: string;
        readonly startLine?: number;
        readonly endLine?: number;
    }[];
}

/** Readers must return only authorized records. They may wrap any registry, storage or index. */
export type DiscoverySnapshotReader<T> = (binding: AgentBinding) => readonly T[] | Promise<readonly T[]>;

const SummaryLength = 320;
const SearchLength = 4096;
const clip = (text: string, length: number): string => text.length > length ? text.slice(0, length) : text;

/** Caller supplies the authorized conversation projection, including any desired role filtering. */
export const createConversationDiscoveryProvider = (read: DiscoverySnapshotReader<SessionDiscoveryMessage>): DiscoveryProvider => ({
    source: "conversation",
    async search(_query, binding) {
        const candidates: DiscoveryCandidate[] = [];
        for (const message of await read(binding)) {
            if (!inScope(message.scope, binding)) { continue; }
            candidates.push({ id: message.id, source: "conversation", kind: "message", module: message.turnId, scope: message.scope,
                name: `${message.role}:${message.id}`, summary: clip(message.content, SummaryLength) || message.role,
                searchText: clip(message.content, SearchLength),
                target: { kind: "message", messageId: message.id, turnId: message.turnId, role: message.role } });
        }
        return candidates;
    },
});

/** Network access belongs to the host. This adapter never fetches a URL itself. */
export const createNetworkDiscoveryProvider = (search: (query: string, binding: AgentBinding) => readonly DiscoveryWebResult[] | Promise<readonly DiscoveryWebResult[]>): DiscoveryProvider => ({
    source: "network",
    async search(query, binding) {
        const unique = new Map<string, DiscoveryWebResult>();
        for (const result of await search(query, binding)) {
            if (!unique.has(result.url)) { unique.set(result.url, result); }
        }
        return [...unique.values()].map(result => {
            const url = new URL(result.url);
            if (url.protocol !== "https:" && url.protocol !== "http:") { throw new TypeError("network results require HTTP(S) URLs"); }
            return { id: result.url, source: "network", kind: "web", module: url.hostname,
                name: clip(result.title, SummaryLength) || clip(result.url, SummaryLength),
                summary: clip(result.snippet, SummaryLength) || clip(result.title, SummaryLength) || clip(result.url, SummaryLength),
                signals: result.signals, target: { kind: "web", url: result.url } };
        });
    },
});

const inScope = (scope: DiscoveryScope, binding: AgentBinding): boolean => scope.tenantId === binding.tenantId
    && scope.principalId === binding.principalId && scope.sessionId === binding.sessionId;

/** Covers all modules returned by the host registry, whether or not implemented as plugins. */
export const createHostModuleDiscoveryProvider = (read: DiscoverySnapshotReader<RegisteredDiscoveryModule>): DiscoveryProvider => ({
    source: "host_modules",
    async search(_query, binding) {
        const candidates: DiscoveryCandidate[] = [];
        for (const module of await read(binding)) {
            candidates.push({ id: safeStringify([module.id]), source: "host_modules", kind: "module", module: module.id,
                name: module.name, summary: module.summary, keywords: module.keywords, signals: module.signals,
                target: { kind: "host_module", moduleId: module.id } });
            for (const tool of module.tools ?? []) {
                candidates.push({ id: safeStringify([module.id, tool.id]), source: "host_modules", kind: "tool", module: module.id,
                    name: tool.name, summary: tool.summary, keywords: [...(module.keywords ?? []), ...(tool.keywords ?? [])], signals: tool.signals,
                    target: { kind: "host_tool", moduleId: module.id, toolId: tool.id } });
            }
        }
        return candidates;
    },
});

/** Searches current-session snapshots only; never walks a filesystem or opens a path. */
export const createSessionFileDiscoveryProvider = (read: DiscoverySnapshotReader<SessionDiscoveryFile>): DiscoveryProvider => ({
    source: "session_files",
    async search(_query, binding) {
        const candidates: DiscoveryCandidate[] = [];
        for (const file of await read(binding)) {
            if (!inScope(file.scope, binding)) { continue; }
            const target = { fileId: file.id, path: file.path, version: file.version };
            candidates.push({ id: safeStringify([file.id, file.version]), source: "session_files", kind: "file", module: file.path,
                scope: file.scope, name: file.path, summary: file.summary || file.path, target: { kind: "file", ...target } });
            if (file.content === undefined) { continue; }
            const lines = file.content.split(/\r\n|\n|\r/);
            // Line candidates keep exact locations and do not copy whole files into the tree.
            for (const [index, line] of lines.entries()) {
                if (!line.trim()) { continue; }
                candidates.push({ id: safeStringify([file.id, file.version, index]), source: "session_files", kind: "content", module: file.path,
                    scope: file.scope, name: `${file.path}:${index + 1}`, summary: clip(line, SummaryLength), searchText: clip(line, SearchLength),
                    target: { kind: "content", ...target, startLine: String(index + 1), endLine: String(index + 1) } });
            }
        }
        return candidates;
    },
});

/** Adapt file, document or other session outlines as flat nodes with parent references. Lines are 1-based. */
export const createSessionOutlineDiscoveryProvider = (read: DiscoverySnapshotReader<SessionDiscoveryOutline>): DiscoveryProvider => ({
    source: "session_outlines",
    async search(_query, binding) {
        const candidates: DiscoveryCandidate[] = [];
        for (const outline of await read(binding)) {
            if (!inScope(outline.scope, binding)) { continue; }
            for (const node of outline.nodes) {
                candidates.push({ id: safeStringify([outline.id, outline.version, node.id]), source: "session_outlines", kind: "outline", module: outline.path,
                    scope: outline.scope, name: node.name, summary: node.summary || node.name,
                    target: { kind: "outline", outlineId: outline.id, nodeId: node.id, path: outline.path, version: outline.version,
                        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
                        ...(node.startLine === undefined ? {} : { startLine: String(node.startLine) }),
                        ...(node.endLine === undefined ? {} : { endLine: String(node.endLine) }) } });
            }
        }
        return candidates;
    },
});
