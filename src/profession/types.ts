import type { Identifier, JsonValue } from "../shared.ts";

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
/**
 * One case in a profession evaluation set. The executor is injected; this layer
 * never runs models, shadow sandboxes or network calls itself.
 */
export type ProfessionEvaluationCase = {
    readonly caseId: Identifier;
    readonly taskId?: Identifier;
    readonly input?: JsonValue;
};

/** Shadow execution result for one evaluation case. */
export type ProfessionShadowOutcome = {
    readonly success: boolean;
    readonly tokenCost: number;
    readonly sideEffects?: number;
    readonly output?: JsonValue;
};

export type ProfessionShadowExecutor = (testCase: ProfessionEvaluationCase) => ProfessionShadowOutcome | Promise<ProfessionShadowOutcome>;

/**
 * One observed task run used by `evaluateTraces`. Metrics are derived from these
 * facts; an evaluation is never fabricated from a declared score.
 */
export type ProfessionTrace = {
    readonly traceId: Identifier;
    readonly taskId?: Identifier;
    readonly success: boolean;
    /** Measured token cost of this run, averaged into `averageTokens` and summed into `tokenCost`. */
    readonly tokenCost: number;
    /** Number of observable side effects for this run; omitted means zero. */
    readonly sideEffects?: number;
    readonly observedAt?: string;
};

/** One evaluation run; `sampleSize` counts independent task outcomes. */
export type ProfessionEvaluation = {
    readonly evaluationId: Identifier;
    readonly taskSuccessRate: number;
    readonly averageTokens: number;
    readonly sideEffectRate: number;
    readonly sampleSize: number;
    /** Total token cost across the aggregated traces; absent on externally supplied evaluations. */
    readonly tokenCost?: number;
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
