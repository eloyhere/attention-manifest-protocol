#!/usr/bin/env node
/**
 * Construction-boundary checks.
 *
 * Each case corresponds to a failure that the literal-based runtime accepts
 * silently today: unresolvable references, empty revisit reasons, unbounded
 * exclusion lists, and tool arguments that do not match their schema.
 */
import assert from "node:assert/strict";

import { BoundaryRejection, RefTable, frameFrom, parseToolCall } from "../src/boundary/index.ts";
import type { FrameDraft } from "../src/boundary/index.ts";
import type { Ignored, Impasse, Slot } from "../src/frame/frame.ts";
import { canonical, digestOf } from "../src/semantic/canonical.ts";
import { sha256Hex } from "../src/semantic/sha256.ts";

let passed: number = 0;
let failed: number = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed++;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const rejects =
    (code: string, fragment?: string) =>
    (error: unknown): boolean => {
        if (!(error instanceof BoundaryRejection) || error.code !== code) {
            return false;
        }
        if (fragment === (void 0)) {
            return true;
        }
        return error.problems.some((problem) => problem.includes(fragment));
    };

const table = RefTable.forScope("run", "a.test")
    .add("capability", "logs.query", { kind: "capability", id: "logs.query" })
    .add("concept", "c.dns_failover", { kind: "concept", id: "c.dns_failover" })
    .add("claim", "cl.1", { kind: "claim", id: "cl.1" });

const slot: Slot = {
    target: { kind: "tool", id: "logs.query" },
    role: "evidence",
    salience: 0.7,
    voi: 0.6,
    cost: { tokens: 400 },
    why: "需要最近 30 分钟的日志",
    state: "active",
};

const ignored: Ignored = {
    target: { kind: "concept", id: "c.dns_failover" },
    reason: "deferred",
    revisit_if: "预算恢复或 DNS 相关错误码出现",
};

const draft = (overrides: Partial<FrameDraft> = {}): FrameDraft => ({
    id: "f.101",
    agent: "a.test",
    cycle: 1,
    ts: "2026-10-24T01:10:00.000Z",
    mode: "triage",
    slots: [slot],
    ignored: [ignored],
    budget: { allocated: { tokens: 4000 }, spent: { tokens: 0 } },
    ...overrides,
});

test("valid frame is accepted and digest is computed by the boundary", () => {
    const result = frameFrom(draft(), table);
    assert.match(result.frame.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.frame.ignored?.length, 1);
    assert.equal(result.deferred.length, 0);
    assert.equal(result.frame.budget.allocated.tokens, 4000);
});

test("frame omitting ignored keeps the field absent", () => {
    const result = frameFrom(draft({ ignored: [] }), table);
    assert.equal(result.frame.ignored, (void 0));
    assert.equal(result.deferred.length, 0);
});

test("unresolvable slot target is rejected", () => {
    const bad: Slot = { ...slot, target: { kind: "concept", id: "c.missing" } };
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "c.missing"));
});

test("unresolvable ignored target is rejected", () => {
    const bad: Ignored = { ...ignored, target: { kind: "concept", id: "c.missing" } };
    assert.throws(() => frameFrom(draft({ ignored: [bad] }), table), rejects("invalid_frame", "c.missing"));
});

test("empty revisit_if is rejected", () => {
    assert.throws(() => frameFrom(draft({ ignored: [{ ...ignored, revisit_if: "   " }] }), table), rejects("invalid_frame", "revisit_if"));
});

test("more than nine slots is rejected", () => {
    const slots: Slot[] = Array.from({ length: 10 }, () => slot);
    assert.throws(() => frameFrom(draft({ slots }), table), rejects("invalid_frame", "max is 9"));
});

test("exclusions beyond the visible cap are returned, not dropped", () => {
    const many: Ignored[] = Array.from({ length: 60 }, () => ignored);
    const result = frameFrom(draft({ ignored: many }), table);
    assert.equal(result.frame.ignored?.length, 50);
    assert.equal(result.deferred.length, 10);
});

