import type {
    BehaviorAbstraction,
    BehaviorAbstractionOptions,
    BehaviorAbstractionSource,
    BehaviorCandidate,
    BehaviorStepPattern,
    BehaviorSuccessCriterion,
    BehaviorTrace,
    BehaviorTraceStep,
    BehaviorTraceStepKind,
    BehaviorType,
} from "./types.ts";

const fail = (message: string): never => {
    throw new TypeError(message);
};
const text = (value: unknown, field: string): string =>
    typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const clone = <T>(value: T): T => structuredClone(value);

const fnv1a = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const BEHAVIOR_TYPES: readonly BehaviorType[] = Object.freeze([
    "action_pattern", "strategy", "failure_recovery", "decision_pattern", "attention_pattern",
]);
const TRACE_STEP_KINDS: readonly BehaviorTraceStepKind[] = Object.freeze([
    "tool", "action", "plan", "task", "goal", "decision", "attention", "other",
]);
const MAXIMUM_TRACES = 10_000;

/** Default minimum pattern support: a step must appear in at least half of the successful traces. */
export const DEFAULT_MINIMUM_SUPPORT = 0.5;
/** Default maximum aggregated steps in one behavior pattern. */
export const DEFAULT_MAXIMUM_STEPS = 8;
/** Refract §7.4 requires at least three independent successful observations. */
export const MINIMUM_ABSTRACTION_SAMPLES = 3;

export function isBehaviorType(value: unknown): value is BehaviorType {
    return typeof value === "string" && (BEHAVIOR_TYPES as readonly string[]).includes(value);
}

export function isBehaviorTraceStepKind(value: unknown): value is BehaviorTraceStepKind {
    return typeof value === "string" && (TRACE_STEP_KINDS as readonly string[]).includes(value);
}

type NormalizedStep = { readonly kind: BehaviorTraceStepKind; readonly name: string };
type NormalizedTrace = {
    readonly trace: BehaviorTrace;
    readonly independenceKey: string;
    readonly steps: readonly NormalizedStep[];
    readonly stepsFiltered: number;
};

const normalizeStep = (step: BehaviorTraceStep, field: string): NormalizedStep => {
    if (typeof step !== "object" || step === null || Array.isArray(step)) fail(`${field} must be an object`);
    if (!isBehaviorTraceStepKind(step.kind)) fail(`${field}.kind is not a behavior trace step kind`);
    return Object.freeze({ kind: step.kind, name: text(step.name, `${field}.name`) });
};

const normalizeTrace = (trace: BehaviorTrace, index: number, seen: Set<string>): NormalizedTrace => {
    if (typeof trace !== "object" || trace === null || Array.isArray(trace)) fail(`Behavior trace[${index}] must be an object`);
    const traceId = text(trace.traceId, `Behavior trace[${index}].traceId`);
    if (seen.has(traceId)) fail(`duplicate behavior trace: ${traceId}`);
    seen.add(traceId);
    if (typeof trace.success !== "boolean") fail(`Behavior trace[${index}].success must be a boolean`);
    if (trace.noisy !== undefined && typeof trace.noisy !== "boolean") fail(`Behavior trace[${index}].noisy must be a boolean`);
    if (trace.taskId !== undefined) text(trace.taskId, `Behavior trace[${index}].taskId`);
    if (trace.goalId !== undefined) text(trace.goalId, `Behavior trace[${index}].goalId`);
    if (trace.planId !== undefined) text(trace.planId, `Behavior trace[${index}].planId`);
    if (trace.observedAt !== undefined) text(trace.observedAt, `Behavior trace[${index}].observedAt`);
    const independenceKey = trace.independenceKey === undefined
        ? `trace:${traceId}`
        : text(trace.independenceKey, `Behavior trace[${index}].independenceKey`);
    if (!Array.isArray(trace.steps)) fail(`Behavior trace[${index}].steps must be an array`);
    const steps: NormalizedStep[] = [];
    let stepsFiltered = 0;
    for (let stepIndex = 0; stepIndex < trace.steps.length; stepIndex += 1) {
        const step = trace.steps[stepIndex];
        if (typeof step !== "object" || step === null || Array.isArray(step)) fail(`Behavior trace[${index}].steps[${stepIndex}] must be an object`);
        if (step.outcome === "failure") {
            // Denoise: a retry/failed probe is not part of the successful pattern.
            stepsFiltered += 1;
            continue;
        }
        if (step.outcome !== undefined && step.outcome !== "success") fail(`Behavior trace[${index}].steps[${stepIndex}].outcome is invalid`);
        if (step.capabilityId !== undefined) text(step.capabilityId, `Behavior trace[${index}].steps[${stepIndex}].capabilityId`);
        const normalized = normalizeStep(step, `Behavior trace[${index}].steps[${stepIndex}]`);
        const previous = steps[steps.length - 1];
        // Collapse adjacent duplicates: "call tool twice in a row" is one logical step.
        if (previous !== undefined && previous.kind === normalized.kind && previous.name === normalized.name) continue;
        steps.push(normalized);
    }
    return Object.freeze({
        trace: clone(trace),
        // The key is already validated above; keep the derived value readable.
        independenceKey,
        steps: Object.freeze(steps),
        stepsFiltered,
    });
};

