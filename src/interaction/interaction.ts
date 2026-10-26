/**
 * Interaction modes: how to relate, not what the task is.
 *
 * Scenarios answer "what domain is this?" (chat, engineering, research...).
 * Interaction answers "what move does this turn need?" (affect, think,
 * inspire, converge, orchestrate). They are orthogonal weight vectors and can
 * be combined: engineering 0.7 + affect 0.2 + converge 0.1.
 *
 * The modes are not a personality test and not a therapy protocol. They are
 * response-shaping policies with explicit guardrails.
 */
import type { MemoryKind } from "../process/agent.ts";

export const InteractionKinds = ["affect", "think", "inspire", "converge", "orchestrate"] as const;
export type InteractionKind = (typeof InteractionKinds)[number];

export type InteractionMix = Partial<Record<InteractionKind, number>>;

export type InteractionContextKey = "self" | "role" | "affect" | "memory" | "relationship" | "membership" | "background";

export type InteractionMove =
    | "validate"
    | "label"
    | "reflect"
    | "support"
    | "boundary"
    | "analyze"
    | "explain"
    | "compare"
    | "test"
    | "question"
    | "diverge"
    | "analogize"
    | "reframe"
    | "prompt"
    | "imagine"
    | "synthesize"
    | "decide"
    | "commit"
    | "summarize"
    | "close"
    | "plan"
    | "assign"
    | "coordinate"
    | "checkin"
    | "handoff";

export type InteractionPhase = "open" | "explore" | "analyze" | "decide" | "close" | "coordinate";

export interface InteractionResponse {
    pace: "fast" | "normal" | "slow";
    verbosity: "terse" | "normal" | "detailed";
    questionRatio: number;
    structure: "narrative" | "bullets" | "dialogue";
}

export interface InteractionAttention {
    /**
     * Divergent breadth, [0,1].
     */
    breadth: number;
    /**
     * Convergent depth, [0,1].
     */
    depth: number;
    /**
     * Tolerance for mode switching, [0,1].
     */
    switchTolerance: number;
}

export interface InteractionSafety {
    noDiagnosis: boolean;
    noManipulation: boolean;
    inviteDissent: boolean;
    escalateRisk: boolean;
    labelHypotheses: boolean;
}

export interface InteractionProfile {
    context: Record<InteractionContextKey, number>;
    memory: Record<MemoryKind, number>;
    moves: InteractionMove[];
    attention: InteractionAttention;
    response: InteractionResponse;
    safety: InteractionSafety;
}

export interface InteractionPlan {
    weights: Record<InteractionKind, number>;
    active: InteractionKind[];
    primary: InteractionKind;
    secondary?: InteractionKind;
    /**
     * Ordered phases: affect -> inspire -> think -> converge -> orchestrate.
     */
    sequence: InteractionKind[];
    moves: InteractionMove[];
    contextWeights: Record<InteractionContextKey, number>;
    memoryKindWeights: Record<MemoryKind, number>;
    attention: InteractionAttention;
    response: InteractionResponse;
    safety: InteractionSafety;
    guardrails: string[];
    rationale: string;
}

