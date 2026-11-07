import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as attentionOperations from "../attention/operations.ts";
import type { CreateAttentionInput } from "../attention/types.ts";
import { BudgetLedger } from "../budget/ledger.ts";
import { EvidenceLedger } from "../evidence/ledger.ts";
import type { AddEvidenceInput } from "../evidence/types.ts";
import { Project } from "../project/core.ts";
import * as provenance from "../provenance/core.ts";
import type { ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";
import { Store } from "../service/store.ts";
import { openSqlite } from "../sql/index.ts";
import type { BudgetSnapshot } from "../tool/types.ts";
import type { BusinessVerification } from "../verification/types.ts";
import {
    bindAttention,
    bindBudget,
    bindEvidence,
    bindProject,
    bindReceipts,
    rehydrateAll,
} from "./bindings.ts";
import { listEntities, loadEvidence, loadProjectRule, loadReceipt, plainEntity } from "./index.ts";

const TENANT = "tenant-1";
const ROOT = "root-1";
const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const DEADLINE = "2030-01-01T00:00:00.000Z";
const SCOPE = { tenantId: TENANT, rootId: ROOT } as const;

function temporaryDatabase(): { readonly path: string; readonly dispose: () => void } {
    const directory = mkdtempSync(join(tmpdir(), "amp-bindings-"));
    return {
        path: join(directory, "store.sqlite"),
        dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
}

/** Runs one test body against a throwaway database directory. */
async function withDatabase(run: (path: string) => void | Promise<void>): Promise<void> {
    const database = temporaryDatabase();
    try {
        await run(database.path);
    } finally {
        database.dispose();
    }
}

function openStore(path: string): Store {
    return Store.open({ path, now: () => NOW });
}

function createProject(): Project {
    return new Project({ ...SCOPE, clock: () => NOW });
}

function invocationRecord(): Parameters<typeof provenance.createInvocation>[0] {
    return {
        id: "inv-1",
        context: {
            tenantId: TENANT,
            principalId: "user-1",
            agentId: "agent-1",
            sessionId: "session-1",
            operationId: "op-1",
            attemptId: "attempt-1",
            executionId: "exec-1",
            policyVersion: "policy-1",
            cancellationEpoch: 0,
        },
        toolId: "tool-1",
        arguments: null,
        createdAt: NOW,
    };
}

interface ReceiptFacts {
    readonly receipt: ReceiptCore;
    readonly integrity: ReceiptIntegrityVerification;
    readonly verification: BusinessVerification;
}

/** Deterministic in-memory receipt chain; the receipts binding persists it. */
function receiptFacts(): ReceiptFacts {
    const receipt = provenance.createReceiptCore({
        id: "r1",
        invocation: provenance.createInvocation(invocationRecord()),
        observation: provenance.createObservation({ id: "o1", invocationId: "inv-1", status: "success", observedAt: NOW }),
        issuedAt: NOW,
        payloadDigest: "sha256:digest",
        hashAlgorithm: "sha256",
    });
    const integrity: ReceiptIntegrityVerification = {
        id: "integrity:r1",
        receiptId: "r1",
        status: "integrity_verified",
        digestValid: true,
        signatureValid: "not_checked",
        verifier: "test",
        verifiedAt: NOW,
        reasons: [],
    };
    const verification: BusinessVerification = {
        id: "verification:r1",
        observationId: "o1",
        receiptId: "r1",
        status: "semantic_verified",
        claims: ["the effect is observable"],
        criteriaVersion: "criteria-v1",
        verifier: "test",
        verifiedAt: NOW,
    };
    return { receipt, integrity, verification };
}

function evidenceInput(id: string, facts: ReceiptFacts, dependsOn: readonly string[] = []): AddEvidenceInput {
    return {
        id,
        tenantId: TENANT,
        claim: "the effect is observable",
        polarity: "supports",
        receipt: facts.receipt,
        integrity: facts.integrity,
        verification: facts.verification,
        criteriaVersion: "criteria-v1",
        environmentVersion: "env-1",
        createdAt: NOW,
        dependsOn,
    };
}

function attentionInput(): CreateAttentionInput {
    return {
        id: "attention-1",
        summary: "track the accepted effect",
        pointer: { kind: "evidence", id: "e1", version: "1" },
        scope: { tenantId: TENANT, principalId: "user-1", sessionId: "session-1", turnId: "turn-1" },
        budget: { tokens: 100 },
        expiresAt: DEADLINE,
        reason: "created by test",
    };
}

test("project binding writes rules, metadata, views and environment in one store", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindProject(store, createProject());
            binding.putRule({ id: "rule-1", ...SCOPE, text: "first guidance" });
            binding.putRule({ id: "rule-1", ...SCOPE, text: "second guidance", expectedVersion: 1 });
            binding.putMetadata({ path: "src/index.ts", ...SCOPE, tags: ["entry"], ruleIds: ["rule-1"] });
            binding.putView({
                kind: "er",
                ...SCOPE,
                projection: { entities: ["Project"] },
                sourceRuleIds: ["rule-1"],
            });
            binding.configureEnvironment({ variables: { NODE_ENV: "test" }, paths: ["src"] });

            assert.deepEqual(store.events().map(event => event.kind), [
                "project_rule.created",
                "project_rule.transitioned",
                "project_metadata.created",
                "project_view.created",
                "project_environment.created",
            ]);
            const rule = loadProjectRule(store, "rule-1");
            assert.ok(rule);
            assert.equal(plainEntity(rule).version, 2);

            const stats = { entities: store.stats().entities, events: store.stats().events };
            binding.flush();
            assert.equal(store.stats().entities, stats.entities);
            assert.equal(store.stats().events, stats.events);
        } finally {
            store.close();
        }
    });
});

