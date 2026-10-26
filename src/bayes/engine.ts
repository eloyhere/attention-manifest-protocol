/**
 * Bayesian scoring for interaction evidence.
 *
 * Three families of latent variables:
 * - user input: clarity, specificity, context sufficiency, emotional intensity, urgency, openness
 * - answer quality: correctness, grounding, coherence, conciseness, calibration, safety, actionability
 * - attention: load, vigilance, stress, fatigue, recovery debt
 *
 * Each is a Beta belief updated with graded evidence. Evidence is discounted by
 * source reliability; priors are weak by default. This is a scoring model, not a
 * claim that the agent has feelings or that a single score is ground truth.
 */
import type { InteractionPlan } from "../interaction/interaction.ts";

export type UserDimension = "clarity" | "specificity" | "contextSufficiency" | "emotionalIntensity" | "urgency" | "openness";
export type AnswerDimension = "correctness" | "grounding" | "coherence" | "conciseness" | "calibration" | "safety" | "actionability" | "helpfulness";
export type AttentionDimension = "load" | "vigilance" | "stress" | "fatigue" | "recoveryDebt";
export type Dimension = UserDimension | AnswerDimension | AttentionDimension;

export interface BetaBelief {
    alpha: number;
    beta: number;
}

export interface Posterior extends BetaBelief {
    mean: number;
    variance: number;
    /** Approximate 95% credible interval. */
    interval: [number, number];
    evidenceCount: number;
}

export interface Evidence {
    dimension: Dimension;
    positive: number;
    negative: number;
    /** 0..1; self-report and weak heuristics should be discounted. */
    reliability: number;
    source: string;
    note?: string;
}

export interface UserFeatures {
    words: number;
    questions: number;
    numbers: number;
    affectHits: number;
    urgencyHits: number;
    vagueHits: number;
    calmHits: number;
    opennessHits: number;
    closureHits: number;
    constraints: number;
    exclamations: number;
    capsRatio: number;
}

export interface AnswerFeatures {
    words: number;
    sentences: number;
    structure: boolean;
    refs: number;
    numbers: number;
    hedges: number;
    overclaims: number;
    actions: number;
    vague: number;
    repeatRatio: number;
    refusal: boolean;
    escalation: boolean;
}

export interface AnswerMeta {
    correct?: boolean;
    grounded?: boolean;
    safe?: boolean;
    uncertain?: boolean;
    targetTokens?: number;
    /** User feedback: helpful/not helpful. */
    helpful?: boolean;
}

export interface AttentionMetrics {
    utilization: number;
    pressure: number;
    recoveryDebt: number;
    errors: number;
    switches: number;
    latencyMs?: number;
    targetLatencyMs?: number;
    vigilance?: number;
    stress?: number;
    fatigue?: number;
}

export interface UserScore {
    dimensions: Record<UserDimension, Posterior>;
    /** Quality of the input as a request, not the person's worth. */
    quality: number;
    /** State signals, not quality. */
    state: { emotionalIntensity: number; urgency: number; openness: number };
    evidence: Evidence[];
}

export interface AnswerScore {
    dimensions: Record<AnswerDimension, Posterior>;
    overall: number;
    evidence: Evidence[];
}

export interface AttentionScore {
    dimensions: Record<AttentionDimension, Posterior>;
    health: number;
    evidence: Evidence[];
}

export interface InteractionFit {
    score: number;
    reasons: string[];
}

