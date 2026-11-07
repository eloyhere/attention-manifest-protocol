import type { Identifier } from "../shared.ts";
import { COGNITION_TASK_TYPES } from "./types.ts";
import type {
    CognitionEvaluation,
    CognitionEvaluationPolicy,
    CognitionRecommendation,
    CognitionRejectionReason,
    CognitionSelection,
    CognitionStrategy,
    CognitionTask,
    CognitionTaskType,
    CognitionTrace,
    RejectedCognitionStrategy,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export type CognitionErrorCode =
    | "empty_strategies"
    | "invalid_strategy"
    | "duplicate_strategy"
    | "invalid_task"
    | "no_applicable_strategy"
    | "cost_exceeds_budget"
    | "invalid_trace"
    | "duplicate_trace"
    | "invalid_policy";

export class CognitionError extends Error {
    readonly code: CognitionErrorCode;

    constructor(code: CognitionErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "CognitionError";
        this.code = code;
    }
}

const fail = (code: CognitionErrorCode, message: string): never => {
    throw new CognitionError(code, message);
};

export const DEFAULT_COGNITION_EVALUATION_POLICY: CognitionEvaluationPolicy = Object.freeze({
    minimumSamples: 3,
    adoptPassRate: 0.8,
    retirePassRate: 0.4,
    maxAverageCost: Number.POSITIVE_INFINITY,
});

function text(value: unknown, field: string, code: CognitionErrorCode = "invalid_strategy"): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        return fail(code, `${field} must be a nonempty string`);
    }
    return value;
}

function readTaskType(value: unknown, field: string, code: CognitionErrorCode): CognitionTaskType {
    if (!(COGNITION_TASK_TYPES as readonly string[]).includes(value as string)) {
        return fail(code, `${field} must be one of ${COGNITION_TASK_TYPES.join(", ")}`);
    }
    return value as CognitionTaskType;
}

function textArray(value: unknown, field: string, minimum: number, code: CognitionErrorCode): readonly string[] {
    if (!Array.isArray(value)) return fail(code, `${field} must be an array`);
    if (value.length < minimum) return fail(code, `${field} must contain at least ${minimum} item(s)`);
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of value) {
        if (typeof item !== "string" || item.trim().length === 0) return fail(code, `${field} must contain nonempty strings`);
        if (seen.has(item)) return fail(code, `${field} contains a duplicate item: ${item}`);
        seen.add(item);
        items.push(item);
    }
    return Object.freeze(items);
}

function readStrategy(value: unknown, index: number): CognitionStrategy {
    if (!isRecord(value)) return fail("invalid_strategy", `Strategy at index ${index} must be an object`);
    const id = text(value.id, `Strategy at index ${index} id`);
    const name = value.name === undefined ? undefined : text(value.name, `Strategy ${id} name`);
    const applicableTaskTypesValue = value.applicableTaskTypes;
    if (!Array.isArray(applicableTaskTypesValue) || applicableTaskTypesValue.length === 0) {
        return fail("invalid_strategy", `Strategy ${id} applicableTaskTypes must be a nonempty array`);
    }
    const applicable: CognitionTaskType[] = [];
    const seenTypes = new Set<CognitionTaskType>();
    for (const item of applicableTaskTypesValue) {
        const type = readTaskType(item, `Strategy ${id} applicableTaskType`, "invalid_strategy");
        if (seenTypes.has(type)) return fail("invalid_strategy", `Strategy ${id} declares duplicate task type: ${type}`);
        seenTypes.add(type);
        applicable.push(type);
    }
    const steps = textArray(value.steps, `Strategy ${id} steps`, 1, "invalid_strategy");
    const costMultiplier = value.costMultiplier;
    if (typeof costMultiplier !== "number" || !Number.isFinite(costMultiplier) || costMultiplier <= 0) {
        return fail("invalid_strategy", `Strategy ${id} costMultiplier must be a finite positive number`);
    }
    return Object.freeze({
        id,
        ...(name === undefined ? {} : { name }),
        applicableTaskTypes: Object.freeze(applicable),
        steps,
        costMultiplier,
    });
}

/**
 * Validates one strategy and returns an immutable normalized copy. Illegal
 * strategies are rejected instead of being silently ignored.
 */
export function validateCognitionStrategy(strategy: CognitionStrategy): CognitionStrategy {
    return readStrategy(strategy, 0);
}

function readTask(value: unknown): CognitionTask {
    if (!isRecord(value)) return fail("invalid_task", "Task must be an object");
    const type = readTaskType(value.type, "Task type", "invalid_task");
    const taskId = value.taskId === undefined ? undefined : text(value.taskId, "Task taskId", "invalid_task");
    const maxCostMultiplier = value.maxCostMultiplier;
    if (maxCostMultiplier !== undefined && (typeof maxCostMultiplier !== "number" || !Number.isFinite(maxCostMultiplier) || maxCostMultiplier <= 0)) {
        return fail("invalid_task", "Task maxCostMultiplier must be a finite positive number");
    }
    return Object.freeze({
        ...(taskId === undefined ? {} : { taskId }),
        type,
        ...(maxCostMultiplier === undefined ? {} : { maxCostMultiplier }),
    });
}

