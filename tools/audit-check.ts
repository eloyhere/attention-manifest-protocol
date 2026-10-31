#!/usr/bin/env node
/**
 * Governance audit-chain checks.
 *
 * The chain must survive a reopen, reject tampering and corruption, and accept
 * the records produced by every governance object. A governed runtime turn is
 * covered by governed-task-check; this script exercises the audit API itself.
 */
import assert from "node:assert/strict";

import type { GlobalCore } from "../src/governance/context.ts";
import type { AttentionManifestDraft } from "../src/governance/index.ts";
import {
    ContextLayers,
    GovernanceAuditLog,
    GovernanceBudget,
    LegalGate,
    Workflow,
    constraintsFor,
    createAttentionManifest,
    issueCredential,
} from "../src/governance/index.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryAppendSink } from "../src/storage/appendLog.ts";
import { FileAppendSink } from "../src/storage/fileAppendSink.ts";

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

const signers = [
    { role: "issuer" as const, by: "general-manager" as const, at: At },
    { role: "legal" as const, by: "legal" as const, at: At },
    { role: "finance" as const, by: "finance" as const, at: At },
];

const draft: AttentionManifestDraft = {
    id: "mft.audit.1",
    perspective: "technology",
    scenario: "engineering",
    focus: [{ target: { kind: "goal", id: "goal.audit" }, category: "goal", priority: 0.9, depth: 2 }],
    budget: { scope: "perspective", perspective: "technology", cap: { tokens: 1000 }, elasticity: "high" },
    constraints: constraintsFor("engineering"),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
};

const core: GlobalCore = {
    goal: "audit the turn",
    strategy: { version: 1, digest: "sha256:strategy", summary: "evidence first", detail: "full record" },
    constraints: ["no irreversible write"],
    priorities: ["correctness"],
    taskState: "executing",
    scenario: "engineering",
    modes: { affect: 0.05, think: 0.35, diverge: 0.1, converge: 0.5 },
    budget: { tokens: 1000 },
    version: 1,
};

await test("every governance object appends a verifiable record", async () => {
    const sink = new MemoryAppendSink();
    const log: GovernanceAuditLog = await GovernanceAuditLog.open({ sink, now: () => At });
    const manifest = createAttentionManifest(draft, signers);
    const credential = issueCredential(
        {
            from: "general-manager",
            to: "technology",
            reason: "audit run",
            visibleScope: [{ kind: "goal", id: "goal.audit" }],
            payloadRefs: [],
            budget: { quota: { tokens: 1000 }, elasticity: "high" },
            constraints: constraintsFor("engineering"),
            manifest: { id: manifest.id, version: manifest.version },
            scenario: "engineering",
            issuedAt: At,
        },
        signers,
    );
    const budget = new GovernanceBudget({
        global: { cap: { tokens: 4000 }, elasticity: "medium" },
        reserve: { cap: { tokens: 1000 }, elasticity: "low" },
        perspectives: [{ perspective: "technology", cap: { tokens: 1000 }, elasticity: "high" }],
        now: () => At,
    });
    const charge = budget.charge({ scope: "perspective", perspective: "technology", amount: { tokens: 120 }, reason: "turn" });
    const legal = new LegalGate({ now: () => At });
    const verdict = legal.checkTool({ perspective: "technology", scenario: "engineering", action: "test", effect: "read" });
    const workflow = Workflow.start({ id: "wf.audit", scenario: "engineering", at: At });
    const layers = new ContextLayers({ core, now: () => At });
    layers.openPerspective("technology", { id: manifest.id, version: manifest.version });
    const receipt = layers.writeReceipt("technology", {
        conclusion: "the audit chain accepts the receipt",
        evidence: [{ kind: "evidence", id: "ev.1" }],
        confidence: 0.8,
        budget: { tokens: 120 },
        manifest: { id: manifest.id, version: manifest.version },
        scenario: "engineering",
        modes: manifest.modes,
    });
    await log.recordManifest(manifest, "general-manager");
    await log.recordCredential(credential);
    await log.recordReceipt(receipt);
    await log.recordCharge(charge, "technology", "technology");
    await log.recordLegal(verdict, "legal");
    await log.recordWorkflow(workflow.current(), "general-manager");
    await log.recordSwitch(credential, "peer", "general-manager");
    await log.recordTurn({
        turnId: "rt.audit.1",
        perspective: "technology",
        manifest: { id: manifest.id, version: manifest.version, digest: manifest.digest },
        tokens: 120,
        charge,
        control: { action: "hold", stop: false, escalate: false, approvalRequired: false },
        receiptId: receipt.id,
    });
    assert.equal(log.count, 8);
    assert.deepEqual(log.verify(), { ok: true, reasons: [] });
    assert.equal(log.byCategory("manifest").length, 1);
    assert.equal(log.byCategory("runtime").length, 1);
    assert.equal(log.bySubject("mft.audit.1").length, 1);
    assert.equal(log.entries()[0].prev.startsWith("sha256:"), true);

    const reopened: GovernanceAuditLog = await GovernanceAuditLog.open({ sink, now: () => At });
    assert.equal(reopened.count, 8);
    assert.deepEqual(reopened.verify(), { ok: true, reasons: [] });
    assert.equal(reopened.entries()[7].record.action, "runtime.turn");
});

