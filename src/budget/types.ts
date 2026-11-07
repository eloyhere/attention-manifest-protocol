import {
    BUDGET_DIMENSIONS,
    addBudgetUsage as addSharedBudgetUsage,
    normalizeBudget,
} from "../shared.ts";
import type { Budget, BudgetDimension } from "../shared.ts";

export type { BudgetReservation, BudgetSnapshot } from "../tool/types.ts";

/**
 * The canonical six budget dimensions now live in `shared.ts`; the tree and
 * ledger both consume that definition instead of maintaining a second list.
 */
export { BUDGET_DIMENSIONS };
export type { BudgetDimension };

/** A partial amount. Omitted dimensions mean zero. */
export type BudgetTreeAmount = Budget;

/** A complete, normalized accounting value; every dimension is present. */
export type BudgetTreeUsage = Required<Budget>;

export const EmptyBudgetTreeUsage: Readonly<BudgetTreeUsage> = Object.freeze({
    tokens: 0,
    milliseconds: 0,
    calls: 0,
    bytes: 0,
    retries: 0,
    concurrency: 0,
});

export function isBudgetDimension(value: string): value is BudgetDimension {
    return (BUDGET_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Validate an amount and fill omitted dimensions with zero.
 *
 * Only nonnegative safe integers are accepted. Fractions, `NaN`, infinities,
 * negative numbers and unknown dimension names are rejected rather than being
 * rounded or silently ignored.
 */
export function normalizeBudgetUsage(amount: BudgetTreeAmount): BudgetTreeUsage {
    return normalizeBudget(amount);
}

/** Shared six-dimensional addition; see `shared.ts`. */
export const addBudgetUsage = addSharedBudgetUsage;

/** Subtract a usage from a larger-or-equal usage; never returns a negative dimension. */
export function subtractBudgetUsage(left: BudgetTreeUsage, right: BudgetTreeUsage): BudgetTreeUsage {
    const difference: BudgetTreeUsage = { ...EmptyBudgetTreeUsage };
    for (const dimension of BUDGET_DIMENSIONS) {
        if (right[dimension] > left[dimension]) {
            throw new TypeError(`Budget dimension ${dimension} cannot be subtracted: result would be negative.`);
        }
        difference[dimension] = left[dimension] - right[dimension];
    }
    return difference;
}

export function isZeroBudgetUsage(usage: BudgetTreeUsage): boolean {
    return BUDGET_DIMENSIONS.every(dimension => usage[dimension] === 0);
}
