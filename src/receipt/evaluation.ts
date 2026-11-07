import type { Identifier } from "../shared.ts";
import type { ObservationMetrics, ReceiptCore } from "./types.ts";

/** Group key used when a receipt has no value for a grouping dimension. */
export const UNASSIGNED_RECEIPT_GROUP = "unassigned" as const;

/** Frozen aggregate for one dimension of receipts. */
export interface ReceiptStats {
    /** Number of receipts in this bucket. */
    readonly total: number;
    readonly success: number;
    readonly failure: number;
    readonly unknown: number;
    /** `success / total`; zero for an empty bucket. */
    readonly successRate: number;
    /** `failure / total`; zero for an empty bucket. */
    readonly failureRate: number;
    /** Total measured execution time; observations without metrics contribute zero. */
    readonly durationMs: number;
    /** Mean over receipts that supplied `metrics.durationMs`; zero when none did. */
    readonly averageDurationMs: number;
    readonly durationSamples: number;
    /** Total measured token cost; observations without metrics contribute zero. */
    readonly tokens: number;
    /** Mean over receipts that supplied `metrics.tokens`; zero when none did. */
    readonly averageTokens: number;
    readonly tokenSamples: number;
    /** Summed named resources in stable key order. */
    readonly resources: Readonly<Record<string, number>>;
}

/** Receipt-based evaluation (refract.md §9.5). */
export interface ReceiptAggregate extends ReceiptStats {
    /** Capability evaluation: all receipts for one capability. */
    readonly byCapabilityId: Readonly<Record<Identifier, ReceiptStats>>;
    /** Profession evaluation: all receipts for one profession. */
    readonly byProfessionId: Readonly<Record<Identifier, ReceiptStats>>;
    /** Session evaluation: all receipts in one session. */
    readonly bySessionId: Readonly<Record<Identifier, ReceiptStats>>;
    /** Turn evaluation: all receipts in one turn. */
    readonly byTurnId: Readonly<Record<Identifier, ReceiptStats>>;
}

type MutableStats = {
    total: number;
    success: number;
    failure: number;
    unknown: number;
    durationMs: number;
    durationSamples: number;
    tokens: number;
    tokenSamples: number;
    resources: Map<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function newStats(): MutableStats {
    return {
        total: 0,
        success: 0,
        failure: 0,
        unknown: 0,
        durationMs: 0,
        durationSamples: 0,
        tokens: 0,
        tokenSamples: 0,
        resources: new Map<string, number>(),
    };
}

function addAmount(target: Map<string, number>, key: string, amount: number): void {
    target.set(key, (target.get(key) ?? 0) + amount);
}

function nonnegative(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`Receipt ${field} must be a finite nonnegative number`);
    }
    return value;
}

function readMetrics(receipt: ReceiptCore, index: number): ObservationMetrics | undefined {
    const metrics = receipt.observation?.metrics;
    if (metrics === undefined) return undefined;
    if (!isRecord(metrics)) throw new TypeError(`Receipt[${index}].observation.metrics must be an object`);
    return metrics as ObservationMetrics;
}

function addReceipt(stats: MutableStats, receipt: ReceiptCore, index: number): void {
    const status = receipt.observation?.status;
    if (status !== "success" && status !== "failure" && status !== "unknown") {
        throw new TypeError(`Receipt[${index}].observation.status must be success, failure or unknown`);
    }
    stats.total += 1;
    stats[status] += 1;

    const metrics = readMetrics(receipt, index);
    if (metrics === undefined) return;
    const durationMs = nonnegative(metrics.durationMs, `[${index}].observation.metrics.durationMs`);
    if (durationMs !== undefined) {
        stats.durationMs += durationMs;
        stats.durationSamples += 1;
    }
    const tokens = nonnegative(metrics.tokens, `[${index}].observation.metrics.tokens`);
    if (tokens !== undefined) {
        stats.tokens += tokens;
        stats.tokenSamples += 1;
    }
    if (metrics.resources !== undefined) {
        if (!isRecord(metrics.resources)) throw new TypeError(`Receipt[${index}].observation.metrics.resources must be an object`);
        for (const [resource, rawAmount] of Object.entries(metrics.resources)) {
            const amount = nonnegative(rawAmount, `[${index}].observation.metrics.resources.${resource}`);
            if (amount !== undefined) addAmount(stats.resources, resource, amount);
        }
    }
}

function freezeResources(resources: Map<string, number>): Readonly<Record<string, number>> {
    const entries = [...resources.entries()].sort(([left], [right]) => left.localeCompare(right));
    return Object.freeze(Object.fromEntries(entries));
}

