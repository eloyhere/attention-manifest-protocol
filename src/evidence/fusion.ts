import type { Identifier } from "../shared.ts";
import type { Evidence, EvidenceLevel, EvidenceSourceType } from "./types.ts";
import { EVIDENCE_LEVELS } from "./types.ts";
import {
    CONSUMABLE_EVIDENCE_STATUSES,
    clampUnit,
    corroborationFactor,
    effectiveSampleWeight,
    evidenceStatusReason,
    freezeSnapshot,
    freshnessOf,
    independenceKeyOf,
    originFactorOf,
    requireNonEmptyString,
    requirePositiveInteger,
    requireUnitInterval,
    validateSourceReliability,
} from "./scoring.ts";

/** Fusion method: no honest score yet, cold-start weighting, or smoothed Bayesian. */
export type FusionMethod = "insufficient" | "weighted" | "smoothed_bayesian";

export const FUSION_METHODS: readonly FusionMethod[] = Object.freeze([
    "insufficient",
    "weighted",
    "smoothed_bayesian",
]);

/** "Enough evidence" defaults from refract.md §5.7; all are overridable. */
export const DEFAULT_FUSION_MIN_EFFECTIVE_SAMPLES: number = 3;
export const DEFAULT_FUSION_STALE_RATIO_THRESHOLD: number = 0.25;
export const DEFAULT_FUSION_POSTERIOR_CI_THRESHOLD: number = 0.5;
export const DEFAULT_FUSION_PRIOR: Readonly<{ readonly alpha: number; readonly beta: number }> = Object.freeze({ alpha: 1, beta: 1 });

/** A dimension is one claim at one evidence level; levels never mix (§5.7). */
export interface FusionDimension {
    readonly claim: string;
    readonly level: EvidenceLevel | null;
}

/** 95% equal-tailed-normal-approximation interval for the Beta posterior. */
export interface FusionPosterior {
    readonly alpha: number;
    readonly beta: number;
    readonly mean: number;
    readonly ciWidth: number;
}

/** Per-evidence audit trail: inputs, discounts and the effective weight used. */
export interface FusionContribution {
    readonly evidenceId: Identifier;
    readonly dimension: FusionDimension;
    readonly sourceType: EvidenceSourceType | null;
    readonly polarity: "supports" | "refutes";
    readonly reliability: number;
    readonly freshness: number;
    readonly corroborationFactor: number;
    readonly originFactor: number;
    readonly independenceFactor: number;
    readonly weight: number;
    readonly signedWeight: number;
    readonly counted: boolean;
    readonly independenceKey: string | null;
    readonly reason?: string;
    readonly duplicateOf?: Identifier;
}

/** One independently aggregated dimension. */
export interface FusionDimensionResult {
    readonly dimension: FusionDimension;
    readonly score: number;
    readonly confidence: number;
    readonly method: FusionMethod;
    readonly effectiveSamples: number;
    readonly supports: number;
    readonly refutes: number;
    readonly sufficient: boolean;
    readonly insufficientReasons: readonly string[];
    readonly verified: boolean;
    readonly countedEvidenceIds: readonly Identifier[];
    readonly duplicateEvidenceIds: readonly Identifier[];
    readonly excludedEvidenceIds: readonly Identifier[];
    readonly posterior?: FusionPosterior;
}

/**
 * Fusion output. `score` is net support in `[-1, 1]` and `confidence` is in
 * `[0, 1]`. When evidence is insufficient the method is explicitly
 * `insufficient` and no `posterior` is emitted: a Bayesian posterior is only
 * reported once every §5.7 sufficiency criterion passes.
 */
export interface FusionResult {
    readonly score: number;
    readonly confidence: number;
    readonly contributions: readonly FusionContribution[];
    readonly method: FusionMethod;
    readonly dimension: FusionDimension | null;
    readonly dimensions: readonly FusionDimensionResult[];
    readonly effectiveSamples: number;
    readonly supports: number;
    readonly refutes: number;
    readonly sufficient: boolean;
    readonly insufficientReasons: readonly string[];
    readonly verified: boolean;
    readonly posterior?: FusionPosterior;
}

