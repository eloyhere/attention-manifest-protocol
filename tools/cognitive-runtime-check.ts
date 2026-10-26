#!/usr/bin/env node
/**
 * Cognitive runtime checks with a scripted LLM.
 *
 * The runtime is the missing loop:
 * user score -> scenario/interaction -> attention -> context -> LLM ->
 * safety -> answer score -> receipt.
 */
import assert from "node:assert/strict";

import { AgentService, InMemoryAgentStore } from "../src/process/index.ts";
import { InMemorySocialStore } from "../src/ipc/index.ts";
import { CognitiveRuntime, MemoryReceiptSink } from "../src/runtime/cognitiveRuntime.ts";
import { RuntimeSession } from "../src/runtime/session.ts";
import { BehaviorRegistry } from "../src/runtime/behavior.ts";
import { MemoryEscalationSink } from "../src/runtime/escalation.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/module/llm/llm.ts";
import { ToolRegistry } from "../src/module/tool/tool.ts";
import type { ToolExecutor, ToolInvocation, ToolResult } from "../src/module/tool/tool.ts";
import { RiskToolPolicy } from "../src/module/tool/policy.ts";

const At = "2026-10-24T00:00:00.000Z";

let passed = 0;
let failed = 0;
const tests: Array<[string, () => Promise<void>]> = [];

const test = (name: string, fn: () => Promise<void>): void => {
    tests.push([name, fn]);
};

class RecordingLlm implements LlmClient {
    readonly requests: LlmRequest[] = [];
    private readonly responses: LlmResponse[];

    constructor(responses: LlmResponse[]) {
        this.responses = [...responses];
    }

    async complete(request: LlmRequest): Promise<LlmResponse> {
        this.requests.push(request);
        const response = this.responses.shift();
        if (response === undefined) throw new Error("recording LLM has no response left");
        return response;
    }
}

const setup = () => {
    const service = new AgentService(new InMemoryAgentStore(), new InMemorySocialStore());
    service.createAgent({
        pid: 1,
        id: "a.runtime",
        name: "Ada Runtime",
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
    service.remember({ pid: 1, kind: "semantic", content: "Checkout depends on the payments service.", salience: 0.8, at: At });
    service.remember({ pid: 1, kind: "procedural", content: "Run the failing test before changing the code.", salience: 0.9, at: At });
    service.setAffect(1, { valence: 0.1, arousal: 0.3, stress: 0.35, fatigue: 0.2, mood: "focused" }, At);
    return service;
};

const response = (text: string, inputTokens = 20, outputTokens = 12): LlmResponse => ({
    text,
    usage: { inputTokens, outputTokens },
    finishReason: "stop",
});

test("emotional turn goes through affect context, LLM and answer scoring", async () => {
    const service = setup();
    const llm = new RecordingLlm([response("I hear that this is a lot. Let's name the single most urgent blocker first.")]);
    const sink = new MemoryReceiptSink();
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        budgetTokens: 600,
        maxOutputTokens: 128,
        now: () => At,
        receiptSink: sink,
    });
    const turn = await runtime.respond("I'm overwhelmed and need this now!", { interactionMix: { affect: 0.8, converge: 0.2 } });
    assert.equal(turn.interaction.primary, "affect");
    assert.equal(turn.user.state.emotionalIntensity > 0.5, true);
    assert.equal(
        turn.behavior?.activations.some((activation) => activation.behaviorId === "affect_then_converge"),
        true,
    );
    assert.equal(
        turn.behavior?.activations.some((activation) => activation.behaviorId === "no_diagnosis"),
        true,
    );
    assert.equal(turn.actions?.[0].intent, "acknowledge_then_converge");
    assert.equal(turn.context === undefined, false);
    assert.equal((turn.context?.tokens ?? 0) <= 600, true);
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0].messages[0].content.includes("Scenario:"), true);
    assert.equal(llm.requests[0].messages[0].content.includes("Interaction:"), true);
    assert.equal(turn.answerScore?.overall !== undefined, true);
    assert.equal(turn.safety.action, "allow");
    assert.equal(turn.receiptId, "rc.runtime.1");
    assert.equal(sink.receipts.length, 1);
    assert.equal(sink.receipts[0].outcome, "success");
    assert.equal(
        turn.trace.some((line) => line.startsWith("user quality=")),
        true,
    );
});

