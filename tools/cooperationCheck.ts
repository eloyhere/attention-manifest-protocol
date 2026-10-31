#!/usr/bin/env node
/**
 * Cooperation and switching checks (spec sections 12 and 13).
 *
 * The tests cover the two flows that turn the governance objects into an
 * actual protocol: a structured multi-agent message bus with credential
 * validation at the boundary, and the peer / downgrade / mode / scenario /
 * escalation transitions of one agent.
 */
import assert from "node:assert/strict";

import type { AgentMessage, ApprovalGrant, AttentionManifest, AttentionManifestDraft, SignerInput } from "../src/governance/index.ts";
import {
    CooperationBus,
    GovernanceKeyring,
    HttpCooperationTransport,
    LoopbackTransport,
    createCooperationHandler,
    generateGovernanceSigners,
    GovernanceError,
    constraintsFor,
    createAttentionManifest,
    issueCredential,
    manifestSummaryOf,
    planDowngrade,
    planEscalation,
    planPeerSwitch,
    switchMode,
    switchScenario,
    verifyAgentMessage,
} from "../src/governance/index.ts";

const At: string = "2026-10-28T00:00:00.000Z";
const At2: string = "2026-10-28T00:05:00.000Z";
const AtLate: string = "2026-10-28T00:20:00.000Z";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const signers: readonly SignerInput[] = [
    { role: "issuer", by: "general-manager", at: At },
    { role: "legal", by: "legal", at: At },
    { role: "finance", by: "finance", at: At },
];

const grant: (id: string, subject: ApprovalGrant["subject"], by: ApprovalGrant["by"], at?: string) => ApprovalGrant = (
    id: string,
    subject: ApprovalGrant["subject"],
    by: ApprovalGrant["by"],
    at: string = At,
): ApprovalGrant => ({ id, subject, by, at, granted: true });

const draft: (perspective: AttentionManifestDraft["perspective"], scenario: AttentionManifestDraft["scenario"], tags: string[]) => AttentionManifestDraft = (
    perspective: AttentionManifestDraft["perspective"],
    scenario: AttentionManifestDraft["scenario"],
    tags: string[],
): AttentionManifestDraft => ({
    id: `mft.${tags[0]}`,
    perspective,
    scenario,
    focus: tags.map((tag: string, index: number) => ({ target: { kind: "goal" as const, id: `goal.${tag}` }, category: "goal" as const, priority: 1 - index * 0.1, depth: 2 as const })),
    budget: { scope: "agent", agent: `agt.${tags[0]}`, cap: { tokens: 1000 }, elasticity: "high" },
    constraints: constraintsFor(scenario),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
    ttlMs: 60 * 60 * 1000,
});

const technology: AttentionManifest = createAttentionManifest(draft("technology", "engineering", ["tech"]), signers);
const marketing: AttentionManifest = createAttentionManifest(draft("marketing", "office", ["mkt"]), signers);
const supervisory: AttentionManifest = createAttentionManifest(draft("supervisory", "research", ["sup"]), signers);

const credential = issueCredential(
    {
        from: "general-manager",
        to: "marketing",
        reason: "hand the launch review to marketing",
        visibleScope: [{ kind: "goal", id: "goal.mkt" }],
        payloadRefs: [{ kind: "goal", id: "goal.mkt" }],
        budget: { quota: { tokens: 400 }, elasticity: "medium" },
        constraints: constraintsFor("office"),
        manifest: { id: marketing.id, version: marketing.version },
        scenario: "office",
        issuedAt: At,
        ttlMs: 10 * 60 * 1000,
    },
    signers,
);

