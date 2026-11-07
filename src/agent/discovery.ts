import { safeStringify } from "../serialization/index.ts";
import type { AgentBinding, ToolDescriptor } from "./surface.ts";

export interface DiscoveryWeights {
    readonly lexical: number;
    readonly semantic: number;
    readonly signature: number;
    readonly context: number;
}

/** Host scores must be query-specific and normalized. Missing signals are not zero evidence. */
export interface DiscoverySignals {
    readonly semantic?: number;
    readonly signature?: number;
    readonly context?: number;
}

export type DiscoverySource = "host_modules" | "amp" | "session_files" | "session_outlines" | "conversation" | "network";
export type DiscoveryKind = "tool" | "module" | "file" | "content" | "outline" | "message" | "web";
export const DISCOVERY_SOURCES: readonly DiscoverySource[] = Object.freeze(["host_modules", "amp", "session_files", "session_outlines", "conversation", "network"]);
export const DISCOVERY_KINDS: readonly DiscoveryKind[] = Object.freeze(["tool", "module", "file", "content", "outline", "message", "web"]);
export const DEFAULT_DISCOVERY_SOURCES: readonly DiscoverySource[] = Object.freeze(DISCOVERY_SOURCES.filter(source => source !== "network"));
export interface DiscoveryScope {
    readonly tenantId: string;
    readonly principalId: string;
    readonly sessionId: string;
}

export interface DiscoveryCandidate {
    /** Unique within source, including endpoint/version when relevant. */
    readonly id: string;
    readonly source: DiscoverySource;
    readonly kind: DiscoveryKind;
    /** Module name for capabilities; file path for session resources. */
    readonly module: string;
    readonly scope?: DiscoveryScope;
    /** Searchable body is never copied into the model response. */
    readonly searchText?: string;
    readonly name: string;
    readonly summary: string;
    readonly keywords?: readonly string[];
    readonly signals?: DiscoverySignals;
    /** Navigation only; execution must recheck authorization and pinned versions. */
    readonly target: Readonly<Record<string, string>>;
}

export interface DiscoveryOptions {
    readonly query: string;
    /** Defaults to local sources. Network is queried only when explicitly selected. */
    readonly sources?: readonly DiscoverySource[];
    readonly limit?: number;
    readonly maxPerModule?: number;
    readonly minimumScore?: number;
    readonly weights?: Partial<DiscoveryWeights>;
}

export interface DiscoveryLeaf {
    readonly kind: DiscoveryKind;
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly score: number;
    readonly scores: Readonly<Partial<DiscoveryWeights>>;
    readonly weights: Readonly<Partial<DiscoveryWeights>>;
    readonly matchedTerms: readonly string[];
    readonly target: Readonly<Record<string, string>>;
}

export interface DiscoveryBranch {
    readonly kind: "source" | "group";
    readonly name: string;
    /** Best descendant score, not a sum that rewards large catalogs. */
    readonly score: number;
    readonly children: readonly (DiscoveryBranch | DiscoveryLeaf)[];
}

export interface DiscoveryResult {
    readonly query: string;
    readonly tree: { readonly kind: "query"; readonly children: readonly DiscoveryBranch[] };
    readonly considered: number;
    readonly matched: number;
    readonly returned: number;
    readonly sources: readonly DiscoverySource[];
    readonly unavailableSources: readonly DiscoverySource[];
    readonly truncated: boolean;
    readonly authorization: "not_granted";
}

/** Generic host port: registered modules, session files/content or session outlines. No plugin runtime dependency. */
export interface DiscoveryProvider {
    readonly source: Exclude<DiscoverySource, "amp">;
    /** Apply visibility, current-version and read-policy checks before returning any data. */
    search(query: string, binding: AgentBinding): readonly DiscoveryCandidate[] | Promise<readonly DiscoveryCandidate[]>;
}

export interface DiscoveryHost {
    readonly providers?: readonly DiscoveryProvider[];
    readonly signals?: (tool: ToolDescriptor, query: string, binding: AgentBinding) => DiscoverySignals;
    /** Synonyms or localized terms for AMP tools; the surface itself stays English and stable. */
    readonly keywords?: (tool: ToolDescriptor) => readonly string[];
}

export interface DiscoveryCollection {
    readonly candidates: readonly DiscoveryCandidate[];
    /** A source is unavailable when it has no provider or its provider failed for this call. */
    readonly unavailable: readonly DiscoverySource[];
}