test("unresolvable parent frame is rejected", () => {
    assert.throws(() => frameFrom(draft({ parent: { kind: "frame", id: "f.100" } }), table), rejects("invalid_frame", "f.100"));
});

test("spent budget above allocation is rejected", () => {
    const budget = { allocated: { tokens: 100 }, spent: { tokens: 200 } };
    assert.throws(() => frameFrom(draft({ budget }), table), rejects("invalid_frame", "exceeds"));
});

test("tool argument of the wrong type is rejected", () => {
    const tool = { name: "logs.query", inputSchema: { type: "object", properties: { window: { type: "string" } }, required: ["window"] } };
    assert.throws(() => parseToolCall(tool, { window: 123 }), rejects("invalid_tool_args", "$.window expected string"));
});

test("missing required tool argument is rejected", () => {
    const tool = { name: "logs.query", inputSchema: { type: "object", properties: { window: { type: "string" } }, required: ["window"] } };
    assert.throws(() => parseToolCall(tool, {}), rejects("invalid_tool_args", "$.window is required"));
});

test("extra tool argument is rejected when additionalProperties is false", () => {
    const tool = { name: "logs.query", inputSchema: { type: "object", properties: { window: { type: "string" } }, additionalProperties: false } };
    assert.throws(() => parseToolCall(tool, { window: "post", extra: true }), rejects("invalid_tool_args", "$.extra is not allowed"));
});

test("valid tool arguments are accepted with a stable digest", () => {
    const tool = {
        name: "logs.query",
        inputSchema: {
            type: "object",
            properties: { window: { type: "string" }, limit: { type: "integer", minimum: 1 } },
            required: ["window"],
            additionalProperties: false,
        },
    };
    const first = parseToolCall(tool, { window: "post", limit: 10 });
    const second = parseToolCall(tool, { limit: 10, window: "post" });
    assert.equal(first.digest, second.digest);
    assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
});

test("anyOf accepts a value matching one branch", () => {
    const tool = { name: "t", inputSchema: { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } } };
    assert.equal(parseToolCall(tool, { value: 3 }).tool, "t");
    assert.throws(() => parseToolCall(tool, { value: true }), rejects("invalid_tool_args"));
});

test("enum rejects a value outside the allowed set", () => {
    const tool = { name: "t", inputSchema: { type: "object", properties: { window: { enum: ["post", "pre"] } } } };
    assert.throws(() => parseToolCall(tool, { window: "mid" }), rejects("invalid_tool_args", "allowed values"));
});

test("external references may stay unresolved", () => {
    const external: Slot = { ...slot, target: { kind: "human", id: "u.li" }, role: "other" };
    const result = frameFrom(draft({ slots: [external] }), table);
    assert.equal(result.frame.slots[0]?.target.id, "u.li");
});

test("strict scope rejects an unresolved external reference", () => {
    const strict: RefTable = RefTable.forScope("run", "a.test", []);
    const external: Slot = { ...slot, target: { kind: "human", id: "u.li" }, role: "other" };
    assert.throws(() => frameFrom(draft({ slots: [external] }), strict), rejects("invalid_frame", "human:u.li"));
});

test("tool namespace alias resolves mcp-prefixed ids", () => {
    assert.equal(table.has({ kind: "tool", id: "mcp.logs.query" }), true);
    assert.equal(table.has({ kind: "tool", id: "logs.query" }), true);
});

test("self reference resolves to the registered agent", () => {
    assert.equal(table.has({ kind: "self", id: "a.test" }), true);
});

test("duplicate registration is rejected", () => {
    const registry = RefTable.forScope("run").add("claim", "cl.1", {});
    assert.throws(() => registry.add("claim", "cl.1", {}), rejects("duplicate_ref"));
});

test("identifier outside the AMP grammar is rejected", () => {
    assert.throws(() => RefTable.forScope("run").add("claim", "CL.1", {}), rejects("invalid_id"));
});

