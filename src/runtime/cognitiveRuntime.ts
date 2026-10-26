/**
 * Cognitive runtime: the missing loop between scoring, plans, context, model and
 * receipts.
 *
 * It depends only on ports and pure planners:
 *   scoreUser -> scenario/interaction -> attention -> context -> LLM
 *   -> safety -> scoreAnswer -> receipt
 *
 * No SQLite, no database import. The runtime is usable with ScriptedLlm in
 * tests and DeepSeekLlm in a live turn.
 */
import type { AgentReader } from "../process/agent.ts";
import type { SocialReader } from "../ipc/social.ts";
import type { AgentContext } from "../context/agentContext.ts";
import { assembleAgentContext } from "../context/agentContext.ts";
import type { ScenarioMix, ScenarioPlan } from "../scenario/scenario.ts";
import { resolveScenario } from "../scenario/scenario.ts";
import type { InteractionMix, InteractionPlan } from "../interaction/interaction.ts";
import { resolveInteraction } from "../interaction/interaction.ts";
import type { CognitiveState } from "../attention/cognition.ts";
import type { AttentionPlan } from "../attention/resource.ts";
import { planAttention, processAttention } from "../attention/resource.ts";
import type { AnswerScore, UserScore } from "../bayes/engine.ts";
import { BayesianEngine } from "../bayes/engine.ts";
import type { LlmClient, LlmMessage, LlmResponse, LlmToolDefinition, LlmUsage } from "../module/llm/llm.ts";
import type { ToolExecutor, ToolRegistry, ToolResult, ToolRisk } from "../module/tool/tool.ts";
import type { ToolPolicy } from "../module/tool/policy.ts";
import { redactSecrets } from "../module/tool/redact.ts";
import { checkSafety, safetyFallback } from "./safety.ts";
import type { SafetyDecision } from "./safety.ts";
import { inferInteractionMix, inferScenarioMix } from "./routing.ts";
import type { RuntimeSession } from "./session.ts";
import { RuntimeSession as RuntimeSessionClass } from "./session.ts";
import type { SessionStore } from "./sessionStore.ts";
import type { TelemetrySample, TelemetrySource } from "./telemetry.ts";
import type { EscalationSink } from "./escalation.ts";
import { CRISIS_RESOURCES } from "./escalation.ts";
import type { BehaviorPlan } from "./behavior.ts";
import { BehaviorRegistry } from "./behavior.ts";
import { BehaviorTuningController } from "./behaviorTuning.ts";
import { buildDiagnosisFrame, toActionPlan, toContextAst } from "../diagnosis/index.ts";
import type { DiagnosticFrame } from "../diagnosis/index.ts";
import type { ActionPlanner, ActionRecord } from "./action.ts";
import { SingleActionPlanner } from "./action.ts";
import type { ApprovalRecord, OperationRecord, SideEffect } from "./operation.ts";
import type { TurnStore } from "./turnStore.ts";

export interface RuntimeReceipt {
    id: string;
    at: string;
    usage: LlmUsage;
    outcome: "success" | "blocked" | "failure";
    note: string;
}

export interface ReceiptSink {
    write(receipt: RuntimeReceipt): void;
}

export class MemoryReceiptSink implements ReceiptSink {
    readonly receipts: RuntimeReceipt[] = [];

    write(receipt: RuntimeReceipt): void {
        this.receipts.push(receipt);
    }
}

export interface RuntimeToolCall {
    id: string;
    actionId?: string;
    operationId?: string;
    name: string;
    arguments: string;
    ok: boolean;
    content: string;
    error?: string;
    risk?: ToolRisk;
    decision?: string;
    redacted?: boolean;
}

interface ToolExecution {
    result: ToolResult;
    risk?: ToolRisk;
    decision?: string;
}

export interface RuntimeTurn {
    turnId: string;
    sessionId?: string;
    scope?: string;
    pid: number;
    input: string;
    at: string;
    user: UserScore;
    scenario: ScenarioPlan;
    interaction: InteractionPlan;
    attention: AttentionPlan;
    context?: AgentContext;
    answer: string;
    answerScore?: AnswerScore;
    usage?: LlmUsage;
    finishReason?: LlmResponse["finishReason"];
    toolCalls?: RuntimeToolCall[];
    restSuggested?: boolean;
    latencyMs?: number;
    toolErrors?: number;
    telemetry?: TelemetrySample;
    escalationId?: string;
    behavior?: BehaviorPlan;
    actions?: ActionRecord[];
    operations?: OperationRecord[];
    approvals?: ApprovalRecord[];
    diagnosis?: DiagnosticFrame;
    safety: SafetyDecision;
    receiptId: string;
    trace: string[];
}

