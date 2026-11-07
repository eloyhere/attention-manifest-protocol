export type { BudgetReservation, BudgetSnapshot } from "../tool/types.ts";

/**
 * Every dimension a budget tree can allocate and account independently.
 *
 * The first four mirror `Budget` from `shared.ts`; `retries` and `concurrency`
 * are protocol-level quotas from `refract.md` §16.3 that have no shared type yet.
 */
export const BUDGET_DIMENSIONS = Object.freeze([
    "tokens",
    "milliseconds",
    "calls",
    "bytes",
    "retries",
    "concurrency",
] as const);

export type BudgetDimension = typeof BUDGET_DIMENSIONS[number];

/** A partial amount. Omitted dimensions mean zero. */
export type BudgetTreeAmount = Partial<Record<BudgetDimension, number>>;

/** A complete, normalized accounting value; every dimension is present. */
export type BudgetTreeUsage = Record<BudgetDimension, number>;

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
    if (typeof amount !== "object" || amount === null || Array.isArray(amount)) {
        throw new TypeError("Budget amount must be an object.");
    }
    const normalized: BudgetTreeUsage = { ...EmptyBudgetTreeUsage };
    for (const [key, value] of Object.entries(amount)) {
        if (!isBudgetDimension(key)) {
            throw new TypeError(`Unknown budget dimension: ${key}.`);
        }
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
            throw new TypeError(`Budget dimension ${key} must be a nonnegative safe integer.`);
        }
        normalized[key] = value;
    }
    return normalized;
}

export function addBudgetUsage(left: BudgetTreeUsage, right: BudgetTreeAmount): BudgetTreeUsage {
    const normalized = normalizeBudgetUsage(right);
    const sum: BudgetTreeUsage = { ...EmptyBudgetTreeUsage };
    for (const dimension of BUDGET_DIMENSIONS) {
        const value = left[dimension] + normalized[dimension];
        if (!Number.isSafeInteger(value)) {
            throw new TypeError(`Budget dimension ${dimension} exceeds the safe integer range.`);
        }
        sum[dimension] = value;
    }
    return sum;
}

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