test("project binding restores versioned knowledge and environment after restart", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindProject(store, createProject());
            binding.putRule({ id: "rule-1", ...SCOPE, text: "first guidance" });
            binding.putRule({ id: "rule-1", ...SCOPE, text: "second guidance", expectedVersion: 1 });
            binding.putMetadata({ path: "src/index.ts", ...SCOPE, tags: ["entry"], ruleIds: ["rule-1"] });
            binding.putView({
                kind: "er",
                ...SCOPE,
                projection: { entities: ["Project"] },
                sourceRuleIds: ["rule-1"],
            });
            binding.configureEnvironment({ variables: { NODE_ENV: "test" }, paths: ["src"] });
        } finally {
            store.close();
        }

        const reopened = openStore(path);
        try {
            const project = createProject();
            const binding = bindProject(reopened, project);
            binding.rehydrate();

            assert.deepEqual(binding.report, { restored: 4, skipped: [] });
            assert.equal(project.getRule("rule-1")?.version, 2);
            assert.equal(project.getRule("rule-1")?.text, "second guidance");
            assert.equal(project.getMetadata("src/index.ts")?.version, 1);
            const view = project.getView("er");
            assert.deepEqual(view?.sourceVersions, [{ ruleId: "rule-1", version: 2 }]);
            assert.equal(view?.stale, false);
            assert.equal(project.environment.variables.NODE_ENV, "test");
            assert.equal(project.environmentVersion, 1);

            const events = reopened.events().length;
            binding.flush();
            assert.equal(reopened.events().length, events);

            const next = binding.putRule({ id: "rule-1", ...SCOPE, text: "third guidance", expectedVersion: 2 });
            assert.equal(next.version, 3);
            const stored = loadProjectRule(reopened, "rule-1");
            assert.ok(stored);
            assert.equal(plainEntity(stored).version, 3);

            // The rule bump invalidates the view in memory; the binding mirrors that.
            const storedViews = reopened.list<{ readonly stale?: boolean }>("project_view").map(row => plainEntity(row));
            assert.equal(storedViews.length, 1);
            assert.equal(storedViews[0]?.stale, true);
            assert.ok(reopened.events().some(event => event.kind === "project_view.transitioned"));
        } finally {
            reopened.close();
        }
    });
});

