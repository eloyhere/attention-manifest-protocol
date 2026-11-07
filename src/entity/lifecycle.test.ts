import assert from "node:assert/strict";
import test from "node:test";

import {
    ENTITY_LIFECYCLE_EVENTS,
    ENTITY_STATES,
    LIFECYCLE_TRANSITIONS,
    LifecycleRegistry,
    assertLifecycleTransition,
    createLifecycleDispatcher,
    normalizeLifecycleState,
} from "./index.ts";
import type {
    EntityKind,
    EntityLifecycle,
    EntityLifecycleContext,
    EntityLifecycleEvent,
    EntityState,
} from "./index.ts";

const context = (kind: EntityKind = "session", patch: Partial<EntityLifecycleContext> = {}): EntityLifecycleContext => ({
    kind,
    state: "new",
    version: 0,
    now: "2026-01-01T00:00:00.000Z",
    ...patch,
});

test("the lifecycle event list and state list are complete and frozen", () => {
    assert.deepEqual([...ENTITY_LIFECYCLE_EVENTS], [
        "prePersist",
        "postPersist",
        "preUpdate",
        "postUpdate",
        "preRemove",
        "postRemove",
        "postLoad",
    ]);
    assert.deepEqual([...ENTITY_STATES], ["new", "managed", "detached", "removed", "deleted"]);
    assert.ok(Object.isFrozen(ENTITY_LIFECYCLE_EVENTS));
    assert.ok(Object.isFrozen(ENTITY_STATES));
});

test("the full transition matrix accepts legal edges and rejects illegal edges", () => {
    const states = Object.keys(LIFECYCLE_TRANSITIONS) as EntityState[];
    for (const from of states) {
        for (const to of states) {
            if (LIFECYCLE_TRANSITIONS[from].includes(to)) {
                assert.doesNotThrow(() => assertLifecycleTransition(from, to), `${from} -> ${to} should be legal`);
            } else {
                assert.throws(() => assertLifecycleTransition(from, to), TypeError, `${from} -> ${to} should be illegal`);
            }
        }
    }

    assert.equal(normalizeLifecycleState("deleted"), "removed");
    assert.equal(normalizeLifecycleState("managed"), "managed");
    assert.throws(() => assertLifecycleTransition("new", "unknown" as EntityState), /unknown lifecycle transition/);
    assert.throws(() => assertLifecycleTransition("unknown" as EntityState, "managed"), /unknown lifecycle transition/);

    // `deleted` is reserved: normalizing it first makes it comparable to a
    // `removed` state, while the raw alias is never a legal transition edge.
    assert.throws(() => assertLifecycleTransition("managed", "deleted"), /invalid lifecycle transition/);
    assert.throws(() => assertLifecycleTransition("deleted", "managed"), /invalid lifecycle transition/);
    assert.throws(() => assertLifecycleTransition("removed", "deleted"), /invalid lifecycle transition/);
    assert.doesNotThrow(() => assertLifecycleTransition("managed", normalizeLifecycleState("deleted")));
});

test("a pre* callback that throws aborts dispatch immediately", () => {
    const calls: string[] = [];
    const failure = new Error("pre boom");
    const dispatcher = createLifecycleDispatcher([
        {
            prePersist() {
                calls.push("first");
            },
        },
        {
            prePersist() {
                calls.push("second");
                throw failure;
            },
        },
        {
            postPersist() {
                calls.push("never");
            },
        },
    ]);

    assert.throws(
        () => dispatcher.fire("prePersist", { id: "session-1" }, context()),
        error => error === failure,
    );
    assert.deepEqual(calls, ["first", "second"]);
});

test("post* callback errors are collected while later callbacks still run", () => {
    const calls: string[] = [];
    const first = new Error("first post failure");
    const second = new Error("second post failure");
    const dispatcher = createLifecycleDispatcher([
        {
            postPersist() {
                calls.push("first");
                throw first;
            },
        },
        {
            postPersist() {
                calls.push("second");
            },
        },
        {
            postPersist() {
                calls.push("third");
                throw second;
            },
        },
    ]);

    const result = dispatcher.fire("postPersist", { id: "session-1" }, context());
    assert.deepEqual(calls, ["first", "second", "third"]);
    assert.equal(result.invoked, 3);
    assert.equal(result.errors.length, 2);
    assert.strictEqual(result.errors[0], first);
    assert.strictEqual(result.errors[1], second);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.errors));

    const nonError: unknown = "plain failure";
    const normalized = createLifecycleDispatcher({
        postLoad() {
            throw nonError;
        },
    }).fire("postLoad", {}, context());
    assert.equal(normalized.errors.length, 1);
    assert.ok(normalized.errors[0] instanceof Error);
});

