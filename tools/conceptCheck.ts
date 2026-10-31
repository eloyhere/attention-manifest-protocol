#!/usr/bin/env node
/**
 * Concept economy checks.
 *
 * A concept is paid for on every turn that uses it, so its content must stay
 * bounded. The tests below hold the line at both ends: nothing that makes the
 * concept a concept may be trimmed, and nothing may leave without a reason.
 */
import assert from "node:assert/strict";

import { ConceptCompactionRefused, compactConceptHistory, pruneConcept, verifyConceptCheckpoint } from "../src/concept/conceptBudget.ts";
import type { ConceptHistoryCompaction, ConceptPruneResult } from "../src/concept/conceptBudget.ts";
import type { ConceptDrop } from "../src/concept/conceptBudgetTypes.ts";
import type { Concept } from "../src/types/index.ts";

let Passed: number = 0;
let Failed: number = 0;

type SyncTest = (name: string, fn: () => void) => void;

const test: SyncTest = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed++;
        console.log(`\u2713 ${name}`);
    } catch (error) {
        Failed++;
        console.log(`\u2717 ${name}`);
        console.log(`    ${(error as Error).message}`);
    }
};

type ConceptFactory = (over?: Partial<Concept>) => Concept;

const concept: ConceptFactory = (over: Partial<Concept> = {}): Concept => {
    return {
        amp: "0.1",
        kind: "concept",
        id: "c.deploy-drift",
        label: "deploy drift",
        definition: "configuration diverges from the declared state",
        intension: [{ feature: "declared differs from observed", weight: 0.9 }],
        examples: [{ description: "a config map edited by hand" }],
        relations: [{ type: "causes", target: { kind: "claim", id: "cl.1" } }],
        status: "active",
        confidence: 0.7,
        provenance: { source: "test" },
        version: 1,
        created: "2026-10-24T01:00:00Z",
        ...over,
    };
};

/**
 * A value that carries a human-readable description.
 */
type Described = {
    description: string;
};

/**
 * Renders the descriptions of a list of described values.
 */
type Descriptions = (items?: Described[]) => string[];

const descriptions: Descriptions = (items?: Described[]): string[] => (items ?? []).map((item) => item.description);

/**
 * Verdict returned by `verifyConceptCheckpoint()`.
 */
type CheckpointVerdict = {
    ok: boolean;
    reasons: string[];
};

test("a concept inside its budget is returned unchanged", () => {
    const original: Concept = concept();
    const before: string = JSON.stringify(original);
    const { plan, concept: view }: ConceptPruneResult = pruneConcept(original);
    assert.deepEqual(plan.dropped, []);
    assert.equal(plan.reclaimedBytes, 0);
    assert.deepEqual(view, original);
    assert.equal(JSON.stringify(original), before, "input must not be mutated");
});

test("duplicate examples collapse, and the more typical one survives", () => {
    const { concept: view, plan }: ConceptPruneResult = pruneConcept(
        concept({
            examples: [
                { description: "config map edited by hand", typicality: 0.3 },
                { description: "Config  map edited by hand", typicality: 0.9 },
            ],
        }),
    );
    assert.deepEqual(descriptions(view.examples), ["Config  map edited by hand"]);
    assert.equal(plan.dropped.length, 1);
    assert.equal(plan.dropped[0].reason, "duplicate");
    assert.equal(plan.dropped[0].index, 0);
});

test("examples beyond the ceiling are trimmed from the least typical end", () => {
    const { concept: view, plan }: ConceptPruneResult = pruneConcept(
        concept({
            examples: [
                { description: "a", typicality: 0.9 },
                { description: "b", typicality: 0.2 },
                { description: "c", typicality: 0.7 },
            ],
        }),
        { maxExamples: 2 },
    );
    assert.deepEqual(descriptions(view.examples), ["a", "c"]);
    assert.deepEqual(
        plan.dropped.map((d) => d.reason),
        ["over-budget"],
    );
    assert.equal(plan.dropped[0].summary, "b");
});

test("the grounding floor wins over the ceiling", () => {
    const { concept: view }: ConceptPruneResult = pruneConcept(concept({ examples: [{ description: "a" }, { description: "b" }] }), {
        maxExamples: 0,
        minExamples: 1,
    });
    assert.equal(view.examples?.length, 1);
});

test("the definition, intension and counterexamples are never trimmed", () => {
    const original: Concept = concept({
        counterexamples: [{ description: "a declared change that was applied as written" }],
        examples: [{ description: "one" }, { description: "two" }, { description: "three" }],
    });
    const { concept: view }: ConceptPruneResult = pruneConcept(original, { maxExamples: 1 });
    assert.deepEqual(view.intension, original.intension);
    assert.equal(view.definition, original.definition);
    assert.deepEqual(view.counterexamples, original.counterexamples);
    assert.equal(view.examples?.length, 1);
});