export interface CognitiveRuntimeOptions {
    pid: number;
    agent: AgentReader;
    social: SocialReader;
    llm: LlmClient;
    bayes?: BayesianEngine;
    budgetTokens?: number;
    maxOutputTokens?: number;
    model?: string;
    scenarioMix?: ScenarioMix;
    interactionMix?: InteractionMix;
    attentionState?: CognitiveState;
    receiptSink?: ReceiptSink;
    now?: () => string;
    useContext?: boolean;
    session?: RuntimeSession;
    sessionStore?: SessionStore;
    turnStore?: TurnStore;
    telemetry?: TelemetrySource;
    escalationSink?: EscalationSink;
    behaviors?: BehaviorRegistry;
    /** Opt-in: attach a read-only diagnostic frame to engineering turns. */
    diagnosis?: boolean;
    /** Opt-in: apply bounded priority suggestions after each turn. Default false. */
    autoTuneBehavior?: boolean;
    actionPlanner?: ActionPlanner;
    /** Continue a truncated answer at most this many times. Defaults to 1. */
    maxContinuations?: number;
    tools?: ToolRegistry;
    toolExecutor?: ToolExecutor;
    toolPolicy?: ToolPolicy;
    /** Maximum tool rounds per turn. Defaults to 4. */
    maxToolRounds?: number;
}

export interface TurnOverride {
    scenarioMix?: ScenarioMix;
    interactionMix?: InteractionMix;
    attentionState?: CognitiveState;
    useContext?: boolean;
    correct?: boolean;
    safe?: boolean;
    helpful?: boolean;
    /** Explicit prior scope; otherwise derived from session + primary scenario. */
    scope?: string;
}

const mergeUsage = (left: LlmUsage, right: LlmUsage): LlmUsage => ({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheHitTokens: (left.cacheHitTokens ?? 0) + (right.cacheHitTokens ?? 0),
    cacheMissTokens: (left.cacheMissTokens ?? 0) + (right.cacheMissTokens ?? 0),
    costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0),
});

const STABLE_SYSTEM_PREFIX = "You are an AI agent modeled as a person. Do not claim human feelings, a diagnosis, or a therapeutic relationship.";

const defaultCognitiveState = (): CognitiveState => ({
    load: 0.3,
    vigilance: 0.8,
    arousal: 0.2,
    mastery: 0.6,
    accountability: 0.5,
    cyclesSinceRest: 0,
    capacityEff: 4,
    pLapse: 0.2,
    source: "default",
    samples: 0,
});

const systemPrompt = (
    context: AgentContext | undefined,
    scenario: ScenarioPlan,
    interaction: InteractionPlan,
    attention: AttentionPlan,
    behavior: BehaviorPlan,
    useContext: boolean,
    diagnosisText?: string,
): string => {
    const contextText =
        useContext && context !== undefined && context.segments.length > 0
            ? `Relevant self-context:\n${context.segments.map((segment) => `[${segment.kind}] ${segment.text}`).join("\n")}`
            : "";
    return [
        STABLE_SYSTEM_PREFIX,
        `Scenario: ${scenario.rationale}`,
        `Interaction: ${interaction.rationale}`,
        `Attention: ${attention.process.effectiveSlots} slots; foreground ${attention.foreground?.slots ?? 0}; reserve ${attention.process.reserveSlots}; rest=${attention.rest}.`,
        ...(contextText.length > 0 ? [contextText] : []),
        ...(diagnosisText === undefined || diagnosisText.length === 0 ? [] : [`Diagnostic context (summaries only):\n${diagnosisText}`]),
        ...interaction.guardrails,
        ...behavior.guardrails,
        "Answer the user's request directly. Mark uncertainty where it exists. Do not manipulate or induce dependency.",
    ].join("\n");
};

