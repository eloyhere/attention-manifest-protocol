#!/usr/bin/env node
/**
 * Pre-execution tool gate checks.
 *
 * The point is ordering: a destructive tool must be denied before the executor
 * runs, not audited after it. The policy also honours legal freeze, the breaker
 * and the manifest's evidence floor.
 */
import assert from "node:assert/strict";

import type { ApprovalGrant, AttentionManifestDraft } from "../src/governance/index.ts";
import {
    GovernedToolPolicy,
    LegalGate,
    constraintsFor,
    createAttentionManifest,
} from "../src/governance/index.ts";

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

const manifest = createAttentionManifest(
    {
        id: "mft.tool.1",
        perspective: "technology",
        scenario: "engineering",
        focus: [{ target: { kind: "goal", id: "goal.tool" }, category: "goal", priority: 0.9, depth: 2 }],
        budget: { scope: "perspective", perspective: "technology", cap: { tokens: 1000 }, elasticity: "high" },
        constraints: constraintsFor("engineering"),
        derivation: { strategyVersion: 1, strategyDigest: "sha256:strategy", derivedAt: At },
        issuedAt: At,
    } satisfies AttentionManifestDraft,
    [
        { role: "issuer", by: "general-manager", at: At },
        { role: "legal", by: "legal", at: At },
        { role: "finance", by: "finance", at: At },
    ],
);

const approval: ApprovalGrant = { id: "apv.tool", subject: "tool.high-risk", by: "legal", at: At, granted: true };
const invocation = { tool: "shell", args: { command: "rm -rf build" } };
const destructive = { name: "shell", description: "run a shell command", inputSchema: {}, risk: "destructive" as const };
const read = { name: "read_file", description: "read a file", inputSchema: {}, risk: "read" as const };

await test("a destructive tool is denied before the executor runs", async () => {
    const legal = new LegalGate({ now: () => At });
    const policy = new GovernedToolPolicy({ legal, manifest });
    const verdict = await policy.check(invocation, destructive);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason?.includes("tool-unapproved"), true);
    assert.equal((await policy.check({ tool: "read_file", args: {} }, read)).allowed, true);
});

await test("a legal high-risk approval unlocks the tool", async () => {
    const legal = new LegalGate({ now: () => At });
    const policy = new GovernedToolPolicy({ legal, manifest, approval });
    assert.equal((await policy.check(invocation, destructive)).allowed, true);
});

await test("forbidden actions, freeze and breaker deny before execution", async () => {
    const legal = new LegalGate({ now: () => At });
    const policy = new GovernedToolPolicy({ legal, manifest });
    assert.equal((await policy.check({ tool: "exfiltrate", args: {} }, { ...read, name: "exfiltrate" })).allowed, false);
    legal.enforceTool({ perspective: "technology", scenario: "engineering", action: "exfiltrate", effect: "read" });
    assert.equal((await policy.check({ tool: "read_file", args: {} }, read)).allowed, false);
    assert.equal((await policy.check({ tool: "read_file", args: {} }, read)).reason?.includes("frozen"), true);
    legal.reportEmergency("technology", "injection", "injection-detected");
    assert.equal((await policy.check({ tool: "read_file", args: {} }, read)).reason?.includes("breaker"), true);
});

await test("the evidence floor blocks a low-tier destructive call", async () => {
    const legal = new LegalGate({ now: () => At });
    const policy = new GovernedToolPolicy({ legal, manifest, evidenceTier: "T1", approval });
    const verdict = await policy.check(invocation, destructive);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason?.includes("evidence-below-floor"), true);
    const readPolicy = new GovernedToolPolicy({ legal, manifest, evidenceTier: "T3" });
    assert.equal((await readPolicy.check({ tool: "read_file", args: {} }, read)).allowed, true);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
