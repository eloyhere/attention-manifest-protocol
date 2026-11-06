import type { Identifier } from "../shared.ts";

export type Clock = () => string;
export type ProvenanceRecord = { readonly sourceId: Identifier; readonly sourceType: "agent" | "tool" | "user" | "external" | "derived"; readonly authorityScope?: readonly string[]; readonly chain: readonly Identifier[]; readonly taint: readonly string[] };
export type ValidationTrace = { readonly traceId: Identifier; readonly behaviorId: Identifier; readonly sampleId: Identifier; readonly independenceKey: Identifier; readonly validated: boolean; readonly candidateScore: number; readonly baselineScore: number; readonly validator: Identifier; readonly observedAt: string; readonly provenance: readonly ProvenanceRecord[] };
export type BehaviorCandidateState = "candidate" | "evaluated" | "published" | "revoked";
export type BehaviorReleasePolicy = { readonly minimumIndependentSamples: number; readonly requireComparison: boolean; readonly minimumImprovement: number; readonly minimumPassRate: number };
export type BehaviorCandidate = { readonly candidateId: Identifier; readonly behaviorId: Identifier; readonly version: string; readonly state: BehaviorCandidateState; readonly traces: readonly ValidationTrace[]; readonly independentSampleCount: number; readonly createdAt: string; readonly evaluationId?: Identifier; readonly publishedAt?: string };
export type ComparativeEvaluation = { readonly evaluationId: Identifier; readonly candidateId: Identifier; readonly evaluator: Identifier; readonly independentSampleCount: number; readonly passRate: number; readonly candidateScore: number; readonly baselineScore: number; readonly improvement: number; readonly comparedWith: Identifier; readonly passed: boolean; readonly evaluatedAt: string };
export type BehaviorCandidateInput = { readonly candidateId: Identifier; readonly behaviorId: Identifier; readonly version: string; readonly traces: readonly ValidationTrace[] };
export type ComparativeEvaluationInput = { readonly evaluationId: Identifier; readonly evaluator: Identifier; readonly comparedWith: Identifier; readonly independentSampleCount: number; readonly passRate: number; readonly candidateScore: number; readonly baselineScore: number };
