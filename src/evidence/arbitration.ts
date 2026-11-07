import type { Identifier } from "../shared.ts";
import type { Evidence, EvidenceLevel, EvidenceSourceType } from "./types.ts";
import { EVIDENCE_LEVELS } from "./types.ts";
import {
    corroborationFactor,
    describeScore,
    evidenceStatusReason,
    freshnessOf,
    freezeSnapshot,
    independenceKeyOf,
    isArbitrationEvidenceStatus,
    isArbitrationSourceType,
    originFactorOf,
    requireNonEmptyString,
    sourceTier,
    validateSourceReliability,
} from "./scoring.ts";

/** Arbitration outcome: a factual winner, or escalation to a human decision. */
export type ArbitrationOutcome = "supports" | "refutes" | "escalate_to_human";

/**
 * How the outcome was reached. `eligibility` means only one side had
 * arbitrable evidence and `unanimous` means the input never actually opposed
 * the winning polarity; both exist so every result names its rule.
 */
export type ArbitrationMethod =
    | "cross_level_priority"
    | "same_level_weight"
    | "eligibility"
    | "unanimous"
    | "escalate_to_human";

/**
 * A conflict submitted for arbitration. `conflictId` (or the legacy `id`) and
 * `evidenceIds` identify the dispute; `level` optionally pins the evidence
 * level, and `intent`/`kind: "intent"` force the §5.5 rule that intent
 * conflicts must ask a human. Intent level on any party is inferred as well.
 */
export interface EvidenceConflict {
    readonly conflictId?: Identifier;
    readonly id?: Identifier;
    readonly claim: string;
    readonly evidenceIds: readonly Identifier[];
    readonly level?: EvidenceLevel;
    readonly intent?: boolean;
    readonly kind?: "fact" | "intent";
}

/** Evidence lookup accepted by {@link arbitrate}: a Map or a plain record. */
export type EvidenceIndex = ReadonlyMap<Identifier, Evidence> | Readonly<Record<Identifier, Evidence>>;

export interface ArbitrationOptions {
    /** Explicit clock for freshness decay and the arbitration record timestamp. */
    readonly now?: string;
    /** Override the 24h freshness half-life when `now` is passed. */
    readonly halfLifeMs?: number;
    /** Optional tenant guard; every conflict party must belong to it. */
    readonly tenantId?: Identifier;
}

/** One evidence item's contribution to an arbitration decision. */
export interface ArbitrationScore {
    readonly evidenceId: Identifier;
    readonly sourceType: EvidenceSourceType | null;
    readonly tier: number;
    readonly polarity: "supports" | "refutes";
    readonly reliability: number;
    readonly freshness: number;
    /** 1 for an independent representative, 0 for an ineligible or duplicate item. */
    readonly independenceWeight: number;
    readonly corroboration: number;
    readonly originFactor: number;
    readonly weight: number;
    readonly counted: boolean;
    readonly reason?: string;
    readonly duplicateOf?: Identifier;
}

/** One frozen arbitration decision plus its `system_rule` evidence record. */
export interface ArbitrationResult {
    readonly conflictId: Identifier;
    readonly claim: string;
    readonly outcome: ArbitrationOutcome;
    readonly method: ArbitrationMethod;
    readonly winnerId?: Identifier;
    readonly reason: string;
    readonly evidenceIds: readonly Identifier[];
    /** Decisive weight on the supports side at its highest source tier. */
    readonly supportScore: number;
    /** Decisive weight on the refutes side at its highest source tier. */
    readonly refuteScore: number;
    readonly scores: readonly ArbitrationScore[];
    /**
     * The arbitration record itself (refract.md §5.5 rule 4). It is a fabricated
     * `system_rule` evidence item: reliability 0.95, original, reproducible and
     * keyed by `system_rule:arbitration:{conflictId}`. It is returned, not
     * inserted into the caller's index, so the function stays pure.
     */
    readonly evidence: Evidence;
}

interface ResolvedConflict {
    readonly conflictId: Identifier;
    readonly claim: string;
    readonly evidenceIds: readonly Identifier[];
    readonly level?: EvidenceLevel;
    readonly intent: boolean;
    readonly evidence: readonly Evidence[];
}