function freezeStats(stats: MutableStats): ReceiptStats {
    return Object.freeze({
        total: stats.total,
        success: stats.success,
        failure: stats.failure,
        unknown: stats.unknown,
        successRate: stats.total === 0 ? 0 : stats.success / stats.total,
        failureRate: stats.total === 0 ? 0 : stats.failure / stats.total,
        durationMs: stats.durationMs,
        averageDurationMs: stats.durationSamples === 0 ? 0 : stats.durationMs / stats.durationSamples,
        durationSamples: stats.durationSamples,
        tokens: stats.tokens,
        averageTokens: stats.tokenSamples === 0 ? 0 : stats.tokens / stats.tokenSamples,
        tokenSamples: stats.tokenSamples,
        resources: freezeResources(stats.resources),
    });
}

function freezeGroups(groups: Map<string, MutableStats>): Readonly<Record<Identifier, ReceiptStats>> {
    const entries = [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, stats]) => [key, freezeStats(stats)] as const);
    return Object.freeze(Object.fromEntries(entries));
}

function groupOf(groups: Map<string, MutableStats>, key: Identifier): MutableStats {
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const created = newStats();
    groups.set(key, created);
    return created;
}

function groupKey(...candidates: readonly (Identifier | undefined)[]): Identifier {
    return candidates.find(candidate => isNonEmptyString(candidate)) ?? UNASSIGNED_RECEIPT_GROUP;
}

function capabilityOf(receipt: ReceiptCore): Identifier {
    return groupKey(receipt.capabilityId, receipt.executor?.skill?.id, receipt.executor?.tool?.id);
}

function professionOf(receipt: ReceiptCore): Identifier {
    return groupKey(receipt.executor?.professionId);
}

function sessionOf(receipt: ReceiptCore): Identifier {
    return groupKey(receipt.sessionId, receipt.invocation?.context?.sessionId);
}

function turnOf(receipt: ReceiptCore): Identifier {
    return groupKey(receipt.turnId, receipt.invocation?.context?.observedInTurnId, receipt.invocation?.context?.originTurnId);
}

/** Zero statistics returned for an empty receipt set; never throws. */
export const EMPTY_RECEIPT_STATS: ReceiptStats = freezeStats(newStats());

/** Zero aggregate returned for an empty receipt set; every grouping map is empty. */
export const EMPTY_RECEIPT_AGGREGATE: ReceiptAggregate = Object.freeze({
    ...EMPTY_RECEIPT_STATS,
    byCapabilityId: Object.freeze({}),
    byProfessionId: Object.freeze({}),
    bySessionId: Object.freeze({}),
    byTurnId: Object.freeze({}),
});

/**
 * Aggregates receipts into objective success/failure, duration, resource and
 * token statistics (refract.md §9.5).
 *
 * Grouping reads `capabilityId` (falling back to the executor skill/tool),
 * `executor.professionId`, `sessionId` and `turnId`, with the corresponding
 * invocation-context identifiers as legacy fallbacks. Receipts without a group
 * value land in {@link UNASSIGNED_RECEIPT_GROUP}, so every bucket set sums back
 * to the overall statistics.
 *
 * An empty input is a valid evaluation of zero samples and returns
 * {@link EMPTY_RECEIPT_AGGREGATE} instead of throwing. The returned object and
 * every nested statistics object are frozen, and group/resource keys are
 * sorted so equal receipt sets always produce deeply equal aggregates.
 */
export function aggregateReceipts(receipts: readonly ReceiptCore[]): ReceiptAggregate {
    if (!Array.isArray(receipts)) throw new TypeError("Receipt aggregation input must be an array");
    if (receipts.length === 0) return EMPTY_RECEIPT_AGGREGATE;

    const overall = newStats();
    const byCapabilityId = new Map<string, MutableStats>();
    const byProfessionId = new Map<string, MutableStats>();
    const bySessionId = new Map<string, MutableStats>();
    const byTurnId = new Map<string, MutableStats>();
    const seen = new Set<Identifier>();

    receipts.forEach((receipt, index) => {
        if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) throw new TypeError(`Receipt[${index}] must be an object`);
        if (!isNonEmptyString(receipt.id)) throw new TypeError(`Receipt[${index}].id must be a non-empty identifier`);
        if (seen.has(receipt.id)) throw new TypeError(`Duplicate receipt: ${receipt.id}`);
        seen.add(receipt.id);

        addReceipt(overall, receipt, index);
        addReceipt(groupOf(byCapabilityId, capabilityOf(receipt)), receipt, index);
        addReceipt(groupOf(byProfessionId, professionOf(receipt)), receipt, index);
        addReceipt(groupOf(bySessionId, sessionOf(receipt)), receipt, index);
        addReceipt(groupOf(byTurnId, turnOf(receipt)), receipt, index);
    });

    return Object.freeze({
        ...freezeStats(overall),
        byCapabilityId: freezeGroups(byCapabilityId),
        byProfessionId: freezeGroups(byProfessionId),
        bySessionId: freezeGroups(bySessionId),
        byTurnId: freezeGroups(byTurnId),
    });
}
