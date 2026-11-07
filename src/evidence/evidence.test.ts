import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceLedger } from "./index.ts";
import { advanceEvidence, EVIDENCE_TRANSITIONS } from "./index.ts";
import type { AddEvidenceInput, EvidenceLevel, EvidenceSourceType, EvidenceStatus } from "./index.ts";
import { createInvocation, createObservation, createReceiptCore, verifyReceiptIntegrity } from "../receipt/index.ts";
import { verifyBusinessSemantics } from "../verification/index.ts";
import type { ExecutionContext } from "../shared.ts";

const now = "2026-01-01T00:00:00.000Z";
const context = (tenantId: string): ExecutionContext => ({
    tenantId,
    principalId: "principal",
    agentId: "agent",
    sessionId: "session",
    operationId: "operation",
    attemptId: "attempt",
    executionId: "execution",
    policyVersion: "policy/1",
    cancellationEpoch: 0,
});

async function facts(tenantId = "tenant-a") {
    const invocation = createInvocation({ id: `invocation-${tenantId}`, context: context(tenantId), toolId: "tool", arguments: null, createdAt: now });
    const observation = createObservation({ id: `observation-${tenantId}`, invocationId: invocation.id, status: "success", value: { result: "ok" }, observedAt: now });
    const receipt = createReceiptCore({ id: `receipt-${tenantId}`, invocation, observation, issuedAt: now, payloadDigest: "digest", hashAlgorithm: "sha256-test" });
    const integrity = await verifyReceiptIntegrity(receipt, { digest: () => "digest", verifier: "integrity", verifiedAt: now });
    const verification = await verifyBusinessSemantics(receipt, integrity, { id: `verification-${tenantId}`, verifier: "business", verifiedAt: now, criteriaVersion: "criteria-v1" }, () => true, ["claim"]);
    return { receipt, integrity, verification };
}

async function setup(tenantId = "tenant-a") {
    const verified = await facts(tenantId);
    const ledger = new EvidenceLedger();
    const add = (id: string, patch: Partial<AddEvidenceInput> = {}) => ledger.add({
        id,
        tenantId,
        claim: "claim",
        polarity: "supports",
        receipt: verified.receipt,
        integrity: verified.integrity,
        verification: verified.verification,
        criteriaVersion: "criteria-v1",
        environmentVersion: "env-v1",
        createdAt: now,
        ...patch,
    });
    return { ledger, add, verified };
}

test("evidence extensions persist level, source and consumption metadata frozen", async () => {
    const { ledger, add } = await setup();
    const evidence = add("evidence-1", {
        level: "action",
        parentId: "parent-evidence",
        agentId: "agent",
        cooperationId: "cooperation",
        sessionId: "session",
        turnId: "turn",
        source: {
            type: "operation_history",
            sourceId: "run-1",
            domain: "repository",
            tool: "shell",
            instruction: "read",
            reliability: 0.9,
            origin: "original",
            reproducible: true,
            independenceKey: "operation_history:run-1",
        },
        corroborationIds: ["witness-1"],
        consumedBy: ["conclusion-1"],
        supersededBy: "evidence-2",
        freshnessScore: 0.75,
    });
    assert.equal(evidence.level, "action");
    assert.equal(evidence.parentId, "parent-evidence");
    assert.equal(evidence.agentId, "agent");
    assert.equal(evidence.cooperationId, "cooperation");
    assert.equal(evidence.sessionId, "session");
    assert.equal(evidence.turnId, "turn");
    assert.equal(evidence.source?.type, "operation_history");
    assert.equal(evidence.source?.reliability, 0.9);
    assert.equal(evidence.source?.origin, "original");
    assert.equal(evidence.source?.reproducible, true);
    assert.equal(evidence.source?.independenceKey, "operation_history:run-1");
    assert.deepEqual(evidence.corroborationIds, ["witness-1"]);
    assert.deepEqual(evidence.consumedBy, ["conclusion-1"]);
    assert.equal(evidence.supersededBy, "evidence-2");
    assert.equal(evidence.freshnessScore, 0.75);
    assert.equal(Object.isFrozen(evidence), true);
    assert.equal(Object.isFrozen(evidence.source), true);
    assert.equal(Object.isFrozen(evidence.corroborationIds), true);
    assert.equal(Object.isFrozen(evidence.consumedBy), true);
    assert.throws(() => {
        (evidence.source as unknown as { reliability: number }).reliability = 0;
    }, TypeError);
    assert.throws(() => {
        (evidence.corroborationIds as unknown as string[]).push("other");
    }, TypeError);
    assert.equal(ledger.get("evidence-1", "tenant-a")?.id, "evidence-1");
});