interface ScoreDraft {
    readonly evidence: Evidence;
    readonly sourceType: EvidenceSourceType | null;
    readonly tier: number;
    readonly polarity: "supports" | "refutes";
    readonly reliability: number;
    readonly freshness: number;
    readonly corroboration: number;
    readonly origin: number;
    readonly baseWeight: number;
    readonly independenceKey: string;
    readonly reason?: string;
}

interface DedupedSide {
    readonly counted: readonly ScoreDraft[];
    readonly weight: number;
}

const WEIGHT_EPSILON: number = 1e-9;
const SYSTEM_RULE_RELIABILITY: number = 0.95;

function lookupEvidence(index: EvidenceIndex, id: Identifier): Evidence | undefined {
    if (index instanceof Map) return index.get(id);
    if (typeof index !== "object" || index === null || Array.isArray(index)) {
        throw new TypeError("Evidence index must be a Map or a plain record");
    }
    return Object.hasOwn(index, id) ? (index as Readonly<Record<Identifier, Evidence>>)[id] : undefined;
}

function validateOptions(options: ArbitrationOptions): void {
    if (options === null || typeof options !== "object") throw new TypeError("Arbitration options must be an object");
    if (options.now !== undefined && !Number.isFinite(Date.parse(options.now))) {
        throw new TypeError("Arbitration now must be an ISO-compatible timestamp");
    }
    if (options.halfLifeMs !== undefined && (!Number.isFinite(options.halfLifeMs) || options.halfLifeMs <= 0)) {
        throw new TypeError("Arbitration halfLifeMs must be a positive finite number");
    }
    if (options.tenantId !== undefined) requireNonEmptyString(options.tenantId, "Arbitration tenantId");
}

