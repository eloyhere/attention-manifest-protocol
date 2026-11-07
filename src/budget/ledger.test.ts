import assert from "node:assert/strict";
import test from "node:test";
import { BudgetLedger, BudgetError } from "./ledger.ts";
import type { BudgetErrorCode } from "./ledger.ts";
import { addBudgetUsage } from "../shared.ts";

const code = (value: BudgetErrorCode) => (error: unknown): boolean => error instanceof BudgetError && error.code === value;
const unsafe = Number.MAX_SAFE_INTEGER + 1;

test("budget ledger rejects unsafe and fractional amounts on configure, reserve and settle", () => {
    const ledger = new BudgetLedger();
    assert.throws(() => ledger.configure("k", { tokens: unsafe }), code("invalid_amount"));
    assert.throws(() => ledger.configure("k", { tokens: 1.5 }), code("invalid_amount"));
    ledger.configure("k", { tokens: 10 });
    assert.throws(() => ledger.reserve("r", "k", { tokens: unsafe }), code("invalid_amount"));
    ledger.reserve("r", "k", { tokens: 4 });
    assert.throws(() => ledger.settle("r", { tokens: unsafe }), code("invalid_amount"));
    assert.throws(() => ledger.settle("r", { tokens: 1.5 }), code("invalid_amount"));
    assert.throws(() => ledger.settle("r", { tokens: 5 }), code("settlement_exceeds_reservation"));
});

test("budget arithmetic rejects overflow instead of silently rounding", () => {
    assert.throws(
        () => addBudgetUsage({ tokens: Number.MAX_SAFE_INTEGER, milliseconds: 0, calls: 0, bytes: 0 }, { tokens: 1 }),
        /safe integer/,
    );
    assert.deepEqual(
        addBudgetUsage({ tokens: 1, milliseconds: 2, calls: 3, bytes: 4 }, { tokens: 4 }),
        { tokens: 5, milliseconds: 2, calls: 3, bytes: 4 },
    );
});

test("budget snapshots and reservations are deeply frozen without changing failed state", () => {
    const ledger = new BudgetLedger();
    ledger.configure("k", { tokens: 10 });
    const reservation = ledger.reserve("r", "k", { tokens: 4 });
    assert.equal(Object.isFrozen(reservation), true);
    assert.equal(Object.isFrozen(reservation.amount), true);
    assert.throws(() => { (reservation.amount as unknown as { tokens: number }).tokens = 99; }, TypeError);

    const snapshot = ledger.snapshot("k");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.limit), true);
    assert.equal(Object.isFrozen(snapshot.settled), true);
    assert.equal(Object.isFrozen(snapshot.reserved), true);
    assert.throws(() => { (snapshot.limit as unknown as { tokens: number }).tokens = 99; }, TypeError);
    assert.throws(() => { (snapshot.reserved as unknown as { tokens: number }).tokens = 99; }, TypeError);

    assert.throws(() => ledger.reserve("r2", "k", { tokens: 7 }), code("limit_exceeded"));
    assert.throws(() => ledger.settle("r", { tokens: 5 }), code("settlement_exceeds_reservation"));
    const after = ledger.snapshot("k");
    assert.equal(after.limit.tokens, 10);
    assert.equal(after.settled.tokens, 0);
    assert.equal(after.reserved.tokens, 4);
});
