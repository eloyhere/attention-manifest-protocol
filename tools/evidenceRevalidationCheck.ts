#!/usr/bin/env node
/**
 * Evidence-change replay: dependency locality, host review races and policy
 * consumption. Fixtures test behavior rather than confidence heuristics.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceGraph, WarrantRevalidation } from "../src/evidence/index.ts";
import type { ReviewToken, WarrantSource } from "../src/evidence/index.ts";
import { PolicyEngine } from "../src/policy/policy.ts";
import type { ActionRequest } from "../src/policy/policy.ts";
import type { Claim, EvidenceItem } from "../src/warrant/epistemic.ts";
import type { Plan } from "../src/goal/plan.ts";

const At: string = "2026-10-29T00:00:00Z";
const evidence: (id: string, overrides?: Partial<EvidenceItem>) => EvidenceItem = (id: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem => ({
    id,
    kind: "document",
    trust: "verified",
    independence: 1,
    at: At,
    ...overrides,
});
const claim: (id: string, items?: EvidenceItem[]) => Claim = (id: string, items: EvidenceItem[] = []): Claim => ({
    amp: "0.1",
    kind: "claim",
    id,
    statement: id,
    tier: "T2",
    status: "held",
    warrant: { evidence: items, inference: "deduction", strength: 0.8 },
    provenance: { source: "revalidation-check", trust: "self" },
    created: At,
});
const plan: (id: string, warrant: string) => Plan = (id: string, warrant: string): Plan => ({
    amp: "0.1",
    kind: "plan",
    id,
    goal: { kind: "goal", id: "goal" },
    warrant: { kind: "claim", id: warrant },
    tasks: [],
    edges: [],
    commitment_window: 1,
    budget: {},
    abandon_if: [],
    status: "draft",
    created: At,
});
const Origin: WarrantSource = { kind: "origin", id: "measurement" };

test("failed insertions are atomic and identities cannot drift", () => {
    const graph: EvidenceGraph = new EvidenceGraph();
    assert.throws(() => graph.addEvidence("orphan", "orphan", "absent"), /unknown/);
    assert.equal(graph.size, 0);
    const a: ReturnType<EvidenceGraph["addClaim"]> = graph.addClaim("a", "a");
    graph.addEvidence("e", "e", "a");
    graph.link("e", "a");
    assert.deepEqual(graph.evidenceFor("a"), ["e"]);
    assert.throws(() => graph.link("a", "e"), /cycle/);
    assert.throws(() => graph.link("a", "a"), /itself/);
    assert.equal(Reflect.set(a, "id", "renamed"), false);
    assert.equal(Reflect.set(a, "kind", "evidence"), false);
    assert.deepEqual(graph.evidenceFor("e"), []);
    assert.equal(graph.hasCycle(), false);
});

test("multi-source diamond impact has one shortest witness and no unrelated nodes", () => {
    const graph: EvidenceGraph = new EvidenceGraph();
    ["s", "a", "b", "c", "other"].forEach((id: string) => {
        graph.addClaim(id, id);
    });
    graph.link("s", "a");
    graph.link("s", "b");
    graph.link("a", "c");
    graph.link("b", "c");
    assert.deepEqual(graph.impact(["s", "b", "s"]), [
        { id: "s", via: null },
        { id: "b", via: null },
        { id: "a", via: "s" },
        { id: "c", via: "b" },
    ]);
    const copy: string[] = graph.claimsFor("s");
    copy.length = 0;
    assert.deepEqual(new Set(graph.claimsFor("s")), new Set(["a", "b"]));
    assert.throws(() => graph.impact(["s", "missing"]), /unknown/);
    assert.deepEqual(graph.impact([]), []);
});

test("deep chains use iterative traversal and reject the closing cycle", () => {
    const graph: EvidenceGraph = new EvidenceGraph();
    for (let i: number = 0; i < 8000; i += 1) {
        graph.addClaim(`${i}`, `${i}`);
        if (i > 0) {
            graph.link(`${i - 1}`, `${i}`);
        }
    }
    assert.equal(graph.impact(["0"]).length, 8000);
    assert.throws(() => graph.link("7999", "0"), /cycle/);
    assert.equal(graph.hasCycle(), false);
});

test("indexed closure matches an independent fixed-point edge scan", () => {
    const graph: EvidenceGraph = new EvidenceGraph();
    const edges: Array<[string, string]> = [];
    for (let i: number = 0; i < 90; i += 1) {
        graph.addClaim(`${i}`, `${i}`);
    }
    for (let i: number = 0; i < 90; i += 1) {
        for (let j: number = i + 1; j < 90; j += 1) {
            if ((i * 17 + j * 31) % 19 === 0) {
                graph.link(`${i}`, `${j}`);
                edges.push([`${i}`, `${j}`]);
            }
        }
    }
    for (let seed: number = 0; seed < 90; seed += 7) {
        const expected: Set<string> = new Set<string>([`${seed}`]);
        let changed: boolean = true;
        while (changed) {
            changed = false;
            for (let edgeIndex: number = 0; edgeIndex < edges.length; edgeIndex += 1) {
                const [from, to]: [string, string] = edges[edgeIndex];
                if (expected.has(from) && !expected.has(to)) {
                    expected.add(to);
                    changed = true;
                }
            }
        }
        assert.deepEqual(new Set(graph.impact([`${seed}`]).map((item) => item.id)), expected);
    }
});

test("source change reaches derived claims and plans, independent branches stay current", () => {
    const a: Claim = claim("a", [evidence("shared", { origin: "measurement" }), evidence("backup", { origin: "backup" })]);
    const b: Claim = claim("b", [evidence("shared", { ref: { kind: "claim", id: "a" } })]);
    const c: Claim = claim("c", [evidence("shared", { origin: "other" })]);
    const index: WarrantRevalidation = new WarrantRevalidation([a, b, c], [plan("work", "b"), plan("unrelated", "c")]);
    assert.deepEqual(index.invalidate([Origin]), { claims: ["a", "b"], plans: ["work"] });
    assert.equal(index.isCurrent(a), false);
    assert.equal(index.isCurrent(c), true);
    assert.equal(a.status, "held");
    assert.equal(a.warrant.evidence.length, 2);
    const downstream: ReviewToken = index.beginReview("b");
    assert.equal(index.completeReview(downstream), false);
    assert.equal(index.completeReview(index.beginReview("a")), true);
    assert.equal(index.completeReview(downstream), true);
    assert.equal(index.completeReview(downstream), false);
    assert.equal(index.isCurrent(a), true);
    assert.equal(index.isCurrent(b), true);
});

test("second source change invalidates in-flight review, even with the same notification", () => {
    const a: Claim = claim("a", [evidence("e", { origin: "measurement" })]);
    const index: WarrantRevalidation = new WarrantRevalidation([a]);
    index.invalidate([Origin]);
    const old: ReviewToken = index.beginReview("a");
    index.invalidate([Origin, Origin]);
    assert.equal(index.completeReview(old), false);
    assert.equal(index.completeReview({ ...index.beginReview("a") }), false);
    assert.equal(index.completeReview(index.beginReview("a")), true);
    assert.equal(index.needsRevalidation("a"), false);
});

test("unknown change batch cannot partially mark known claims", () => {
    const a: Claim = claim("a", [evidence("e", { origin: "measurement" })]);
    const index: WarrantRevalidation = new WarrantRevalidation([a]);
    assert.throws(() => index.invalidate([Origin, { kind: "origin", id: "unknown" }]), /unknown/);
    assert.equal(index.isCurrent(a), true);
    assert.equal(index.needsRevalidation("missing"), true);
    assert.throws(() => index.beginReview("missing"), /unknown/);
});

test("contradicting/undercutting sources also trigger review and refs retain namespaces", () => {
    const a: Claim = claim("a", [evidence("e", { ref: { kind: "claim", id: "b" }, relation: "contradicts" })]);
    const b: Claim = claim("b", [evidence("e", { ref: { kind: "tool", id: "b" }, relation: "undercuts" })]);
    const index: WarrantRevalidation = new WarrantRevalidation([a, b]);
    assert.deepEqual(index.invalidate([{ kind: "evidence", claimId: "a", id: "e" }]).claims, ["a"]);
    assert.equal(index.isCurrent(b), true);
    assert.deepEqual(index.invalidate([{ kind: "ref", ref: { kind: "tool", id: "b" } }]).claims, ["b", "a"]);
});

test("missing or non-held antecedents prevent dependent review completion", () => {
    const a: Claim = claim("a", [evidence("e", { ref: { kind: "claim", id: "missing" } })]);
    const index: WarrantRevalidation = new WarrantRevalidation([a]);
    assert.equal(index.isCurrent(a), false);
    assert.equal(index.completeReview(index.beginReview("a")), false);
    const retracted: Claim = { ...claim("missing"), status: "retracted" };
    const other: WarrantRevalidation = new WarrantRevalidation([a, retracted]);
    assert.equal(other.completeReview(other.beginReview("missing")), true);
    assert.equal(other.completeReview(other.beginReview("a")), false);
});

test("supersedes is history, cycles and duplicate snapshot identities are rejected", () => {
    const a: Claim = claim("a");
    const b: Claim = { ...claim("b"), supersedes: { kind: "claim", id: "a" } };
    const index: WarrantRevalidation = new WarrantRevalidation([a, b]);
    assert.deepEqual(index.invalidate([{ kind: "ref", ref: { kind: "claim", id: "a" } }]).claims, ["a"]);
    assert.equal(index.isCurrent(b), true);
    assert.throws(() => new WarrantRevalidation([a, a]), /duplicate/);
    assert.throws(() => new WarrantRevalidation([a], [plan("p", "a"), plan("p", "a")]), /duplicate/);
    const cyclic: Claim = claim("a", [evidence("e", { ref: { kind: "claim", id: "b" } })]);
    assert.throws(() => new WarrantRevalidation([cyclic, claim("b", [evidence("e", { ref: { kind: "claim", id: "a" } })])]), /cycle/);
});

test("policy blocks stale/mutated/unknown claim bodies without burning an approval", () => {
    const a: Claim = claim("a", [evidence("e", { origin: "measurement" })]);
    const index: WarrantRevalidation = new WarrantRevalidation([a]);
    const policy: PolicyEngine = new PolicyEngine({ now: () => At, isClaimCurrent: (value) => index.isCurrent(value) });
    const request: ActionRequest = { action: "send.result", effect: "send", claim: a };
    const approval: ReturnType<PolicyEngine["approve"]> = policy.approve({ action: request.action, effect: request.effect, approvedBy: "host" });
    index.invalidate([Origin]);
    assert.equal(policy.decide(request, approval).reason, "claim_requires_revalidation");
    assert.equal(policy.consume(approval.id, request).reason, "claim_requires_revalidation");
    assert.equal(index.completeReview(index.beginReview("a")), true);
    assert.equal(policy.decide({ ...request, claim: { ...a, statement: "different" } }, approval).reason, "claim_requires_revalidation");
    assert.equal(policy.decide({ ...request, claim: claim("unknown") }, approval).reason, "claim_requires_revalidation");
    assert.equal(policy.decide(request, approval).outcome, "allow");
    assert.equal(policy.decide(request, approval).reason, "approval_consumed");
    a.warrant.evidence[0].origin = "mutated";
    assert.equal(index.isCurrent(a), false);
});

test("freshness callback failure denies; legacy policy and claimless read retain behavior", () => {
    const a: Claim = claim("a", [evidence("e")]);
    const request: ActionRequest = { action: "edit", effect: "write-reversible", claim: a };
    const broken: PolicyEngine = new PolicyEngine({
        now: () => At,
        isClaimCurrent: () => {
            throw new Error("offline");
        },
    });
    assert.equal(broken.decide(request).reason, "claim_freshness_unavailable");
    assert.equal(new PolicyEngine({ now: () => At }).decide(request).outcome, "allow");
    assert.equal(broken.decide({ action: "inspect", effect: "read" }).outcome, "allow");
});