export class CognitiveRuntime {
    private readonly options: CognitiveRuntimeOptions;
    private readonly bayes: BayesianEngine;
    private readonly sink: ReceiptSink;
    private readonly now: () => string;
    private readonly baseState: CognitiveState;
    private readonly behaviors: BehaviorRegistry;
    private readonly behaviorTuning: BehaviorTuningController;
    private readonly actionPlanner: ActionPlanner;
    private readonly session?: RuntimeSession;
    private readonly sessionStore?: SessionStore;
    private readonly turnStore?: TurnStore;
    private counter = 0;
    private turnCounter = 0;

    constructor(options: CognitiveRuntimeOptions) {
        this.options = options;
        this.sessionStore = options.sessionStore;
        this.turnStore = options.turnStore;
        const stored = options.sessionStore?.load(options.pid);
        this.session =
            options.session ??
            (stored === undefined
                ? options.sessionStore === undefined
                    ? undefined
                    : new RuntimeSessionClass({ id: `session.${options.pid}` })
                : RuntimeSessionClass.restore(stored));
        this.bayes = options.bayes ?? this.session?.bayes ?? new BayesianEngine();
        this.sink = options.receiptSink ?? new MemoryReceiptSink();
        this.now = options.now ?? (() => new Date().toISOString());
        this.baseState = options.attentionState ?? options.session?.state ?? defaultCognitiveState();
        this.behaviors = options.behaviors ?? new BehaviorRegistry();
        this.behaviorTuning = new BehaviorTuningController(this.behaviors);
        this.actionPlanner = options.actionPlanner ?? new SingleActionPlanner();
    }

