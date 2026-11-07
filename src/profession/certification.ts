import { SynchronousUnorderedMap } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import { restrictByProfession } from "./policy.ts";
import type {
    PermissionScope,
    ProfessionCertificationRequirements,
    ProfessionCertificationStatus,
    ProfessionEvaluation,
    ProfessionLifecycleEvent,
    ProfessionProfile,
    ProfessionProfileScores,
} from "./types.ts";

const clone = <T>(value: T): T => structuredClone(value);
const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const rate = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail(`${field} must be a finite number between 0 and 1`);
    return value as number;
};
const nonNegative = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${field} must be a finite number >= 0`);
    return value as number;
};
const count = (value: unknown, field: string, minimum = 0): number => Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : fail(`${field} must be a safe integer >= ${minimum}`);

export const DEFAULT_PROFESSION_REQUIREMENTS: ProfessionCertificationRequirements = Object.freeze({
    minimumTaskSuccessRate: 0.8,
    minimumSampleSize: 3,
    maximumSideEffectRate: 0.05,
});
const CERTIFICATION_STATUSES: readonly ProfessionCertificationStatus[] = ["uncertified", "certified", "recertified", "deprecated"];
const CERTIFICATION_EVENTS: readonly ProfessionLifecycleEvent["eventType"][] = ["defined", "certified", "recertified", "restricted", "deprecated"];

const validateScope = (scope: PermissionScope): void => {
    if (scope === null || typeof scope !== "object") fail("Profession permissionScope must be an object");
    for (const field of ["capabilityIds", "operations", "resources"] as const) {
        if (!Array.isArray(scope[field])) fail(`Profession permissionScope.${field} must be an array`);
        for (const item of scope[field]) text(item, `Profession permissionScope.${field} item`);
    }
    if (typeof scope.allowWrite !== "boolean") fail("Profession permissionScope.allowWrite must be a boolean");
};
const validateScores = (scores: ProfessionProfileScores, field: string): void => {
    if (scores === null || typeof scores !== "object") fail(`${field} must be an object`);
    rate(scores.taskSuccessRate, `${field}.taskSuccessRate`);
    nonNegative(scores.averageTokens, `${field}.averageTokens`);
    rate(scores.sideEffectRate, `${field}.sideEffectRate`);
    count(scores.sampleSize, `${field}.sampleSize`);
};
/** Validates declarative certification thresholds without running an evaluation. */
export const validateCertificationRequirements = (requirements: ProfessionCertificationRequirements): void => {
    if (requirements === null || typeof requirements !== "object") fail("Profession requirements must be an object");
    rate(requirements.minimumTaskSuccessRate, "Profession requirements.minimumTaskSuccessRate");
    count(requirements.minimumSampleSize, "Profession requirements.minimumSampleSize", 1);
    rate(requirements.maximumSideEffectRate, "Profession requirements.maximumSideEffectRate");
    if (requirements.maximumAverageTokens !== undefined) nonNegative(requirements.maximumAverageTokens, "Profession requirements.maximumAverageTokens");
};
const validateEvaluation = (evaluation: ProfessionEvaluation): void => {
    if (evaluation === null || typeof evaluation !== "object") fail("Profession evaluation must be an object");
    text(evaluation.evaluationId, "Profession evaluation id");
    text(evaluation.evaluator, "Profession evaluation evaluator");
    text(evaluation.evaluatedAt, "Profession evaluation evaluatedAt");
    validateScores(evaluation, "Profession evaluation");
    if (evaluation.tokenCost !== undefined) nonNegative(evaluation.tokenCost, "Profession evaluation tokenCost");
};

/** Validates a profile's shape and score ranges; throws without mutating it. */
export const validateProfessionProfile = (profile: ProfessionProfile): void => {
    if (profile === null || typeof profile !== "object") fail("Profession profile must be an object");
    text(profile.id, "Profession profile id");
    text(profile.name, "Profession profile name");
    text(profile.version, "Profession profile version");
    if (!CERTIFICATION_STATUSES.includes(profile.certificationStatus)) fail(`Invalid profession certification status: ${profile.certificationStatus}`);
    validateScope(profile.permissionScope);
    if (!Array.isArray(profile.deniedCapabilityIds)) fail("Profession deniedCapabilityIds must be an array");
    for (const capabilityId of profile.deniedCapabilityIds) text(capabilityId, "Profession denied capability id");
    validateScores(profile.scores, "Profession profile scores");
    validateCertificationRequirements(profile.requirements ?? DEFAULT_PROFESSION_REQUIREMENTS);
    if (profile.lifecycle !== undefined && !Array.isArray(profile.lifecycle)) fail("Profession profile lifecycle must be an array");
    for (const event of profile.lifecycle ?? []) {
        if (!CERTIFICATION_EVENTS.includes(event.eventType)) fail(`Invalid profession lifecycle event: ${event.eventType}`);
        text(event.at, "Profession lifecycle event at");
    }
};

const meetsRequirements = (profile: ProfessionProfile, evaluation: ProfessionEvaluation): void => {
    const requirements = profile.requirements ?? DEFAULT_PROFESSION_REQUIREMENTS;
    if (evaluation.sampleSize < requirements.minimumSampleSize) fail(`Profession certification requires at least ${requirements.minimumSampleSize} samples, received ${evaluation.sampleSize}`);
    if (evaluation.taskSuccessRate < requirements.minimumTaskSuccessRate) fail(`Profession certification requires taskSuccessRate >= ${requirements.minimumTaskSuccessRate}, received ${evaluation.taskSuccessRate}`);
    if (evaluation.sideEffectRate > requirements.maximumSideEffectRate) fail(`Profession certification requires sideEffectRate <= ${requirements.maximumSideEffectRate}, received ${evaluation.sideEffectRate}`);
    if (requirements.maximumAverageTokens !== undefined && evaluation.averageTokens > requirements.maximumAverageTokens) fail(`Profession certification requires averageTokens <= ${requirements.maximumAverageTokens}, received ${evaluation.averageTokens}`);
};

const applyEvaluation = (profile: ProfessionProfile, evaluation: ProfessionEvaluation, status: Extract<ProfessionCertificationStatus, "certified" | "recertified">): ProfessionProfile => {
    const scores: ProfessionProfileScores = Object.freeze({
        taskSuccessRate: evaluation.taskSuccessRate,
        averageTokens: evaluation.averageTokens,
        sideEffectRate: evaluation.sideEffectRate,
        sampleSize: evaluation.sampleSize,
    });
    const event: ProfessionLifecycleEvent = Object.freeze({ eventType: status, at: evaluation.evaluatedAt, detail: evaluation.evaluationId });
    return {
        ...profile,
        scores,
        certificationStatus: status,
        certifiedAt: evaluation.evaluatedAt,
        evaluationId: evaluation.evaluationId,
        lifecycle: Object.freeze([...(profile.lifecycle ?? []), event]),
    };
};

/**
 * Certifies an uncertified profile against its declared thresholds.
 * Pure: validations and threshold checks all happen before a new value is
 * returned, so a failed certification leaves the input profile untouched.
 */
export const certify = (profile: ProfessionProfile, evaluation: ProfessionEvaluation): ProfessionProfile => {
    validateProfessionProfile(profile);
    validateEvaluation(evaluation);
    if (profile.certificationStatus !== "uncertified") fail(`Profession profile is already ${profile.certificationStatus}; use recertify`);
    meetsRequirements(profile, evaluation);
    return applyEvaluation(profile, evaluation, "certified");
};

/**
 * Re-certifies an already certified profile. A failed re-certification throws
 * and preserves the previous certification, scores and lifecycle.
 */
export const recertify = (profile: ProfessionProfile, evaluation: ProfessionEvaluation): ProfessionProfile => {
    validateProfessionProfile(profile);
    validateEvaluation(evaluation);
    if (profile.certificationStatus !== "certified" && profile.certificationStatus !== "recertified") fail(`Profession profile must be certified before recertification: ${profile.certificationStatus}`);
    meetsRequirements(profile, evaluation);
    return applyEvaluation(profile, evaluation, "recertified");
};

/**
 * Stateful registry whose certification methods compute the complete new
 * profile first and only then replace the stored value. A threshold failure
 * therefore never leaves a half-certified record behind.
 */
export class ProfessionRegistry {
    private readonly profiles = new SynchronousUnorderedMap<Identifier, ProfessionProfile>();

    register(profile: ProfessionProfile): ProfessionProfile {
        validateProfessionProfile(profile);
        if (this.profiles.containsKey(profile.id)) fail(`Duplicate profession profile: ${profile.id}`);
        const stored = clone(profile);
        this.profiles.put(stored.id, stored);
        return clone(stored);
    }
    get(profileId: Identifier): ProfessionProfile | undefined {
        const value = this.profiles.get(profileId);
        return value.isPresent() ? clone(value.get()) : undefined;
    }
    list(): ProfessionProfile[] { return this.profiles.values().toArray().map(clone); }
    certify(profileId: Identifier, evaluation: ProfessionEvaluation): ProfessionProfile {
        const profile = this.require(profileId);
        const certified = certify(profile, evaluation);
        this.profiles.put(profileId, clone(certified));
        return clone(certified);
    }
    recertify(profileId: Identifier, evaluation: ProfessionEvaluation): ProfessionProfile {
        const profile = this.require(profileId);
        const recertified = recertify(profile, evaluation);
        this.profiles.put(profileId, clone(recertified));
        return clone(recertified);
    }
    restrict(profileId: Identifier, scope: PermissionScope): PermissionScope {
        return restrictByProfession(scope, this.require(profileId));
    }
    private require(profileId: Identifier): ProfessionProfile {
        const value = this.profiles.get(profileId);
        if (value.isEmpty()) return fail(`Unknown profession profile: ${profileId}`);
        return clone(value.get());
    }
}