test("a rejected project write persists neither an entity nor an event", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindProject(store, createProject());
            binding.putRule({ id: "rule-1", ...SCOPE, text: "first guidance" });
            const before = { entities: store.stats().entities, events: store.stats().events };

            assert.throws(
                () => binding.putRule({ id: "rule-1", ...SCOPE, text: "third guidance", expectedVersion: 99 }),
                /version changed/,
            );
            assert.equal(store.stats().entities, before.entities);
            assert.equal(store.stats().events, before.events);
            const stored = loadProjectRule(store, "rule-1");
            assert.ok(stored);
            assert.equal(plainEntity(stored).text, "first guidance");
        } finally {
            store.close();
        }
    });
});

test("project flush persists state written directly to the service", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const project = createProject();
            project.putRule({ id: "rule-1", ...SCOPE, text: "direct guidance" });
            const binding = bindProject(store, project);
            assert.equal(loadProjectRule(store, "rule-1"), undefined);

            binding.flush();
            const stored = loadProjectRule(store, "rule-1");
            assert.ok(stored);
            assert.equal(plainEntity(stored).text, "direct guidance");
            assert.deepEqual(store.events().map(event => event.kind), ["project_rule.created"]);

            const events = store.events().length;
            binding.flush();
            assert.equal(store.events().length, events);
        } finally {
            store.close();
        }
    });
});

test("evidence binding persists additions and revocation propagation", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const ledger = new EvidenceLedger();
            const binding = bindEvidence(store, ledger);
            const facts = receiptFacts();
            binding.add(evidenceInput("e1", facts));
            binding.add(evidenceInput("e2", facts, ["e1"]));
            const revoked = binding.revoke("e1", TENANT, "superseded", LATER);
            assert.deepEqual([...revoked].sort(), ["e1", "e2"]);

            const first = loadEvidence(store, "e1");
            const second = loadEvidence(store, "e2");
            assert.ok(first);
            assert.ok(second);
            assert.equal(plainEntity(first).status, "revoked");
            assert.equal(plainEntity(second).status, "pending_revalidation");

            assert.deepEqual(store.events().map(event => event.kind), [
                "evidence.created",
                "evidence.created",
                "evidence.transitioned",
                "evidence.transitioned",
            ]);
            const provenanceRows = store
                .list<{ readonly type?: string; readonly reason?: string }>("provenance_event")
                .map(row => plainEntity(row));
            assert.equal(provenanceRows.length, 4);
            assert.ok(provenanceRows.some(row => row.type === "evidence_revoked" && row.reason === "superseded"));
            assert.equal(binding.report.restored, 0);
        } finally {
            store.close();
        }
    });
});

test("evidence rehydrate rebuilds the ledger from the persisted receipt chain", async () => {
    await withDatabase(async (path) => {
        const facts = receiptFacts();
        let chain: ReceiptFacts | undefined;
        const store = openStore(path);
        try {
            const receipts = bindReceipts(store, provenance);
            const receipt = receipts.issueReceipt({
                id: facts.receipt.id,
                invocation: facts.receipt.invocation,
                observation: facts.receipt.observation,
                issuedAt: facts.receipt.issuedAt,
                payloadDigest: facts.receipt.payloadDigest,
                hashAlgorithm: facts.receipt.hashAlgorithm,
            });
            const integrity = await receipts.verifyIntegrity(receipt, {
                digest: () => receipt.payloadDigest,
                verifier: "test",
                verifiedAt: NOW,
            });
            const verification = await receipts.verifyBusiness(
                receipt,
                integrity,
                { id: "v1", verifier: "test", verifiedAt: NOW, criteriaVersion: "criteria-v1" },
                () => true,
                ["the effect is observable"],
            );
            chain = { receipt, integrity, verification };
            const evidence = bindEvidence(store, new EvidenceLedger());
            evidence.add(evidenceInput("e1", chain));
            evidence.add(evidenceInput("e2", chain, ["e1"]));
            evidence.revoke("e1", TENANT, "revoked by test", LATER);
        } finally {
            store.close();
        }

        assert.ok(chain);
        const reopened = openStore(path);
        try {
            const ledger = new EvidenceLedger();
            const binding = bindEvidence(reopened, ledger);
            binding.rehydrate();

            assert.deepEqual(binding.report, { restored: 2, skipped: [] });
            assert.equal(ledger.get("e1", TENANT)?.status, "revoked");
            assert.equal(ledger.get("e2", TENANT)?.status, "pending_revalidation");
            assert.equal(ledger.getConsumable("e1", TENANT, LATER), undefined);

            // A new fact written after rehydration appends a fresh provenance row
            // instead of reusing the identities restored from disk.
            binding.add(evidenceInput("e3", chain));
            assert.equal(ledger.get("e3", TENANT)?.status, "active");
            const provenanceRows = reopened.list<{ readonly type?: string }>("provenance_event").map(row => plainEntity(row));
            assert.equal(provenanceRows.length, 5);
            assert.equal(provenanceRows.filter(row => row.type === "evidence_added").length, 3);
        } finally {
            reopened.close();
        }
    });
});

