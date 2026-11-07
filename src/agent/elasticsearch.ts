import type { Client, estypes } from "@elastic/elasticsearch";
import { DISCOVERY_KINDS, DISCOVERY_SOURCES } from "./discovery.ts";
import type { AgentBinding } from "./surface.ts";
import type { DiscoveryCandidate, DiscoveryKind, DiscoveryProvider, DiscoverySignals, DiscoverySource } from "./discovery.ts";

/** Index documents under the same names as this interface; the adapter does not infer host schemas. */
export interface ElasticsearchDiscoveryDocument {
    readonly id: string;
    readonly source: DiscoverySource;
    readonly kind: DiscoveryKind;
    readonly module: string;
    readonly name: string;
    readonly summary: string;
    readonly keywords?: readonly string[];
    readonly searchText?: string;
    readonly target: Readonly<Record<string, string>>;
    /** Required for tenant and session scope. */
    readonly tenantId?: string;
    readonly principalId?: string;
    readonly sessionId?: string;
    readonly semantic?: number;
    readonly signature?: number;
    readonly context?: number;
}

export type ElasticsearchDiscoveryScope = "session" | "tenant" | "global";
export interface ElasticsearchDiscoveryFields {
    readonly name?: string;
    readonly keywords?: string;
    readonly module?: string;
    readonly summary?: string;
    readonly searchText?: string;
}

export interface ElasticsearchDiscoveryOptions {
    readonly client: Client;
    readonly index: string;
    /** One index per source keeps authorization filters simple; `amp` is gateway-owned. */
    readonly source: Exclude<DiscoverySource, "amp">;
    /** Defaults: session resources use `session`, host modules `tenant`, network `global`. */
    readonly scope?: ElasticsearchDiscoveryScope;
    /** Hits fetched before local weighted re-ranking. Defaults to 50, capped at 100. */
    readonly size?: number;
    readonly fields?: ElasticsearchDiscoveryFields;
    /** Optionally fold the BM25 `_score` into one normalized signal. Defaults to `none`. */
    readonly scoreSignal?: "semantic" | "context" | "none";
}

const DefaultFields: Required<ElasticsearchDiscoveryFields> = {
    name: "name", keywords: "keywords", module: "module", summary: "summary", searchText: "searchText",
};
const DefaultSize = 50;
const MaximumSize = 100;

const defaultScope = (source: Exclude<DiscoverySource, "amp">): ElasticsearchDiscoveryScope => {
    if (source === "host_modules") { return "tenant"; }
    return source === "network" ? "global" : "session";
};

const asRecord = (value: unknown): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new TypeError("Elasticsearch discovery document must be an object"); }
    return value as Record<string, unknown>;
};

const stringField = (document: Record<string, unknown>, field: string): string => {
    const value = document[field];
    if (typeof value !== "string" || !value.trim()) { throw new TypeError(`Elasticsearch discovery document.${field} is required`); }
    return value;
};

const targetOf = (value: unknown): Readonly<Record<string, string>> => {
    const target = asRecord(value);
    for (const [key, item] of Object.entries(target)) {
        if (typeof item !== "string") { throw new TypeError(`Elasticsearch discovery target.${key} must be a string`); }
    }
    return target as Record<string, string>;
};

const signalOf = (value: unknown, field: string): number | undefined => {
    if (value === undefined) { return undefined; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new RangeError(`Elasticsearch discovery document.${field} must be between 0 and 1`);
    }
    return value;
};

