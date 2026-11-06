import { isNumber, isString, Optional, SynchronousCollector, SynchronousOrderedMap, SynchronousOrderedSet, useFrom } from "semantic-typescript";
import type { Manifest } from "../tooling/types.ts";
import type { CandidateStream, RetrievalOptions, RetrievalQuery, RetrievalResult, RetrievalStatus, RetrievedTool, ScoreBreakdown, ToolCandidate } from "./types.ts";

const DEFAULT_WEIGHTS = { lexical: 0.5, semantic: 0.35, signature: 0.15 } as const;
const clamp = (score: number, label: string): number => {
    if (!isNumber(score) || !Number.isFinite(score) || score < 0 || score > 1) throw new RangeError(`${label} must be between 0 and 1`);
    return score;
};
const tokens = (text: string): string[] => text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
const optionalValue = <T>(value: T | Optional<T> | null | undefined): T | undefined => {
    if (value === null || value === undefined) return undefined;
    return value instanceof Optional ? (value.isPresent() ? value.get() : undefined) : value;
};

function lexicalScore(queryTerms: readonly string[], candidate: ToolCandidate): { score: number; matched: string[] } {
    const text = [candidate.toolId, candidate.summary, ...(candidate.when ?? []), ...(candidate.preconditions ?? [])].join(" ");
    const termSet = new SynchronousOrderedSet(useFrom(tokens(text)).distinct().toCollectable().toArray());
    const uniqueTerms = new SynchronousOrderedSet(useFrom(queryTerms).distinct().toCollectable().toArray());
    const matched = uniqueTerms.toArray().filter(term => termSet.contains(term));
    return { score: uniqueTerms.isEmpty() ? 0 : matched.length / Number(uniqueTerms.size()), matched };
}

/** Pure local candidate ranking. Authorization is an input scope, never inferred from scores or manifest contents. */
export function retrieve(stream: CandidateStream, options: RetrievalOptions): RetrievalResult {
    if (!isString(options.tenantId) || !options.tenantId || !isString(options.query) || !options.query.trim()) throw new TypeError("tenantId and query are required");
    const limit = options.limit ?? 10;
    const minimumScore = options.minimumScore ?? 0.35;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("limit must be a nonnegative safe integer");
    clamp(minimumScore, "minimumScore");
    const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    for (const [key, weight] of Object.entries(weights)) clamp(weight, `${key} weight`);
    const weightTotal = weights.lexical + weights.semantic + weights.signature;
    if (weightTotal <= 0) throw new RangeError("at least one score weight must be positive");

    const manifestIndex = new SynchronousOrderedMap<string, Manifest>();
    const manifests = useFrom(stream.manifests).toCollectable().toArray();
    for (const manifest of manifests) if (manifest.tenantId === options.tenantId) manifestIndex.put(manifest.manifestId, manifest);

    const authorizedToolIds = new SynchronousOrderedSet(options.authorizedToolIds);
    const candidates: ToolCandidate[] = [];
    for (const manifest of manifests) {
        if (manifest.tenantId !== options.tenantId || manifestIndex.get(manifest.manifestId).isEmpty()) continue;
        for (const tool of manifest.tools) {
            if (!authorizedToolIds.contains(tool.toolId)) continue;
            const status = optionalValue(stream.statusByToolId.get(tool.toolId)) ?? "disabled";
            const semanticScore = optionalValue(stream.semanticScores?.get(tool.toolId));
            const signature = optionalValue(stream.signatureCompatibility?.get(tool.toolId));
            candidates.push({ ...tool, endpointId: manifest.endpointId, tenantId: manifest.tenantId, manifestId: manifest.manifestId, status,
                ...(semanticScore === undefined ? {} : { semanticScore: clamp(semanticScore, "semanticScore") }),
                ...(signature === undefined ? {} : { signatureCompatibility: clamp(signature, "signatureCompatibility") }) });
        }
    }
    const queryTerms = tokens(options.query);
    const ranked: RetrievedTool[] = useFrom(candidates).toCollectable().collect(SynchronousCollector.full<ToolCandidate, RetrievedTool[], RetrievedTool[]>(
        () => [],
        (items, candidate) => {
            const lexical = lexicalScore(queryTerms, candidate);
            const semantic = candidate.semanticScore ?? 0;
            const signature = candidate.signatureCompatibility ?? 0;
            const scores: ScoreBreakdown = { lexical: lexical.score, semantic, signature,
                weighted: (lexical.score * weights.lexical + semantic * weights.semantic + signature * weights.signature) / weightTotal };
            if (scores.weighted < minimumScore) return items;
            items.push({ manifestId: candidate.manifestId, tool: candidate, score: scores.weighted,
                reason: { matchedTerms: lexical.matched, scores, status: candidate.status } });
            return items;
        }, items => items.sort((a, b) => b.score - a.score || a.tool.toolId.localeCompare(b.tool.toolId))));
    return { tools: ranked.slice(0, limit), considered: candidates.length };
}

/** Optional-query adapter: empty Optional/null/undefined values are rejected as missing input. */
export function retrieveOptional(stream: CandidateStream, query: RetrievalQuery): RetrievalResult {
    const tenantId = optionalValue(query.tenantId);
    const authorizedToolIds = optionalValue(query.authorizedToolIds);
    const text = optionalValue(query.query);
    if (tenantId === undefined || authorizedToolIds === undefined || text === undefined) throw new TypeError("tenantId, authorizedToolIds and query are required");
    const limit = optionalValue(query.limit);
    const minimumScore = optionalValue(query.minimumScore);
    const weights = optionalValue(query.weights);
    return retrieve(stream, { tenantId, authorizedToolIds, query: text, ...(limit === undefined ? {} : { limit }), ...(minimumScore === undefined ? {} : { minimumScore }), ...(weights === undefined ? {} : { weights }) });
}

export function retrievalStatus(status: RetrievalStatus): RetrievalStatus { return status; }