export interface FusionOptions {
    /** Select one claim dimension. Without it, mixed dimensions return insufficient. */
    readonly claim?: string;
    /** Select one evidence level. Mixed levels are never fused together. */
    readonly level?: EvidenceLevel;
    /** Explicit clock for freshness decay; passing it makes freshness reproducible. */
    readonly now?: string;
    /** Override the 24h freshness half-life when `now` is passed. */
    readonly halfLifeMs?: number;
    /** N in §5.7 "effective sample count >= N" (default 3). */
    readonly minEffectiveSamples?: number;
    /** Maximum tolerable stale share (default 0.25). */
    readonly staleRatioThreshold?: number;
    /** Maximum posterior CI width for sufficiency (default 0.5). */
    readonly posteriorCiThreshold?: number;
    /** Beta prior used only on the sufficient path (default 1, 1). */
    readonly prior?: Readonly<{ readonly alpha: number; readonly beta: number }>;
    /** Set false to keep the cold-start weighted score even when sufficient. */
    readonly bayesian?: boolean;
    /** Caller-supplied drift signal from the last K samples. */
    readonly driftDetected?: boolean;
    /** Explicit opt-in to relevance-only dialogue fusion; off by default (§5.7 hard rule 2). */
    readonly includeDialogue?: boolean;
    /** Optional tenant guard; all evidence must belong to it. */
    readonly tenantId?: Identifier;
}

interface NormalizedFusionOptions {
    readonly claim?: string;
    readonly level?: EvidenceLevel;
    readonly now?: string;
    readonly halfLifeMs?: number;
    readonly minEffectiveSamples: number;
    readonly staleRatioThreshold: number;
    readonly posteriorCiThreshold: number;
    readonly priorAlpha: number;
    readonly priorBeta: number;
    readonly bayesian: boolean;
    readonly driftDetected: boolean;
    readonly includeDialogue: boolean;
    readonly tenantId?: Identifier;
}

interface FusionDraft {
    readonly evidence: Evidence;
    readonly dimension: FusionDimension;
    readonly sourceType: EvidenceSourceType | null;
    readonly polarity: "supports" | "refutes";
    readonly reliability: number;
    readonly freshness: number;
    readonly corroboration: number;
    readonly origin: number;
    readonly independenceKey: string | null;
    readonly baseWeight: number;
    readonly reason?: string;
}

interface DimensionBucket {
    readonly dimension: FusionDimension;
    readonly members: readonly Evidence[];
}

interface DimensionComputation {
    readonly result: FusionDimensionResult;
    readonly contributions: readonly FusionContribution[];
}

