import type { Identifier } from "../shared.ts";
import { FUSION_EVIDENCE_LEVELS, FUSION_SOURCE_TYPES } from "./types.ts";
import type {
    DimensionFusion,
    DimensionInsufficientReason,
    EvidenceSummary,
    FusedDimension,
    FusedResult,
    FusionContribution,
    FusionIgnoredReason,
    FusionPolicy,
    FusionResult,
    IgnoredEvidence,
    InsufficientDimension,
    InsufficientFusionResult,
} from "./types.ts";
import { DEFAULT_FUSION_POLICY } from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const clone = <T>(value: T): T => structuredClone(value);

export type FusionErrorCode = "invalid_policy" | "invalid_summary" | "duplicate_evidence" | "mixed_levels";

export class FusionError extends Error {
    readonly code: FusionErrorCode;

    constructor(code: FusionErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "FusionError";
        this.code = code;
    }
}

const fail = (code: FusionErrorCode, message: string): never => {
    throw new FusionError(code, message);
};

function requireText(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) return fail("invalid_summary", `${field} must be a nonempty string`);
    return value;
}

function requireUnit(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        return fail("invalid_summary", `${field} must be a finite number between 0 and 1`);
    }
    return value;
}

function readSummary(value: unknown, index: number): EvidenceSummary {
    if (!isRecord(value)) return fail("invalid_summary", `Summary at index ${index} must be an object`);
    const evidenceId = requireText(value.evidenceId, `Summary at index ${index} evidenceId`);
    const dimension = requireText(value.dimension, `Summary ${evidenceId} dimension`);
    const independenceKey = requireText(value.independenceKey, `Summary ${evidenceId} independenceKey`);
    let level: EvidenceSummary["level"];
    if (value.level !== undefined) {
        if (!(FUSION_EVIDENCE_LEVELS as readonly string[]).includes(value.level as string)) {
            return fail("invalid_summary", `Summary ${evidenceId} has an invalid evidence level`);
        }
        level = value.level as EvidenceSummary["level"];
    }
    let sourceType: EvidenceSummary["sourceType"];
    if (value.sourceType !== undefined) {
        if (!(FUSION_SOURCE_TYPES as readonly string[]).includes(value.sourceType as string)) {
            return fail("invalid_summary", `Summary ${evidenceId} has an invalid source type`);
        }
        sourceType = value.sourceType as EvidenceSummary["sourceType"];
    }
    let agentId: Identifier | undefined;
    if (value.agentId !== undefined) agentId = requireText(value.agentId, `Summary ${evidenceId} agentId`);
    if (value.origin !== undefined && value.origin !== "original" && value.origin !== "secondary") {
        return fail("invalid_summary", `Summary ${evidenceId} origin must be original or secondary`);
    }
    if (value.polarity !== undefined && value.polarity !== "supports" && value.polarity !== "refutes") {
        return fail("invalid_summary", `Summary ${evidenceId} polarity must be supports or refutes`);
    }
    return Object.freeze({
        evidenceId,
        dimension,
        ...(level === undefined ? {} : { level }),
        ...(sourceType === undefined ? {} : { sourceType }),
        score: requireUnit(value.score, `Summary ${evidenceId} score`),
        confidence: requireUnit(value.confidence, `Summary ${evidenceId} confidence`),
        reliability: requireUnit(value.reliability, `Summary ${evidenceId} reliability`),
        ...(agentId === undefined ? {} : { agentId }),
        independenceKey,
        ...(value.origin === undefined ? {} : { origin: value.origin as "original" | "secondary" }),
        ...(value.freshness === undefined ? {} : { freshness: requireUnit(value.freshness, `Summary ${evidenceId} freshness`) }),
        ...(value.polarity === undefined ? {} : { polarity: value.polarity as "supports" | "refutes" }),
    });
}

function readPolicy(options: Partial<FusionPolicy> | undefined): FusionPolicy {
    if (options !== undefined && !isRecord(options)) return fail("invalid_policy", "Fusion policy must be an object");
    const source = options ?? {};
    const minimumIndependentSources = source.minimumIndependentSources ?? DEFAULT_FUSION_POLICY.minimumIndependentSources;
    if (!Number.isSafeInteger(minimumIndependentSources) || minimumIndependentSources < 1) {
        return fail("invalid_policy", "minimumIndependentSources must be a positive safe integer");
    }
    const minimumEffectiveSamples = source.minimumEffectiveSamples ?? DEFAULT_FUSION_POLICY.minimumEffectiveSamples;
    if (typeof minimumEffectiveSamples !== "number" || !Number.isFinite(minimumEffectiveSamples) || minimumEffectiveSamples <= 0) {
        return fail("invalid_policy", "minimumEffectiveSamples must be a finite positive number");
    }
    const defaultAgentWeight = source.defaultAgentWeight ?? DEFAULT_FUSION_POLICY.defaultAgentWeight;
    if (typeof defaultAgentWeight !== "number" || !Number.isFinite(defaultAgentWeight) || defaultAgentWeight < 0 || defaultAgentWeight > 1) {
        return fail("invalid_policy", "defaultAgentWeight must be a finite number between 0 and 1");
    }
    const secondaryDiscount = source.secondaryDiscount ?? DEFAULT_FUSION_POLICY.secondaryDiscount;
    if (typeof secondaryDiscount !== "number" || !Number.isFinite(secondaryDiscount) || secondaryDiscount < 0 || secondaryDiscount > 1) {
        return fail("invalid_policy", "secondaryDiscount must be a finite number between 0 and 1");
    }
    const weightsSource = source.agentWeights ?? {};
    if (!isRecord(weightsSource)) return fail("invalid_policy", "agentWeights must be an object");
    const agentWeights: Record<Identifier, number> = {};
    for (const [agentId, weight] of Object.entries(weightsSource)) {
        if (agentId.trim().length === 0) return fail("invalid_policy", "agentWeights keys must be nonempty agent identifiers");
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) {
            return fail("invalid_policy", `agentWeights.${agentId} must be a finite number between 0 and 1`);
        }
        agentWeights[agentId] = weight;
    }
    return Object.freeze({
        minimumIndependentSources,
        minimumEffectiveSamples,
        agentWeights: Object.freeze(agentWeights),
        defaultAgentWeight,
        secondaryDiscount,
    });
}