test("peer switch sequences HR, legal, finance and GM and yields a valid credential", () => {
    const result = planPeerSwitch({
        requester: "technology",
        to: "marketing",
        reason: "launch review belongs to marketing",
        scenario: "office",
        targetManifest: marketing,
        visibleScope: [{ kind: "goal", id: "goal.mkt" }],
        payloadRefs: [{ kind: "goal", id: "goal.mkt" }],
        quota: { tokens: 400 },
        elasticity: "medium",
        constraints: constraintsFor("office"),
        issuedAt: At,
        at: At2,
        approvals: {
            generalManager: grant("apv.gm", "credential.issue", "general-manager"),
            legal: grant("apv.legal", "credential.compliance", "legal"),
            finance: grant("apv.fin", "budget.elasticity", "finance"),
            humanResources: grant("apv.hr", "perspective.assignment", "human-resources"),
        },
        signers,
    });
    assert.equal(result.credential.to, "marketing");
    assert.equal(result.verdict.valid, true);
    assert.equal(result.steps.length >= 6, true);
    assert.throws(
        () =>
            planPeerSwitch({
                requester: "technology",
                to: "marketing",
                reason: "missing HR",
                scenario: "office",
                targetManifest: marketing,
                visibleScope: [{ kind: "goal", id: "goal.mkt" }],
                quota: { tokens: 100 },
                elasticity: "medium",
                constraints: constraintsFor("office"),
                issuedAt: At,
                at: At2,
                approvals: {
                    generalManager: grant("apv.gm2", "credential.issue", "general-manager"),
                    legal: grant("apv.legal2", "credential.compliance", "legal"),
                    finance: grant("apv.fin2", "budget.elasticity", "finance"),
                    humanResources: grant("apv.hr2", "perspective.readiness", "human-resources"),
                },
                signers,
            }),
        /perspective.assignment/,
    );
});

test("a peer switch cannot target the requester", () => {
    assert.throws(
        () =>
            planPeerSwitch({
                requester: "marketing",
                to: "marketing",
                reason: "no-op switch",
                scenario: "office",
                targetManifest: marketing,
                visibleScope: [{ kind: "goal", id: "goal.mkt" }],
                quota: { tokens: 10 },
                elasticity: "low",
                constraints: constraintsFor("office"),
                issuedAt: At,
                at: At2,
                approvals: {} as never,
                signers,
            }),
        /itself/,
    );
});

test("downgrade returns authority to an execution perspective", () => {
    const result = planDowngrade({
        requester: "board",
        from: "board",
        to: "technology",
        reason: "arbitration finished",
        targetManifest: technology,
        visibleScope: [{ kind: "goal", id: "goal.tech" }],
        quota: { tokens: 500 },
        elasticity: "high",
        constraints: constraintsFor("engineering"),
        issuedAt: At,
        at: At2,
        approvals: {
            generalManager: grant("apv.dgm", "credential.issue", "general-manager"),
            legal: grant("apv.dlegal", "credential.compliance", "legal"),
            finance: grant("apv.dfin", "budget.settlement", "finance"),
            humanResources: grant("apv.dhr", "perspective.readiness", "human-resources"),
        },
        signers,
    });
    assert.equal(result.credential.to, "technology");
    assert.equal(result.verdict.valid, true);
});

test("mode switch patches weights, and large drift needs the general manager", () => {
    const small = switchMode({
        manifest: technology,
        modes: { think: 0.45 },
        by: "general-manager",
        at: At2,
        signoff: { role: "issuer", by: "general-manager", at: At2 },
    });
    assert.equal(small.manifest.version, 2);
    assert.equal(small.approvalRequired, false);
    assert.equal(small.steps.length > 0, true);
    assert.throws(
        () =>
            switchMode({
                manifest: technology,
                modes: { converge: 2 },
                by: "general-manager",
                at: At2,
                signoff: { role: "issuer", by: "general-manager", at: At2 },
            }),
        /exceeds 0.15/,
    );
    const approved = switchMode({
        manifest: technology,
        modes: { converge: 2 },
        by: "general-manager",
        at: At2,
        signoff: { role: "issuer", by: "general-manager", at: At2 },
        approvals: { modeWeights: grant("apv.mode", "mode.weights", "general-manager") },
    });
    assert.equal(approved.approvalRequired, true);
    assert.equal(approved.manifest.version, 2);
});

test("scenario switch re-derives instead of patching and increments the version", () => {
    const result = switchScenario({
        manifest: technology,
        scenario: "research",
        at: At2,
        signers,
        approvals: { scenario: grant("apv.scenario", "scenario.judgement", "general-manager") },
    });
    assert.equal(result.manifest.scenario, "research");
    assert.equal(result.manifest.version, 2);
    assert.equal(result.manifest.parent, technology.digest);
    assert.equal(result.plan.scenario, "research");
    assert.throws(
        () => switchScenario({ manifest: technology, scenario: "research", at: At2, signers, approvals: { scenario: grant("apv.scenario2", "mode.weights", "general-manager") } }),
        /scenario.judgement/,
    );
    assert.throws(
        () =>
            switchScenario({
                manifest: technology,
                scenario: "research",
                at: At2,
                signers,
                approvals: { scenario: grant("apv.scenario3", "scenario.judgement", "general-manager") },
                crossScenarioEscalation: true,
            }),
        /also needs the board/,
    );
});

