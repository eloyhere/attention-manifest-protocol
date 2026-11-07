import { EmptyBudgetUsage, exceedsBudget } from "../shared.ts";
import type { Budget, BudgetUsage, Identifier } from "../shared.ts";
import type { AttentionObject, AttentionPointer, AttentionScope } from "./types.ts";
import { AttentionError, inScope, isExpired, requireText, timestamp, unitInterval, validateBudget, validateObject, validateScope } from "./validation.ts";

/**
 * L3 attention scheduling (§11.9).
 *
 * The scheduler is deliberately pure and host-agnostic: it consumes attention
 * projections, produces a ranked, budgeted route for the current stage, and
 * records why every decision was made. It never mounts objects, fetches a
 * source, settles a shared budget ledger or grants authorization.
 */

/** The nine L3 stages in their normal progression order. */
export type AttentionStage =
    | "receive"
    | "parse"
    | "strategy"
    | "plan"
    | "tactics"
    | "execute"
    | "verify"
    | "diagnose"
    | "respond";

/** The four §11.9 mechanisms: route, focus, switch and suppress. */
export type AttentionMechanism = "focus" | "blur" | "switch" | "suppress";

export const ATTENTION_STAGES: readonly AttentionStage[] = Object.freeze([
    "receive",
    "parse",
    "strategy",
    "plan",
    "tactics",
    "execute",
    "verify",
    "diagnose",
    "respond",
] as const);

/** Stable display labels for the nine §11.9 stages. */
export const ATTENTION_STAGE_LABELS: Readonly<Record<AttentionStage, string>> = Object.freeze({
    receive: "接收",
    parse: "解析",
    strategy: "战略",
    plan: "规划",
    tactics: "战术",
    execute: "执行",
    verify: "验证",
    diagnose: "失败诊断",
    respond: "响应",
});

/** What each stage focuses on, mirroring the §11.9 stage table. */
export interface AttentionStageProfile {
    readonly stage: AttentionStage;
    /** Level that owns attention during this stage. */
    readonly focusLevel: string;
    /** Signals/objects that stage should look at. */
    readonly sees: readonly string[];
}

function stageProfile(stage: AttentionStage, focusLevel: string, sees: readonly string[]): AttentionStageProfile {
    return Object.freeze({ stage, focusLevel, sees: Object.freeze([...sees]) });
}

export const ATTENTION_STAGE_PROFILES: Readonly<Record<AttentionStage, AttentionStageProfile>> = Object.freeze({
    receive: stageProfile("receive", "Turn", ["current input", "session history summary"]),
    parse: stageProfile("parse", "Turn + Intent", ["input parsing", "intent candidates", "ambiguities"]),
    strategy: stageProfile("strategy", "Mission", ["value", "constraints", "total resources"]),
    plan: stageProfile("plan", "Goal + Plan", ["end state", "alternatives", "DAG constraints"]),
    tactics: stageProfile("tactics", "Task DAG", ["ready tasks", "dependencies", "parallelism"]),
    execute: stageProfile("execute", "Action", ["current command", "preconditions", "expected output"]),
    verify: stageProfile("verify", "Current-level standard + subordinate evidence", ["success criteria vs actual", "subordinate evidence"]),
    diagnose: stageProfile("diagnose", "Minimal failing unit + fallback path", ["failure classification", "fallback path", "minimal failing unit"]),
    respond: stageProfile("respond", "Turn", ["response organization", "evidence citations"]),
});

/**
 * Legal stage transitions. Forward movement is always legal, as are the
 * bounded backtracks a real turn needs: rescoping, re-planning, retrying and
 * diagnosing. A jump that skips a whole level is rejected.
 */
