import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type { BehaviorCandidate, BehaviorCandidateInput, BehaviorReleasePolicy, ComparativeEvaluation, ComparativeEvaluationInput, Clock, ValidationTrace } from "./types.ts";
const clone = <T>(value: T): T => structuredClone(value);
const finite = (value: number): boolean => Number.isFinite(value);
export class BehaviorGovernance {
    private readonly candidates = new SynchronousUnorderedMap<Identifier, BehaviorCandidate>();
    private readonly evaluations = new SynchronousUnorderedMap<Identifier, ComparativeEvaluation>();
    private readonly policy: BehaviorReleasePolicy;
    private readonly clock: Clock;
    constructor(policy: BehaviorReleasePolicy, clock: Clock = () => new Date().toISOString()) {
        this.policy = policy;
        this.clock = clock;
        if (!Number.isSafeInteger(policy.minimumIndependentSamples) || policy.minimumIndependentSamples < 2 || !finite(policy.minimumPassRate) || policy.minimumPassRate < 0 || policy.minimumPassRate > 1 || !finite(policy.minimumImprovement) || policy.minimumImprovement < 0) throw new TypeError("Invalid behavior release policy");
    }
    createCandidate(input: BehaviorCandidateInput): BehaviorCandidate {
        if (this.candidates.containsKey(input.candidateId)) throw new TypeError(`Duplicate behavior candidate: ${input.candidateId}`);
        if (!input.traces.length || input.traces.some(trace => trace.behaviorId !== input.behaviorId || !trace.validated || !finite(trace.candidateScore) || !finite(trace.baselineScore))) throw new TypeError("Candidate requires finite validated traces for matching behavior");
        const independent = new SynchronousUnorderedSet(input.traces.map(trace => trace.independenceKey));
        if (Number(independent.size()) < this.policy.minimumIndependentSamples) throw new TypeError("Candidate requires minimum independent samples");
        const candidate: BehaviorCandidate = { candidateId: input.candidateId, behaviorId: input.behaviorId, version: input.version, state: "candidate", traces: Object.freeze(input.traces.map(clone)), independentSampleCount: Number(independent.size()), createdAt: this.clock() };
        this.candidates.put(candidate.candidateId, clone(candidate)); return clone(candidate);
    }
    getCandidate(candidateId: Identifier): BehaviorCandidate | undefined { const value = this.findCandidate(candidateId); return value.isPresent() ? clone(value.get()) : undefined; }
    findCandidate(candidateId: Identifier): Optional<BehaviorCandidate> { return this.candidates.get(candidateId).map(clone); }
    evaluate(candidateId: Identifier, input: ComparativeEvaluationInput): ComparativeEvaluation {
        const candidate = this.require(candidateId);
        if (this.evaluations.containsKey(input.evaluationId) || !finite(input.passRate) || input.passRate < 0 || input.passRate > 1 || !finite(input.candidateScore) || !finite(input.baselineScore) || !Number.isSafeInteger(input.independentSampleCount) || input.independentSampleCount < 0) throw new TypeError("Invalid comparative evaluation");
        const independent = Number(new SynchronousUnorderedSet(candidate.traces.map(trace => trace.independenceKey)).size());
        const improvement = input.candidateScore - input.baselineScore;
        const passed = independent >= this.policy.minimumIndependentSamples && input.independentSampleCount >= this.policy.minimumIndependentSamples && input.passRate >= this.policy.minimumPassRate && improvement >= this.policy.minimumImprovement && (!this.policy.requireComparison || Boolean(input.comparedWith));
        const evaluation: ComparativeEvaluation = { evaluationId: input.evaluationId, candidateId, evaluator: input.evaluator, independentSampleCount: Math.min(independent, input.independentSampleCount), passRate: input.passRate, candidateScore: input.candidateScore, baselineScore: input.baselineScore, improvement, comparedWith: input.comparedWith, passed, evaluatedAt: this.clock() };
        this.evaluations.put(evaluation.evaluationId, clone(evaluation)); this.candidates.put(candidateId, clone({ ...candidate, state: "evaluated", evaluationId: evaluation.evaluationId })); return clone(evaluation);
    }
    publish(candidateId: Identifier, evaluationId: Identifier): BehaviorCandidate {
        const candidate = this.require(candidateId); const evaluation = this.evaluations.get(evaluationId);
        if (candidate.state !== "evaluated" || candidate.evaluationId !== evaluationId || evaluation.isEmpty() || evaluation.get().candidateId !== candidateId || !evaluation.get().passed) throw new TypeError("Candidate lacks its current passing comparative evaluation");
        const published = { ...candidate, state: "published" as const, publishedAt: this.clock() }; this.candidates.put(candidateId, clone(published)); return clone(published);
    }
    revoke(candidateId: Identifier): BehaviorCandidate { const candidate = this.require(candidateId); const revoked = { ...candidate, state: "revoked" as const }; this.candidates.put(candidateId, clone(revoked)); return clone(revoked); }
    private require(candidateId: Identifier): BehaviorCandidate { const value = this.candidates.get(candidateId); if (value.isEmpty()) throw new TypeError(`Unknown behavior candidate: ${candidateId}`); return clone(value.get()); }
}
export function traceFromValidation(input: ValidationTrace): ValidationTrace { return Object.freeze(clone(input)); }
