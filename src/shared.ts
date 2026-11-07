export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Identifier = string;

/**
 * The six independently accounted budget dimensions, in stable order.
 *
 * `retries` and `concurrency` are the protocol-level quotas required by
 * `refract.md` §16.3; the first four dimensions are the original shared
 * budget shape. Keeping the canonical list here makes the tree, ledger and
 * attention layers agree on one definition instead of each maintaining its
 * own copy.
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

/**
 * A partial amount or limit. Omitted dimensions mean zero, so a legacy
 * four-dimensional budget (`tokens`/`milliseconds`/`calls`/`bytes`) remains a
 * valid input and its two protocol quotas default to zero.
 */
export type Budget = {
    tokens?: number;
    milliseconds?: number;
    calls?: number;
    bytes?: number;
    /** Retry quota from §16.3; omitted legacy budgets mean zero. */
    retries?: number;
    /** Per-tool/behaviour/workspace concurrency quota from §16.3; omitted legacy budgets mean zero. */
    concurrency?: number;
};

/**
 * A complete accounting value.
 *
 * Values produced by `normalizeBudget`, `addBudgetUsage` and the budget tree
 * always carry all six dimensions. The two protocol quotas stay optional in
 * the type so legacy four-dimensional usage snapshots remain assignable; read
 * them through the arithmetic helpers, which treat a missing quota as zero.
 */
export type BudgetUsage = Required<Pick<Budget, "tokens" | "milliseconds" | "calls" | "bytes">>
    & Partial<Pick<Budget, "retries" | "concurrency">>;

/** A complete usage value with every dimension present. */
export type CompleteBudgetUsage = Required<Budget>;

/**
 * Runtime-complete zero usage.
 *
 * Typed as `BudgetUsage` on purpose: a legacy four-dimensional usage variable
 * may be assigned from a spread of this value, while the actual object always
 * carries all six dimensions. Use `normalizeBudget` when a fully required
 * `CompleteBudgetUsage` is needed.
 */
export const EmptyBudgetUsage: Readonly<BudgetUsage> = Object.freeze({
    tokens: 0,
    milliseconds: 0,
    calls: 0,
    bytes: 0,
    retries: 0,
    concurrency: 0,
});

/**
 * Validate every declared dimension.
 *
 * Only the six canonical names are accepted, and only as nonnegative safe
 * integers: fractions, `NaN`, infinities, negative numbers, unknown dimension
 * names and non-object inputs are rejected rather than rounded or ignored.
 */
export function validateBudget(budget: Budget): void {
    if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
        throw new TypeError("Invalid budget: a budget must be an object.");
    }
    for (const [key, value] of Object.entries(budget)) {
        // Safe integers only: larger values would round silently in later arithmetic.
        if (!(BUDGET_DIMENSIONS as readonly string[]).includes(key)
            || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
            throw new TypeError(`Invalid budget dimension: ${key} must be a nonnegative safe integer.`);
        }
    }
}

/**
 * Validate an amount and fill omitted dimensions with zero, including the
 * `retries` and `concurrency` quotas added by §16.3.
 */
export function normalizeBudget(budget: Budget): CompleteBudgetUsage {
    validateBudget(budget);
    return {
        tokens: budget.tokens ?? 0,
        milliseconds: budget.milliseconds ?? 0,
        calls: budget.calls ?? 0,
        bytes: budget.bytes ?? 0,
        retries: budget.retries ?? 0,
        concurrency: budget.concurrency ?? 0,
    };
}

/** Backwards-compatible alias of `normalizeBudget`. */
export function normalizeBudgetUsage(budget: Budget): BudgetUsage {
    return normalizeBudget(budget);
}

export function addBudgetUsage(left: BudgetUsage, right: Budget): CompleteBudgetUsage {
    // Usage ledgers may carry a fractional wall-clock measurement; round that
    // one timing dimension at the arithmetic boundary. Every limit dimension and
    // every other usage dimension must remain a nonnegative safe integer.
    const normalizedLeft: CompleteBudgetUsage = {
        tokens: left.tokens,
        milliseconds: Math.ceil(left.milliseconds),
        calls: left.calls,
        bytes: left.bytes,
        retries: left.retries ?? 0,
        concurrency: left.concurrency ?? 0,
    };
    validateBudget(normalizedLeft);
    validateBudget(right);
    const sum: CompleteBudgetUsage = {
        tokens: normalizedLeft.tokens + (right.tokens ?? 0),
        milliseconds: normalizedLeft.milliseconds + (right.milliseconds ?? 0),
        calls: normalizedLeft.calls + (right.calls ?? 0),
        bytes: normalizedLeft.bytes + (right.bytes ?? 0),
        retries: normalizedLeft.retries + (right.retries ?? 0),
        concurrency: normalizedLeft.concurrency + (right.concurrency ?? 0),
    };
    // Reject arithmetic overflow instead of silently rounding past MAX_SAFE_INTEGER.
    validateBudget(sum);
    return sum;
}

export function exceedsBudget(usage: BudgetUsage, budget: Budget): boolean {
    return (budget.tokens !== undefined && usage.tokens > budget.tokens)
        || (budget.milliseconds !== undefined && usage.milliseconds > budget.milliseconds)
        || (budget.calls !== undefined && usage.calls > budget.calls)
        || (budget.bytes !== undefined && usage.bytes > budget.bytes)
        || (budget.retries !== undefined && (usage.retries ?? 0) > budget.retries)
        || (budget.concurrency !== undefined && (usage.concurrency ?? 0) > budget.concurrency);
}

export type ExecutionContext = {
    tenantId: Identifier;
    principalId: Identifier;
    agentId: Identifier;
    sessionId: Identifier;
    originTurnId?: Identifier;
    observedInTurnId?: Identifier;
    missionId?: Identifier;
    taskId?: Identifier;
    actionId?: Identifier;
    operationId: Identifier;
    attemptId: Identifier;
    executionId: Identifier;
    policyVersion: string;
    cancellationEpoch: number;
};

export type InvocationRecord = {
    id: Identifier;
    context: ExecutionContext;
    toolId: Identifier;
    arguments: JsonValue;
    createdAt: string;
    idempotencyKey?: string;
};

export type ObservationRecord = {
    id: Identifier;
    invocationId: Identifier;
    status: "success" | "failure" | "unknown";
    value?: JsonValue;
    error?: string;
    observedAt: string;
    digest?: string;
};

export type VerificationRecord = {
    id: Identifier;
    observationId: Identifier;
    valid: boolean;
    claims: readonly string[];
    verifier: string;
    verifiedAt: string;
};

/** Number of decimal places allowed for derived metrics. */
export const METRIC_DECIMALS = 2;

/**
 * Rounds a derived metric — score, confidence, rate, ratio, cost, multiplier or
 * duration — to at most two decimal places. Integers and integer-valued fields
 * (versions, offsets, counts, epochs, token totals) must not use this helper.
 * Internal arithmetic keeps full precision; call this only at the output edge.
 */
export function roundMetric(value: number): number {
    if (!Number.isFinite(value)) throw new TypeError("metric must be a finite number");
    // Symmetric rounding: Math.round alone rounds negative halves towards +∞,
    // so -1.005 would become -1 instead of -1.01. EPSILON corrects binary
    // representation error (1.005 * 100 = 100.49999999999999).
    const magnitude = Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
    const rounded = value < 0 ? -magnitude : magnitude;
    return Object.is(rounded, -0) ? 0 : rounded;
}
