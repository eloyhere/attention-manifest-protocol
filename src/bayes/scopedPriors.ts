/**
 * Scope-level Beta priors.
 *
 * `priorsFor(scope)` = global prior + local counts for that scope. This is a
 * simple hierarchical model: task/scenario-level feedback can move the posterior
 * without discarding the global prior, and unseen scopes fall back to global.
 */
import { BayesianEngine, DefaultPriors } from "./engine.ts";
import type { BetaBelief, Dimension, Evidence } from "./engine.ts";

export interface ScopedPriorsOptions {
    global?: Partial<Record<Dimension, BetaBelief>>;
    /**
     * 0 = no pooling into global; 1 = every local observation also updates global.
     */
    globalWeight?: number;
}

const empty = (): Record<Dimension, BetaBelief> => {
    const result = {} as Record<Dimension, BetaBelief>;
    for (const dimension of Object.keys(DefaultPriors) as Dimension[]) {
        result[dimension] = { alpha: 0, beta: 0 };
    }
    return result;
};

export class ScopedPriors {
    private readonly global: Record<Dimension, BetaBelief>;
    private readonly scopes = new Map<string, Record<Dimension, BetaBelief>>();
    private readonly globalWeight: number;

    constructor(options: ScopedPriorsOptions = {}) {
        const source = { ...DefaultPriors, ...options.global };
        this.global = Object.fromEntries(Object.entries(source).map(([dimension, belief]) => [dimension, { ...belief }])) as Record<Dimension, BetaBelief>;
        this.globalWeight = Math.max(0, Math.min(1, options.globalWeight ?? 0));
    }

    observe(scope: string, evidence: readonly Evidence[]): void {
        const local = this.scopes.get(scope) ?? empty();
        for (const item of evidence) {
            const amount = Math.max(0, item.reliability);
            local[item.dimension].alpha += Math.max(0, item.positive) * amount;
            local[item.dimension].beta += Math.max(0, item.negative) * amount;
            if (this.globalWeight > 0) {
                this.global[item.dimension].alpha += Math.max(0, item.positive) * amount * this.globalWeight;
                this.global[item.dimension].beta += Math.max(0, item.negative) * amount * this.globalWeight;
            }
        }
        this.scopes.set(scope, local);
    }

    priorsFor(scope: string): Record<Dimension, BetaBelief> {
        const local = this.scopes.get(scope);
        const result = {} as Record<Dimension, BetaBelief>;
        for (const dimension of Object.keys(DefaultPriors) as Dimension[]) {
            result[dimension] = {
                alpha: this.global[dimension].alpha + (local?.[dimension].alpha ?? 0),
                beta: this.global[dimension].beta + (local?.[dimension].beta ?? 0),
            };
        }
        return result;
    }

    engineFor(scope: string): BayesianEngine {
        return new BayesianEngine(this.priorsFor(scope));
    }

    scopesKnown(): string[] {
        return [...this.scopes.keys()];
    }

    snapshot(): { global: Record<Dimension, BetaBelief>; scopes: Record<string, Record<Dimension, BetaBelief>> } {
        return {
            global: JSON.parse(JSON.stringify(this.global)) as Record<Dimension, BetaBelief>,
            scopes: Object.fromEntries([...this.scopes.entries()].map(([scope, beliefs]) => [scope, JSON.parse(JSON.stringify(beliefs))])),
        };
    }

    load(snapshot: { global?: Record<Dimension, BetaBelief>; scopes?: Record<string, Record<Dimension, BetaBelief>> }): void {
        if (snapshot.global !== (void 0)) {
            Object.assign(this.global, snapshot.global);
        }
        this.scopes.clear();
        for (const [scope, beliefs] of Object.entries(snapshot.scopes ?? {})) {
            this.scopes.set(scope, JSON.parse(JSON.stringify(beliefs)) as Record<Dimension, BetaBelief>);
        }
    }
}
