import type { Identifier } from "../shared.ts";

export type Profession = {
    readonly id: Identifier;
    readonly version: string;
    readonly allowedCapabilityIds: readonly Identifier[];
    readonly deniedCapabilityIds: readonly Identifier[];
    readonly verificationStrictness: "standard" | "strict" | "paranoid";
    readonly riskPreference: "low" | "balanced" | "high";
};

export type PermissionScope = {
    readonly capabilityIds: readonly Identifier[];
    readonly operations: readonly string[];
    readonly resources: readonly string[];
    readonly allowWrite: boolean;
};

/** Profile evaluation scores from refract §8.1. */
export type ProfessionProfileScores = {
    readonly taskSuccessRate: number;
    readonly averageTokens: number;
    readonly sideEffectRate: number;
    readonly sampleSize: number;
};
export type ProfessionCertificationStatus = "uncertified" | "certified" | "recertified" | "deprecated";
/** Declarative thresholds used by `certify` / `recertify`. */
export type ProfessionCertificationRequirements = {
    readonly minimumTaskSuccessRate: number;
    readonly minimumSampleSize: number;
    readonly maximumSideEffectRate: number;
    readonly maximumAverageTokens?: number;
};
/** One evaluation run; `sampleSize` counts independent task outcomes. */
export type ProfessionEvaluation = {
    readonly evaluationId: Identifier;
    readonly taskSuccessRate: number;
    readonly averageTokens: number;
    readonly sideEffectRate: number;
    readonly sampleSize: number;
    readonly evaluator: Identifier;
    readonly evaluatedAt: string;
};
export type ProfessionLifecycleEventType = "defined" | "certified" | "recertified" | "restricted" | "deprecated";
export type ProfessionLifecycleEvent = { readonly eventType: ProfessionLifecycleEventType; readonly at: string; readonly detail?: string };

/**
 * A profession profile (refract §8.1): declared permission scope, denied
 * capabilities, evaluation scores, certification state and lifecycle events.
 * `scores` describe observed evidence; certification never invents scores.
 */
export type ProfessionProfile = {
    readonly id: Identifier;
    readonly name: string;
    readonly summary?: string;
    readonly version: string;
    readonly permissionScope: PermissionScope;
    readonly deniedCapabilityIds: readonly Identifier[];
    readonly scores: ProfessionProfileScores;
    readonly certificationStatus: ProfessionCertificationStatus;
    /** Optional: defaults to `DEFAULT_PROFESSION_REQUIREMENTS` when omitted. */
    readonly requirements?: ProfessionCertificationRequirements;
    readonly certifiedAt?: string;
    readonly evaluationId?: Identifier;
    readonly lifecycle?: readonly ProfessionLifecycleEvent[];
};
