import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError } from "./ledger.ts";
import type { BudgetErrorCode } from "./ledger.ts";
import { BudgetTree } from "./tree.ts";
import { EmptyBudgetTreeUsage } from "./types.ts";
import type { BudgetDimension, BudgetTreeUsage } from "./types.ts";

const code = (expected: BudgetErrorCode) => (error: unknown): boolean => error instanceof BudgetError && error.code === expected;
const usage = (overrides: Partial<BudgetTreeUsage> = {}): BudgetTreeUsage => ({ ...EmptyBudgetTreeUsage, ...overrides });
const tree = (limit: Partial<BudgetTreeUsage> = { tokens: 100 }): BudgetTree =>
    new BudgetTree({ root: { id: "session", limit } });
const unsafe = Number.MAX_SAFE_INTEGER + 1;

test("allocate creates a child and moves budget without inventing usage", () => {
    const budgets = tree();
    const turn = budgets.allocate("session", "turn-1", { tokens: 40 });

    assert.equal(turn.id, "turn-1");
    assert.equal(turn.parentId, "session");
    assert.deepEqual(turn.limit, usage({ tokens: 40 }));
    assert.deepEqual(turn.allocated, usage());
    assert.deepEqual(turn.settled, usage());
    assert.deepEqual(turn.reserved, usage());

    const session = budgets.snapshot("session");
    assert.deepEqual(session.limit, usage({ tokens: 100 }));
    assert.deepEqual(session.allocated, usage({ tokens: 40 }));
    assert.deepEqual(session.settled, usage());
    assert.deepEqual(session.reserved, usage());
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 60 }));
    assert.equal(budgets.size, 2);
});

test("a child allocation may not exceed the parent's remaining budget", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "turn-1", { tokens: 70 });
    const before = budgets.snapshot("session");

    assert.throws(() => budgets.allocate("session", "turn-2", { tokens: 31 }), code("budget_exhausted"));
    assert.deepEqual(budgets.snapshot("session"), before);
    assert.equal(budgets.has("turn-2"), false);
    assert.equal(budgets.size, 2);
});

test("siblings are isolated: one child's consumption does not reduce another's budget", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "a", { tokens: 40 });
    budgets.allocate("session", "b", { tokens: 40 });
    budgets.consume("a", { tokens: 30 });

    assert.deepEqual(budgets.remaining("a"), usage({ tokens: 10 }));
    assert.deepEqual(budgets.remaining("b"), usage({ tokens: 40 }));
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 20 }));
    assert.equal(budgets.snapshot("b").settled.tokens, 0);
    assert.throws(() => budgets.consume("b", { tokens: 41 }), code("budget_exhausted"));
    assert.deepEqual(budgets.snapshot("b").settled, usage());
});

test("consume records settled usage across dimensions", () => {
    const budgets = tree({ tokens: 100, calls: 10 });
    budgets.allocate("session", "turn", { tokens: 50, calls: 5 });
    budgets.consume("turn", { tokens: 20, calls: 2 });

    const snapshot = budgets.snapshot("turn");
    assert.deepEqual(snapshot.settled, usage({ tokens: 20, calls: 2 }));
    assert.deepEqual(snapshot.allocated, usage());
    assert.deepEqual(snapshot.reserved, usage());
    assert.deepEqual(budgets.remaining("turn"), usage({ tokens: 30, calls: 3 }));
});

test("consume exhaustion throws budget_exhausted, keeps state unchanged, and fires once per node/dimension", () => {
    const events: { readonly node: string; readonly dimension: BudgetDimension }[] = [];
    const budgets = new BudgetTree({
        root: { id: "session", limit: { tokens: 10 } },
        onExhausted: (node, dimension) => { events.push({ node, dimension }); },
    });
    budgets.allocate("session", "turn", { tokens: 5 });
    const before = budgets.snapshot("turn");

    assert.throws(() => budgets.consume("turn", { tokens: 6 }), code("budget_exhausted"));
    assert.throws(() => budgets.consume("turn", { tokens: 7 }), code("budget_exhausted"));
    assert.deepEqual(budgets.snapshot("turn"), before);
    assert.deepEqual(events, [{ node: "turn", dimension: "tokens" }]);

    assert.throws(() => budgets.consume("turn", { calls: 1 }), code("budget_exhausted"));
    assert.deepEqual(events, [
        { node: "turn", dimension: "tokens" },
        { node: "turn", dimension: "calls" },
    ]);
});