test("callbacks run in registration order and invoked counts only matching callbacks", () => {
    const calls: string[] = [];
    const dispatcher = createLifecycleDispatcher();
    dispatcher.register({ preUpdate() { calls.push("first"); } });
    dispatcher.register({ preUpdate() { calls.push("second"); }, postUpdate() { calls.push("unused"); } });
    dispatcher.register({ preUpdate() { calls.push("third"); } });

    const result = dispatcher.fire("preUpdate", {}, context("turn", { state: "managed", version: 4 }));
    assert.deepEqual(calls, ["first", "second", "third"]);
    assert.equal(result.invoked, 3);

    const empty = createLifecycleDispatcher().fire("postRemove", {}, context());
    assert.deepEqual(empty, { invoked: 0, errors: [] });
    assert.ok(Object.isFrozen(empty));
    assert.ok(Object.isFrozen(empty.errors));
});

test("a single callback object and an array both register hooks", () => {
    const calls: string[] = [];
    const single = createLifecycleDispatcher({
        preRemove() {
            calls.push("single");
        },
    });
    single.fire("preRemove", {}, context());
    assert.deepEqual(calls, ["single"]);

    const multiple = createLifecycleDispatcher([
        { preRemove() { calls.push("array-1"); } },
        { preRemove() { calls.push("array-2"); } },
    ]);
    multiple.fire("preRemove", {}, context());
    assert.deepEqual(calls, ["single", "array-1", "array-2"]);
});

test("dispatcher rejects unknown events and malformed contexts", () => {
    const dispatcher = createLifecycleDispatcher({ prePersist() {} });
    assert.throws(
        () => dispatcher.fire("unknown" as EntityLifecycleEvent, {}, context()),
        /unknown entity lifecycle event/,
    );
    assert.throws(() => dispatcher.fire("prePersist", {}, context("session", { version: -1 })), /version/);
    assert.throws(() => dispatcher.fire("prePersist", {}, context("session", { now: "" })), /now/);
    assert.throws(
        () => dispatcher.fire("prePersist", {}, context("session", { state: "bad" as EntityState })),
        /entity state/,
    );
    assert.throws(
        () => dispatcher.fire("prePersist", {}, context("not-a-kind" as EntityKind)),
        /unknown lifecycle context kind/,
    );
});

test("LifecycleRegistry registers one hook object per kind and rejects duplicates", () => {
    const registry = new LifecycleRegistry();
    const calls: string[] = [];
    const hooks: EntityLifecycle<{ id: string }> = {
        prePersist(entity) {
            calls.push(`pre:${entity.id}`);
        },
        postPersist(entity) {
            calls.push(`post:${entity.id}`);
        },
    };
    assert.strictEqual(registry.register("session", hooks), registry);
    assert.equal(registry.has("session"), true);
    assert.deepEqual(registry.get("session"), hooks);
    assert.deepEqual(registry.kinds(), ["session"]);
    assert.throws(() => registry.register("session", {}), /already registered/);
    assert.throws(() => registry.register("not-a-kind" as EntityKind, {}), /unknown entity kind/);

    assert.equal(registry.fire("session", "prePersist", { id: "s1" }, context()).invoked, 1);
    assert.equal(registry.fire("session", "postPersist", { id: "s1" }, context()).invoked, 1);
    assert.deepEqual(calls, ["pre:s1", "post:s1"]);

    // A known kind without hooks is a no-op; a context for another kind is not.
    const empty = registry.fire("turn", "prePersist", {}, context("turn"));
    assert.deepEqual(empty, { invoked: 0, errors: [] });
    assert.ok(Object.isFrozen(empty));
    assert.throws(() => registry.fire("session", "prePersist", {}, context("turn")), /does not match/);
});

test("LifecycleRegistry preserves registration order and collects post errors", () => {
    const registry = new LifecycleRegistry();
    const calls: string[] = [];
    const sessionHooks: EntityLifecycle<unknown> = {
        prePersist() {
            calls.push("session:pre");
        },
        postPersist() {
            calls.push("session:post");
            throw new Error("session post");
        },
    };
    const turnHooks: EntityLifecycle<unknown> = {
        prePersist() {
            calls.push("turn:pre");
        },
    };
    registry.register("session", sessionHooks);
    registry.register("turn", turnHooks);
    assert.deepEqual(registry.kinds(), ["session", "turn"]);

    const result = registry.fire("session", "postPersist", {}, context());
    assert.deepEqual(calls, ["session:post"]);
    assert.equal(result.errors.length, 1);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.errors));

    const initialized = new LifecycleRegistry({
        session: { prePersist() { calls.push("initialized"); } },
    });
    assert.equal(initialized.has("session"), true);
    assert.equal(initialized.has("turn"), false);
});

test("registry fire validates kinds and events before dispatching", () => {
    const registry = new LifecycleRegistry();
    assert.throws(
        () => registry.fire("not-a-kind" as EntityKind, "prePersist", {}, context()),
        /unknown entity kind/,
    );
    assert.throws(
        () => registry.fire("session", "unknown" as EntityLifecycleEvent, {}, context()),
        /unknown entity lifecycle event/,
    );
});
