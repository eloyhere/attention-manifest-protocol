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
import { agentContextToAst } from "../context/projections.ts";
import type { ScenarioMix, ScenarioPlan } from "../scenario/scenario.ts";
import { resolveScenario } from "../scenario/scenario.ts";
import type { InteractionMix, InteractionPlan } from "../interaction/interaction.ts";
import { resolveInteraction } from "../interaction/interaction.ts";
import type { CognitiveState } from "../attention/cognition.ts";
import type { AttentionPlan } from "../attention/resource.ts";
import { planAttention, processAttention } from "../attention/resource.ts";
import type { AnswerScore, UserScore } from "../bayes/engine.ts";
import { BayesianEngine } from "../bayes/engine.ts";
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse, LlmToolCall, LlmToolDefinition, LlmUsage } from "../module/llm/llm.ts";
import type { ToolDescriptor, ToolExecutor, ToolRegistry, ToolResult, ToolRisk } from "../module/tool/tool.ts";
import type { ToolDecision, ToolPolicy } from "../module/tool/policy.ts";
import { redactSecrets } from "../module/tool/redact.ts";
import type { Redaction } from "../module/tool/redact.ts";
import { checkSafety, safetyFallback } from "./safety.ts";
import type { SafetyDecision } from "./safety.ts";
import { inferInteractionMix, inferScenarioMix } from "./routing.ts";
import type { RuntimeSession, SessionSnapshot } from "./session.ts";
import { RuntimeSession as RuntimeSessionClass } from "./session.ts";
import type { SessionStore } from "./sessionStore.ts";
import type { TelemetrySample, TelemetrySource } from "./telemetry.ts";
import type { EscalationSink } from "./escalation.ts";
import { CrisisResources } from "./escalation.ts";
import type { BehaviorPlan } from "./behavior.ts";
import { BehaviorRegistry } from "./behavior.ts";
import { BehaviorTuningController } from "./behaviorTuning.ts";
import type { AutoTuneResult } from "./behaviorTuning.ts";
import { buildDiagnosisFrame, toActionPlan, toContextAst } from "../diagnosis/index.ts";
import type { DiagnosisContext, DiagnosticFrame } from "../diagnosis/index.ts";
import type { ActionPlan, ActionPlanner, ActionRecord } from "./action.ts";
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

type ToolCallPayload = {
    name: string;
    arguments: string;
};

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
    /**
     * Opt-in: render AgentContext through the AST summary view.
     */
    contextAst?: boolean;
    session?: RuntimeSession;
    sessionStore?: SessionStore;
    turnStore?: TurnStore;
    telemetry?: TelemetrySource;
    escalationSink?: EscalationSink;
    behaviors?: BehaviorRegistry;
    /**
     * Opt-in: attach a read-only diagnostic frame to engineering turns.
     */
    diagnosis?: boolean;
    /**
     * Opt-in: apply bounded priority suggestions after each turn. Default false.
     */
    autoTuneBehavior?: boolean;
    actionPlanner?: ActionPlanner;
    /**
     * Continue a truncated answer at most this many times. Defaults to 1.
     */
    maxContinuations?: number;
    tools?: ToolRegistry;
    toolExecutor?: ToolExecutor;
    toolPolicy?: ToolPolicy;
    /**
     * Maximum tool rounds per turn. Defaults to 4.
     */
    maxToolRounds?: number;
    /**
     * Maximum serialized tool message size. Defaults to 1 MiB; an oversized
     * result becomes a complete error envelope rather than broken JSON.
     */
    maxToolResultChars?: number;
}

export interface TurnOverride {
    scenarioMix?: ScenarioMix;
    interactionMix?: InteractionMix;
    attentionState?: CognitiveState;
    useContext?: boolean;
    correct?: boolean;
    safe?: boolean;
    helpful?: boolean;
    /**
     * Explicit prior scope; otherwise derived from session + primary scenario.
     */
    scope?: string;
    /**
     * Optional governance note (manifest refs, floor, constraints). It is
     * appended to the system prompt and never carries context bodies.
     */
    systemNote?: string;
}

const mergeUsage: (left: LlmUsage, right: LlmUsage) => LlmUsage = (left: LlmUsage, right: LlmUsage): LlmUsage => ({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheHitTokens: (left.cacheHitTokens ?? 0) + (right.cacheHitTokens ?? 0),
    cacheMissTokens: (left.cacheMissTokens ?? 0) + (right.cacheMissTokens ?? 0),
    costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0),
});

