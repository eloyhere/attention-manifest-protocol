import type { Identifier } from "../shared.ts";
import type { EvidenceLevel, EvidenceSourceType } from "../evidence/types.ts";

/**
 * Mirrors the evidence levels in `refract.md` §5.1 without importing a runtime
 * constant from another layer. A fusion dimension may only contain one level.
 */
export const FUSION_EVIDENCE_LEVELS: readonly EvidenceLevel[] = Object.freeze([
    "action",
    "task",
    "plan",
    "goal",
    "mission",
    "intent",
]);

export const FUSION_SOURCE_TYPES: readonly EvidenceSourceType[] = Object.freeze([
    "operation_history",
    "user_confirmation",
    "web_search",
    "dialogue",
    "system_rule",
]);

/**
 * One evidence summary from one source. `reliability` is the source baseline
 * already combined with receipt verification; cross-agent trust enters through
 * {@link FusionPolicy.agentWeights}. `score` is the observed support for the
 * claim in `0..1`, and `polarity` flips its orientation for refuting evidence.
 */
export interface EvidenceSummary {
    readonly evidenceId: Identifier;
    /** Dimension the summary belongs to (for example correctness or freshness). */
    readonly dimension: string;
    /** Optional level tag; all summaries in one dimension must share it. */
    readonly level?: EvidenceLevel;
    readonly sourceType?: EvidenceSourceType;
    readonly score: number;
    readonly confidence: number;
    readonly reliability: number;
    readonly agentId?: Identifier;
    /** Same key means the same origin and is counted once per dimension. */
    readonly independenceKey: string;
    /** `secondary` evidence is discounted (refract §5.7). */
    readonly origin?: "original" | "secondary";
    /** Optional freshness multiplier in `0..1`; defaults to 1. */
    readonly freshness?: number;
    readonly polarity?: "supports" | "refutes";
}

/** Cross-agent weights and independence thresholds for one fusion layer. */
export interface FusionPolicy {
    /** Minimum distinct independence keys required per dimension. */
    readonly minimumIndependentSources: number;
    /** Minimum Kish effective sample size required per dimension. */
    readonly minimumEffectiveSamples: number;
    readonly agentWeights: Readonly<Record<Identifier, number>>;
    readonly defaultAgentWeight: number;
    readonly secondaryDiscount: number;
}

export const DEFAULT_FUSION_POLICY: FusionPolicy = Object.freeze({
    minimumIndependentSources: 2,
    minimumEffectiveSamples: 1,
    agentWeights: Object.freeze({}),
    defaultAgentWeight: 1,
    secondaryDiscount: 0.5,
});

export interface FusionContribution {
    readonly evidenceId: Identifier;
    readonly agentId?: Identifier;
    readonly independenceKey: string;
    readonly weight: number;
    readonly effectiveScore: number;
    readonly confidence: number;
}

export type FusionIgnoredReason = "duplicate_independence" | "zero_weight";

export interface IgnoredEvidence {
    readonly evidenceId: Identifier;
    readonly reason: FusionIgnoredReason;
}

export interface FusedDimension {
    readonly status: "fused";
    readonly dimension: string;
    readonly level?: EvidenceLevel;
    readonly score: number;
    /**
     * Independence-adjusted weighted mean of source confidences. This is a
     * transparent aggregate, not a Bayesian posterior.
     */
    readonly confidence: number;
    readonly sampleCount: number;
    readonly independentSources: number;
    readonly effectiveSamples: number;
    readonly weightMass: number;
    readonly contributions: readonly FusionContribution[];
    readonly ignored: readonly IgnoredEvidence[];
}

export type DimensionInsufficientReason = "insufficient_samples" | "zero_weight";

export interface InsufficientDimension {
    readonly status: "insufficient";
    readonly dimension: string;
    readonly level?: EvidenceLevel;
    readonly sampleCount: number;
    readonly independentSources: number;
    readonly effectiveSamples: number;
    readonly reason: DimensionInsufficientReason;
    readonly ignored: readonly IgnoredEvidence[];
}

export type DimensionFusion = FusedDimension | InsufficientDimension;

/**
 * Fused result. When any dimension lacks enough independent evidence the whole
 * result stays `insufficient`; the layer never fills the missing score with a
 * fabricated posterior.
 */
export interface FusedResult {
    readonly status: "fused";
    readonly score: number;
    readonly confidence: number;
    readonly dimensions: readonly FusedDimension[];
    readonly method: "independence-weighted-average";
    readonly sampleCount: number;
    readonly independentSources: number;
    /** Summaries suppressed as duplicate origins; zero-weight summaries are excluded. */
    readonly ignoredDuplicates: number;
}

export type FusionInsufficientReason = "no_evidence" | "dimension_insufficient";

export interface InsufficientFusionResult {
    readonly status: "insufficient";
    readonly reason: FusionInsufficientReason;
    readonly dimensions: readonly DimensionFusion[];
    readonly method: "insufficient";
    readonly sampleCount: number;
    readonly independentSources: number;
    /** Dimensions that lacked enough evidence; empty when there is no evidence. */
    readonly missingDimensions: readonly string[];
}

export type FusionResult = FusedResult | InsufficientFusionResult;