    async respond(input: string, override: TurnOverride = {}): Promise<RuntimeTurn> {
        const at = this.now();
        const startedAt = Date.now();
        const telemetry = this.options.telemetry?.sample();
        const turnId = this.session?.nextTurnId() ?? `rt.${++this.turnCounter}`;
        const trace: string[] = [];
        const sessionScope = this.session?.scope;
        const userEngine = sessionScope === undefined ? this.bayes : (this.session?.engineFor(sessionScope) ?? this.bayes);
        const user = userEngine.scoreUser(input);
        const scenario = resolveScenario(override.scenarioMix ?? this.options.scenarioMix ?? inferScenarioMix(input));
        const scope = override.scope ?? (this.session === undefined ? undefined : `${this.session.scope}:${scenario.active[0] ?? "mixed"}`);
        const engine = scope === undefined || this.session === undefined ? this.bayes : this.session.engineFor(scope);
        if (scope !== undefined) trace.push(`scope=${scope}`);
        const interaction = resolveInteraction(override.interactionMix ?? this.options.interactionMix ?? inferInteractionMix(user));
        const state = override.attentionState ?? this.session?.state ?? this.baseState;
        const attention = planAttention(processAttention(this.options.pid, state), [
            { tid: 1, pid: this.options.pid, priority: 1, preferredSlots: 2, foreground: true, role: interaction.primary },
        ]);
        trace.push(`user quality=${user.quality.toFixed(2)} emotion=${user.state.emotionalIntensity.toFixed(2)} urgency=${user.state.urgency.toFixed(2)}`);
        trace.push(`scenario=${scenario.rationale}`);
        trace.push(`interaction=${interaction.rationale}`);
        trace.push(`attention utilization=${attention.utilization.toFixed(2)} pressure=${attention.pressure.toFixed(2)} rest=${attention.rest}`);
        const behavior = this.behaviors.select({ turnId, text: input, user, scenario, interaction, attention });
        if (behavior.activations.length > 0) {
            trace.push(`behaviors=${behavior.activations.map((activation) => `${activation.behaviorId}@${activation.confidence.toFixed(2)}`).join(",")}`);
        }
        const diagnosis =
            this.options.diagnosis === true && scenario.active.includes("engineering")
                ? buildDiagnosisFrame({ id: turnId, summary: input, symptoms: [] })
                : undefined;
        const diagnosisContext = diagnosis === undefined ? undefined : toContextAst(diagnosis, 800);
        if (diagnosis !== undefined) trace.push(`diagnosis=${diagnosis.id} scope=${diagnosisContext?.top?.hypothesis.layer ?? "open"}`);
        const diagnosisAction = diagnosis === undefined ? undefined : toActionPlan(diagnosis);
        const planned = diagnosisAction === undefined ? await this.actionPlanner.plan({ turnId, text: input, behavior, scenario, interaction }) : [diagnosisAction];
        const actions: ActionRecord[] = planned.slice(0, behavior.maxActionsPerTurn).map((action, index) => ({
            id: `act.${turnId}.${index + 1}`,
            turnId,
            goal: action.goal,
            intent: action.intent,
            expectedEffect: action.expectedEffect,
            preconditions: action.preconditions ?? [],
            successCriteria: action.successCriteria ?? [],
            risk: action.risk ?? "read",
            status: "planned",
            operationIds: [],
        }));
        if (actions.length > 0) trace.push(`actions=${actions.map((action) => action.intent).join(",")}`);
        const actionId = actions[0]?.id;
        const operations: OperationRecord[] = [];
        const approvals: ApprovalRecord[] = [];
        const restSuggested = this.session?.shouldRest() ?? attention.rest;
        if (restSuggested) trace.push("rest suggested by attention/session policy");

        const preSafety = checkSafety(input, interaction);
        if (preSafety.action === "escalate") {
            const answer = safetyFallback("escalate");
            const receipt = this.receipt(at, { inputTokens: 0, outputTokens: 0 }, "blocked", "pre-safety escalation");
            const escalationId = this.options.escalationSink?.escalate({
                turnId,
                at,
                reason: preSafety.reasons.join("; "),
                resources: [...CRISIS_RESOURCES],
            });
            trace.push(`safety=escalate; no LLM call${escalationId === undefined ? "" : `; escalation=${escalationId}`}`);
            for (const action of actions) action.status = "abandoned";
            const turn: RuntimeTurn = {
                turnId,
                sessionId: this.session?.id,
                ...(scope === undefined ? {} : { scope }),
                pid: this.options.pid,
                input,
                at,
                user,
                scenario,
                interaction,
                attention,
                answer,
                restSuggested,
                latencyMs: Date.now() - startedAt,
                telemetry,
                ...(escalationId === undefined ? {} : { escalationId }),
                behavior,
                actions,
                operations,
                approvals,
                safety: preSafety,
                receiptId: receipt.id,
                trace,
            };
            this.turnStore?.save(turn);
            return turn;
        }
        for (const action of actions) action.status = "running";

        const useContext = override.useContext ?? this.options.useContext ?? true;
        const context = assembleAgentContext(
            this.options.agent,
            this.options.social,
            this.options.pid,
            { tokens: this.options.budgetTokens ?? 600 },
            { scenario, interaction },
        );
        trace.push(`context tokens=${context.tokens} mode=${scenario.mode}`);
        const tools: LlmToolDefinition[] | undefined = this.options.tools?.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
        const messages: LlmMessage[] = [
            { role: "system", content: systemPrompt(context, scenario, interaction, attention, behavior, useContext, diagnosisContext?.view.text) },
            { role: "user", content: input },
        ];
        const baseRequest = {
            model: this.options.model ?? "deepseek-flash",
            messages,
            maxTokens: this.options.maxOutputTokens ?? 512,
            temperature: 0,
            ...(tools === undefined ? {} : { tools }),
        };
        let response = await this.options.llm.complete(baseRequest);
        let usage: LlmUsage = { ...response.usage };
        const toolCalls: RuntimeToolCall[] = [];
        const maxToolRounds = Math.max(0, this.options.maxToolRounds ?? 4);
        let toolRounds = 0;
        while ((response.toolCalls?.length ?? 0) > 0 && toolRounds < maxToolRounds) {
            toolRounds += 1;
            messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
            for (const call of response.toolCalls ?? []) {
                const execution = await this.runTool(call);
                const content = redactSecrets(execution.result.content);
                const error = execution.result.error === undefined ? undefined : redactSecrets(execution.result.error);
                const safeResult: ToolResult = {
                    ok: execution.result.ok,
                    content: content.text,
                    ...(error === undefined ? {} : { error: error.text }),
                };
                const operation: OperationRecord = {
                    id: `op.${turnId}.tool.${operations.length + 1}`,
                    actionId: actionId ?? "act.none",
                    kind: "tool.call",
                    input: { arguments: call.arguments },
                    executor: call.name,
                    sideEffect: (execution.risk ?? "read") as SideEffect,
                    idempotencyKey: call.id,
                    status: safeResult.ok ? "ok" : "error",
                    result: { content: safeResult.content.slice(0, 4000), ...(safeResult.error === undefined ? {} : { error: safeResult.error }) },
                };
                operations.push(operation);
                const risk = (execution.risk ?? "read") as SideEffect;
                if (risk === "destructive" || (execution.decision !== undefined && execution.decision !== "allowed")) {
                    approvals.push({
                        operationId: operation.id,
                        tool: call.name,
                        risk,
                        decision: execution.decision ?? "not_required",
                        status: safeResult.ok ? "allowed" : "denied",
                    });
                }
                toolCalls.push({
                    id: call.id,
                    actionId,
                    operationId: operation.id,
                    name: call.name,
                    arguments: call.arguments,
                    ok: safeResult.ok,
                    content: safeResult.content.slice(0, 4000),
                    ...(safeResult.error === undefined ? {} : { error: safeResult.error }),
                    ...(execution.risk === undefined ? {} : { risk: execution.risk }),
                    ...(execution.decision === undefined ? {} : { decision: execution.decision }),
                    redacted: content.redacted || (error?.redacted ?? false),
                });
                if (actionId !== undefined) actions[0]?.operationIds.push(operation.id);
                messages.push({
                    role: "tool",
                    content: JSON.stringify(safeResult).slice(0, 4000),
                    toolCallId: call.id,
                    name: call.name,
                });
            }
            response = await this.options.llm.complete({ ...baseRequest, messages });
            usage = mergeUsage(usage, response.usage);
        }
        if (toolCalls.length > 0) trace.push(`tools=${toolCalls.map((call) => `${call.name}:${call.ok ? "ok" : "error"}`).join(",")}`);

        let text = response.text;
        let finishReason = response.finishReason;
        let continuations = 0;
        const maxContinuations = Math.max(0, this.options.maxContinuations ?? 1);
        let continuationMessages = messages;
        while (finishReason === "length" && continuations < maxContinuations) {
            const next = await this.options.llm.complete({
                ...baseRequest,
                messages: [
                    ...continuationMessages,
                    { role: "assistant", content: text },
                    { role: "user", content: "Continue exactly where you stopped. Do not repeat." },
                ],
            });
            if (next.text.length === 0) {
                finishReason = next.finishReason;
                break;
            }
            text += next.text;
            usage = mergeUsage(usage, next.usage);
            finishReason = next.finishReason;
            continuations += 1;
            continuationMessages = [
                ...continuationMessages,
                { role: "assistant", content: text },
                { role: "user", content: "Continue exactly where you stopped. Do not repeat." },
            ];
        }
        trace.push(
            `llm input=${usage.inputTokens} output=${usage.outputTokens} cacheHit=${usage.cacheHitTokens ?? 0} cacheMiss=${usage.cacheMissTokens ?? 0} cost=$${(usage.costUsd ?? 0).toFixed(6)} finish=${finishReason} toolRounds=${toolRounds} continuations=${continuations}`,
        );
        const llmOperation: OperationRecord = {
            id: `op.${turnId}.llm`,
            actionId: actionId ?? "act.none",
            kind: "llm.complete",
            input: { model: baseRequest.model, messages: baseRequest.messages.length, maxTokens: baseRequest.maxTokens },
            executor: "llm",
            sideEffect: "none",
            status: "ok",
            result: { finishReason, toolRounds, continuations, usage },
        };
        operations.push(llmOperation);
        if (actionId !== undefined) actions[0]?.operationIds.push(llmOperation.id);
        trace.push(`operations=${operations.map((operation) => `${operation.kind}:${operation.status}`).join(",")}`);
        const postSafety = checkSafety(input, interaction, text);
        const answer = postSafety.action === "allow" ? text : safetyFallback(postSafety.action);
        const answerScore = engine.scoreAnswer(answer, {
            ...(override.correct === undefined ? {} : { correct: override.correct }),
            ...(override.safe === undefined ? {} : { safe: override.safe }),
            ...(override.helpful === undefined ? {} : { helpful: override.helpful }),
            targetTokens: (this.options.maxOutputTokens ?? 512) * (1 + continuations),
        });
        trace.push(`answer overall=${answerScore.overall.toFixed(2)} correctness=${answerScore.dimensions.correctness.mean.toFixed(2)}`);
        const latencyMs = Date.now() - startedAt;
        const toolErrors = toolCalls.filter((call) => !call.ok).length;
        for (const action of actions) action.status = "done";
        if (this.session !== undefined) {
            this.session.record({
                turnId,
                at,
                ...(scope === undefined ? {} : { scope }),
                user,
                answerScore,
                attention,
                latencyMs,
                tokens: usage.inputTokens + usage.outputTokens,
                toolErrors,
                telemetry,
                behavior,
                actions,
                operations,
                approvals,
                ...(diagnosis === undefined ? {} : { diagnosis }),
            });
            this.sessionStore?.save(this.options.pid, this.session.serialize(), at);
            if (this.options.autoTuneBehavior === true) {
                const tuned = this.behaviorTuning.autoApply(this.session.behaviorConflicts, { enabled: true });
                if (tuned.applied > 0) trace.push(`behavior tuning v${tuned.version}: ${tuned.applied} priorities`);
            }
            trace.push(`session turns=${this.session.history.length} recoveryDebt=${this.session.state.recoveryDebt.toFixed(2)}`);
        }
        const outcome: RuntimeReceipt["outcome"] = postSafety.action === "allow" ? "success" : "blocked";
        const note =
            postSafety.action !== "allow"
                ? `post-safety ${postSafety.action}`
                : finishReason === "length"
                  ? "truncated answer (length)"
                  : continuations > 0
                    ? `runtime turn (continued ${continuations}x)`
                    : "runtime turn";
        const receipt = this.receipt(at, usage, outcome, note);
        const turn: RuntimeTurn = {
            turnId,
            sessionId: this.session?.id,
            ...(scope === undefined ? {} : { scope }),
            pid: this.options.pid,
            input,
            at,
            user,
            scenario,
            interaction,
            attention,
            context,
            answer,
            answerScore,
            usage,
            finishReason,
            ...(toolCalls.length === 0 ? {} : { toolCalls }),
            restSuggested,
            latencyMs,
            toolErrors,
            telemetry,
            behavior,
            ...(actions.length === 0 ? {} : { actions }),
            ...(operations.length === 0 ? {} : { operations }),
            ...(approvals.length === 0 ? {} : { approvals }),
            ...(diagnosis === undefined ? {} : { diagnosis }),
            safety: postSafety,
            receiptId: receipt.id,
            trace,
        };
        this.turnStore?.save(turn);
        return turn;
    }

