import type { Identifier, JsonValue } from "../shared.ts";
import { immutableSnapshot } from "../receipt/immutable.ts";
import type { Evidence, EvidenceSource, EvidenceSourceType, EvidenceStatus } from "./types.ts";

/**
 * Cross-source priority tiers from refract.md §5.5: a lower tier outranks a
 * higher one (operation history 1 ... dialogue 4). `system_rule` is meta
 * evidence (arbitration records, revocation reasons) and is deliberately not
 * part of the four-tier factual ordering; arbitration rejects it as a normal
 * conflict party and fusion consumes it only as a meta contribution.
 */
export const EVIDENCE_SOURCE_TIERS: Readonly<Record<EvidenceSourceType, number>> = Object.freeze({
    operation_history: 1,
    user_confirmation: 2,
    web_search: 3,
    dialogue: 4,
    system_rule: 5,
});

/** Source types that may act as a factual party in an evidence conflict. */
export const ARBITRATION_SOURCE_TYPES: readonly EvidenceSourceType[] = Object.freeze([
    "operation_history",
    "user_confirmation",
    "web_search",
    "dialogue",
]);

/** Default freshness half-life used when only `createdAt`/`now` are available. */
export const DEFAULT_FRESHNESS_HALF_LIFE_MS: number = 24 * 60 * 60 * 1000;

/** Secondary evidence is discounted to half weight (refract.md §5.4/§5.7). */
export const SECONDARY_ORIGIN_FACTOR: number = 0.5;

/** Statuses whose evidence may be consumed by fusion (refract.md §5.2). */
export const CONSUMABLE_EVIDENCE_STATUSES: readonly EvidenceStatus[] = Object.freeze([
    "active",
    "corroborated",
    "arbitrated",
]);

/** Statuses that may participate in conflict arbitration (contested is the normal case). */
export const ARBITRATION_EVIDENCE_STATUSES: readonly EvidenceStatus[] = Object.freeze([
    "active",
    "corroborated",
    "contested",
    "arbitrated",
]);

export interface FreshnessOptions {
    readonly now?: string;
    readonly halfLifeMs?: number;
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError(`${field} must be a nonempty string`);
    }
    return value;
}

export function requireUnitInterval(value: unknown, field: string): number {
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
        throw new TypeError(`${field} must be a finite number between 0 and 1`);
    }
    return value;
}

export function requirePositiveInteger(value: unknown, field: string): number {
    if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1) {
        throw new TypeError(`${field} must be a positive integer`);
    }
    return value;
}

/** Structural clone plus deep freeze; the input is never mutated. */
export function freezeSnapshot<T>(value: T): T {
    return immutableSnapshot(value as unknown as JsonValue) as unknown as T;
}

export function sourceTier(type: EvidenceSourceType): number {
    const tier: number | undefined = EVIDENCE_SOURCE_TIERS[type];
    if (tier === undefined) throw new TypeError(`invalid evidence source type: ${String(type)}`);
    return tier;
}

export function isArbitrationSourceType(type: EvidenceSourceType): boolean {
    return ARBITRATION_SOURCE_TYPES.includes(type);
}

export function isConsumableEvidenceStatus(status: EvidenceStatus): boolean {
    return CONSUMABLE_EVIDENCE_STATUSES.includes(status);
}

export function isArbitrationEvidenceStatus(status: EvidenceStatus): boolean {
    return ARBITRATION_EVIDENCE_STATUSES.includes(status);
}

/**
 * Validates a source's reliability without inventing a default. Sources are
 * optional on `Evidence`; callers decide whether a missing source is an error
 * (arbitration) or an exclusion (fusion).
 */
export function validateSourceReliability(source: EvidenceSource, evidenceId: Identifier): number {
    return requireUnitInterval(source.reliability, `Evidence source reliability (${evidenceId})`);
}

/**
 * Freshness from `freshnessScore` when supplied, otherwise an exponential
 * half-life decay against `options.now`. With no clock the function is pure and
 * reports 1: callers that need wall-clock decay must pass `now` explicitly.
 */
export function freshnessOf(evidence: Evidence, options: FreshnessOptions = {}): number {
    if (evidence.freshnessScore !== undefined) {
        return requireUnitInterval(evidence.freshnessScore, `Evidence freshnessScore (${evidence.id})`);
    }
    if (options.now === undefined) return 1;
    const now: number = Date.parse(options.now);
    if (!Number.isFinite(now)) throw new TypeError("Freshness now must be an ISO-compatible timestamp");
    if (evidence.expiresAt !== undefined) {
        const expiresAt: number = Date.parse(evidence.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= now) return 0;
    }
    const createdAt: number = Date.parse(evidence.createdAt);
    if (!Number.isFinite(createdAt)) throw new TypeError(`Evidence createdAt must be an ISO-compatible timestamp (${evidence.id})`);
    if (createdAt >= now) return 1;
    const halfLifeMs: number = options.halfLifeMs ?? DEFAULT_FRESHNESS_HALF_LIFE_MS;
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) throw new TypeError("Freshness halfLifeMs must be a positive finite number");
    return 0.5 ** ((now - createdAt) / halfLifeMs);
}

/** `0.5` for secondary origin, `1` otherwise. */
export function originFactorOf(source: EvidenceSource | undefined): number {
    return source?.origin === "secondary" ? SECONDARY_ORIGIN_FACTOR : 1;
}

/**
 * Corroboration multiplier `1 + n`. Corroborators already present in the input
 * set are excluded because they contribute their own sample; self-references
 * are ignored. Duplicate corroboration ids count once.
 */
export function corroborationFactor(evidence: Evidence, presentIds: ReadonlySet<Identifier> = new Set<Identifier>()): number {
    const corroborators = new Set<Identifier>();
    for (const id of evidence.corroborationIds ?? []) {
        if (id !== evidence.id && !presentIds.has(id)) corroborators.add(id);
    }
    return 1 + corroborators.size;
}

/** Stable independence key; evidence without one is independent by its own id. */
export function independenceKeyOf(evidence: Evidence): string {
    return evidence.source?.independenceKey ?? `evidence:${evidence.id}`;
}

/** Effective sample weight: a secondary record counts as half an independent sample. */
export function effectiveSampleWeight(evidence: Evidence): number {
    return evidence.source?.origin === "secondary" ? SECONDARY_ORIGIN_FACTOR : 1;
}

/**
 * Coarse status explanation used by fusion contributions and arbitration
 * scores. Contested is the arbitration input state; fusion treats it as an
 * unresolved conflict rather than silently counting it.
 */
export function evidenceStatusReason(status: EvidenceStatus): string {
    switch (status) {
        case "contested":
            return "unarbitrated_contested";
        case "stale":
            return "stale_evidence";
        case "revoked":
            return "revoked_evidence";
        case "superseded":
            return "superseded_evidence";
        case "purged":
            return "purged_evidence";
        case "archived":
            return "archived_evidence";
        case "pending_revalidation":
            return "pending_revalidation";
        case "captured":
        case "normalized":
        case "validated":
            return "not_active_evidence";
        default:
            return `ineligible_status:${status}`;
    }
}

export function clampUnit(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

/** Rounds only for human-readable arbitration reasons; scores stay exact. */
export function describeScore(value: number): string {
    return value.toFixed(6);
}
