import assert from "node:assert/strict";
import test from "node:test";
import { AgentGateway, GatewayError } from "./gateway.ts";
import { SURFACE_PREFIX, createAgentSurface } from "./surface.ts";
import type { GatewayCallRecord } from "./gateway.ts";

const binding = { tenantId: "t", principalId: "p", sessionId: "s", policyVersion: "v1", cancellationEpoch: 0 } as const;
const readName = `${SURFACE_PREFIX}_workspace.read`;
const writeName = `${SURFACE_PREFIX}_workspace.write`;
const budgetName = `${SURFACE_PREFIX}_budget.remaining`;

function setup(options: Record<string, unknown> = {}) {
    const calls: GatewayCallRecord[] = [];
    const gateway = new AgentGateway({
        handlers: {
            [readName]: (_parameters, context) => `${context.tool.verb}:content`,
            [writeName]: parameters => ({ written: parameters.expectedHash }),
            [budgetName]: () => 42,
        },
        onCall: record => calls.push(record),
        ...options,
    });
    return { gateway, calls };
}

function failure(code: GatewayError["code"]) {
    return (error: unknown): boolean => error instanceof GatewayError && error.code === code;
}

test("a read tool dispatches with the bound context and journals once", () => {
    const { gateway, calls } = setup();
    const result = gateway.call(readName, { path: "src/a.ts" }, { binding });
    assert.equal(result, "read:content");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, readName);
    assert.equal(calls[0]?.mutating, false);
    assert.equal(calls[0]?.ok, true);
    assert.equal(typeof calls[0]?.durationMs, "number");
    assert.equal(Object.isFrozen(calls[0]), true);
});

test("unknown and filtered tools are rejected", () => {
    const { gateway } = setup();
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workflow.transition`, {}, { binding }), failure("unknown_tool"));

    const restricted = setup({ surface: createAgentSurface({ only: ["workspace"] }) }).gateway;
    assert.throws(() => restricted.call(budgetName, {}, { binding }), failure("not_exposed"));
});

test("model arguments cannot carry host context", () => {
    const { gateway, calls } = setup();
    assert.throws(() => gateway.call(readName, { tenantId: "evil" }, { binding }), failure("invalid_parameters"));
    assert.throws(() => gateway.call(readName, { nested: { fence: 3 } }, { binding }), failure("invalid_parameters"));
    assert.equal(calls.at(-1)?.ok, false);
    assert.equal(calls.at(-1)?.error, "invalid_parameters");
});

test("mutating tools require an idempotency key", () => {
    const { gateway, calls } = setup();
    assert.throws(() => gateway.call(writeName, { expectedHash: "h" }, { binding }), failure("mutating_requires_idempotency_key"));
    const result = gateway.call(writeName, { expectedHash: "h" }, { binding, idempotencyKey: "op-1" });
    assert.deepEqual(result, { written: "h" });
    assert.equal(calls.at(-1)?.idempotencyKey, "op-1");
    assert.equal(calls.at(-1)?.mutating, true);
});

test("the host authorization hook can deny authorities", () => {
    const deny = setup({ authorize: () => false }).gateway;
    assert.throws(() => deny.call(readName, {}, { binding }), failure("unauthorized"));

    const seen: string[][] = [];
    const allow = setup({ authorize: (authority: readonly string[]) => { seen.push([...authority]); return true; } }).gateway;
    assert.equal(allow.call(readName, {}, { binding }), "read:content");
    assert.deepEqual(seen, [["workspace:read"]]);
});

test("missing handlers and handler exceptions map to typed gateway errors", () => {
    const { gateway, calls } = setup({ handlers: { [readName]: () => { throw new Error("boom"); } } });
    assert.throws(() => gateway.call(`${SURFACE_PREFIX}_workspace.outline`, {}, { binding }), failure("handler_missing"));
    assert.throws(() => gateway.call(readName, {}, { binding }), failure("handler_failed"));
    assert.equal(calls.at(-1)?.error, "handler_failed");
});

test("an invalid binding never reaches a handler", () => {
    const { gateway, calls } = setup();
    assert.throws(() => gateway.call(readName, {}, { binding: { ...binding, sessionId: "" } }), failure("binding_invalid"));
    assert.throws(() => gateway.call(readName, {}, { binding: { ...binding, cancellationEpoch: -1 } }), failure("binding_invalid"));
    assert.equal(calls.length, 2);
    assert.equal(calls.every(record => record.error === "binding_invalid"), true);
});

test("the gateway exposes exactly the surface tools", () => {
    const { gateway } = setup();
    assert.ok(gateway.tools.length > 30);
    assert.equal(gateway.tools.every(tool => tool.name.startsWith(`${SURFACE_PREFIX}_`)), true);
});
