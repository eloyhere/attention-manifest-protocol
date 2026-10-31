#!/usr/bin/env node
/**
 * Action-policy checks: normative tier floors, claim gating, host-controlled
 * approvals, one-time consumption, expiry, digest binding and TTL clamping.
 *
 * The clock is injected everywhere, so there is no real sleeping and every
 * expiry case is deterministic.
 */
import assert from "node:assert/strict";

import { DefaultApprovalEffects, EffectClasses, PolicyEngine } from "../src/policy/policy.ts";
import type { ActionRequest, Approval, ApproveInput, EffectClass, PolicyOptions, PolicyVerdict } from "../src/policy/policy.ts";
import type { Tier } from "../src/types/common.ts";
import type { Claim } from "../src/warrant/epistemic.ts";

type TestCase = () => void | Promise<void>;

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: TestCase) => Promise<void> = async (name: string, fn: TestCase): Promise<void> => {
    try {
        await fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

interface Clock {
    now: () => string;
    advance: (ms: number) => void;
}

const clock: (start?: string) => Clock = (start: string = "2026-10-24T01:00:00Z"): Clock => {
    let current: number = Date.parse(start);
    return {
        now: () => new Date(current).toISOString(),
        advance: (ms) => {
            current += ms;
        },
    };
};

type ClockSource = () => string;
type EngineOptions = Omit<PolicyOptions, "now">;
type EngineFactory = (now: ClockSource, options?: EngineOptions) => PolicyEngine;

const makeEngine: EngineFactory = (now: ClockSource, options: EngineOptions = {}): PolicyEngine => {
    return new PolicyEngine({ now, ...options });
};

const heldClaim: (overrides?: Partial<Claim>) => Claim = (overrides: Partial<Claim> = {}): Claim => {
    return {
        amp: "0.1",
        kind: "claim",
        id: "cl.policy.test",
        statement: "policy-check claim",
        tier: "T2",
        confidence: 0.9,
        status: "held",
        warrant: { evidence: [], inference: "deduction", strength: 0.9 },
        provenance: { source: "policy-check", trust: "self" },
        created: "2026-10-24T00:00:00Z",
        ...overrides,
    };
};

type RequestOverrides = Partial<ActionRequest>;
type RequestFactory = (effect: EffectClass, overrides?: RequestOverrides) => ActionRequest;

const request: RequestFactory = (effect: EffectClass, overrides: RequestOverrides = {}): ActionRequest => {
    return {
        action: "deploy.rollback",
        effect,
        claim: heldClaim({ tier: "T3" }),
        ...overrides,
    };
};

const ToolA: string = "sha256:tool-a";
const ArgsA: string = "sha256:args-a";
const ToolB: string = "sha256:tool-b";
const ArgsB: string = "sha256:args-b";

const deployRequest: (overrides?: RequestOverrides) => ActionRequest = (overrides: RequestOverrides = {}): ActionRequest => {
    return request("deploy", {
        action: "deploy.rollback",
        toolDigest: ToolA,
        argsDigest: ArgsA,
        ...overrides,
    });
};

const irreversibleRequest: (overrides?: RequestOverrides) => ActionRequest = (overrides: RequestOverrides = {}): ActionRequest => {
    return request("write-irreversible", {
        action: "db.migrate",
        claim: heldClaim({ tier: "T2" }),
        toolDigest: ToolA,
        argsDigest: ArgsA,
        ...overrides,
    });
};

type IssueApproval = (engine: PolicyEngine, overrides?: Partial<ApproveInput>) => Approval;

const issue: IssueApproval = (engine: PolicyEngine, overrides: Partial<ApproveInput> = {}): Approval => {
    return engine.approve({
        action: "deploy.rollback",
        effect: "deploy",
        approvedBy: "host.ops",
        toolDigest: ToolA,
        argsDigest: ArgsA,
        ...overrides,
    });
};

await test("minTierFor maps every effect to the normative floor", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const expected: Record<EffectClass, Tier> = {
        read: "T0",
        "write-reversible": "T1",
        "write-irreversible": "T2",
        spend: "T2",
        send: "T2",
        delete: "T3",
        deploy: "T3",
        permission: "T3",
        publish: "T3",
    };
    assert.deepEqual([...EffectClasses].sort(), Object.keys(expected).sort());
    const effects: EffectClass[] = [...EffectClasses];
    for (let index: number = 0; index < effects.length; index += 1) {
        const effect: EffectClass = effects[index];
        assert.equal(engine.minTierFor(effect), expected[effect]);
    }
});

await test("default approval effects cover every externally visible risk", () => {
    assert.deepEqual([...DefaultApprovalEffects].sort(), ["delete", "deploy", "permission", "publish", "send", "spend", "write-irreversible"]);
    assert.equal(DefaultApprovalEffects.has("read"), false);
    assert.equal(DefaultApprovalEffects.has("write-reversible"), false);
});

await test("read is allowed without a claim by default", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(request("read", { action: "logs.read", claim: undefined }));
    assert.equal(verdict.outcome, "allow");
    assert.equal(verdict.reason, "read_without_claim");
    assert.equal(verdict.minTier, "T0");
});

