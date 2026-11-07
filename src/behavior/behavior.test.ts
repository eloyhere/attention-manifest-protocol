import assert from "node:assert/strict";
import test from "node:test";
import { BehaviorGovernance } from "./index.ts";
import type { ValidationTrace } from "./index.ts";

const clock = (): string => "2026-01-01T00:00:00.000Z";
const policy = { minimumIndependentSamples: 2, requireComparison: true, minimumImprovement: 0.05, minimumPassRate: 0.8 } as const;
const trace = (sampleId: string, independenceKey: string, behaviorId: string): ValidationTrace => ({ traceId: `trace-${sampleId}`, behaviorId, sampleId, independenceKey, validated: true, candidateScore: 0.9, baselineScore: 0.8, validator: "validator", observedAt: clock(), provenance: [] });
const create = (governance: BehaviorGovernance, candidateId: string, behaviorId: string, dependsOnBehaviorIds: readonly string[] = []): void => {
    governance.createCandidate({ candidateId, behaviorId, version: "1", dependsOnBehaviorIds, traces: [trace(`${candidateId}-1`, `${candidateId}-independence-1`, behaviorId), trace(`${candidateId}-2`, `${candidateId}-independence-2`, behaviorId)] });
};
const publish = (governance: BehaviorGovernance, candidateId: string): void => {
    const evaluation = governance.evaluate(candidateId, { evaluationId: `evaluation-${candidateId}`, evaluator: "evaluator", comparedWith: "baseline", independentSampleCount: 2, passRate: 1, candidateScore: 0.9, baselineScore: 0.8 });
    assert.equal(evaluation.passed, true);
    governance.publish(candidateId, evaluation.evaluationId);
};

test("cooling a published behavior records a declarative adjustment", () => {
    const governance = new BehaviorGovernance(policy, clock);
    create(governance, "candidate-a", "behavior-a");
    publish(governance, "candidate-a");
    const cooled = governance.cool("candidate-a", "side effects regressed");
    assert.equal(cooled.state, "cooling");
    assert.equal(cooled.coolingReason, "side effects regressed");
    const adjustments = governance.listAdjustments("candidate-a");
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0]?.kind, "cooling");
    assert.equal(adjustments[0]?.source, "manual");
    assert.equal(governance.getAdjustment(adjustments[0]?.adjustmentId ?? "")?.behaviorId, "behavior-a");
    assert.throws(() => governance.cool("candidate-a", "again"), /Only published/);
});

test("cooling propagates transitively to dependants while leaving unpublished candidates alone", () => {
    const governance = new BehaviorGovernance(policy, clock);
    create(governance, "candidate-a", "behavior-a");
    create(governance, "candidate-b", "behavior-b", ["behavior-a"]);
    create(governance, "candidate-c", "behavior-c", ["behavior-b"]);
    create(governance, "candidate-d", "behavior-d", ["behavior-a"]);
    publish(governance, "candidate-a");
    publish(governance, "candidate-b");
    publish(governance, "candidate-c");
    governance.cool("candidate-a", "quality regression");
    assert.equal(governance.getCandidate("candidate-b")?.state, "demoted");
    assert.equal(governance.getCandidate("candidate-c")?.state, "demoted");
    assert.equal(governance.getCandidate("candidate-d")?.state, "candidate");
    const adjustments = governance.listAdjustments();
    assert.equal(adjustments.length, 3);
    const propagated = adjustments.filter(adjustment => adjustment.source === "propagation");
    assert.equal(propagated.length, 2);
    assert.equal(propagated.every(adjustment => adjustment.kind === "demote" && adjustment.causedByCandidateId === "candidate-a"), true);
    assert.match(governance.getCandidate("candidate-b")?.demotedReason ?? "", /Cooling propagation from behavior behavior-a/);
});

test("demote declares a reason and only accepts published or cooling candidates", () => {
    const governance = new BehaviorGovernance(policy, clock);
    create(governance, "candidate-e", "behavior-e");
    publish(governance, "candidate-e");
    const demoted = governance.demote("candidate-e", "manual override");
    assert.equal(demoted.state, "demoted");
    assert.equal(demoted.demotedReason, "manual override");
    assert.throws(() => governance.demote("candidate-e", "again"), /Only published or cooling/);
    create(governance, "candidate-f", "behavior-f");
    assert.throws(() => governance.demote("candidate-f", "not active"), /Only published or cooling/);
    assert.throws(() => governance.demote("candidate-e", ""), /nonempty string/);
});

test("shadow validation is recorded without executing an evaluation or changing state", () => {
    const governance = new BehaviorGovernance(policy, clock);
    create(governance, "candidate-s", "behavior-s");
    const record = governance.recordShadowValidation({ shadowId: "shadow-1", candidateId: "candidate-s", sampleId: "sample-1", independenceKey: "independent-1", validator: "shadow-runner", candidateScore: 0.91, baselineScore: 0.8, passed: true, observedAt: clock(), notes: "canary" });
    assert.equal(record.behaviorId, "behavior-s");
    assert.equal(record.notes, "canary");
    assert.equal(governance.getCandidate("candidate-s")?.state, "candidate");
    assert.equal(governance.listShadowValidations("candidate-s").length, 1);
    assert.throws(() => governance.recordShadowValidation({ shadowId: "shadow-1", candidateId: "candidate-s", sampleId: "sample-2", independenceKey: "independent-2", validator: "shadow-runner", candidateScore: 0.9, baselineScore: 0.8, passed: true, observedAt: clock() }), /Duplicate shadow validation/);
    assert.throws(() => governance.recordShadowValidation({ shadowId: "shadow-2", candidateId: "candidate-s", sampleId: "sample-3", independenceKey: "independent-3", validator: "shadow-runner", candidateScore: Number.NaN, baselineScore: 0.8, passed: true, observedAt: clock() }), /finite numbers/);
});

test("shadow records never substitute for a comparative evaluation at publication", () => {
    const governance = new BehaviorGovernance(policy, clock);
    create(governance, "candidate-p", "behavior-p");
    governance.recordShadowValidation({ shadowId: "shadow-p", candidateId: "candidate-p", sampleId: "sample-p", independenceKey: "independent-p", validator: "shadow-runner", candidateScore: 0.99, baselineScore: 0.7, passed: true, observedAt: clock() });
    assert.throws(() => governance.publish("candidate-p", "shadow-p"), /current passing comparative evaluation/);
    assert.equal(governance.getCandidate("candidate-p")?.state, "candidate");
});
