import type { Budget, Usage } from "../types/common.ts";

export type BudgetDimension = "tokens" | "calls" | "ms";

export class BudgetExceeded extends Error {
    readonly code = "budget_exceeded";
    readonly dimension: BudgetDimension;
    readonly limit: number;
    readonly observed: number;

    constructor(dimension: BudgetDimension, limit: number, observed: number) {
        super(`budget exceeded on ${dimension}: observed ${observed} > limit ${limit}`);
        this.name = "BudgetExceeded";
        this.dimension = dimension;
        this.limit = limit;
        this.observed = observed;
    }
}

export interface CallCost {
    tokens?: number;
    calls?: number;
    ms?: number;
}

/**
 * The single metering point (A-3).
 *
 * The 2026 CVE-2026-114386 showed why this cannot live inside a sandbox: a
 * nested call that bypasses the outer counter makes every quota advisory.
 * Here, `run` charges *before* executing, so a nested orchestration that loops
 * still hits the same counter.
 */
export class Dispatcher {
    readonly lease: Budget;
    private used: { tokens: number; calls: number; ms: number } = { tokens: 0, calls: 0, ms: 0 };

    constructor(lease: Budget) {
        for (const dimension of ["tokens", "calls", "ms"] as const) {
            const limit = lease[dimension];
            if (limit !== (void 0) && (!Number.isFinite(limit) || limit < 0)) {
                throw new RangeError(`budget ${dimension} must be a finite non-negative number`);
            }
        }
        this.lease = { ...lease };
    }

    run<T>(fn: () => T, cost: CallCost = {}): T {
        const amounts = {
            tokens: cost.tokens ?? 0,
            calls: cost.calls ?? 1,
            ms: cost.ms ?? 0,
        };
        for (const dimension of ["tokens", "calls", "ms"] as const) {
            const amount = amounts[dimension];
            if (!Number.isFinite(amount) || amount < 0) {
                throw new RangeError(`call cost ${dimension} must be a finite non-negative number`);
            }
        }

        // Validate every dimension and compute all next values before mutating
        // usage. A failed multi-dimensional charge must be fully atomic.
        const next = {
            tokens: this.nextUsage("tokens", amounts.tokens),
            calls: this.nextUsage("calls", amounts.calls),
            ms: this.nextUsage("ms", amounts.ms),
        };
        this.used = next;
        return fn();
    }

    private nextUsage(dimension: BudgetDimension, amount: number): number {
        const next = this.used[dimension] + amount;
        if (!Number.isFinite(next)) {
            throw new RangeError(`budget ${dimension} would overflow`);
        }
        const limit = this.lease[dimension];
        if (limit !== (void 0) && next > limit) {
            throw new BudgetExceeded(dimension, limit, next);
        }
        return next;
    }

    usage(): Usage {
        return { tokens: this.used.tokens, calls: this.used.calls, ms: this.used.ms };
    }

    remaining(): Required<Pick<Budget, "tokens" | "calls" | "ms">> {
        return {
            tokens: Math.max(0, (this.lease.tokens ?? 0) - this.used.tokens),
            calls: Math.max(0, (this.lease.calls ?? 0) - this.used.calls),
            ms: Math.max(0, (this.lease.ms ?? 0) - this.used.ms),
        };
    }
}
