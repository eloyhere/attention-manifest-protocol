import type { Identifier } from "../shared.ts";
import {
    DEFAULT_PROFESSION_REQUIREMENTS,
    certify,
    validateCertificationRequirements,
    validateProfessionProfile,
} from "./certification.ts";
import type {
    ProfessionCertificationRequirements,
    ProfessionEvaluation,
    ProfessionEvaluationCase,
    ProfessionProfile,
    ProfessionShadowExecutor,
    ProfessionShadowOutcome,
    ProfessionTrace,
} from "./types.ts";

const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);

/** Stable error for an evaluation that cannot be computed from the supplied evidence. */
export class ProfessionEvaluationError extends Error {
    readonly code = "insufficient_samples" as const;

    constructor(message: string) {
        super(`insufficient_samples: ${message}`);
        this.name = "ProfessionEvaluationError";
    }
}

export type TraceEvaluationOptions = {
    readonly evaluationId?: Identifier;
    readonly evaluator?: Identifier;
    /** Explicit timestamp; otherwise `clock()` or the current time is used. */
    readonly evaluatedAt?: string;
    readonly clock?: () => string;
};

export type ProfessionShadowErrorCode = "invalid_shadow_outcome" | "shadow_execution_failed" | "shadow_side_effect";

/** Raised when a shadow run is unsafe or returns an invalid observation. */
export class ProfessionShadowError extends Error {
    readonly code: ProfessionShadowErrorCode;
    readonly caseId?: Identifier;
    readonly cause?: unknown;

    constructor(code: ProfessionShadowErrorCode, message: string, caseId?: Identifier, cause?: unknown) {
        super(`${code}: ${message}`);
        this.name = "ProfessionShadowError";
        this.code = code;
        if (caseId !== undefined) this.caseId = caseId;
        if (cause !== undefined) this.cause = cause;
    }
}

export type ShadowEvaluationOptions = TraceEvaluationOptions & {
    /** Shadow executions must be side-effect free by default; set true for measurement fixtures. */
    readonly allowSideEffects?: boolean;
    readonly traceIdPrefix?: string;
};

export type ShadowEvaluationResult = {
    readonly traces: readonly ProfessionTrace[];
    readonly evaluation: ProfessionEvaluation;
};

const fnv1a = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
};

const traceFingerprint = (traces: readonly ProfessionTrace[]): string => {
    const facts = traces
        .map(trace => `${trace.traceId}:${trace.success ? "1" : "0"}:${trace.tokenCost}:${trace.sideEffects ?? 0}`)
        .sort()
        .join("|");
    return fnv1a(facts);
};

const validateTrace = (trace: ProfessionTrace, index: number, seen: Set<string>): void => {
    if (trace === null || typeof trace !== "object") fail(`Profession trace[${index}] must be an object`);
    const traceId = text(trace.traceId, `Profession trace[${index}].traceId`);
    if (seen.has(traceId)) fail(`Duplicate profession trace: ${traceId}`);
    seen.add(traceId);
    if (trace.taskId !== undefined) text(trace.taskId, `Profession trace[${index}].taskId`);
    if (typeof trace.success !== "boolean") fail(`Profession trace[${index}].success must be a boolean`);
    if (typeof trace.tokenCost !== "number" || !Number.isFinite(trace.tokenCost) || trace.tokenCost < 0) {
        fail(`Profession trace[${index}].tokenCost must be a finite number >= 0`);
    }
    if (trace.sideEffects !== undefined && (!Number.isSafeInteger(trace.sideEffects) || trace.sideEffects < 0)) {
        fail(`Profession trace[${index}].sideEffects must be a safe integer >= 0`);
    }
    if (trace.observedAt !== undefined) text(trace.observedAt, `Profession trace[${index}].observedAt`);
};

