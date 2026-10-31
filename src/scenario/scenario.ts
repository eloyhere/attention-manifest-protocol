/**
 * Scenarios as weighted mixes, not mutually exclusive modes.
 *
 * A task can be 60% chat, 30% engineering, 10% collaboration. The mix decides:
 * - which context kinds are worth loading,
 * - which memory kinds are relevant,
 * - the token multiplier,
 * - the attention policy (foreground cap, reserve, rest cadence),
 * - output style / tool bias.
 *
 * The goal is not to label a task; it is to spend less context on tasks that
 * do not need it, while keeping the relevant facets for mixed tasks.
 */
import { DefaultAttentionPolicy } from "../attention/resource.ts";
import type { AttentionResourcePolicy } from "../attention/resource.ts";
import type { MemoryKind } from "../process/agent.ts";

type ScenarioKindList = readonly ["chat", "writing", "office", "collaboration", "investigation", "research", "engineering", "iteration"];

export const ScenarioKinds: ScenarioKindList = ["chat", "writing", "office", "collaboration", "investigation", "research", "engineering", "iteration"];
export type ScenarioKind = ScenarioKindList[number];

export type ScenarioMix = Partial<Record<ScenarioKind, number>>;

export type ScenarioContextKey = "self" | "role" | "affect" | "memory" | "relationship" | "membership" | "background";

export type ScenarioMode = "bare" | "compact" | "full";

export interface ScenarioAttention {
    maxForegroundUtil: number;
    reserveRatio: number;
    minSliceSlots: number;
    restAfterCycles: number;
}

export interface ScenarioStyle {
    verbosity: "terse" | "normal" | "detailed";
    toolBias: "none" | "light" | "heavy";
}

export interface ScenarioProfile {
    context: Record<ScenarioContextKey, number>;
    memory: Record<MemoryKind, number>;
    tokenFactor: number;
    contextDepth: number;
    attention: ScenarioAttention;
    style: ScenarioStyle;
}

export interface ScenarioPlan {
    /**
     * Normalized weights; always sums to 1.
     */
    weights: Record<ScenarioKind, number>;
    active: ScenarioKind[];
    contextWeights: Record<ScenarioContextKey, number>;
    memoryKindWeights: Record<MemoryKind, number>;
    tokenBudgetFactor: number;
    contextDepth: number;
    mode: ScenarioMode;
    attention: ScenarioAttention;
    style: ScenarioStyle;
    rationale: string;
}

type ScenarioWeights = Record<ScenarioKind, number>;

type ContextWeights = Record<ScenarioContextKey, number>;

const Profiles: Record<ScenarioKind, ScenarioProfile> = {
    chat: {
        context: { self: 0.15, role: 0.05, affect: 0.3, memory: 0.35, relationship: 0.25, membership: 0, background: 0.05 },
        memory: { episodic: 0.3, semantic: 0.1, procedural: 0.05, social: 0.5, affective: 0.3 },
        tokenFactor: 0.4,
        contextDepth: 0.2,
        attention: { maxForegroundUtil: 0.5, reserveRatio: 0.35, minSliceSlots: 1, restAfterCycles: 10 },
        style: { verbosity: "terse", toolBias: "none" },
    },
    writing: {
        context: { self: 0.35, role: 0.2, affect: 0.1, memory: 0.25, relationship: 0.05, membership: 0, background: 0.05 },
        memory: { episodic: 0.2, semantic: 0.4, procedural: 0.3, social: 0.05, affective: 0.05 },
        tokenFactor: 0.8,
        contextDepth: 0.5,
        attention: { maxForegroundUtil: 0.7, reserveRatio: 0.25, minSliceSlots: 1, restAfterCycles: 8 },
        style: { verbosity: "normal", toolBias: "light" },
    },
    office: {
        context: { self: 0.2, role: 0.3, affect: 0.1, memory: 0.25, relationship: 0.1, membership: 0.15, background: 0.05 },
        memory: { episodic: 0.2, semantic: 0.35, procedural: 0.3, social: 0.1, affective: 0.05 },
        tokenFactor: 0.7,
        contextDepth: 0.6,
        attention: { maxForegroundUtil: 0.65, reserveRatio: 0.3, minSliceSlots: 1, restAfterCycles: 8 },
        style: { verbosity: "normal", toolBias: "light" },
    },
    collaboration: {
        context: { self: 0.15, role: 0.25, affect: 0.2, memory: 0.15, relationship: 0.3, membership: 0.15, background: 0.05 },
        memory: { episodic: 0.2, semantic: 0.15, procedural: 0.1, social: 0.4, affective: 0.15 },
        tokenFactor: 0.8,
        contextDepth: 0.7,
        attention: { maxForegroundUtil: 0.7, reserveRatio: 0.3, minSliceSlots: 1, restAfterCycles: 8 },
        style: { verbosity: "normal", toolBias: "light" },
    },
    investigation: {
        context: { self: 0.1, role: 0.15, affect: 0.05, memory: 0.35, relationship: 0.15, membership: 0.1, background: 0.1 },
        memory: { episodic: 0.4, semantic: 0.2, procedural: 0.15, social: 0.15, affective: 0.1 },
        tokenFactor: 1.2,
        contextDepth: 0.9,
        attention: { maxForegroundUtil: 0.8, reserveRatio: 0.2, minSliceSlots: 2, restAfterCycles: 6 },
        style: { verbosity: "detailed", toolBias: "heavy" },
    },
    research: {
        context: { self: 0.2, role: 0.15, affect: 0.05, memory: 0.45, relationship: 0.05, membership: 0.05, background: 0.05 },
        memory: { episodic: 0.15, semantic: 0.5, procedural: 0.2, social: 0.05, affective: 0.05 },
        tokenFactor: 1.3,
        contextDepth: 0.9,
        attention: { maxForegroundUtil: 0.8, reserveRatio: 0.2, minSliceSlots: 2, restAfterCycles: 8 },
        style: { verbosity: "detailed", toolBias: "heavy" },
    },
    engineering: {
        context: { self: 0.15, role: 0.2, affect: 0.1, memory: 0.35, relationship: 0.05, membership: 0.05, background: 0.1 },
        memory: { episodic: 0.2, semantic: 0.25, procedural: 0.4, social: 0.05, affective: 0.1 },
        tokenFactor: 1.1,
        contextDepth: 0.85,
        attention: { maxForegroundUtil: 0.8, reserveRatio: 0.2, minSliceSlots: 2, restAfterCycles: 6 },
        style: { verbosity: "normal", toolBias: "heavy" },
    },
    iteration: {
        context: { self: 0.15, role: 0.2, affect: 0.2, memory: 0.35, relationship: 0.05, membership: 0.05, background: 0.1 },
        memory: { episodic: 0.4, semantic: 0.1, procedural: 0.3, social: 0.05, affective: 0.15 },
        tokenFactor: 0.8,
        contextDepth: 0.7,
        attention: { maxForegroundUtil: 0.7, reserveRatio: 0.25, minSliceSlots: 2, restAfterCycles: 5 },
        style: { verbosity: "terse", toolBias: "light" },
    },
};