test("allocation exhaustion reports the parent once and does not close it", () => {
    const events: { readonly node: string; readonly dimension: BudgetDimension }[] = [];
    const budgets = new BudgetTree({
        root: { id: "session", limit: { tokens: 10 } },
        onExhausted: (node, dimension) => { events.push({ node, dimension }); },
    });
    budgets.allocate("session", "turn-1", { tokens: 8 });

    assert.throws(() => budgets.allocate("session", "turn-2", { tokens: 3 }), code("budget_exhausted"));
    assert.throws(() => budgets.allocate("session", "turn-3", { tokens: 4 }), code("budget_exhausted"));
    assert.deepEqual(events, [{ node: "session", dimension: "tokens" }]);
    assert.equal(budgets.has("turn-2"), false);
    assert.equal(budgets.has("turn-3"), false);
});

test("reserve and release adjust reserved budget without touching settled usage", () => {
    const budgets = tree({ tokens: 100, calls: 10 });
    budgets.allocate("session", "turn", { tokens: 50, calls: 5 });
    budgets.reserve("turn", { tokens: 20, calls: 2 });

    assert.deepEqual(budgets.snapshot("turn").reserved, usage({ tokens: 20, calls: 2 }));
    assert.deepEqual(budgets.remaining("turn"), usage({ tokens: 30, calls: 3 }));

    budgets.release("turn", { tokens: 5 });
    assert.deepEqual(budgets.snapshot("turn").reserved, usage({ tokens: 15, calls: 2 }));
    assert.throws(() => budgets.release("turn", { tokens: 16 }), code("invalid_release"));

    budgets.release("turn");
    assert.deepEqual(budgets.snapshot("turn").reserved, usage());
    assert.deepEqual(budgets.snapshot("turn").settled, usage());
    assert.deepEqual(budgets.snapshot("turn").limit, usage({ tokens: 50, calls: 5 }));
});

test("release returns unspent allocation to the parent without settling the node", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "turn", { tokens: 50 });
    budgets.consume("turn", { tokens: 10 });

    budgets.release("turn", { tokens: 15 });
    assert.deepEqual(budgets.snapshot("turn").limit, usage({ tokens: 35 }));
    assert.deepEqual(budgets.snapshot("turn").settled, usage({ tokens: 10 }));
    assert.deepEqual(budgets.snapshot("session").allocated, usage({ tokens: 35 }));
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 65 }));

    budgets.release("turn");
    assert.deepEqual(budgets.snapshot("turn").limit, usage({ tokens: 10 }));
    assert.deepEqual(budgets.snapshot("session").allocated, usage({ tokens: 10 }));
    assert.throws(() => budgets.release("session", { tokens: 1 }), code("invalid_release"));
});

test("the root can be supplied through the constructor shorthand", () => {
    const budgets = new BudgetTree({ id: "session", limit: { tokens: 20 } });
    assert.equal(budgets.has("session"), true);
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 20 }));
});

test("settle finalizes reservations, reclaims the remainder by default, and closes the node", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "turn", { tokens: 50 });
    budgets.reserve("turn", { tokens: 20 });

    const settled = budgets.settle("turn");
    assert.deepEqual(settled.settled, usage({ tokens: 20 }));
    assert.deepEqual(settled.reserved, usage());
    assert.deepEqual(settled.limit, usage({ tokens: 20 }));
    assert.deepEqual(budgets.snapshot("session").allocated, usage({ tokens: 20 }));
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 80 }));
    assert.throws(() => budgets.consume("turn", { tokens: 1 }), code("node_closed"));
});

test("settle with actual usage releases the unused reservation and returns it to the parent", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "turn", { tokens: 50 });
    budgets.reserve("turn", { tokens: 20 });

    const settled = budgets.settle("turn", { tokens: 12 });
    assert.deepEqual(settled.settled, usage({ tokens: 12 }));
    assert.deepEqual(settled.reserved, usage());
    assert.deepEqual(settled.limit, usage({ tokens: 12 }));
    assert.deepEqual(budgets.snapshot("session").allocated, usage({ tokens: 12 }));
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 88 }));
});

test("settle can retain the unused limit for a retention policy", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "turn", { tokens: 50 });
    budgets.consume("turn", { tokens: 10 });

    const settled = budgets.settle("turn", undefined, { reclaim: false });
    assert.deepEqual(settled.limit, usage({ tokens: 50 }));
    assert.deepEqual(settled.settled, usage({ tokens: 10 }));
    assert.deepEqual(budgets.snapshot("session").allocated, usage({ tokens: 50 }));
});

test("settlement cannot exceed an open reservation", () => {
    const budgets = tree({ tokens: 100 });
    budgets.allocate("session", "turn", { tokens: 50 });
    budgets.reserve("turn", { tokens: 10 });
    const before = budgets.snapshot("turn");

    assert.throws(() => budgets.settle("turn", { tokens: 11 }), code("settlement_exceeds_reservation"));
    assert.deepEqual(budgets.snapshot("turn"), before);
});

