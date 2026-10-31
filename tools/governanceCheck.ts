#!/usr/bin/env node
/**
 * Governance-layer checks: the nine constructs of the protocol description.
 *
 * The tests are written against the public barrel, so a missing export or a
 * signature drift fails here before any integration does. They also prove the
 * negative cases: self-signed manifests, missing counter-signatures, expired
 * credentials, scope escapes, frozen ledgers, legal freezes that the general
 * manager cannot lift, and phases that advance without their approvals.
 */
import assert from "node:assert/strict";

import type { BetaBelief } from "../src/bayes/engine.ts";
import type { Ref } from "../src/types/common.ts";
import type { AttentionManifest, AttentionManifestDraft, CredentialDraft, SwitchCredential } from "../src/governance/index.ts";
import {
    BehaviorRegistry,
    ContextLayers,
    DefaultModeWeights,
    ElasticityLimits,
    GovernanceBudget,
    GovernanceError,
    LegalGate,
    Workflow,
    activeModes,
    canApprove,
    canIssueCredential,
    canRead,
    canonicalScenarioOf,
    constraintsFor,
    credentialDigest,
    createAttentionManifest,
    credentialSummary,
    decideControl,
    deriveAttentionManifest,
    elasticityFor,
    evidenceFloorFor,
    isExpired,
    issueCredential,
    issueAttentionManifest,
    legacyInteractionMix,
    loadAttentionManifest,
    manifestSummary,
    modeAdjustments,
    normalizeModeWeights,
    perspective,
    perspectivesForScenario,
    promoteIgnored,
    reassessIgnored,
    resolveScenarioModes,
    revisitIntervalFor,
    revokeCredential,
    sensitivityFor,
    strictestFloor,
    updateAttentionManifest,
    validatePerspectiveRegistry,
    verifyAttentionManifest,
    verifyCredential,
} from "../src/governance/index.ts";
import type { GlobalCore } from "../src/governance/context.ts";
import type { WorkflowState } from "../src/governance/workflow.ts";
import type { EscalationType } from "../src/governance/workflow.ts";

const At: string = "2026-10-28T00:00:00.000Z";
const At2: string = "2026-10-28T00:05:00.000Z";

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

const ref: (kind: Ref["kind"], id: string) => Ref = (kind: Ref["kind"], id: string): Ref => ({ kind, id });

const signers: () => Array<{ role: "issuer" | "legal" | "finance"; by: "general-manager" | "legal" | "finance"; at: string }> = () => [
    { role: "issuer", by: "general-manager", at: At },
    { role: "legal", by: "legal", at: At },
    { role: "finance", by: "finance", at: At },
];

const draft: (patch?: Partial<AttentionManifestDraft>) => AttentionManifestDraft = (patch: Partial<AttentionManifestDraft> = {}): AttentionManifestDraft => ({
    id: "mft.eng.1",
    perspective: "technology",
    scenario: "engineering",
    focus: [
        { target: ref("goal", "goal.checkout"), category: "goal", priority: 0.9, depth: 2 },
        { target: ref("tool", "tool.lint"), category: "tool", priority: 0.5, depth: 1 },
        { target: ref("memory", "memory.old"), category: "memory", priority: 0.3, depth: 1 },
    ],
    ignore: [{ target: ref("memory", "memory.stale"), reason: "stale", revisitIf: "deploy", everyFrames: 2 }],
    budget: { scope: "perspective", perspective: "technology", cap: { tokens: 1000 }, elasticity: "high" },
    constraints: constraintsFor("engineering"),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
    ...patch,
});

const manifest: () => AttentionManifest = (): AttentionManifest => createAttentionManifest(draft(), signers());

const credentialDraft: (patch?: Partial<CredentialDraft>) => CredentialDraft = (patch: Partial<CredentialDraft> = {}): CredentialDraft => ({
    id: "crd.eng.1",
    from: "general-manager",
    to: "technology",
    reason: "hand the checkout incident to engineering",
    visibleScope: [ref("evidence", "ev.1"), ref("tool", "tool.deploy")],
    payloadRefs: [ref("evidence", "ev.1")],
    budget: { quota: { tokens: 500 }, elasticity: "medium" },
    constraints: constraintsFor("engineering"),
    manifest: { id: "mft.eng.1", version: 1 },
    scenario: "engineering",
    issuedAt: At,
    ...patch,
});

const credential: (patch?: Partial<CredentialDraft>) => SwitchCredential = (patch: Partial<CredentialDraft> = {}): SwitchCredential => issueCredential(credentialDraft(patch), signers());