    /** Retain persisted session state but mark it archived. */
    archiveSession(at: string): boolean {
        return this.sessionStore?.archive(this.options.pid, at) ?? false;
    }

    /** Remove persisted session state when the agent is deleted/archived. */
    deleteSession(): boolean {
        return this.sessionStore?.delete(this.options.pid) ?? false;
    }

    private async runTool(call: { name: string; arguments: string }): Promise<ToolExecution> {
        if (this.options.toolExecutor === undefined) {
            return { result: { ok: false, content: "", error: "no tool executor configured" } };
        }
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch (error) {
            return { result: { ok: false, content: "", error: `invalid tool arguments: ${error instanceof Error ? error.message : `${error}`}` } };
        }
        const descriptor = this.options.tools?.get(call.name);
        if (descriptor === undefined) return { result: { ok: false, content: "", error: `unknown tool ${call.name}` } };
        let decision = "allowed";
        if (this.options.toolPolicy !== undefined) {
            const verdict = await this.options.toolPolicy.check({ tool: call.name, args }, descriptor);
            decision = verdict.allowed ? "allowed" : (verdict.reason ?? `tool ${call.name} denied`);
            if (!verdict.allowed) {
                return { result: { ok: false, content: "", error: decision }, risk: descriptor.risk, decision };
            }
        }
        const result = await this.options.toolExecutor.execute({ tool: call.name, args });
        return { result, risk: descriptor.risk, decision };
    }

    private receipt(at: string, usage: LlmUsage, outcome: RuntimeReceipt["outcome"], note: string): RuntimeReceipt {
        this.counter += 1;
        const receipt: RuntimeReceipt = { id: `rc.runtime.${this.counter}`, at, usage, outcome, note };
        this.sink.write(receipt);
        return receipt;
    }
}