function resolveConflicts(conflictInput: EvidenceConflict | readonly EvidenceConflict[], index: EvidenceIndex, options: ArbitrationOptions): readonly ResolvedConflict[] {
    if (conflictInput === null || typeof conflictInput !== "object") throw new TypeError("Evidence conflicts must be an object or an array");
    const list: readonly EvidenceConflict[] = Array.isArray(conflictInput) ? conflictInput : [conflictInput];
    const resolved: ResolvedConflict[] = [];
    const conflictIds = new Set<Identifier>();
    let tenantId: Identifier | undefined = options.tenantId;
    for (const conflict of list) {
        if (conflict === null || typeof conflict !== "object") throw new TypeError("Evidence conflict must be an object");
        const conflictId: Identifier = requireNonEmptyString(conflict.conflictId ?? conflict.id, "Evidence conflict id");
        if (conflictIds.has(conflictId)) throw new TypeError(`Duplicate evidence conflict: ${conflictId}`);
        conflictIds.add(conflictId);
        const claim: string = requireNonEmptyString(conflict.claim, `Evidence conflict claim (${conflictId})`);
        if (!Array.isArray(conflict.evidenceIds) || conflict.evidenceIds.length === 0) {
            throw new TypeError(`Evidence conflict must name at least one evidence id (${conflictId})`);
        }
        const evidenceIds: Identifier[] = [];
        const seenIds = new Set<Identifier>();
        const evidence: Evidence[] = [];
        for (const evidenceId of conflict.evidenceIds) {
            requireNonEmptyString(evidenceId, `Evidence conflict evidenceIds (${conflictId})`);
            if (seenIds.has(evidenceId)) throw new TypeError(`Evidence conflict contains duplicate evidence id: ${evidenceId}`);
            seenIds.add(evidenceId);
            const item = lookupEvidence(index, evidenceId);
            if (item === undefined) throw new TypeError(`Unknown evidence in conflict ${conflictId}: ${evidenceId}`);
            if (tenantId === undefined) tenantId = item.tenantId;
            if (item.tenantId !== tenantId) throw new TypeError(`Cross-tenant evidence conflict: ${conflictId}`);
            evidenceIds.push(evidenceId);
            evidence.push(item);
        }
        if (conflict.level !== undefined && !(EVIDENCE_LEVELS as readonly string[]).includes(conflict.level)) {
            throw new TypeError(`Invalid evidence conflict level: ${String(conflict.level)}`);
        }
        if (conflict.intent !== undefined && typeof conflict.intent !== "boolean") {
            throw new TypeError(`Evidence conflict intent must be a boolean (${conflictId})`);
        }
        if (conflict.kind !== undefined && conflict.kind !== "fact" && conflict.kind !== "intent") {
            throw new TypeError(`Invalid evidence conflict kind: ${String(conflict.kind)}`);
        }
        const intent: boolean = conflict.intent === true
            || conflict.kind === "intent"
            || evidence.some(item => item.level === "intent");
        resolved.push(Object.freeze({
            conflictId,
            claim,
            evidenceIds: Object.freeze([...evidenceIds].sort()),
            ...(conflict.level === undefined ? {} : { level: conflict.level }),
            intent,
            evidence: Object.freeze([...evidence].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
        }));
    }
    return Object.freeze(resolved);
}

function missingSourceDraft(evidence: Evidence): ScoreDraft {
    return {
        evidence,
        sourceType: null,
        tier: 5,
        polarity: evidence.polarity,
        reliability: 0,
        freshness: 0,
        corroboration: 1,
        origin: 1,
        baseWeight: 0,
        independenceKey: independenceKeyOf(evidence),
        reason: "missing_source",
    };
}

function evaluateEvidence(evidence: Evidence, presentIds: ReadonlySet<Identifier>, options: ArbitrationOptions): ScoreDraft {
    const source = evidence.source;
    if (source === undefined) return missingSourceDraft(evidence);
    const reliability: number = validateSourceReliability(source, evidence.id);
    const tier: number = sourceTier(source.type);
    const freshness: number = freshnessOf(evidence, { now: options.now, halfLifeMs: options.halfLifeMs });
    const corroboration: number = corroborationFactor(evidence, presentIds);
    const origin: number = originFactorOf(source);
    const baseWeight: number = reliability * freshness * corroboration * origin;
    let reason: string | undefined;
    if (!isArbitrationSourceType(source.type)) reason = "system_rule_meta_evidence";
    else if (!isArbitrationEvidenceStatus(evidence.status)) reason = evidenceStatusReason(evidence.status);
    else if (freshness <= 0) reason = "expired_evidence";
    else if (!(baseWeight > 0)) reason = "zero_weight";
    return {
        evidence,
        sourceType: source.type,
        tier,
        polarity: evidence.polarity,
        reliability,
        freshness,
        corroboration,
        origin,
        baseWeight,
        independenceKey: independenceKeyOf(evidence),
        ...(reason === undefined ? {} : { reason }),
    };
}

function compareDrafts(left: ScoreDraft, right: ScoreDraft): number {
    if (right.baseWeight !== left.baseWeight) return right.baseWeight - left.baseWeight;
    return left.evidence.id < right.evidence.id ? -1 : left.evidence.id > right.evidence.id ? 1 : 0;
}

function dedupeDrafts(drafts: readonly ScoreDraft[]): { readonly scores: readonly ArbitrationScore[]; readonly counted: readonly ScoreDraft[] } {
    const groups = new Map<string, ScoreDraft[]>();
    for (const draft of drafts) {
        if (draft.reason !== undefined || !(draft.baseWeight > 0)) continue;
        const group = groups.get(draft.independenceKey);
        if (group === undefined) groups.set(draft.independenceKey, [draft]);
        else group.push(draft);
    }
    const countedIds = new Set<Identifier>();
    const duplicateOf = new Map<Identifier, Identifier>();
    for (const group of groups.values()) {
        const sorted: readonly ScoreDraft[] = Object.freeze([...group].sort(compareDrafts));
        const representative = sorted[0];
        if (representative === undefined) continue;
        countedIds.add(representative.evidence.id);
        for (const duplicate of sorted.slice(1)) duplicateOf.set(duplicate.evidence.id, representative.evidence.id);
    }
    const scores: ArbitrationScore[] = drafts.map(draft => {
        const counted: boolean = countedIds.has(draft.evidence.id);
        const duplicate: Identifier | undefined = duplicateOf.get(draft.evidence.id);
        return {
            evidenceId: draft.evidence.id,
            sourceType: draft.sourceType,
            tier: draft.tier,
            polarity: draft.polarity,
            reliability: draft.reliability,
            freshness: draft.freshness,
            independenceWeight: counted ? 1 : 0,
            corroboration: draft.corroboration,
            originFactor: draft.origin,
            weight: counted ? draft.baseWeight : 0,
            counted,
            ...(draft.reason === undefined && duplicate === undefined ? {} : { reason: draft.reason ?? "same_independence_key" }),
            ...(duplicate === undefined ? {} : { duplicateOf: duplicate }),
        };
    });
    const counted: readonly ScoreDraft[] = Object.freeze(drafts.filter(draft => countedIds.has(draft.evidence.id)));
    return Object.freeze({
        scores: Object.freeze(scores.sort((left, right) => left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0)),
        counted,
    });
}

function sideOf(counted: readonly ScoreDraft[], polarity: "supports" | "refutes"): DedupedSide {
    const side: readonly ScoreDraft[] = Object.freeze(counted.filter(draft => draft.polarity === polarity));
    // Only the highest source tier on a side is compared; a lower-tier item
    // (e.g. dialogue) must never outvote an operation-history fact.
    const tier: number = side.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...side.map(draft => draft.tier));
    const decisive: readonly ScoreDraft[] = Object.freeze(side.filter(draft => draft.tier === tier));
    return Object.freeze({ counted: side, weight: decisive.reduce((sum, draft) => sum + draft.baseWeight, 0) });
}