const core: () => GlobalCore = (): GlobalCore => ({
    goal: "ship the checkout fix",
    strategy: { version: 3, digest: "sha256:strategy", summary: "fix reliability before growth", detail: "full board record" },
    constraints: ["no irreversible write without approval"],
    priorities: ["availability", "correctness"],
    taskState: "executing",
    scenario: "engineering",
    modes: DefaultModeWeights.engineering,
    budget: { tokens: 1000 },
    version: 1,
});

test("matrix defaults match the specification and normalize", () => {
    assert.deepEqual(DefaultModeWeights.chat, { affect: 0.5, think: 0.2, diverge: 0.2, converge: 0.1 });
    assert.equal(DefaultModeWeights.engineering.converge, 0.5);
    const weights = normalizeModeWeights({ affect: 3, think: 1 });
    assert.equal(weights.affect, 0.75);
    assert.equal(weights.converge, 0);
    assert.throws(() => normalizeModeWeights({}), /positive/);
    assert.throws(() => normalizeModeWeights({ think: -1 }), /non-negative/);
});

test("floors, cadence, elasticity and sensitivity follow the matrix", () => {
    assert.equal(evidenceFloorFor("chat", DefaultModeWeights.chat), "F3");
    assert.equal(evidenceFloorFor("engineering", DefaultModeWeights.engineering), "F1");
    assert.equal(evidenceFloorFor("research", { affect: 0, think: 0.5, diverge: 0.5, converge: 0 }), "F1");
    assert.equal(evidenceFloorFor("writing", { affect: 0, think: 0, diverge: 0.5, converge: 0.5 }), "F2");
    assert.equal(revisitIntervalFor("writing", { affect: 0, think: 0, diverge: 1, converge: 0 }), 2);
    assert.equal(revisitIntervalFor("engineering", { affect: 0, think: 0, diverge: 0, converge: 1 }), 2);
    assert.equal(elasticityFor("writing", { affect: 0, think: 0, diverge: 1, converge: 0 }), "high");
    assert.equal(elasticityFor("chat", { affect: 0.8, think: 0.2, diverge: 0, converge: 0 }), "low");
    assert.equal(sensitivityFor("engineering", { affect: 0, think: 0, diverge: 0, converge: 1 }), "high");
    const plan = resolveScenarioModes("engineering");
    assert.equal(plan.requiredTier, "T3");
    assert.equal(plan.gateStrictness, "strict");
    assert.equal(plan.focusLimit, 2);
    assert.deepEqual(activeModes({ affect: 0, think: 0.8, diverge: 0.1, converge: 0.1 }), ["think"]);
});

test("mode adjustments and bridges preserve intent", () => {
    const adjustments = modeAdjustments(DefaultModeWeights.writing);
    assert.equal(adjustments.some((entry) => entry.mode === "diverge" && entry.adjustment.focusDelta > 0), true);
    assert.equal(legacyInteractionMix(DefaultModeWeights.writing).inspire, 0.5);
    assert.equal(canonicalScenarioOf({ collaboration: 1 }), "office");
    assert.equal(canonicalScenarioOf({ investigation: 1 }), "research");
    assert.equal(canonicalScenarioOf({ iteration: 1 }), "engineering");
    assert.throws(() => canonicalScenarioOf({}), /positive/);
});

test("perspective registry is coherent and strategic targets need escalation", () => {
    assert.deepEqual(validatePerspectiveRegistry(), []);
    assert.equal(perspective("finance").layer, "rule");
    assert.equal(perspective("marketing").switchable, true);
    assert.equal(canIssueCredential("general-manager", "technology"), true);
    assert.equal(canIssueCredential("general-manager", "board"), false);
    assert.equal(canApprove("legal", "audit.behavior"), true);
    assert.equal(canApprove("finance", "audit.budget"), true);
    assert.equal(canIssueCredential("technology", "marketing"), false);
    const plan = perspectivesForScenario("research");
    assert.equal(plan.default.includes("strategy"), true);
    assert.equal(plan.onDemand.includes("supervisory"), true);
});

test("manifest derivation clamps focus, floor and elasticity", () => {
    const derived = deriveAttentionManifest(draft());
    assert.equal(derived.focus.length, 2);
    assert.equal(derived.evidenceFloor, "F1");
    assert.equal(derived.requiredTier, "T3");
    assert.equal(derived.reassessEvery, 2);
    assert.equal(derived.elasticity, "high");
    assert.equal(derived.sensitivity, "high");
    const chat = deriveAttentionManifest(draft({ scenario: "chat", budget: { scope: "perspective", perspective: "technology", cap: { tokens: 10 }, elasticity: "high" }, constraints: constraintsFor("chat") }));
    assert.equal(chat.elasticity, "low");
    assert.equal(chat.evidenceFloor, "F3");
    assert.throws(() => deriveAttentionManifest(draft({ evidenceFloor: "F3" })), /requires at least F1/);
});

