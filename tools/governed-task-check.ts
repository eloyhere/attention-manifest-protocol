#!/usr/bin/env node
/**
 * Governed-task checks: the adapter between the governance layer and the
 * cognitive runtime.
 *
 * These tests use the real runtime with a scripted model, so they prove the
 * wrapper does not bypass scoring, context assembly or receipts. The negative
 * cases never call the model at all.
 */
import assert from "node:assert/strict";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { ScriptedLlm } from "../src/module/llm/llm.ts";
import { CognitiveRuntime } from "../src/runtime/cognitiveRuntime.ts";
import { GovernedTask } from "../src/runtime/governedTask.ts";
import type { LlmResponse } from "../src/module/llm/llm.ts";
import type { AttentionManifest, AttentionManifestDraft, CredentialDraft, SwitchCredential } from "../src/governance/index.ts";
import {
    ContextLayers,
    GovernanceAuditLog,
    GovernanceBudget,
    LegalGate,
    constraintsFor,
    createAttentionManifest,
    issueCredential,
} from "../src/governance/index.ts";
import type { GlobalCore } from "../src/governance/context.ts";
import type { Ref } from "../src/types/common.ts";

const At: string = "2026-10-28T00:00:00.000Z";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => Promise<void>) => Promise<void> = async (name: string, fn: () => Promise<void>): Promise<void> => {
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

const ref: (kind: Ref["kind"], id: string) => Ref = (kind: Ref["kind"], id: string): Ref => ({ kind, id });

const store: InMemoryAgentStore = new InMemoryAgentStore();
const social: InMemorySocialStore = new InMemorySocialStore();
const service: AgentService = new AgentService(store, social);
service.createAgent({
    pid: 1,
    id: "a.governed",
    name: "Ada Governed",
    values: ["truth"],
    constraints: ["do not fabricate evidence"],
    narrative: "I work inside a signed mandate.",
    at: At,
});
service.addRole({
    id: "role.engineer",
    label: "Engineer",
    obligations: [{ id: "ob.test", statement: "test before shipping" }],
    audiences: ["team"],
    createdAt: At,
});
service.assignRole({ pid: 1, roleId: "role.engineer", salience: 0.9, active: true, since: At });
service.remember({ pid: 1, kind: "procedural", content: "Run the migration before the integration tests.", salience: 0.9, at: At });
service.setAffect(1, { valence: 0.2, arousal: 0.3, stress: 0.3, fatigue: 0.2, mood: "focused" }, At);
service.createInstitution({ id: "org.team", name: "Team", norms: ["blameless review"] });
service.joinInstitution({ pid: 1, institutionId: "org.team", role: "responder", since: At });

const core: () => GlobalCore = (): GlobalCore => ({
    goal: "ship the checkout fix",
    strategy: { version: 1, digest: "sha256:strategy", summary: "reliability first", detail: "full board record" },
    constraints: ["no irreversible write without approval"],
    priorities: ["availability"],
    taskState: "executing",
    scenario: "engineering",
    modes: { affect: 0.05, think: 0.35, diverge: 0.1, converge: 0.5 },
    budget: { tokens: 2000 },
    version: 1,
});

const signers: ReadonlyArray<{ role: "issuer" | "legal" | "finance"; by: "general-manager" | "legal" | "finance"; at: string }> = [
    { role: "issuer", by: "general-manager", at: At },
    { role: "legal", by: "legal", at: At },
    { role: "finance", by: "finance", at: At },
];

const manifestDraft: (patch?: Partial<AttentionManifestDraft>) => AttentionManifestDraft = (patch: Partial<AttentionManifestDraft> = {}): AttentionManifestDraft => ({
    id: "mft.eng.task",
    perspective: "technology",
    scenario: "engineering",
    focus: [{ target: ref("goal", "goal.checkout"), category: "goal", priority: 0.9, depth: 2 }],
    ignore: [],
    budget: { scope: "perspective", perspective: "technology", cap: { tokens: 1500 }, elasticity: "high" },
    constraints: constraintsFor("engineering"),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
    ...patch,
});

const credentialDraft: (manifest: AttentionManifest) => CredentialDraft = (manifest: AttentionManifest): CredentialDraft => ({
    id: "crd.eng.task",
    from: "general-manager",
    to: "technology",
    reason: "run the checkout incident",
    visibleScope: [ref("goal", "goal.checkout"), ref("evidence", "ev.1")],
    payloadRefs: [ref("goal", "goal.checkout")],
    budget: { quota: { tokens: 1500 }, elasticity: "high" },
    constraints: constraintsFor("engineering"),
    manifest: { id: manifest.id, version: manifest.version },
    scenario: "engineering",
    issuedAt: At,
    ttlMs: 10 * 60 * 1000,
});

interface HarnessOptions {
    manifest?: AttentionManifest;
    credential?: SwitchCredential;
    clock?: string;
    cap?: number;
    elasticity?: "low" | "medium" | "high";
    audit?: GovernanceAuditLog;
}

interface Harness {
    task: GovernedTask;
    manifest: AttentionManifest;
    credential: SwitchCredential;
    budget: GovernanceBudget;
    legal: LegalGate;
    clock: { at: string };
    audit?: GovernanceAuditLog;
}

const response: () => LlmResponse = (): LlmResponse => ({
    text: "The checkout lock is held by the migration job; run the migration before the integration tests.",
    usage: { inputTokens: 40, outputTokens: 12, cacheHitTokens: 0, cacheMissTokens: 40 },
    finishReason: "stop",
});

const harness: (options?: HarnessOptions) => Harness = (options: HarnessOptions = {}): Harness => {
    const clock: { at: string } = { at: options.clock ?? At };
    const manifest: AttentionManifest = options.manifest ?? createAttentionManifest(manifestDraft(), signers);
    const credential: SwitchCredential = options.credential ?? issueCredential(credentialDraft(manifest), signers);
    const budget: GovernanceBudget = new GovernanceBudget({
        global: { cap: { tokens: 4000 }, elasticity: "medium" },
        reserve: { cap: { tokens: 1000 }, elasticity: "low" },
        perspectives: [{ perspective: "technology", cap: { tokens: options.cap ?? 1500 }, elasticity: options.elasticity ?? "high" }],
        now: () => clock.at,
    });
    const legal: LegalGate = new LegalGate({ now: () => clock.at });
    const context: ContextLayers = new ContextLayers({ core: core(), now: () => clock.at });
    const runtime: CognitiveRuntime = new CognitiveRuntime({ pid: 1, agent: store, social, llm: new ScriptedLlm([response()]), budgetTokens: 400 });
    const task: GovernedTask = new GovernedTask({
        runtime,
        manifest,
        credential,
        budget,
        legal,
        context,
        ...(options.audit === (void 0) ? {} : { audit: options.audit }),
        now: () => clock.at,
    });
    return { task, manifest, credential, budget, legal, clock, ...(options.audit === (void 0) ? {} : { audit: options.audit }) };
};

await test("a governed turn runs the real runtime, charges and writes a receipt", async () => {
    const fixture: Harness = harness();
    const result = await fixture.task.turn("why is checkout locked?");
    assert.equal(result.turn.answer.includes("migration job"), true);
    assert.equal(result.receipt.from, "technology");
    assert.equal(result.receipt.manifest.version, 1);
    assert.equal(result.charge.ok, true);
    assert.equal(result.charge.code, "charged");
    assert.equal(result.charge.ledger.used.tokens, 52);
    assert.equal(result.credential?.verdict, "valid");
    assert.equal(result.control.mean > 0, true);
    assert.equal(result.legal.length, 0);
    assert.equal(result.manifest.focus.length, 1);
});

await test("a frozen perspective is rejected before the model is called", async () => {
    const fixture: Harness = harness();
    fixture.legal.enforceTool({ perspective: "technology", scenario: "engineering", action: "exfiltrate", effect: "read" });
    await assert.rejects(() => fixture.task.turn("continue"), /frozen/);
});

await test("an expired manifest never reaches generation", async () => {
    const manifest: AttentionManifest = createAttentionManifest(manifestDraft({ ttlMs: 1_000 }), signers);
    const fixture: Harness = harness({ manifest, credential: issueCredential(credentialDraft(manifest), signers), clock: "2026-10-28T00:00:02.000Z" });
    await assert.rejects(() => fixture.task.turn("continue"), /expired/);
});

await test("a stale credential is rejected even when the manifest is valid", async () => {
    const fixture: Harness = harness({ clock: "2026-10-28T00:11:00.000Z" });
    await assert.rejects(() => fixture.task.turn("continue"), /credential/);
});

await test("an overrun is visible in the settled result instead of being hidden", async () => {
    const fixture: Harness = harness({ cap: 20, elasticity: "low" });
    const result = await fixture.task.turn("why is checkout locked?");
    assert.equal(result.charge.ok, false);
    assert.equal(result.charge.code, "exhausted");
    assert.equal(result.charge.ledger.frozen, true);
    assert.equal(result.turn.answer.length > 0, true);
});

await test("a settled turn is appended to the audit chain", async () => {
    const audit: GovernanceAuditLog = await GovernanceAuditLog.open({ now: () => At });
    const fixture: Harness = harness({ audit });
    const result = await fixture.task.turn("why is checkout locked?");
    assert.equal(result.audit?.record.action, "runtime.turn");
    assert.equal(result.audit?.record.category, "runtime");
    assert.equal(audit.count, 1);
    assert.deepEqual(audit.verify(), { ok: true, reasons: [] });
    assert.equal(audit.byCategory("runtime").length, 1);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