test("evidence binding persists corroboration and stale transitions", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const facts = receiptFacts();
            const binding = bindEvidence(store, new EvidenceLedger());
            binding.add(evidenceInput("e1", facts));
            binding.add(evidenceInput("e2", facts));
            binding.corroborate("e1", "e2", LATER);
            const first = loadEvidence(store, "e1");
            assert.ok(first);
            assert.equal(plainEntity(first).status, "corroborated");

            binding.markStale("e1", "environment changed", LATER);
            const staled = loadEvidence(store, "e1");
            assert.ok(staled);
            assert.equal(plainEntity(staled).status, "stale");

            assert.deepEqual(store.events().map(event => event.kind), [
                "evidence.created",
                "evidence.created",
                "evidence.transitioned",
                "evidence.transitioned",
            ]);
            const provenanceRows = store
                .list<{ readonly type?: string; readonly reason?: string }>("provenance_event")
                .map(row => plainEntity(row));
            assert.ok(provenanceRows.some(row => row.type === "evidence_corroborated"));
            assert.ok(provenanceRows.some(row => row.type === "evidence_staled" && row.reason === "environment changed"));
        } finally {
            store.close();
        }
    });
});

test("evidence rehydrate reports skipped rows when the receipt chain was never stored", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindEvidence(store, new EvidenceLedger());
            binding.add(evidenceInput("e1", receiptFacts()));
        } finally {
            store.close();
        }

        const reopened = openStore(path);
        try {
            const ledger = new EvidenceLedger();
            const binding = bindEvidence(reopened, ledger);
            binding.rehydrate();
            assert.equal(binding.report.restored, 0);
            assert.deepEqual(binding.report.skipped, ["evidence:e1:receipt_missing"]);
            assert.equal(ledger.get("e1", TENANT), undefined);
        } finally {
            reopened.close();
        }
    });
});

test("receipt binding persists issuance, integrity, verification and lifecycle advances", async () => {
    await withDatabase(async (path) => {
        const facts = receiptFacts();
        const store = openStore(path);
        try {
            const binding = bindReceipts(store, provenance);
            const receipt = binding.issueReceipt({
                id: facts.receipt.id,
                invocation: facts.receipt.invocation,
                observation: facts.receipt.observation,
                issuedAt: facts.receipt.issuedAt,
                payloadDigest: facts.receipt.payloadDigest,
                hashAlgorithm: facts.receipt.hashAlgorithm,
            });
            const integrity = await binding.verifyIntegrity(receipt, {
                digest: () => receipt.payloadDigest,
                verifier: "test",
                verifiedAt: NOW,
            });
            const verification = await binding.verifyBusiness(
                receipt,
                integrity,
                { id: "v1", verifier: "test", verifiedAt: NOW, criteriaVersion: "criteria-v1" },
                () => true,
                ["the effect is observable"],
            );
            assert.equal(integrity.status, "integrity_verified");
            assert.equal(verification.status, "semantic_verified");
            const signed = binding.advance(receipt, "signed");
            assert.equal(signed.lifecycle, "signed");

            assert.deepEqual(store.events().map(event => event.kind), [
                "receipt.created",
                "receipt_integrity.created",
                "verification.created",
                "receipt.transitioned",
            ]);
            const stored = loadReceipt(store, "r1");
            assert.ok(stored);
            assert.equal(plainEntity(stored).lifecycle, "signed");
        } finally {
            store.close();
        }

        const reopened = openStore(path);
        try {
            const binding = bindReceipts(reopened, provenance);
            binding.rehydrate();
            assert.deepEqual(binding.report, { restored: 3, skipped: [] });
            assert.equal(binding.receipt("r1")?.lifecycle, "signed");
            assert.equal(binding.integrityForReceipt("r1")?.status, "integrity_verified");
            assert.equal(binding.verification("v1")?.status, "semantic_verified");
            assert.equal(binding.receipts().length, 1);
        } finally {
            reopened.close();
        }
    });
});

