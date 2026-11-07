import type { Identifier } from "../shared.ts";

export type Clock = () => string;
export type ProvenanceRecord = { readonly sourceId: Identifier; readonly sourceType: "agent" | "tool" | "user" | "external" | "derived"; readonly authorityScope?: readonly string[]; readonly chain: readonly Identifier[]; readonly taint: readonly string[] };
export type ValidationTrace = { readonly traceId: Identifier; readonly behaviorId: Identifier; readonly sampleId: Identifier; readonly independenceKey: Identifier; readonly validated: boolean; readonly candidateScore: number; readonly baselineScore: number; readonly validator: Identifier; readonly observedAt: string; readonly provenance: readonly ProvenanceRecord[] };
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
};
export type ComparativeEvaluation = { readonly evaluationId: Identifier; readonly candidateId: Identifier; readonly evaluator: Identifier; readonly independentSampleCount: number; readonly passRate: number; readonly candidateScore: number; readonly baselineScore: number; readonly improvement: number; readonly comparedWith: Identifier; readonly passed: boolean; readonly evaluatedAt: string };
export type BehaviorCandidateInput = { readonly candidateId: Identifier; readonly behaviorId: Identifier; readonly version: string; readonly traces: readonly ValidationTrace[]; readonly dependsOnBehaviorIds?: readonly Identifier[] };
export type ComparativeEvaluationInput = { readonly evaluationId: Identifier; readonly evaluator: Identifier; readonly comparedWith: Identifier; readonly independentSampleCount: number; readonly passRate: number; readonly candidateScore: number; readonly baselineScore: number };

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
