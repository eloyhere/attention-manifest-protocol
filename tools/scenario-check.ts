#!/usr/bin/env node
/**
 * Scenario mix checks: scenarios are weights, not mutually exclusive modes.
 *
 * A mix controls context shares, memory kinds, token multiplier, attention
 * policy and style. The same agent is assembled under chat vs engineering to
 * prove that context size and memory selection actually differ.
 */
import assert from "node:assert/strict";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import {
    ScenarioKinds,
    contextBudgetTokens,
    normalizeScenarioMix,
    resolveScenario,
    scenarioAttentionPolicy,
    shouldUseBareContext,
} from "../src/scenario/scenario.ts";
import type { ScenarioKind, ScenarioMix, ScenarioPlan } from "../src/scenario/scenario.ts";
import type { AttentionResourcePolicy } from "../src/attention/resource.ts";
import type { AgentContext } from "../src/context/agentContext.ts";

const At: string = "2026-10-24T00:00:00.000Z";

let Passed: number = 0;
let Failed: number = 0;

const test: (name: string, fn: () => void) => void = (name: string, fn: () => void): void => {
    try {
        fn();
        Passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        Failed += 1;
        const message: string = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
};

const setup: () => AgentService = (): AgentService => {
    const service: AgentService = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    service.createAgent({
        pid: 1,
        id: "a.scenario",
        name: "Ada Scenario",
        values: ["truth"],
        constraints: ["do not fabricate evidence"],
        narrative: "I adjust how much of myself to bring to the task.",
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
    service.remember({ pid: 1, kind: "semantic", content: "Checkout depends on the payment service.", salience: 0.8, at: At });
    service.remember({ pid: 1, kind: "procedural", content: "Run the migration before the integration tests.", salience: 0.9, at: At });
    service.remember({ pid: 1, kind: "episodic", content: "The deploy broke checkout last time.", salience: 0.7, at: At });
    service.remember({ pid: 1, kind: "affective", content: "I felt anxious during the incident.", salience: 0.6, at: At });
    service.setAffect(1, { valence: 0.1, arousal: 0.3, stress: 0.35, fatigue: 0.2, mood: "focused" }, At);
    service.createInstitution({ id: "org.team", name: "Team", norms: ["blameless review"] });
    service.joinInstitution({ pid: 1, institutionId: "org.team", role: "responder", since: At });
    return service;
};

const mix: (input: ScenarioMix) => ScenarioPlan = (input: ScenarioMix): ScenarioPlan => resolveScenario(input);

test("scenario weights normalize and do not need to be mutually exclusive", () => {
    const weights: Record<ScenarioKind, number> = normalizeScenarioMix({ chat: 3, engineering: 1 });
    assert.equal(weights.chat, 0.75);
    assert.equal(weights.engineering, 0.25);
    assert.equal(weights.writing, 0);
    assert.equal(
        ScenarioKinds.reduce((sum, kind) => sum + weights[kind], 0),
        1,
    );
    assert.throws(() => normalizeScenarioMix({}), /positive/);
    assert.throws(() => normalizeScenarioMix({ chat: -1 }), /non-negative/);
});

test("a mixed task keeps both facets instead of picking one", () => {
    const plan: ScenarioPlan = mix({ chat: 0.6, engineering: 0.4 });
    assert.deepEqual(plan.active, ["chat", "engineering"]);
    assert.equal(plan.weights.chat, 0.6);
    assert.equal(plan.weights.engineering, 0.4);
    assert.equal(plan.mode, "compact");
    assert.equal(plan.tokenBudgetFactor > 0.4 && plan.tokenBudgetFactor < 1.1, true);
    assert.equal(plan.contextWeights.memory > 0.3, true);
    assert.equal(plan.memoryKindWeights.social > 0, true);
    assert.equal(plan.memoryKindWeights.procedural > 0, true);
});

test("context depth selects bare, compact or full", () => {
    assert.equal(mix({ chat: 1 }).mode, "bare");
    assert.equal(shouldUseBareContext(mix({ chat: 1 })), true);
    assert.equal(mix({ writing: 1 }).mode, "compact");
    assert.equal(mix({ engineering: 1 }).mode, "full");
    assert.equal(mix({ research: 1 }).mode, "full");
    assert.equal(shouldUseBareContext(mix({ research: 1 })), false);
});

test("token multiplier and attention policy follow the mix", () => {
    const chat: ScenarioPlan = mix({ chat: 1 });
    const engineering: ScenarioPlan = mix({ engineering: 1 });
    assert.equal(contextBudgetTokens(chat, 400), 160);
    assert.equal(contextBudgetTokens(engineering, 400), 440);

    const chatPolicy: AttentionResourcePolicy = scenarioAttentionPolicy(chat);
    const engineeringPolicy: AttentionResourcePolicy = scenarioAttentionPolicy(engineering);
    assert.equal(chatPolicy.maxForegroundUtil, 0.5);
    assert.equal(engineeringPolicy.maxForegroundUtil, 0.8);
    assert.equal(chatPolicy.reserveRatio, 0.35);
    assert.equal(engineeringPolicy.reserveRatio, 0.2);
    assert.equal(engineeringPolicy.minSliceSlots, 2);
    assert.equal(engineeringPolicy.restAfterCycles, 6);
});

test("same agent assembles smaller chat context and larger engineering context", () => {
    const service: AgentService = setup();
    const chat: AgentContext = service.context(1, { tokens: 600 }, { scenario: mix({ chat: 1 }) });
    const engineering: AgentContext = service.context(1, { tokens: 600 }, { scenario: mix({ engineering: 1 }) });
    assert.equal(chat.scenario?.mode, "bare");
    assert.equal(engineering.scenario?.mode, "full");
    assert.equal(chat.tokens < engineering.tokens, true);
    assert.equal(chat.tokens <= 240, true);
    assert.equal(engineering.tokens > 0, true);
});

test("memory kind weights change which memories are retrieved", () => {
    const service: AgentService = setup();
    const chat: AgentContext = service.context(1, { tokens: 600 }, { scenario: mix({ chat: 1 }) });
    const engineering: AgentContext = service.context(1, { tokens: 600 }, { scenario: mix({ engineering: 1 }) });
    const chatMemory: string = chat.segments
        .filter((segment) => segment.kind === "memory")
        .map((segment) => segment.text)
        .join(" ");
    const engineeringMemory: string = engineering.segments
        .filter((segment) => segment.kind === "memory")
        .map((segment) => segment.text)
        .join(" ");
    assert.equal(chatMemory.includes("Mira"), true);
    assert.equal(engineeringMemory.includes("migration"), true);
});

test("a zero-weight scenario contributes no context share", () => {
    const plan: ScenarioPlan = mix({ engineering: 1 });
    assert.equal(plan.contextWeights.membership <= 0.05, true);
    assert.equal(plan.attention.minSliceSlots, 2);
    assert.equal(plan.style.toolBias, "heavy");
});

console.log(`\n${Passed} passed, ${Failed} failed`);
if (Failed > 0) {
    process.exitCode = 1;
}
