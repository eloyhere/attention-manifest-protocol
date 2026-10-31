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

type PriorShape = {
    alpha: number;
    beta: number;
};

export class SourceReliability {
    private readonly prior: PriorShape;
    private readonly beliefs = new Map<string, ReliabilityBelief>();

    constructor(prior: PriorShape = { alpha: 2, beta: 2 }) {
        if (!Number.isFinite(prior.alpha) || !Number.isFinite(prior.beta) || prior.alpha < 0 || prior.beta < 0) {
            throw new RangeError("reliability prior must contain finite non-negative counts");
        }
        this.prior = { ...prior };
    }

    observe(source: string, correct: boolean, weight = 1): ReliabilityBelief {
        if (!Number.isFinite(weight) || weight < 0) {
            throw new RangeError("reliability weight must be a finite non-negative number");
        }
        const current: ReliabilityBelief = this.beliefs.get(source) ?? { ...this.prior, observations: 0 };
        const next: ReliabilityBelief = {
            alpha: current.alpha + (correct ? weight : 0),
            beta: current.beta + (correct ? 0 : weight),
            observations: current.observations + 1,
        };
        if (!Number.isFinite(next.alpha) || !Number.isFinite(next.beta) || !Number.isSafeInteger(next.observations)) {
            throw new RangeError("reliability observation would overflow");
        }
        this.beliefs.set(source, next);
        return { ...next };
    }

    weight(source: string): number {
        const belief: ReliabilityBelief | undefined = this.beliefs.get(source);
        if (belief === (void 0)) {
            return 1;
        }
        const scale: number = Math.max(belief.alpha, belief.beta);
        return scale === 0 ? 1 : (belief.alpha / scale) / (belief.alpha / scale + belief.beta / scale);
    }

    weights(): Record<string, number> {
        return Object.fromEntries([...this.beliefs.keys()].map((source) => [source, this.weight(source)]));
    }

    snapshot(): Record<string, ReliabilityBelief> {
        return Object.fromEntries([...this.beliefs].map(([source, belief]) => [source, { ...belief }]));
    }

    load(snapshot: Record<string, ReliabilityBelief>): void {
        const entries: [string, ReliabilityBelief][] = Object.entries(snapshot);
        for (const [, belief] of entries) {
            if (!Number.isFinite(belief.alpha) || !Number.isFinite(belief.beta) || belief.alpha < 0 || belief.beta < 0 || !Number.isSafeInteger(belief.observations) || belief.observations < 0) {
                throw new RangeError("reliability snapshot must contain finite non-negative counts and safe observation counts");
            }
        }
        for (let i: number = 0; i < entries.length; i += 1) {
            const source: string = entries[i][0];
            const belief: ReliabilityBelief = entries[i][1];
            this.beliefs.set(source, { ...belief });
        }
    }
}
