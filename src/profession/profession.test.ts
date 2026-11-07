import assert from "node:assert/strict";
import test from "node:test";
import { ProfessionRegistry, certify, composeProfessionRestrictions, recertify, restrictByProfession } from "./index.ts";
import type { PermissionScope, Profession, ProfessionEvaluation, ProfessionProfile } from "./index.ts";

const clock = (): string => "2026-01-01T00:00:00.000Z";
const scope = (allowWrite = true): PermissionScope => ({ capabilityIds: ["read", "write", "deploy"], operations: ["inspect", "mutate"], resources: ["workspace", "production"], allowWrite });
const requirements = { minimumTaskSuccessRate: 0.8, minimumSampleSize: 3, maximumSideEffectRate: 0.1, maximumAverageTokens: 1000 } as const;
const profile = (overrides: Partial<ProfessionProfile> = {}): ProfessionProfile => ({
    id: "developer",
    name: "Developer",
    version: "1",
    permissionScope: scope(),
    deniedCapabilityIds: ["deploy"],
    scores: { taskSuccessRate: 0.5, averageTokens: 500, sideEffectRate: 0.2, sampleSize: 1 },
    certificationStatus: "uncertified",
    requirements,
    lifecycle: [{ eventType: "defined", at: clock() }],
    ...overrides,
});
const evaluation = (overrides: Partial<ProfessionEvaluation> = {}): ProfessionEvaluation => ({
    evaluationId: "eval-1",
    taskSuccessRate: 0.9,
    averageTokens: 400,
    sideEffectRate: 0.02,
    sampleSize: 5,
    evaluator: "evaluator",
    evaluatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
});

test("certify updates scores and lifecycle only after every threshold passes", () => {
    const before = profile();
    const after = certify(before, evaluation());
    assert.equal(after.certificationStatus, "certified");
    assert.equal(after.certifiedAt, "2026-02-01T00:00:00.000Z");
    assert.deepEqual(after.scores, { taskSuccessRate: 0.9, averageTokens: 400, sideEffectRate: 0.02, sampleSize: 5 });
    assert.equal(after.lifecycle?.at(-1)?.eventType, "certified");
    assert.deepEqual(before, profile());
});

test("certification threshold failures leave the input profile untouched", () => {
    const before = profile();
    assert.throws(() => certify(before, evaluation({ sampleSize: 1 })), /at least 3 samples/);
    assert.throws(() => certify(before, evaluation({ taskSuccessRate: 0.5 })), /taskSuccessRate/);
    assert.throws(() => certify(before, evaluation({ sideEffectRate: 0.5 })), /sideEffectRate/);
    assert.throws(() => certify(before, evaluation({ averageTokens: 5000 })), /averageTokens/);
    assert.deepEqual(before, profile());
});

test("registry certification failure rolls back and keeps the uncertified record", () => {
    const registry = new ProfessionRegistry();
    const before = registry.register(profile());
    assert.throws(() => registry.certify("developer", evaluation({ taskSuccessRate: 0.1 })), /taskSuccessRate/);
    assert.deepEqual(registry.get("developer"), before);
    const certified = registry.certify("developer", evaluation());
    assert.equal(certified.certificationStatus, "certified");
    assert.equal(registry.get("developer")?.certificationStatus, "certified");
    assert.throws(() => registry.register(profile()), /Duplicate profession profile/);
});

test("recertify requires a certified profile and preserves the previous certification on failure", () => {
    const certified = certify(profile(), evaluation());
    const recertified = recertify(certified, evaluation({ evaluationId: "eval-2", taskSuccessRate: 0.95, sampleSize: 10 }));
    assert.equal(recertified.certificationStatus, "recertified");
    assert.equal(recertified.scores.sampleSize, 10);
    assert.equal(recertified.lifecycle?.at(-1)?.eventType, "recertified");
    assert.throws(() => recertify(profile(), evaluation()), /must be certified/);
    const registry = new ProfessionRegistry();
    registry.register(certified);
    assert.throws(() => registry.recertify("developer", evaluation({ evaluationId: "bad", sampleSize: 1 })), /at least 3 samples/);
    assert.equal(registry.get("developer")?.certificationStatus, "certified");
    assert.equal(registry.get("developer")?.evaluationId, "eval-1");
});

test("restrictByProfession composes profile scope, denied capabilities and legacy professions", () => {
    const scoped = scope(true);
    const developer = profile({ permissionScope: { capabilityIds: ["read", "write"], operations: ["inspect"], resources: ["workspace"], allowWrite: true }, deniedCapabilityIds: ["write"] });
    const restricted = restrictByProfession(scoped, developer);
    assert.deepEqual(restricted, { capabilityIds: ["read"], operations: ["inspect"], resources: ["workspace"], allowWrite: true });
    const legacy: Profession = { id: "reviewer", version: "1", allowedCapabilityIds: ["read"], deniedCapabilityIds: [], verificationStrictness: "strict", riskPreference: "low" };
    assert.deepEqual(restrictByProfession(scoped, legacy).capabilityIds, ["read"]);
    const readOnly = profile({ permissionScope: { capabilityIds: ["read"], operations: ["inspect"], resources: ["workspace"], allowWrite: false }, deniedCapabilityIds: [] });
    const composed = composeProfessionRestrictions(scoped, [legacy, readOnly]);
    assert.deepEqual(composed, { capabilityIds: ["read"], operations: ["inspect"], resources: ["workspace"], allowWrite: false });
});

test("empty or malformed profiles are rejected before certification", () => {
    assert.throws(() => certify({ ...profile(), name: "" }, evaluation()), /name/);
    assert.throws(() => certify(profile({ scores: { taskSuccessRate: Number.NaN, averageTokens: 1, sideEffectRate: 0, sampleSize: 3 } }), evaluation()), /taskSuccessRate/);
    const registry = new ProfessionRegistry();
    assert.throws(() => registry.register({ ...profile(), certificationStatus: "unknown" as ProfessionProfile["certificationStatus"] }), /certification status/);
});