await test("allowReadWithoutClaim:false makes reads need a claim", () => {
    const engine: PolicyEngine = makeEngine(clock().now, { allowReadWithoutClaim: false });
    const verdict: PolicyVerdict = engine.decide(request("read", { action: "logs.read", claim: undefined }));
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "missing_claim");
});

await test("a T0 claim cannot authorize an irreversible write", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(
        request("write-irreversible", {
            action: "db.migrate",
            claim: heldClaim({ tier: "T0" }),
        }),
    );
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "tier_below_minimum:T2");
    assert.equal(verdict.minTier, "T2");
});

await test("a held T1 claim authorizes a reversible write", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(
        request("write-reversible", {
            action: "file.write",
            claim: heldClaim({ tier: "T1" }),
        }),
    );
    assert.equal(verdict.outcome, "allow");
    assert.equal(verdict.reason, "allowed");
    assert.equal(verdict.minTier, "T1");
});

await test("a T1 claim cannot authorize an irreversible write", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(
        request("write-irreversible", {
            action: "db.migrate",
            claim: heldClaim({ tier: "T1" }),
        }),
    );
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "tier_below_minimum:T2");
});

await test("a missing claim denies a non-read effect", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(request("delete", { action: "repo.delete", claim: undefined }));
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "missing_claim");
    assert.equal(verdict.minTier, "T3");
});

await test("a contested claim cannot authorize an effect", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(
        request("delete", {
            action: "repo.delete",
            claim: heldClaim({ tier: "T3", status: "contested" }),
        }),
    );
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "claim_not_held");
});

await test("a low-confidence claim cannot authorize an effect", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(
        request("deploy", {
            action: "deploy.rollback",
            claim: heldClaim({ tier: "T3", confidence: 0.2 }),
        }),
    );
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "claim_low_confidence");
});

await test("request.minTier cannot lower the host floor", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(
        request("delete", {
            action: "repo.delete",
            claim: heldClaim({ tier: "T2" }),
            minTier: "T0",
        }),
    );
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "tier_below_minimum:T3");
    assert.equal(verdict.minTier, "T3");
});

await test("T2 irreversible with a held claim returns approval_required", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(irreversibleRequest());
    assert.equal(verdict.outcome, "approval_required");
    assert.equal(verdict.reason, "approval_required");
    assert.equal(verdict.minTier, "T2");
    assert.equal(verdict.approvalId, undefined);
});

await test("a host-issued approval authorizes the exact request", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    const verdict: PolicyVerdict = engine.decide(irreversibleRequest(), approval);
    assert.equal(verdict.outcome, "allow");
    assert.equal(verdict.reason, "approved");
    assert.equal(verdict.minTier, "T2");
    assert.equal(verdict.approvalId, approval.id);
});

await test("decide consumes an approval exactly once", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    assert.equal(engine.decide(irreversibleRequest(), approval).outcome, "allow");
    const replay: PolicyVerdict = engine.decide(irreversibleRequest(), approval);
    assert.equal(replay.outcome, "deny");
    assert.equal(replay.reason, "approval_consumed");
    assert.equal(replay.approvalId, approval.id);
});