function compareIdentifiers(left: Identifier, right: Identifier): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Selects the cheapest strategy applicable to the task type (refract §11.11).
 * Cost ties are broken by strategy id so the result never depends on input
 * order. A task-level cost ceiling filters strategies before ranking.
 */
export function selectCognition(task: CognitionTask, strategies: readonly CognitionStrategy[]): CognitionSelection {
    const normalizedTask = readTask(task);
    if (!Array.isArray(strategies) || strategies.length === 0) {
        return fail("empty_strategies", "At least one cognition strategy is required");
    }
    const normalized: CognitionStrategy[] = [];
    const ids = new Set<Identifier>();
    for (let index = 0; index < strategies.length; index += 1) {
        const strategy = readStrategy(strategies[index], index);
        if (ids.has(strategy.id)) return fail("duplicate_strategy", `Duplicate cognition strategy: ${strategy.id}`);
        ids.add(strategy.id);
        normalized.push(strategy);
    }
    const rejected: RejectedCognitionStrategy[] = [];
    const eligible: CognitionStrategy[] = [];
    for (const strategy of normalized) {
        if (!strategy.applicableTaskTypes.includes(normalizedTask.type)) {
            rejected.push(Object.freeze({ strategyId: strategy.id, reason: "task_type" as CognitionRejectionReason }));
        } else if (normalizedTask.maxCostMultiplier !== undefined && strategy.costMultiplier > normalizedTask.maxCostMultiplier) {
            rejected.push(Object.freeze({ strategyId: strategy.id, reason: "cost" as CognitionRejectionReason }));
        } else {
            eligible.push(strategy);
        }
    }
    if (eligible.length === 0) {
        const costRejected = rejected.some(entry => entry.reason === "cost");
        return costRejected
            ? fail("cost_exceeds_budget", `No applicable strategy costs at most ${String(normalizedTask.maxCostMultiplier)} for task type ${normalizedTask.type}`)
            : fail("no_applicable_strategy", `No cognition strategy applies to task type ${normalizedTask.type}`);
    }
    eligible.sort((left, right) => left.costMultiplier - right.costMultiplier || compareIdentifiers(left.id, right.id));
    rejected.sort((left, right) => compareIdentifiers(left.strategyId, right.strategyId) || compareIdentifiers(left.reason, right.reason));
    const selected = eligible[0] as CognitionStrategy;
    const selection: CognitionSelection = Object.freeze({
        ...(normalizedTask.taskId === undefined ? {} : { taskId: normalizedTask.taskId }),
        taskType: normalizedTask.type,
        strategy: selected,
        eligibleStrategyIds: Object.freeze(eligible.map(strategy => strategy.id)),
        rejected: Object.freeze(rejected),
        method: "task-type-and-cost" as const,
    });
    return selection;
}

function readPolicy(options: Partial<CognitionEvaluationPolicy> | undefined): CognitionEvaluationPolicy {
    if (options !== undefined && !isRecord(options)) return fail("invalid_policy", "Cognition evaluation policy must be an object");
    const source = options ?? {};
    const minimumSamples = source.minimumSamples ?? DEFAULT_COGNITION_EVALUATION_POLICY.minimumSamples;
    if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1) {
        return fail("invalid_policy", "minimumSamples must be a positive safe integer");
    }
    const adoptPassRate = source.adoptPassRate ?? DEFAULT_COGNITION_EVALUATION_POLICY.adoptPassRate;
    const retirePassRate = source.retirePassRate ?? DEFAULT_COGNITION_EVALUATION_POLICY.retirePassRate;
    for (const [field, value] of [["adoptPassRate", adoptPassRate], ["retirePassRate", retirePassRate]] as const) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            return fail("invalid_policy", `${field} must be a finite number between 0 and 1`);
        }
    }
    if (retirePassRate > adoptPassRate) return fail("invalid_policy", "retirePassRate cannot exceed adoptPassRate");
    const maxAverageCost = source.maxAverageCost ?? DEFAULT_COGNITION_EVALUATION_POLICY.maxAverageCost;
    if (typeof maxAverageCost !== "number" || Number.isNaN(maxAverageCost) || maxAverageCost < 0 || (maxAverageCost === Number.NEGATIVE_INFINITY)) {
        return fail("invalid_policy", "maxAverageCost must be zero, a positive finite number, or Infinity");
    }
    return Object.freeze({ minimumSamples, adoptPassRate, retirePassRate, maxAverageCost });
}

