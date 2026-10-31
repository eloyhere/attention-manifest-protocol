#!/usr/bin/env node
/**
 * Interaction binding invariants.
 *
 * Covers party/protocol validation, acknowledgement, cadence, budget,
 * escalation and handoff. Messages are only legal inside an active binding.
 */
import assert from "node:assert/strict";

import { AssignmentLedger, BindingLedger } from "../src/assignment/index.ts";
import type {
    AssignmentPolicy,
    BindingPolicy,
    CreateAssignmentInput,
    CreateBindingInput,
    Duty,
    ResponsibilityAssignment,
} from "../src/assignment/index.ts";

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

const Rules: AssignmentPolicy = {
    authority: ["tool.logs.query"],
    budget: { tokens: 1000, calls: 2, interrupts: 1 },
    window: { from: "2026-10-24T09:00:00Z", to: "2026-10-24T12:00:00Z" },
    maxDepth: 2,
};

const LogDuty: Duty = {
    id: "d.logs",
    statement: "collect logs",
    scope: ["project:api"],
    acceptance: [{ id: "c.logs", statement: "done", check: "test" }],
};

const AssignmentInput: CreateAssignmentInput = {
    id: "ra.1",
    assigner: "a.lead",
    assignee: "a.worker",
    duties: [LogDuty],
    authority: ["tool.logs.query"],
    budget: { tokens: 1000, calls: 2, interrupts: 1 },
    window: { from: "2026-10-24T10:00:00Z", to: "2026-10-24T11:00:00Z" },
    why: "test assignment",
    created: At,
};

const Assignments: AssignmentLedger = new AssignmentLedger({ now: () => At });
Assignments.create(AssignmentInput, Rules);
Assignments.accept("ra.1", "a.worker", At);
const ActiveAssignment: ResponsibilityAssignment = Assignments.activate("ra.1", At);

const Policy: BindingPolicy = { assignment: ActiveAssignment, allowedEscalationTargets: [] };

const base: (id: string) => CreateBindingInput = (id: string): CreateBindingInput => ({
    id,
    assignment: "ra.1",
    parties: ["a.lead", "a.worker", "a.host"],
    purpose: { kind: "goal", id: "g.incident" },
    channel: { kind: "a2a", endpoint: "https://worker.example/a2a", auth: "ed25519" },
    protocol: {
        id: "amp.delegation",
        version: "0.1",
        roles: [
            { party: "a.lead", role: "initiator" },
            { party: "a.worker", role: "responder" },
            { party: "a.host", role: "observer" },
        ],
    },
    mode_mix: { think: 0.6, converge: 0.4 },
    direction: "request-response",
    cadence: { max_turns: 3, max_messages: 6, response_within_ms: 300000 },
    escalation: [{ when: "timeout", to: "a.host", within_ms: 600000, fallback: "escalate" }],
    handoff: { required_state: [{ kind: "frame", id: "f.1" }], acceptance: "ack" },
    budget: { tokens: 500, interrupts: 1 },
    why: "test binding",
    created: At,
});

const mkLedger: () => BindingLedger = (): BindingLedger => new BindingLedger({ now: () => At });

const ackAll: (ledger: BindingLedger, id: string) => void = (ledger: BindingLedger, id: string): void => {
    for (const party of ["a.lead", "a.worker", "a.host"]) {
        ledger.ack(id, party, At);
    }
};

const activate: (ledger: BindingLedger, id: string) => void = (ledger: BindingLedger, id: string): void => {
    ackAll(ledger, id);
    ledger.activate(id, At);
};

const throwsCode: (fn: () => void, code: string) => void = (fn: () => void, code: string): void => {
    assert.throws(fn, (error: unknown): boolean => (error as { code?: string }).code === code);
};