await test("explicit consume redeems once and blocks later reuse", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    const first: PolicyVerdict = engine.consume(approval.id, irreversibleRequest());
    assert.equal(first.outcome, "allow");
    assert.equal(first.reason, "approved");
    const second: PolicyVerdict = engine.consume(approval.id, irreversibleRequest());
    assert.equal(second.outcome, "deny");
    assert.equal(second.reason, "approval_consumed");
});

await test("checkApproval validates without consuming", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    const checked: PolicyVerdict = engine.checkApproval(approval, irreversibleRequest());
    assert.equal(checked.outcome, "allow");
    assert.equal(checked.reason, "approval_valid");
    assert.equal(checked.approvalId, approval.id);
    assert.equal(engine.decide(irreversibleRequest(), approval).outcome, "allow");
    const afterUse: PolicyVerdict = engine.checkApproval(approval, irreversibleRequest());
    assert.equal(afterUse.outcome, "deny");
    assert.equal(afterUse.reason, "approval_consumed");
});

await test("an expired approval is denied", () => {
    const time: Clock = clock();
    const engine: PolicyEngine = makeEngine(time.now, { defaultTtlMs: 1_000, maxTtlMs: 10_000 });
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    time.advance(1_000);
    const verdict: PolicyVerdict = engine.decide(irreversibleRequest(), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_expired");
    assert.equal(verdict.approvalId, approval.id);
});

await test("checkApproval accepts an injected time and denies at expiry", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    const at: string = new Date(Date.parse(approval.expires)).toISOString();
    const verdict: PolicyVerdict = engine.checkApproval(approval, irreversibleRequest(), at);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_expired");
});

await test("approval TTL is clamped to maxTtlMs", () => {
    const time: Clock = clock();
    const engine: PolicyEngine = makeEngine(time.now, { defaultTtlMs: 1_500, maxTtlMs: 2_000 });
    const long: Approval = issue(engine, { ttlMs: 60_000 });
    assert.equal(Date.parse(long.expires) - Date.parse(long.issued), 2_000);
    const byDefault: Approval = issue(engine);
    assert.equal(Date.parse(byDefault.expires) - Date.parse(byDefault.issued), 1_500);

    const tight: PolicyEngine = makeEngine(time.now, { defaultTtlMs: 9_000, maxTtlMs: 1_000 });
    const clampedDefault: Approval = issue(tight);
    assert.equal(Date.parse(clampedDefault.expires) - Date.parse(clampedDefault.issued), 1_000);
    assert.throws(() => tight.approve({ action: "deploy.rollback", effect: "deploy", approvedBy: "host", ttlMs: 0 }), RangeError);
});

await test("a wrong action is denied", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    const verdict: PolicyVerdict = engine.decide(deployRequest({ action: "deploy.promote" }), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_action_mismatch");
});

await test("a wrong effect is denied", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    const verdict: PolicyVerdict = engine.decide(deployRequest({ effect: "permission" }), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_effect_mismatch");
});

await test("a wrong tool digest is denied", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    const verdict: PolicyVerdict = engine.decide(deployRequest({ toolDigest: ToolB }), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_digest_mismatch");
});

await test("a wrong args digest is denied", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    const verdict: PolicyVerdict = engine.decide(deployRequest({ argsDigest: ArgsB }), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_digest_mismatch");
});

await test("a missing request digest cannot satisfy a bound approval", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    const verdict: PolicyVerdict = engine.decide(deployRequest({ toolDigest: undefined }), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_digest_mismatch");
});

await test("failed validation does not burn an approval", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    assert.equal(engine.decide(deployRequest({ argsDigest: ArgsB }), approval).outcome, "deny");
    const retry: PolicyVerdict = engine.decide(deployRequest(), approval);
    assert.equal(retry.outcome, "allow");
    assert.equal(retry.reason, "approved");
});

await test("a revoked approval is denied", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine);
    assert.equal(engine.revoke(approval.id), true);
    assert.equal(engine.revoke(approval.id), true);
    assert.equal(engine.revoke("apr.missing"), false);
    const verdict: PolicyVerdict = engine.decide(deployRequest(), approval);
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_revoked");
});