export const ATTENTION_STAGE_TRANSITIONS: Readonly<Record<AttentionStage, readonly AttentionStage[]>> = Object.freeze({
    receive: Object.freeze(["parse", "respond"] as const),
    parse: Object.freeze(["receive", "strategy", "respond"] as const),
    strategy: Object.freeze(["parse", "plan", "diagnose", "respond"] as const),
    plan: Object.freeze(["strategy", "tactics", "diagnose", "respond"] as const),
    tactics: Object.freeze(["plan", "execute", "diagnose"] as const),
    execute: Object.freeze(["tactics", "verify", "diagnose"] as const),
    verify: Object.freeze(["execute", "respond", "diagnose"] as const),
    diagnose: Object.freeze(["strategy", "plan", "tactics", "execute", "respond"] as const),
    respond: Object.freeze(["receive"] as const),
});

export function isAttentionStage(value: unknown): value is AttentionStage {
    return typeof value === "string" && (ATTENTION_STAGES as readonly string[]).includes(value);
}

export function isStageTransitionAllowed(from: AttentionStage, to: AttentionStage): boolean {
    if (!isAttentionStage(from) || !isAttentionStage(to)) return false;
    return ATTENTION_STAGE_TRANSITIONS[from].includes(to);
}

/** Observations from the host that select the next stage when no explicit stage is supplied. */
export interface AttentionStageSignals {
    /** A Turn input exists and the turn has not moved past receiving it. */
    readonly inputReceived?: boolean;
    /** Parsed intent candidates. */
    readonly intentCandidates?: readonly string[];
    /** Ambiguities that keep the turn in parsing/clarification. */
    readonly ambiguity?: readonly string[];
    readonly missionId?: Identifier;
    readonly goalIds?: readonly Identifier[];
    readonly planId?: Identifier;
    readonly readyTaskIds?: readonly Identifier[];
    readonly actionId?: Identifier;
    /** The current action/standard still needs verification. */
    readonly verificationPending?: boolean;
    /** A minimal failing unit; it selects failure diagnosis. */
    readonly failure?: {
        readonly unitId: Identifier;
        readonly category?: string;
    };
    /** The response is ready to be organized. */
    readonly responseReady?: boolean;
}

function requireNonemptyList(values: readonly string[] | undefined, field: string): void {
    for (const value of values ?? []) requireText(value, field);
}

function validateSignals(signals: AttentionStageSignals): void {
    if (typeof signals !== "object" || signals === null) throw new AttentionError("invalid", "Stage signals must be an object");
    if (signals.missionId !== undefined) requireText(signals.missionId, "signals.missionId");
    if (signals.planId !== undefined) requireText(signals.planId, "signals.planId");
    if (signals.actionId !== undefined) requireText(signals.actionId, "signals.actionId");
    requireNonemptyList(signals.intentCandidates, "signals.intentCandidates");
    requireNonemptyList(signals.ambiguity, "signals.ambiguity");
    requireNonemptyList(signals.goalIds, "signals.goalIds");
    requireNonemptyList(signals.readyTaskIds, "signals.readyTaskIds");
    if (signals.failure !== undefined) {
        requireText(signals.failure.unitId, "signals.failure.unitId");
        if (signals.failure.category !== undefined) requireText(signals.failure.category, "signals.failure.category");
    }
}

/**
 * Deterministically selects the most specific active stage. Failure diagnosis
 * outranks normal progress because a failure must be classified before a
 * response can honestly claim success.
 */
export function detectStage(signals: AttentionStageSignals): AttentionStage {
    validateSignals(signals);
    if (signals.failure !== undefined) return "diagnose";
    if (signals.verificationPending === true) return "verify";
    if (signals.actionId !== undefined) return "execute";
    if ((signals.readyTaskIds?.length ?? 0) > 0) return "tactics";
    if (signals.planId !== undefined || (signals.goalIds?.length ?? 0) > 0) return "plan";
    if (signals.missionId !== undefined) return "strategy";
    if ((signals.intentCandidates?.length ?? 0) > 0 || (signals.ambiguity?.length ?? 0) > 0) return "parse";
    if (signals.responseReady === true) return "respond";
    return "receive";
}