test("valid binding is proposed and sealed", () => {
    const ledger: BindingLedger = mkLedger();
    const binding = ledger.create(base("ib.1"), Policy);
    assert.equal(binding.status, "proposed");
    assert.match(binding.digest ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("duplicate parties are rejected", () => {
    const ledger: BindingLedger = mkLedger();
    const input: CreateBindingInput = base("ib.1");
    input.parties = ["a.lead", "a.lead"];
    throwsCode(() => ledger.create(input, Policy), "binding_invalid");
});

test("protocol roles must cover every party", () => {
    const ledger: BindingLedger = mkLedger();
    const input: CreateBindingInput = base("ib.1");
    input.protocol = { id: "amp.delegation", version: "0.1", roles: [{ party: "a.lead", role: "initiator" }] };
    throwsCode(() => ledger.create(input, Policy), "protocol_role_missing");
});

test("a mode mix needs at least one positive weight", () => {
    const ledger: BindingLedger = mkLedger();
    const input: CreateBindingInput = base("ib.1");
    input.mode_mix = { think: 0, converge: 0 };
    throwsCode(() => ledger.create(input, Policy), "mode_mix_invalid");
});

test("cadence limits must be positive", () => {
    const ledger: BindingLedger = mkLedger();
    const input: CreateBindingInput = base("ib.1");
    input.cadence = { max_turns: 0, max_messages: 1, response_within_ms: 1000 };
    throwsCode(() => ledger.create(input, Policy), "cadence_invalid");
});

test("escalation to the initiator is rejected", () => {
    const ledger: BindingLedger = mkLedger();
    const input: CreateBindingInput = base("ib.1");
    input.escalation = [{ when: "timeout", to: "a.lead", within_ms: 1000 }];
    throwsCode(() => ledger.create(input, Policy), "escalation_unauthorized");
});

test("activation requires every party to acknowledge", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    ledger.ack("ib.1", "a.lead", At);
    throwsCode(() => ledger.activate("ib.1", At), "binding_not_acked");
});

test("activation succeeds after all acknowledgements", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    assert.equal(ledger.get("ib.1").status, "active");
});

test("messages from outside the binding are rejected", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    throwsCode(
        () => ledger.recordMessage({ binding: "ib.1", from: "a.unknown", to: "a.worker", performative: "inform", at: At }),
        "message_outside_binding",
    );
});

test("max_messages is enforced", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    for (let index: number = 0; index < 6; index += 1) {
        ledger.recordMessage({ binding: "ib.1", from: "a.worker", to: "a.lead", performative: "inform", at: At });
    }
    throwsCode(
        () => ledger.recordMessage({ binding: "ib.1", from: "a.worker", to: "a.lead", performative: "inform", at: At }),
        "binding_cadence_exceeded",
    );
});

test("interaction budget is enforced", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    throwsCode(
        () => ledger.recordMessage({ binding: "ib.1", from: "a.worker", to: "a.lead", performative: "inform", at: At, usage: { tokens: 600 } }),
        "binding_budget_exhausted",
    );
});

test("handoff requires the declared state", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    throwsCode(() => ledger.handoff("ib.1", "a.lead", At, [], true), "handoff_state_missing");
});

test("handoff with state and acknowledgement closes the binding", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    const closed = ledger.handoff("ib.1", "a.lead", At, [{ kind: "frame", id: "f.1" }], true);
    assert.equal(closed.status, "closed");
});

test("suspend and resume preserve the binding", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    ledger.suspend("ib.1", "a.lead", At, "pause");
    assert.equal(ledger.get("ib.1").status, "suspended");
    ledger.resume("ib.1", "a.lead", At);
    assert.equal(ledger.get("ib.1").status, "active");
});

test("revoke is terminal", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    ledger.revoke("ib.1", "a.lead", At, "cancelled");
    assert.equal(ledger.get("ib.1").status, "revoked");
    throwsCode(
        () => ledger.recordMessage({ binding: "ib.1", from: "a.lead", to: "a.worker", performative: "request", at: At }),
        "status_transition",
    );
});

test("assignment revocation revokes its bindings", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    const revoked = ledger.revokeForAssignment("ra.1", "a.lead", At, "assignment revoked");
    assert.equal(revoked.length, 1);
    assert.equal(ledger.get("ib.1").status, "revoked");
});

test("a second active binding for the same purpose and parties is rejected", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    throwsCode(() => ledger.create(base("ib.2"), Policy), "binding_duplicate");
});

test("sweep escalates a timeout when a rule exists", () => {
    const ledger: BindingLedger = mkLedger();
    ledger.create(base("ib.1"), Policy);
    activate(ledger, "ib.1");
    const results = ledger.sweep("2026-10-24T10:10:00Z");
    assert.equal(results.length, 1);
    assert.equal(results[0].action, "escalate");
    assert.equal(results[0].to, "a.host");
});

test("sweep breaches a timeout without an escalation rule", () => {
    const ledger: BindingLedger = mkLedger();
    const input: CreateBindingInput = base("ib.1");
    input.escalation = undefined;
    ledger.create(input, Policy);
    activate(ledger, "ib.1");
    const results = ledger.sweep("2026-10-24T10:06:00Z");
    assert.equal(results.length, 1);
    assert.equal(results[0].action, "breach");
    assert.equal(ledger.get("ib.1").status, "breached");
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