/*
 * Regression cover for the construction-boundary fixes. Each group pins one
 * repaired edge so a later change cannot quietly reintroduce the acceptance of
 * an invalid frame, ref or tool call.
 */

test("non-object drafts are rejected, not thrown as TypeError", () => {
    assert.throws(() => frameFrom(null as never, table), rejects("invalid_frame", "draft must be an object"));
    assert.throws(() => frameFrom(undefined as never, table), rejects("invalid_frame", "draft must be an object"));
    assert.throws(() => frameFrom(5 as never, table), rejects("invalid_frame", "draft must be an object"));
});

test("non-finite salience is rejected", () => {
    const bad: Slot = { ...slot, salience: NaN };
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "salience must be in [0,1]"));
});

test("non-finite voi is rejected", () => {
    const bad: Slot = { ...slot, voi: NaN };
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "voi must be in [0,1]"));
});

test("date-only, offset-less and impossible timestamps are rejected", () => {
    const rejected: string[] = ["2026-10-24", "2026-10-24T01:10:00", "2026-02-30T00:00:00Z", "0"];
    for (let index: number = 0; index < rejected.length; index += 1) {
        assert.throws(() => frameFrom(draft({ ts: rejected[index] }), table), rejects("invalid_frame", "ts is not a date-time"));
    }
});

test("a non-string timestamp is rejected", () => {
    assert.throws(() => frameFrom(draft({ ts: null as never }), table), rejects("invalid_frame", "ts is not a date-time"));
});

test("fractional-second, leap-second and offset timestamps are accepted", () => {
    const accepted: string[] = ["2026-10-24T01:10:00.000Z", "2016-12-31T23:59:60Z", "2026-10-24T01:10:00+08:00"];
    for (let index: number = 0; index < accepted.length; index += 1) {
        assert.equal(frameFrom(draft({ ts: accepted[index] }), table).frame.ts, accepted[index]);
    }
});

test("unknown slot fields are rejected", () => {
    const bad: Slot = { ...slot, extra: true } as unknown as Slot;
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "unknown property"));
});

test("unknown ignored fields are rejected", () => {
    const bad: Ignored = { ...ignored, extra: true } as unknown as Ignored;
    assert.throws(() => frameFrom(draft({ ignored: [bad] }), table), rejects("invalid_frame", "unknown property"));
});

test("unknown impasse fields are rejected", () => {
    const bad: Impasse = { state: "TIE", extra: true } as unknown as Impasse;
    assert.throws(() => frameFrom(draft({ impasse: bad }), table), rejects("invalid_frame", "unknown property"));
});

test("unknown target fields are rejected", () => {
    const bad: Slot = { ...slot, target: { kind: "tool", id: "logs.query", extra: 1 } as never };
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "unknown property"));
});

test("a non-string target label is rejected", () => {
    const bad: Slot = { ...slot, target: { kind: "tool", id: "logs.query", label: 42 } as never };
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "label must be a string"));
});

test("registering an unknown ref kind is rejected before it is stored", () => {
    assert.throws(() => RefTable.forScope("run").add("bogus" as never, "x", {}), rejects("invalid_ref"));
});

test("a target kind outside the runtime ref kinds is rejected", () => {
    const bad: Slot = { ...slot, target: { kind: "bogus" as never, id: "x" } };
    assert.throws(() => frameFrom(draft({ slots: [bad] }), table), rejects("invalid_frame", "not a ref kind"));
});

test("a constructed frame and its nested objects are frozen", () => {
    const result = frameFrom(draft(), table);
    assert.equal(Object.isFrozen(result.frame), true);
    assert.equal(Object.isFrozen(result.frame.slots[0]), true);
    assert.equal(Object.isFrozen(result.frame.budget), true);
});