function readTrace(value: unknown, index: number, strategy: CognitionStrategy): CognitionTrace {
    if (!isRecord(value)) return fail("invalid_trace", `Trace at index ${index} must be an object`);
    const traceId = text(value.traceId, `Trace at index ${index} traceId`, "invalid_trace");
    if (value.strategyId !== undefined && value.strategyId !== strategy.id) {
        return fail("invalid_trace", `Trace ${traceId} belongs to strategy ${String(value.strategyId)}, not ${strategy.id}`);
    }
    if (typeof value.passed !== "boolean") return fail("invalid_trace", `Trace ${traceId} passed must be a boolean`);
    if (typeof value.cost !== "number" || !Number.isFinite(value.cost) || value.cost < 0) {
        return fail("invalid_trace", `Trace ${traceId} cost must be a finite nonnegative number`);
    }
    let traceTaskType: CognitionTaskType | undefined;
    if (value.taskType !== undefined) {
        traceTaskType = readTaskType(value.taskType, `Trace ${traceId} taskType`, "invalid_trace");
        if (!strategy.applicableTaskTypes.includes(traceTaskType)) {
            return fail("invalid_trace", `Trace ${traceId} taskType ${traceTaskType} is outside strategy ${strategy.id}`);
        }
    }
    if (value.durationMs !== undefined && (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0)) {
        return fail("invalid_trace", `Trace ${traceId} durationMs must be a finite nonnegative number`);
    }
    if (value.observedAt !== undefined && (typeof value.observedAt !== "string" || value.observedAt.trim().length === 0)) {
        return fail("invalid_trace", `Trace ${traceId} observedAt must be a nonempty string`);
    }
    return Object.freeze({
        traceId,
        ...(value.strategyId === undefined ? {} : { strategyId: strategy.id }),
        ...(traceTaskType === undefined ? {} : { taskType: traceTaskType }),
        passed: value.passed,
        cost: value.cost,
        ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
        ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt as string }),
    });
}

function recommendationFor(
    sampleCount: number,
    passRate: number,
    averageCost: number,
    policy: CognitionEvaluationPolicy,
): { readonly recommendation: CognitionRecommendation; readonly reason: string } {
    if (sampleCount < policy.minimumSamples) {
        return {
            recommendation: "insufficient",
            reason: `Only ${sampleCount} sample(s); ${policy.minimumSamples} required for a recommendation.`,
        };
    }
    if (passRate >= policy.adoptPassRate && averageCost <= policy.maxAverageCost) {
        return {
            recommendation: "adopt",
            reason: `Pass rate ${passRate} meets ${policy.adoptPassRate} and average cost ${averageCost} is within ${policy.maxAverageCost}.`,
        };
    }
    if (passRate <= policy.retirePassRate) {
        return {
            recommendation: "retire",
            reason: `Pass rate ${passRate} is at or below the retire threshold ${policy.retirePassRate}.`,
        };
    }
    return {
        recommendation: "hold",
        reason: averageCost > policy.maxAverageCost
            ? `Average cost ${averageCost} exceeds the ceiling ${policy.maxAverageCost}.`
            : `Pass rate ${passRate} falls between the retire and adopt thresholds.`,
    };
}

/**
 * Evaluates a strategy from observed traces (refract §11.11). Empty traces
 * produce an `insufficient` evaluation with null metrics; no score is invented.
 */
export function evaluateCognition(
    strategy: CognitionStrategy,
    traces: readonly CognitionTrace[],
    policy: Partial<CognitionEvaluationPolicy> = {},
): CognitionEvaluation {
    const normalizedStrategy = readStrategy(strategy, 0);
    const normalizedPolicy = readPolicy(policy);
    if (!Array.isArray(traces)) return fail("invalid_trace", "Cognition traces must be an array");
    const seenTraceIds = new Set<Identifier>();
    const collected: CognitionTrace[] = [];
    for (let index = 0; index < traces.length; index += 1) {
        const trace = readTrace(traces[index], index, normalizedStrategy);
        if (seenTraceIds.has(trace.traceId)) return fail("duplicate_trace", `Duplicate cognition trace: ${trace.traceId}`);
        seenTraceIds.add(trace.traceId);
        collected.push(trace);
    }
    collected.sort((left, right) => compareIdentifiers(left.traceId, right.traceId));
    let passedCount = 0;
    let totalCost = 0;
    for (const trace of collected) {
        if (trace.passed) passedCount += 1;
        totalCost += trace.cost;
    }
    if (!Number.isFinite(totalCost)) return fail("invalid_trace", "Cognition trace cost total overflowed");
    const sampleCount = collected.length;
    if (sampleCount === 0) {
        return Object.freeze({
            strategyId: normalizedStrategy.id,
            sampleCount: 0,
            passRate: null,
            averageCost: null,
            totalCost: null,
            costMultiplier: normalizedStrategy.costMultiplier,
            recommendation: "insufficient" as const,
            reason: "No traces were supplied; no pass rate or cost is inferred.",
            policy: normalizedPolicy,
        });
    }
    const passRate = passedCount / sampleCount;
    const averageCost = totalCost / sampleCount;
    const recommendation = recommendationFor(sampleCount, passRate, averageCost, normalizedPolicy);
    return Object.freeze({
        strategyId: normalizedStrategy.id,
        sampleCount,
        passRate,
        averageCost,
        totalCost,
        costMultiplier: normalizedStrategy.costMultiplier,
        recommendation: recommendation.recommendation,
        reason: recommendation.reason,
        policy: normalizedPolicy,
    });
}
