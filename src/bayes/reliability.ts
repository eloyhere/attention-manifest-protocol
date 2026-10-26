/**
 * Source reliability learned from labeled feedback.
 *
 * The engine's static evidence reliability says "this kind of feature is weak";
 * this table says "this particular source has been right/wrong historically".
 * Unseen sources default to 1, so behavior is unchanged until labels exist.
 */
export interface ReliabilityBelief {
    alpha: number;
    beta: number;
    observations: number;
}

export class SourceReliability {
    private readonly prior: { alpha: number; beta: number };
    private readonly beliefs = new Map<string, ReliabilityBelief>();

    constructor(prior: { alpha: number; beta: number } = { alpha: 2, beta: 2 }) {
        this.prior = prior;
    }

    observe(source: string, correct: boolean, weight = 1): ReliabilityBelief {
        const current = this.beliefs.get(source) ?? { ...this.prior, observations: 0 };
        const amount = Math.max(0, weight);
        current.alpha += correct ? amount : 0;
        current.beta += correct ? 0 : amount;
        current.observations += 1;
        this.beliefs.set(source, current);
        return current;
    }

    weight(source: string): number {
        const belief = this.beliefs.get(source);
        if (belief === undefined) return 1;
        const total = belief.alpha + belief.beta;
        return total === 0 ? 1 : belief.alpha / total;
    }

    weights(): Record<string, number> {
        return Object.fromEntries([...this.beliefs.keys()].map((source) => [source, this.weight(source)]));
    }

    snapshot(): Record<string, ReliabilityBelief> {
        return Object.fromEntries(this.beliefs);
    }

    load(snapshot: Record<string, ReliabilityBelief>): void {
        for (const [source, belief] of Object.entries(snapshot)) this.beliefs.set(source, { ...belief });
    }
}