test("escalation plans an independent strategic context with type-specific authorisation", () => {
    const plan = planEscalation({
        from: "technology",
        kind: "strategy",
        reason: "the architecture decision exceeds delegated authority",
        evidence: [{ kind: "evidence", id: "ev.1" }],
        at: At2,
        goal: "choose the platform",
        strategySummary: "reliability before growth",
        approvals: {
            initiate: grant("apv.esc", "escalation.initiate", "general-manager"),
            reserve: grant("apv.res", "budget.reserve", "finance"),
            readiness: grant("apv.ready", "perspective.readiness", "human-resources"),
            authorization: grant("apv.auth", "escalation.strategic", "board"),
        },
    });
    assert.equal(plan.target, "board");
    assert.equal(plan.independent.inheritsPrivateReasoning, false);
    assert.equal(plan.independent.evidence.length, 1);
    assert.equal(plan.approvals.length, 4);
    const audit = planEscalation({
        from: "technology",
        kind: "audit",
        reason: "the evidence chain needs an independent audit",
        evidence: [{ kind: "evidence", id: "ev.2" }],
        at: At2,
        goal: "audit the evidence",
        strategySummary: "reliability before growth",
        approvals: {
            initiate: grant("apv.esc2", "escalation.initiate", "general-manager"),
            reserve: grant("apv.res2", "budget.reserve", "finance"),
            readiness: grant("apv.ready2", "perspective.readiness", "human-resources"),
            authorization: grant("apv.auth2", "escalation.audit", "general-manager"),
        },
    });
    assert.equal(audit.target, "supervisory");
    assert.throws(
        () =>
            planEscalation({
                from: "technology",
                kind: "audit",
                reason: "wrong authoriser",
                evidence: [{ kind: "evidence", id: "ev.2" }],
                at: At2,
                goal: "audit",
                strategySummary: "summary",
                approvals: {
                    initiate: grant("apv.e3", "escalation.initiate", "general-manager"),
                    reserve: grant("apv.r3", "budget.reserve", "finance"),
                    readiness: grant("apv.rd3", "perspective.readiness", "human-resources"),
                    authorization: grant("apv.a3", "escalation.audit", "board"),
                },
            }),
        /general-manager/,
    );
    assert.throws(
        () =>
            planEscalation({
                from: "technology",
                kind: "final",
                reason: "goal conflict",
                evidence: [{ kind: "evidence", id: "ev.1" }],
                at: At2,
                goal: "goal",
                strategySummary: "summary",
                approvals: {
                    initiate: grant("apv.e2", "escalation.initiate", "general-manager"),
                    reserve: grant("apv.r2", "budget.reserve", "finance"),
                    readiness: grant("apv.rd2", "perspective.readiness", "human-resources"),
                    authorization: grant("apv.a2", "escalation.strategic", "board"),
                },
            }),
        /shareholders/,
    );
});

const bus: CooperationBus = new CooperationBus({ now: () => At2 });