test("mutating the draft after construction changes neither frame nor digest", () => {
    const mutableSlot: Slot = { ...slot };
    const source: FrameDraft = draft({ slots: [mutableSlot] });
    const result = frameFrom(source, table);
    const digest: string = result.frame.digest;
    const body: Record<string, unknown> = { ...result.frame };
    delete body.digest;
    assert.equal(digestOf(body), digest);
    mutableSlot.salience = 0.2;
    assert.equal(result.frame.slots[0]?.salience, 0.7);
    assert.equal(result.frame.digest, digest);
    assert.equal(digestOf(body), result.frame.digest);
});

test("maxIgnored above the default cap is rejected", () => {
    assert.throws(() => frameFrom(draft(), table, { maxIgnored: 51 }), rejects("invalid_frame", "maxIgnored must be an integer"));
});

test("deferred exclusions are frozen copies that are detached from the draft", () => {
    const many: Ignored[] = Array.from({ length: 60 }, () => ({ ...ignored }));
    const result = frameFrom(draft({ ignored: many }), table, { maxIgnored: 50 });
    assert.equal(result.frame.ignored?.length, 50);
    assert.equal(result.deferred.length, 10);
    assert.notEqual(result.deferred[0], many[50]);
    assert.deepEqual(result.deferred[0], many[50]);
    assert.equal(Object.isFrozen(result.deferred[0]), true);
});

test("spent budget may not use an unallocated dimension", () => {
    const budget = { allocated: { tokens: 100 }, spent: { ms: 10 } };
    assert.throws(() => frameFrom(draft({ budget }), table), rejects("invalid_frame", "budget.spent.ms is not declared in budget.allocated"));
});

test("spent above allocation is rejected on any dimension", () => {
    const budget = { allocated: { ms: 100 }, spent: { ms: 200 } };
    assert.throws(() => frameFrom(draft({ budget }), table), rejects("invalid_frame", "budget.spent.ms exceeds"));
});

test("an allocated budget with no dimension is rejected", () => {
    const budget = { allocated: {}, spent: {} };
    assert.throws(() => frameFrom(draft({ budget }), table), rejects("invalid_frame", "must set at least one dimension"));
});

test("top-level fields outside the frame schema are rejected", () => {
    const polluted = { ...draft(), amp: "0.1", kind: "frame", extra: true } as unknown as FrameDraft;
    assert.throws(() => frameFrom(polluted, table), rejects("invalid_frame", "unknown property"));
});

test("tool and capability names share one namespace", () => {
    const registry = RefTable.forScope("run").add("tool", "x", { marker: 1 });
    assert.throws(() => registry.add("capability", "x", {}), rejects("duplicate_ref"));
    assert.equal(registry.has({ kind: "tool", id: "x" }), true);
    assert.equal(registry.has({ kind: "capability", id: "x" }), true);
});

test("the mcp prefix is stripped once before the namespace comparison", () => {
    const registered: { marker: number } = { marker: 1 };
    const registry = RefTable.forScope("run").add("capability", "x", registered);
    assert.throws(() => registry.add("tool", "mcp.x", {}), rejects("duplicate_ref"));
    assert.equal(registry.resolve({ kind: "tool", id: "x" }), registered);
    assert.equal(registry.resolve({ kind: "capability", id: "mcp.x" }), registered);
});

test("an agent id outside the AMP grammar is rejected with invalid_id", () => {
    assert.throws(() => RefTable.forScope("run", "A.BAD"), rejects("invalid_id"));
});

test("a scope outside the runtime set is rejected", () => {
    assert.throws(() => RefTable.forScope("bogus" as never), rejects("invalid_ref"));
});

test("an opaque kind outside the runtime set is rejected", () => {
    assert.throws(() => RefTable.forScope("run", "a.test", ["bogus" as never]), rejects("invalid_ref"));
});

test("registering an undefined value is rejected", () => {
    assert.throws(() => RefTable.forScope("run").add("claim", "cl.1", void 0), rejects("invalid_ref"));
});

test("a tool id that is empty after the mcp strip is rejected", () => {
    assert.throws(() => RefTable.forScope("run").add("tool", "mcp.", {}), rejects("invalid_id"));
});

