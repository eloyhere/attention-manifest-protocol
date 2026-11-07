import {
    BUDGET_DIMENSIONS,
    EmptyBudgetUsage,
    addBudgetUsage,
    exceedsBudget,
    normalizeBudget,
} from "../shared.ts";
import type { Budget, BudgetUsage, CompleteBudgetUsage, Identifier } from "../shared.ts";
import { SynchronousOrderedMap, SynchronousOrderedSet } from "semantic-typescript";
import type { BudgetReservation, BudgetSnapshot } from "../tool/types.ts";

export type BudgetErrorCode =
    | "invalid_amount"
    | "limit_exceeded"
    | "budget_not_configured"
    | "reservation_not_found"
    | "reservation_not_open"
    | "settlement_exceeds_reservation"
    | "budget_exhausted"
    | "invalid_node"
    | "node_not_found"
    | "node_exists"
    | "node_closed"
    | "invalid_parent"
    | "invalid_release";
export class BudgetError extends Error {
    readonly code: BudgetErrorCode;
    constructor(code: BudgetErrorCode, message: string) {
        super(message);
        this.name = "BudgetError";
        this.code = code;
    }
}

/** Normalize any accepted budget shape to all six dimensions, reporting domain errors. */
function normalize(amount: Budget): BudgetUsage {
    try {
        return normalizeBudget(amount);
    } catch (error) {
        if (error instanceof BudgetError) throw error;
        throw new BudgetError("invalid_amount", error instanceof Error ? error.message : String(error));
    }
}

/** Freeze a detached copy so callers cannot mutate live accounting facts. */
function freezeDeep<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
}

function withinReservation(actual: BudgetUsage, reserved: BudgetUsage): boolean {
    return BUDGET_DIMENSIONS.every(dimension => (actual[dimension] ?? 0) <= (reserved[dimension] ?? 0));
}

function total(left: BudgetUsage, right: BudgetUsage): CompleteBudgetUsage {
    return addBudgetUsage(left, right);
}

function cloneReservation(reservation: BudgetReservation): BudgetReservation {
    return freezeDeep(structuredClone(reservation));
}

function difference(next: BudgetUsage, previous: BudgetUsage): CompleteBudgetUsage {
    const result: CompleteBudgetUsage = {
        tokens: 0,
        milliseconds: 0,
        calls: 0,
        bytes: 0,
        retries: 0,
        concurrency: 0,
    };
    for (const dimension of BUDGET_DIMENSIONS) {
        result[dimension] = (next[dimension] ?? 0) - (previous[dimension] ?? 0);
    }
    return result;
}

export class BudgetLedger {
    private readonly limits = new SynchronousOrderedMap<Identifier, Budget>();
    private readonly settled = new SynchronousOrderedMap<Identifier, BudgetUsage>();
    private readonly reservations = new SynchronousOrderedMap<Identifier, BudgetReservation>();
    private readonly openByKey = new SynchronousOrderedSet<Identifier>();

    configure(key: Identifier, limit: Budget): void {
        // An empty object keeps the documented "omitted limit = unlimited"
        // semantics; otherwise normalize once to a complete six-dimensional
        // value so the same validation/overflow rules apply to every dimension.
        const unlimited = Object.keys(limit).length === 0;
        const normalized = unlimited ? undefined : normalize(limit);
        const prior = this.snapshot(key);
        const projected = total(prior.settled, prior.reserved);
        if (normalized !== undefined && exceedsBudget(projected, normalized)) {
            throw new BudgetError("limit_exceeded", "New limit is below already consumed or reserved budget.");
        }
        this.limits.put(key, unlimited ? Object.freeze({}) : Object.freeze({ ...normalized }));
    }

    snapshot(key: Identifier): BudgetSnapshot {
        const limitValue = this.limits.get(key);
        const settledValue = this.settled.get(key);
        const limit = limitValue.isPresent() ? limitValue.get() : {};
        const settled = settledValue.isPresent() ? settledValue.get() : { ...EmptyBudgetUsage };
        let reserved: BudgetUsage = { ...EmptyBudgetUsage };
        for (const reservationId of this.openByKey) {
            const reservation = this.reservations.get(reservationId);
            if (reservation.isPresent()) {
                const value = reservation.get();
                if (value.budgetKey === key && value.state === "reserved") {
                    reserved = addBudgetUsage(reserved, value.amount);
                }
            }
        }
        return freezeDeep(structuredClone({ limit, settled, reserved }));
    }

    reserve(id: Identifier, key: Identifier, amount: Budget): BudgetReservation {
        if (this.reservations.containsKey(id)) {
            throw new BudgetError("reservation_not_open", `Reservation ${id} already exists.`);
        }
        if (!this.limits.containsKey(key)) throw new BudgetError("budget_not_configured", `Budget key ${key} is not configured.`);
        const normalized = normalize(amount);
        const current = this.snapshot(key);
        let projected: CompleteBudgetUsage;
        try {
            projected = total(total(current.settled, current.reserved), normalized);
        } catch {
            // Summing past MAX_SAFE_INTEGER is still a budget overrun, not a malformed amount.
            throw new BudgetError("limit_exceeded", "Reservation would exceed the configured budget.");
        }
        if (exceedsBudget(projected, current.limit)) {
            throw new BudgetError("limit_exceeded", "Reservation would exceed the configured budget.");
        }
        const reservation: BudgetReservation = { id, budgetKey: key, amount: normalized, state: "reserved" };
        this.reservations.put(id, reservation);
        this.openByKey.add(id);
        return cloneReservation(reservation);
    }

    settle(id: Identifier, actual: Budget): BudgetReservation {
        const current = this.findOpen(id);
        const usage = normalize(actual);
        if (!withinReservation(usage, normalize(current.amount))) {
            throw new BudgetError("settlement_exceeds_reservation", "Actual usage cannot exceed the reserved amount.");
        }
        const snapshot = this.snapshot(current.budgetKey);
        const newSettled = addBudgetUsage(snapshot.settled, usage);
        if (exceedsBudget(total(newSettled, difference(snapshot.reserved, normalize(current.amount))), snapshot.limit)) {
            throw new BudgetError("limit_exceeded", "Settlement would exceed the configured budget.");
        }
        const settled: BudgetReservation = { ...current, state: "settled", actual: usage };
        this.reservations.put(id, settled);
        this.openByKey.remove(id);
        this.settled.put(current.budgetKey, newSettled);
        return cloneReservation(settled);
    }

    release(id: Identifier): BudgetReservation {
        const current = this.findOpen(id);
        const released: BudgetReservation = { ...current, state: "released" };
        this.reservations.put(id, released);
        this.openByKey.remove(id);
        return cloneReservation(released);
    }

    findReservation(id: Identifier) {
        return this.reservations.get(id).map(cloneReservation);
    }

    getReservation(id: Identifier): BudgetReservation | undefined {
        const reservation = this.findReservation(id);
        return reservation.isPresent() ? reservation.get() : undefined;
    }

    private findOpen(id: Identifier): BudgetReservation {
        const reservation = this.reservations.get(id);
        if (reservation.isEmpty()) throw new BudgetError("reservation_not_found", `Reservation ${id} does not exist.`);
        const value = reservation.get();
        if (value.state !== "reserved") throw new BudgetError("reservation_not_open", `Reservation ${id} is already ${value.state}.`);
        return value;
    }
}