test("budget binding restores limits, settled totals and reservations after restart", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        let before: BudgetSnapshot | undefined;
        try {
            const ledger = new BudgetLedger();
            const binding = bindBudget(store, ledger);
            binding.configure("tenant-1:root-1", { tokens: 1_000, calls: 10 });
            binding.reserve("op-1", "tenant-1:root-1", { tokens: 100, calls: 1 });
            binding.settle("op-1", { tokens: 80, calls: 1 });
            binding.reserve("op-2", "tenant-1:root-1", { tokens: 50 });
            binding.reserve("op-3", "tenant-1:root-1", { tokens: 20 });
            binding.release("op-3");

            before = binding.snapshot("tenant-1:root-1");
            assert.deepEqual(before.settled, { tokens: 80, milliseconds: 0, calls: 1, bytes: 0 });
            assert.deepEqual(before.reserved, { tokens: 50, milliseconds: 0, calls: 0, bytes: 0 });
            assert.equal(store.events().filter(event => event.kind === "budget_ledger.created").length, 1);
            assert.equal(store.events().filter(event => event.kind === "budget_reservation.created").length, 3);
        } finally {
            store.close();
        }

        assert.ok(before);
        const reopened = openStore(path);
        try {
            const ledger = new BudgetLedger();
            const binding = bindBudget(reopened, ledger);
            binding.rehydrate();

            assert.deepEqual(binding.report, { restored: 4, skipped: [] });
            assert.deepEqual(ledger.snapshot("tenant-1:root-1"), before);
            assert.equal(ledger.getReservation("op-1")?.state, "settled");
            assert.equal(ledger.getReservation("op-2")?.state, "reserved");
            assert.equal(ledger.getReservation("op-3")?.state, "released");

            const stats = { entities: reopened.stats().entities, events: reopened.events().length };
            binding.rehydrate();
            assert.deepEqual(ledger.snapshot("tenant-1:root-1"), before);
            assert.equal(reopened.stats().entities, stats.entities);
            assert.equal(reopened.events().length, stats.events);
        } finally {
            reopened.close();
        }
    });
});

test("attention binding persists state and rebuilds the object list", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindAttention(store, attentionOperations);
            const created = binding.create(attentionInput(), NOW);
            assert.equal(created.version, 1);
            const focused = binding.focus(created, { expectedVersion: 1, now: LATER, reason: "focus" });
            const mounted = binding.mount(focused, { expectedVersion: 2, now: LATER, reason: "mount" });
            const updated = binding.update(mounted, { summary: "updated summary" }, { expectedVersion: 3, now: LATER, reason: "update" });
            const blurred = binding.blur(updated, { expectedVersion: 4, now: LATER, reason: "blur" });
            const unmounted = binding.unmount(blurred, { expectedVersion: 5, now: LATER, reason: "unmount" });
            const retained = binding.persist(unmounted, {
                across: "steps",
                reason: "keep for the next step",
                expiresAt: "2027-01-01T00:00:00.000Z",
                budget: { tokens: 50 },
            }, { expectedVersion: 6, now: LATER, reason: "retain" });
            assert.equal(retained.version, 7);
            assert.equal(retained.mounted, false);
            assert.equal(retained.intensity, 0.5);

            assert.deepEqual(store.events().map(event => event.kind), [
                "attention.created",
                "attention.transitioned",
                "attention.transitioned",
                "attention.transitioned",
                "attention.transitioned",
                "attention.transitioned",
                "attention.transitioned",
            ]);
            assert.equal(binding.list().length, 1);
        } finally {
            store.close();
        }

        const reopened = openStore(path);
        try {
            const binding = bindAttention(reopened, attentionOperations);
            binding.rehydrate();
            assert.deepEqual(binding.report, { restored: 1, skipped: [] });
            const restored = binding.get("attention-1");
            assert.ok(restored);
            assert.equal(restored.version, 7);
            assert.equal(restored.mounted, false);
            assert.equal(restored.summary, "updated summary");
            assert.equal(restored.intensity, 0.5);
            assert.equal(restored.retention?.across, "steps");
            assert.equal(binding.list().length, 1);
        } finally {
            reopened.close();
        }
    });
});

