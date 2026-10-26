#!/usr/bin/env node
/**
 * Interaction-mode checks: affect/think/inspire/converge/orchestrate are
 * weighted modes, orthogonal to scenarios.
 *
 * The tests check the psychology-facing behavior: affect validates without
 * diagnosing, inspiration diverges but labels hypotheses, convergence invites
 * dissent, and orchestration exposes ownership/coordination.
 */
import assert from "node:assert/strict";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { resolveScenario } from "../src/scenario/scenario.ts";
import { combineContextWeights, combineMemoryWeights, normalizeInteractionMix, phaseFor, resolveInteraction } from "../src/interaction/interaction.ts";
import type { InteractionMix } from "../src/interaction/interaction.ts";

const At = "2026-10-24T00:00:00.000Z";

let passed = 0;
let failed = 0;

const test = (name: string, fn: () => void): void => {
    try {
        fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const setup = () => {
    const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    service.createAgent({
        pid: 1,
        id: "a.interaction",
        name: "Ada Interaction",
        values: ["truth", "care"],
        constraints: ["do not fabricate evidence"],
        narrative: "I can be warm without pretending to be a therapist.",
        at: At,
    });
    service.addRole({
        id: "role.analyst",
        label: "Analyst",
        obligations: [{ id: "ob.evidence", statement: "ground claims in evidence" }],
        audiences: ["team"],
        createdAt: At,
    });
    service.assignRole({ pid: 1, roleId: "role.analyst", salience: 0.8, active: true, since: At });
    service.remember({ pid: 1, kind: "social", content: "Mira warned me about the payment coupling.", salience: 0.9, at: At });
    service.remember({ pid: 1, kind: "procedural", content: "Run the migration before the integration tests.", salience: 0.9, at: At });
    service.remember({ pid: 1, kind: "affective", content: "I felt anxious during the incident.", salience: 0.8, at: At });
    service.setAffect(1, { valence: 0.1, arousal: 0.3, stress: 0.35, fatigue: 0.2, mood: "focused" }, At);
    return service;
};

const mix = (input: InteractionMix) => resolveInteraction(input);

test("interaction weights normalize and can combine affect with convergence", () => {
    const weights = normalizeInteractionMix({ affect: 3, converge: 1 });
    assert.equal(weights.affect, 0.75);
    assert.equal(weights.converge, 0.25);
    assert.throws(() => normalizeInteractionMix({}), /positive/);
    assert.throws(() => normalizeInteractionMix({ think: -1 }), /non-negative/);

    const plan = mix({ affect: 0.6, converge: 0.4 });
    assert.deepEqual(plan.active, ["affect", "converge"]);
    assert.equal(plan.primary, "affect");
    assert.equal(plan.secondary, "converge");
    assert.deepEqual(plan.sequence, ["affect", "converge"]);
    assert.equal(plan.moves.includes("validate"), true);
    assert.equal(plan.moves.includes("decide"), true);
    assert.equal(plan.safety.noDiagnosis, true);
    assert.equal(plan.safety.inviteDissent, true);
    assert.equal(plan.response.structure, "dialogue");
    assert.equal(plan.guardrails.length >= 2, true);
});

test("inspiration mode is broad and labels hypotheses", () => {
    const plan = mix({ inspire: 1 });
    assert.equal(plan.primary, "inspire");
    assert.equal(plan.attention.breadth > 0.8, true);
    assert.equal(plan.attention.depth < 0.4, true);
    assert.equal(plan.moves.includes("diverge"), true);
    assert.equal(plan.moves.includes("analogize"), true);
    assert.equal(plan.safety.labelHypotheses, true);
    assert.equal(plan.safety.inviteDissent, true);
    assert.equal(plan.response.questionRatio > 0.4, true);
});

test("thinking mode is deep and does not claim diagnosis", () => {
    const plan = mix({ think: 1 });
    assert.equal(plan.primary, "think");
    assert.equal(plan.attention.depth > 0.8, true);
    assert.equal(plan.safety.labelHypotheses, true);
    assert.equal(plan.safety.noDiagnosis, false);
    assert.equal(plan.moves.includes("analyze"), true);
});

test("convergence invites dissent and is safe to close", () => {
    const plan = mix({ converge: 1 });
    assert.equal(plan.primary, "converge");
    assert.equal(plan.safety.inviteDissent, true);
    assert.equal(plan.response.verbosity, "terse");
    assert.equal(plan.moves.includes("summarize"), true);
    assert.equal(plan.moves.includes("commit"), true);
});

test("orchestration exposes ownership and coordination load", () => {
    const plan = mix({ orchestrate: 1 });
    assert.equal(plan.primary, "orchestrate");
    assert.equal(plan.contextWeights.role > 0.25, true);
    assert.equal(plan.contextWeights.relationship > 0.2, true);
    assert.equal(plan.contextWeights.membership > 0.15, true);
    assert.equal(plan.moves.includes("assign"), true);
    assert.equal(plan.moves.includes("handoff"), true);
    assert.equal(plan.safety.noManipulation, true);
});

test("affect and engineering combine into context weights", () => {
    const scenario = resolveScenario({ engineering: 1 });
    const interaction = mix({ affect: 0.7, converge: 0.3 });
    const combined = combineContextWeights(scenario.contextWeights, interaction.contextWeights);
    assert.equal(combined.affect > scenario.contextWeights.affect, true);
    assert.equal(combined.relationship > scenario.contextWeights.relationship, true);
    assert.equal(Math.abs(Object.values(combined).reduce((sum, value) => sum + value, 0) - 1) < 1e-9, true);

    const memory = combineMemoryWeights(scenario.memoryKindWeights, interaction.memoryKindWeights);
    assert.ok(memory);
    assert.equal(memory.social > scenario.memoryKindWeights.social, true);
});

test("same agent retrieves social memory under affect and procedural under engineering", () => {
    const service = setup();
    const engineering = resolveScenario({ engineering: 1 });
    const affect = mix({ affect: 1 });
    const engineeringContext = service.context(1, { tokens: 600 }, { scenario: engineering });
    const affectContext = service.context(1, { tokens: 600 }, { scenario: engineering, interaction: affect });
    assert.equal(engineeringContext.interaction, (void 0));
    assert.equal(affectContext.interaction?.primary, "affect");
    const engineeringMemory = engineeringContext.segments
        .filter((segment) => segment.kind === "memory")
        .map((segment) => segment.text)
        .join(" ");
    const affectMemory = affectContext.segments
        .filter((segment) => segment.kind === "memory")
        .map((segment) => segment.text)
        .join(" ");
    assert.equal(engineeringMemory.includes("migration"), true);
    assert.equal(affectMemory.includes("Mira"), true);
});

test("phase mapping follows the dominant mode", () => {
    assert.equal(phaseFor(mix({ affect: 1 })), "open");
    assert.equal(phaseFor(mix({ inspire: 1 })), "explore");
    assert.equal(phaseFor(mix({ think: 1 })), "analyze");
    assert.equal(phaseFor(mix({ converge: 1 })), "decide");
    assert.equal(phaseFor(mix({ orchestrate: 1 })), "coordinate");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
