#!/usr/bin/env node
/**
 * Durable governance-object store checks.
 *
 * The audit chain proves what happened; the store lets a new process resume
 * with the latest manifest, credentials and receipts. Both are append-only
 * JSONL, and both must reject an edited file on open.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttentionManifestDraft } from "../src/governance/index.ts";
import {
    ContextLayers,
    GovernanceStore,
    constraintsFor,
    createAttentionManifest,
    issueCredential,
} from "../src/governance/index.ts";
import type { GlobalCore } from "../src/governance/context.ts";
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
    id: "mft.store.1",
    perspective: "technology",
    scenario: "engineering",
    focus: [{ target: { kind: "goal", id: "goal.store" }, category: "goal", priority: 0.9, depth: 2 }],
    budget: { scope: "perspective", perspective: "technology", cap: { tokens: 1000 }, elasticity: "high" },
    constraints: constraintsFor("engineering"),
    derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
    issuedAt: At,
};

const core: GlobalCore = {
    goal: "persist the governance state",
    strategy: { version: 1, digest: "sha256:strategy", summary: "evidence first", detail: "full record" },
    constraints: ["no irreversible write"],
    priorities: ["correctness"],
    taskState: "executing",
    scenario: "engineering",
    modes: { affect: 0.05, think: 0.35, diverge: 0.1, converge: 0.5 },
    budget: { tokens: 1000 },
    version: 1,
};

await test("manifests, credentials and receipts survive a reopen", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "amp-store-"));
    const file: string = join(directory, "governance.jsonl");
    try {
        const manifest = createAttentionManifest(draft, signers);
        const credential = issueCredential(
            {
                from: "general-manager",
                to: "technology",
                reason: "store test",
                visibleScope: [{ kind: "goal", id: "goal.store" }],
                payloadRefs: [],
                budget: { quota: { tokens: 1000 }, elasticity: "high" },
                constraints: constraintsFor("engineering"),
                manifest: { id: manifest.id, version: manifest.version },
                scenario: "engineering",
                issuedAt: At,
            },
            signers,
        );
        const layers = new ContextLayers({ core, now: () => At });
        layers.openPerspective("technology", { id: manifest.id, version: manifest.version });
        const receipt = layers.writeReceipt("technology", {
            conclusion: "store works",
            evidence: [{ kind: "evidence", id: "ev.1" }],
            confidence: 0.8,
            budget: { tokens: 10 },
            manifest: { id: manifest.id, version: manifest.version },
            scenario: "engineering",
            modes: manifest.modes,
        });
        const store = await GovernanceStore.open(new FileAppendSink(file));
        await store.saveManifest(manifest);
        await store.saveCredential(credential);
        await store.saveReceipt(receipt);
        assert.equal(store.count, 3);
        assert.equal(store.getManifest(manifest.id)?.id, manifest.id);

        const reopened = await GovernanceStore.open(new FileAppendSink(file));
        assert.equal(reopened.count, 3);
        assert.deepEqual(reopened.verify(), { ok: true, reasons: [] });
        assert.equal(reopened.snapshot().manifests.length, 1);
        assert.equal(reopened.snapshot().credentials.length, 1);
        assert.equal(reopened.snapshot().receipts.length, 1);
        assert.equal(reopened.getCredential(credential.id)?.to, "technology");
        assert.equal(reopened.getReceipt(receipt.id)?.conclusion, "store works");

        const lines: string[] = readFileSync(file, "utf8").split(/\r?\n/).filter((line: string) => line.length > 0);
        const parsed = JSON.parse(lines[0]) as { payload: { value: { id: string } } };
        parsed.payload.value.id = "mft.tampered";
        writeFileSync(file, `${lines.map((line: string, index: number) => (index === 0 ? JSON.stringify(parsed) : line)).join("\n")}\n`, "utf8");
        await assert.rejects(() => GovernanceStore.open(new FileAppendSink(file)), /verification|hash|mismatch|modified/i);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