function normalizeOptions(options: FusionOptions | undefined): NormalizedFusionOptions {
    const value: FusionOptions = options ?? {};
    if (value === null || typeof value !== "object") throw new TypeError("Fusion options must be an object");
    const claim: string | undefined = value.claim === undefined ? undefined : requireNonEmptyString(value.claim, "Fusion claim");
    if (value.level !== undefined && !(EVIDENCE_LEVELS as readonly string[]).includes(value.level)) {
        throw new TypeError(`Invalid fusion level: ${String(value.level)}`);
    }
    if (value.now !== undefined && !Number.isFinite(Date.parse(value.now))) {
        throw new TypeError("Fusion now must be an ISO-compatible timestamp");
    }
    if (value.halfLifeMs !== undefined && (!Number.isFinite(value.halfLifeMs) || value.halfLifeMs <= 0)) {
        throw new TypeError("Fusion halfLifeMs must be a positive finite number");
    }
    const minEffectiveSamples: number = value.minEffectiveSamples === undefined
        ? DEFAULT_FUSION_MIN_EFFECTIVE_SAMPLES
        : requirePositiveInteger(value.minEffectiveSamples, "Fusion minEffectiveSamples");
    const staleRatioThreshold: number = value.staleRatioThreshold === undefined
        ? DEFAULT_FUSION_STALE_RATIO_THRESHOLD
        : requireUnitInterval(value.staleRatioThreshold, "Fusion staleRatioThreshold");
    const posteriorCiThreshold: number = value.posteriorCiThreshold === undefined
        ? DEFAULT_FUSION_POSTERIOR_CI_THRESHOLD
        : requireUnitInterval(value.posteriorCiThreshold, "Fusion posteriorCiThreshold");
    const prior = value.prior ?? DEFAULT_FUSION_PRIOR;
    if (prior === null || typeof prior !== "object") throw new TypeError("Fusion prior must be an object");
    if (!Number.isFinite(prior.alpha) || prior.alpha <= 0) throw new TypeError("Fusion prior alpha must be a positive finite number");
    if (!Number.isFinite(prior.beta) || prior.beta <= 0) throw new TypeError("Fusion prior beta must be a positive finite number");
    if (value.bayesian !== undefined && typeof value.bayesian !== "boolean") throw new TypeError("Fusion bayesian must be a boolean");
    if (value.driftDetected !== undefined && typeof value.driftDetected !== "boolean") throw new TypeError("Fusion driftDetected must be a boolean");
    if (value.includeDialogue !== undefined && typeof value.includeDialogue !== "boolean") throw new TypeError("Fusion includeDialogue must be a boolean");
    if (value.tenantId !== undefined) requireNonEmptyString(value.tenantId, "Fusion tenantId");
    return {
        ...(claim === undefined ? {} : { claim }),
        ...(value.level === undefined ? {} : { level: value.level }),
        ...(value.now === undefined ? {} : { now: value.now }),
        ...(value.halfLifeMs === undefined ? {} : { halfLifeMs: value.halfLifeMs }),
        minEffectiveSamples,
        staleRatioThreshold,
        posteriorCiThreshold,
        priorAlpha: prior.alpha,
        priorBeta: prior.beta,
        bayesian: value.bayesian ?? true,
        driftDetected: value.driftDetected ?? false,
        includeDialogue: value.includeDialogue ?? false,
        ...(value.tenantId === undefined ? {} : { tenantId: value.tenantId }),
    };
}

function validateEvidenceInput(evidence: readonly Evidence[], options: NormalizedFusionOptions): void {
    if (!Array.isArray(evidence)) throw new TypeError("Evidence must be an array");
    const seen = new Set<Identifier>();
    for (const item of evidence) {
        if (item === null || typeof item !== "object") throw new TypeError("Evidence entries must be objects");
        requireNonEmptyString(item.id, "Evidence id");
        requireNonEmptyString(item.claim, `Evidence claim (${item.id})`);
        requireNonEmptyString(item.tenantId, `Evidence tenantId (${item.id})`);
        if (seen.has(item.id)) throw new TypeError(`Duplicate evidence id: ${item.id}`);
        seen.add(item.id);
        if (item.source !== undefined) validateSourceReliability(item.source, item.id);
        if (item.level !== undefined && !(EVIDENCE_LEVELS as readonly string[]).includes(item.level)) {
            throw new TypeError(`Invalid evidence level: ${String(item.level)} (${item.id})`);
        }
        if (options.tenantId !== undefined && item.tenantId !== options.tenantId) {
            throw new TypeError(`Cross-tenant evidence fusion: ${item.id}`);
        }
        if (evidence[0] !== undefined && item.tenantId !== evidence[0].tenantId) {
            throw new TypeError(`Cross-tenant evidence fusion: ${item.id}`);
        }
    }
}

function dimensionOf(evidence: Evidence): FusionDimension {
    return { claim: evidence.claim, level: evidence.level ?? null };
}

function dimensionKey(dimension: FusionDimension): string {
    return `${dimension.level ?? "*"}\u0000${dimension.claim}`;
}