test("manifest issue verifies, tampering is visible and sign-offs are mandatory", () => {
    const issued = manifest();
    assert.equal(issued.version, 1);
    assert.deepEqual(verifyAttentionManifest(issued, At), { ok: true });
    assert.equal(verifyAttentionManifest(issued).ok, true);
    const tampered: AttentionManifest = { ...issued, focus: [] };
    assert.equal(verifyAttentionManifest(tampered).code, "manifest-tampered");
    assert.throws(
        () => createAttentionManifest(draft(), [signers()[0], signers()[1]]),
        /missing finance sign-off/,
    );
    assert.throws(
        () =>
            createAttentionManifest(
                draft({
                    perspective: "legal",
                    budget: { scope: "perspective", perspective: "legal", cap: { tokens: 1000 }, elasticity: "high" },
                }),
                signers(),
            ),
        /cannot issue its own manifest|cannot counter-sign/,
    );
});

test("manifest load enforces owner, scenario and expiry", () => {
    const issued = manifest();
    assert.equal(loadAttentionManifest(issued, { perspective: "technology", at: At }).focus.length, 2);
    assert.throws(() => loadAttentionManifest(issued, { perspective: "marketing", at: At }), /belongs to technology/);
    assert.throws(() => loadAttentionManifest(issued, { perspective: "technology", scenario: "chat", at: At }), /does not match/);
    const shortLived = createAttentionManifest(draft({ ttlMs: 1_000 }), signers());
    assert.throws(() => loadAttentionManifest(shortLived, { perspective: "technology", at: "2026-10-28T00:00:02.000Z" }), /expired/);
});

test("ignored items return only when due and their signal fired", () => {
    const issued = manifest();
    const early = reassessIgnored(issued, 1, ["deploy"]);
    assert.equal(early.due.length, 0);
    assert.equal(early.promoted.length, 0);
    const due = reassessIgnored(issued, 2, ["deploy"]);
    assert.equal(due.due.length, 1);
    assert.equal(due.promoted.length, 1);
    assert.equal(due.updated.ignore.length, 0);
    const retained = reassessIgnored(issued, 2, []);
    assert.equal(retained.promoted.length, 0);
    assert.equal(retained.retained.length, 1);
    const promoted = promoteIgnored(issued, due.promoted, { role: "issuer", by: "technology", at: At2 }, At2);
    assert.equal(promoted.version, 2);
    assert.equal(promoted.focus.length, 3);
    assert.equal(verifyAttentionManifest(promoted).ok, true);
});

test("manifest updates enforce drift, re-derivation and owner scope", () => {
    const issued = manifest();
    const focusOnly = updateAttentionManifest(
        issued,
        { focus: [{ target: ref("goal", "goal.new"), category: "goal", priority: 1, depth: 3 }] },
        { by: "technology", at: At2, signoff: { role: "issuer", by: "technology", at: At2 } },
    );
    assert.equal(focusOnly.version, 2);
    assert.equal(focusOnly.focus.length, 1);
    assert.throws(
        () => updateAttentionManifest(issued, { evidenceFloor: "F3" }, { by: "technology", at: At2, signoff: { role: "issuer", by: "technology", at: At2 } }),
        /only focus and ignore/,
    );
    assert.throws(
        () => updateAttentionManifest(issued, { scenario: "chat" }, { by: "general-manager", at: At2, signoff: { role: "issuer", by: "general-manager", at: At2 } }),
        /requires a fresh derivation/,
    );
    assert.throws(
        () =>
            updateAttentionManifest(
                issued,
                { modes: { converge: 1.5 } },
                { by: "general-manager", at: At2, signoff: { role: "issuer", by: "general-manager", at: At2 } },
            ),
        /drift .* exceeds 0.15/,
    );
    const approved = updateAttentionManifest(
        issued,
        { modes: { converge: 1.5 } },
        {
            by: "general-manager",
            at: At2,
            signoff: { role: "issuer", by: "general-manager", at: At2 },
            approvals: { modeWeights: { id: "apv.1", subject: "mode.weights", by: "general-manager", at: At2, granted: true, note: "approved by the general manager" } },
        },
    );
    assert.equal(approved.version, 2);
});

test("credential issue requires the three sign-offs and rejects self-signature", () => {
    const issued = credential();
    assert.deepEqual(verifyCredential(issued, { at: At2, to: "technology" }), {
        valid: true,
        code: "valid",
        detail: `${issued.id} authorises technology until ${issued.expires}`,
    });
    assert.equal(canRead(issued, ref("evidence", "ev.1")), true);
    assert.equal(canRead(issued, ref("evidence", "ev.2")), false);
    assert.throws(() => issueCredential(credentialDraft(), [signers()[0], signers()[1]]), /missing finance sign-off/);
    assert.throws(() => issueCredential(credentialDraft(), [signers()[0], signers()[1], signers()[2], { role: "issuer", by: "technology", at: At }]), /technology cannot sign its own/);
    assert.throws(() => issueCredential(credentialDraft({ payloadRefs: [ref("evidence", "ev.9")] }), signers()), /outside the visible scope/);
    assert.throws(() => issueCredential(credentialDraft({ to: "board" }), signers()), /board or human authorisation/);
    assert.equal(credentialSummary(issued).includes("general-manager->technology"), true);
});