/** Scope checks also protect callers whose provider accidentally returns another session's records. */
export const collectDiscoveryCandidates = async (host: DiscoveryHost, options: DiscoveryOptions, binding: AgentBinding): Promise<DiscoveryCollection> => {
    const sources = options.sources ?? DEFAULT_DISCOVERY_SOURCES;
    const providers = (host.providers ?? []).filter(provider => sources.includes(provider.source));
    const results = await Promise.allSettled(providers.map(async provider => {
        if (!DISCOVERY_SOURCES.includes(provider.source) || (provider.source as string) === "amp") { throw new TypeError("invalid discovery provider source"); }
        const candidates = await provider.search(options.query, Object.freeze({ ...binding }));
        return candidates.filter(candidate => {
            if (candidate.source !== provider.source) { throw new TypeError("discovery provider source mismatch"); }
            if (provider.source === "host_modules" || provider.source === "network") { return true; }
            return candidate.scope?.tenantId === binding.tenantId && candidate.scope.principalId === binding.principalId
                && candidate.scope.sessionId === binding.sessionId;
        });
    }));
    const candidates: DiscoveryCandidate[] = [];
    const unavailable = new Set<DiscoverySource>();
    for (const [index, result] of results.entries()) {
        const source = providers[index].source;
        if (result.status === "fulfilled") { candidates.push(...result.value); }
        else { unavailable.add(source); }
    }
    for (const source of sources) { if (source !== "amp" && !providers.some(provider => provider.source === source)) { unavailable.add(source); } }
    return { candidates, unavailable: [...unavailable] };
};

const DefaultWeights: DiscoveryWeights = { lexical: 0.45, semantic: 0.3, signature: 0.1, context: 0.15 };
const Dimensions: readonly (keyof DiscoveryWeights)[] = ["lexical", "semantic", "signature", "context"];
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const unit = (value: number, label: string): number => {
    if (!Number.isFinite(value) || value < 0 || value > 1) { throw new RangeError(`${label} must be between 0 and 1`); }
    return value;
};
const boundedInteger = (value: number, maximum: number, label: string): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) { throw new RangeError(`${label} must be an integer between 0 and ${maximum}`); }
    return value;
};

/** Minimal English plural folding; queries and vocabularies share the same expansion. */
const stem = (term: string): string => {
    if (term.length <= 3) { return term; }
    if (term.endsWith("ies")) { return `${term.slice(0, -3)}y`; }
    if (/(sses|ches|shes|xes|zes)$/.test(term)) { return term.slice(0, -2); }
    return term.endsWith("s") && !/(ss|us|is)$/.test(term) ? term.slice(0, -1) : term;
};

/** Unicode word segmentation supports Chinese text supplied by host keywords/descriptions. */
const WordSegmenter = new Intl.Segmenter("und", { granularity: "word" });
const terms = (text: string): string[] => {
    const expanded: string[] = [];
    for (const part of WordSegmenter.segment(text.normalize("NFKC").toLowerCase().replace(/[_./:-]+/g, " "))) {
        if (!part.isWordLike) { continue; }
        expanded.push(part.segment, stem(part.segment));
    }
    return [...new Set(expanded)];
};

/** Validate untyped model input; scoring signals and candidate scopes are host-only. */
export const parseDiscoveryOptions = (parameters: Readonly<Record<string, unknown>>): DiscoveryOptions => {
    const allowed: readonly string[] = ["query", "sources", "limit", "maxPerModule", "minimumScore", "weights"];
    for (const key of Object.keys(parameters)) {
        if (!allowed.includes(key)) { throw new TypeError(`unknown discovery parameter: ${key}`); }
    }
    if (typeof parameters.query !== "string" || !parameters.query.trim() || parameters.query.length > 4096) {
        throw new TypeError("query must be nonempty and at most 4096 characters");
    }
    if (terms(parameters.query).length === 0) { throw new TypeError("query must contain searchable words"); }
    if (parameters.sources !== undefined && (!Array.isArray(parameters.sources) || parameters.sources.length === 0
        || !parameters.sources.every(source => DISCOVERY_SOURCES.includes(source))
        || new Set(parameters.sources).size !== parameters.sources.length)) { throw new TypeError("sources must be a nonempty list of unique discovery source names"); }
    for (const key of ["limit", "maxPerModule", "minimumScore"] as const) {
        if (parameters[key] !== undefined && typeof parameters[key] !== "number") { throw new TypeError(`${key} must be a number`); }
    }
    if (parameters.weights !== undefined) {
        if (typeof parameters.weights !== "object" || parameters.weights === null || Array.isArray(parameters.weights)) { throw new TypeError("weights must be an object"); }
        for (const [key, value] of Object.entries(parameters.weights)) {
            if (!Dimensions.includes(key as keyof DiscoveryWeights) || typeof value !== "number") { throw new TypeError(`invalid discovery weight: ${key}`); }
            unit(value, key);
        }
    }
    const options = parameters as unknown as DiscoveryOptions;
    boundedInteger(options.limit ?? 6, 50, "limit");
    boundedInteger(options.maxPerModule ?? 3, 50, "maxPerModule");
    unit(options.minimumScore ?? 0.1, "minimumScore");
    const weights = { ...DefaultWeights, ...options.weights };
    if (Dimensions.reduce((sum, key) => sum + weights[key], 0) <= 0) { throw new RangeError("at least one weight must be positive"); }
    return options;
};