export interface AttentionRouteInput {
    readonly now: string;
    readonly scope: AttentionScope;
    /** Scheduling work budget; one `calls` unit is charged per inspected candidate. */
    readonly budget: Budget;
    readonly reason: string;
    /** Explicit stage; when omitted the scheduler derives it from signals or keeps the current stage. */
    readonly stage?: AttentionStage;
    readonly signals?: AttentionStageSignals;
    /** Maximum number selected into the current stage focus. Defaults to every admitted candidate. */
    readonly maxSelected?: number;
}

/** Why an object stayed outside the current focus. */
export type AttentionDeferReason = "scope" | "expired" | "stale" | "budget" | "top_n" | "suppressed";

/** A candidate kept outside the model payload but still retrievable by pointer and summary. */
export interface DeferredAttention {
    readonly id: Identifier;
    readonly version: number;
    readonly summary: string;
    readonly pointer: AttentionPointer;
    readonly score?: number;
    readonly reason: AttentionDeferReason;
    readonly detail: string;
}

/** A candidate selected into the current stage focus. */
export interface ScheduledAttention {
    readonly object: AttentionObject;
    readonly id: Identifier;
    readonly summary: string;
    readonly pointer: AttentionPointer;
    readonly score: number;
    readonly baseScore: number;
    readonly adjustment: number;
    readonly reason: string;
    readonly budget: Budget;
}

/** One candidate's deterministic ranking evidence in the decision log. */
export interface SchedulingCandidateScore {
    readonly id: Identifier;
    readonly version: number;
    readonly summary: string;
    readonly pointer: AttentionPointer;
    readonly score: number;
    readonly baseScore: number;
    readonly adjustment: number;
    readonly selected: boolean;
    readonly reason: string;
    readonly budget: Budget;
}

/**
 * One auditable scheduling decision. Route decisions carry the full candidate
 * ranking, selected/deferred/suppressed sets and the scheduling budget; the
 * other mechanisms carry their target (plus amount or suppression expiry).
 */
export interface SchedulingDecision {
    readonly id: Identifier;
    readonly sequence: number;
    readonly at: string;
    readonly action: "route" | AttentionMechanism;
    readonly reason: string;
    readonly stage: AttentionStage | null;
    readonly fromStage?: AttentionStage;
    readonly toStage?: AttentionStage;
    readonly target?: Identifier;
    readonly amount?: number;
    readonly until?: string;
    readonly candidates: readonly SchedulingCandidateScore[];
    readonly selected: readonly Identifier[];
    readonly deferred: readonly Identifier[];
    readonly suppressed: readonly Identifier[];
    readonly budget: Budget;
    readonly usage: BudgetUsage;
    readonly authorization: "not_granted";
}

export interface AttentionRoute {
    readonly version: "attention-route/1";
    readonly stage: AttentionStage;
    readonly previousStage?: AttentionStage;
    readonly profile: AttentionStageProfile;
    readonly selected: readonly ScheduledAttention[];
    readonly deferred: readonly DeferredAttention[];
    readonly suppressed: readonly DeferredAttention[];
    readonly budget: Budget;
    readonly usage: BudgetUsage;
    readonly decision: SchedulingDecision;
    readonly authorization: "not_granted";
}

export interface AttentionMechanismOptions {
    readonly now: string;
    readonly reason: string;
}

export interface AttentionSuppressionOptions extends AttentionMechanismOptions {
    readonly until?: string;
}

type CandidateStatus = "eligible" | Exclude<AttentionDeferReason, "budget" | "top_n">;

interface CandidateState {
    readonly object: AttentionObject;
    readonly baseScore: number;
    readonly adjustment: number;
    readonly score: number;
    readonly status: CandidateStatus;
    readonly detail: string;
}

function schedulingScore(object: AttentionObject): number {
    const { relevance, urgency, confidence, importance } = object.scores;
    return object.intensity + relevance + urgency + confidence + importance;
}

function zeroUsage(): BudgetUsage {
    return { ...EmptyBudgetUsage };
}

function requireMaxSelected(value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new AttentionError("invalid", "maxSelected must be a positive integer");
    }
}

