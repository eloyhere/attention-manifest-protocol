#!/usr/bin/env node
/**
 * Reference runtime checks (not a spec conformance suite — see tools/conformance.ts).
 * These assert that the implementation actually honours the invariants it claims.
 */
import assert from "node:assert/strict";

import { sha256Hex } from "../src/semantic/sha256.ts";
import { canonical, digestOf } from "../src/semantic/canonical.ts";
import { Dispatcher, BudgetExceeded } from "../src/attention/budget.ts";
import { HandleStore } from "../src/execution/handles.ts";
import type { HandlePage } from "../src/execution/handles.ts";
import { canAuthorizeEffect, deriveConfidence, validateClaim, validateHypothesis } from "../src/warrant/warrant.ts";
import { respectsMonotonicity, salience, selectFocus } from "../src/attention/attention.ts";
import type { Claim, EvidenceItem, Handle, Hypothesis } from "../src/types/index.ts";
import type { Candidate, Selection } from "../src/attention/attention.ts";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        Failed++;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    }
};

const evidence: (over?: Partial<EvidenceItem>) => EvidenceItem = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
    id: "ev.1",
    kind: "observation",
    trust: "self",
    independence: 0.9,
    entails: true,
    origin: "a",
    at: "2026-10-24T01:00:00Z",
    ...over,
});

const claim: (over?: Partial<Claim>) => Claim = (over: Partial<Claim> = {}): Claim => ({
    amp: "0.1",
    kind: "claim",
    id: "cl.1",
    statement: "x",
    tier: "T2",
    status: "held",
    warrant: { evidence: [evidence()], inference: "abduction", strength: 0.7 },
    provenance: { source: "a.gamma" },
    created: "2026-10-24T01:00:00Z",
    ...over,
});

test("sha256 matches FIPS vectors", () => {
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("canonical JSON is key-order independent", () => {
    assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
    assert.equal(digestOf({ b: 1, a: 2 }), digestOf({ a: 2, b: 1 }));
});

test("nested calls hit the same budget counter", () => {
    const dispatcher: Dispatcher = new Dispatcher({ calls: 2 });
    dispatcher.run(() => undefined, {});
    dispatcher.run(() => undefined, {});
    assert.throws(() => dispatcher.run(() => undefined, {}), BudgetExceeded);
    assert.equal(dispatcher.usage().calls, 2);
});

test("handles page deterministically", () => {
    const store: HandleStore = new HandleStore();
    const handle: Handle = store.put("x".repeat(1000), "text", 250);
    const page1: HandlePage = store.read(handle.id, 0, 100);
    assert.equal(page1.text.length, 400);
    assert.equal(page1.next, 400);
    const page2: HandlePage = store.read(handle.id, page1.next, 100);
    assert.equal(page2.text.length, 400);
    assert.equal(store.read(handle.id, 0, 100).text, page1.text);
});

test("confidence is derived from tier and capped by the weakest source", () => {
    const t0: number = deriveConfidence({ tier: "T0", warrant: { evidence: [], inference: "abduction", strength: 0.5 } });
    assert.ok(t0 <= 0.6, `T0 derived ${t0}`);

    const external: number = deriveConfidence(
        claim({ tier: "T1", warrant: { evidence: [evidence({ trust: "external" })], inference: "testimony", strength: 0.5 } }),
    );
    assert.ok(external <= 0.5, `external trust cap violated: ${external}`);
});

test("tier inflation is rejected", () => {
    assert.ok(validateClaim(claim({ tier: "T1", warrant: { evidence: [evidence({ entails: false })], inference: "testimony", strength: 0.5 } })).length > 0);
    assert.ok(validateClaim(claim({ tier: "T2", warrant: { evidence: [evidence({ trust: "external" })], inference: "testimony", strength: 0.5 } })).length > 0);
    assert.equal(validateClaim(claim()).length, 0);
});

test("hypothesis without refutes_if is rejected", () => {
    const hypothesis: Hypothesis = {
        amp: "0.1",
        kind: "hypothesis",
        id: "h.1",
        question: { kind: "unknown", id: "u.1" },
        statement: "x",
        prediction: "y",
        refutes_if: "",
        status: "testing",
        created: "2026-10-24T01:00:00Z",
    };
    assert.ok(validateHypothesis(hypothesis).includes("refutes_if is required"));
});

test("contested claims cannot authorize effects", () => {
    assert.equal(canAuthorizeEffect(claim({ status: "contested" }), "T1"), false);
    assert.equal(canAuthorizeEffect(claim(), "T1"), true);
    assert.equal(canAuthorizeEffect(claim({ tier: "T0" }), "T2"), false);
});

test("salience respects its monotonicity contract", () => {
    const base: Candidate = {
        target: { kind: "tool", id: "logs.query" },
        role: "tool",
        voi: 0.6,
        goalFit: 0.7,
        uncertainty: 0.5,
        novelty: 0.2,
        costTokens: 400,
        risk: 0.1,
        trustCap: 0.95,
        why: "because",
    };
    assert.ok(respectsMonotonicity(base));
    assert.ok(salience({ ...base, trustCap: 0.1 }) <= 0.1);
});

test("nothing above threshold produces STUCK with an ignored list", () => {
    const selection: Selection = selectFocus(
        [
            {
                target: { kind: "tool", id: "a" },
                role: "tool",
                voi: 0.01,
                goalFit: 0.01,
                uncertainty: 0.1,
                novelty: 0,
                costTokens: 100,
                risk: 0,
                trustCap: 0.9,
                why: "irrelevant",
            },
        ],
        { budgetTokens: 1000 },
    );
    assert.equal(selection.slots.length, 0);
    assert.equal(selection.impasse, "STUCK");
    assert.equal(selection.ignored.length, 1);
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
