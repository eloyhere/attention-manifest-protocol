import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CascadeError } from "./cascade.ts";
import { Store } from "./store.ts";
import type { StoreOptions } from "./types.ts";

let serial = 0;
function temporaryPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "amp-cascade-"));
    return join(directory, `case-${++serial}.sqlite`);
}

function cleanup(path: string): void {
    rmSync(join(path, ".."), { recursive: true, force: true });
}

/** Opens a throwaway store, runs the case and always releases the database. */
function withStore(run: (store: Store) => void, options: StoreOptions = {}): void {
    const path = temporaryPath();
    const store = Store.open({ path, ...options });
    try {
        run(store);
    } finally {
        store.close();
        cleanup(path);
    }
}

function cascadeCode(code: CascadeError["code"]): (error: unknown) => boolean {
    return (error: unknown): boolean => error instanceof CascadeError && error.code === code;
}

/** plan -> tasks -> actions tree used by the persist and remove cases. */
function planTree() {
    return {
        id: "plan-1",
        sessionId: "session-1",
        version: 0,
        tasks: [
            {
                id: "task-1",
                sessionId: "session-1",
                planId: "plan-1",
                version: 0,
                actions: [
                    { id: "action-1", sessionId: "session-1", taskId: "task-1", version: 0 },
                ],
            },
            {
                id: "task-2",
                sessionId: "session-1",
                planId: "plan-1",
                version: 0,
                actions: [],
            },
        ],
    };
}

test("cascade persist saves the parent, children and grandchildren in one call", () => withStore((store) => {
    store.save("plan", planTree(), { cascade: "persist" });

    assert.equal(store.stats().entities, 4);
    assert.equal(store.stats().cache.entries, 4);
    assert.equal(store.stats().identity, 4);
    assert.equal(store.resolve<Record<string, unknown>>("plan", "plan-1").id, "plan-1");
    assert.equal(store.resolve<Record<string, unknown>>("task", "task-1").id, "task-1");
    assert.equal(store.resolve<Record<string, unknown>>("task", "task-2").id, "task-2");
    assert.equal(store.resolve<Record<string, unknown>>("action", "action-1").id, "action-1");
    assert.equal(store.state("task", "task-1"), "managed");
}));

test("cascade persist on a session saves its turns and cascade remove deletes them", () => withStore((store) => {
    const session = {
        id: "session-1",
        sessionId: "session-1",
        version: 0,
        turns: [{ id: "turn-1", sessionId: "session-1", version: 0 }],
    };

    store.save("session", session, { cascade: "persist" });
    assert.equal(store.resolve<Record<string, unknown>>("turn", "turn-1").id, "turn-1");

    assert.deepEqual(store.removeCascade("session", "session-1", { cascade: "remove" }), { removed: 2 });
    assert.equal(store.stats().entities, 0);
}));

test("save cascade none keeps the historical single-row write", () => withStore((store) => {
    store.save("plan", planTree());

    assert.equal(store.stats().entities, 1);
    assert.equal(store.resolve<Record<string, unknown>>("plan", "plan-1").id, "plan-1");
    assert.throws(() => store.resolve("task", "task-1"), /not_found/);
    assert.throws(() => store.resolve("action", "action-1"), /not_found/);
}));

test("cascade persist rejects a payload cycle with a stable error and rolls back", () => withStore((store) => {
    const cyclic = {
        id: "goal-a",
        version: 0,
        dependencies: [
            {
                id: "goal-b",
                version: 0,
                dependencies: [{ id: "goal-a", version: 0 }],
            },
        ],
    };

    assert.throws(() => store.save("goal", cyclic, { cascade: "persist" }), cascadeCode("cascade_cycle"));
    assert.equal(store.stats().entities, 0);
    assert.throws(() => store.resolve("goal", "goal-a"), /not_found/);
    assert.throws(() => store.resolve("goal", "goal-b"), /not_found/);
}));