const documentOf = (value: unknown, source: Exclude<DiscoverySource, "amp">, binding: AgentBinding,
    scope: ElasticsearchDiscoveryScope): DiscoveryCandidate => {
    const document = asRecord(value);
    if (document.source !== source) { throw new TypeError("Elasticsearch discovery document.source does not match the provider"); }
    if (typeof document.kind !== "string" || !DISCOVERY_KINDS.includes(document.kind as DiscoveryKind)) {
        throw new TypeError("Elasticsearch discovery document.kind is invalid");
    }
    if (scope !== "global" && document.tenantId !== binding.tenantId) { throw new TypeError("Elasticsearch discovery tenant mismatch"); }
    if (scope === "session" && (document.principalId !== binding.principalId || document.sessionId !== binding.sessionId)) {
        throw new TypeError("Elasticsearch discovery session mismatch");
    }
    const keywords = document.keywords;
    if (keywords !== undefined && (!Array.isArray(keywords) || !keywords.every(keyword => typeof keyword === "string"))) {
        throw new TypeError("Elasticsearch discovery document.keywords must be strings");
    }
    if (document.searchText !== undefined && typeof document.searchText !== "string") {
        throw new TypeError("Elasticsearch discovery document.searchText must be a string");
    }
    const signals: { semantic?: number; signature?: number; context?: number } = {};
    const semantic = signalOf(document.semantic, "semantic");
    const signature = signalOf(document.signature, "signature");
    const context = signalOf(document.context, "context");
    if (semantic !== undefined) { signals.semantic = semantic; }
    if (signature !== undefined) { signals.signature = signature; }
    if (context !== undefined) { signals.context = context; }
    return {
        id: stringField(document, "id"), source, kind: document.kind as DiscoveryKind, module: stringField(document, "module"),
        name: stringField(document, "name"), summary: stringField(document, "summary"),
        ...(keywords === undefined ? {} : { keywords: keywords as string[] }),
        ...(typeof document.searchText === "string" ? { searchText: document.searchText } : {}),
        ...(scope === "global" ? {} : { scope: { tenantId: binding.tenantId, principalId: binding.principalId, sessionId: binding.sessionId } }),
        ...(Object.keys(signals).length === 0 ? {} : { signals: signals as DiscoverySignals }),
        target: targetOf(document.target),
    };
};

/**
 * Elasticsearch is a retrieval adapter, not an authority. The host owns the index, its mapping and the
 * write path; this provider adds scope filters and returns candidates for the same local weighted ranking.
 */
export const createElasticsearchDiscoveryProvider = (options: ElasticsearchDiscoveryOptions): DiscoveryProvider => {
    if (typeof options.client?.search !== "function") { throw new TypeError("Elasticsearch discovery requires a search client"); }
    if (!DISCOVERY_SOURCES.includes(options.source)) { throw new TypeError(`invalid Elasticsearch discovery source: ${options.source}`); }
    if ((options.source as string) === "amp") { throw new TypeError("Elasticsearch discovery cannot own the amp source"); }
    if (typeof options.index !== "string" || !options.index.trim()) { throw new TypeError("Elasticsearch discovery index is required"); }
    const size = options.size ?? DefaultSize;
    if (!Number.isSafeInteger(size) || size < 1 || size > MaximumSize) { throw new RangeError(`Elasticsearch discovery size must be between 1 and ${MaximumSize}`); }
    const scope = options.scope ?? defaultScope(options.source);
    if (!["session", "tenant", "global"].includes(scope)) { throw new TypeError("invalid Elasticsearch discovery scope"); }
    const scoreSignal = options.scoreSignal ?? "none";
    if (!["semantic", "context", "none"].includes(scoreSignal)) { throw new TypeError("invalid Elasticsearch discovery scoreSignal"); }
    const fields = { ...DefaultFields, ...options.fields };
    for (const [key, field] of Object.entries(fields)) {
        if (typeof field !== "string" || !field.trim()) { throw new TypeError(`Elasticsearch discovery field ${key} must be a nonempty string`); }
    }
    const searchFields = [`${fields.name}^4`, `${fields.keywords}^3`, `${fields.module}^2`, fields.summary, fields.searchText];
    return {
        source: options.source,
        async search(query, binding) {
            const filters: estypes.QueryDslQueryContainer[] = [{ term: { source: options.source } }];
            if (scope !== "global") { filters.push({ term: { tenantId: binding.tenantId } }); }
            if (scope === "session") {
                filters.push({ term: { principalId: binding.principalId } }, { term: { sessionId: binding.sessionId } });
            }
            const body: estypes.QueryDslQueryContainer = { bool: { filter: filters, must: [{
                multi_match: { query, fields: searchFields, type: "best_fields", operator: "or" },
            }] } };
            const response = await options.client.search<ElasticsearchDiscoveryDocument>({
                index: options.index, query: body, size, _source: true, track_total_hits: false,
            });
            const candidates: DiscoveryCandidate[] = [];
            for (const hit of response.hits.hits) {
                let candidate = documentOf(hit._source, options.source, binding, scope);
                if (scoreSignal !== "none" && typeof hit._score === "number" && hit._score >= 0) {
                    const normalized = hit._score / (hit._score + 1);
                    const existing = candidate.signals?.[scoreSignal] ?? 0;
                    candidate = { ...candidate, signals: { ...candidate.signals, [scoreSignal]: Math.max(existing, normalized) } };
                }
                candidates.push(candidate);
            }
            return candidates;
        },
    };
};
