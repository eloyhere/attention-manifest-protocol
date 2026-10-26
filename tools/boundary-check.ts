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
import type { Ignored, Slot } from "../src/frame/frame.ts";

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

const rejects = (code: string, fragment?: string) => (error: unknown): boolean => {
    if (!(error instanceof BoundaryRejection) || error.code !== code) return false;
    if (fragment === (void 0)) return true;
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
    assert.equal(result.frame.ignored, void 0);
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
        inputSchema: { type: "object", properties: { window: { type: "string" }, limit: { type: "integer", minimum: 1 } }, required: ["window"], additionalProperties: false },
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