type Clamp = (value: number, min: number, max: number) => number;

const clamp: Clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const clamp01: (value: number) => number = (value: number): number => clamp(value, 0, 1);

const normalizeContext: (weights: ContextWeights) => ContextWeights = (weights: ContextWeights): ContextWeights => {
    const total: number = Object.values(weights).reduce((sum, weight) => sum + Math.max(0, weight), 0);
    if (total <= 0) {
        return { self: 1, role: 0, affect: 0, memory: 0, relationship: 0, membership: 0, background: 0 };
    }
    const result: ContextWeights = {} as ContextWeights;
    const keys: ScenarioContextKey[] = Object.keys(weights) as ScenarioContextKey[];
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: ScenarioContextKey = keys[index];
        result[key] = Math.max(0, weights[key]) / total;
    }
    return result;
};

type WeightedReader<K extends string> = (profile: ScenarioProfile) => Record<K, number>;

type WeightedFunction = <K extends string>(weights: ScenarioWeights, read: WeightedReader<K>, keys: readonly K[]) => Record<K, number>;

const weighted: WeightedFunction = <K extends string>(weights: ScenarioWeights, read: WeightedReader<K>, keys: readonly K[]): Record<K, number> => {
    const result: Record<K, number> = {} as Record<K, number>;
    for (let index: number = 0; index < keys.length; index += 1) {
        const key: K = keys[index];
        result[key] = ScenarioKinds.reduce<number>((sum, kind) => sum + weights[kind] * read(Profiles[kind])[key], 0);
    }
    return result;
};

type VoteReader<K extends string> = (profile: ScenarioProfile) => K;

type VoteFunction = <K extends string>(weights: ScenarioWeights, read: VoteReader<K>) => K;

const vote: VoteFunction = <K extends string>(weights: ScenarioWeights, read: VoteReader<K>): K => {
    const scores: Map<K, number> = new Map<K, number>();
    for (let kindIndex: number = 0; kindIndex < ScenarioKinds.length; kindIndex += 1) {
        const kind: ScenarioKind = ScenarioKinds[kindIndex];
        const key: K = read(Profiles[kind]);
        scores.set(key, (scores.get(key) ?? 0) + weights[kind]);
    }
    let best: K | undefined;
    let bestScore: number = -1;
    const entries: Array<[K, number]> = [...scores];
    for (let index: number = 0; index < entries.length; index += 1) {
        const entry: [K, number] = entries[index];
        if (entry[1] > bestScore) {
            best = entry[0];
            bestScore = entry[1];
        }
    }
    return best as K;
};

/**
 * Normalize a mix; zeros are allowed, negatives and empty mixes are rejected.
 */
