#!/usr/bin/env node
/**
 * Responsibility assignment invariants.
 *
 * Covers authority/budget/window attenuation, acceptance, single accountable
 * ownership, separation of duties, evidence-based discharge, cascade revoke,
 * expiry, blocking and coverage.
 */
import assert from "node:assert/strict";

import { AssignmentLedger } from "../src/assignment/index.ts";
import type { AssignmentPolicy, CreateAssignmentInput, Duty } from "../src/assignment/index.ts";

let Passed: number = 0;
let Failed: number = 0;

type SyncTest = (name: string, fn: () => void) => void;

const test: SyncTest = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const At: string = "2026-10-24T10:00:00Z";

const Policy: AssignmentPolicy = {
    authority: ["tool.logs.query", "tool.deploy.rollback", "assign"],
    budget: { tokens: 4000, calls: 8, interrupts: 2 },
    window: { from: "2026-10-24T09:00:00Z", to: "2026-10-24T12:00:00Z" },
    maxDepth: 2,
};

const duty: (id: string, conflicts?: string[]) => Duty = (id: string, conflicts: string[] = []): Duty => ({
    id,
    statement: `duty ${id}`,
    scope: ["project:api"],
    acceptance: [{ id: `c.${id}`, statement: "done", check: "test", kind: "assert" }],
    ...(conflicts.length === 0 ? {} : { conflicts_with: conflicts }),
});

const base: (id: string, dutyId?: string) => CreateAssignmentInput = (id: string, dutyId: string = `d.${id}`): CreateAssignmentInput => ({
    id,
    assigner: "a.lead",
    assignee: "a.worker",
    duties: [duty(dutyId)],
    authority: ["tool.logs.query"],
    budget: { tokens: 1000, calls: 2, interrupts: 1 },
    window: { from: "2026-10-24T10:00:00Z", to: "2026-10-24T11:00:00Z" },
    why: "test assignment",
    created: At,
});

const mkLedger: () => AssignmentLedger = (): AssignmentLedger => new AssignmentLedger({ now: () => At });

const activate: (ledger: AssignmentLedger, id: string) => void = (ledger: AssignmentLedger, id: string): void => {
    ledger.accept(id, "a.worker", At);
    ledger.activate(id, At);
};

const throwsCode: (fn: () => void, code: string) => void = (fn: () => void, code: string): void => {
    assert.throws(fn, (error: unknown): boolean => (error as { code?: string }).code === code);
};

test("valid assignment is proposed and sealed", () => {
    const ledger: AssignmentLedger = mkLedger();
    const assignment = ledger.create(base("ra.1"), Policy);
    assert.equal(assignment.status, "proposed");
    assert.match(assignment.digest ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("assignee acceptance moves the assignment to accepted", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create(base("ra.1"), Policy);
    const accepted = ledger.accept("ra.1", "a.worker", At);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptance?.state, "accepted");
});

test("activation before acceptance is rejected", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create(base("ra.1"), Policy);
    throwsCode(() => ledger.activate("ra.1", At), "acceptance_missing");
});

test("authority widening is rejected", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.authority = ["tool.secret"];
    throwsCode(() => ledger.create(input, Policy), "authority_widened");
});

test("budget widening is rejected", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.budget = { tokens: 9000 };
    throwsCode(() => ledger.create(input, Policy), "budget_widened");
});

test("window widening is rejected", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.window = { from: "2026-10-24T09:00:00Z", to: "2026-10-24T13:00:00Z" };
    throwsCode(() => ledger.create(input, Policy), "window_widened");
});

test("depth beyond two is rejected", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.depth = 3;
    throwsCode(() => ledger.create(input, Policy), "depth_exceeded");
});

test("a duty cannot have two active owners", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create(base("ra.1"), Policy);
    activate(ledger, "ra.1");
    throwsCode(() => ledger.create(base("ra.2", "d.ra.1"), Policy), "multiple_accountable");
});

test("separation of duties is enforced for overlapping windows", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create(base("ra.approve", "d.approve"), Policy);
    activate(ledger, "ra.approve");
    const candidate: CreateAssignmentInput = base("ra.execute", "d.execute");
    candidate.duties = [duty("d.execute", ["d.approve"])];
    throwsCode(() => ledger.create(candidate, Policy), "duty_conflict");
});

test("discharge without required evidence is rejected", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.duties = [duty("d.ra.1")];
    input.duties[0].evidence_required = ["result-contract"];
    ledger.create(input, Policy);
    activate(ledger, "ra.1");
    throwsCode(() => ledger.discharge("ra.1", "a.lead", At, []), "evidence_missing");
});

test("discharge with matching evidence succeeds", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.duties = [duty("d.ra.1")];
    input.duties[0].evidence_required = ["result-contract"];
    ledger.create(input, Policy);
    activate(ledger, "ra.1");
    const done = ledger.discharge("ra.1", "a.lead", At, [{ kind: "result-contract", id: "rc.1" }]);
    assert.equal(done.status, "discharged");
    assert.equal(done.evidence?.produced.length, 1);
});

test("revoking a parent cascades to its children", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create({ ...base("ra.parent", "d.parent"), delegable: true }, Policy);
    activate(ledger, "ra.parent");
    ledger.create({ ...base("ra.child", "d.child"), parent: "ra.parent", depth: 1 }, Policy);
    activate(ledger, "ra.child");
    ledger.revoke("ra.parent", "a.lead", At, "cancelled");
    assert.equal(ledger.get("ra.parent").status, "revoked");
    assert.equal(ledger.get("ra.child").status, "revoked");
});

test("sweep expires assignments past their window", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.window = { from: "2026-10-24T10:00:00Z", to: "2026-10-24T10:30:00Z" };
    ledger.create(input, Policy);
    activate(ledger, "ra.1");
    const expired = ledger.sweep("2026-10-24T11:00:00Z");
    assert.equal(expired.length, 1);
    assert.equal(ledger.get("ra.1").status, "expired");
});

test("block and resume preserve the assignment", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create(base("ra.1"), Policy);
    activate(ledger, "ra.1");
    ledger.block("ra.1", "a.lead", At, "waiting for logs");
    assert.equal(ledger.get("ra.1").status, "blocked");
    ledger.resume("ra.1", "a.lead", At);
    assert.equal(ledger.get("ra.1").status, "active");
});

test("independent duties cannot be self-assigned", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.assigner = "a.worker";
    input.raci = { accountable: "a.worker", responsible: ["a.worker"] };
    const independent: AssignmentPolicy = { ...Policy, independentDuties: ["d.ra.1"] };
    throwsCode(() => ledger.create(input, independent), "self_approval");
});

test("the accountable party must be a party to the assignment", () => {
    const ledger: AssignmentLedger = mkLedger();
    const input: CreateAssignmentInput = base("ra.1");
    input.raci = { accountable: "a.other", responsible: ["a.worker"] };
    throwsCode(() => ledger.create(input, Policy), "accountable_not_party");
});

test("coverage reports unassigned duties", () => {
    const ledger: AssignmentLedger = mkLedger();
    ledger.create(base("ra.1"), Policy);
    activate(ledger, "ra.1");
    const report = ledger.coverage(["d.ra.1", "d.missing"]);
    assert.deepEqual(report.assigned, ["d.ra.1"]);
    assert.deepEqual(report.unassigned, ["d.missing"]);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