test("cascade persist refuses graphs deeper than the default limit of eight", () => withStore((store) => {
    let chain: Record<string, unknown> = { id: "goal-9", version: 0 };
    for (let index = 8; index >= 0; index -= 1) {
        chain = { id: `goal-${index}`, version: 0, dependencies: [chain] };
    }

    assert.throws(() => store.save("goal", chain, { cascade: "persist" }), cascadeCode("cascade_depth"));
    assert.equal(store.stats().entities, 0);
}));

test("cascade persist honours a configured depth limit and rolls the root back", () => withStore((store) => {
    assert.throws(() => store.save("plan", planTree(), { cascade: "persist" }), cascadeCode("cascade_depth"));

    assert.equal(store.stats().entities, 0);
    assert.equal(store.stats().cache.entries, 0);
    // The failed root save left a managed identity, but no stale snapshot: its
    // payload was invalidated and the next read finds no row.
    const proxy = store.load<Record<string, unknown>>("plan", "plan-1");
    assert.equal(proxy?.tasks, undefined);
    assert.throws(() => store.resolve("plan", "plan-1"), /not_found/);
}, { cascadeDepth: 0 }));

test("cascade remove deletes the parent and its descendants", () => withStore((store) => {
    store.save("plan", planTree(), { cascade: "persist" });

    const report = store.removeCascade("plan", "plan-1", { cascade: "remove" });

    assert.deepEqual(report, { removed: 4 });
    assert.equal(store.stats().entities, 0);
    assert.equal(store.stats().cache.entries, 0);
    assert.equal(store.state("plan", "plan-1"), "removed");
    assert.equal(store.state("task", "task-1"), "removed");
    assert.equal(store.state("task", "task-2"), "removed");
    assert.equal(store.state("action", "action-1"), "removed");
    assert.throws(() => store.resolve("task", "task-1"), /not_found/);
}));

test("remove cascade none deletes only the addressed row", () => withStore((store) => {
    store.save("plan", planTree(), { cascade: "persist" });

    assert.equal(store.remove("plan", "plan-1"), true);
    assert.equal(store.state("plan", "plan-1"), "removed");
    assert.equal(store.stats().entities, 3);
    assert.equal(store.resolve<Record<string, unknown>>("task", "task-1").id, "task-1");
    assert.equal(store.resolve<Record<string, unknown>>("action", "action-1").id, "action-1");
    // The counting variant keeps the same default.
    assert.deepEqual(store.removeCascade("task", "task-2", { cascade: "none" }), { removed: 1 });
}));

test("a failing cascade remove rolls every deletion back and rotates identity", () => withStore((store) => {
    store.save("plan", { id: "plan-1", sessionId: "session-1", version: 0 });
    store.save("task", { id: "task-1", sessionId: "session-1", planId: "plan-1", version: 0 });
    store.save("action", { id: "action-1", sessionId: "session-1", taskId: "task-1", version: 0 });
    const before = store.resolve<Record<string, unknown>>("plan", "plan-1");

    // The plan and its task are deleted before the action exceeds the limit.
    assert.throws(() => store.removeCascade("plan", "plan-1", { cascade: "remove" }), cascadeCode("cascade_depth"));

    assert.equal(store.stats().entities, 3);
    assert.equal(store.stats().cache.entries, 0);
    assert.notEqual(store.state("plan", "plan-1"), "removed");
    assert.equal(store.resolve<Record<string, unknown>>("task", "task-1").id, "task-1");
    assert.equal(store.resolve<Record<string, unknown>>("action", "action-1").id, "action-1");
    const after = store.resolve<Record<string, unknown>>("plan", "plan-1");
    assert.equal(after.id, "plan-1");
    assert.notStrictEqual(after, before);
}, { cascadeDepth: 1 }));

