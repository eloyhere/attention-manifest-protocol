import type { Identifier } from "../shared.ts";

export type Clock = () => string;
export type ProvenanceRecord = { readonly sourceId: Identifier; readonly sourceType: "agent" | "tool" | "user" | "external" | "derived"; readonly authorityScope?: readonly string[]; readonly chain: readonly Identifier[]; readonly taint: readonly string[] };
export type ValidationTrace = { readonly traceId: Identifier; readonly behaviorId: Identifier; readonly sampleId: Identifier; readonly independenceKey: Identifier; readonly validated: boolean; readonly candidateScore: number; readonly baselineScore: number; readonly validator: Identifier; readonly observedAt: string; readonly provenance: readonly ProvenanceRecord[] };

/* ------------------------------------------------------------------------- */
/* Abstraction inputs (refract §7.5–§7.6)                                    */
/* ------------------------------------------------------------------------- */

/** Behavior categories from refract §7.2. */
export type BehaviorType = "action_pattern" | "strategy" | "failure_recovery" | "decision_pattern" | "attention_pattern";

/** The trace concepts a behavior pattern can be mined from (refract §7.6). */
export type BehaviorTraceStepKind = "tool" | "action" | "plan" | "task" | "goal" | "decision" | "attention" | "other";

export type BehaviorTraceStep = {
    readonly kind: BehaviorTraceStepKind;
    /** Stable step name: a tool id, action id, plan id, or a decision/attention label. */
    readonly name: Identifier;
    readonly outcome?: "success" | "failure";
    /** Capability the step referred to, when the step is a tool/action invocation. */
    readonly capabilityId?: Identifier;
};

/**
 * A completed task trace supplied to the abstraction engine. Only traces with
 * `success: true` can seed a candidate. `independenceKey` follows refract §5.4;
 * when omitted it defaults to `trace:<traceId>`.
 */
export type BehaviorTrace = {
    readonly traceId: Identifier;
    readonly taskId?: Identifier;
    readonly goalId?: Identifier;
    readonly planId?: Identifier;
    readonly success: boolean;
    readonly independenceKey?: Identifier;
    readonly steps: readonly BehaviorTraceStep[];
    readonly observedAt?: string;
    /** Explicitly marked noise (collector-side filter); never seeds a candidate. */
    readonly noisy?: boolean;
};

export type BehaviorAbstractionOptions = {
    readonly candidateId?: Identifier;
    readonly behaviorId?: Identifier;
    readonly version?: string;
    readonly type?: BehaviorType;
    /** Restrict abstraction to one task class. */
    readonly taskId?: Identifier;
    /** Refract §7.4 requires at least three independent successful observations. */
    readonly minimumIndependentSamples?: number;
    /** Fraction of source traces that must contain a step for it to enter the pattern. */
    readonly minimumSupport?: number;
    readonly maximumSteps?: number;
    /** Extra soft success criteria, appended to the derived observable ones. */
    readonly successCriteria?: readonly string[];
    readonly clock?: Clock;
};

/** One aggregated step in the abstracted execution pattern. */
export type BehaviorStepPattern = {
    readonly kind: BehaviorTraceStepKind;
    readonly name: Identifier;
    /** Fraction of successful source traces containing this step. */
    readonly support: number;
    readonly occurrences: number;
};

export type BehaviorSuccessCriterion = {
    readonly criterionId: Identifier;
    readonly kind: "observable" | "soft";
    readonly description: string;
    readonly threshold?: number;
};

export type BehaviorAbstractionSource = {
    readonly traceIds: readonly Identifier[];
    readonly taskIds: readonly Identifier[];
    readonly goalIds: readonly Identifier[];
    readonly planIds: readonly Identifier[];
    readonly toolIds: readonly Identifier[];
};