/**
 * Aggregates observed traces into a `ProfessionEvaluation`:
 * `sampleSize` counts traces, `taskSuccessRate` is the success fraction,
 * `sideEffectRate` the fraction of runs with at least one side effect, and
 * `tokenCost` the measured total (its per-sample mean is `averageTokens`).
 *
 * Empty evidence is rejected as `insufficient_samples`; the aggregator never
 * fabricates a zero-sample evaluation. Requirements are validated up front.
 */
export function evaluateTraces(
    traces: readonly ProfessionTrace[],
    requirements: ProfessionCertificationRequirements = DEFAULT_PROFESSION_REQUIREMENTS,
    options: TraceEvaluationOptions = {},
): ProfessionEvaluation {
    validateCertificationRequirements(requirements);
    if (!Array.isArray(traces)) fail("Profession traces must be an array");
    if (traces.length === 0) {
        throw new ProfessionEvaluationError(`at least ${requirements.minimumSampleSize} trace(s) are required, received 0`);
    }
    const seen = new Set<string>();
    let successes = 0;
    let sideEffected = 0;
    let tokenCost = 0;
    traces.forEach((trace, index) => {
        validateTrace(trace, index, seen);
        if (trace.success) successes += 1;
        if ((trace.sideEffects ?? 0) > 0) sideEffected += 1;
        tokenCost += trace.tokenCost;
    });
    const sampleSize = traces.length;
    const evaluatedAt = options.evaluatedAt ?? (options.clock === undefined ? new Date().toISOString() : options.clock());
    text(evaluatedAt, "Profession trace evaluation evaluatedAt");
    const evaluation: ProfessionEvaluation = Object.freeze({
        evaluationId: options.evaluationId === undefined ? `profession-evaluation:${traceFingerprint(traces)}` : text(options.evaluationId, "Profession trace evaluation evaluationId"),
        taskSuccessRate: successes / sampleSize,
        averageTokens: tokenCost / sampleSize,
        sideEffectRate: sideEffected / sampleSize,
        sampleSize,
        tokenCost,
        evaluator: options.evaluator === undefined ? "profession.trace-aggregator" : text(options.evaluator, "Profession trace evaluation evaluator"),
        evaluatedAt,
    });
    return evaluation;
}

/**
 * `evaluateTraces` followed by `certify`: the passed requirements become the
 * certification thresholds, and certification still happens only after every
 * threshold check passes. Empty traces raise `insufficient_samples` before certify.
 */
export function certifyWithTraces(
    profile: ProfessionProfile,
    traces: readonly ProfessionTrace[],
    requirements: ProfessionCertificationRequirements = profile.requirements ?? DEFAULT_PROFESSION_REQUIREMENTS,
    options: TraceEvaluationOptions = {},
): ProfessionProfile {
    validateProfessionProfile(profile);
    validateCertificationRequirements(requirements);
    const evaluation = evaluateTraces(traces, requirements, options);
    return certify({ ...profile, requirements }, evaluation);
}

const validateShadowOutcome = (outcome: ProfessionShadowOutcome, caseId: Identifier): void => {
    if (outcome === null || typeof outcome !== "object") {
        throw new ProfessionShadowError("invalid_shadow_outcome", `executor returned no outcome for ${caseId}`, caseId);
    }
    if (typeof outcome.success !== "boolean") {
        throw new ProfessionShadowError("invalid_shadow_outcome", `success must be a boolean for ${caseId}`, caseId);
    }
    if (typeof outcome.tokenCost !== "number" || !Number.isFinite(outcome.tokenCost) || outcome.tokenCost < 0) {
        throw new ProfessionShadowError("invalid_shadow_outcome", `tokenCost must be a finite number >= 0 for ${caseId}`, caseId);
    }
    if (outcome.sideEffects !== undefined && (!Number.isSafeInteger(outcome.sideEffects) || outcome.sideEffects < 0)) {
        throw new ProfessionShadowError("invalid_shadow_outcome", `sideEffects must be a safe integer >= 0 for ${caseId}`, caseId);
    }
};