test("credential verification is closed on expiry, scope, target and revocation", () => {
    const issued = credential();
    assert.equal(verifyCredential(issued, { at: "2026-10-28T00:10:01.000Z", to: "technology" }).code, "credential-expired");
    assert.equal(verifyCredential(issued, { at: At2, to: "marketing" }).code, "credential-target");
    assert.equal(verifyCredential(issued, { at: At2, to: "technology", readRefs: [ref("evidence", "ev.9")] }).code, "credential-scope");
    assert.equal(verifyCredential(issued, { at: At2, to: "technology", manifest: { id: "mft.eng.1", version: 2 } }).code, "credential-manifest");
    const revocation = revokeCredential(issued, "legal", "task withdrawn", At2);
    assert.equal(verifyCredential(issued, { at: At2, to: "technology", revoked: [revocation] }).code, "credential-revoked");
    const tampered: SwitchCredential = { ...issued, reason: "changed" };
    assert.equal(verifyCredential(tampered, { at: At2, to: "technology" }).code, "credential-tampered");
});

test("three-layer context isolates private state and gates global writes", () => {
    const layers = new ContextLayers({ core: core(), now: () => At });
    assert.equal(layers.global("technology").strategySummary, "fix reliability before growth");
    assert.equal(layers.expandGlobal("technology").strategy.detail, "full board record");
    assert.throws(() => layers.writeGlobal("technology", { goal: "hijack" }), /may not write the global core/);
    layers.writeGlobal("board", { goal: "ship safely" });
    assert.equal(layers.global("technology").goal, "ship safely");
    assert.equal(layers.global("technology").version, 2);
    layers.openPerspective("technology", { id: "mft.eng.1", version: 1 });
    layers.writePrivate("technology", { at: At, kind: "reasoning", text: "checkout lock suspected" });
    layers.openPerspective("marketing", { id: "mft.mkt.1", version: 1 });
    assert.throws(() => layers.readPrivate("technology", "marketing"), /may not read/);
    assert.equal(layers.readPrivate("technology", "technology")?.notes.length, 1);
    assert.throws(() => layers.writeReceipt("technology", { conclusion: "stale", evidence: [], confidence: 0.5, budget: {}, manifest: { id: "mft.eng.1", version: 1 }, scenario: "engineering", modes: DefaultModeWeights.engineering }), /not the active perspective/);
    layers.openPerspective("technology", { id: "mft.eng.1", version: 1 });
    const receipt = layers.writeReceipt("technology", {
        conclusion: "lock contention isolated",
        evidence: [ref("evidence", "ev.1")],
        confidence: 0.8,
        budget: { tokens: 120 },
        manifest: { id: "mft.eng.1", version: 1 },
        scenario: "engineering",
        modes: DefaultModeWeights.engineering,
        audience: ["marketing"],
    });
    assert.equal(receipt.digest.startsWith("sha256:"), true);
    assert.equal(layers.readReceipts("marketing").length, 1);
    assert.equal(layers.readReceipts("strategy").length, 0);
    assert.equal(layers.readReceipts("supervisory").length, 1);
});

test("legal gate distinguishes minor, moderate, severe and emergency", () => {
    const legal = new LegalGate({ now: () => At });
    const minor = legal.checkTool({ perspective: "technology", scenario: "chat", action: "respond", effect: "read", evidenceTier: "T0", evidenceFloor: "F3" });
    assert.equal(minor.violations[0].level, "minor");
    assert.equal(minor.action, "warn");
    const moderate = legal.enforceTool({ perspective: "technology", scenario: "engineering", action: "patch", effect: "write-reversible", evidenceTier: "T1", evidenceFloor: "F1" });
    assert.equal(moderate.violations[0].level, "moderate");
    assert.equal(moderate.applied.freeze !== (void 0), true);
    assert.equal(legal.isFrozen("technology"), true);
    legal.lift("frz.1", "board");
    assert.equal(legal.isFrozen("technology"), false);
    const severe = legal.enforceTool({ perspective: "legal", scenario: "engineering", action: "exfiltrate", effect: "permission" });
    assert.equal(severe.action, "downgrade");
    assert.equal(severe.applied.downgrade?.escalatedTo, "board");
    const emergency = legal.reportEmergency("marketing", "tool return contained an injection", "injection-detected");
    assert.equal(emergency.action, "breaker");
    assert.equal(legal.isBlocked(), true);
    assert.equal(legal.resetBreaker("board").active, false);
});