/** The formalized draft behind a candidate: trigger conditions, mode and success criteria. */
export type BehaviorAbstraction = {
    readonly type: BehaviorType;
    readonly summary: string;
    readonly triggers: readonly string[];
    readonly pattern: readonly BehaviorStepPattern[];
    readonly successCriteria: readonly BehaviorSuccessCriterion[];
    readonly source: BehaviorAbstractionSource;
    readonly independenceKeys: readonly Identifier[];
    /** Traces removed as failed, noisy, task-mismatched, duplicate or step-less. */
    readonly noiseFiltered: number;
    /** Failure-outcome steps removed before aggregation. */
    readonly stepsFiltered: number;
    /** Weakest-link support of the selected pattern (minimum step support). */
    readonly support: number;
    readonly sourceTraceCount: number;
    readonly successfulTraceCount: number;
};
export type BehaviorCandidateState = "candidate" | "evaluated" | "published" | "revoked" | "cooling" | "demoted";
export type BehaviorReleasePolicy = { readonly minimumIndependentSamples: number; readonly requireComparison: boolean; readonly minimumImprovement: number; readonly minimumPassRate: number };
export type BehaviorCandidate = {
    readonly candidateId: Identifier;
    readonly behaviorId: Identifier;
    readonly version: string;
    readonly state: BehaviorCandidateState;
    readonly traces: readonly ValidationTrace[];
    readonly independentSampleCount: number;
    readonly dependsOnBehaviorIds: readonly Identifier[];
    readonly coolingReason?: string;
    readonly demotedReason?: string;
    readonly createdAt: string;
    readonly evaluationId?: Identifier;
    readonly publishedAt?: string;
    /**
     * Present on candidates produced by `abstractBehavior`. `traces` stays
     * empty until comparative validation records exist; the successful source
     * traces are kept in `sourceTraces` for audit.
     */
    readonly abstraction?: BehaviorAbstraction;
    readonly sourceTraces?: readonly BehaviorTrace[];
};
export type ComparativeEvaluation = { readonly evaluationId: Identifier; readonly candidateId: Identifier; readonly evaluator: Identifier; readonly independentSampleCount: number; readonly passRate: number; readonly candidateScore: number; readonly baselineScore: number; readonly improvement: number; readonly comparedWith: Identifier; readonly passed: boolean; readonly evaluatedAt: string };
export type BehaviorCandidateInput = { readonly candidateId: Identifier; readonly behaviorId: Identifier; readonly version: string; readonly traces: readonly ValidationTrace[]; readonly dependsOnBehaviorIds?: readonly Identifier[] };
export type ComparativeEvaluationInput = { readonly evaluationId: Identifier; readonly evaluator: Identifier; readonly comparedWith: Identifier; readonly independentSampleCount: number; readonly passRate: number; readonly candidateScore: number; readonly baselineScore: number };

/* ------------------------------------------------------------------------- */
/* Abstraction evaluation and explicit publication (refract §7.4–§7.5)       */
/* ------------------------------------------------------------------------- */

/** One applicability/success observation for a candidate behavior. */
export type BehaviorEvaluationSample = {
    readonly sampleId: Identifier;
    /** Refract §5.4 independence key; defaults to `sample:<sampleId>`. */
    readonly independenceKey?: Identifier;
    /** False when the trigger did not fire; such samples are excluded from the rate. Defaults to true. */
    readonly applicable?: boolean;
    readonly success: boolean;
    readonly sideEffect?: boolean;
};

export type BehaviorEvaluationOptions = {
    readonly evaluationId?: Identifier;
    readonly minimumPassRate?: number;
    readonly minimumIndependentSamples?: number;
    readonly clock?: Clock;
};

/** Pure evaluation result; it never marks the candidate published. */
export type BehaviorEvaluation = {
    readonly evaluationId: Identifier;
    readonly candidateId: Identifier;
    readonly behaviorId: Identifier;
    readonly sampleCount: number;
    readonly independentSampleCount: number;
    readonly passedCount: number;
    readonly passRate: number;
    readonly minimumPassRate: number;
    readonly thresholdMet: boolean;
    readonly minimumIndependentSamples: number;
    readonly sampleThresholdMet: boolean;
    readonly passed: boolean;
    readonly reasons: readonly string[];
    readonly evaluatedAt: string;
};

/** Declarative cooling / demotion record (refract §7.4). */
export type BehaviorAdjustmentKind = "cooling" | "demote";
export type BehaviorAdjustmentSource = "manual" | "propagation";
export type BehaviorAdjustment = {
    readonly adjustmentId: Identifier;
    readonly candidateId: Identifier;
    readonly behaviorId: Identifier;
    readonly kind: BehaviorAdjustmentKind;
    readonly reason: string;
    readonly source: BehaviorAdjustmentSource;
    /** Present when a cooling propagated from another behavior candidate. */
    readonly causedByCandidateId?: Identifier;
    readonly declaredAt: string;
};

/**
 * Recorded shadow validation result. The governance layer stores the record
 * only; it never runs a model, evaluation harness or network call.
 */
export type BehaviorShadowValidationInput = {
    readonly shadowId: Identifier;
    readonly candidateId: Identifier;
    readonly sampleId: Identifier;
    readonly independenceKey: Identifier;
    readonly validator: Identifier;
    readonly candidateScore: number;
    readonly baselineScore: number;
    readonly passed: boolean;
    readonly observedAt: string;
    readonly notes?: string;
};
export type BehaviorShadowValidation = BehaviorShadowValidationInput & { readonly behaviorId: Identifier };