function topTier(counted: readonly ScoreDraft[]): number {
    return Math.min(...counted.map(draft => draft.tier));
}

function tierTypes(counted: readonly ScoreDraft[], tier: number): string {
    return [...new Set(counted.filter(draft => draft.tier === tier).map(draft => draft.sourceType ?? "unknown"))].sort().join("/");
}

function pickWinner(counted: readonly ScoreDraft[]): ScoreDraft | undefined {
    if (counted.length === 0) return undefined;
    const tier: number = Math.min(...counted.map(draft => draft.tier));
    return [...counted].filter(draft => draft.tier === tier).sort(compareDrafts)[0];
}

function latestCreatedAt(evidence: readonly Evidence[], now: string | undefined): string {
    if (now !== undefined) return now;
    const sorted: readonly Evidence[] = Object.freeze([...evidence].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    let latest: string = sorted[0]?.createdAt ?? "";
    let latestTime: number = Date.parse(latest);
    for (const item of sorted.slice(1)) {
        const time: number = Date.parse(item.createdAt);
        if (time > latestTime) {
            latest = item.createdAt;
            latestTime = time;
        }
    }
    if (!Number.isFinite(latestTime)) throw new TypeError(`Evidence createdAt must be an ISO-compatible timestamp (${latest})`);
    return latest;
}

function arbitrationEvidence(conflict: ResolvedConflict, evidence: readonly Evidence[], outcome: ArbitrationOutcome, winner: ScoreDraft | undefined, options: ArbitrationOptions): Evidence {
    const sourceEvidence: Evidence = winner?.evidence ?? evidence[0];
    if (sourceEvidence === undefined) throw new TypeError(`Arbitration requires evidence (${conflict.conflictId})`);
    const level: EvidenceLevel | undefined = conflict.level ?? winner?.evidence.level ?? sourceEvidence.level;
    const record: Evidence = {
        id: `evidence:arbitration:${conflict.conflictId}`,
        tenantId: sourceEvidence.tenantId,
        dependsOn: Object.freeze([...conflict.evidenceIds].sort()),
        claim: conflict.claim,
        polarity: outcome === "refutes" ? "refutes" : "supports",
        observationId: sourceEvidence.observationId,
        receiptId: sourceEvidence.receiptId,
        verificationId: sourceEvidence.verificationId,
        integrityVerificationId: sourceEvidence.integrityVerificationId,
        criteriaVersion: sourceEvidence.criteriaVersion,
        environmentVersion: sourceEvidence.environmentVersion,
        createdAt: latestCreatedAt(evidence, options.now),
        status: "active",
        ...(level === undefined ? {} : { level }),
        ...(sourceEvidence.agentId === undefined ? {} : { agentId: sourceEvidence.agentId }),
        ...(sourceEvidence.cooperationId === undefined ? {} : { cooperationId: sourceEvidence.cooperationId }),
        ...(sourceEvidence.sessionId === undefined ? {} : { sessionId: sourceEvidence.sessionId }),
        ...(sourceEvidence.turnId === undefined ? {} : { turnId: sourceEvidence.turnId }),
        source: Object.freeze({
            type: "system_rule",
            reliability: SYSTEM_RULE_RELIABILITY,
            origin: "original",
            reproducible: true,
            independenceKey: `system_rule:arbitration:${conflict.conflictId}`,
        }),
        freshnessScore: 1,
    };
    return freezeSnapshot(record);
}

function noEligibleReason(conflict: ResolvedConflict, options: ArbitrationOptions): string {
    const reasons: readonly string[] = Object.freeze(conflict.evidence
        .map(item => `${item.id}:${evaluateEvidence(item, new Set(conflict.evidenceIds), options).reason ?? "ineligible"}`)
        .sort());
    return `no eligible evidence: ${reasons.join(", ")}`;
}

function decide(conflict: ResolvedConflict, support: DedupedSide, refute: DedupedSide, options: ArbitrationOptions): {
    readonly outcome: ArbitrationOutcome;
    readonly method: ArbitrationMethod;
    readonly winner: ScoreDraft | undefined;
    readonly reason: string;
} {
    const hasSupportEvidence: boolean = conflict.evidence.some(item => item.polarity === "supports");
    const hasRefuteEvidence: boolean = conflict.evidence.some(item => item.polarity === "refutes");
    if (!hasRefuteEvidence) {
        return support.counted.length > 0
            ? { outcome: "supports", method: "unanimous", winner: pickWinner(support.counted), reason: "unanimous supports: no opposing evidence" }
            : { outcome: "escalate_to_human", method: "escalate_to_human", winner: undefined, reason: noEligibleReason(conflict, options) };
    }
    if (!hasSupportEvidence) {
        return refute.counted.length > 0
            ? { outcome: "refutes", method: "unanimous", winner: pickWinner(refute.counted), reason: "unanimous refutes: no opposing evidence" }
            : { outcome: "escalate_to_human", method: "escalate_to_human", winner: undefined, reason: noEligibleReason(conflict, options) };
    }
    if (support.counted.length === 0 && refute.counted.length === 0) {
        return { outcome: "escalate_to_human", method: "escalate_to_human", winner: undefined, reason: noEligibleReason(conflict, options) };
    }
    if (conflict.intent) {
        return { outcome: "escalate_to_human", method: "escalate_to_human", winner: undefined, reason: "intent conflict requires a human decision (refract.md §5.5 rule 3)" };
    }
    if (support.counted.length === 0) {
        return { outcome: "refutes", method: "eligibility", winner: pickWinner(refute.counted), reason: "only the refutes side has eligible evidence" };
    }
    if (refute.counted.length === 0) {
        return { outcome: "supports", method: "eligibility", winner: pickWinner(support.counted), reason: "only the supports side has eligible evidence" };
    }
    const supportTier: number = topTier(support.counted);
    const refuteTier: number = topTier(refute.counted);
    if (supportTier !== refuteTier) {
        const winner: "supports" | "refutes" = supportTier < refuteTier ? "supports" : "refutes";
        const winningTier: number = Math.min(supportTier, refuteTier);
        const losingTier: number = Math.max(supportTier, refuteTier);
        const winningCounted: readonly ScoreDraft[] = winner === "supports" ? support.counted : refute.counted;
        const losingCounted: readonly ScoreDraft[] = winner === "supports" ? refute.counted : support.counted;
        return {
            outcome: winner,
            method: "cross_level_priority",
            winner: pickWinner(winningCounted),
            reason: `cross-level priority: ${tierTypes(winningCounted, winningTier)} (tier ${winningTier}) outranks ${tierTypes(losingCounted, losingTier)} (tier ${losingTier})`,
        };
    }
    if (Math.abs(support.weight - refute.weight) <= WEIGHT_EPSILON) {
        return {
            outcome: "escalate_to_human",
            method: "escalate_to_human",
            winner: undefined,
            reason: `same-tier weighted scores tie at ${describeScore(support.weight)}; escalation required`,
        };
    }
    const winner: "supports" | "refutes" = support.weight > refute.weight ? "supports" : "refutes";
    return {
        outcome: winner,
        method: "same_level_weight",
        winner: pickWinner(winner === "supports" ? support.counted : refute.counted),
        reason: `same-tier weighted arbitration: supports ${describeScore(support.weight)} vs refutes ${describeScore(refute.weight)}`,
    };
}

function arbitrateOne(conflict: ResolvedConflict, options: ArbitrationOptions): ArbitrationResult {
    const presentIds: ReadonlySet<Identifier> = new Set(conflict.evidenceIds);
    const drafts: readonly ScoreDraft[] = Object.freeze(conflict.evidence.map(item => evaluateEvidence(item, presentIds, options)));
    const deduped = dedupeDrafts(drafts);
    const support: DedupedSide = sideOf(deduped.counted, "supports");
    const refute: DedupedSide = sideOf(deduped.counted, "refutes");
    const decision = decide(conflict, support, refute, options);
    const supportTier: number = support.counted.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...support.counted.map(draft => draft.tier));
    const refuteTier: number = refute.counted.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...refute.counted.map(draft => draft.tier));
    const scores: readonly ArbitrationScore[] = Object.freeze(deduped.scores.map(score => {
        if (!score.counted) return score;
        const tier: number = score.polarity === "supports" ? supportTier : refuteTier;
        if (score.tier <= tier) return score;
        return {
            ...score,
            independenceWeight: 0,
            weight: 0,
            counted: false,
            reason: "lower_source_tier_not_compared",
        };
    }));
    const record: Evidence = arbitrationEvidence(conflict, conflict.evidence, decision.outcome, decision.winner, options);
    const result: ArbitrationResult = {
        conflictId: conflict.conflictId,
        claim: conflict.claim,
        outcome: decision.outcome,
        method: decision.method,
        ...(decision.winner === undefined ? {} : { winnerId: decision.winner.evidence.id }),
        reason: decision.reason,
        evidenceIds: conflict.evidenceIds,
        supportScore: support.weight,
        refuteScore: refute.weight,
        scores,
        evidence: record,
    };
    return freezeSnapshot(result);
}