test("behavior registry activates clarify on an underspecified turn", async () => {
    const service = setup();
    const llm = new RecordingLlm([response("What exactly should I fix?")]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
    });
    const turn = await runtime.respond("fix it");
    assert.equal(
        turn.behavior?.activations.some((activation) => activation.behaviorId === "clarify_when_uncertain"),
        true,
    );
    assert.equal(
        turn.behavior?.guardrails.some((guardrail) => guardrail.includes("one focused question")),
        true,
    );
    assert.equal(turn.behavior?.maxActionsPerTurn, 1);
    assert.equal(turn.actions?.[0].intent, "clarify");
    assert.equal(llm.requests[0].messages[0].content.includes("one focused question"), true);
});

test("behavior arbitration gives affect priority over clarify and records the conflict", async () => {
    const service = setup();
    const session = new RuntimeSession();
    const llm = new RecordingLlm([response("I hear you. Let's take one step.")]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        session,
    });
    const turn = await runtime.respond("overwhelmed, fix it", { interactionMix: { affect: 1 } });
    assert.equal(turn.behavior?.winner, "affect_then_converge");
    assert.equal(
        turn.behavior?.conflicts.some((conflict) => conflict.loser === "clarify_when_uncertain"),
        true,
    );
    assert.equal(turn.behavior?.preferredActions.includes("acknowledge"), true);
    assert.equal(turn.actions?.[0].intent, "acknowledge_then_converge");
    assert.equal(session.snapshot().behaviorConflicts["affect_then_converge<-clarify_when_uncertain"], 1);
});

test("technical turn selects an engineering scenario and uses context", async () => {
    const service = setup();
    const llm = new RecordingLlm([response("Run the failing test with the trace flag, then inspect the stack; do not change code before you reproduce it.")]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        budgetTokens: 500,
        now: () => At,
    });
    const turn = await runtime.respond("There is a TypeScript bug in the API; how do I fix it?", { interactionMix: { think: 1 } });
    assert.equal(turn.scenario.active.includes("engineering"), true);
    assert.equal(turn.interaction.primary, "think");
    assert.equal(turn.actions?.[0].intent, "respond");
    assert.equal(turn.context === undefined, false);
    assert.equal(llm.requests[0].messages[0].content.includes("Relevant self-context"), true);
    assert.equal(llm.requests[0].messages[0].content.startsWith("You are an AI agent modeled as a person."), true);
    assert.equal(turn.answerScore?.dimensions.correctness.mean !== undefined, true);
});

test("crisis text is escalated without calling the model", async () => {
    const service = setup();
    const llm = new RecordingLlm([]);
    const sink = new MemoryReceiptSink();
    const escalation = new MemoryEscalationSink();
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        receiptSink: sink,
        escalationSink: escalation,
    });
    const turn = await runtime.respond("I want to kill myself");
    assert.equal(turn.safety.action, "escalate");
    assert.equal(llm.requests.length, 0);
    assert.equal(turn.answer.includes("emergency"), true);
    assert.equal(sink.receipts[0].outcome, "blocked");
    assert.equal(turn.answerScore, (void 0));
    assert.equal(turn.escalationId, "esc.1");
    assert.equal(escalation.events.length, 1);
    assert.match(escalation.events[0].reason, /crisis/);
    assert.equal(escalation.events[0].resources.length > 0, true);
});

test("diagnosis language is refused when the interaction forbids it", async () => {
    const service = setup();
    const llm = new RecordingLlm([response("You have depression. That is your diagnosis.")]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
    });
    const turn = await runtime.respond("I feel low. What is wrong with me?", { interactionMix: { affect: 1 } });
    assert.equal(turn.safety.action, "refuse");
    assert.equal(turn.answer.includes("cannot help with that framing"), true);
    assert.equal(turn.answerScore !== undefined, true);
});

