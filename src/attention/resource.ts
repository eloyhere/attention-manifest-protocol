/**
 * Attention as a bounded, multi-dimensional resource.
 *
 * This is the resource layer above `cognition.ts`:
 * - `ProcessAttention` is the agent-level capacity, reserve and recovery debt.
 * - `ThreadAttention` is the per-task allocation inside that capacity.
 *
 * CPU analogies are structural only: a CPU can run at 100% indefinitely, a
 * person cannot. The policy therefore caps foreground utilization below 1,
 * keeps a safety/reserve floor, and schedules rest when recovery debt is high.
 */
import type { Pid } from "../types/common.ts";
import type { CognitiveState } from "./cognition.ts";

export interface AttentionResourcePolicy {
    /** Working-memory chunks assumed when no measured capacity exists. */
    baseSlots: number;
    /** Fraction kept away from foreground work (background, safety, recovery). */
    reserveRatio: number;
    /** Hard safety floor, in slots, reserved even under pressure. */
    safetyFloorRatio: number;
    /** Foreground utilization ceiling; must stay below 1.0. */
    maxForegroundUtil: number;
    /** Minimum allocation for an admitted task, in slots. */
    minSliceSlots: number;
    /** Rest after this many cycles without a rest frame. */
    restAfterCycles: number;
    /** Rest when vigilance falls to this level. */
    vigilanceFloor: number;
    /** Rest when load reaches this level. */
    loadCeiling: number;
    /** Rest when recovery debt reaches this level. */
    recoveryDebtThreshold: number;
}

export const DEFAULT_ATTENTION_POLICY: AttentionResourcePolicy = {
    baseSlots: 4,
    reserveRatio: 0.25,
    safetyFloorRatio: 0.1,
    maxForegroundUtil: 0.75,
    minSliceSlots: 1,
    restAfterCycles: 8,
    vigilanceFloor: 0.25,
    loadCeiling: 0.9,
    recoveryDebtThreshold: 0.7,
};

export interface ProcessAttention {
    pid: Pid;
    /** Effective working-memory slots after load penalty. */
    effectiveSlots: number;
    /** Foreground ceiling (`floor(effective * maxForegroundUtil)`). */
    foregroundCap: number;
    /** Slots kept out of foreground allocation. */
    reserveSlots: number;
    /** Hard safety floor inside the reserve. */
    safetySlots: number;
    state: CognitiveState;
    /** [0, 1] accumulated need for rest. */
    recoveryDebt: number;
    /** True when the policy says no foreground work should run. */
    offline: boolean;
}

export type ThreadDeferReason = "budget" | "offline" | "low-priority" | "floor";

export interface ThreadAttentionCandidate {
    tid: number;
    pid: Pid;
    priority: number;
    /** Desired slots; the planner clamps to capacity. */
    preferredSlots: number;
    /** Minimum slots if admitted; defaults to policy.minSliceSlots. */
    minSlots?: number;
    /** Background tasks use the reserve and never the foreground slot. */
    foreground?: boolean;
    /** Extra pressure from role/context switching. */
    switchCost?: number;
    role?: string;
}

export interface ThreadAttention {
    tid: number;
    pid: Pid;
    slots: number;
    foreground: boolean;
    priority: number;
    switchCost: number;
    role?: string;
}

export interface DeferredAttention {
    tid: number;
    reason: ThreadDeferReason;
}