function excludedDraft(
    evidence: Evidence,
    dimension: FusionDimension,
    reason: string,
    metrics: {
        readonly sourceType?: EvidenceSourceType | null;
        readonly reliability?: number;
        readonly freshness?: number;
        readonly corroboration?: number;
        readonly origin?: number;
        readonly independenceKey?: string | null;
    } = {},
): FusionDraft {
    return {
        evidence,
        dimension,
        sourceType: metrics.sourceType ?? null,
        polarity: evidence.polarity,
        reliability: metrics.reliability ?? 0,
        freshness: metrics.freshness ?? 0,
        corroboration: metrics.corroboration ?? 1,
        origin: metrics.origin ?? 1,
        independenceKey: metrics.independenceKey ?? null,
        baseWeight: 0,
        reason,
    };
}

function evaluateEvidenceForFusion(
    evidence: Evidence,
    dimension: FusionDimension,
    presentIds: ReadonlySet<Identifier>,
    options: NormalizedFusionOptions,
): FusionDraft {
    const source = evidence.source;
    if (source === undefined) return excludedDraft(evidence, dimension, "missing_source");
    const reliability: number = validateSourceReliability(source, evidence.id);
    const corroboration: number = corroborationFactor(evidence, presentIds);
    const origin: number = originFactorOf(source);
    const independenceKey: string = independenceKeyOf(evidence);
    if (source.type === "dialogue" && !options.includeDialogue) {
        // §5.7 hard rule 2: dialogue history is relevance evidence, never verification evidence.
        return excludedDraft(evidence, dimension, "dialogue_history_not_verification_evidence", {
            sourceType: source.type, reliability, corroboration, origin, independenceKey,
        });
    }
    if (!CONSUMABLE_EVIDENCE_STATUSES.includes(evidence.status)) {
        return excludedDraft(evidence, dimension, evidenceStatusReason(evidence.status), {
            sourceType: source.type, reliability, corroboration, origin, independenceKey,
        });
    }
    const freshness: number = freshnessOf(evidence, { now: options.now, halfLifeMs: options.halfLifeMs });
    const baseWeight: number = reliability * freshness * corroboration * origin;
    if (freshness <= 0) {
        return excludedDraft(evidence, dimension, "expired_evidence", {
            sourceType: source.type, reliability, freshness, corroboration, origin, independenceKey,
        });
    }
    if (!(baseWeight > 0)) {
        return excludedDraft(evidence, dimension, "zero_weight", {
            sourceType: source.type, reliability, freshness, corroboration, origin, independenceKey,
        });
    }
    return {
        evidence,
        dimension,
        sourceType: source.type,
        polarity: evidence.polarity,
        reliability,
        freshness,
        corroboration,
        origin,
        independenceKey,
        baseWeight,
    };
}

function compareDrafts(left: FusionDraft, right: FusionDraft): number {
    if (right.baseWeight !== left.baseWeight) return right.baseWeight - left.baseWeight;
    return left.evidence.id < right.evidence.id ? -1 : left.evidence.id > right.evidence.id ? 1 : 0;
}

function compareContributions(left: FusionContribution, right: FusionContribution): number {
    const leftKey: string = dimensionKey(left.dimension);
    const rightKey: string = dimensionKey(right.dimension);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0;
}

