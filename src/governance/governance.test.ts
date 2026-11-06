import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityRegistry } from "../capability/index.ts";
import { BehaviorGovernance } from "../behavior/index.ts";
import { CooperationCoordinator } from "../cooperation/index.ts";
import { intersectPermissionScopes, restrictByProfession } from "../profession/index.ts";
import type { CapabilityDefinition, PermissionScope, Profession, ValidationTrace } from "./types.ts";

const clock = (): string => "2026-01-01T00:00:00.000Z";
const scope = (allowWrite = true): PermissionScope => ({ capabilityIds: ["read", "write"], operations: ["inspect", "mutate"], resources: ["workspace"], allowWrite });
const definition = (id: string, version = "1"): CapabilityDefinition => ({ id, version, kind: "tool", digest: `${id}-${version}`, contract: null, dependencies: [], risk: "low", definedAt: clock() });

test("registry lists definitions through semantic stream and latest follows insertion order", () => {
    const registry = new CapabilityRegistry(clock);
    registry.define(definition("a"));
    assert.equal(registry.list().length, 1);
    for (let index = 0; index < 10; index += 1) registry.activate("a", "1");
    const latest = registry.latestUsable("a");
    assert.equal(latest?.activationId, "a@1#10");
});

test("registry invalidates resolved fallback and dependent activations", () => {
    const registry = new CapabilityRegistry(clock);
    registry.define(definition("fallback"));
    registry.define({ ...definition("main"), dependencies: [{ capabilityId: "missing", version: "1", required: true, fallback: { capabilityId: "fallback", version: "1" } }] });
    const fallback = registry.activate("fallback", "1");
    const main = registry.activate("main", "1");
    assert.equal(main.status, "degraded");
    registry.invalidate(fallback.activationId, "fallback revoked");
    assert.equal(registry.latestUsable("fallback"), undefined);
    const next = registry.activate("main", "1");
    assert.equal(next.status, "failed");
});

test("profession narrows scope and never grants authority", () => {
    const profession: Profession = { id: "reviewer", version: "1", allowedCapabilityIds: ["read"], deniedCapabilityIds: [], verificationStrictness: "strict", riskPreference: "low" };
    assert.deepEqual(restrictByProfession(scope(), profession).capabilityIds, ["read"]);
    assert.deepEqual(intersectPermissionScopes(scope(), { ...scope(), capabilityIds: ["write"] }).capabilityIds, ["write"]);
});

test("cooperation rejects cancellation and unknown outcome transfer", () => {
    const coordinator = new CooperationCoordinator(clock);
    const task = coordinator.delegate({ taskId: "t", delegatorAgentId: "parent", ownerAgentId: "child", parentScope: scope(), requestedScope: { ...scope(), capabilityIds: ["read"] } });
    coordinator.start("t", "child", task.ownerEpoch, task.fence);
    coordinator.cancel("t", "child", task.ownerEpoch, task.fence, "stop");
    assert.throws(() => coordinator.transfer("t", "replacement"));
    const unknownTask = coordinator.delegate({ taskId: "unknown-task", delegatorAgentId: "parent", ownerAgentId: "child", parentScope: scope(), requestedScope: scope() });
    coordinator.start("unknown-task", "child", unknownTask.ownerEpoch, unknownTask.fence);
    const unknown = coordinator.submitResult({ taskId: "unknown-task", ownerAgentId: "child", ownerEpoch: unknownTask.ownerEpoch, fence: unknownTask.fence, outcome: "unknown_outcome", provenance: [] });
    assert.equal(unknown.accepted, true);
    assert.throws(() => coordinator.transfer("unknown-task", "replacement"));
});

test("cooperation fences old owner and preserves provenance messages", () => {
    const coordinator = new CooperationCoordinator(clock);
    const task = coordinator.delegate({ taskId: "t2", delegatorAgentId: "parent", ownerAgentId: "child", parentScope: scope(), requestedScope: { ...scope(), capabilityIds: ["read"] } });
    coordinator.start("t2", "child", task.ownerEpoch, task.fence);
    const transferred = coordinator.transfer("t2", "replacement");
    const late = coordinator.submitResult({ taskId: "t2", ownerAgentId: "child", ownerEpoch: task.ownerEpoch, fence: task.fence, outcome: "success", provenance: [] });
    assert.equal(late.reason, "not_owner");
    assert.equal(coordinator.submitResult({ taskId: "t2", ownerAgentId: "replacement", ownerEpoch: transferred.ownerEpoch, fence: transferred.fence, outcome: "success", provenance: [] }).accepted, true);
    const message = coordinator.storeMessage({ messageId: "m", taskId: "t2", senderAgentId: "child", recipientAgentId: "parent", kind: "untrustedData", payload: "data", provenance: [{ sourceId: "external", sourceType: "external", chain: ["external"], taint: ["untrusted"] }], sentAt: clock() });
    assert.equal(coordinator.getMessage("m")?.kind, message.kind);
});

test("behavior requires independent samples, rejects NaN, and binds publication to current evaluation", () => {
    const governance = new BehaviorGovernance({ minimumIndependentSamples: 2, requireComparison: true, minimumImprovement: 0.05, minimumPassRate: 0.8 }, clock);
    const trace = (sampleId: string, independenceKey: string): ValidationTrace => ({ traceId: `trace-${sampleId}`, behaviorId: "b", sampleId, independenceKey, validated: true, candidateScore: 0.9, baselineScore: 0.8, validator: "v", observedAt: clock(), provenance: [] });
    const candidate = governance.createCandidate({ candidateId: "c", behaviorId: "b", version: "1", traces: [trace("1", "a"), trace("2", "b")] });
    assert.throws(() => governance.evaluate(candidate.candidateId, { evaluationId: "nan", evaluator: "eval", comparedWith: "baseline", independentSampleCount: 2, passRate: Number.NaN, candidateScore: 0.9, baselineScore: 0.8 }));
    const passing = governance.evaluate(candidate.candidateId, { evaluationId: "pass", evaluator: "eval", comparedWith: "baseline", independentSampleCount: 2, passRate: 1, candidateScore: 0.9, baselineScore: 0.8 });
    const failing = governance.evaluate(candidate.candidateId, { evaluationId: "fail", evaluator: "eval", comparedWith: "baseline", independentSampleCount: 2, passRate: 0, candidateScore: 0.8, baselineScore: 0.8 });
    assert.throws(() => governance.publish(candidate.candidateId, passing.evaluationId));
    assert.throws(() => governance.publish(candidate.candidateId, failing.evaluationId));
});