export interface AttentionPlan {
    process: ProcessAttention;
    foreground?: ThreadAttention;
    background: ThreadAttention[];
    deferred: DeferredAttention[];
    /** Allocated slots / effective slots. */
    utilization: number;
    /** Deferred pressure plus switch cost, [0, 1+]. */
    pressure: number;
    /** True when the policy wants a rest frame. */
    rest: boolean;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const recoveryDebtOf = (state: CognitiveState): number => {
    return clamp01(0.5 * (1 - state.vigilance) + 0.3 * state.load + 0.2 * state.pLapse);
};

export const shouldRest = (state: CognitiveState, policy: AttentionResourcePolicy = DEFAULT_ATTENTION_POLICY): boolean => {
    return (
        state.cyclesSinceRest >= policy.restAfterCycles ||
        state.vigilance <= policy.vigilanceFloor ||
        state.load >= policy.loadCeiling ||
        recoveryDebtOf(state) >= policy.recoveryDebtThreshold
    );
};

export const processAttention = (pid: Pid, state: CognitiveState, policy: AttentionResourcePolicy = DEFAULT_ATTENTION_POLICY): ProcessAttention => {
    const effectiveSlots = Math.max(1, Math.floor(state.capacityEff));
    const safetySlots = Math.min(effectiveSlots, Math.max(1, Math.floor(effectiveSlots * policy.safetyFloorRatio)));
    const rawCap = Math.max(0, Math.floor(effectiveSlots * policy.maxForegroundUtil));
    const foregroundCap = Math.max(0, Math.min(rawCap, effectiveSlots - safetySlots));
    const reserveSlots = Math.max(safetySlots, effectiveSlots - foregroundCap);
    return {
        pid,
        effectiveSlots,
        foregroundCap,
        reserveSlots,
        safetySlots,
        state,
        recoveryDebt: recoveryDebtOf(state),
        offline: shouldRest(state, policy),
    };
};

const toAttention = (candidate: ThreadAttentionCandidate, slots: number, foreground: boolean): ThreadAttention => {
    const attention: ThreadAttention = {
        tid: candidate.tid,
        pid: candidate.pid,
        slots,
        foreground,
        priority: candidate.priority,
        switchCost: Math.max(0, candidate.switchCost ?? 0),
    };
    if (candidate.role !== undefined) attention.role = candidate.role;
    return attention;
};

/**
 * Allocate one foreground task and, from the reserve, background tasks.
 *
 * Floors are intentionally asymmetric: safety is always reserved, every
 * admitted task gets `minSlots`, but a deferred task gets no floor. Guaranteeing
 * a floor to every candidate would make admission meaningless under pressure.
 */
export const planAttention = (
    process: ProcessAttention,
    candidates: readonly ThreadAttentionCandidate[],
    policy: AttentionResourcePolicy = DEFAULT_ATTENTION_POLICY,
): AttentionPlan => {
    const deferred: DeferredAttention[] = [];
    const background: ThreadAttention[] = [];
    const sorted = [...candidates].sort((left, right) => right.priority - left.priority || left.tid - right.tid);
    const foregroundCandidates = sorted.filter((candidate) => candidate.foreground !== false);
    const backgroundCandidates = sorted.filter((candidate) => candidate.foreground === false);

    if (process.offline) {
        for (const candidate of foregroundCandidates) deferred.push({ tid: candidate.tid, reason: "offline" });
        return {
            process,
            background,
            deferred,
            utilization: 0,
            pressure: 1,
            rest: true,
        };
    }

    let foreground: ThreadAttention | undefined;
    let remaining = process.foregroundCap;
    for (let index = 0; index < foregroundCandidates.length; index += 1) {
        const candidate = foregroundCandidates[index];
        const minSlots = Math.max(1, candidate.minSlots ?? policy.minSliceSlots);
        if (index === 0 && remaining >= minSlots) {
            const slots = Math.min(remaining, Math.max(minSlots, Math.floor(candidate.preferredSlots)));
            foreground = toAttention(candidate, slots, true);
            remaining -= slots;
        } else {
            deferred.push({ tid: candidate.tid, reason: index === 0 ? "budget" : "low-priority" });
        }
    }

    let reserveRemaining = Math.max(0, process.effectiveSlots - process.safetySlots - (foreground?.slots ?? 0));
    for (const candidate of backgroundCandidates) {
        const minSlots = Math.max(1, candidate.minSlots ?? policy.minSliceSlots);
        if (reserveRemaining < minSlots) {
            deferred.push({ tid: candidate.tid, reason: "budget" });
            continue;
        }
        const slots = Math.min(reserveRemaining, Math.max(minSlots, Math.floor(candidate.preferredSlots)));
        background.push(toAttention(candidate, slots, false));
        reserveRemaining -= slots;
    }

    const allocated = (foreground?.slots ?? 0) + background.reduce((sum, task) => sum + task.slots, 0);
    const utilization = allocated / process.effectiveSlots;
    const switchPressure = foreground === undefined ? 0 : Math.min(1, foreground.switchCost / Math.max(1, process.effectiveSlots));
    const pressure = Math.min(1.5, deferred.length / Math.max(1, candidates.length) + switchPressure);

    return {
        process,
        ...(foreground === undefined ? {} : { foreground }),
        background,
        deferred,
        utilization,
        pressure,
        rest: false,
    };
};

/** Rest restores vigilance, reduces load and clears the rest counter. */
export const applyRest = (state: CognitiveState, cycles: number = 1): CognitiveState => {
    const amount = Math.max(1, Math.floor(cycles));
    const vigilance = clamp01(state.vigilance + 0.25 * amount);
    const load = clamp01(state.load - 0.2 * amount);
    return {
        ...state,
        vigilance,
        load,
        pLapse: clamp01(1 - vigilance),
        cyclesSinceRest: 0,
    };
};

export interface OutcomeStats {
    successes: number;
    attempts: number;
    errors: number;
    rework: number;
    attentionSlots: number;
}

/**
 * Efficiency is useful outcomes per unit of attention, not raw utilization.
 * Errors and rework are subtracted so a busy-but-wrong agent cannot win.
 */
export const qualityAdjustedThroughput = (stats: OutcomeStats): number => {
    const useful = Math.max(0, stats.successes - stats.errors - stats.rework);
    return useful / Math.max(1, stats.attentionSlots);
};

export const attentionHealth = (plan: AttentionPlan): { utilization: number; pressure: number; headroom: number; rest: boolean } => {
    return {
        utilization: plan.utilization,
        pressure: plan.pressure,
        headroom: Math.max(0, 1 - plan.utilization),
        rest: plan.rest,
    };
};