const StableSystemPrefix: string = "You are an AI agent modeled as a person. Do not claim human feelings, a diagnosis, or a therapeutic relationship.";

const defaultCognitiveState: () => CognitiveState = (): CognitiveState => ({
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

type SystemPromptInput = {
    context: AgentContext | undefined;
    scenario: ScenarioPlan;
    interaction: InteractionPlan;
    attention: AttentionPlan;
    behavior: BehaviorPlan;
    useContext: boolean;
    diagnosisText: string | undefined;
    contextAstText: string | undefined;
    systemNote?: string;
};

const systemPrompt: (input: SystemPromptInput) => string = (input: SystemPromptInput): string => {
    const { context, scenario, interaction, attention, behavior, useContext, diagnosisText, contextAstText, systemNote }: SystemPromptInput = input;
    const contextText: string =
        contextAstText !== (void 0) && contextAstText.length > 0
            ? `Relevant self-context (AST):\n${contextAstText}`
            : useContext && context !== (void 0) && context.segments.length > 0
              ? `Relevant self-context:\n${context.segments.map((segment) => `[${segment.kind}] ${segment.text}`).join("\n")}`
              : "";
    return [
        StableSystemPrefix,
        `Scenario: ${scenario.rationale}`,
        `Interaction: ${interaction.rationale}`,
        `Attention: ${attention.process.effectiveSlots} slots; foreground ${attention.foreground?.slots ?? 0}; reserve ${attention.process.reserveSlots}; rest=${attention.rest}.`,
        ...(systemNote === (void 0) || systemNote.length === 0 ? [] : [systemNote]),
        ...(contextText.length > 0 ? [contextText] : []),
        ...(diagnosisText === (void 0) || diagnosisText.length === 0 ? [] : [`Diagnostic context (summaries only):\n${diagnosisText}`]),
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
    private readonly maxToolResultChars: number;
    private counter = 0;
    private turnCounter = 0;

    constructor(options: CognitiveRuntimeOptions) {
        const resultLimit: number = options.maxToolResultChars ?? 1024 * 1024;
        if (!Number.isSafeInteger(resultLimit) || resultLimit < 128 || resultLimit > 1024 * 1024) {
            throw new RangeError("maxToolResultChars must be an integer in 128..1048576");
        }
        this.maxToolResultChars = resultLimit;
        this.options = options;
        this.sessionStore = options.sessionStore;
        this.turnStore = options.turnStore;
        const stored: SessionSnapshot | undefined = options.sessionStore?.load(options.pid);
        this.session =
            options.session ??
            (stored === (void 0)
                ? options.sessionStore === (void 0)
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
        const at: string = this.now();
        const startedAt: number = Date.now();
        const telemetry: TelemetrySample | undefined = this.options.telemetry?.sample();
        const turnId: string = this.session?.nextTurnId() ?? `rt.${++this.turnCounter}`;
        const trace: string[] = [];
        const sessionScope: string | undefined = this.session?.scope;
        const userEngine: BayesianEngine = sessionScope === (void 0) ? this.bayes : (this.session?.engineFor(sessionScope) ?? this.bayes);
        const user: UserScore = userEngine.scoreUser(input);
        const scenario: ScenarioPlan = resolveScenario(override.scenarioMix ?? this.options.scenarioMix ?? inferScenarioMix(input));
        const scope: string | undefined = override.scope ?? (this.session === (void 0) ? undefined : `${this.session.scope}:${scenario.active[0] ?? "mixed"}`);
        const engine: BayesianEngine = scope === (void 0) || this.session === (void 0) ? this.bayes : this.session.engineFor(scope);
        if (scope !== (void 0)) {
            trace.push(`scope=${scope}`);
        }
        const interaction: InteractionPlan = resolveInteraction(override.interactionMix ?? this.options.interactionMix ?? inferInteractionMix(user));
        const state: CognitiveState = override.attentionState ?? this.session?.state ?? this.baseState;
        const attention: AttentionPlan = planAttention(processAttention(this.options.pid, state), [
            { tid: 1, pid: this.options.pid, priority: 1, preferredSlots: 2, foreground: true, role: interaction.primary },
        ]);
        trace.push(`user quality=${user.quality.toFixed(2)} emotion=${user.state.emotionalIntensity.toFixed(2)} urgency=${user.state.urgency.toFixed(2)}`);
        trace.push(`scenario=${scenario.rationale}`);
        trace.push(`interaction=${interaction.rationale}`);
        trace.push(`attention utilization=${attention.utilization.toFixed(2)} pressure=${attention.pressure.toFixed(2)} rest=${attention.rest}`);
        const behavior: BehaviorPlan = this.behaviors.select({ turnId, text: input, user, scenario, interaction, attention });
        if (behavior.activations.length > 0) {
            trace.push(`behaviors=${behavior.activations.map((activation) => `${activation.behaviorId}@${activation.confidence.toFixed(2)}`).join(",")}`);
        }
        const diagnosis: DiagnosticFrame | undefined =
            this.options.diagnosis === true && scenario.active.includes("engineering")
                ? buildDiagnosisFrame({ id: turnId, summary: input, symptoms: [] })
                : undefined;
        const diagnosisContext: DiagnosisContext | undefined = diagnosis === (void 0) ? undefined : toContextAst(diagnosis, 800);
        if (diagnosis !== (void 0)) {
            trace.push(`diagnosis=${diagnosis.id} scope=${diagnosisContext?.top?.hypothesis.layer ?? "open"}`);
        }
        const diagnosisAction: ActionPlan | undefined = diagnosis === (void 0) ? undefined : toActionPlan(diagnosis);
        const planned: ActionPlan[] =
            diagnosisAction === (void 0) ? await this.actionPlanner.plan({ turnId, text: input, behavior, scenario, interaction }) : [diagnosisAction];
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
        if (actions.length > 0) {
            trace.push(`actions=${actions.map((action) => action.intent).join(",")}`);
        }
        const actionId: string = actions[0]?.id;
        const operations: OperationRecord[] = [];
        const approvals: ApprovalRecord[] = [];
        const restSuggested: boolean = this.session?.shouldRest() ?? attention.rest;
        if (restSuggested) {
            trace.push("rest suggested by attention/session policy");
        }

        const preSafety: SafetyDecision = checkSafety(input, interaction);
        if (preSafety.action === "escalate") {
            const answer: string = safetyFallback("escalate");
            const receipt: RuntimeReceipt = this.receipt(at, { inputTokens: 0, outputTokens: 0 }, "blocked", "pre-safety escalation");
            const escalationId: string | undefined = this.options.escalationSink?.escalate({
                turnId,
                at,
                reason: preSafety.reasons.join("; "),
                resources: [...CrisisResources],
            });
            trace.push(`safety=escalate; no LLM call${escalationId === (void 0) ? "" : `; escalation=${escalationId}`}`);
            for (let i: number = 0; i < actions.length; i += 1) {
                const action: ActionRecord = actions[i];
                action.status = "abandoned";
            }
            const turn: RuntimeTurn = {
                turnId,
                sessionId: this.session?.id,
                ...(scope === (void 0) ? {} : { scope }),
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
                ...(escalationId === (void 0) ? {} : { escalationId }),
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
        for (let i: number = 0; i < actions.length; i += 1) {
            const action: ActionRecord = actions[i];
            action.status = "running";
        }

        const useContext: boolean = override.useContext ?? this.options.useContext ?? true;
        const context: AgentContext = assembleAgentContext(
            this.options.agent,
            this.options.social,
            this.options.pid,
            { tokens: this.options.budgetTokens ?? 600 },
            { scenario, interaction },
        );
        trace.push(`context tokens=${context.tokens} mode=${scenario.mode}`);
        const contextAstView: DiagnosisContext["view"] | undefined = this.options.contextAst === true && useContext ? agentContextToAst(context).ast.view(800) : undefined;
        if (contextAstView !== (void 0)) {
            trace.push(`context ast tokens=${contextAstView.tokens} nodes=${contextAstView.nodes.length}`);
        }
        const tools: LlmToolDefinition[] | undefined = this.options.tools?.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
        const messages: LlmMessage[] = [
            {
                role: "system",
                content: systemPrompt({
                    context,
                    scenario,
                    interaction,
                    attention,
                    behavior,
                    useContext,
                    diagnosisText: diagnosisContext?.view.text,
                    contextAstText: contextAstView?.text,
                    ...(override.systemNote === (void 0) ? {} : { systemNote: override.systemNote }),
                }),
            },
            { role: "user", content: input },
        ];
        const baseRequest: LlmRequest = {
            model: this.options.model ?? "deepseek-flash",
            messages,
            maxTokens: this.options.maxOutputTokens ?? 512,
            temperature: 0,
            ...(tools === (void 0) ? {} : { tools }),
        };
        let response: LlmResponse = await this.options.llm.complete(baseRequest);
        let usage: LlmUsage = { ...response.usage };
        const toolCalls: RuntimeToolCall[] = [];
        const maxToolRounds: number = Math.max(0, this.options.maxToolRounds ?? 4);
        let toolRounds: number = 0;
        while ((response.toolCalls?.length ?? 0) > 0 && toolRounds < maxToolRounds) {
            toolRounds += 1;
            messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
            const toolCallList: LlmToolCall[] = response.toolCalls ?? [];
            for (let i: number = 0; i < toolCallList.length; i += 1) {
                const call: LlmToolCall = toolCallList[i];
                const execution: ToolExecution = await this.runTool(call);
                const content: Redaction = redactSecrets(execution.result.content);
                const error: Redaction | undefined = execution.result.error === (void 0) ? undefined : redactSecrets(execution.result.error);
                let safeResult: ToolResult = {
                    ok: execution.result.ok,
                    content: content.text,
                    ...(error === (void 0) ? {} : { error: error.text }),
                };
                let toolMessage: string = JSON.stringify(safeResult);
                if (toolMessage.length > this.maxToolResultChars) {
                    safeResult = { ok: false, content: "", error: "tool_result_too_large: request a smaller page or view" };
                    toolMessage = JSON.stringify(safeResult);
                }
                const operation: OperationRecord = {
                    id: `op.${turnId}.tool.${operations.length + 1}`,
                    actionId: actionId ?? "act.none",
                    kind: "tool.call",
                    input: { arguments: call.arguments },
                    executor: call.name,
                    sideEffect: (execution.risk ?? "read") as SideEffect,
                    idempotencyKey: call.id,
                    status: safeResult.ok ? "ok" : "error",
                    result: { content: safeResult.content.slice(0, 4000), ...(safeResult.error === (void 0) ? {} : { error: safeResult.error }) },
                };
                operations.push(operation);
                const risk: SideEffect = (execution.risk ?? "read") as SideEffect;
                if (risk === "destructive" || (execution.decision !== (void 0) && execution.decision !== "allowed")) {
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
                    ...(safeResult.error === (void 0) ? {} : { error: safeResult.error }),
                    ...(execution.risk === (void 0) ? {} : { risk: execution.risk }),
                    ...(execution.decision === (void 0) ? {} : { decision: execution.decision }),
                    redacted: content.redacted || (error?.redacted ?? false),
                });
                if (actionId !== (void 0)) {
                    actions[0]?.operationIds.push(operation.id);
                }
                messages.push({
                    role: "tool",
                    content: toolMessage,
                    toolCallId: call.id,
                    name: call.name,
                });
            }
            response = await this.options.llm.complete({ ...baseRequest, messages });
            usage = mergeUsage(usage, response.usage);
        }
        if (toolCalls.length > 0) {
            trace.push(`tools=${toolCalls.map((call) => `${call.name}:${call.ok ? "ok" : "error"}`).join(",")}`);
        }

        let text: string = response.text;
        let finishReason: LlmResponse["finishReason"] = response.finishReason;
        let continuations: number = 0;
        const maxContinuations: number = Math.max(0, this.options.maxContinuations ?? 1);
        let continuationMessages: LlmMessage[] = messages;
        while (finishReason === "length" && continuations < maxContinuations) {
            const next: LlmResponse = await this.options.llm.complete({
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
        if (actionId !== (void 0)) {
            actions[0]?.operationIds.push(llmOperation.id);
        }
        trace.push(`operations=${operations.map((operation) => `${operation.kind}:${operation.status}`).join(",")}`);
        const postSafety: SafetyDecision = checkSafety(input, interaction, text);
        const answer: string = postSafety.action === "allow" ? text : safetyFallback(postSafety.action);
        const answerScore: AnswerScore = engine.scoreAnswer(answer, {
            ...(override.correct === (void 0) ? {} : { correct: override.correct }),
            ...(override.safe === (void 0) ? {} : { safe: override.safe }),
            ...(override.helpful === (void 0) ? {} : { helpful: override.helpful }),
            targetTokens: (this.options.maxOutputTokens ?? 512) * (1 + continuations),
        });
        trace.push(`answer overall=${answerScore.overall.toFixed(2)} correctness=${answerScore.dimensions.correctness.mean.toFixed(2)}`);
        const latencyMs: number = Date.now() - startedAt;
        const toolErrors: number = toolCalls.filter((call) => !call.ok).length;
        for (let i: number = 0; i < actions.length; i += 1) {
            const action: ActionRecord = actions[i];
            action.status = "done";
        }
        if (this.session !== (void 0)) {
            this.session.record({
                turnId,
                at,
                ...(scope === (void 0) ? {} : { scope }),
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
                ...(diagnosis === (void 0) ? {} : { diagnosis }),
            });
            this.sessionStore?.save(this.options.pid, this.session.serialize(), at);
            if (this.options.autoTuneBehavior === true) {
                const tuned: AutoTuneResult = this.behaviorTuning.autoApply(this.session.behaviorConflicts, { enabled: true });
                if (tuned.applied > 0) {
                    trace.push(`behavior tuning v${tuned.version}: ${tuned.applied} priorities`);
                }
            }
            trace.push(`session turns=${this.session.history.length} recoveryDebt=${this.session.state.recoveryDebt.toFixed(2)}`);
        }
        const outcome: RuntimeReceipt["outcome"] = postSafety.action === "allow" ? "success" : "blocked";
        const note: string =
            postSafety.action !== "allow"
                ? `post-safety ${postSafety.action}`
                : finishReason === "length"
                  ? "truncated answer (length)"
                  : continuations > 0
                    ? `runtime turn (continued ${continuations}x)`
                    : "runtime turn";
        const receipt: RuntimeReceipt = this.receipt(at, usage, outcome, note);
        const turn: RuntimeTurn = {
            turnId,
            sessionId: this.session?.id,
            ...(scope === (void 0) ? {} : { scope }),
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
            ...(diagnosis === (void 0) ? {} : { diagnosis }),
            safety: postSafety,
            receiptId: receipt.id,
            trace,
        };
        this.turnStore?.save(turn);
        return turn;
    }

    /**
     * Retain persisted session state but mark it archived.
     */
    archiveSession(at: string): boolean {
        return this.sessionStore?.archive(this.options.pid, at) ?? false;
    }

    /**
     * Remove persisted session state when the agent is deleted/archived.
     */
    deleteSession(): boolean {
        return this.sessionStore?.delete(this.options.pid) ?? false;
    }

    private async runTool(call: ToolCallPayload): Promise<ToolExecution> {
        if (this.options.toolExecutor === (void 0)) {
            return { result: { ok: false, content: "", error: "no tool executor configured" } };
        }
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch (error) {
            return { result: { ok: false, content: "", error: `invalid tool arguments: ${error instanceof Error ? error.message : `${error}`}` } };
        }
        const descriptor: ToolDescriptor | undefined = this.options.tools?.get(call.name);
        if (descriptor === (void 0)) {
            return { result: { ok: false, content: "", error: `unknown tool ${call.name}` } };
        }
        let decision: string = "allowed";
        if (this.options.toolPolicy !== (void 0)) {
            const verdict: ToolDecision = await this.options.toolPolicy.check({ tool: call.name, args }, descriptor);
            decision = verdict.allowed ? "allowed" : (verdict.reason ?? `tool ${call.name} denied`);
            if (!verdict.allowed) {
                return { result: { ok: false, content: "", error: decision }, risk: descriptor.risk, decision };
            }
        }
        const result: ToolResult = await this.options.toolExecutor.execute({ tool: call.name, args });
        return { result, risk: descriptor.risk, decision };
    }

    private receipt(at: string, usage: LlmUsage, outcome: RuntimeReceipt["outcome"], note: string): RuntimeReceipt {
        this.counter += 1;
        const receipt: RuntimeReceipt = { id: `rc.runtime.${this.counter}`, at, usage, outcome, note };
        this.sink.write(receipt);
        return receipt;
    }
}
