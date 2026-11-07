import assert from "node:assert/strict";
import test from "node:test";
import type { AttentionScope } from "../attention/types.ts";
import { cacheKey, stableSerializeArguments } from "../cache/index.ts";
import { signature } from "../context/cached.ts";
import type { Budget } from "../shared.ts";
import {
    SerializationError,
    digestOf,
    isSerializationError,
    safeParse,
    safeStringify,
    traverseSafely,
} from "./index.ts";

const NOW = "2026-11-07T00:00:00.000Z";

const isSerializationFailure = (error: unknown): boolean => isSerializationError(error) && error instanceof SerializationError;

test("safeStringify filters circular references instead of throwing", () => {
    const self: Record<string, unknown> = { id: "root" };
    self.self = self;
    assert.equal(safeStringify(self), '{"id":"root"}');
    assert.deepEqual(safeParse(safeStringify(self)), { id: "root" });

    const parent: Record<string, unknown> = { name: "parent" };
    const child: Record<string, unknown> = { name: "child", parent };
    parent.child = child;
    assert.equal(safeStringify(parent), '{"name":"parent","child":{"name":"child"}}');

    // A circular array position is rendered as null, exactly like JSON's
    // treatment of an undefined array element.
    const items: unknown[] = [1];
    items.push(items);
    assert.equal(safeStringify(items), "[1,null]");

    // Stable mode keeps the same filter semantics.
    assert.equal(safeStringify(self, { stableKeys: true }), '{"id":"root"}');
});

test("safeStringify keeps only the first occurrence of a shared reference", () => {
    const shared = { id: "shared" };
    assert.equal(safeStringify({ first: shared, second: shared }), '{"first":{"id":"shared"}}');
    assert.equal(safeStringify([shared, shared]), '[{"id":"shared"},null]');
    assert.equal(
        safeStringify({ a: shared, b: shared }, { stableKeys: true }),
        '{"a":{"id":"shared"}}',
    );
});

test("safeStringify handles deep nesting without recursion failure", () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 256; depth += 1) value = { next: value };
    const text = safeStringify(value, { stableKeys: true });
    assert.equal(text.includes('"leaf":true'), true);
    let parsed = safeParse<Record<string, unknown>>(text);
    for (let depth = 0; depth < 256; depth += 1) parsed = parsed.next as Record<string, unknown>;
    assert.deepEqual(parsed, { leaf: true });

    const visited: unknown[] = [];
    const stats = traverseSafely(value, leaf => { visited.push(leaf); });
    assert.deepEqual(stats, { visited: 1, skipped: 0, stopped: false });
    assert.deepEqual(visited, [true]);
});

test("undefined, functions and symbols are omitted from objects and nulled in arrays", () => {
    const value = { keep: 1, missing: undefined, fn() {}, sym: Symbol("s") };
    assert.equal(safeStringify(value), '{"keep":1}');
    assert.equal(safeStringify([undefined, () => 1, Symbol("s"), 2]), "[null,null,null,2]");
    for (const root of [undefined, () => 1, Symbol("s")]) {
        assert.throws(() => safeStringify(root), isSerializationFailure);
    }
});

test("Date is rendered through toJSON and BigInt fails as SerializationError", () => {
    assert.equal(safeStringify({ when: new Date(0) }), '{"when":"1970-01-01T00:00:00.000Z"}');
    assert.equal(safeStringify({ when: new Date(0) }, { stableKeys: true }), '{"when":"1970-01-01T00:00:00.000Z"}');
    assert.throws(() => safeStringify({ count: 1n }), (error: unknown) => {
        if (!isSerializationError(error)) return false;
        return error.cause instanceof TypeError;
    });
});

test("numbers JSON cannot represent become null while -0 keeps JSON semantics", () => {
    assert.equal(safeStringify({ nan: Number.NaN, infinity: Infinity }), '{"nan":null,"infinity":null}');
    assert.equal(safeStringify([Number.NaN, Infinity, -0]), "[null,null,0]");
});

test("stable key order is insertion-independent and uses code-unit order", () => {
    const left = { b: 1, A: 2, a: 3, nested: { z: 1, y: 2 } };
    const right = { nested: { y: 2, z: 1 }, a: 3, A: 2, b: 1 };
    assert.equal(safeStringify(left, { stableKeys: true }), '{"A":2,"a":3,"b":1,"nested":{"y":2,"z":1}}');
    assert.equal(safeStringify(left, { stableKeys: true }), safeStringify(right, { stableKeys: true }));
    assert.notEqual(JSON.stringify(left), JSON.stringify(right));

    // Default mode preserves the historical JSON.stringify property order.
    assert.equal(safeStringify(left), JSON.stringify(left));
    // Arrays keep index order; only object keys are sorted.
    assert.equal(safeStringify([{ b: 1, a: 2 }], { stableKeys: true }), '[{"a":2,"b":1}]');
});

test("stable serialization is pure: it neither mutates nor reorders the input", () => {
    const shared = Object.freeze({ id: "shared" });
    const value = Object.freeze({ b: shared, a: Object.freeze([1, 2]) });
    assert.equal(safeStringify(value, { stableKeys: true }), '{"a":[1,2],"b":{"id":"shared"}}');
    assert.deepEqual(Object.keys(value), ["b", "a"]);
    assert.equal(value.b, shared);
});

test("safeStringify validates its options", () => {
    assert.throws(() => safeStringify({}, null as never), TypeError);
    assert.throws(() => safeStringify({}, { stableKeys: "yes" } as never), TypeError);
});