interface WeightedEntry {
    readonly summary: EvidenceSummary;
    readonly weight: number;
    readonly effectiveScore: number;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function agentWeightFor(summary: EvidenceSummary, policy: FusionPolicy): number {
    return summary.agentId === undefined
        ? policy.defaultAgentWeight
        : policy.agentWeights[summary.agentId] ?? policy.defaultAgentWeight;
}

function effectiveWeight(summary: EvidenceSummary, policy: FusionPolicy): number {
    const secondary = summary.origin === "secondary" ? policy.secondaryDiscount : 1;
    const freshness = summary.freshness ?? 1;
    return summary.reliability * agentWeightFor(summary, policy) * secondary * freshness * summary.confidence;
}

function effectiveScoreFor(summary: EvidenceSummary): number {
    return summary.polarity === "refutes" ? 1 - summary.score : summary.score;
}

function dimensionLevel(dimension: string, summaries: readonly EvidenceSummary[]): EvidenceSummary["level"] {
    const levelKeys = new Set<string>();
    for (const summary of summaries) levelKeys.add(summary.level ?? "<unspecified>");
    if (levelKeys.size > 1) {
        return fail("mixed_levels", `Dimension ${dimension} mixes evidence levels: ${[...levelKeys].join(", ")}`);
    }
    return summaries[0]?.level;
}

function insufficientDimension(
    dimension: string,
    level: EvidenceSummary["level"],
    entries: readonly WeightedEntry[],
    independentSources: number,
    effectiveSamples: number,
    ignored: readonly IgnoredEvidence[],
    reason: DimensionInsufficientReason,
): InsufficientDimension {
    return Object.freeze({
        status: "insufficient" as const,
        dimension,
        ...(level === undefined ? {} : { level }),
        sampleCount: entries.length,
        independentSources,
        effectiveSamples,
        reason,
        ignored: Object.freeze([...ignored].sort((left, right) => compareText(left.evidenceId, right.evidenceId))),
    });
}

function aggregateDimension(
    dimension: string,
    summaries: readonly EvidenceSummary[],
    policy: FusionPolicy,
): DimensionFusion {
    const level = dimensionLevel(dimension, summaries);
    const weighted: WeightedEntry[] = [];
    const ignored: IgnoredEvidence[] = [];
    for (const summary of summaries) {
        const weight = effectiveWeight(summary, policy);
        if (weight <= 0) {
            ignored.push(Object.freeze({ evidenceId: summary.evidenceId, reason: "zero_weight" as FusionIgnoredReason }));
            continue;
        }
        weighted.push(Object.freeze({ summary, weight, effectiveScore: effectiveScoreFor(summary) }));
    }
    weighted.sort((left, right) => compareText(left.summary.evidenceId, right.summary.evidenceId));
    const byIndependence = new Map<string, WeightedEntry>();
    const dedupeOrder = [...weighted].sort((left, right) => right.weight - left.weight || compareText(left.summary.evidenceId, right.summary.evidenceId));
    for (const entry of dedupeOrder) {
        if (byIndependence.has(entry.summary.independenceKey)) {
            ignored.push(Object.freeze({
                evidenceId: entry.summary.evidenceId,
                reason: "duplicate_independence" as FusionIgnoredReason,
            }));
            continue;
        }
        byIndependence.set(entry.summary.independenceKey, entry);
    }
    const kept = [...byIndependence.values()].sort((left, right) => compareText(left.summary.evidenceId, right.summary.evidenceId));
    const weightMass = kept.reduce((sum, entry) => sum + entry.weight, 0);
    const squaredMass = kept.reduce((sum, entry) => sum + entry.weight * entry.weight, 0);
    const effectiveSamples = squaredMass === 0 ? 0 : (weightMass * weightMass) / squaredMass;
    if (kept.length === 0) {
        return insufficientDimension(dimension, level, weighted, 0, 0, ignored, "zero_weight");
    }
    if (kept.length < policy.minimumIndependentSources || effectiveSamples < policy.minimumEffectiveSamples) {
        return insufficientDimension(dimension, level, weighted, kept.length, effectiveSamples, ignored, "insufficient_samples");
    }
    const score = kept.reduce((sum, entry) => sum + entry.weight * entry.effectiveScore, 0) / weightMass;
    const weightedConfidence = kept.reduce((sum, entry) => sum + entry.weight * entry.summary.confidence, 0) / weightMass;
    const confidence = Math.max(0, Math.min(1, weightedConfidence * (kept.length / weighted.length)));
    const contributions: FusionContribution[] = kept.map(entry => Object.freeze({
        evidenceId: entry.summary.evidenceId,
        ...(entry.summary.agentId === undefined ? {} : { agentId: entry.summary.agentId }),
        independenceKey: entry.summary.independenceKey,
        weight: entry.weight,
        effectiveScore: entry.effectiveScore,
        confidence: entry.summary.confidence,
    }));
    const fused: FusedDimension = Object.freeze({
        status: "fused" as const,
        dimension,
        ...(level === undefined ? {} : { level }),
        score: Math.max(0, Math.min(1, score)),
        confidence,
        sampleCount: weighted.length,
        independentSources: kept.length,
        effectiveSamples,
        weightMass,
        contributions: Object.freeze(contributions),
        ignored: Object.freeze([...ignored].sort((left, right) => compareText(left.evidenceId, right.evidenceId))),
    });
    return fused;
}

/**
 * L7 fusion layer (refract §11.13). It aggregates evidence summaries per
 * dimension with independence de-duplication and cross-agent weighting. It is
 * deliberately conservative: any dimension without enough independent evidence
 * makes the whole result `insufficient`, and no Bayesian posterior is fabricated.
 */
export class FusionLayer {
    readonly policy: FusionPolicy;