const profiles: Record<InteractionKind, InteractionProfile> = {
    affect: {
        context: { self: 0.2, role: 0.05, affect: 0.4, memory: 0.15, relationship: 0.25, membership: 0, background: 0.05 },
        memory: { episodic: 0.2, semantic: 0.05, procedural: 0, social: 0.4, affective: 0.4 },
        moves: ["validate", "label", "reflect", "support", "boundary"],
        attention: { breadth: 0.3, depth: 0.5, switchTolerance: 0.6 },
        response: { pace: "slow", verbosity: "normal", questionRatio: 0.4, structure: "dialogue" },
        safety: { noDiagnosis: true, noManipulation: true, inviteDissent: false, escalateRisk: true, labelHypotheses: false },
    },
    think: {
        context: { self: 0.15, role: 0.1, affect: 0.05, memory: 0.4, relationship: 0, membership: 0, background: 0.1 },
        memory: { episodic: 0.2, semantic: 0.4, procedural: 0.25, social: 0.05, affective: 0.05 },
        moves: ["analyze", "explain", "compare", "test", "question"],
        attention: { breadth: 0.2, depth: 0.9, switchTolerance: 0.4 },
        response: { pace: "normal", verbosity: "detailed", questionRatio: 0.2, structure: "narrative" },
        safety: { noDiagnosis: false, noManipulation: true, inviteDissent: true, escalateRisk: false, labelHypotheses: true },
    },
    inspire: {
        context: { self: 0.15, role: 0, affect: 0.1, memory: 0.5, relationship: 0.1, membership: 0, background: 0.15 },
        memory: { episodic: 0.3, semantic: 0.35, procedural: 0.1, social: 0.1, affective: 0.15 },
        moves: ["diverge", "analogize", "reframe", "prompt", "imagine"],
        attention: { breadth: 0.9, depth: 0.3, switchTolerance: 0.7 },
        response: { pace: "fast", verbosity: "normal", questionRatio: 0.5, structure: "bullets" },
        safety: { noDiagnosis: false, noManipulation: true, inviteDissent: true, escalateRisk: false, labelHypotheses: true },
    },
    converge: {
        context: { self: 0.2, role: 0.25, affect: 0.05, memory: 0.25, relationship: 0.15, membership: 0, background: 0.1 },
        memory: { episodic: 0.25, semantic: 0.3, procedural: 0.25, social: 0.1, affective: 0.05 },
        moves: ["synthesize", "decide", "commit", "summarize", "close"],
        attention: { breadth: 0.2, depth: 0.8, switchTolerance: 0.3 },
        response: { pace: "normal", verbosity: "terse", questionRatio: 0.1, structure: "bullets" },
        safety: { noDiagnosis: false, noManipulation: true, inviteDissent: true, escalateRisk: false, labelHypotheses: false },
    },
    orchestrate: {
        context: { self: 0.1, role: 0.3, affect: 0.05, memory: 0.1, relationship: 0.25, membership: 0.2, background: 0 },
        memory: { episodic: 0.2, semantic: 0.15, procedural: 0.2, social: 0.35, affective: 0.05 },
        moves: ["plan", "assign", "coordinate", "checkin", "handoff"],
        attention: { breadth: 0.6, depth: 0.5, switchTolerance: 0.9 },
        response: { pace: "normal", verbosity: "normal", questionRatio: 0.25, structure: "bullets" },
        safety: { noDiagnosis: false, noManipulation: true, inviteDissent: true, escalateRisk: false, labelHypotheses: false },
    },
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const normalizeContext = (weights: Record<InteractionContextKey, number>): Record<InteractionContextKey, number> => {
    const total = Object.values(weights).reduce((sum, weight) => sum + Math.max(0, weight), 0);
    if (total <= 0) {
        return { self: 1, role: 0, affect: 0, memory: 0, relationship: 0, membership: 0, background: 0 };
    }
    const result = {} as Record<InteractionContextKey, number>;
    for (const key of Object.keys(weights) as InteractionContextKey[]) {
        result[key] = Math.max(0, weights[key]) / total;
    }
    return result;
};

const weighted = <K extends string>(
    weights: Record<InteractionKind, number>,
    read: (profile: InteractionProfile) => Record<K, number>,
    keys: readonly K[],
): Record<K, number> => {
    const result = {} as Record<K, number>;
    for (const key of keys) {
        result[key] = InteractionKinds.reduce<number>((sum, kind) => sum + weights[kind] * read(profiles[kind])[key], 0);
    }
    return result;
};

const vote = <K extends string>(weights: Record<InteractionKind, number>, read: (profile: InteractionProfile) => K): K => {
    const scores = new Map<K, number>();
    for (const kind of InteractionKinds) {
        const key = read(profiles[kind]);
        scores.set(key, (scores.get(key) ?? 0) + weights[kind]);
    }
    let best: K | undefined;
    let bestScore = -1;
    for (const [key, score] of scores) {
        if (score > bestScore) {
            best = key;
            bestScore = score;
        }
    }
    return best as K;
};

export const normalizeInteractionMix = (mix: InteractionMix): Record<InteractionKind, number> => {
    const result = {} as Record<InteractionKind, number>;
    let total = 0;
    for (const kind of InteractionKinds) {
        const raw = mix[kind] ?? 0;
        if (!Number.isFinite(raw) || raw < 0) {
            throw new RangeError(`interaction weight ${kind} must be a finite non-negative number`);
        }
        result[kind] = raw;
        total += raw;
    }
    if (total <= 0) {
        throw new RangeError("interaction mix must contain at least one positive weight");
    }
    for (const kind of InteractionKinds) {
        result[kind] /= total;
    }
    return result;
};

const moveScores = (weights: Record<InteractionKind, number>): Map<InteractionMove, number> => {
    const scores = new Map<InteractionMove, number>();
    for (const kind of InteractionKinds) {
        for (const move of profiles[kind].moves) {
            scores.set(move, (scores.get(move) ?? 0) + weights[kind]);
        }
    }
    return scores;
};

const sequenceFor = (active: InteractionKind[]): InteractionKind[] => {
    const order: InteractionKind[] = ["affect", "inspire", "think", "converge", "orchestrate"];
    const present = new Set(active);
    return order.filter((kind) => present.has(kind));
};

const guardrailsFor = (weights: Record<InteractionKind, number>): string[] => {
    const result: string[] = [];
    if (weights.affect > 0.05) {
        result.push("情感模式：只做倾听、标注、验证与陪伴；不诊断、不宣称治疗、不制造依赖。");
        if (weights.affect > 0.4) {
            result.push("高风险信号（自伤/伤人/急性危机）必须升级给人类或紧急资源。");
        }
    }
    if (weights.inspire > 0.05) {
        result.push("启发模式：把点子标为假设，限制数量，避免用大量选项淹没判断。");
    }
    if (weights.think > 0.05) {
        result.push("思维模式：区分事实/推断/未知，给出可检查的依据，不用流畅感代替正确性。");
    }
    if (weights.converge > 0.05) {
        result.push("收束模式：先给判据与取舍，再给结论；主动邀请反方意见，避免过早闭合。");
    }
    if (weights.orchestrate > 0.05) {
        result.push("统筹模式：明确 owner、依赖与共享状态；不隐藏资源分配与失败。");
    }
    return result;
};

export const resolveInteraction = (mix: InteractionMix): InteractionPlan => {
    const weights = normalizeInteractionMix(mix);
    const active = InteractionKinds.filter((kind) => weights[kind] >= 0.1);
    const ranked = [...InteractionKinds].sort((left, right) => weights[right] - weights[left]);
    const primary = ranked[0];
    const secondary = ranked[1];
    const contextWeights = normalizeContext(
        weighted(weights, (profile) => profile.context, ["self", "role", "affect", "memory", "relationship", "membership", "background"] as const),
    );
    const memoryKindWeights = weighted(weights, (profile) => profile.memory, ["episodic", "semantic", "procedural", "social", "affective"] as const);
    const attention: InteractionAttention = {
        breadth: clamp01(InteractionKinds.reduce((sum, kind) => sum + weights[kind] * profiles[kind].attention.breadth, 0)),
        depth: clamp01(InteractionKinds.reduce((sum, kind) => sum + weights[kind] * profiles[kind].attention.depth, 0)),
        switchTolerance: clamp01(InteractionKinds.reduce((sum, kind) => sum + weights[kind] * profiles[kind].attention.switchTolerance, 0)),
    };
    const response: InteractionResponse = {
        pace: vote(weights, (profile) => profile.response.pace),
        verbosity: vote(weights, (profile) => profile.response.verbosity),
        questionRatio: clamp01(InteractionKinds.reduce((sum, kind) => sum + weights[kind] * profiles[kind].response.questionRatio, 0)),
        structure: vote(weights, (profile) => profile.response.structure),
    };
    const safety: InteractionSafety = {
        noDiagnosis: InteractionKinds.some((kind) => weights[kind] >= 0.1 && profiles[kind].safety.noDiagnosis),
        noManipulation: InteractionKinds.some((kind) => weights[kind] >= 0.1 && profiles[kind].safety.noManipulation),
        inviteDissent: InteractionKinds.some((kind) => weights[kind] >= 0.1 && profiles[kind].safety.inviteDissent),
        escalateRisk: InteractionKinds.some((kind) => weights[kind] >= 0.1 && profiles[kind].safety.escalateRisk),
        labelHypotheses: InteractionKinds.some((kind) => weights[kind] >= 0.1 && profiles[kind].safety.labelHypotheses),
    };
    const moves = [...moveScores(weights).entries()]
        .filter(([, score]) => score > 0)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 10)
        .map(([move]) => move);
    const rationale =
        `${active.length === 0 ? "no active mode" : active.map((kind) => `${kind} ${weights[kind].toFixed(2)}`).join(" + ")}; ` +
        `moves ${moves.join(", ")}; breadth ${attention.breadth.toFixed(2)}, depth ${attention.depth.toFixed(2)}`;
    return {
        weights,
        active,
        primary,
        ...(secondary === (void 0) ? {} : { secondary }),
        sequence: sequenceFor(active),
        moves,
        contextWeights,
        memoryKindWeights,
        attention,
        response,
        safety,
        guardrails: guardrailsFor(weights),
        rationale,
    };
};

