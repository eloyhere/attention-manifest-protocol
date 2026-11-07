import type { Identifier, JsonValue } from "../shared.ts";
import type { ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";
import type { BusinessVerification } from "../verification/types.ts";
import { immutableSnapshot } from "../receipt/immutable.ts";

/** Evidence lifecycle states; the four legacy states stay valid and first-class. */
export const EVIDENCE_STATUSES = [
    "captured",
    "active",
    "revoked",
    "stale",
    "pending_revalidation",
    "normalized",
    "validated",
    "corroborated",
    "contested",
    "arbitrated",
    "superseded",
    "archived",
    "purged",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Level of the lifecycle object an evidence item supports (refract.md §5.1). */
export const EVIDENCE_LEVELS = ["action", "task", "plan", "goal", "mission", "intent"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const EVIDENCE_SOURCE_TYPES = [
    "operation_history",
    "user_confirmation",
    "web_search",
    "dialogue",
    "system_rule",
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

/**
 * Where a piece of evidence came from and how much it can be trusted.
 * `reliability` is validated at ingestion to stay inside 0..1.
 */
export interface EvidenceSource {
    readonly type: EvidenceSourceType;
    readonly sourceId?: Identifier;
    readonly domain?: string;
    readonly tool?: Identifier;
    readonly instruction?: string;
    readonly reliability: number;
    /** `original` (default) or `secondary`; secondary evidence is discounted. */
    readonly origin?: "original" | "secondary";
    readonly reproducible?: boolean;
    /** Same key means the same origin; it counts as one effective sample. */
    readonly independenceKey?: string;
}

export interface Evidence {
    readonly id: Identifier;
    readonly tenantId: Identifier;
    readonly dependsOn: readonly Identifier[];
    readonly claim: string;
    readonly polarity: "supports" | "refutes";
    readonly observationId: Identifier;
    readonly receiptId: Identifier;
    readonly verificationId: Identifier;
    readonly integrityVerificationId: Identifier;
    readonly criteriaVersion: string;
    readonly environmentVersion: string;
    readonly createdAt: string;
    readonly expiresAt?: string;
    readonly status: EvidenceStatus;
    readonly parentId?: Identifier;
    readonly agentId?: Identifier;
    readonly cooperationId?: Identifier;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
    readonly level?: EvidenceLevel;
    readonly source?: EvidenceSource;
    readonly corroborationIds?: readonly Identifier[];
    readonly consumedBy?: readonly Identifier[];
    readonly supersededBy?: Identifier;
    readonly freshnessScore?: number;
}

export type ProvenanceEvent =
    | { readonly type: "evidence_added"; readonly evidenceId: Identifier; readonly at: string }
    | { readonly type: "evidence_revoked" | "evidence_staled"; readonly evidenceId: Identifier; readonly reason: string; readonly at: string }
    | { readonly type: "evidence_corroborated"; readonly evidenceId: Identifier; readonly byId: Identifier; readonly at: string }
    | { readonly type: "dependency_invalidated"; readonly sourceId: Identifier; readonly dependentId: Identifier; readonly at: string };

export interface AddEvidenceInput {
    readonly id: Identifier;
    readonly tenantId: Identifier;
    readonly dependsOn?: readonly Identifier[];
    readonly claim: string;
    readonly polarity: "supports" | "refutes";
    readonly receipt: ReceiptCore;
    readonly integrity: ReceiptIntegrityVerification;
    readonly verification: BusinessVerification;
    readonly criteriaVersion: string;
    readonly environmentVersion: string;
    readonly createdAt: string;
    readonly expiresAt?: string;
    readonly level?: EvidenceLevel;
    readonly parentId?: Identifier;
    readonly agentId?: Identifier;
    readonly cooperationId?: Identifier;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
    readonly source?: EvidenceSource;
    readonly corroborationIds?: readonly Identifier[];
    readonly consumedBy?: readonly Identifier[];
    readonly supersededBy?: Identifier;
    readonly freshnessScore?: number;
}

export type EvidenceCause = { readonly kind: "evidence" | "receipt" | "observation" | "verification" | "environment"; readonly id: Identifier; readonly tenantId: Identifier };

const EVIDENCE_TRANSITION_EDGES: Record<EvidenceStatus, readonly EvidenceStatus[]> = {
    captured: ["normalized", "revoked"],
    normalized: ["validated", "revoked"],
    validated: ["active", "revoked"],
    active: ["corroborated", "contested", "stale", "superseded", "revoked", "archived"],
    corroborated: ["active", "contested", "stale", "superseded", "revoked", "archived"],
    contested: ["arbitrated", "superseded", "revoked"],
    arbitrated: ["active", "superseded", "revoked"],
    stale: ["active", "pending_revalidation", "superseded", "revoked"],
    pending_revalidation: ["active", "stale", "superseded", "revoked"],
    superseded: ["archived", "purged"],
    archived: ["purged"],
    revoked: ["purged", "archived"],
    purged: [],
};

/**
 * Evidence lifecycle edges from refract.md §5.2. Legacy `active` remains the
 * ingestion state produced by `EvidenceLedger.add`.
 */
export const EVIDENCE_TRANSITIONS: Readonly<Record<EvidenceStatus, readonly EvidenceStatus[]>> = Object.freeze(
    Object.fromEntries(
        Object.entries(EVIDENCE_TRANSITION_EDGES).map(([state, next]) => [state, Object.freeze([...next])]),
    ) as Record<EvidenceStatus, readonly EvidenceStatus[]>,
);

function nextEvidenceStatus(current: EvidenceStatus, next: EvidenceStatus): EvidenceStatus {
    if (!Object.hasOwn(EVIDENCE_TRANSITIONS, current)) throw new TypeError(`invalid evidence status: ${String(current)}`);
    if (!Object.hasOwn(EVIDENCE_TRANSITIONS, next)) throw new TypeError(`invalid evidence status: ${String(next)}`);
    if (!EVIDENCE_TRANSITIONS[current].includes(next)) throw new TypeError(`invalid evidence transition: ${current} -> ${next}`);
    return next;
}

/**
 * Advances an evidence item along {@link EVIDENCE_TRANSITIONS} and returns a new
 * frozen item; the input is never mutated. A bare status may also be advanced.
 */
export function advanceEvidence(evidence: Evidence, next: EvidenceStatus): Evidence;
export function advanceEvidence(status: EvidenceStatus, next: EvidenceStatus): EvidenceStatus;
export function advanceEvidence(target: Evidence | EvidenceStatus, next: EvidenceStatus): Evidence | EvidenceStatus {
    if (typeof target === "string") return nextEvidenceStatus(target, next);
    nextEvidenceStatus(target.status, next);
    return immutableSnapshot({ ...target, status: next } as unknown as JsonValue) as unknown as Evidence;
}