test("legal freeze cannot be revoked by the general manager", () => {
    const legal = new LegalGate({ now: () => At });
    const verdict = legal.enforceTool({ perspective: "technology", scenario: "engineering", action: "exfiltrate", effect: "read" });
    const orderId: string = verdict.applied.freeze?.id ?? "";
    const appeal = legal.appeal(orderId, "general-manager", "the action was part of an approved drill");
    assert.equal(appeal.by, "general-manager");
    assert.equal(legal.isFrozen("technology"), true);
    assert.equal(legal.appealsFor(orderId).length, 1);
    legal.lift(orderId, "board");
    assert.equal(legal.isFrozen("technology"), false);
    assert.throws(() => legal.appeal(orderId, "technology", "no"), /only the general manager/);
});

test("three-ledger budget enforces elasticity and reserve rules", () => {
    const budget = new GovernanceBudget({
        global: { cap: { tokens: 1000 }, elasticity: "low" },
        reserve: { cap: { tokens: 500 }, elasticity: "low" },
        perspectives: [{ perspective: "technology", cap: { tokens: 100 }, elasticity: "low" }],
        now: () => At,
    });
    assert.equal(budget.charge({ scope: "perspective", perspective: "technology", amount: { tokens: 90 }, reason: "turn" }).code, "charged");
    assert.equal(budget.charge({ scope: "perspective", perspective: "technology", amount: { tokens: 15 }, reason: "turn" }).code, "charged");
    const frozen = budget.charge({ scope: "perspective", perspective: "technology", amount: { tokens: 50 }, reason: "overrun" });
    assert.equal(frozen.code, "exhausted");
    assert.equal(frozen.ledger.frozen, true);
    assert.equal(ElasticityLimits.low.hardRatio, 0.2);
    const high = new GovernanceBudget({ global: { cap: { tokens: 1000 }, elasticity: "high" }, reserve: { cap: { tokens: 100 }, elasticity: "low" }, now: () => At });
    assert.equal(high.charge({ scope: "global", amount: { tokens: 1400 }, reason: "big turn" }).code, "charged-post-audit");
    const medium = new GovernanceBudget({ global: { cap: { tokens: 1000 }, elasticity: "medium" }, reserve: { cap: { tokens: 100 }, elasticity: "low" }, now: () => At });
    assert.equal(medium.charge({ scope: "global", amount: { tokens: 1100 }, reason: "over" }).code, "approval-required");
    const approval = { id: "apv.budget", subject: "budget.top-up" as const, by: "finance" as const, at: At, granted: true, requestedBy: "technology" as const };
    assert.equal(medium.charge({ scope: "global", amount: { tokens: 1100 }, reason: "over", approval, requestedBy: "technology" }).code, "charged-with-approval");
    assert.equal(medium.charge({ scope: "reserve", amount: { tokens: 10 }, reason: "not an escalation" }).code, "reserve-restricted");
    assert.equal(medium.drawReserve({ tokens: 50 }, { ...approval, subject: "budget.reserve" }, "escalate").ok, true);
    assert.throws(() => medium.drawReserve({ tokens: 400 }, { ...approval, subject: "budget.reserve" }, "big escalation"), /board budget.major-top-up/);
    const reserve = new GovernanceBudget({ global: { cap: { tokens: 1000 }, elasticity: "low" }, reserve: { cap: { tokens: 1000 }, elasticity: "low" }, now: () => At });
    const financeReserve = { ...approval, subject: "budget.reserve" as const };
    assert.throws(() => reserve.drawReserve({ tokens: 600 }, financeReserve, "big escalation"), /board budget.major-top-up/);
    const boardApproval = { id: "apv.board", subject: "budget.major-top-up" as const, by: "board" as const, at: At, granted: true };
    assert.equal(reserve.drawReserve({ tokens: 600 }, financeReserve, "big escalation", boardApproval).code, "charged");
    assert.equal(medium.settle().balanced, true);

    const family = new GovernanceBudget({
        global: { cap: { tokens: 2000 }, elasticity: "low" },
        reserve: { cap: { tokens: 500 }, elasticity: "low" },
        perspectives: [{ perspective: "technology", cap: { tokens: 500 }, elasticity: "medium" }],
        now: () => At,
    });
    const allocation = { id: "apv.alloc", subject: "budget.allocation" as const, by: "finance" as const, at: At, granted: true };
    const moved = family.reallocate(
        { scope: "perspective", id: "technology" },
        { scope: "agent", id: "agt.child" },
        { amount: { tokens: 200 }, approval: allocation, reason: "child quota", options: { toElasticity: "high", requestedBy: "technology" } },
    );
    assert.equal(moved.code, "reallocated");
    assert.equal(moved.from.cap.tokens, 300);
    assert.equal(moved.to.cap.tokens, 200);
    assert.equal(family.remaining("agent", "agt.child").tokens, 200);
    assert.equal(family.charge({ scope: "agent", agent: "agt.child", amount: { tokens: 150 }, reason: "child turn" }).code, "charged");
    assert.equal(family.remaining("agent", "agt.child").tokens, 50);
    assert.equal(
        family.reallocate(
            { scope: "perspective", id: "technology" },
            { scope: "agent", id: "agt.child" },
            { amount: { tokens: 400 }, approval: allocation, reason: "over-allocate", options: { requestedBy: "technology" } },
        ).code,
        "insufficient",
    );
    assert.equal(
        family.reallocate(
            { scope: "perspective", id: "technology" },
            { scope: "agent", id: "agt.other" },
            { amount: { tokens: 10 }, approval: { ...allocation, granted: false }, reason: "no approval" },
        ).code,
        "approval-required",
    );
    assert.equal(family.settle().agents.length, 1);
    assert.equal(family.transferHistory().length, 1);
});