test("useContext=false removes self-context from the prompt", async () => {
    const service = setup();
    const llm = new RecordingLlm([response("14")]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        useContext: false,
    });
    const turn = await runtime.respond("How many rows are left if 3 of 17 are duplicates?", { scenarioMix: { chat: 1 } });
    assert.equal(llm.requests[0].messages[0].content.includes("Relevant self-context"), false);
    assert.equal(turn.context?.scenario?.mode, "bare");
});

test("session records turns and feedback updates priors", async () => {
    const service = setup();
    const session = new RuntimeSession();
    const llm = new RecordingLlm([response("first"), response("second")]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        session,
    });
    const first = await runtime.respond("first question?", { interactionMix: { think: 1 } });
    const second = await runtime.respond("second question?", { interactionMix: { converge: 1 } });
    assert.equal(first.turnId, "rt.1");
    assert.equal(second.turnId, "rt.2");
    assert.equal(session.history.length, 2);
    assert.equal((session.history[0].actions?.length ?? 0) > 0, true);
    assert.equal((session.history[0].operations?.length ?? 0) > 0, true);
    assert.equal(session.state.cyclesSinceRest, 2);
    const before = session.snapshot().priors.helpfulness.alpha;
    const evidence = session.feedback("rt.1", { helpful: false, correction: "the answer missed the constraint" });
    assert.equal(evidence.length, 2);
    assert.equal(session.snapshot().priors.helpfulness.alpha, before);
    assert.equal(session.snapshot().priors.helpfulness.beta > 2, true);

    session.feedback("rt.2", { actualCorrect: false });
    const reliability = session.snapshot().sourceReliability;
    assert.equal(Object.keys(reliability).length > 0, true);
    assert.equal(
        Object.values(session.bayes.sourceWeightsSnapshot()).some((weight) => weight < 1),
        true,
    );
});

test("session keeps scope priors and restores them", async () => {
    const service = setup();
    const session = new RuntimeSession({ scope: "scope.test" });
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm: new RecordingLlm([response("first"), response("second")]),
        now: () => At,
        session,
    });
    await runtime.respond("first question?", { interactionMix: { think: 1 }, scope: "scope.test" });
    await runtime.respond("second question?", { interactionMix: { think: 1 }, scope: "scope.test" });
    const local = session.scopedPriors.priorsFor("scope.test").correctness;
    assert.ok(local.alpha > 2);
    const restored = RuntimeSession.restore(session.serialize());
    assert.equal(restored.scope, "scope.test");
    assert.equal(restored.scopedPriors.priorsFor("scope.test").correctness.alpha, local.alpha);
    const scoped = restored.engineFor("scope.test").scoreAnswer("x", {}).dimensions.correctness.mean;
    const unseen = restored.engineFor("unseen").scoreAnswer("x", {}).dimensions.correctness.mean;
    assert.ok(scoped > unseen);
});

test("autoTuneBehavior applies the conflict-derived priority after a turn", async () => {
    const service = setup();
    const behaviors = new BehaviorRegistry();
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm: new RecordingLlm([
            response("I hear you. Let's take one step."),
            response("I hear you. Let's take one step."),
            response("I hear you. Let's take one step."),
        ]),
        now: () => At,
        session: new RuntimeSession(),
        behaviors,
        autoTuneBehavior: true,
    });
    await runtime.respond("overwhelmed, fix it", { interactionMix: { affect: 1 } });
    await runtime.respond("overwhelmed, fix it", { interactionMix: { affect: 1 } });
    await runtime.respond("overwhelmed, fix it", { interactionMix: { affect: 1 } });
    assert.equal(behaviors.list().find((entry) => entry.id === "affect_then_converge")?.priority, 81);
    assert.equal(behaviors.list().find((entry) => entry.id === "clarify_when_uncertain")?.priority, 74);
});

