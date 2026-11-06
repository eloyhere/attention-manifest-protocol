import { EmptyBudgetUsage, addBudgetUsage, exceedsBudget, normalizeBudgetUsage } from "../shared.ts";
import type { Budget, BudgetUsage, Identifier } from "../shared.ts";
import { isNumber, SynchronousOrderedMap, SynchronousOrderedSet } from "semantic-typescript";
import type { BudgetReservation, BudgetSnapshot } from "../tool/types.ts";

export type BudgetErrorCode = "invalid_amount" | "limit_exceeded" | "budget_not_configured" | "reservation_not_found" | "reservation_not_open" | "settlement_exceeds_reservation";
export class BudgetError extends Error {
    readonly code: BudgetErrorCode;
    constructor(code: BudgetErrorCode, message: string) {
        super(message);
        this.name = "BudgetError";
        this.code = code;
    }
}

function normalize(amount: Budget): BudgetUsage {
    try {
        for (const [key, value] of Object.entries(amount)) {
            if (!isNumber(value)) throw new BudgetError("invalid_amount", `Budget dimension ${key} must be numeric.`);
        }
        return normalizeBudgetUsage(amount);
    } catch (error) {
        throw new BudgetError("invalid_amount", error instanceof Error ? error.message : String(error));
    }
}

function withinReservation(actual: BudgetUsage, reserved: BudgetUsage): boolean {
    return actual.tokens <= reserved.tokens
        && actual.milliseconds <= reserved.milliseconds
        && actual.calls <= reserved.calls
        && actual.bytes <= reserved.bytes;
}

function total(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
    return addBudgetUsage(left, right);
}

function cloneReservation(reservation: BudgetReservation): BudgetReservation {
    return structuredClone(reservation);
}

function difference(next: BudgetUsage, previous: BudgetUsage): BudgetUsage {
    return {
        tokens: next.tokens - previous.tokens,
        milliseconds: next.milliseconds - previous.milliseconds,
        calls: next.calls - previous.calls,
        bytes: next.bytes - previous.bytes,
    };
}

export class BudgetLedger {
    private readonly limits = new SynchronousOrderedMap<Identifier, Budget>();
    private readonly settled = new SynchronousOrderedMap<Identifier, BudgetUsage>();
    private readonly reservations = new SynchronousOrderedMap<Identifier, BudgetReservation>();
    private readonly openByKey = new SynchronousOrderedSet<Identifier>();

    configure(key: Identifier, limit: Budget): void {
        normalize(limit);
        const prior = this.snapshot(key);
        const projected = total(prior.settled, prior.reserved);
        if (exceedsBudget(projected, limit)) {
            throw new BudgetError("limit_exceeded", "New limit is below already consumed or reserved budget.");
        }
        this.limits.put(key, { ...limit });
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
        return structuredClone({ limit, settled, reserved });
    }

    reserve(id: Identifier, key: Identifier, amount: Budget): BudgetReservation {
        if (this.reservations.containsKey(id)) {
            throw new BudgetError("reservation_not_open", `Reservation ${id} already exists.`);
        }
        if (!this.limits.containsKey(key)) throw new BudgetError("budget_not_configured", `Budget key ${key} is not configured.`);
        const normalized = normalize(amount);
        const current = this.snapshot(key);
        const projected = total(total(current.settled, current.reserved), normalized);
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
