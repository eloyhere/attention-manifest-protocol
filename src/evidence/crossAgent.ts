import type { Identifier } from "../shared.ts";
import type { Evidence, EvidenceSourceType } from "./types.ts";
import {
    CONSUMABLE_EVIDENCE_STATUSES,
    evidenceStatusReason,
    freezeSnapshot,
    originFactorOf,
    requireNonEmptyString,
    requireUnitInterval,
    validateSourceReliability,
} from "./scoring.ts";

/** Default §5.8 entry thresholds; callers may override either gate. */
export const DEFAULT_CROSS_AGENT_MIN_TRUST: number = 0.5;
export const DEFAULT_CROSS_AGENT_MIN_RELIABILITY: number = 0.4;

export interface CrossAgentAcceptanceOptions {
    /** Agent trust level in `[0, 1]`. */
    readonly trustLevel: number;
    /** Whether the agent's receipt passed integrity verification. */
    readonly receiptVerified: boolean;
    /** Minimum trust required to enter fusion (default 0.5). */
    readonly minTrustLevel?: number;
    /** Minimum combined reliability required to enter fusion (default 0.4). */
    readonly minReliability?: number;
    /** Independence keys already counted in the target fusion set. */
    readonly acceptedIndependenceKeys?: readonly string[];
}

/**
 * §5.8 admission decision. `adjustedReliability` is the §5.8 combined
 * reliability (`source baseline × trust × receipt factor`); `weight` is the
 * effective fusion weight after the §5.4 secondary-origin discount. Rejected
 * evidence always weighs 0 and reports every failing gate in `reasons`.
 */
export interface CrossAgentAcceptance {
    readonly evidenceId: Identifier;
    readonly accepted: boolean;
    readonly weight: number;
    readonly adjustedReliability: number;
    readonly sourceReliability: number;
    readonly sourceType: EvidenceSourceType | null;
    readonly trustLevel: number;
    readonly receiptVerified: boolean;
    readonly receiptFactor: number;
    readonly originFactor: number;
    readonly independent: boolean;
    readonly independenceKey: string | null;
    readonly reasons: readonly string[];
}

function validateOptions(options: CrossAgentAcceptanceOptions): {
    readonly trustLevel: number;
    readonly minTrustLevel: number;
    readonly minReliability: number;
    readonly acceptedKeys: ReadonlySet<string>;
} {
    if (options === null || typeof options !== "object") throw new TypeError("Cross-agent options must be an object");
    const trustLevel: number = requireUnitInterval(options.trustLevel, "Cross-agent trustLevel");
    if (typeof options.receiptVerified !== "boolean") throw new TypeError("Cross-agent receiptVerified must be a boolean");
    const minTrustLevel: number = options.minTrustLevel === undefined
        ? DEFAULT_CROSS_AGENT_MIN_TRUST
        : requireUnitInterval(options.minTrustLevel, "Cross-agent minTrustLevel");
    const minReliability: number = options.minReliability === undefined
        ? DEFAULT_CROSS_AGENT_MIN_RELIABILITY
        : requireUnitInterval(options.minReliability, "Cross-agent minReliability");
    const acceptedKeys = new Set<string>();
    if (options.acceptedIndependenceKeys !== undefined) {
        if (!Array.isArray(options.acceptedIndependenceKeys)) {
            throw new TypeError("Cross-agent acceptedIndependenceKeys must be an array");
        }
        for (const key of options.acceptedIndependenceKeys) {
            acceptedKeys.add(requireNonEmptyString(key, "Cross-agent accepted independence key"));
        }
    }
    return { trustLevel, minTrustLevel, minReliability, acceptedKeys };
}

/**
 * Decides whether cross-agent evidence may enter fusion (refract.md §5.8).
 *
 * Entry requires all of: trust ≥ threshold, a verified receipt, a passing
 * independence check (its `independenceKey` is not already accepted), a source
 * reliability baseline, a consumable evidence status, and combined reliability
 * above the configured gate. A missing source, dialogue evidence (hard rule 2)
 * and inactive evidence are rejected with explicit reasons.
 *
 * Pure: validates but never mutates or records the evidence.
 */
export function crossAgentAcceptance(evidence: Evidence, options: CrossAgentAcceptanceOptions): CrossAgentAcceptance {
    if (evidence === null || typeof evidence !== "object") throw new TypeError("Cross-agent evidence must be an object");
    requireNonEmptyString(evidence.id, "Cross-agent evidence id");
    const validated = validateOptions(options);
    const reasons: string[] = [];
    const source = evidence.source;
    const sourceReliability: number = source === undefined ? 0 : validateSourceReliability(source, evidence.id);
    const independenceKey: string | null = source?.independenceKey ?? null;
    const independent: boolean = independenceKey === null || !validated.acceptedKeys.has(independenceKey);
    const receiptFactor: number = options.receiptVerified ? 1 : 0;
    const originFactor: number = originFactorOf(source);
    const adjustedReliability: number = sourceReliability * validated.trustLevel * receiptFactor;
    const fusionWeight: number = adjustedReliability * originFactor;
    if (source === undefined) {
        reasons.push("missing_source");
    } else {
        if (source.type === "dialogue") reasons.push("dialogue_history_not_verification_evidence");
    }
    if (!CONSUMABLE_EVIDENCE_STATUSES.includes(evidence.status)) reasons.push(evidenceStatusReason(evidence.status));
    if (!options.receiptVerified) reasons.push("receipt_not_verified");
    if (validated.trustLevel < validated.minTrustLevel) reasons.push("trust_below_threshold");
    if (!independent) reasons.push("independence_conflict");
    // Report the reliability gate only when every preceding gate passed: a
    // receipt/trust failure already forces weight 0 and is the actionable reason.
    if (source !== undefined && options.receiptVerified && validated.trustLevel >= validated.minTrustLevel && independent
        && adjustedReliability < validated.minReliability) {
        reasons.push("combined_reliability_below_threshold");
    }
    const accepted: boolean = reasons.length === 0;
    const result: CrossAgentAcceptance = {
        evidenceId: evidence.id,
        accepted,
        weight: accepted ? fusionWeight : 0,
        adjustedReliability,
        sourceReliability,
        sourceType: source?.type ?? null,
        trustLevel: validated.trustLevel,
        receiptVerified: options.receiptVerified,
        receiptFactor,
        originFactor,
        independent,
        independenceKey,
        reasons: Object.freeze([...reasons]),
    };
    return freezeSnapshot(result);
}