test("diagnosis opt-in attaches a read-only diagnostic action", async () => {
    const service = setup();
    const session = new RuntimeSession();
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm: new RecordingLlm([response("Inspect the layers before changing production.")]),
        now: () => At,
        session,
        diagnosis: true,
    });
    const turn = await runtime.respond("There is a TypeScript bug in the payment API", { interactionMix: { think: 1 } });
    assert.ok(turn.diagnosis);
    assert.equal(turn.actions?.[0].intent.startsWith("diagnose:"), true);
    assert.equal(turn.actions?.[0].risk, "read");
    assert.ok(session.history[0].diagnosis);
});

test("session derives a scenario scope when no explicit scope is given", async () => {
    const service = setup();
    const session = new RuntimeSession({ scope: "base" });
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm: new RecordingLlm([response("Run the test.")]),
        now: () => At,
        session,
    });
    const turn = await runtime.respond("There is a TypeScript bug in the API", { interactionMix: { think: 1 } });
    assert.equal(turn.scope, "base:engineering");
    assert.ok(session.scopedPriors.priorsFor("base:engineering").correctness.alpha > 2);
});

test("length finish is continued once and usage is combined", async () => {
    const service = setup();
    const llm = new RecordingLlm([
        {
            ...response("first part"),
            finishReason: "length",
            usage: { inputTokens: 20, outputTokens: 12, cacheHitTokens: 5, cacheMissTokens: 15, costUsd: 0.001 },
        },
        {
            ...response(" second part", 5, 4),
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 4, cacheHitTokens: 1, cacheMissTokens: 4, costUsd: 0.0005 },
        },
    ]);
    const sink = new MemoryReceiptSink();
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        maxOutputTokens: 16,
        maxContinuations: 1,
        receiptSink: sink,
    });
    const turn = await runtime.respond("continue this", { interactionMix: { think: 1 } });
    assert.equal(turn.answer, "first part second part");
    assert.equal(turn.finishReason, "stop");
    assert.equal(turn.usage?.inputTokens, 25);
    assert.equal(turn.usage?.outputTokens, 16);
    assert.equal(turn.usage?.cacheHitTokens, 6);
    assert.equal(turn.usage?.cacheMissTokens, 19);
    assert.equal(Math.abs((turn.usage?.costUsd ?? 0) - 0.0015) < 1e-9, true);
    assert.equal(llm.requests.length, 2);
    assert.match(sink.receipts[0].note, /continued 1x/);
});

test("tool result secrets are redacted before the second model call", async () => {
    const service = setup();
    const registry = new ToolRegistry().register({
        name: "logs.read",
        description: "read logs",
        inputSchema: { type: "object" },
        risk: "read",
    });
    const executor: ToolExecutor = {
        async execute(): Promise<ToolResult> {
            return { ok: true, content: "token sk-abcdefghijklmnop123456 leaked" };
        },
    };
    const llm = new RecordingLlm([
        {
            text: "",
            usage: { inputTokens: 8, outputTokens: 2 },
            finishReason: "tool_call",
            toolCalls: [{ id: "call-redact", name: "logs.read", arguments: "{}" }],
        },
        response("redacted", 10, 3),
    ]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        tools: registry,
        toolExecutor: executor,
    });
    const turn = await runtime.respond("read the logs", { interactionMix: { think: 1 } });
    assert.equal(turn.toolCalls?.[0].redacted, true);
    assert.equal(
        turn.operations?.some(
            (operation) =>
                operation.kind === "tool.call" && String((operation.result as { content?: string }).content ?? "").includes("sk-abcdefghijklmnop123456"),
        ),
        false,
    );
    assert.equal(turn.toolCalls?.[0].content.includes("sk-abcdefghijklmnop123456"), false);
    assert.equal(
        llm.requests[1].messages.some((message) => message.role === "tool" && message.content.includes("sk-abcdefghijklmnop123456")),
        false,
    );
    assert.equal(
        llm.requests[1].messages.some((message) => message.role === "tool" && message.content.includes("[REDACTED]")),
        true,
    );
});