function compareDimensions(left: FusionDimension, right: FusionDimension): number {
    const leftKey: string = dimensionKey(left);
    const rightKey: string = dimensionKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function outsideContribution(contribution: FusionContribution): FusionContribution {
    return {
        evidenceId: contribution.evidenceId,
        dimension: contribution.dimension,
        sourceType: contribution.sourceType,
        polarity: contribution.polarity,
        reliability: contribution.reliability,
        freshness: contribution.freshness,
        corroborationFactor: contribution.corroborationFactor,
        originFactor: contribution.originFactor,
        independenceFactor: 0,
        weight: 0,
        signedWeight: 0,
        counted: false,
        independenceKey: contribution.independenceKey,
        reason: "outside_selected_dimension",
    };
}

function computeDimension(bucket: DimensionBucket, options: NormalizedFusionOptions): DimensionComputation {
    const members: readonly Evidence[] = Object.freeze([...bucket.members].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const presentIds: ReadonlySet<Identifier> = new Set(members.map(item => item.id));
    const drafts: readonly FusionDraft[] = Object.freeze(members.map(item => evaluateEvidenceForFusion(item, bucket.dimension, presentIds, options)));
    const groups = new Map<string, FusionDraft[]>();
    for (const draft of drafts) {
        if (draft.reason !== undefined || draft.independenceKey === null || !(draft.baseWeight > 0)) continue;
        const group = groups.get(draft.independenceKey);
        if (group === undefined) groups.set(draft.independenceKey, [draft]);
        else group.push(draft);
    }
    const representativeIds = new Set<Identifier>();
    const duplicateOf = new Map<Identifier, Identifier>();
    for (const group of groups.values()) {
        const sorted: readonly FusionDraft[] = Object.freeze([...group].sort(compareDrafts));
        const representative = sorted[0];
        if (representative === undefined) continue;
        representativeIds.add(representative.evidence.id);
        for (const duplicate of sorted.slice(1)) duplicateOf.set(duplicate.evidence.id, representative.evidence.id);
    }
    const contributions: readonly FusionContribution[] = Object.freeze(drafts.map(draft => {
        const counted: boolean = representativeIds.has(draft.evidence.id);
        const duplicate: Identifier | undefined = duplicateOf.get(draft.evidence.id);
        const weight: number = counted ? draft.baseWeight : 0;
        const reason: string | undefined = draft.reason ?? (duplicate === undefined ? undefined : "same_independence_key");
        return {
            evidenceId: draft.evidence.id,
            dimension: draft.dimension,
            sourceType: draft.sourceType,
            polarity: draft.polarity,
            reliability: draft.reliability,
            freshness: draft.freshness,
            corroborationFactor: draft.corroboration,
            originFactor: draft.origin,
            independenceFactor: counted ? 1 : 0,
            weight,
            signedWeight: weight === 0 ? 0 : draft.polarity === "supports" ? weight : -weight,
            counted,
            independenceKey: draft.independenceKey,
            ...(reason === undefined ? {} : { reason }),
            ...(duplicate === undefined ? {} : { duplicateOf: duplicate }),
        };
    }));
    const countedDrafts: readonly FusionDraft[] = Object.freeze(drafts.filter(draft => representativeIds.has(draft.evidence.id)));
    let supportMass: number = 0;
    let refuteMass: number = 0;
    let supportSamples: number = 0;
    let refuteSamples: number = 0;
    let hasOperationHistory: boolean = false;
    for (const draft of countedDrafts) {
        const sampleWeight: number = effectiveSampleWeight(draft.evidence);
        if (draft.polarity === "supports") {
            supportMass += draft.baseWeight;
            supportSamples += sampleWeight;
        } else {
            refuteMass += draft.baseWeight;
            refuteSamples += sampleWeight;
        }
        if (draft.sourceType === "operation_history") hasOperationHistory = true;
    }
    const totalMass: number = supportMass + refuteMass;
    const weightedScore: number = totalMass > 0 ? (supportMass - refuteMass) / totalMass : 0;
    const effectiveSamples: number = supportSamples + refuteSamples;
    const staleCount: number = members.filter(item => item.status === "stale").length;
    const contestedCount: number = members.filter(item => item.status === "contested").length;
    const staleRatio: number = members.length === 0 ? 0 : staleCount / members.length;
    const alpha: number = options.priorAlpha + supportSamples;
    const beta: number = options.priorBeta + refuteSamples;
    const posteriorMean: number = alpha / (alpha + beta);
    const posteriorVariance: number = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const ciWidth: number = clampUnit(2 * 1.96 * Math.sqrt(posteriorVariance));
    const insufficientReasons: string[] = [];
    if (members.length === 0) {
        insufficientReasons.push("no_evidence");
    } else if (effectiveSamples <= 0) {
        insufficientReasons.push("no_effective_evidence");
    } else if (effectiveSamples < options.minEffectiveSamples) {
        insufficientReasons.push("insufficient_effective_samples");
    }
    if (contestedCount > 0) insufficientReasons.push("unarbitrated_contested");
    if (staleRatio >= options.staleRatioThreshold) insufficientReasons.push("stale_ratio_exceeded");
    if (options.driftDetected) insufficientReasons.push("recent_drift");
    if (effectiveSamples >= options.minEffectiveSamples && ciWidth >= options.posteriorCiThreshold) {
        insufficientReasons.push("posterior_ci_too_wide");
    }
    const sufficient: boolean = insufficientReasons.length === 0;
    const agreement: number = totalMass > 0 ? Math.abs(supportMass - refuteMass) / totalMass : 0;
    let score: number;
    let confidence: number;
    let method: FusionMethod;
    let posterior: FusionPosterior | undefined;
    if (sufficient) {
        const sampleFactor: number = effectiveSamples / (effectiveSamples + 2 * options.minEffectiveSamples);
        const sampleConfidence: number = effectiveSamples / (effectiveSamples + options.minEffectiveSamples);
        const ciFactor: number = 1 - Math.min(0.5, ciWidth / 2);
        confidence = clampUnit(agreement * (0.5 + 0.5 * sampleConfidence) * ciFactor);
        const posteriorScore: number = 2 * posteriorMean - 1;
        const smoothing: number = clampUnit(sampleFactor * (0.5 + 0.5 * agreement) * (0.5 + 0.5 * confidence));
        score = options.bayesian ? (1 - smoothing) * weightedScore + smoothing * posteriorScore : weightedScore;
        method = options.bayesian ? "smoothed_bayesian" : "weighted";
        if (options.bayesian) posterior = freezeSnapshot({ alpha, beta, mean: posteriorMean, ciWidth });
    } else {
        confidence = effectiveSamples <= 0
            ? 0
            : Math.min(0.49, clampUnit(agreement * (effectiveSamples / (2 * options.minEffectiveSamples)) * 0.5));
        score = weightedScore;
        method = "insufficient";
    }
    const verified: boolean = sufficient && hasOperationHistory && score > 0;
    const result: FusionDimensionResult = {
        dimension: bucket.dimension,
        score,
        confidence,
        method,
        effectiveSamples,
        supports: supportMass,
        refutes: refuteMass,
        sufficient,
        insufficientReasons: Object.freeze(insufficientReasons),
        verified,
        countedEvidenceIds: Object.freeze(countedDrafts.map(draft => draft.evidence.id).sort()),
        duplicateEvidenceIds: Object.freeze([...duplicateOf.keys()].sort()),
        excludedEvidenceIds: Object.freeze(drafts.filter(draft => draft.reason !== undefined).map(draft => draft.evidence.id).sort()),
        ...(posterior === undefined ? {} : { posterior }),
    };
    return freezeSnapshot({ result, contributions: Object.freeze([...contributions].sort(compareContributions)) });
}

function matchesSelector(dimension: FusionDimension, options: NormalizedFusionOptions): boolean {
    if (options.claim !== undefined && dimension.claim !== options.claim) return false;
    if (options.level !== undefined && dimension.level !== options.level) return false;
    return true;
}

function emptyResult(contributions: readonly FusionContribution[], reason: string): FusionResult {
    const result: FusionResult = {
        score: 0,
        confidence: 0,
        contributions: Object.freeze([...contributions].sort(compareContributions)),
        method: "insufficient",
        dimension: null,
        dimensions: Object.freeze([]),
        effectiveSamples: 0,
        supports: 0,
        refutes: 0,
        sufficient: false,
        insufficientReasons: Object.freeze([reason]),
        verified: false,
    };
    return freezeSnapshot(result);
}

/**
 * Fuses evidence according to refract.md §5.7:
 *
 * - Independence dedupe: one `independenceKey` is one effective sample.
 * - Secondary origin is discounted ×0.5; corroboration and freshness modulate
 *   each contribution (`reliability × freshness × corroboration × origin`).
 * - Dimensions (claim × level) are aggregated independently; mixed dimensions
 *   are never blended. Use `claim`/`level` to select one.
 * - Cold start uses the weighted score. Once every sufficiency criterion
 *   passes (effective samples ≥ N, posterior CI narrow enough, no unarbitrated
 *   contested evidence, stale ratio below threshold, no recent drift) the
 *   score is a smoothed weighted/Bayesian blend. Otherwise the method is
 *   explicitly `insufficient` and no posterior is reported.
 * - §5.7 hard rules: no operation-history evidence means `verified === false`,
 *   and dialogue history is excluded from verification unless explicitly
 *   opted into with `includeDialogue`.
 *
 * Pure and deterministic: no clock is read (pass `now` for freshness decay),
 * inputs are never mutated, and all output is frozen. Malformed arguments
 * throw `TypeError`; insufficient evidence is a normal result, not an error.
 */
export function fuseEvidence(evidence: readonly Evidence[], options: FusionOptions = {}): FusionResult {
    const normalized: NormalizedFusionOptions = normalizeOptions(options);
    validateEvidenceInput(evidence, normalized);
    const buckets = new Map<string, { readonly dimension: FusionDimension; readonly members: Evidence[] }>();
    for (const item of evidence) {
        const dimension: FusionDimension = dimensionOf(item);
        const key: string = dimensionKey(dimension);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, { dimension, members: [item] });
        else bucket.members.push(item);
    }
    const allComputations: readonly DimensionComputation[] = Object.freeze([...buckets.values()]
        .sort((left, right) => compareDimensions(left.dimension, right.dimension))
        .map(bucket => computeDimension(Object.freeze({ dimension: bucket.dimension, members: Object.freeze(bucket.members) }), normalized)));
    const selectorActive: boolean = normalized.claim !== undefined || normalized.level !== undefined;
    const selected: readonly DimensionComputation[] = Object.freeze(selectorActive
        ? allComputations.filter(computation => matchesSelector(computation.result.dimension, normalized))
        : allComputations);
    const selectedKeys = new Set<Identifier>(selected.map(computation => dimensionKey(computation.result.dimension)));
    const contributions: readonly FusionContribution[] = Object.freeze(allComputations.flatMap(computation => {
        if (!selectorActive || selectedKeys.has(dimensionKey(computation.result.dimension))) return [...computation.contributions];
        return computation.contributions.map(outsideContribution);
    }));
    if (selected.length === 0) {
        return emptyResult(contributions, evidence.length === 0 ? "no_evidence" : "outside_selected_dimension");
    }
    const dimensions: readonly FusionDimensionResult[] = Object.freeze(selected
        .map(computation => computation.result)
        .sort((left, right) => compareDimensions(left.dimension, right.dimension)));
    if (dimensions.length > 1) {
        const multiple: FusionResult = {
            score: 0,
            confidence: 0,
            contributions: Object.freeze([...contributions].sort(compareContributions)),
            method: "insufficient",
            dimension: null,
            dimensions,
            effectiveSamples: 0,
            supports: 0,
            refutes: 0,
            sufficient: false,
            insufficientReasons: Object.freeze(["multiple_dimensions"]),
            verified: false,
        };
        return freezeSnapshot(multiple);
    }
    const chosen = dimensions[0];
    if (chosen === undefined) return emptyResult(contributions, evidence.length === 0 ? "no_evidence" : "outside_selected_dimension");
    const result: FusionResult = {
        score: chosen.score,
        confidence: chosen.confidence,
        contributions: Object.freeze([...contributions].sort(compareContributions)),
        method: chosen.method,
        dimension: chosen.dimension,
        dimensions,
        effectiveSamples: chosen.effectiveSamples,
        supports: chosen.supports,
        refutes: chosen.refutes,
        sufficient: chosen.sufficient,
        insufficientReasons: chosen.insufficientReasons,
        verified: chosen.verified,
        ...(chosen.posterior === undefined ? {} : { posterior: chosen.posterior }),
    };
    return freezeSnapshot(result);
}