test("six dimensions are tracked independently and only the exhausted dimension fires", () => {
    const dimensions: readonly BudgetDimension[] = ["tokens", "milliseconds", "calls", "bytes", "retries", "concurrency"];
    const events: { readonly node: string; readonly dimension: BudgetDimension }[] = [];
    const limits = {
        tokens: 100,
        milliseconds: 1000,
        calls: 10,
        bytes: 100,
        retries: 2,
        concurrency: 4,
    };
    const budgets = new BudgetTree({
        root: { id: "root", limit: limits },
        onExhausted: (node, dimension) => { events.push({ node, dimension }); },
    });
    budgets.allocate("root", "child", limits);
    budgets.consume("child", limits);

    for (const dimension of dimensions) assert.equal(budgets.remaining("child")[dimension], 0, dimension);
    assert.throws(() => budgets.consume("child", { calls: 1 }), code("budget_exhausted"));
    assert.deepEqual(events, [{ node: "child", dimension: "calls" }]);
    for (const dimension of dimensions) {
        if (dimension !== "calls") assert.equal(budgets.snapshot("child").settled[dimension], limits[dimension]);
    }
});

test("negative, fractional, unsafe, unknown and non-numeric dimensions are rejected atomically", () => {
    const budgets = tree({ tokens: 100 });
    const before = budgets.snapshot("session");
    const invalid = [
        { tokens: -1 },
        { tokens: 1.5 },
        { tokens: unsafe },
        { unknown: 1 },
        { tokens: "1" },
        { tokens: Number.NaN },
        { tokens: Number.POSITIVE_INFINITY },
    ] as unknown as readonly Record<string, unknown>[];

    for (const amount of invalid) {
        assert.throws(() => budgets.allocate("session", "turn", amount as never), code("invalid_amount"), JSON.stringify(amount));
    }
    assert.deepEqual(budgets.snapshot("session"), before);
    assert.equal(budgets.has("turn"), false);

    budgets.allocate("session", "turn", { tokens: 10 });
    for (const amount of invalid) {
        assert.throws(() => budgets.consume("turn", amount as never), code("invalid_amount"), JSON.stringify(amount));
        assert.throws(() => budgets.reserve("turn", amount as never), code("invalid_amount"), JSON.stringify(amount));
    }
    assert.deepEqual(budgets.snapshot("turn").settled, usage());
    assert.deepEqual(budgets.snapshot("turn").reserved, usage());
});

test("unknown nodes, duplicate roots, self-allocation and re-parenting are rejected", () => {
    const budgets = tree();
    assert.throws(() => budgets.allocate("missing", "child", { tokens: 1 }), code("node_not_found"));
    assert.throws(() => budgets.consume("missing", { tokens: 1 }), code("node_not_found"));
    assert.throws(() => budgets.snapshot("missing"), code("node_not_found"));
    assert.throws(() => budgets.addRoot("session", { tokens: 1 }), code("node_exists"));
    assert.throws(() => budgets.allocate("session", "session", { tokens: 1 }), code("invalid_parent"));

    budgets.allocate("session", "a", { tokens: 10 });
    budgets.allocate("session", "b", { tokens: 10 });
    assert.throws(() => budgets.allocate("a", "b", { tokens: 1 }), code("invalid_parent"));
});

test("snapshots are detached, deeply frozen copies", () => {
    const budgets = tree();
    const snapshot = budgets.allocate("session", "turn", { tokens: 10 });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.limit), true);
    assert.equal(Object.isFrozen(snapshot.allocated), true);
    assert.equal(Object.isFrozen(snapshot.settled), true);
    assert.equal(Object.isFrozen(snapshot.reserved), true);
    assert.throws(() => { (snapshot.limit as unknown as { tokens: number }).tokens = 99; }, TypeError);

    const all = budgets.snapshots();
    assert.equal(Object.isFrozen(all), true);
    assert.deepEqual(all.map(item => item.id), ["session", "turn"]);
    assert.throws(() => (all as unknown as unknown[]).push({}), TypeError);
});

test("multiple roots are independent and settle is idempotent only by rejection", () => {
    const budgets = new BudgetTree();
    budgets.addRoot("session", { tokens: 100 });
    budgets.addRoot("reserve", { tokens: 50 });
    assert.deepEqual(budgets.remaining("session"), usage({ tokens: 100 }));
    assert.deepEqual(budgets.remaining("reserve"), usage({ tokens: 50 }));

    budgets.allocate("reserve", "mission", { tokens: 20 });
    budgets.settle("reserve");
    assert.deepEqual(budgets.snapshot("reserve").allocated, usage({ tokens: 20 }));
    assert.throws(() => budgets.settle("reserve"), code("node_closed"));
});
