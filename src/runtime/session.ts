/**
 * Multi-turn runtime session: attention state, belief priors and feedback.
 *
 * The session is the memory of the loop, not the model's context. It records
 * posterior evidence and updates the agent's cognitive state from telemetry.
 */
import type { AttentionPlan } from "../attention/resource.ts";
import type { CognitiveState } from "../attention/cognition.ts";
import { applyRest, shouldRest as shouldRestState } from "../attention/resource.ts";
import type { AttentionResourcePolicy } from "../attention/resource.ts";
import type { AnswerScore, BetaBelief, Dimension, Evidence, UserScore } from "../bayes/engine.ts";
import { BayesianEngine } from "../bayes/engine.ts";
import { SourceReliability } from "../bayes/reliability.ts";
import type { ReliabilityBelief } from "../bayes/reliability.ts";
import { ScopedPriors } from "../bayes/scopedPriors.ts";
import type { ScenarioMix } from "../scenario/scenario.ts";
import type { InteractionMix } from "../interaction/interaction.ts";
import type { TelemetrySample } from "./telemetry.ts";
import type { BehaviorPlan } from "./behavior.ts";
import type { ActionRecord } from "./action.ts";
import type { ApprovalRecord, OperationRecord } from "./operation.ts";

export interface SessionAttentionState extends CognitiveState {
    stress: number;
    fatigue: number;
    recoveryDebt: number;
}

export interface SessionTurnRecord {
    turnId: string;
    at: string;
    /** Prior scope for this turn, e.g. "session:engineering". */
    scope?: string;
    user: UserScore;
    answerScore?: AnswerScore;
    attention: AttentionPlan;
    latencyMs?: number;
    tokens?: number;
    toolErrors?: number;
    telemetry?: TelemetrySample;
    behavior?: BehaviorPlan;
    actions?: ActionRecord[];
    operations?: OperationRecord[];
    approvals?: ApprovalRecord[];
}

export interface TurnFeedback {
    helpful?: boolean;
    correction?: string;
    /** Optional ground truth for answer quality; updates source reliability. */
    actualCorrect?: boolean;
}

export interface SessionSnapshot {
    id?: string;
    scope?: string;
    state: SessionAttentionState;
    priors: Record<Dimension, BetaBelief>;
    history: SessionTurnRecord[];
    /** Monotonic turn counter so IDs survive runtime restarts. */
    turnCounter?: number;
    /** Monotonic session mutation version. */
    version?: number;
    /** Behavior arbitration counts, e.g. "affect<-clarify": 3. */
    behaviorConflicts?: Record<string, number>;
    /** Learned source reliability (Beta beliefs). */
    sourceReliability?: Record<string, ReliabilityBelief>;
    /** Scope-level priors (global + local counts). */
    scopedPriors?: { global: Record<Dimension, BetaBelief>; scopes: Record<string, Record<Dimension, BetaBelief>> };
    /** Set when the agent is archived but the snapshot is retained. */
    archivedAt?: string;
}

export interface RuntimeSessionOptions {
    id?: string;
    /** Prior scope, e.g. task/scenario id. */
    scope?: string;
    initial?: SessionAttentionState;
    bayes?: BayesianEngine;
    scenarioMix?: ScenarioMix;
    interactionMix?: InteractionMix;
    maxHistory?: number;
}

