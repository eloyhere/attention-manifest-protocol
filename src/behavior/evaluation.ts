import { MINIMUM_ABSTRACTION_SAMPLES } from "./abstraction.ts";
import type {
    BehaviorCandidate,
    BehaviorEvaluation,
    BehaviorEvaluationOptions,
    BehaviorEvaluationSample,
    Clock,
} from "./types.ts";

const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);

const fnv1a = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
};

/** Default pass-rate threshold for standalone behavior evaluation. */
export const DEFAULT_BEHAVIOR_MINIMUM_PASS_RATE = 0.8;
const MAXIMUM_SAMPLES = 10_000;

const score = (value: unknown, field: string, minimum: number, maximum: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new TypeError(`${field} must be a finite number between ${minimum} and ${maximum}`);
    }
    return value;
};

const count = (value: unknown, field: string, minimum: number, maximum: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${field} must be a safe integer between ${minimum} and ${maximum}`);
    }
    return value;
};

type SampleGroup = { applicable: boolean; passed: boolean };

/**
 * Evaluates a behavior candidate against applicability/success samples
 * (refract §7.4–§7.5).
 *
 * The result is pure and deterministic: the candidate is not mutated and the
 * evaluation id is derived from the candidate id plus the sample facts, so
 * reordering samples does not change the result. Samples sharing an
 * independence key collapse into one effective sample (§5.4); a group passes
 * only when every applicable observation in it passed. A missing `applicable`
 * field means the trigger fired. Publication is a separate, explicit call to
 * {@link publishBehavior}.
 */
export function evaluateBehavior(
    candidate: BehaviorCandidate,
    samples: readonly BehaviorEvaluationSample[],
    options: BehaviorEvaluationOptions = {},
): BehaviorEvaluation {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) fail("Behavior candidate must be an object");
    const candidateId = text(candidate.candidateId, "candidateId");
    const behaviorId = text(candidate.behaviorId, "behaviorId");
    if (candidate.state !== "candidate" && candidate.state !== "evaluated") fail("Only candidate or evaluated behavior candidates may be evaluated");
    if (!Array.isArray(samples)) fail("Behavior evaluation samples must be an array");
    if (samples.length === 0) fail("Behavior evaluation requires at least one sample");
    if (samples.length > MAXIMUM_SAMPLES) fail(`Behavior evaluation accepts at most ${MAXIMUM_SAMPLES} samples`);
    if (typeof options !== "object" || options === null || Array.isArray(options)) fail("Behavior evaluation options must be an object");
    const minimumPassRate = options.minimumPassRate === undefined
        ? DEFAULT_BEHAVIOR_MINIMUM_PASS_RATE
        : score(options.minimumPassRate, "minimumPassRate", 0, 1);
    const minimumIndependentSamples = options.minimumIndependentSamples === undefined
        ? MINIMUM_ABSTRACTION_SAMPLES
        : count(options.minimumIndependentSamples, "minimumIndependentSamples", 1, MAXIMUM_SAMPLES);
    const clock: Clock = options.clock === undefined ? () => new Date().toISOString() : options.clock;
    if (typeof clock !== "function") fail("clock must be a function");

    const groups = new Map<string, SampleGroup>();
    const seenSamples = new Set<string>();
    for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        if (typeof sample !== "object" || sample === null || Array.isArray(sample)) fail(`Behavior sample[${index}] must be an object`);
        const sampleId = text(sample.sampleId, `Behavior sample[${index}].sampleId`);
        if (seenSamples.has(sampleId)) fail(`duplicate behavior sample: ${sampleId}`);
        seenSamples.add(sampleId);
        if (typeof sample.success !== "boolean") fail(`Behavior sample[${index}].success must be a boolean`);
        if (sample.applicable !== undefined && typeof sample.applicable !== "boolean") fail(`Behavior sample[${index}].applicable must be a boolean`);
        if (sample.sideEffect !== undefined && typeof sample.sideEffect !== "boolean") fail(`Behavior sample[${index}].sideEffect must be a boolean`);
        const independenceKey = sample.independenceKey === undefined
            ? `sample:${sampleId}`
            : text(sample.independenceKey, `Behavior sample[${index}].independenceKey`);
        const applicable = sample.applicable !== false;
        const group = groups.get(independenceKey) ?? { applicable: false, passed: true };
        if (applicable) {
            group.applicable = true;
            group.passed = group.passed && sample.success;
        }
        groups.set(independenceKey, group);
    }

    const facts = [...groups.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, group]) => [key, group.applicable ? 1 : 0, group.passed ? 1 : 0]);
    const independentSampleCount = facts.filter(([, applicable]) => applicable === 1).length;
    const passedCount = facts.filter(([, applicable, passed]) => applicable === 1 && passed === 1).length;
    const passRate = independentSampleCount === 0 ? 0 : passedCount / independentSampleCount;
    const thresholdMet = passRate >= minimumPassRate;
    const sampleThresholdMet = independentSampleCount >= minimumIndependentSamples;
    const reasons: readonly string[] = Object.freeze([
        ...(independentSampleCount === 0 ? ["no applicable samples"] : []),
        ...(sampleThresholdMet ? [] : [`insufficient independent samples: ${independentSampleCount} < ${minimumIndependentSamples}`]),
        ...(thresholdMet ? [] : [`pass rate ${passRate} is below minimum ${minimumPassRate}`]),
    ]);
    const evaluationId = options.evaluationId === undefined
        ? `behavior-evaluation:${fnv1a(JSON.stringify({ candidateId, behaviorId, facts, minimumPassRate, minimumIndependentSamples }))}`
        : text(options.evaluationId, "evaluationId");
    const evaluation: BehaviorEvaluation = Object.freeze({
        evaluationId,
        candidateId,
        behaviorId,
        sampleCount: samples.length,
        independentSampleCount,
        passedCount,
        passRate,
        minimumPassRate,
        thresholdMet,
        minimumIndependentSamples,
        sampleThresholdMet,
        passed: thresholdMet && sampleThresholdMet,
        reasons,
        evaluatedAt: clock(),
    });
    return evaluation;
}

export type PublishBehaviorOptions = {
    readonly publishedAt?: string;
    readonly clock?: Clock;
};

/**
 * Explicitly publishes an evaluated candidate (refract §7.4: abstraction is a
 * candidate, never an automatic write). A failing evaluation cannot publish,
 * the input candidate is not mutated, and no registry is touched.
 */
export function publishBehavior(
    candidate: BehaviorCandidate,
    evaluation: BehaviorEvaluation,
    options: PublishBehaviorOptions = {},
): BehaviorCandidate {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) fail("Behavior candidate must be an object");
    if (typeof evaluation !== "object" || evaluation === null || Array.isArray(evaluation)) fail("Behavior evaluation must be an object");
    if (candidate.state !== "candidate" && candidate.state !== "evaluated") fail("Only candidate or evaluated behavior candidates may be published");
    if (evaluation.candidateId !== candidate.candidateId) fail("Evaluation does not belong to this candidate");
    if (evaluation.behaviorId !== candidate.behaviorId) fail("Evaluation behaviorId does not match the candidate");
    if (evaluation.passed !== true) fail("Cannot publish a behavior candidate with a failing evaluation");
    const evaluationId = text(evaluation.evaluationId, "evaluationId");
    if (typeof options !== "object" || options === null || Array.isArray(options)) fail("Publish options must be an object");
    const clock: Clock = options.clock === undefined ? () => new Date().toISOString() : options.clock;
    if (typeof clock !== "function") fail("clock must be a function");
    const publishedAt = options.publishedAt === undefined ? clock() : text(options.publishedAt, "publishedAt");
    return Object.freeze({
        ...candidate,
        state: "published" as const,
        evaluationId,
        publishedAt,
    });
}