test("source reliability accepts only the inclusive 0..1 interval", async () => {
    const { add } = await setup();
    const low = add("reliability-0", { source: { type: "dialogue", reliability: 0 } });
    const high = add("reliability-1", { source: { type: "system_rule", reliability: 1 } });
    assert.equal(low.source?.reliability, 0);
    assert.equal(high.source?.reliability, 1);
    for (const [index, reliability] of [-0.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].entries()) {
        assert.throws(() => add(`invalid-reliability-${index}`, { source: { type: "web_search", reliability } }), /reliability/);
    }
});

test("evidence lineage fields reject empty identifiers", async () => {
    const { add } = await setup();
    for (const field of ["parentId", "agentId", "cooperationId", "sessionId", "turnId"] as const) {
        assert.throws(() => add(`invalid-${field}`, { [field]: "" }), new RegExp(field));
    }
});

test("captured evidence can only normalize before validation and activation", () => {
    assert.equal(advanceEvidence("captured", "normalized"), "normalized");
    assert.equal(advanceEvidence("normalized", "validated"), "validated");
    assert.equal(advanceEvidence("validated", "active"), "active");
    assert.throws(() => advanceEvidence("captured", "active"), /invalid evidence transition/);
});

test("invalid evidence level, source type, origin and freshness are rejected", async () => {
    const { add } = await setup();
    assert.throws(() => add("invalid-level", { level: "bogus" as EvidenceLevel }), /invalid evidence level/);
    assert.throws(() => add("invalid-source", { source: { type: "bogus" as EvidenceSourceType, reliability: 0.5 } }), /invalid evidence source type/);
    assert.throws(() => add("invalid-origin", { source: { type: "dialogue", reliability: 0.2, origin: "third" as "original" } }), /origin/);
    assert.throws(() => add("invalid-freshness", { freshnessScore: 1.01 }), /freshnessScore/);
    assert.throws(() => add("invalid-freshness-low", { freshnessScore: -0.01 }), /freshnessScore/);
    assert.throws(() => add("duplicate-corroboration", { corroborationIds: ["witness", "witness"] }), /duplicate/);
    assert.throws(() => add("self-consumed", { consumedBy: ["self-consumed"] }), /itself/);
    assert.throws(() => add("self-superseded", { supersededBy: "self-superseded" }), /itself/);
});

test("evidence lifecycle transitions follow the documented superset", () => {
    const path: readonly EvidenceStatus[] = [
        "validated", "active", "corroborated", "active", "contested",
        "arbitrated", "active", "stale", "active", "superseded", "archived", "purged",
    ];
    let status: EvidenceStatus = "normalized";
    for (const next of path) status = advanceEvidence(status, next);
    assert.equal(status, "purged");
    assert.equal(advanceEvidence("active", "corroborated"), "corroborated");
    assert.equal(advanceEvidence("stale", "active"), "active");
    assert.equal(advanceEvidence("contested", "arbitrated"), "arbitrated");
    assert.throws(() => advanceEvidence("normalized", "active"), /invalid evidence transition/);
    assert.throws(() => advanceEvidence("purged", "active"), /invalid evidence transition/);
    assert.throws(() => advanceEvidence("active", "validated"), /invalid evidence transition/);
    assert.equal(Object.isFrozen(EVIDENCE_TRANSITIONS), true);
    assert.equal(Object.isFrozen(EVIDENCE_TRANSITIONS.active), true);
    assert.throws(() => {
        (EVIDENCE_TRANSITIONS.active as unknown as EvidenceStatus[]).push("purged");
    }, TypeError);
});

test("evidence status validation rejects values outside the supported union", () => {
    assert.throws(() => advanceEvidence("bogus" as EvidenceStatus, "active"), /invalid evidence status/);
    assert.throws(() => advanceEvidence("active", "bogus" as EvidenceStatus), /invalid evidence status/);
    assert.throws(() => advanceEvidence("bogus" as EvidenceStatus, "active"), TypeError);
});

test("advanceEvidence returns a new frozen item without mutating the original", async () => {
    const { add } = await setup();
    const active = add("advance", { level: "task", source: { type: "user_confirmation", reliability: 0.8, independenceKey: "user:1" } });
    const corroborated = advanceEvidence(active, "corroborated");
    assert.equal(active.status, "active");
    assert.equal(corroborated.status, "corroborated");
    assert.notEqual(corroborated, active);
    assert.equal(Object.isFrozen(corroborated), true);
    assert.equal(Object.isFrozen(corroborated.source), true);
    assert.equal(corroborated.level, "task");
});

