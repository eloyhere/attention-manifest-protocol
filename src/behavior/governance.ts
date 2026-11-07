import { Optional, SynchronousUnorderedMap, SynchronousUnorderedSet } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type {
    BehaviorAdjustment,
    BehaviorAdjustmentKind,
    BehaviorAdjustmentSource,
    BehaviorCandidate,
    BehaviorCandidateInput,
    BehaviorReleasePolicy,
    BehaviorShadowValidation,
    BehaviorShadowValidationInput,
    ComparativeEvaluation,
    ComparativeEvaluationInput,
    Clock,
    ValidationTrace,
} from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);
const finite = (value: number): boolean => Number.isFinite(value);
const fail = (message: string): never => {
    throw new TypeError(message);
};
const requireText = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);

export class BehaviorGovernance {
    private readonly candidates = new SynchronousUnorderedMap<Identifier, BehaviorCandidate>();
    private readonly evaluations = new SynchronousUnorderedMap<Identifier, ComparativeEvaluation>();
    private readonly adjustments = new SynchronousUnorderedMap<Identifier, BehaviorAdjustment>();
    private readonly shadowValidations = new SynchronousUnorderedMap<Identifier, BehaviorShadowValidation>();
    private adjustmentSequence = 0;
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
        const dependsOnBehaviorIds = input.dependsOnBehaviorIds ?? [];
        if (!Array.isArray(dependsOnBehaviorIds)) fail("Candidate dependsOnBehaviorIds must be an array");
        const dependencies = new SynchronousUnorderedSet<Identifier>();
        for (const behaviorId of dependsOnBehaviorIds) {
            requireText(behaviorId, "Candidate dependency behaviorId");
            if (behaviorId === input.behaviorId) fail("Behavior candidate cannot depend on itself");
            if (!dependencies.add(behaviorId)) fail(`Duplicate behavior dependency: ${behaviorId}`);
        }
        const candidate: BehaviorCandidate = { candidateId: input.candidateId, behaviorId: input.behaviorId, version: input.version, state: "candidate", traces: Object.freeze(input.traces.map(clone)), independentSampleCount: Number(independent.size()), dependsOnBehaviorIds: Object.freeze([...dependsOnBehaviorIds]), createdAt: this.clock() };
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

    /**
     * Declares cooling for a published behavior. Cooling then propagates along
     * declared `dependsOnBehaviorIds` edges: published or cooling dependents are
     * demoted transitively, one adjustment record per affected candidate.
     */
    cool(candidateId: Identifier, reason: string): BehaviorCandidate {
        const candidate = this.require(candidateId);
        const coolingReason = requireText(reason, "Cooling reason");
        if (candidate.state !== "published") fail("Only published behavior candidates may cool");
        const updates = new Map<Identifier, BehaviorCandidate>();
        updates.set(candidateId, Object.freeze({ ...candidate, state: "cooling", coolingReason }));
        const queue: Identifier[] = [candidate.behaviorId];
        const expanded = new Set<Identifier>([candidate.behaviorId]);
        while (queue.length > 0) {
            const behaviorId = queue.shift() as Identifier;
            for (const dependent of this.candidates.values().toArray()) {
                if (updates.has(dependent.candidateId) || !dependent.dependsOnBehaviorIds.includes(behaviorId)) continue;
                if (dependent.state !== "published" && dependent.state !== "cooling") continue;
                const propagatedReason = `Cooling propagation from behavior ${candidate.behaviorId}: ${coolingReason}`;
                updates.set(dependent.candidateId, Object.freeze({ ...dependent, state: "demoted", demotedReason: propagatedReason }));
                if (!expanded.has(dependent.behaviorId)) {
                    expanded.add(dependent.behaviorId);
                    queue.push(dependent.behaviorId);
                }
            }
        }
        const adjustments: BehaviorAdjustment[] = [this.declareAdjustment(candidate, "cooling", coolingReason, "manual")];
        for (const updated of updates.values()) {
            if (updated.candidateId === candidateId) continue;
            adjustments.push(this.declareAdjustment(updated, "demote", updated.demotedReason ?? coolingReason, "propagation", candidateId));
        }
        for (const updated of updates.values()) this.candidates.put(updated.candidateId, clone(updated));
        for (const adjustment of adjustments) this.adjustments.put(adjustment.adjustmentId, clone(adjustment));
        return clone(updates.get(candidateId) as BehaviorCandidate);
    }
    /** Demotes a published or cooling behavior without propagating further. */
    demote(candidateId: Identifier, reason: string): BehaviorCandidate {
        const candidate = this.require(candidateId);
        const demoteReason = requireText(reason, "Demote reason");
        if (candidate.state !== "published" && candidate.state !== "cooling") fail("Only published or cooling behavior candidates may demote");
        const updated: BehaviorCandidate = Object.freeze({ ...candidate, state: "demoted", demotedReason: demoteReason });
        const adjustment = this.declareAdjustment(updated, "demote", demoteReason, "manual");
        this.candidates.put(candidateId, clone(updated));
        this.adjustments.put(adjustment.adjustmentId, clone(adjustment));
        return clone(updated);
    }
    getAdjustment(adjustmentId: Identifier): BehaviorAdjustment | undefined { const value = this.adjustments.get(adjustmentId); return value.isPresent() ? clone(value.get()) : undefined; }
    listAdjustments(candidateId?: Identifier): BehaviorAdjustment[] { return this.adjustments.values().toArray().filter(adjustment => candidateId === undefined || adjustment.candidateId === candidateId).map(clone); }