    constructor(options: Partial<FusionPolicy> = {}) {
        this.policy = readPolicy(options);
    }

    fuse(summaries: readonly EvidenceSummary[]): FusionResult {
        if (!Array.isArray(summaries)) return fail("invalid_summary", "Fusion input must be an array of evidence summaries");
        const normalized = summaries.map((summary, index) => readSummary(summary, index));
        const evidenceIds = new Set<Identifier>();
        for (const summary of normalized) {
            if (evidenceIds.has(summary.evidenceId)) return fail("duplicate_evidence", `Duplicate evidence summary: ${summary.evidenceId}`);
            evidenceIds.add(summary.evidenceId);
        }
        const groups = new Map<string, EvidenceSummary[]>();
        for (const summary of normalized) {
            const group = groups.get(summary.dimension);
            if (group === undefined) groups.set(summary.dimension, [summary]);
            else group.push(summary);
        }
        const dimensions = [...groups.keys()]
            .sort(compareText)
            .map(dimension => aggregateDimension(dimension, groups.get(dimension) as EvidenceSummary[], this.policy));
        if (dimensions.length === 0) {
            const empty: InsufficientFusionResult = Object.freeze({
                status: "insufficient" as const,
                reason: "no_evidence" as const,
                dimensions: Object.freeze([]),
                method: "insufficient" as const,
                sampleCount: 0,
                independentSources: 0,
                missingDimensions: Object.freeze([]),
            });
            return clone(empty);
        }
        const missing = dimensions.filter((dimension): dimension is InsufficientDimension => dimension.status === "insufficient");
        if (missing.length > 0) {
            const insufficient: InsufficientFusionResult = Object.freeze({
                status: "insufficient" as const,
                reason: "dimension_insufficient" as const,
                dimensions: Object.freeze(dimensions),
                method: "insufficient" as const,
                sampleCount: dimensions.reduce((sum, dimension) => sum + dimension.sampleCount, 0),
                independentSources: dimensions.reduce((sum, dimension) => sum + dimension.independentSources, 0),
                missingDimensions: Object.freeze(missing.map(dimension => dimension.dimension).sort(compareText)),
            });
            return clone(insufficient);
        }
        const fusedDimensions = dimensions as readonly FusedDimension[];
        const weightMass = fusedDimensions.reduce((sum, dimension) => sum + dimension.weightMass, 0);
        const score = fusedDimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weightMass, 0) / weightMass;
        const confidence = fusedDimensions.reduce((sum, dimension) => sum + dimension.confidence * dimension.weightMass, 0) / weightMass;
        const fused: FusedResult = Object.freeze({
            status: "fused" as const,
            score: Math.max(0, Math.min(1, score)),
            confidence: Math.max(0, Math.min(1, confidence)),
            dimensions: Object.freeze(fusedDimensions),
            method: "independence-weighted-average" as const,
            sampleCount: fusedDimensions.reduce((sum, dimension) => sum + dimension.sampleCount, 0),
            independentSources: fusedDimensions.reduce((sum, dimension) => sum + dimension.independentSources, 0),
            ignoredDuplicates: fusedDimensions.reduce(
                (sum, dimension) => sum + dimension.ignored.filter(entry => entry.reason === "duplicate_independence").length,
                0,
            ),
        });
        return clone(fused);
    }
}