test("hostile accessors and toJSON methods fail as SerializationError", () => {
    const accessor = { get boom(): number { throw new Error("accessor exploded"); } };
    assert.throws(() => safeStringify(accessor), isSerializationFailure);
    assert.throws(() => safeStringify(accessor, { stableKeys: true }), isSerializationFailure);
    assert.throws(() => safeStringify({ toJSON() { throw new Error("toJSON exploded"); } }), isSerializationFailure);
});

test("digestOf is stable across key order and sensitive to content", () => {
    assert.equal(digestOf({ a: 1, b: { c: 2 } }), digestOf({ b: { c: 2 }, a: 1 }));
    assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
    assert.match(digestOf({ a: 1 }), /^sha256:[0-9a-f]{64}$/);

    const cyclic: Record<string, unknown> = { id: "x" };
    cyclic.self = cyclic;
    assert.equal(digestOf(cyclic), digestOf({ id: "x" }));
    assert.throws(() => digestOf({ count: 1n }), isSerializationFailure);
});

test("safeParse rejects malformed JSON with SerializationError and never returns partial data", () => {
    for (const text of ["", "{", '{"a":}', "[1,,]"]) {
        assert.throws(() => safeParse(text), isSerializationFailure);
    }
    assert.throws(() => safeParse(42 as never), isSerializationFailure);
    assert.deepEqual(safeParse<{ a: number }>('{"a":1}'), { a: 1 });
    assert.equal(safeParse<string>('"text"'), "text");
});

test("safeStringify equals JSON.stringify for acyclic JSON-safe input", () => {
    const value = {
        id: "x", count: 2, ratio: 0.5, active: true, nothing: null,
        list: [1, "two", false, null, { nested: ["deep"] }],
        object: { alpha: 1, beta: { gamma: 2 } },
    };
    assert.equal(safeStringify(value), JSON.stringify(value));
    assert.deepEqual(safeParse(safeStringify(value, { stableKeys: true })), value);

    // When insertion order already matches the fixed rule, stable output is
    // byte-identical to JSON.stringify.
    const sorted = { alpha: 1, beta: { gamma: 2 }, list: [1, 2] };
    assert.equal(safeStringify(sorted, { stableKeys: true }), JSON.stringify(sorted));
});

test("traverseSafely visits leaves once and counts skipped shared references", () => {
    const shared = { id: "shared", tags: ["a"] };
    const left = { name: "left" };
    const root = {
        shared,
        again: shared,
        left,
        right: { name: "right", left },
        list: [{ v: 1 }, "two", [3]],
        ok: true,
        missing: null,
        undef: undefined,
    };
    const values: unknown[] = [];
    const paths: string[] = [];
    const stats = traverseSafely(root, (value, path) => {
        values.push(value);
        paths.push(path.map(String).join("."));
    });
    assert.equal(stats.visited, 9);
    assert.equal(stats.skipped, 2);
    assert.equal(stats.stopped, false);
    // `useTraverse` walks a nested array through its own keys, so its length
    // is reported as a leaf too; that library quirk is preserved on purpose.
    assert.deepEqual(values, ["shared", "a", "left", "right", 1, "two", 3, 1, true]);
    assert.deepEqual(paths, [
        "shared.id", "shared.tags.0", "left.name", "right.name",
        "list.0.v", "list.1", "list.2.0", "list.2.length", "ok",
    ]);
});

test("traverseSafely stops when the visitor returns false", () => {
    const values: unknown[] = [];
    const stats = traverseSafely({ a: 1, b: 2, c: 3 }, value => {
        values.push(value);
        return false;
    });
    assert.deepEqual(stats, { visited: 1, skipped: 0, stopped: true });
    assert.deepEqual(values, [1]);
});

test("traverseSafely ignores non-object roots and rejects a missing visitor", () => {
    const visitor = (): void => { throw new Error("visitor must not run"); };
    for (const root of [null, undefined, 1, "text", true, 1n]) {
        assert.deepEqual(traverseSafely(root, visitor), { visited: 0, skipped: 0, stopped: false });
    }
    assert.throws(() => traverseSafely({}, null as never), TypeError);
});

test("cache keys stay order-insensitive and cycle-rejecting after the serializer swap", () => {
    const left = { tenantId: "tenant", path: "a/b", version: 2 };
    const right = { version: 2, path: "a/b", tenantId: "tenant" };
    assert.notEqual(JSON.stringify(left), JSON.stringify(right));
    assert.equal(cacheKey("find", [left]), cacheKey("find", [right]));
    assert.equal(cacheKey("find", [left]), safeStringify(["find", stableSerializeArguments([left])]));

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => stableSerializeArguments([cyclic]), /cycles/);
});

test("context signatures are value-identical and use the stable key rule", () => {
    const scope: AttentionScope = { tenantId: "tenant", principalId: "principal", sessionId: "session", turnId: "turn" };
    const budget: Budget = { tokens: 1000, bytes: 4096 };
    const expected = safeStringify({
        scope: [scope.tenantId, scope.principalId, scope.sessionId, scope.turnId, scope.workspaceId ?? null, scope.projectId ?? null],
        budget: [budget.tokens ?? null, budget.milliseconds ?? null, budget.calls ?? null, budget.bytes ?? null],
        now: NOW,
        objects: [],
    }, { stableKeys: true });
    assert.equal(signature(scope, budget, NOW, []), expected);
    assert.equal(
        signature(scope, budget, NOW, []),
        signature({ turnId: "turn", sessionId: "session", principalId: "principal", tenantId: "tenant" }, budget, NOW, []),
    );
});