/**
 * Runs an evaluation set through an injected shadow executor and aggregates the
 * observations with `evaluateTraces`. The runner itself never executes models or
 * tools; hosts provide a sandboxed executor. Shadow runs must report zero side
 * effects unless `allowSideEffects` is explicitly set.
 */
export async function runShadowEvaluation(
    cases: readonly ProfessionEvaluationCase[],
    execute: ProfessionShadowExecutor,
    requirements: ProfessionCertificationRequirements = DEFAULT_PROFESSION_REQUIREMENTS,
    options: ShadowEvaluationOptions = {},
): Promise<ShadowEvaluationResult> {
    validateCertificationRequirements(requirements);
    if (!Array.isArray(cases)) fail("Profession evaluation cases must be an array");
    if (typeof execute !== "function") fail("Shadow evaluation requires an executor");
    const seen = new Set<string>();
    for (const [index, testCase] of cases.entries()) {
        if (testCase === null || typeof testCase !== "object") fail(`Profession evaluation case[${index}] must be an object`);
        const caseId = text(testCase.caseId, `Profession evaluation case[${index}].caseId`);
        if (seen.has(caseId)) fail(`Duplicate profession evaluation case: ${caseId}`);
        seen.add(caseId);
        if (testCase.taskId !== undefined) text(testCase.taskId, `Profession evaluation case[${index}].taskId`);
    }
    if (cases.length === 0) {
        // Reuse the explicit insufficient_samples failure instead of returning empty scores.
        return { traces: Object.freeze([]), evaluation: evaluateTraces([], requirements, options) };
    }
    const observedAt = options.evaluatedAt ?? (options.clock === undefined ? new Date().toISOString() : options.clock());
    text(observedAt, "Profession shadow evaluation evaluatedAt");
    const traces: ProfessionTrace[] = [];
    for (const testCase of cases) {
        let outcome: ProfessionShadowOutcome;
        try {
            outcome = await execute(testCase);
        } catch (error) {
            throw new ProfessionShadowError(
                "shadow_execution_failed",
                `executor failed for ${testCase.caseId}: ${error instanceof Error ? error.message : String(error)}`,
                testCase.caseId,
                error,
            );
        }
        validateShadowOutcome(outcome, testCase.caseId);
        const sideEffects = outcome.sideEffects ?? 0;
        if (options.allowSideEffects !== true && sideEffects > 0) {
            throw new ProfessionShadowError(
                "shadow_side_effect",
                `shadow execution for ${testCase.caseId} reported ${sideEffects} side effect(s); shadow runs must be side-effect free`,
                testCase.caseId,
            );
        }
        traces.push(Object.freeze({
            traceId: `${options.traceIdPrefix ?? ""}${testCase.caseId}`,
            ...(testCase.taskId === undefined ? {} : { taskId: testCase.taskId }),
            success: outcome.success,
            tokenCost: outcome.tokenCost,
            sideEffects,
            observedAt,
        }));
    }
    const evaluation = evaluateTraces(traces, requirements, options);
    return Object.freeze({ traces: Object.freeze(traces), evaluation });
}

/**
 * Evaluation-set variant of `certifyWithTraces`: run every case in shadow, aggregate
 * the returned observations and certify against the supplied requirements.
 */
export async function certifyWithShadow(
    profile: ProfessionProfile,
    cases: readonly ProfessionEvaluationCase[],
    execute: ProfessionShadowExecutor,
    requirements: ProfessionCertificationRequirements = profile.requirements ?? DEFAULT_PROFESSION_REQUIREMENTS,
    options: ShadowEvaluationOptions = {},
): Promise<ProfessionProfile> {
    validateProfessionProfile(profile);
    validateCertificationRequirements(requirements);
    const result = await runShadowEvaluation(cases, execute, requirements, options);
    return certify({ ...profile, requirements }, result.evaluation);
}