/**
 * Combine scenario and interaction context weights as a weighted blend.
 * Scenario sets the task budget; interaction re-weights what matters inside it.
 * The default 40/60 split lets the current interaction mode lead without
 * erasing the task's domain needs. Missing dimensions default to the other plan.
 */
export const combineContextWeights = (
    scenario?: Partial<Record<InteractionContextKey, number>>,
    interaction?: Partial<Record<InteractionContextKey, number>>,
    scenarioWeight: number = 0.4,
): Record<InteractionContextKey, number> => {
    const keys: InteractionContextKey[] = ["self", "role", "affect", "memory", "relationship", "membership", "background"];
    const w = Math.max(0, Math.min(1, scenarioWeight));
    const combined = {} as Record<InteractionContextKey, number>;
    let total = 0;
    for (const key of keys) {
        const scenarioValue = scenario?.[key];
        const interactionValue = interaction?.[key];
        const value =
            scenarioValue === (void 0) && interactionValue === (void 0)
                ? 1
                : scenarioValue === (void 0)
                  ? (interactionValue as number)
                  : interactionValue === (void 0)
                    ? scenarioValue
                    : w * scenarioValue + (1 - w) * interactionValue;
        combined[key] = Math.max(0, value);
        total += combined[key];
    }
    if (total <= 0) {
        return { self: 1, role: 0, affect: 0, memory: 0, relationship: 0, membership: 0, background: 0 };
    }
    for (const key of keys) {
        combined[key] /= total;
    }
    return combined;
};