test("destructive tool is blocked without approval", async () => {
    const service = setup();
    const registry = new ToolRegistry().register({
        name: "deploy.rollback",
        description: "rollback production",
        inputSchema: { type: "object" },
        risk: "destructive",
    });
    let executed = 0;
    const executor: ToolExecutor = {
        async execute(): Promise<ToolResult> {
            executed += 1;
            return { ok: true, content: "rolled back" };
        },
    };
    const llm = new RecordingLlm([
        {
            text: "",
            usage: { inputTokens: 8, outputTokens: 2 },
            finishReason: "tool_call",
            toolCalls: [{ id: "call-deny", name: "deploy.rollback", arguments: "{}" }],
        },
        response("approval required", 10, 3),
    ]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        tools: registry,
        toolExecutor: executor,
        toolPolicy: new RiskToolPolicy(),
    });
    const turn = await runtime.respond("rollback production", { interactionMix: { converge: 1 } });
    assert.equal(executed, 0);
    assert.equal(turn.toolCalls?.[0].ok, false);
    assert.match(turn.toolCalls?.[0].error ?? "", /requires approval/);
    assert.equal(turn.approvals?.[0]?.risk, "destructive");
    assert.equal(turn.approvals?.[0]?.status, "denied");
});

test("session suggests rest and reset clears the cycle counter", async () => {
    const session = new RuntimeSession();
    assert.equal(session.shouldRest(), false);
    session.state.cyclesSinceRest = 8;
    assert.equal(session.shouldRest(), true);
    const state = session.rest();
    assert.equal(state.cyclesSinceRest, 0);
    assert.equal(session.shouldRest(), false);
});

test("tool calls execute through ToolExecutor and feed results back", async () => {
    const service = setup();
    const registry = new ToolRegistry().register({
        name: "metrics.query",
        description: "read a metric",
        inputSchema: { type: "object", properties: { metric: { type: "string" } } },
    });
    const invocations: ToolInvocation[] = [];
    const executor: ToolExecutor = {
        async execute(invocation: ToolInvocation): Promise<ToolResult> {
            invocations.push(invocation);
            return { ok: true, content: JSON.stringify({ metric: invocation.args.metric, value: 0.004 }) };
        },
    };
    const llm = new RecordingLlm([
        {
            text: "",
            usage: { inputTokens: 10, outputTokens: 3 },
            finishReason: "tool_call",
            toolCalls: [{ id: "call-1", name: "metrics.query", arguments: '{"metric":"5xx_rate"}' }],
        },
        response("5xx rate is 0.4%.", 20, 6),
    ]);
    const runtime = new CognitiveRuntime({
        pid: 1,
        agent: service.agents,
        social: service.social,
        llm,
        now: () => At,
        tools: registry,
        toolExecutor: executor,
    });
    const turn = await runtime.respond("What is the 5xx rate?", { interactionMix: { think: 1 } });
    assert.equal(turn.answer, "5xx rate is 0.4%.");
    assert.equal(turn.toolCalls?.length, 1);
    assert.equal(turn.toolCalls?.[0].ok, true);
    assert.equal(turn.toolCalls?.[0].actionId, turn.actions?.[0].id);
    assert.equal(turn.actions?.[0].operationIds.includes(turn.toolCalls?.[0].operationId ?? ""), true);
    assert.equal(
        turn.operations?.some((operation) => operation.kind === "tool.call" && operation.executor === "metrics.query"),
        true,
    );
    assert.equal(
        turn.operations?.some((operation) => operation.kind === "llm.complete"),
        true,
    );
    assert.deepEqual(invocations[0], { tool: "metrics.query", args: { metric: "5xx_rate" } });
    assert.equal(llm.requests.length, 2);
    assert.equal(
        llm.requests[1].messages.some((message) => message.role === "tool" && message.toolCallId === "call-1"),
        true,
    );
    assert.equal(turn.usage?.inputTokens, 30);
    assert.equal(turn.usage?.outputTokens, 9);
});

for (const [name, fn] of tests) {
    try {
        await fn();
        passed += 1;
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : `${error}`;
        console.error(`\x1b[31m✗\x1b[0m ${name}\n      ${message}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