/**
 * Stateful, deterministic L3 scheduler. Stage transitions are validated
 * against `ATTENTION_STAGE_TRANSITIONS`; focus/blur adjustments persist until
 * the host removes them, and suppressions persist until an optional expiry.
 */
export class AttentionScheduler {
    private stageValue: AttentionStage | undefined;
    private readonly adjustments = new Map<Identifier, number>();
    private readonly suppressions = new Map<Identifier, { readonly reason: string; readonly until?: string }>();
    private readonly decisions: SchedulingDecision[] = [];
    private sequence = 0;

    currentStage(): AttentionStage | undefined {
        return this.stageValue;
    }

    decisionLog(): readonly SchedulingDecision[] {
        return Object.freeze([...this.decisions]);
    }

    /** Routes candidates into the current (or newly selected) stage and returns the top focus. */
    route(input: AttentionRouteInput, candidates: readonly AttentionObject[]): AttentionRoute {
        requireText(input.reason, "reason");
        timestamp(input.now);
        validateScope(input.scope);
        validateBudget(input.budget);
        requireMaxSelected(input.maxSelected);
        const nextStage = this.resolveStage(input);
        const previousStage = this.stageValue;
        if (previousStage !== undefined && previousStage !== nextStage && !isStageTransitionAllowed(previousStage, nextStage)) {
            throw new AttentionError("invalid", `Stage transition ${previousStage} -> ${nextStage} is not allowed`);
        }
        this.purgeSuppressions(input.now);
        const states = this.classify(input, candidates);
        this.stageValue = nextStage;
        const eligible = states
            .filter(state => state.status === "eligible")
            .sort((left, right) => right.score - left.score || left.object.id.localeCompare(right.object.id));
        let usage = zeroUsage();
        const admitted: CandidateState[] = [];
        const admittedIds = new Set<Identifier>();
        for (const state of eligible) {
            const nextUsage: BudgetUsage = { ...usage, calls: usage.calls + 1 };
            if (exceedsBudget(nextUsage, input.budget)) continue;
            usage = nextUsage;
            admitted.push(state);
            admittedIds.add(state.object.id);
        }
        const maxSelected = input.maxSelected ?? admitted.length;
        const focusedStates = admitted.slice(0, maxSelected);
        const topNStates = admitted.slice(maxSelected);
        const focusedIds = new Set(focusedStates.map(state => state.object.id));
        const budgetIds = new Set(eligible.filter(state => !admittedIds.has(state.object.id)).map(state => state.object.id));
        const topNIds = new Set(topNStates.map(state => state.object.id));

        const selected: ScheduledAttention[] = focusedStates.map(state => Object.freeze({
            object: structuredClone(state.object),
            id: state.object.id,
            summary: state.object.summary,
            pointer: structuredClone(state.object.pointer),
            score: state.score,
            baseScore: state.baseScore,
            adjustment: state.adjustment,
            reason: state.adjustment > 0 ? "focus" : state.adjustment < 0 ? "blur" : "rank",
            budget: Object.freeze({ ...state.object.budget }),
        }));
        const deferred: DeferredAttention[] = [];
        const suppressed: DeferredAttention[] = [];
        const decisionCandidates: SchedulingCandidateScore[] = [];
        for (const state of states) {
            const isSelected = focusedIds.has(state.object.id);
            let reason = state.status as string;
            let detail = state.detail;
            if (state.status === "eligible") {
                if (isSelected) {
                    reason = "selected";
                    detail = `selected for ${nextStage}`;
                } else if (budgetIds.has(state.object.id)) {
                    reason = "budget";
                    detail = "scheduling call budget exhausted";
                } else if (topNIds.has(state.object.id)) {
                    reason = "top_n";
                    detail = `outside top ${maxSelected}`;
                }
            }
            decisionCandidates.push(Object.freeze({
                id: state.object.id,
                version: state.object.version,
                summary: state.object.summary,
                pointer: structuredClone(state.object.pointer),
                score: state.score,
                baseScore: state.baseScore,
                adjustment: state.adjustment,
                selected: isSelected,
                reason,
                budget: Object.freeze({ ...state.object.budget }),
            }));
            if (state.status === "suppressed") {
                suppressed.push(Object.freeze({
                    id: state.object.id,
                    version: state.object.version,
                    summary: state.object.summary,
                    pointer: structuredClone(state.object.pointer),
                    score: state.score,
                    reason: "suppressed",
                    detail,
                }));
                continue;
            }
            if (isSelected) continue;
            const deferReason: AttentionDeferReason = state.status === "eligible"
                ? (budgetIds.has(state.object.id) ? "budget" : "top_n")
                : state.status;
            deferred.push(Object.freeze({
                id: state.object.id,
                version: state.object.version,
                summary: state.object.summary,
                pointer: structuredClone(state.object.pointer),
                score: state.score,
                reason: deferReason,
                detail,
            }));
        }
        const decision = this.record({
            action: "route",
            at: input.now,
            reason: input.reason,
            stage: nextStage,
            ...(previousStage === undefined ? {} : { fromStage: previousStage }),
            toStage: nextStage,
            candidates: decisionCandidates,
            selected: focusedStates.map(state => state.object.id),
            deferred: deferred.map(item => item.id),
            suppressed: suppressed.map(item => item.id),
            budget: input.budget,
            usage,
        });
        return Object.freeze({
            version: "attention-route/1",
            stage: nextStage,
            ...(previousStage === undefined ? {} : { previousStage }),
            profile: ATTENTION_STAGE_PROFILES[nextStage],
            selected: Object.freeze(selected),
            deferred: Object.freeze(deferred),
            suppressed: Object.freeze(suppressed),
            budget: Object.freeze({ ...input.budget }),
            usage: Object.freeze({ ...usage }),
            decision,
            authorization: "not_granted",
        });
    }