export const normalizeScenarioMix: (mix: ScenarioMix) => ScenarioWeights = (mix: ScenarioMix): ScenarioWeights => {
    const result: ScenarioWeights = {} as ScenarioWeights;
    let maximum: number = 0;
    for (let index: number = 0; index < ScenarioKinds.length; index += 1) {
        const kind: ScenarioKind = ScenarioKinds[index];
        const raw: number = mix[kind] ?? 0;
        if (!Number.isFinite(raw) || raw < 0) {
            throw new RangeError(`scenario weight ${kind} must be a finite non-negative number`);
        }
        result[kind] = raw;
        maximum = Math.max(maximum, raw);
    }
    if (maximum <= 0) {
        throw new RangeError("scenario mix must contain at least one positive weight");
    }
    const total: number = ScenarioKinds.reduce((sum, kind) => sum + result[kind] / maximum, 0);
    for (let index: number = 0; index < ScenarioKinds.length; index += 1) {
        const kind: ScenarioKind = ScenarioKinds[index];
        result[kind] = (result[kind] / maximum) / total;
    }
    return result;
};

export const resolveScenario: (mix: ScenarioMix) => ScenarioPlan = (mix: ScenarioMix): ScenarioPlan => {
    const weights: ScenarioWeights = normalizeScenarioMix(mix);
    const contextRaw: ContextWeights = weighted(weights, (profile) => profile.context, [
        "self",
        "role",
        "affect",
        "memory",
        "relationship",
        "membership",
        "background",
    ] as const);
    const memoryKindWeights: Record<MemoryKind, number> = weighted(weights, (profile) => profile.memory, [
        "episodic",
        "semantic",
        "procedural",
        "social",
        "affective",
    ] as const);
    const tokenBudgetFactor: number = clamp(
        ScenarioKinds.reduce((sum, kind) => sum + weights[kind] * Profiles[kind].tokenFactor, 0),
        0.3,
        1.5,
    );
    const contextDepth: number = clamp01(ScenarioKinds.reduce((sum, kind) => sum + weights[kind] * Profiles[kind].contextDepth, 0));
    const attention: ScenarioAttention = {
        maxForegroundUtil: clamp(
            ScenarioKinds.reduce((sum, kind) => sum + weights[kind] * Profiles[kind].attention.maxForegroundUtil, 0),
            0.4,
            0.9,
        ),
        reserveRatio: clamp(
            ScenarioKinds.reduce((sum, kind) => sum + weights[kind] * Profiles[kind].attention.reserveRatio, 0),
            0.15,
            0.4,
        ),
        minSliceSlots: Math.max(1, Math.round(ScenarioKinds.reduce((sum, kind) => sum + weights[kind] * Profiles[kind].attention.minSliceSlots, 0))),
        restAfterCycles: Math.max(3, Math.round(ScenarioKinds.reduce((sum, kind) => sum + weights[kind] * Profiles[kind].attention.restAfterCycles, 0))),
    };
    const active: ScenarioKind[] = ScenarioKinds.filter((kind) => weights[kind] >= 0.1);
    const mode: ScenarioMode = contextDepth < 0.35 ? "bare" : contextDepth < 0.7 ? "compact" : "full";
    const style: ScenarioStyle = {
        verbosity: vote(weights, (profile) => profile.style.verbosity),
        toolBias: vote(weights, (profile) => profile.style.toolBias),
    };
    const rationale: string =
        `${active.length === 0 ? "no active scenario" : active.map((kind) => `${kind} ${weights[kind].toFixed(2)}`).join(" + ")}` +
        ` -> ${mode}; token x${tokenBudgetFactor.toFixed(2)}; context depth ${contextDepth.toFixed(2)}`;
    return {
        weights,
        active,
        contextWeights: normalizeContext(contextRaw),
        memoryKindWeights,
        tokenBudgetFactor,
        contextDepth,
        mode,
        attention,
        style,
        rationale,
    };
};

export const contextBudgetTokens: (plan: ScenarioPlan, baseTokens: number) => number = (plan: ScenarioPlan, baseTokens: number): number => {
    if (!Number.isFinite(baseTokens) || baseTokens < 0) {
        throw new RangeError("baseTokens must be a non-negative finite number");
    }
    return Math.max(32, Math.round(baseTokens * plan.tokenBudgetFactor));
};

type PolicyFn = (plan: ScenarioPlan, base?: AttentionResourcePolicy) => AttentionResourcePolicy;

export const scenarioAttentionPolicy: PolicyFn = (plan: ScenarioPlan, base: AttentionResourcePolicy = DefaultAttentionPolicy): AttentionResourcePolicy => {
    return {
        ...base,
        maxForegroundUtil: plan.attention.maxForegroundUtil,
        reserveRatio: plan.attention.reserveRatio,
        minSliceSlots: plan.attention.minSliceSlots,
        restAfterCycles: plan.attention.restAfterCycles,
    };
};

export const shouldUseBareContext: (plan: ScenarioPlan) => boolean = (plan: ScenarioPlan): boolean => plan.mode === "bare";