const inferBehaviorType = (steps: readonly NormalizedStep[]): BehaviorType => {
    const kinds = new Set(steps.map(step => step.kind));
    if (kinds.has("attention")) return "attention_pattern";
    if (kinds.has("decision")) return "decision_pattern";
    if (kinds.has("plan") || kinds.has("goal")) return "strategy";
    return "action_pattern";
};

const uniqueSorted = (values: Iterable<string>): readonly string[] => Object.freeze([...new Set(values)].sort(compareText));

const optionInteger = (value: unknown, field: string, minimum: number, maximum: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${field} must be a safe integer between ${minimum} and ${maximum}`);
    }
    return value;
};

const optionSupport = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
        throw new TypeError("minimumSupport must be a finite number greater than 0 and at most 1");
    }
    return value;
};

type Aggregate = { kind: BehaviorTraceStepKind; name: string; traceCount: number; occurrences: number; positionTotal: number; positionCount: number };

/**
 * Mines a `BehaviorCandidate` from successful traces (refract §7.5–§7.6).
 *
 * The engine is deterministic and side-effect free: it never registers or
 * publishes anything. Failed, noisy, task-mismatched, duplicate-independence
 * and step-less traces are filtered, failure-outcome steps are removed, the
 * remaining steps are aggregated by support and ordered by their average
 * position, and success criteria plus trigger conditions are derived from the
 * Task/Goal/Plan/Tool sources the traces cite.
 *
 * At least {@link MINIMUM_ABSTRACTION_SAMPLES} independent successful traces
 * are required (§7.4: `observed → abstracted` needs three independent
 * successes). The returned candidate starts in `candidate` state; publishing
 * requires an explicit evaluation and publication call.
 *
 * Lifecycle mapping (§7.4): this function covers `observed → abstracted`,
 * {@link evaluateBehavior} is the `validated` gate and {@link publishBehavior}
 * is the explicit `registered / active` write. Cooling and demotion of an
 * already published behavior stay with `BehaviorGovernance`, which records
 * declarative adjustments instead of silently rewriting the registry.
 */
export function abstractBehavior(
    traces: readonly BehaviorTrace[],
    options: BehaviorAbstractionOptions = {},
): BehaviorCandidate {
    if (!Array.isArray(traces)) fail("Behavior traces must be an array");
    if (traces.length > MAXIMUM_TRACES) fail(`Behavior abstraction accepts at most ${MAXIMUM_TRACES} traces`);
    if (typeof options !== "object" || options === null || Array.isArray(options)) fail("Behavior abstraction options must be an object");
    const minimumIndependentSamples = options.minimumIndependentSamples === undefined
        ? MINIMUM_ABSTRACTION_SAMPLES
        : optionInteger(options.minimumIndependentSamples, "minimumIndependentSamples", MINIMUM_ABSTRACTION_SAMPLES, MAXIMUM_TRACES);
    const minimumSupport = options.minimumSupport === undefined
        ? DEFAULT_MINIMUM_SUPPORT
        : optionSupport(options.minimumSupport);
    const maximumSteps = options.maximumSteps === undefined
        ? DEFAULT_MAXIMUM_STEPS
        : optionInteger(options.maximumSteps, "maximumSteps", 1, 32);
    const version = options.version === undefined ? "1.0.0" : text(options.version, "version");
    const taskId = options.taskId === undefined ? undefined : text(options.taskId, "taskId");
    if (options.type !== undefined && !isBehaviorType(options.type)) fail("type is not a behavior type");
    const customCriteria = options.successCriteria === undefined
        ? Object.freeze([]) as readonly string[]
        : (Array.isArray(options.successCriteria)
            ? Object.freeze(options.successCriteria.map((criterion, index) => text(criterion, `successCriteria[${index}]`)))
            : fail("successCriteria must be an array"));
    const clock = options.clock === undefined ? () => new Date().toISOString() : options.clock;
    if (typeof clock !== "function") fail("clock must be a function");
    const seen = new Set<string>();
    const normalized = traces.map((trace, index) => normalizeTrace(trace, index, seen));

    // Denoise: success only, non-noisy, optional single task class.
    let noiseFiltered = 0;
    let stepsFiltered = 0;
    const successful: NormalizedTrace[] = [];
    for (const candidate of normalized) {
        stepsFiltered += candidate.stepsFiltered;
        if (candidate.trace.success !== true || candidate.trace.noisy === true || (taskId !== undefined && candidate.trace.taskId !== taskId)) {
            noiseFiltered += 1;
            continue;
        }
        successful.push(candidate);
    }
    // §5.4: the same independence key counts as one effective sample.
    successful.sort((left, right) => compareText(left.trace.traceId, right.trace.traceId));
    const seenKeys = new Set<string>();
    const seeds: NormalizedTrace[] = [];
    for (const candidate of successful) {
        if (seenKeys.has(candidate.independenceKey)) {
            noiseFiltered += 1;
            continue;
        }
        if (candidate.steps.length === 0) {
            noiseFiltered += 1;
            continue;
        }
        seenKeys.add(candidate.independenceKey);
        seeds.push(candidate);
    }
    if (seeds.length < minimumIndependentSamples) {
        fail(`behavior abstraction requires at least ${minimumIndependentSamples} independent successful traces (found ${seeds.length})`);
    }

    const aggregates = new Map<string, Aggregate>();
    for (const seed of seeds) {
        const seenSteps = new Set<string>();
        seed.steps.forEach((step, index) => {
            const key = `${step.kind}:${step.name}`;
            const aggregate = aggregates.get(key) ?? { kind: step.kind, name: step.name, traceCount: 0, occurrences: 0, positionTotal: 0, positionCount: 0 };
            aggregate.occurrences += 1;
            if (!seenSteps.has(key)) {
                seenSteps.add(key);
                aggregate.traceCount += 1;
                aggregate.positionTotal += index;
                aggregate.positionCount += 1;
            }
            aggregates.set(key, aggregate);
        });
    }
    const selected = [...aggregates.values()]
        .map(aggregate => ({
            kind: aggregate.kind,
            name: aggregate.name,
            support: aggregate.traceCount / seeds.length,
            occurrences: aggregate.occurrences,
            averagePosition: aggregate.positionTotal / Math.max(1, aggregate.positionCount),
        }))
        .filter(aggregate => aggregate.support >= minimumSupport)
        .sort((left, right) =>
            left.averagePosition - right.averagePosition
            || right.support - left.support
            || compareText(left.kind, right.kind)
            || compareText(left.name, right.name))
        .slice(0, maximumSteps);
    if (selected.length === 0) {
        fail(`behavior abstraction found no step supported by at least ${minimumSupport} of the successful traces`);
    }
    const pattern: readonly BehaviorStepPattern[] = Object.freeze(selected.map(step => Object.freeze({
        kind: step.kind,
        name: step.name,
        support: step.support,
        occurrences: step.occurrences,
    })));
    const support = Math.min(...pattern.map(step => step.support));

    const taskIds = uniqueSorted(seeds.flatMap(seed => seed.trace.taskId === undefined ? [] : [seed.trace.taskId]));
    const goalIds = uniqueSorted(seeds.flatMap(seed => seed.trace.goalId === undefined ? [] : [seed.trace.goalId]));
    const planIds = uniqueSorted(seeds.flatMap(seed => seed.trace.planId === undefined ? [] : [seed.trace.planId]));
    const toolIds = uniqueSorted(seeds.flatMap(seed => seed.steps.filter(step => step.kind === "tool").map(step => step.name)));
    const triggers: readonly string[] = Object.freeze([
        ...taskIds.map(id => `task:${id}`),
        ...goalIds.map(id => `goal:${id}`),
        ...planIds.map(id => `plan:${id}`),
        ...toolIds.map(id => `tool:${id}`),
    ]);
    const criteria: readonly BehaviorSuccessCriterion[] = Object.freeze([
        Object.freeze({
            criterionId: "criterion:source-success",
            kind: "observable" as const,
            description: `All ${seeds.length} independent source traces completed successfully`,
            threshold: 1,
        }),
        Object.freeze({
            criterionId: "criterion:pattern-support",
            kind: "observable" as const,
            description: `Every pattern step appears in at least ${minimumSupport} of the source traces`,
            threshold: minimumSupport,
        }),
        ...customCriteria.map((description, index) => Object.freeze({
            criterionId: `criterion:custom:${index + 1}`,
            kind: "soft" as const,
            description,
        })),
    ]);
    const behaviorType = options.type ?? inferBehaviorType(seeds.flatMap(seed => seed.steps));
    const source: BehaviorAbstractionSource = Object.freeze({
        traceIds: uniqueSorted(seeds.map(seed => seed.trace.traceId)),
        taskIds,
        goalIds,
        planIds,
        toolIds,
    });
    const independenceKeys = uniqueSorted(seeds.map(seed => seed.independenceKey));
    const summary = `${behaviorType}: ${pattern.map(step => `${step.kind}:${step.name}`).join(" -> ")}`;
    const abstraction: BehaviorAbstraction = Object.freeze({
        type: behaviorType,
        summary,
        triggers,
        pattern,
        successCriteria: criteria,
        source,
        independenceKeys,
        noiseFiltered,
        stepsFiltered,
        support,
        sourceTraceCount: traces.length,
        successfulTraceCount: seeds.length,
    });

    // IDs are content-derived so the same evidence (in any order) yields the same candidate.
    const facts = fnv1a(JSON.stringify({
        type: behaviorType,
        triggers,
        pattern: pattern.map(step => [step.kind, step.name]),
        criteria: criteria.map(criterion => [criterion.criterionId, criterion.kind, criterion.description, criterion.threshold ?? null]),
        traces: source.traceIds,
    }));
    const behaviorId = options.behaviorId === undefined ? `behavior:${facts}` : text(options.behaviorId, "behaviorId");
    const candidateId = options.candidateId === undefined
        ? `behavior-candidate:${fnv1a(`${facts}|${behaviorId}|${version}`)}`
        : text(options.candidateId, "candidateId");

    return Object.freeze({
        candidateId,
        behaviorId,
        version,
        state: "candidate" as const,
        traces: Object.freeze([]),
        independentSampleCount: seeds.length,
        dependsOnBehaviorIds: Object.freeze([]),
        createdAt: clock(),
        abstraction,
        sourceTraces: Object.freeze(seeds.map(seed => clone(seed.trace))),
    });
}