    /** Raises ranking for an object without mounting or authorizing it. */
    focus(id: Identifier, options: AttentionMechanismOptions, amount = 0.25): SchedulingDecision {
        requireText(id, "id");
        requireText(options.reason, "reason");
        timestamp(options.now);
        unitInterval(amount, "amount");
        const next = Math.min(1, (this.adjustments.get(id) ?? 0) + amount);
        this.adjustments.set(id, next);
        return this.record({
            action: "focus",
            at: options.now,
            reason: options.reason,
            stage: this.stageValue ?? null,
            target: id,
            amount,
            candidates: [],
            selected: [],
            deferred: [],
            suppressed: [],
            budget: {},
            usage: zeroUsage(),
        });
    }

    /** Lowers ranking while retaining summary and pointer; blur never removes an object. */
    blur(id: Identifier, options: AttentionMechanismOptions, amount = 0.25): SchedulingDecision {
        requireText(id, "id");
        requireText(options.reason, "reason");
        timestamp(options.now);
        unitInterval(amount, "amount");
        const next = Math.max(-1, (this.adjustments.get(id) ?? 0) - amount);
        this.adjustments.set(id, next);
        return this.record({
            action: "blur",
            at: options.now,
            reason: options.reason,
            stage: this.stageValue ?? null,
            target: id,
            amount,
            candidates: [],
            selected: [],
            deferred: [],
            suppressed: [],
            budget: {},
            usage: zeroUsage(),
        });
    }

    /** Moves to another stage; illegal jumps are rejected before any state changes. */
    switch(stage: AttentionStage, options: AttentionMechanismOptions): SchedulingDecision {
        if (!isAttentionStage(stage)) throw new AttentionError("invalid", `Unknown attention stage: ${String(stage)}`);
        requireText(options.reason, "reason");
        timestamp(options.now);
        const previousStage = this.stageValue;
        if (previousStage !== undefined && previousStage !== stage && !isStageTransitionAllowed(previousStage, stage)) {
            throw new AttentionError("invalid", `Stage transition ${previousStage} -> ${stage} is not allowed`);
        }
        this.stageValue = stage;
        return this.record({
            action: "switch",
            at: options.now,
            reason: options.reason,
            stage,
            ...(previousStage === undefined ? {} : { fromStage: previousStage }),
            toStage: stage,
            candidates: [],
            selected: [],
            deferred: [],
            suppressed: [],
            budget: {},
            usage: zeroUsage(),
        });
    }