test("resolve returns undefined for a non-ref instead of throwing", () => {
    assert.equal(table.resolve(null as never), void 0);
});

test("require rejects a non-ref with invalid_ref", () => {
    assert.throws(() => table.require(42 as never), rejects("invalid_ref"));
});

test("check reports an id outside the grammar as a problem string", () => {
    const problem: string | undefined = table.check({ kind: "human", id: "BAD ID" });
    assert.equal(typeof(problem), "string");
    assert.match(problem as string, /not a valid AMP id/);
});

test("check accepts an opaque kind on shape alone", () => {
    assert.equal(table.check({ kind: "human", id: "u.li" }), void 0);
});

test("an own __proto__ argument is not an allowed property", () => {
    const tool = { name: "logs.query", inputSchema: { type: "object", properties: { window: { type: "string" } }, additionalProperties: false } };
    const raw: unknown = JSON.parse('{"window":"post","__proto__":{"x":1}}');
    assert.throws(() => parseToolCall(tool, raw), rejects("invalid_tool_args", "__proto__ is not allowed"));
});

test("prototype names do not satisfy required arguments", () => {
    const tool = { name: "t", inputSchema: { type: "object", required: ["toString"] } };
    assert.throws(() => parseToolCall(tool, {}), rejects("invalid_tool_args", "$.toString is required"));
});

test("non-JSON argument values are rejected by the boundary", () => {
    const tool = { name: "t", inputSchema: { type: "object" } };
    const bad: unknown[] = [void 0, NaN, (): number => 1, new Date(0), BigInt(10), Symbol("s")];
    for (let index: number = 0; index < bad.length; index += 1) {
        assert.throws(() => parseToolCall(tool, { value: bad[index] }), rejects("invalid_tool_args"));
    }
    assert.throws(() => parseToolCall(tool, { value: [1, , 3] }), rejects("invalid_tool_args"));
});

test("accepted arguments are a frozen copy detached from the raw object", () => {
    const tool = { name: "t", inputSchema: { type: "object", properties: { window: { type: "string" }, inner: { type: "object" } } } };
    const raw: Record<string, unknown> = { window: "post", inner: { limit: 5 } };
    const parsed = parseToolCall(tool, raw);
    assert.notEqual(parsed.args, raw);
    assert.notEqual(parsed.args.inner, raw.inner);
    assert.equal(Object.isFrozen(parsed.args), true);
    assert.equal(Object.isFrozen(parsed.args.inner), true);
    const digest: string = parsed.digest;
    raw.window = "pre";
    (raw.inner as { limit: number }).limit = 9;
    assert.equal(parsed.args.window, "post");
    assert.equal((parsed.args.inner as { limit: number }).limit, 5);
    assert.equal(parsed.digest, digest);
});

test("unknown and malformed type keywords are rejected", () => {
    assert.throws(
        () => parseToolCall({ name: "t", inputSchema: { type: "object", properties: { value: { type: "strng" } } } }, { value: "x" }),
        rejects("invalid_tool_args", "unknown type"),
    );
    assert.throws(
        () => parseToolCall({ name: "t", inputSchema: { type: "object", properties: { value: { type: [] } } } }, { value: "x" }),
        rejects("invalid_tool_args", "must not be an empty array"),
    );
    assert.throws(
        () => parseToolCall({ name: "t", inputSchema: { type: "object", properties: { value: { type: [123] } } } }, { value: "x" }),
        rejects("invalid_tool_args", "must be a string"),
    );
});

test("boolean schemas accept and reject every value", () => {
    assert.equal(parseToolCall({ name: "t", inputSchema: true }, { any: 1 }).tool, "t");
    assert.throws(() => parseToolCall({ name: "t", inputSchema: false }, { any: 1 }), rejects("invalid_tool_args", "does not accept any value"));
});