test("rehydrateAll aggregates binding reports and is idempotent", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const projectBinding = bindProject(store, createProject());
            projectBinding.putRule({ id: "rule-1", ...SCOPE, text: "guidance" });
            projectBinding.configureEnvironment({ variables: { NODE_ENV: "test" } });

            const budgetBinding = bindBudget(store, new BudgetLedger());
            budgetBinding.configure("tenant-1:root-1", { tokens: 500 });
            budgetBinding.reserve("op-1", "tenant-1:root-1", { tokens: 100 });

            const attentionBinding = bindAttention(store, attentionOperations);
            attentionBinding.create(attentionInput(), NOW);

            const bindings = [projectBinding, budgetBinding, attentionBinding];
            const first = rehydrateAll(store, bindings);
            assert.equal(first.restored, 5);
            assert.deepEqual(first.skipped, []);
            assert.equal(Object.isFrozen(first), true);
            assert.equal(Object.isFrozen(first.skipped), true);

            const stats = { entities: store.stats().entities, events: store.events().length };
            const second = rehydrateAll(store, {
                project: projectBinding,
                budget: budgetBinding,
                attention: attentionBinding,
            });
            assert.deepEqual(second, first);
            assert.equal(store.stats().entities, stats.entities);
            assert.equal(store.events().length, stats.events);
        } finally {
            store.close();
        }
    });
});

test("a rolled-back outer transaction leaves neither the binding entity nor its event", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindEvidence(store, new EvidenceLedger());
            const facts = receiptFacts();
            assert.throws(() => store.transaction(() => {
                binding.add(evidenceInput("e1", facts));
                throw new Error("outer rollback");
            }), /outer rollback/);

            assert.equal(loadEvidence(store, "e1"), undefined);
            assert.equal(listEntities(store, "evidence").length, 0);
            assert.equal(store.events().length, 0);
        } finally {
            store.close();
        }
    });
});

test("a corrupt stored row is skipped while the remaining project rows restore", async () => {
    await withDatabase((path) => {
        const store = openStore(path);
        try {
            const binding = bindProject(store, createProject());
            binding.putRule({ id: "rule-1", ...SCOPE, text: "first guidance" });
            binding.putRule({ id: "rule-2", ...SCOPE, text: "second guidance" });
        } finally {
            store.close();
        }

        const raw = openSqlite({ path });
        try {
            raw.run({
                sql: "UPDATE entities SET payload = ? WHERE kind = ? AND id = ?",
                parameters: ["{not-json", "project_rule", "rule-2"],
            });
        } finally {
            raw.close();
        }

        const reopened = openStore(path);
        try {
            const binding = bindProject(reopened, createProject());
            binding.rehydrate();
            assert.equal(binding.report.restored, 1);
            assert.deepEqual(binding.report.skipped, ["project_rule:rule-2"]);
            assert.equal(binding.project.getRule("rule-1")?.text, "first guidance");
            assert.equal(binding.project.getRule("rule-2"), undefined);
        } finally {
            reopened.close();
        }
    });
});

test("two Store instances over one database share identity and see the same facts", async () => {
    await withDatabase((path) => {
        const first = openStore(path);
        const second = openStore(path);
        try {
            bindProject(first, createProject()).putRule({ id: "rule-1", ...SCOPE, text: "shared guidance" });

            const project = createProject();
            const binding = bindProject(second, project);
            binding.rehydrate();
            assert.equal(project.getRule("rule-1")?.text, "shared guidance");

            const proxyFirst = loadProjectRule(first, "rule-1");
            const proxySecond = loadProjectRule(second, "rule-1");
            assert.ok(proxyFirst);
            assert.ok(proxySecond);
            assert.equal(proxyFirst, proxySecond);
        } finally {
            first.close();
            second.close();
        }
    });
});
