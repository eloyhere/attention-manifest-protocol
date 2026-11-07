import type { Identifier } from "../shared.ts";

/**
 * The seven reasoning levels from `refract.md` §11.11. A cognition strategy
 * declares the levels it is allowed to reason over; selection never applies a
 * strategy outside that set.
 */
export const COGNITION_TASK_TYPES = [
    "turn",
    "intent",
    "mission",
    "goal",
    "plan",
    "task",
    "action",
] as const;

export type CognitionTaskType = (typeof COGNITION_TASK_TYPES)[number];

/** Declarative reasoning strategy. `costMultiplier` is relative, not absolute. */
export interface CognitionStrategy {
    readonly id: Identifier;
    readonly name?: string;
    /** Task levels this strategy is applicable to (§11.11). At least one. */
    readonly applicableTaskTypes: readonly CognitionTaskType[];
    /** Ordered reasoning steps; at least one nonempty step. */
    readonly steps: readonly string[];
    /** Positive relative cost multiplier used to rank applicable strategies. */
    readonly costMultiplier: number;
}

/** A task to reason about. The type is the primary selection key. */
export interface CognitionTask {
    readonly taskId?: Identifier;
    readonly type: CognitionTaskType;
    /** Optional ceiling; strategies above it are rejected rather than selected. */
    readonly maxCostMultiplier?: number;
}

export type CognitionRejectionReason = "task_type" | "cost";

export interface RejectedCognitionStrategy {
    readonly strategyId: Identifier;
    readonly reason: CognitionRejectionReason;
}

/** Deterministic record of why one strategy was selected for a task. */
export interface CognitionSelection {
    readonly taskId?: Identifier;
    readonly taskType: CognitionTaskType;
    readonly strategy: CognitionStrategy;
    /** All applicable strategies, cheapest first. */
    readonly eligibleStrategyIds: readonly Identifier[];
    readonly rejected: readonly RejectedCognitionStrategy[];
    readonly method: "task-type-and-cost";
}

/** One observed run of a strategy. Cost is an observed amount, not a guess. */
export interface CognitionTrace {
    readonly traceId: Identifier;
    readonly strategyId?: Identifier;
    readonly taskType?: CognitionTaskType;
    readonly passed: boolean;
    /** Observed nonnegative cost, in the caller's chosen unit (for example tokens). */
    readonly cost: number;
    readonly durationMs?: number;
    readonly observedAt?: string;
}

export interface CognitionEvaluationPolicy {
    readonly minimumSamples: number;
    readonly adoptPassRate: number;
    readonly retirePassRate: number;
    /** Inclusive ceiling for the observed average cost. */
    readonly maxAverageCost: number;
}

export type CognitionRecommendation = "adopt" | "hold" | "retire" | "insufficient";

/**
 * Evaluation output. `passRate`, `averageCost` and `totalCost` stay `null` when
 * there are no samples; no value is invented for an empty trace set.
 */
export interface CognitionEvaluation {
    readonly strategyId: Identifier;
    readonly sampleCount: number;
    readonly passRate: number | null;
    readonly averageCost: number | null;
    readonly totalCost: number | null;
    readonly costMultiplier: number;
    readonly recommendation: CognitionRecommendation;
    readonly reason: string;
    readonly policy: CognitionEvaluationPolicy;
}