test("orphanRemoval removes reservations even without cascade remove", () => withStore((store) => {
    store.save("budget_ledger", { id: "ledger-1", budgetKey: "ledger-1", version: 0 });
    store.save("budget_reservation", { id: "res-1", budgetKey: "ledger-1", version: 0 });
    store.save("budget_reservation", { id: "res-2", budgetKey: "ledger-1", version: 0 });
    store.save("budget_reservation", { id: "res-3", budgetKey: "ledger-2", version: 0 });

    const report = store.removeCascade("budget_ledger", "ledger-1", { cascade: "remove" });

    assert.deepEqual(report, { removed: 3 });
    assert.equal(store.stats().entities, 1);
    assert.equal(store.resolve<Record<string, unknown>>("budget_reservation", "res-3").id, "res-3");
}));

test("context checkpoint cascades persist and remove through the declared join property", () => withStore((store) => {
    const checkpoint = {
        id: "checkpoint-1",
        sessionId: "session-1",
        version: 0,
        cacheEntries: [
            { signature: "signature-1", checkpointId: "checkpoint-1", sessionId: "session-1", version: 0 },
        ],
    };

    store.save("context_checkpoint", checkpoint, { cascade: "persist" });
    assert.equal(store.resolve<Record<string, unknown>>("context_cache_entry", "signature-1").signature, "signature-1");

    assert.deepEqual(store.removeCascade("context_checkpoint", "checkpoint-1", { cascade: "remove" }), { removed: 2 });
    assert.equal(store.stats().entities, 0);
}));

test("cascade remove finds children by declared link even without a session id", () => withStore((store) => {
    store.save("context_checkpoint", { id: "checkpoint-2", sessionId: "session-1", version: 0 });
    store.save("context_cache_entry", { signature: "signature-2", checkpointId: "checkpoint-2", version: 0 });

    assert.deepEqual(store.removeCascade("context_checkpoint", "checkpoint-2", { cascade: "remove" }), { removed: 2 });
    assert.equal(store.stats().entities, 0);
}));

test("cascade all follows associations that do not declare a cascade", () => withStore((store) => {
    const turn = {
        id: "turn-1",
        sessionId: "session-1",
        version: 0,
        intents: [{ id: "intent-1", sessionId: "session-1", version: 0 }],
    };

    store.save("turn", turn, { cascade: "all" });
    assert.equal(store.resolve<Record<string, unknown>>("intent", "intent-1").id, "intent-1");

    assert.deepEqual(store.removeCascade("turn", "turn-1", { cascade: "all" }), { removed: 2 });
    assert.equal(store.stats().entities, 0);
}));

test("scalar ids in a payload stay references and are not persisted", () => withStore((store) => {
    store.save("goal", { id: "goal-1", version: 0, dependencies: ["goal-2"] }, { cascade: "persist" });

    assert.equal(store.stats().entities, 1);
    assert.throws(() => store.resolve("goal", "goal-2"), /not_found/);
}));

test("a cascade save fails before writing children when the root CAS conflicts", () => withStore((store) => {
    store.save("plan", { id: "plan-1", sessionId: "session-1", version: 0 });

    assert.throws(() => store.save("plan", planTree(), { cascade: "persist", expectedVersion: 3 }), /version_conflict/);

    assert.equal(store.stats().entities, 1);
    assert.throws(() => store.resolve("task", "task-1"), /not_found/);
}));

test("unknown cascade selectors and depth settings are rejected", () => {
    const path = temporaryPath();
    try {
        assert.throws(() => Store.open({ path, cascadeDepth: -1 }), /cascadeDepth/);
        const store = Store.open({ path });
        try {
            assert.throws(
                () => store.save("plan", planTree(), { cascade: "everything" as unknown as "all" }),
                cascadeCode("cascade_invalid"),
            );
            assert.throws(
                () => store.remove("plan", "plan-1", { cascade: "everything" as unknown as "remove" }),
                cascadeCode("cascade_invalid"),
            );
        } finally {
            store.close();
        }
    } finally {
        cleanup(path);
    }
});