test("Bayesian control routes modes and decides stop or escalation", () => {
    const uncertain: BetaBelief = { alpha: 2, beta: 2 };
    const expand = decideControl({ scenario: "engineering", modes: DefaultModeWeights.engineering, posterior: uncertain, voi: 0.8 });
    assert.equal(expand.action, "expand");
    assert.equal(expand.modes.diverge > DefaultModeWeights.engineering.diverge, true);
    assert.equal(expand.budget.nextObservationShare > 0.1, true);
    const confident: BetaBelief = { alpha: 18, beta: 2 };
    const shrink = decideControl({ scenario: "engineering", modes: DefaultModeWeights.engineering, posterior: confident });
    assert.equal(shrink.action, "shrink");
    assert.equal(shrink.modes.converge > DefaultModeWeights.engineering.converge, true);
    const conflict = decideControl({ scenario: "research", modes: DefaultModeWeights.research, posterior: uncertain, conflict: true });
    assert.equal(conflict.modes.think > DefaultModeWeights.research.think, true);
    assert.equal(conflict.escalate, true);
    const forced = decideControl({ scenario: "engineering", modes: DefaultModeWeights.engineering, posterior: confident, legalOverride: true });
    assert.equal(forced.escalateTo, "legal");
    const stopped = decideControl({ scenario: "office", modes: DefaultModeWeights.office, posterior: { alpha: 90, beta: 10 }, voi: 0, openQuestions: 0 });
    assert.equal(stopped.stop, true);
});

test("workflow refuses gates without approvals and advances with them", () => {
    const workflow = Workflow.start({ id: "wf.1", scenario: "engineering", at: At });
    const steps = workflow.steps();
    assert.equal(steps.length, 6);
    workflow.complete("intake.requirement", "customer-service", At);
    workflow.complete("intake.complexity", "general-manager", At);
    workflow.complete("intake.budget", "finance", At);
    workflow.complete("intake.strategy", "board", At);
    workflow.complete("intake.log", "administration", At);
    assert.throws(() => workflow.advance("general-manager", At), /missing approvals/);
    assert.throws(() => workflow.approve({ subject: "scenario.judgement", by: "general-manager", at: At, requestedBy: "general-manager" }), /cannot approve its own/);
    assert.throws(() => workflow.approve({ subject: "scenario.judgement", by: "finance", at: At, requestedBy: "customer-service" }), /may not approve/);
    workflow.approve({ subject: "requirement.complete", by: "customer-service", at: At, requestedBy: "general-manager" });
    workflow.approve({ subject: "scenario.judgement", by: "general-manager", at: At, requestedBy: "customer-service" });
    workflow.approve({ subject: "complexity.grade", by: "general-manager", at: At, requestedBy: "customer-service" });
    workflow.approve({ subject: "budget.initial", by: "finance", at: At, requestedBy: "general-manager" });
    assert.throws(() => workflow.advance("technology", At), /only the general manager/);
    assert.equal(workflow.advance("general-manager", At).phase, "planning");
});