test("corroborate marks independent evidence corroborated and consumable", async () => {
    const { ledger, add } = await setup();
    add("target", { source: { type: "operation_history", reliability: 0.9, independenceKey: "operation:1" } });
    add("witness", { source: { type: "web_search", reliability: 0.6, independenceKey: "search:1" } });
    const corroborated = ledger.corroborate("target", "witness");
    assert.equal(corroborated.status, "corroborated");
    assert.deepEqual(corroborated.corroborationIds, ["witness"]);
    assert.equal(ledger.get("target", "tenant-a")?.status, "corroborated");
    assert.equal(ledger.getConsumable("target", "tenant-a", now)?.id, "target");
    assert.ok(ledger.auditEvents().some(event => event.type === "evidence_corroborated"));
    const repeated = ledger.corroborate("target", "witness");
    assert.deepEqual(repeated.corroborationIds, ["witness"]);
    assert.throws(() => ledger.corroborate("target", "target"), /itself/);
    assert.throws(() => ledger.corroborate("absent", "witness"), /Unknown evidence/);
});

test("same independenceKey is deduplicated and never counted twice", async () => {
    const { ledger, add } = await setup();
    add("target", { source: { type: "operation_history", reliability: 0.9, independenceKey: "same-origin" } });
    add("duplicate", { source: { type: "operation_history", reliability: 0.9, independenceKey: "same-origin" } });
    add("independent", { source: { type: "operation_history", reliability: 0.9, independenceKey: "other-origin" } });
    const sameOrigin = ledger.corroborate("target", "duplicate");
    assert.equal(sameOrigin.status, "active");
    assert.equal(sameOrigin.corroborationIds, undefined);
    const independent = ledger.corroborate("target", "independent");
    assert.equal(independent.status, "corroborated");
    assert.deepEqual(independent.corroborationIds, ["independent"]);
});

test("markStale is idempotent and propagates to dependents", async () => {
    const { ledger, add } = await setup();
    add("root");
    add("child", { dependsOn: ["root"] });
    const before = ledger.auditEvents().length;
    const first = ledger.markStale("root", "tenant-a", "environment drift", now);
    assert.deepEqual([...first].sort(), ["child", "root"]);
    assert.equal(ledger.get("root", "tenant-a")?.status, "stale");
    assert.equal(ledger.get("child", "tenant-a")?.status, "stale");
    assert.equal(ledger.getConsumable("child", "tenant-a", now), undefined);
    const afterFirst = ledger.auditEvents().length;
    assert.ok(afterFirst > before);
    const second = ledger.markStale("root", "environment drift");
    assert.deepEqual([...second].sort(), ["child", "root"]);
    assert.equal(ledger.get("root", "tenant-a")?.status, "stale");
    assert.equal(ledger.auditEvents().length, afterFirst);
    assert.throws(() => ledger.markStale("absent", "tenant-a", "environment drift", now), /Unknown evidence/);
    assert.throws(() => ledger.markStale("absent", "environment drift"), /Unknown evidence/);
});

test("revocation propagates through consumedBy conclusions", async () => {
    const { ledger, add } = await setup();
    add("source", { consumedBy: ["conclusion"] });
    add("conclusion");
    const changed = ledger.revoke("source", "tenant-a", "source withdrawn", now);
    assert.deepEqual([...changed].sort(), ["conclusion", "source"]);
    assert.equal(ledger.get("conclusion", "tenant-a")?.status, "pending_revalidation");
    assert.equal(ledger.getConsumable("conclusion", "tenant-a", now), undefined);
});

test("consumedBy revocation propagates across multiple conclusion levels", async () => {
    const { ledger, add } = await setup();
    add("source", { consumedBy: ["conclusion"] });
    add("conclusion", { consumedBy: ["aggregate"] });
    add("aggregate");
    const changed = ledger.revoke("source", "source withdrawn");
    assert.deepEqual([...changed].sort(), ["aggregate", "conclusion", "source"]);
    assert.equal(ledger.get("conclusion", "tenant-a")?.status, "pending_revalidation");
    assert.equal(ledger.get("aggregate", "tenant-a")?.status, "pending_revalidation");
    assert.ok(ledger.auditEvents().some(event => event.type === "evidence_staled" && event.evidenceId === "aggregate"));
});

test("revocation of corroborated evidence still invalidates dependents", async () => {
    const { ledger, add } = await setup();
    add("root", { source: { type: "operation_history", reliability: 0.9, independenceKey: "operation:1" } });
    add("witness", { source: { type: "web_search", reliability: 0.6, independenceKey: "search:1" } });
    add("child", { dependsOn: ["root"] });
    ledger.corroborate("root", "witness");
    const changed = ledger.revoke("root", "source withdrawn");
    assert.deepEqual([...changed].sort(), ["child", "root"]);
    assert.equal(ledger.get("root", "tenant-a")?.status, "revoked");
    assert.equal(ledger.get("child", "tenant-a")?.status, "pending_revalidation");
    assert.equal(ledger.getConsumable("root", "tenant-a", now), undefined);
    assert.equal(ledger.getConsumable("child", "tenant-a", now), undefined);
    assert.throws(() => ledger.markStale("root", "tenant-a", "late", now), /cannot be marked stale/);
});