/**
 * Arbitrates evidence conflicts according to refract.md §5.5:
 *
 * 1. Cross-level priority: operation history > user confirmation > web search
 *    > dialogue. The highest source tier on each side decides; lower-tier
 *    evidence cannot outvote a higher-tier fact.
 * 2. Same-level weighting: `reliability × freshness × independence ×
 *    corroboration`, with secondary origin discounted to half and duplicate
 *    independence keys collapsed to one representative sample.
 * 3. Unresolvable or intent conflicts return `escalate_to_human`.
 * 4. Every result carries the frozen `system_rule` arbitration evidence record.
 *
 * Accepts one conflict or a list and always returns a frozen array (one result
 * per conflict, sorted by `conflictId`). Unknown ids, cross-tenant parties and
 * malformed conflicts raise `TypeError`; indecisive disputes escalate rather
 * than throw.
 */
export function arbitrate(
    conflicts: EvidenceConflict | readonly EvidenceConflict[],
    evidenceById: EvidenceIndex,
    options: ArbitrationOptions = {},
): readonly ArbitrationResult[] {
    validateOptions(options);
    const resolved: readonly ResolvedConflict[] = resolveConflicts(conflicts, evidenceById, options);
    const results: readonly ArbitrationResult[] = Object.freeze(resolved
        .map(conflict => arbitrateOne(conflict, options))
        .sort((left, right) => left.conflictId < right.conflictId ? -1 : left.conflictId > right.conflictId ? 1 : 0));
    return freezeSnapshot(results);
}