test("relations are de-duplicated, and dangling targets leave the view", () => {
    const { concept: view, plan }: ConceptPruneResult = pruneConcept(
        concept({
            relations: [
                { type: "causes", target: { kind: "claim", id: "cl.1" } },
                { type: "causes", target: { kind: "claim", id: "cl.1" } },
                { type: "contrasts-with", target: { kind: "concept", id: "c.declared-state" } },
            ],
        }),
        {},
        { known: (kind, id) => kind === "claim" && id === "cl.1" },
    );
    assert.deepEqual(
        view.relations?.map((r) => `${r.type}:${r.target.id}`),
        ["causes:cl.1"],
    );
    const reasons: string[] = plan.dropped.map((d) => d.reason).sort();
    assert.deepEqual(reasons, ["dangling", "duplicate"]);
});

test("relations beyond the ceiling are trimmed, and the plan says how much was saved", () => {
    const { concept: view, plan }: ConceptPruneResult = pruneConcept(
        concept({
            relations: [
                { type: "is-a", target: { kind: "concept", id: "c.drift" } },
                { type: "causes", target: { kind: "claim", id: "cl.1" } },
            ],
        }),
        { maxRelations: 1 },
    );
    assert.equal(view.relations?.length, 1);
    assert.equal(plan.dropped[0].reason, "over-budget");
    assert.ok(plan.reclaimedBytes > 0);
});

test("base statements the concept carries: every drop says why and when to return", () => {
    const { plan }: ConceptPruneResult = pruneConcept(
        concept({
            examples: [{ description: "a" }, { description: "a" }, { description: "b" }],
            extension: [
                { kind: "claim", id: "cl.1" },
                { kind: "claim", id: "cl.1" },
            ],
        }),
        { maxExamples: 1 },
    );
    assert.ok(plan.dropped.length >= 3);
    for (let index: number = 0; index < plan.dropped.length; index += 1) {
        const item: ConceptDrop = plan.dropped[index];
        assert.ok(["duplicate", "over-budget", "dangling"].includes(item.reason));
        assert.ok(item.revisit_if.length > 10);
        assert.ok(["example", "relation", "extension"].includes(item.slot));
    }
    assert.equal(plan.concept, "c.deploy-drift");
    assert.equal(plan.version, 1, "a view must not bump the version");
});

test("concept pruning is deterministic", () => {
    const original: Concept = concept({
        examples: [{ description: "a" }, { description: "a" }, { description: "b" }],
    });
    const first: ConceptPruneResult = pruneConcept(original, { maxExamples: 1 });
    const second: ConceptPruneResult = pruneConcept(original, { maxExamples: 1 });
    assert.deepEqual(first.plan, second.plan);
    assert.deepEqual(first.concept, second.concept);
});

test("history compaction keeps the head and covers the rest", () => {
    const versions: Concept[] = [1, 2, 3].map((version) => concept({ version, definition: `definition v${version}` }));
    const compaction: ConceptHistoryCompaction = compactConceptHistory(versions, { keepVersions: 1, now: "2026-10-24T01:00:00Z" });
    assert.equal(compaction.removed.length, 2);
    assert.equal(compaction.head.version, 3);
    assert.equal(compaction.checkpoint.from, 1);
    assert.equal(compaction.checkpoint.to, 2);
    assert.equal(compaction.checkpoint.count, 2);
    assert.deepEqual(verifyConceptCheckpoint(compaction.checkpoint, compaction.removed, compaction.head), {
        ok: true,
        reasons: [],
    });
});

test("a checkpoint whose root was rewritten is rejected", () => {
    const versions: Concept[] = [1, 2, 3].map((version) => concept({ version }));
    const compaction: ConceptHistoryCompaction = compactConceptHistory(versions, { keepVersions: 1 });
    const rewritten: ConceptHistoryCompaction = {
        ...compaction,
        checkpoint: { ...compaction.checkpoint, root: `sha256:${"0".repeat(64)}` },
    };
    const verdict: CheckpointVerdict = verifyConceptCheckpoint(rewritten.checkpoint, rewritten.removed, rewritten.head);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes("root")));
});

test("a head that does not continue the checkpoint is rejected", () => {
    const versions: Concept[] = [1, 2, 3].map((version) => concept({ version }));
    const compaction: ConceptHistoryCompaction = compactConceptHistory(versions, { keepVersions: 1 });
    const verdict: CheckpointVerdict = verifyConceptCheckpoint(compaction.checkpoint, compaction.removed, concept({ version: 9 }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some((reason) => reason.includes("head version")));
});

test("compaction refuses a broken lineage instead of asserting completeness", () => {
    const versions: Concept[] = [concept({ version: 1 }), concept({ version: 3 })];
    assert.throws(
        () => compactConceptHistory(versions, { keepVersions: 1 }),
        (error: unknown) => error instanceof ConceptCompactionRefused,
    );
});

test("compaction refuses when every version is inside the retention window", () => {
    const versions: Concept[] = [concept({ version: 1 }), concept({ version: 2 })];
    assert.throws(
        () => compactConceptHistory(versions, { keepVersions: 2 }),
        (error: unknown) => error instanceof ConceptCompactionRefused,
    );
});

test("concept budgets and retention reject non-finite values", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.throws(() => pruneConcept(concept(), { maxExamples: value }), RangeError);
        assert.throws(() => pruneConcept(concept(), { maxRelations: value }), RangeError);
        assert.throws(() => compactConceptHistory([concept({ version: 1 }), concept({ version: 2 })], { keepVersions: value }), ConceptCompactionRefused);
    }
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