test("a full preparation flow reaches execution only with a triple-signed credential", () => {
    const workflow = Workflow.start({ id: "wf.2", scenario: "engineering", at: At });
    workflow.complete("intake.requirement", "customer-service", At);
    workflow.complete("intake.complexity", "general-manager", At);
    workflow.complete("intake.budget", "finance", At);
    workflow.complete("intake.strategy", "board", At);
    workflow.complete("intake.log", "administration", At);
    workflow.approve({ subject: "requirement.complete", by: "customer-service", at: At, requestedBy: "general-manager" });
    workflow.approve({ subject: "scenario.judgement", by: "general-manager", at: At, requestedBy: "customer-service" });
    workflow.approve({ subject: "complexity.grade", by: "general-manager", at: At, requestedBy: "customer-service" });
    workflow.approve({ subject: "budget.initial", by: "finance", at: At, requestedBy: "general-manager" });
    workflow.advance("general-manager", At);
    workflow.complete("planning.route", "strategy", At);
    workflow.complete("planning.staffing", "human-resources", At);
    workflow.complete("planning.budget", "finance", At);
    workflow.complete("planning.constraints", "legal", At);
    workflow.complete("planning.state", "operations", At);
    workflow.complete("planning.manifest", "general-manager", At);
    workflow.approve({ subject: "manifest.derive", by: "general-manager", at: At, requestedBy: "strategy" });
    workflow.approve({ subject: "perspective.routing", by: "human-resources", at: At, requestedBy: "general-manager" });
    workflow.approve({ subject: "budget.allocation", by: "finance", at: At, requestedBy: "general-manager" });
    workflow.approve({ subject: "manifest.constraints", by: "legal", at: At, requestedBy: "general-manager" });
    workflow.advance("general-manager", At);
    assert.throws(
        () =>
            workflow.attach("preparation.credential", "general-manager", {
                kind: "switch-credential",
                at: At,
                signoffs: ["issuer", "legal", "finance"],
                digest: "sha256:not-a-real-credential",
            }),
        /attachCredential/,
    );
    const issued = manifest();
    const flowCredential = issueCredential(
        {
            from: "general-manager",
            to: "technology",
            reason: "execute the incident",
            visibleScope: [{ kind: "goal", id: "goal.checkout" }],
            payloadRefs: [],
            budget: { quota: { tokens: 500 }, elasticity: "high" },
            constraints: constraintsFor("engineering"),
            manifest: { id: issued.id, version: issued.version },
            scenario: "engineering",
            issuedAt: At,
        },
        signers(),
    );
    workflow.attachCredential(flowCredential, At);
    workflow.complete("preparation.compliance", "legal", At);
    workflow.complete("preparation.freeze", "finance", At);
    workflow.complete("preparation.readiness", "human-resources", At);
    workflow.complete("preparation.context", "administration", At);
    workflow.complete("preparation.tools", "technology", At);
    workflow.complete("preparation.state", "operations", At);
    workflow.approve({ subject: "credential.issue", by: "general-manager", at: At, requestedBy: "legal" });
    workflow.approve({ subject: "credential.compliance", by: "legal", at: At, requestedBy: "general-manager" });
    workflow.approve({ subject: "budget.freeze", by: "finance", at: At, requestedBy: "general-manager" });
    workflow.approve({ subject: "perspective.readiness", by: "human-resources", at: At, requestedBy: "general-manager" });
    workflow.bind({ manifest: { id: issued.id, version: issued.version } });
    assert.deepEqual(workflow.verify(), []);
    assert.equal(workflow.advance("general-manager", At).phase, "execution");
});

test("archive cannot finish without settlement and audit", () => {
    const state: WorkflowState = {
        id: "wf.archive",
        scenario: "engineering",
        modes: DefaultModeWeights.engineering,
        phase: "archive",
        status: "open",
        completedSteps: [],
        artifacts: [],
        approvals: [],
        history: [],
    };
    const archive = new Workflow(state);
    assert.throws(() => archive.finish(At), /archive gate/);
    assert.equal(archive.verify().length > 0, true);
});