const defaultState = (): SessionAttentionState => ({
    load: 0.3,
    vigilance: 0.8,
    arousal: 0.2,
    mastery: 0.6,
    accountability: 0.5,
    cyclesSinceRest: 0,
    capacityEff: 4,
    pLapse: 0.2,
    source: "default",
    samples: 0,
    stress: 0.2,
    fatigue: 0.2,
    recoveryDebt: 0.1,
});

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class RuntimeSession {
    readonly id: string;
    state: SessionAttentionState;
    readonly bayes: BayesianEngine;
    readonly history: SessionTurnRecord[] = [];
    readonly behaviorConflicts: Record<string, number> = {};
    readonly reliability = new SourceReliability();
    readonly scope: string;
    readonly scopedPriors = new ScopedPriors();
    readonly scenarioMix?: ScenarioMix;
    readonly interactionMix?: InteractionMix;
    private readonly maxHistory: number;
    private turnCounter = 0;
    private version = 0;

    constructor(options: RuntimeSessionOptions = {}) {
        this.id = options.id ?? "session.local";
        this.scope = options.scope ?? "default";
        this.state = options.initial ?? defaultState();
        this.bayes = options.bayes ?? new BayesianEngine();
        this.scenarioMix = options.scenarioMix;
        this.interactionMix = options.interactionMix;
        this.maxHistory = options.maxHistory ?? 100;
    }

    /** Allocate a stable turn id; survives serialization/restore. */
    nextTurnId(): string {
        this.turnCounter += 1;
        return `rt.${this.turnCounter}`;
    }

    /** Engine with this scope's priors + learned source weights. */
    engineFor(scope: string = this.scope): BayesianEngine {
        const engine = this.scopedPriors.engineFor(scope);
        engine.setSourceWeights(this.reliability.weights());
        return engine;
    }

    /** Record a completed turn and update attention + priors from evidence. */
    record(turn: SessionTurnRecord): void {
        const quality = turn.answerScore?.overall ?? 0.5;
        const toolErrors = turn.toolErrors ?? 0;
        const latencyPressure = (turn.latencyMs ?? 0) > 5000 ? 0.2 : 0;
        const systemLoad = clamp01(turn.telemetry?.systemLoad ?? 0);
        const loopLag = turn.telemetry?.eventLoopLagMs ?? 0;
        const errorRate = clamp01(turn.telemetry?.errorRate ?? 0);
        const pressure = clamp01(turn.attention.pressure + latencyPressure + toolErrors * 0.1 + systemLoad * 0.1 + (loopLag > 50 ? 0.2 : 0) + errorRate * 0.2);
        const effectiveUtilization = clamp01(Math.max(turn.attention.utilization, (turn.tokens ?? 0) / 4000, systemLoad * 0.5));
        const vigilance = 0.9 * this.state.vigilance + 0.1 * (quality > 0.55 ? 0.85 : 0.4) - toolErrors * 0.02 - errorRate * 0.05;
        this.state = {
            ...this.state,
            load: clamp01(0.7 * this.state.load + 0.3 * effectiveUtilization),
            vigilance: clamp01(vigilance),
            arousal: clamp01(0.8 * this.state.arousal + 0.2 * pressure),
            stress: clamp01(0.7 * this.state.stress + 0.3 * pressure),
            fatigue: clamp01(this.state.fatigue + 0.01 + pressure * 0.02 + toolErrors * 0.02 + (loopLag > 50 ? 0.02 : 0)),
            cyclesSinceRest: this.state.cyclesSinceRest + 1,
            recoveryDebt: clamp01(0.7 * this.state.recoveryDebt + 0.3 * (1 - quality)),
            pLapse: clamp01(1 - vigilance),
        };
        if (turn.answerScore !== undefined) this.bayes.learn(turn.answerScore.evidence);
        if (turn.answerScore !== undefined) this.scopedPriors.observe(turn.scope ?? this.scope, turn.answerScore.evidence);
        for (const conflict of turn.behavior?.conflicts ?? []) {
            const key = `${conflict.winner}<-${conflict.loser}`;
            this.behaviorConflicts[key] = (this.behaviorConflicts[key] ?? 0) + 1;
        }
        this.history.push(turn);
        if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
        this.version += 1;
    }

    /** User feedback becomes evidence, not a direct score overwrite. */
    feedback(turnId: string, feedback: TurnFeedback): Evidence[] {
        const turn = this.history.find((entry) => entry.turnId === turnId);
        if (turn === undefined) throw new Error(`unknown turn ${turnId}`);
        const evidence: Evidence[] = [];
        if (feedback.helpful !== undefined) {
            evidence.push({
                dimension: "helpfulness",
                positive: feedback.helpful ? 4 : 0,
                negative: feedback.helpful ? 0 : 4,
                reliability: 0.9,
                source: "user-feedback",
            });
        }
        if (feedback.correction !== undefined && feedback.correction.trim().length > 0) {
            evidence.push({
                dimension: "correctness",
                positive: 0,
                negative: 3,
                reliability: 0.7,
                source: "user-correction",
                note: feedback.correction.slice(0, 200),
            });
        }
        if (feedback.actualCorrect !== undefined) {
            evidence.push({
                dimension: "correctness",
                positive: feedback.actualCorrect ? 4 : 0,
                negative: feedback.actualCorrect ? 0 : 4,
                reliability: 0.95,
                source: "user-feedback",
            });
            for (const item of turn.answerScore?.evidence ?? []) {
                if (item.positive <= 0 && item.negative <= 0) continue;
                const predictedPositive = item.positive >= item.negative;
                this.reliability.observe(item.source, predictedPositive === feedback.actualCorrect, Math.max(0.1, item.reliability));
            }
            this.bayes.setSourceWeights(this.reliability.weights());
        }
        if (evidence.length > 0) this.bayes.learn(evidence);
        if (evidence.length > 0) this.scopedPriors.observe(turn.scope ?? this.scope, evidence);
        this.state = {
            ...this.state,
            vigilance: clamp01(this.state.vigilance + (feedback.helpful === true ? 0.02 : -0.02)),
            stress: clamp01(this.state.stress + (feedback.helpful === false ? 0.05 : 0)),
            recoveryDebt: clamp01(this.state.recoveryDebt + (feedback.helpful === false ? 0.05 : 0)),
        };
        this.version += 1;
        return evidence;
    }

    shouldRest(policy?: AttentionResourcePolicy): boolean {
        return shouldRestState(this.state, policy);
    }

    rest(cycles = 1): SessionAttentionState {
        this.state = applyRest(this.state, cycles) as SessionAttentionState;
        this.version += 1;
        return this.state;
    }

    snapshot(): {
        state: SessionAttentionState;
        priors: Record<Dimension, BetaBelief>;
        turns: number;
        behaviorConflicts: Record<string, number>;
        sourceReliability: Record<string, ReliabilityBelief>;
        scopedPriors: { global: Record<Dimension, BetaBelief>; scopes: Record<string, Record<Dimension, BetaBelief>> };
    } {
        return {
            state: { ...this.state },
            priors: this.bayes.snapshot(),
            turns: this.history.length,
            behaviorConflicts: { ...this.behaviorConflicts },
            sourceReliability: this.reliability.snapshot(),
            scopedPriors: this.scopedPriors.snapshot(),
        };
    }

    serialize(): SessionSnapshot {
        return {
            id: this.id,
            scope: this.scope,
            state: { ...this.state },
            priors: this.bayes.snapshot(),
            history: this.history.map((turn) => JSON.parse(JSON.stringify(turn)) as SessionTurnRecord),
            turnCounter: this.turnCounter,
            version: this.version,
            behaviorConflicts: { ...this.behaviorConflicts },
            sourceReliability: this.reliability.snapshot(),
            scopedPriors: this.scopedPriors.snapshot(),
        };
    }

    static restore(snapshot: SessionSnapshot, options: Omit<RuntimeSessionOptions, "bayes" | "initial"> = {}): RuntimeSession {
        const session = new RuntimeSession({
            ...options,
            id: snapshot.id ?? options.id,
            scope: snapshot.scope ?? options.scope,
            bayes: new BayesianEngine(snapshot.priors),
        });
        session.state = { ...snapshot.state };
        session.history.push(...snapshot.history.slice(-session.maxHistory));
        session.turnCounter = snapshot.turnCounter ?? session.history.length;
        session.version = snapshot.version ?? 0;
        Object.assign(session.behaviorConflicts, snapshot.behaviorConflicts ?? {});
        session.reliability.load(snapshot.sourceReliability ?? {});
        if (snapshot.scopedPriors !== undefined) session.scopedPriors.load(snapshot.scopedPriors);
        session.bayes.setSourceWeights(session.reliability.weights());
        return session;
    }
}