await test("an unknown approval id is denied", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const verdict: PolicyVerdict = engine.decide(deployRequest(), "apr.unknown");
    assert.equal(verdict.outcome, "deny");
    assert.equal(verdict.reason, "approval_unknown");
});

await test("approve requires a non-empty action, effect and approver", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    assert.throws(() => engine.approve({ action: "spend.money", effect: "spend", approvedBy: "   " }), TypeError);
    assert.throws(() => engine.approve({ action: "", effect: "spend", approvedBy: "host" }), TypeError);
    assert.throws(
        () =>
            engine.approve({
                action: "spend.money",
                effect: "not-an-effect" as EffectClass,
                approvedBy: "host",
            }),
        TypeError,
    );

    /**
     * approvedBy is recorded, not implicitly trusted: the host decides trust.
     */
    const untrusted: Approval = engine.approve({
        action: "spend.money",
        effect: "spend",
        approvedBy: "agent.other",
    });
    assert.equal(untrusted.approvedBy, "agent.other");
});

await test("approval ids and nonces are random, unique and non-trivial", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const first: Approval = issue(engine, { approvedBy: "host.one" });
    const second: Approval = issue(engine, { approvedBy: "host.two" });
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.nonce, second.nonce);
    assert.match(first.id, /^apr\.[0-9a-f]{32}$/);
    assert.match(first.nonce, /^[0-9a-f]{48}$/);
    assert.notEqual(first.nonce, first.id);
});

await test("list returns copies, not mutable internals", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const first: Approval = issue(engine);
    const second: Approval = issue(engine);
    const listed: Approval[] = engine.list();
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((entry) => entry.id).sort(), [first.id, second.id].sort());
    listed[0].action = "tampered";
    listed[0].scope.push("tampered");
    assert.equal(engine.list()[0].action, "deploy.rollback");
    assert.deepEqual(engine.list()[0].scope, ["deploy.rollback"]);
});

await test("custom approvalEffects can require approval for reads", () => {
    const engine: PolicyEngine = makeEngine(clock().now, {
        approvalEffects: new Set<EffectClass>(["read"]),
    });
    const readRequest: ActionRequest = request("read", { action: "logs.read", claim: undefined });
    const required: PolicyVerdict = engine.decide(readRequest);
    assert.equal(required.outcome, "approval_required");
    assert.equal(required.minTier, "T0");

    const approval: Approval = engine.approve({
        action: "logs.read",
        effect: "read",
        approvedBy: "host.read",
    });
    const allowed: PolicyVerdict = engine.decide(readRequest, approval);
    assert.equal(allowed.outcome, "allow");
    assert.equal(allowed.reason, "approved");
});

await test("publish can be raised to T4 for cross-task reuse", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const denied: PolicyVerdict = engine.decide(
        request("publish", {
            action: "report.publish",
            claim: heldClaim({ tier: "T3" }),
            minTier: "T4",
        }),
    );
    assert.equal(denied.outcome, "deny");
    assert.equal(denied.reason, "tier_below_minimum:T4");
    assert.equal(denied.minTier, "T4");

    const approval: Approval = issue(engine, {
        action: "report.publish",
        effect: "publish",
        toolDigest: undefined,
        argsDigest: undefined,
    });
    const allowed: PolicyVerdict = engine.decide(
        request("publish", {
            action: "report.publish",
            claim: heldClaim({ tier: "T4" }),
            minTier: "T4",
        }),
        approval,
    );
    assert.equal(allowed.outcome, "allow");
    assert.equal(allowed.reason, "approved");
});

await test("a valid approval cannot override a missing claim", () => {
    const engine: PolicyEngine = makeEngine(clock().now);
    const approval: Approval = issue(engine, { action: "db.migrate", effect: "write-irreversible" });
    const denied: PolicyVerdict = engine.decide(irreversibleRequest({ claim: undefined }), approval);
    assert.equal(denied.outcome, "deny");
    assert.equal(denied.reason, "missing_claim");

    const allowed: PolicyVerdict = engine.decide(irreversibleRequest(), approval);
    assert.equal(allowed.outcome, "allow");
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