test("security regressions found by adversarial review stay closed", () => {
    const budget = new GovernanceBudget({
        global: { cap: { tokens: 1000 }, elasticity: "medium" },
        reserve: { cap: { tokens: 1000 }, elasticity: "low" },
        perspectives: [{ perspective: "technology", cap: { tokens: 100 }, elasticity: "low" }],
        now: () => At,
    });
    assert.throws(() => budget.charge({ scope: "perspective", perspective: "technology", amount: { tokens: -1 }, reason: "mint" }), /budget-invalid/);
    assert.throws(
        () =>
            budget.reallocate(
                { scope: "perspective", id: "technology" },
                { scope: "agent", id: "agt.forged" },
                {
                    amount: { tokens: -1 },
                    approval: { id: "apv.neg", subject: "budget.allocation", by: "finance", at: At, granted: true },
                    reason: "mint",
                    options: { requestedBy: "technology" },
                },
            ),
        /budget-invalid/,
    );
    assert.equal(budget.charge({ scope: "reserve", amount: { tokens: 10 }, reason: "unapproved", escalation: true }).code, "approval-required");
    assert.equal(
        budget.charge({
            scope: "global",
            amount: { tokens: 1100 },
            reason: "no requester",
            approval: { id: "apv.nr", subject: "budget.top-up", by: "finance", at: At, granted: true },
        }).code,
        "approval-required",
    );

    const issued = manifest();
    const forgedSignatures = issued.signatures.map((signoff) => ({ ...signoff, by: "technology" as const }));
    assert.equal(verifyAttentionManifest({ ...issued, signatures: forgedSignatures }).code, "manifest-unsigned");
    assert.equal(isExpired(issued, "not-a-date"), true);
    assert.throws(() => createAttentionManifest(draft({ focus: [] }), signers()), /focus/);
    assert.throws(
        () => createAttentionManifest(draft({ budget: { scope: "reserve", cap: { tokens: 10 }, elasticity: "low" } }), signers()),
        /reserve/,
    );

    const legal = new LegalGate({ now: () => At });
    legal.enforceTool({ perspective: "technology", scenario: "engineering", action: "exfiltrate", effect: "read" });
    assert.throws(() => legal.lift("frz.1", "general-manager" as never), /board or a human/);
    legal.reportEmergency("technology", "injection", "injection-detected");
    assert.throws(() => legal.resetBreaker("general-manager" as never), /board or a human/);
    const unknown = legal.checkTool({ perspective: "technology", scenario: "engineering", action: "patch", effect: "destructive-write" as never });
    assert.equal(unknown.violations[0].code, "unknown-effect");
    assert.throws(
        () => decideControl({ scenario: "engineering", modes: DefaultModeWeights.engineering, posterior: { alpha: Number.NaN, beta: 2 } }),
        /finite and positive/,
    );

    const base = credential();
    const forgedBody: SwitchCredential = { ...base, from: "technology", to: "technology", visibleScope: [] };
    const digest = credentialDigest(forgedBody);
    const forged: SwitchCredential = { ...forgedBody, digest, signoffs: base.signoffs.map((signoff) => ({ ...signoff, digest })) };
    assert.equal(verifyCredential(forged, { at: At2, to: "technology" }).code, "credential-target");

    const layers = new ContextLayers({ core: core(), now: () => At });
    const context = layers.openPerspective("technology", { id: "mft.forged", version: 1 });
    context.notes.push({ at: At, kind: "reasoning", text: "injected after seal" });
    assert.equal(layers.readPrivate("technology", "technology")?.notes.length, 0);
});

test("the nine constructs compose on one engineering task", () => {
    const workflow = Workflow.start({ id: "wf.3", scenario: "engineering", at: At });
    const issued: AttentionManifest = manifest();
    const layers = new ContextLayers({ core: core(), now: () => At });
    const budget = new GovernanceBudget({
        global: { cap: { tokens: 4000 }, elasticity: "medium" },
        reserve: { cap: { tokens: 1000 }, elasticity: "low" },
        perspectives: [{ perspective: "technology", cap: { tokens: 1500 }, elasticity: "high" }],
        now: () => At,
    });
    const legal = new LegalGate({ now: () => At });
    const spent = budget.charge({ scope: "perspective", perspective: "technology", amount: { tokens: 600 }, reason: "first turn" });
    assert.equal(spent.ok, true);
    layers.openPerspective("technology", { id: issued.id, version: issued.version });
    const cleared = legal.enforceTool({ perspective: "technology", scenario: "engineering", action: "test", effect: "read", evidenceTier: "T3", evidenceFloor: issued.evidenceFloor });
    assert.equal(cleared.ok, true);
    const receipt = layers.writeReceipt("technology", {
        conclusion: "the lock hypothesis survived the test",
        evidence: [ref("evidence", "ev.1")],
        confidence: 0.82,
        budget: { tokens: 600 },
        manifest: { id: issued.id, version: issued.version },
        scenario: issued.scenario,
        modes: issued.modes,
    });
    const control = decideControl({ scenario: issued.scenario, modes: issued.modes, posterior: { alpha: 14, beta: 3 }, voi: 0.2 });
    assert.equal(control.stop, false);
    assert.equal(receipt.from, "technology");
    assert.equal(workflow.verify().length, 0);
    assert.equal(manifestSummary(issued).includes("floor=F1"), true);
    assert.equal(strictestFloor("F2", "F1"), "F1");
    assert.equal(canRead(credential(), ref("tool", "tool.deploy")), true);
    assert.equal(new BehaviorRegistry().forScenario("engineering").obligations.includes("run-tests"), true);
    assert.equal(new GovernanceBudget({ global: { cap: {}, elasticity: "low" }, reserve: { cap: {}, elasticity: "low" }, now: () => At }).charge({ scope: "global", amount: { tokens: 1 }, reason: "x" }).code, "charged");
    assert.throws(() => perspective("ceo"), GovernanceError);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