/** Pure ranking over a host-authorized snapshot. No reads, execution or authority are implied. */
export const discover = (candidates: readonly DiscoveryCandidate[], input: DiscoveryOptions): DiscoveryResult => {
    const options = parseDiscoveryOptions({ ...input });
    const queryTerms = terms(options.query);
    if (queryTerms.length === 0) { throw new TypeError("query must contain searchable words"); }
    const weights = { ...DefaultWeights, ...options.weights };
    const selectedSources = options.sources ?? DEFAULT_DISCOVERY_SOURCES;
    const scoped = candidates.filter(candidate => selectedSources.includes(candidate.source));
    const seen = new Set<string>();
    const ranked: { candidate: DiscoveryCandidate; leaf: DiscoveryLeaf }[] = [];
    for (const candidate of scoped) {
        for (const field of ["id", "source", "module", "name", "summary"] as const) {
            if (typeof candidate[field] !== "string" || !candidate[field].trim()) { throw new TypeError(`candidate.${field} is required`); }
        }
        if (!DISCOVERY_KINDS.includes(candidate.kind)) { throw new TypeError(`candidate.kind is invalid: ${candidate.kind}`); }
        if (typeof candidate.target !== "object" || candidate.target === null || Array.isArray(candidate.target)
            || !Object.values(candidate.target).every(value => typeof value === "string")) {
            throw new TypeError("candidate.target must map names to string navigation values");
        }
        if (candidate.keywords !== undefined && (!Array.isArray(candidate.keywords)
            || !candidate.keywords.every(keyword => typeof keyword === "string"))) { throw new TypeError("candidate.keywords must be strings"); }
        const key = safeStringify([candidate.source, candidate.id]);
        if (seen.has(key)) { throw new TypeError(`duplicate discovery candidate: ${key}`); }
        seen.add(key);
        // Field boosts keep a query such as "read" attached to workspace.read instead of every description that mentions reading.
        const vocabulary = new Map<string, number>();
        const addTerms = (text: string, weight: number): void => {
            for (const term of terms(text)) { vocabulary.set(term, Math.max(vocabulary.get(term) ?? 0, weight)); }
        };
        addTerms(candidate.name, 1);
        addTerms(candidate.module, 0.8);
        addTerms((candidate.keywords ?? []).join(" "), 0.7);
        addTerms(candidate.summary, 0.4);
        if (candidate.searchText !== undefined) { addTerms(candidate.searchText, 0.3); }
        const matchedTerms = queryTerms.filter(term => vocabulary.has(term));
        const lexical = matchedTerms.reduce((sum, term) => sum + (vocabulary.get(term) ?? 0), 0) / queryTerms.length;
        const scores: { -readonly [K in keyof DiscoveryWeights]?: number } = { lexical };
        for (const dimension of ["semantic", "signature", "context"] as const) {
            const signal = candidate.signals?.[dimension];
            if (signal !== undefined) { scores[dimension] = unit(signal, dimension); }
        }
        const total = Dimensions.reduce((sum, dimension) => sum + weights[dimension], 0);
        const effective: { -readonly [K in keyof DiscoveryWeights]?: number } = {};
        let score = 0;
        for (const dimension of Dimensions) {
            effective[dimension] = weights[dimension] / total;
            score += (scores[dimension] ?? 0) * effective[dimension]!;
        }
        // Context or signature alone must not introduce an unrelated tool.
        if (!(scores.lexical! > 0 || (scores.semantic ?? 0) > 0) || score <= 0 || score < (options.minimumScore ?? 0.1)) { continue; }
        ranked.push({ candidate, leaf: { kind: candidate.kind, id: candidate.id, name: candidate.name, summary: candidate.summary.slice(0, 320),
            score, scores, weights: effective, matchedTerms, target: { ...candidate.target } } });
    }
    ranked.sort((a, b) => b.leaf.score - a.leaf.score || compare(a.candidate.source, b.candidate.source) || compare(a.candidate.id, b.candidate.id));
    const counts = new Map<string, number>();
    const selected: typeof ranked = [];
    for (const item of ranked) {
        if (selected.length >= (options.limit ?? 6)) { break; }
        const key = safeStringify([item.candidate.source, item.candidate.module]);
        if ((counts.get(key) ?? 0) >= (options.maxPerModule ?? 3)) { continue; }
        counts.set(key, (counts.get(key) ?? 0) + 1);
        selected.push(item);
    }
    const sources = new Map<string, Map<string, DiscoveryLeaf[]>>();
    for (const { candidate, leaf } of selected) {
        let modules = sources.get(candidate.source);
        if (!modules) { modules = new Map(); sources.set(candidate.source, modules); }
        const leaves = modules.get(candidate.module) ?? [];
        leaves.push(leaf);
        modules.set(candidate.module, leaves);
    }
    const children: DiscoveryBranch[] = [...sources].map(([source, modules]) => {
        const branches: DiscoveryBranch[] = [...modules].map(([module, leaves]) => ({ kind: "group", name: module, score: leaves[0].score, children: leaves }));
        branches.sort((a, b) => b.score - a.score || compare(a.name, b.name));
        return { kind: "source", name: source, score: branches[0].score, children: branches };
    });
    children.sort((a, b) => b.score - a.score || compare(a.name, b.name));
    return { query: options.query, tree: { kind: "query", children }, considered: scoped.length, matched: ranked.length,
        sources: [...selectedSources], unavailableSources: [], returned: selected.length, truncated: selected.length < ranked.length, authorization: "not_granted" };
};