    /**
     * Records a shadow validation observation without running any evaluation.
     * Shadow records never mutate candidate state or comparative evaluations.
     */
    recordShadowValidation(input: BehaviorShadowValidationInput): BehaviorShadowValidation {
        const candidate = this.require(input.candidateId);
        const shadowId = requireText(input.shadowId, "Shadow validation id");
        if (this.shadowValidations.containsKey(shadowId)) fail(`Duplicate shadow validation: ${shadowId}`);
        requireText(input.sampleId, "Shadow sampleId");
        requireText(input.independenceKey, "Shadow independenceKey");
        requireText(input.validator, "Shadow validator");
        requireText(input.observedAt, "Shadow observedAt");
        if (typeof input.passed !== "boolean") fail("Shadow passed must be a boolean");
        if (!finite(input.candidateScore) || !finite(input.baselineScore)) fail("Shadow scores must be finite numbers");
        const record: BehaviorShadowValidation = { ...clone(input), shadowId, behaviorId: candidate.behaviorId };
        this.shadowValidations.put(shadowId, clone(record));
        return clone(record);
    }
    getShadowValidation(shadowId: Identifier): BehaviorShadowValidation | undefined { const value = this.shadowValidations.get(shadowId); return value.isPresent() ? clone(value.get()) : undefined; }
    listShadowValidations(candidateId?: Identifier): BehaviorShadowValidation[] { return this.shadowValidations.values().toArray().filter(record => candidateId === undefined || record.candidateId === candidateId).map(clone); }

    private declareAdjustment(candidate: BehaviorCandidate, kind: BehaviorAdjustmentKind, reason: string, source: BehaviorAdjustmentSource, causedByCandidateId?: Identifier): BehaviorAdjustment {
        this.adjustmentSequence += 1;
        return Object.freeze({ adjustmentId: `adjustment:${this.adjustmentSequence}`, candidateId: candidate.candidateId, behaviorId: candidate.behaviorId, kind, reason, source, ...(causedByCandidateId === undefined ? {} : { causedByCandidateId }), declaredAt: this.clock() });
    }
    private require(candidateId: Identifier): BehaviorCandidate { const value = this.candidates.get(candidateId); if (value.isEmpty()) return fail(`Unknown behavior candidate: ${candidateId}`); return clone(value.get()); }
}
export function traceFromValidation(input: ValidationTrace): ValidationTrace { return Object.freeze(clone(input)); }