test("local $ref definitions are resolved and enforced", () => {
    const tool = {
        name: "t",
        inputSchema: {
            $defs: { name: { type: "string", minLength: 2 } },
            type: "object",
            properties: { who: { $ref: "#/$defs/name" } },
            required: ["who"],
        },
    };
    assert.equal(parseToolCall(tool, { who: "ann" }).tool, "t");
    assert.throws(() => parseToolCall(tool, { who: 3 }), rejects("invalid_tool_args", "$.who expected string"));
});

test("exclusive bounds and multiples of a number are enforced", () => {
    const exclusive = { name: "t", inputSchema: { type: "object", properties: { n: { type: "number", exclusiveMinimum: 1 } } } };
    assert.equal(parseToolCall(exclusive, { n: 2 }).tool, "t");
    assert.throws(() => parseToolCall(exclusive, { n: 1 }), rejects("invalid_tool_args", "must be greater than 1"));
    const multiple = { name: "t", inputSchema: { type: "object", properties: { n: { type: "number", multipleOf: 2 } } } };
    assert.equal(parseToolCall(multiple, { n: 4 }).tool, "t");
    assert.throws(() => parseToolCall(multiple, { n: 3 }), rejects("invalid_tool_args", "is not a multiple of 2"));
});

test("string length counts code points, not UTF-16 units", () => {
    const tool = { name: "t", inputSchema: { type: "object", properties: { glyph: { type: "string", maxLength: 1 } } } };
    assert.equal(parseToolCall(tool, { glyph: "😀" }).tool, "t");
    assert.throws(() => parseToolCall(tool, { glyph: "😀😀" }), rejects("invalid_tool_args", "longer than 1"));
});

test("a schema-valued additionalProperties validates extra members", () => {
    const tool = { name: "t", inputSchema: { type: "object", properties: { window: { type: "string" } }, additionalProperties: { type: "number" } } };
    assert.equal(parseToolCall(tool, { window: "post", limit: 5 }).tool, "t");
    assert.throws(() => parseToolCall(tool, { window: "post", limit: "5" }), rejects("invalid_tool_args", "$.limit expected number"));
});

test("tuple items with additionalItems false reject extra elements", () => {
    const tool = {
        name: "t",
        inputSchema: { type: "object", properties: { pair: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false } } },
    };
    assert.equal(parseToolCall(tool, { pair: ["a", 1] }).tool, "t");
    assert.throws(() => parseToolCall(tool, { pair: ["a", 1, 2] }), rejects("invalid_tool_args", "allows at most 2 items"));
});

test("a null tool and array arguments are rejected", () => {
    assert.throws(() => parseToolCall(null as never, {}), rejects("invalid_tool_args", "tool must be an object"));
    assert.throws(() => parseToolCall({ name: "t", inputSchema: true }, []), rejects("invalid_tool_args", "arguments must be an object"));
});

test("canonical rejects values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 3;
    sparse[0] = 1;
    sparse[2] = 3;
    const bad: unknown[] = [void 0, NaN, Infinity, (): number => 1, Symbol("s"), BigInt(10), new Date(0), sparse, cyclic, { a: void 0 }];
    for (let index: number = 0; index < bad.length; index += 1) {
        assert.throws(() => canonical(bad[index]), TypeError);
    }
});

test("digest ignores object key order", () => {
    assert.equal(digestOf({ b: 1, a: 2 }), digestOf({ a: 2, b: 1 }));
});

test("sha256Hex matches the known vector and rejects non-strings", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.throws(() => sha256Hex(123 as never), TypeError);
});

test("revoked proxies fail closed with BoundaryRejection", () => {
    const revoked = (): object => {
        const pair = Proxy.revocable({}, {});
        pair.revoke();
        return pair.proxy;
    };
    assert.throws(() => frameFrom(revoked() as never, table), rejects("invalid_frame", "could not be inspected"));
    assert.throws(() => parseToolCall({ name: "t", inputSchema: true }, revoked()), rejects("invalid_tool_args", "could not be inspected"));
    assert.throws(() => table.require(revoked() as never), rejects("invalid_ref", "could not be inspected"));
    assert.equal(table.resolve(revoked() as never), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exitCode = 1;
}
