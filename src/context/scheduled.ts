import type { Budget } from "../shared.ts";
import type { AttentionObject } from "../attention/types.ts";
import type { AttentionRoute, AttentionScheduler, AttentionStage, AttentionStageSignals, DeferredAttention } from "../attention/scheduler.ts";
import { AttentionError } from "../attention/validation.ts";
import type { CompileContextOptions, CompiledContext } from "./types.ts";
import { compileContext } from "./compiler.ts";

/**
 * L4 assembly over L3 routing (§11.9 → §11.10).
 *
 * The scheduler selects the current stage's top-N attention objects. Only those
 * projections enter `compileContext`; everything else stays outside the model
 * payload as a pointer plus summary on `deferred`/`suppressed`. Scope, budget,
 * version and exclusion rules remain exactly `compileContext`'s rules.
 */

export type ScheduledContextOptions = CompileContextOptions & {
    readonly reason: string;
    /** Maximum objects routed into the context for the current stage. */
    readonly topN: number;
    /** Explicit stage; omitted means derive from signals or keep the scheduler's stage. */
    readonly stage?: AttentionStage;
    readonly signals?: AttentionStageSignals;
    /** Scheduling-work budget; defaults to one `calls` unit per supplied object. */
    readonly schedulingBudget?: Budget;
};

export interface ScheduledContext {
    readonly version: "attention-scheduled-context/1";
    readonly compiledAt: string;
    readonly stage: AttentionStage;
    readonly context: CompiledContext;
    readonly route: AttentionRoute;
    /** Non-selected candidates with their retrievable pointer and summary. */
    readonly deferred: readonly DeferredAttention[];
    /** Suppressed candidates with their retrievable pointer and summary. */
    readonly suppressed: readonly DeferredAttention[];
    readonly authorization: "not_granted";
}

export function compileScheduledContext(
    objects: readonly AttentionObject[],
    scheduler: AttentionScheduler,
    options: ScheduledContextOptions,
): ScheduledContext {
    if (!Number.isSafeInteger(options.topN) || options.topN < 1) {
        throw new AttentionError("invalid", "topN must be a positive integer");
    }
    // Reject a missing payload limit before routing so the scheduler's stage
    // state and decision log are not mutated by a compilation that cannot run.
    if (options.budget.tokens === undefined && options.budget.bytes === undefined) {
        throw new AttentionError("invalid", "Context compilation needs a tokens or bytes limit");
    }
    const route = scheduler.route({
        now: options.now,
        scope: options.scope,
        budget: options.schedulingBudget ?? { calls: objects.length },
        reason: options.reason,
        maxSelected: options.topN,
        ...(options.stage === undefined ? {} : { stage: options.stage }),
        ...(options.signals === undefined ? {} : { signals: options.signals }),
    }, objects);
    const context = compileContext(route.selected.map(item => item.object), options);
    return Object.freeze({
        version: "attention-scheduled-context/1",
        compiledAt: options.now,
        stage: route.stage,
        context,
        route,
        deferred: Object.freeze([...route.deferred]),
        suppressed: Object.freeze([...route.suppressed]),
        authorization: "not_granted",
    });
}