await test("tampering and corruption fail closed", async () => {
    const sink = new MemoryAppendSink();
    const log: GovernanceAuditLog = await GovernanceAuditLog.open({ sink, now: () => At });
    await log.record({ category: "manifest", action: "manifest.issued", actor: "general-manager", subject: "mft.x", detail: "v1" });
    const entries = log.entries();
    entries[0].record.detail = "edited copy";
    assert.equal(log.verify().ok, true);
    const lines: string[] = sink.lines;
    const parsed = JSON.parse(lines[0]) as { payload: { detail: string } };
    parsed.payload.detail = "edited in storage";
    lines[0] = JSON.stringify(parsed);
    assert.equal(log.verify().ok, true);
    await assert.rejects(() => GovernanceAuditLog.open({ sink }), /verification|hash|mismatch|modified/i);
    await assert.rejects(
        () => log.record({ category: "manifest", action: "", actor: "general-manager", detail: "empty action" }),
        /invalid audit record/,
    );
    const badSink = new MemoryAppendSink(["not-json"]);
    await assert.rejects(() => GovernanceAuditLog.open({ sink: badSink }), /verification|JSON|parse|malformed/i);
});

await test("the audit chain survives a file sink and a process restart", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "amp-audit-"));
    const file: string = join(directory, "governance.jsonl");
    try {
        const sink = new FileAppendSink(file);
        const log: GovernanceAuditLog = await GovernanceAuditLog.open({ sink, now: () => At });
        await log.record({ category: "manifest", action: "manifest.issued", actor: "general-manager", subject: "mft.file", detail: "v1" });
        await log.record({ category: "runtime", action: "runtime.turn", actor: "technology", subject: "rt.file", detail: "tokens=1" });
        assert.equal(log.count, 2);
        const reopened: GovernanceAuditLog = await GovernanceAuditLog.open({ sink: new FileAppendSink(file), now: () => At });
        assert.equal(reopened.count, 2);
        assert.deepEqual(reopened.verify(), { ok: true, reasons: [] });
        assert.equal(reopened.entries()[1].record.action, "runtime.turn");

        const lines: string[] = readFileSync(file, "utf8").split(/\r?\n/).filter((line: string) => line.length > 0);
        const parsed = JSON.parse(lines[0]) as { payload: { detail: string } };
        parsed.payload.detail = "edited on disk";
        writeFileSync(file, `${lines.map((line: string, index: number) => (index === 0 ? JSON.stringify(parsed) : line)).join("\n")}\n`, "utf8");
        await assert.rejects(() => GovernanceAuditLog.open({ sink: new FileAppendSink(file) }), /verification|hash|mismatch|modified/i);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

await test("audit checkpoints seal a retained segment", async () => {
    const log: GovernanceAuditLog = await GovernanceAuditLog.open({ now: () => At });
    await log.record({ category: "manifest", action: "manifest.issued", actor: "general-manager", subject: "mft.cp", detail: "v1" });
    await log.record({ category: "credential", action: "credential.issued", actor: "general-manager", subject: "crd.cp", detail: "issued" });
    const checkpoint = log.checkpoint();
    assert.equal(checkpoint.count, 2);
    assert.deepEqual(log.verifyCheckpoint(checkpoint), { ok: true, reasons: [] });
    await log.record({ category: "runtime", action: "runtime.turn", actor: "technology", subject: "rt.cp", detail: "tokens=1" });
    assert.deepEqual(log.verifyCheckpoint(checkpoint), { ok: true, reasons: [] });
    assert.equal(log.entriesAfter(checkpoint.count).length, 1);
    const tampered = { ...checkpoint, tip: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
    assert.equal(log.verifyCheckpoint(tampered).ok, false);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