export const combineMemoryWeights = (
    scenario?: Partial<Record<MemoryKind, number>>,
    interaction?: Partial<Record<MemoryKind, number>>,
    scenarioWeight: number = 0.4,
): Record<MemoryKind, number> | undefined => {
    if (scenario === (void 0) && interaction === (void 0)) {
        return undefined;
    }
    const keys: MemoryKind[] = ["episodic", "semantic", "procedural", "social", "affective"];
    const w = Math.max(0, Math.min(1, scenarioWeight));
    const combined = {} as Record<MemoryKind, number>;
    for (const key of keys) {
        const scenarioValue = scenario?.[key];
        const interactionValue = interaction?.[key];
        combined[key] =
            scenarioValue === (void 0) && interactionValue === (void 0)
                ? 1
                : scenarioValue === (void 0)
                  ? (interactionValue as number)
                  : interactionValue === (void 0)
                    ? scenarioValue
                    : Math.max(0, w * scenarioValue + (1 - w) * interactionValue);
    }
    return combined;
};

export const phaseFor = (plan: InteractionPlan): InteractionPhase => {
    if (plan.weights.affect >= 0.4) {
        return "open";
    }
    if (plan.weights.inspire >= 0.4) {
        return "explore";
    }
    if (plan.weights.think >= 0.4) {
        return "analyze";
    }
    if (plan.weights.converge >= 0.4) {
        return "decide";
    }
    if (plan.weights.orchestrate >= 0.4) {
        return "coordinate";
    }
    return "close";
};

export const isSafeToClose = (plan: InteractionPlan): boolean => {
    return plan.safety.inviteDissent || plan.weights.converge < 0.5;
};