    /** Suppresses an object until an optional expiry; the pointer and summary remain retrievable. */
    suppress(id: Identifier, options: AttentionSuppressionOptions): SchedulingDecision {
        requireText(id, "id");
        requireText(options.reason, "reason");
        const now = timestamp(options.now);
        if (options.until !== undefined) {
            const until = timestamp(options.until);
            if (until <= now) throw new AttentionError("expired", "Suppression must expire in the future");
        }
        this.suppressions.set(id, {
            reason: options.reason,
            ...(options.until === undefined ? {} : { until: options.until }),
        });
        return this.record({
            action: "suppress",
            at: options.now,
            reason: options.reason,
            stage: this.stageValue ?? null,
            target: id,
            ...(options.until === undefined ? {} : { until: options.until }),
            candidates: [],
            selected: [],
            deferred: [],
            suppressed: [id],
            budget: {},
            usage: zeroUsage(),
        });
    }

    private resolveStage(input: AttentionRouteInput): AttentionStage {
        if (input.stage !== undefined) {
            if (!isAttentionStage(input.stage)) throw new AttentionError("invalid", `Unknown attention stage: ${String(input.stage)}`);
            return input.stage;
        }
        if (input.signals !== undefined) return detectStage(input.signals);
        return this.stageValue ?? "receive";
    }

    private purgeSuppressions(now: string): void {
        const at = timestamp(now);
        for (const [id, suppression] of [...this.suppressions]) {
            if (suppression.until !== undefined && timestamp(suppression.until) <= at) this.suppressions.delete(id);
        }
    }

    private classify(input: AttentionRouteInput, candidates: readonly AttentionObject[]): CandidateState[] {
        const states: CandidateState[] = [];
        const seen = new Set<Identifier>();
        for (const object of candidates) {
            validateObject(object);
            if (seen.has(object.id)) throw new AttentionError("invalid", "Duplicate attention IDs in scheduling");
            seen.add(object.id);
            const baseScore = schedulingScore(object);
            const adjustment = this.adjustments.get(object.id) ?? 0;
            const score = Math.max(0, baseScore + adjustment);
            const state = (status: CandidateStatus, detail: string): CandidateState =>
                ({ object, baseScore, adjustment, score, status, detail });
            if (!inScope(object, input.scope, input.now)) { states.push(state("scope", "outside scheduling scope")); continue; }
            if (isExpired(object, input.now)) { states.push(state("expired", "attention expired")); continue; }
            if (object.stale) { states.push(state("stale", "stale attention cannot be routed")); continue; }
            const suppression = this.suppressions.get(object.id);
            if (suppression !== undefined) {
                const detail = suppression.until === undefined
                    ? suppression.reason
                    : `${suppression.reason} (until ${suppression.until})`;
                states.push(state("suppressed", detail));
                continue;
            }
            states.push(state("eligible", "eligible for scheduling"));
        }
        return states;
    }

    private record(decision: Omit<SchedulingDecision, "id" | "sequence" | "authorization">): SchedulingDecision {
        this.sequence += 1;
        const recorded: SchedulingDecision = Object.freeze({
            ...decision,
            id: `attention-decision:${this.sequence}`,
            sequence: this.sequence,
            candidates: Object.freeze([...decision.candidates]),
            selected: Object.freeze([...decision.selected]),
            deferred: Object.freeze([...decision.deferred]),
            suppressed: Object.freeze([...decision.suppressed]),
            budget: Object.freeze({ ...decision.budget }),
            usage: Object.freeze({ ...decision.usage }),
            authorization: "not_granted",
        });
        this.decisions.push(recorded);
        return recorded;
    }
}