test("multi-agent bus delivers structured refs and rejects scope escapes", () => {
    bus.register({ agentId: "a.tech", perspective: "technology", manifest: technology, budget: { scope: "agent", id: "agt.tech" }, reliability: { alpha: 3, beta: 1 } });
    bus.register({ agentId: "a.mkt", perspective: "marketing", manifest: marketing, budget: { scope: "agent", id: "agt.mkt" }, reliability: { alpha: 2, beta: 2 } });
    bus.register({ agentId: "a.sup", perspective: "supervisory", manifest: supervisory, budget: { scope: "agent", id: "agt.sup" }, reliability: { alpha: 4, beta: 1 } });
    const announced = bus.announce("a.tech", At2);
    assert.equal(announced.length, 2);
    assert.equal(announced.every((delivery) => delivery.ok), true);
    const delivered = bus.handoff("a.tech", "a.mkt", credential, [{ kind: "goal", id: "goal.mkt" }], At2, "marketing owns the launch review");
    assert.equal(delivered.ok, true);
    assert.equal(verifyAgentMessage(delivered.message as AgentMessage), true);
    const escaped = bus.send({
        from: "a.tech",
        to: "a.mkt",
        kind: "task",
        at: At2,
        credential,
        refs: [{ kind: "goal", id: "goal.secret" }],
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code === "credential-invalid" || escaped.code === "scope-escape", true);
    const missing = bus.send({ from: "a.tech", to: "a.mkt", kind: "task", at: At2, refs: [] });
    assert.equal(missing.code, "credential-missing");
    const inbox = bus.inbox("a.mkt", At2);
    assert.equal(inbox.some((delivery) => delivery.ok), true);
});

test("expired credentials are rejected at receive time, not only at send", () => {
    const inbox = bus.inbox("a.mkt", AtLate);
    assert.equal(inbox.some((delivery) => delivery.ok === false && delivery.code === "credential-invalid"), true);
});

test("audit requests bypass execution context and carry refs only", () => {
    const audit = bus.auditRequest("a.tech", [{ kind: "evidence", id: "ev.1" }], At2);
    assert.equal(audit.ok, true);
    assert.equal(audit.message?.to, "a.sup");
    assert.equal(audit.message?.kind, "audit-request");
    assert.equal(audit.message?.refs?.length, 1);
    assert.equal(audit.message?.receipt, (void 0));
});

test("communication is pruned by posterior reliability and information value", () => {
    bus.observe("a.sup", true);
    bus.observe("a.mkt", false);
    const routed = bus.route("a.tech", ["a.mkt", "a.sup"], { voi: { "a.mkt": 0.1, "a.sup": 0.2 }, limit: 1 });
    assert.deepEqual(routed, ["a.sup"]);
    const pinned = bus.route("a.tech", ["a.mkt", "a.sup"], { voi: { "a.mkt": 2, "a.sup": 0 }, limit: 1 });
    assert.deepEqual(pinned, ["a.mkt"]);
    assert.equal(manifestSummaryOf(technology).focus, 1);
});

test("approval self-dealing and unknown perspectives fail closed", () => {
    assert.throws(
        () =>
            planPeerSwitch({
                requester: "technology",
                to: "marketing",
                reason: "self approval",
                scenario: "office",
                targetManifest: marketing,
                visibleScope: [{ kind: "goal", id: "goal.mkt" }],
                quota: { tokens: 100 },
                elasticity: "medium",
                constraints: constraintsFor("office"),
                issuedAt: At,
                at: At2,
                approvals: {
                    generalManager: grant("apv.self", "credential.issue", "general-manager"),
                    legal: grant("apv.self2", "credential.compliance", "technology" as never),
                    finance: grant("apv.self3", "budget.elasticity", "finance"),
                    humanResources: grant("apv.self4", "perspective.assignment", "human-resources"),
                },
                signers,
            }),
        /legal/,
    );
    assert.throws(() => planPeerSwitch({ requester: "technology", to: "ceo" as never, reason: "x", scenario: "office", targetManifest: marketing, visibleScope: [], quota: {}, elasticity: "low", constraints: constraintsFor("office"), issuedAt: At, at: At2, approvals: {} as never, signers }), GovernanceError);
});

const testAsync: (name: string, fn: () => Promise<void>) => Promise<void> = async (name: string, fn: () => Promise<void>): Promise<void> => {
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

await testAsync("loopback transport re-admits a sealed message", async () => {
    const source: CooperationBus = new CooperationBus({ now: () => At2 });
    const target: CooperationBus = new CooperationBus({ now: () => At2 });
    for (const bus of [source, target]) {
        bus.register({ agentId: "a.tech", perspective: "technology", manifest: technology, budget: { scope: "agent", id: "agt.tech" }, reliability: { alpha: 3, beta: 1 } });
        bus.register({ agentId: "a.mkt", perspective: "marketing", manifest: marketing, budget: { scope: "agent", id: "agt.mkt" }, reliability: { alpha: 2, beta: 2 } });
    }
    const sent = source.handoff("a.tech", "a.mkt", credential, [{ kind: "goal", id: "goal.mkt" }], At2, "loopback");
    assert.equal(sent.ok, true);
    const transport: LoopbackTransport = new LoopbackTransport(target);
    const delivered = await transport.deliver(sent.message as AgentMessage);
    assert.equal(delivered.ok, true);
    assert.equal((await transport.deliver(sent.message as AgentMessage)).ok, true);
    assert.equal(target.inbox("a.mkt", At2).length, 1);
    const tampered: AgentMessage = { ...(sent.message as AgentMessage), summary: "edited in flight" };
    const rejected = await transport.deliver(tampered);
    assert.equal(rejected.ok, false);
});

await testAsync("HTTP transport and handler preserve the delivery verdict", async () => {
    const source: CooperationBus = new CooperationBus({ now: () => At2 });
    const target: CooperationBus = new CooperationBus({ now: () => At2 });
    for (const bus of [source, target]) {
        bus.register({ agentId: "a.tech", perspective: "technology", manifest: technology, budget: { scope: "agent", id: "agt.tech" }, reliability: { alpha: 3, beta: 1 } });
        bus.register({ agentId: "a.mkt", perspective: "marketing", manifest: marketing, budget: { scope: "agent", id: "agt.mkt" }, reliability: { alpha: 2, beta: 2 } });
    }
    const sent = source.handoff("a.tech", "a.mkt", credential, [{ kind: "goal", id: "goal.mkt" }], At2, "http");
    const handler = createCooperationHandler(target);
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const envelope = JSON.parse(`${init?.body}`) as { message: AgentMessage };
        const result = await handler(envelope);
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const http: HttpCooperationTransport = new HttpCooperationTransport({ endpoint: "https://example.test/cooperation", fetchImpl: fakeFetch });
    const delivered = await http.deliver(sent.message as AgentMessage);
    assert.equal(delivered.ok, true);
    assert.equal(target.inbox("a.mkt", At2).length, 1);
    const malformed = await handler({});
    assert.equal(malformed.status, 400);
    const nonJson = new HttpCooperationTransport({
        endpoint: "https://example.test/cooperation",
        fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    });
    assert.equal((await nonJson.deliver(sent.message as AgentMessage)).code, "transport-error");
});

await testAsync("HTTP transport authenticates, rejects replay and clock skew", async () => {
    const transportSigners = await generateGovernanceSigners(["transport"]);
    const keyring = new GovernanceKeyring();
    keyring.add("transport", transportSigners[0].key.publicKey);
    const source: CooperationBus = new CooperationBus({ now: () => At2 });
    const target: CooperationBus = new CooperationBus({ now: () => At2 });
    for (const bus of [source, target]) {
        bus.register({ agentId: "a.tech", perspective: "technology", manifest: technology, budget: { scope: "agent", id: "agt.tech" }, reliability: { alpha: 3, beta: 1 } });
        bus.register({ agentId: "a.mkt", perspective: "marketing", manifest: marketing, budget: { scope: "agent", id: "agt.mkt" }, reliability: { alpha: 2, beta: 2 } });
    }
    const sent = source.handoff("a.tech", "a.mkt", credential, [{ kind: "goal", id: "goal.mkt" }], At2, "authenticated");
    const handler = createCooperationHandler(target, { keyring, now: () => Date.now() });
    let captured: unknown;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = JSON.parse(`${init?.body}`);
        const result = await handler(captured);
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const http = new HttpCooperationTransport({
        endpoint: "https://example.test/cooperation",
        fetchImpl: fakeFetch,
        auth: { signer: "transport", key: transportSigners[0].key },
    });
    const delivered = await http.deliver(sent.message as AgentMessage);
    assert.equal(delivered.ok, true);
    const replayed = await handler(captured);
    assert.equal(replayed.status, 409);
    assert.equal(replayed.body.code, "transport-error");
    const missing = await handler({ message: sent.message });
    assert.equal(missing.status, 401);
    const empty = createCooperationHandler(target, { keyring: new GovernanceKeyring() });
    assert.equal((await empty(captured)).status, 401);
    const skewed = createCooperationHandler(target, { keyring, now: () => Date.now() + 120_000 });
    assert.equal((await skewed({ ...(captured as Record<string, unknown>), auth: { ...((captured as { auth: Record<string, unknown> }).auth), nonce: "skewed" } })).status, 409);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