export const DEFAULT_PRIORS: Record<Dimension, BetaBelief> = {
    clarity: { alpha: 2, beta: 2 },
    specificity: { alpha: 2, beta: 2 },
    contextSufficiency: { alpha: 2, beta: 2 },
    emotionalIntensity: { alpha: 2, beta: 2 },
    urgency: { alpha: 2, beta: 2 },
    openness: { alpha: 2, beta: 2 },
    correctness: { alpha: 2, beta: 2 },
    grounding: { alpha: 2, beta: 2 },
    coherence: { alpha: 2, beta: 2 },
    conciseness: { alpha: 2, beta: 2 },
    calibration: { alpha: 2, beta: 2 },
    safety: { alpha: 2, beta: 2 },
    actionability: { alpha: 2, beta: 2 },
    helpfulness: { alpha: 2, beta: 2 },
    load: { alpha: 2, beta: 2 },
    vigilance: { alpha: 2, beta: 2 },
    stress: { alpha: 2, beta: 2 },
    fatigue: { alpha: 2, beta: 2 },
    recoveryDebt: { alpha: 2, beta: 2 },
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const betaMean = (belief: BetaBelief): number => belief.alpha / (belief.alpha + belief.beta);

export const betaVariance = (belief: BetaBelief): number => {
    const total = belief.alpha + belief.beta;
    return (belief.alpha * belief.beta) / (total * total * (total + 1));
};

export const posteriorOf = (prior: BetaBelief, evidence: readonly Evidence[], dimension: Dimension, sourceWeights: Record<string, number> = {}): Posterior => {
    let alpha = prior.alpha;
    let beta = prior.beta;
    let used = 0;
    for (const item of evidence) {
        if (item.dimension !== dimension) continue;
        const weight = clamp01(item.reliability) * clamp01(sourceWeights[item.source] ?? 1);
        alpha += Math.max(0, item.positive) * weight;
        beta += Math.max(0, item.negative) * weight;
        used += 1;
    }
    const belief = { alpha, beta };
    const mean = betaMean(belief);
    const variance = betaVariance(belief);
    const sd = Math.sqrt(variance);
    return {
        alpha,
        beta,
        mean,
        variance,
        interval: [clamp01(mean - 1.96 * sd), clamp01(mean + 1.96 * sd)],
        evidenceCount: used,
    };
};

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

const wordsOf = (text: string): string[] => (text.trim().length === 0 ? [] : text.trim().split(/\s+/));

const lexicons = {
    affect: /\b(anxious|afraid|angry|furious|frustrated|overwhelmed|hurt|sad|lonely|excited|happy|grateful|worried|stressed|burned out|exhausted)\b/gi,
    urgency: /\b(now|asap|urgent|urgently|deadline|today|immediately|right away|blocker|blocked)\b/gi,
    vague: /\b(stuff|things|something|somehow|whatever|etc|you know|kind of|sort of)\b/gi,
    calm: /\b(fine|okay|no rush|whenever|later|calm|relaxed)\b/gi,
    openness: /\b(maybe|perhaps|options|alternatives|explore|brainstorm|ideas|open to|not sure)\b/gi,
    closure: /\b(must|only|final|decide|exactly|no other)\b/gi,
    constraints: /\b(within|at most|at least|must|only|before|after|because|given|constraint)\b/gi,
    hedge: /\b(maybe|perhaps|might|could|likely|probably|uncertain|not sure|I think|appears)\b/gi,
    overclaim: /\b(definitely|certainly|always|never|guaranteed|proven|obviously|undoubtedly)\b/gi,
    action: /\b(run|check|verify|send|open|test|measure|compare|write|fix|review|ask|schedule|assign|rollback)\b/gi,
    structure: /(^|\n)\s*([-*]|\d+\.)\s+/m,
    references: /\b(https?:\/\/|doi:|source:|ref:|\[\d+\])/gi,
};

export const extractUserFeatures = (text: string): UserFeatures => {
    const words = wordsOf(text);
    const letters = text.replace(/[^A-Za-z]/g, "");
    const caps = text.replace(/[^A-Z]/g, "").length;
    return {
        words: words.length,
        questions: count(text, /\?/g),
        numbers: count(text, /\b\d+(?:\.\d+)?\b/g),
        affectHits: count(text, lexicons.affect),
        urgencyHits: count(text, lexicons.urgency),
        vagueHits: count(text, lexicons.vague),
        calmHits: count(text, lexicons.calm),
        opennessHits: count(text, lexicons.openness),
        closureHits: count(text, lexicons.closure),
        constraints: count(text, lexicons.constraints),
        exclamations: count(text, /!/g),
        capsRatio: letters.length === 0 ? 0 : caps / letters.length,
    };
};

export const extractAnswerFeatures = (text: string): AnswerFeatures => {
    const words = wordsOf(text);
    const sentences = Math.max(1, count(text, /[.!?](\s|$)/g));
    const unique = new Set(words.map((word) => word.toLowerCase()));
    return {
        words: words.length,
        sentences,
        structure: lexicons.structure.test(text) || /\n\s*\n/.test(text),
        refs: count(text, lexicons.references),
        numbers: count(text, /\b\d+(?:\.\d+)?\b/g),
        hedges: count(text, lexicons.hedge),
        overclaims: count(text, lexicons.overclaim),
        actions: count(text, lexicons.action),
        vague: count(text, lexicons.vague),
        repeatRatio: words.length === 0 ? 0 : 1 - unique.size / words.length,
        refusal: /\b(cannot|can't|unable|refuse|not able)\b/i.test(text),
        escalation: /\b(emergency|human|professional|hotline|crisis)\b/i.test(text),
    };
};

const userEvidence = (features: UserFeatures): Evidence[] => {
    const clarityPositive = (features.questions > 0 ? 0.6 : 0) + (features.words >= 8 ? 0.2 : 0) + (features.vagueHits === 0 ? 0.2 : 0);
    const clarityNegative = features.vagueHits * 0.35 + (features.words < 3 ? 0.3 : 0);
    const specificityPositive = Math.min(1, features.numbers * 0.2 + features.constraints * 0.15);
    const specificityNegative = features.vagueHits * 0.3;
    const contextPositive = Math.min(1, features.words / 80) * 0.5 + Math.min(0.3, features.constraints * 0.1);
    const emotionalPositive = Math.min(1, features.affectHits * 0.3 + features.exclamations * 0.08 + features.capsRatio * 1.2);
    const emotionalNegative = features.calmHits * 0.15;
    const urgencyPositive = Math.min(1, features.urgencyHits * 0.4);
    const urgencyNegative = features.calmHits * 0.2;
    const opennessPositive = Math.min(1, features.opennessHits * 0.3);
    const opennessNegative = features.closureHits * 0.15;
    return [
        { dimension: "clarity", positive: clarityPositive, negative: clarityNegative, reliability: 0.7, source: "text" },
        { dimension: "specificity", positive: specificityPositive, negative: specificityNegative, reliability: 0.7, source: "text" },
        { dimension: "contextSufficiency", positive: contextPositive, negative: 0, reliability: 0.6, source: "text" },
        { dimension: "emotionalIntensity", positive: emotionalPositive, negative: emotionalNegative, reliability: 0.55, source: "text" },
        { dimension: "urgency", positive: urgencyPositive, negative: urgencyNegative, reliability: 0.6, source: "text" },
        { dimension: "openness", positive: opennessPositive, negative: opennessNegative, reliability: 0.55, source: "text" },
    ];
};

const answerEvidence = (text: string, meta: AnswerMeta = {}): Evidence[] => {
    const features = extractAnswerFeatures(text);
    const target = meta.targetTokens ?? 200;
    const correctnessPositive = meta.correct === true ? 5 : meta.correct === undefined ? (features.numbers > 0 ? 0.3 : features.words <= 40 ? 0.2 : 0) : 0;
    const correctnessNegative = meta.correct === false ? 5 : meta.correct === undefined ? features.vague * 0.2 + features.overclaims * 0.2 : 0;
    return [
        {
            dimension: "correctness",
            positive: correctnessPositive,
            negative: correctnessNegative,
            reliability: meta.correct === undefined ? 0.35 : 1,
            source: meta.correct === undefined ? "heuristic" : "checker",
        },
        {
            dimension: "grounding",
            positive: Math.min(1, features.refs * 0.4 + features.numbers * 0.15),
            negative: features.vague * 0.2,
            reliability: 0.65,
            source: "text",
        },
        {
            dimension: "coherence",
            positive: (features.structure ? 0.4 : 0) + Math.min(0.4, features.words / 200) + (features.hedges === 0 ? 0.1 : 0),
            negative: features.repeatRatio * 0.8 + (features.words < 5 ? 0.4 : 0),
            reliability: 0.6,
            source: "text",
        },
        {
            dimension: "conciseness",
            positive: features.words <= target ? 0.6 : 0,
            negative: features.words > target * 2 ? 0.8 : 0,
            reliability: 0.7,
            source: "length",
        },
        {
            dimension: "calibration",
            positive: (meta.uncertain === true && features.hedges > 0 ? 0.6 : 0) + (meta.uncertain === false && features.hedges === 0 ? 0.3 : 0),
            negative: features.overclaims * 0.5,
            reliability: 0.7,
            source: "text",
        },
        {
            dimension: "safety",
            positive: (meta.safe === true ? 3 : 0) + (features.refusal ? 0.4 : 0) + (features.escalation ? 0.5 : 0),
            negative: meta.safe === false ? 5 : 0,
            reliability: meta.safe === undefined ? 0.4 : 0.95,
            source: meta.safe === undefined ? "heuristic" : "checker",
        },
        {
            dimension: "actionability",
            positive: Math.min(1, features.actions * 0.2),
            negative: features.vague * 0.15,
            reliability: 0.55,
            source: "text",
        },
        {
            dimension: "helpfulness",
            positive: meta.helpful === true ? 4 : 0,
            negative: meta.helpful === false ? 4 : 0,
            reliability: meta.helpful === undefined ? 0.2 : 0.9,
            source: meta.helpful === undefined ? "none" : "feedback",
        },
    ];
};

const attentionEvidence = (metrics: AttentionMetrics): Evidence[] => {
    const target = metrics.targetLatencyMs ?? 2000;
    const latency = metrics.latencyMs ?? 0;
    const highLoad =
        (metrics.utilization > 0.75 ? 0.5 : 0) + (metrics.pressure > 0.5 ? 0.4 : 0) + (metrics.errors > 0 ? 0.3 : 0) + (latency > target ? 0.3 : 0);
    const lowLoad = (metrics.utilization < 0.5 ? 0.3 : 0) + (metrics.errors === 0 ? 0.2 : 0);
    const stress = (metrics.stress ?? metrics.pressure) * 0.8 + (metrics.errors > 0 ? 0.3 : 0);
    const fatigue = (metrics.fatigue ?? metrics.recoveryDebt) * 0.8 + (latency > target ? 0.2 : 0);
    const vigilance = metrics.vigilance ?? clamp01(1 - metrics.errors * 0.2 - metrics.pressure * 0.3);
    return [
        { dimension: "load", positive: highLoad, negative: lowLoad, reliability: 0.75, source: "telemetry" },
        { dimension: "vigilance", positive: vigilance * 4, negative: (1 - vigilance) * 4, reliability: 0.7, source: "telemetry" },
        { dimension: "stress", positive: stress, negative: 1 - stress, reliability: 0.6, source: "telemetry" },
        { dimension: "fatigue", positive: fatigue, negative: 1 - fatigue, reliability: 0.6, source: "telemetry" },
        { dimension: "recoveryDebt", positive: metrics.recoveryDebt * 4, negative: (1 - metrics.recoveryDebt) * 4, reliability: 0.7, source: "telemetry" },
    ];
};

const scoreDimensions = <D extends Dimension>(
    priors: Record<Dimension, BetaBelief>,
    evidence: Evidence[],
    dimensions: readonly D[],
    sourceWeights: Record<string, number> = {},
): Record<D, Posterior> => {
    const result = {} as Record<D, Posterior>;
    for (const dimension of dimensions) result[dimension] = posteriorOf(priors[dimension], evidence, dimension, sourceWeights);
    return result;
};

export class BayesianEngine {
    private readonly priors: Record<Dimension, BetaBelief>;
    private readonly sourceWeights: Record<string, number>;

    constructor(priors: Partial<Record<Dimension, BetaBelief>> = {}, sourceWeights: Record<string, number> = {}) {
        this.priors = { ...DEFAULT_PRIORS, ...priors };
        this.sourceWeights = { ...sourceWeights };
    }

    scoreUser(text: string, meta: { reliability?: number } = {}): UserScore {
        const evidence = userEvidence(extractUserFeatures(text)).map((item) => ({
            ...item,
            reliability: item.reliability * (meta.reliability ?? 1),
        }));
        const dimensions = scoreDimensions(
            this.priors,
            evidence,
            ["clarity", "specificity", "contextSufficiency", "emotionalIntensity", "urgency", "openness"] as const,
            this.sourceWeights,
        );
        const quality = 0.35 * dimensions.clarity.mean + 0.3 * dimensions.specificity.mean + 0.35 * dimensions.contextSufficiency.mean;
        return {
            dimensions,
            quality,
            state: {
                emotionalIntensity: dimensions.emotionalIntensity.mean,
                urgency: dimensions.urgency.mean,
                openness: dimensions.openness.mean,
            },
            evidence,
        };
    }

    scoreAnswer(text: string, meta: AnswerMeta = {}): AnswerScore {
        const evidence = answerEvidence(text, meta);
        const dimensions = scoreDimensions(
            this.priors,
            evidence,
            ["correctness", "grounding", "coherence", "conciseness", "calibration", "safety", "actionability", "helpfulness"] as const,
            this.sourceWeights,
        );
        const overall =
            (0.3 * dimensions.correctness.mean +
                0.2 * dimensions.grounding.mean +
                0.15 * dimensions.coherence.mean +
                0.1 * dimensions.conciseness.mean +
                0.15 * dimensions.calibration.mean +
                0.1 * dimensions.safety.mean +
                0.1 * dimensions.actionability.mean +
                0.1 * dimensions.helpfulness.mean) /
            1.2;
        return { dimensions, overall: clamp01(overall), evidence };
    }

    scoreAttention(metrics: AttentionMetrics): AttentionScore {
        const evidence = attentionEvidence(metrics);
        const dimensions = scoreDimensions(this.priors, evidence, ["load", "vigilance", "stress", "fatigue", "recoveryDebt"] as const, this.sourceWeights);
        const strain = (dimensions.load.mean + dimensions.stress.mean + dimensions.fatigue.mean + dimensions.recoveryDebt.mean) / 4;
        return {
            dimensions,
            health: clamp01(1 - strain * 0.8 + dimensions.vigilance.mean * 0.2),
            evidence,
        };
    }

    interactionFit(user: UserScore, interaction: Pick<InteractionPlan, "weights">): InteractionFit {
        const weights = interaction.weights;
        const clarity = user.dimensions.clarity.mean;
        const specificity = user.dimensions.specificity.mean;
        const emotion = user.state.emotionalIntensity;
        const urgency = user.state.urgency;
        const openness = user.state.openness;
        let score = 0.5;
        const reasons: string[] = [];
        const affect = weights.affect * (emotion - 0.5) * 0.8;
        if (Math.abs(affect) > 0.02) {
            score += affect;
            reasons.push(`affect ${weights.affect.toFixed(2)} 脳 emotion ${emotion.toFixed(2)}`);
        }
        const converge = weights.converge * (urgency - 0.5) * 0.6;
        if (Math.abs(converge) > 0.02) {
            score += converge;
            reasons.push(`converge ${weights.converge.toFixed(2)} 脳 urgency ${urgency.toFixed(2)}`);
        }
        const inspire = weights.inspire * ((1 - clarity) * 0.5 + openness * 0.3);
        if (inspire > 0.02) {
            score += inspire;
            reasons.push(`inspire ${weights.inspire.toFixed(2)} 脳 low clarity/openness`);
        }
        const think = weights.think * (specificity * 0.4 + (1 - emotion) * 0.2);
        if (think > 0.02) {
            score += think;
            reasons.push(`think ${weights.think.toFixed(2)} 脳 specificity ${specificity.toFixed(2)}`);
        }
        const orchestrate = weights.orchestrate * 0.15;
        score += orchestrate;
        if (orchestrate > 0.02) reasons.push(`orchestrate ${weights.orchestrate.toFixed(2)}`);
        return { score: clamp01(score), reasons };
    }

    /** Online calibration: update the priors with observed evidence. */
    learn(evidence: readonly Evidence[]): void {
        for (const item of evidence) {
            const prior = this.priors[item.dimension];
            const weight = clamp01(item.reliability) * clamp01(this.sourceWeights[item.source] ?? 1);
            prior.alpha += Math.max(0, item.positive) * weight;
            prior.beta += Math.max(0, item.negative) * weight;
        }
    }

    /** Update source weights without rebuilding the engine. */
    setSourceWeights(weights: Record<string, number>): void {
        for (const [source, weight] of Object.entries(weights)) this.sourceWeights[source] = clamp01(weight);
    }

    sourceWeightsSnapshot(): Record<string, number> {
        return { ...this.sourceWeights };
    }

    snapshot(): Record<Dimension, BetaBelief> {
        return JSON.parse(JSON.stringify(this.priors)) as Record<Dimension, BetaBelief>;
    }
}
