/**
 * Kernel-backed cognitive runtime.
 *
 * The standalone `CognitiveRuntime` owns the turn loop; this adapter binds one
 * turn to a kernel task. The kernel provides the lease, budget accounting,
 * receipt, step row and hash-chained `runtime.turn` object. The runtime itself
 * still has no SQL/database dependency.
 */
import type { Kernel, StepReport } from "../kernel/index.ts";
import type { CognitiveRuntime, RuntimeTurn } from "./cognitiveRuntime.ts";

export interface KernelRuntimeTurn {
    report: StepReport;
    turn: RuntimeTurn;
    objectId: string;
    receiptId: string;
}

export interface KernelRuntimeOptions {
    kernel: Kernel;
    cognitive: CognitiveRuntime;
    onTurn?: (result: KernelRuntimeTurn) => void;
}

const mean = (value: { mean: number }): number => value.mean;

export class KernelRuntime {
    private readonly kernel: Kernel;
    private readonly cognitive: CognitiveRuntime;
    private readonly onTurn?: (result: KernelRuntimeTurn) => void;
    private counter = 0;

    constructor(options: KernelRuntimeOptions) {
        this.kernel = options.kernel;
        this.cognitive = options.cognitive;
        this.onTurn = options.onTurn;
    }

    /** Run one exact task (not "next ready") through an async model turn. */
    async runTask(tid: number, input: string): Promise<KernelRuntimeTurn | undefined> {
        let turn: RuntimeTurn | undefined;
        let objectId: string | undefined;
        const report = await this.kernel.stepAsync(async (context) => {
            turn = await this.cognitive.respond(input);
            objectId = `runtime.turn.${context.task.tid}.${++this.counter}`;
            const events: Array<{ topic: string; payload: Record<string, unknown> }> = [
                { topic: "runtime.receipt", payload: { task: context.task.tid, ...this.serialize(turn) } },
            ];
            for (const approval of turn.approvals ?? []) {
                events.push({ topic: "runtime.approval", payload: { task: context.task.tid, pid: turn.pid, turnId: turn.turnId, ...approval } });
            }
            return {
                status: "done",
                usage: { tokens: (turn.usage?.inputTokens ?? 0) + (turn.usage?.outputTokens ?? 0) },
                objects: [{ kind: "runtime.turn", id: objectId, body: this.serialize(turn) }],
                events,
            };
        }, tid);
        if (report === undefined || turn === undefined || objectId === undefined) return undefined;
        const result: KernelRuntimeTurn = { report, turn, objectId, receiptId: report.receiptId };
        this.onTurn?.(result);
        return result;
    }

    private serialize(turn: RuntimeTurn): Record<string, unknown> {
        return {
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            scope: turn.scope,
            pid: turn.pid,
            input: turn.input,
            at: turn.at,
            user: {
                quality: turn.user.quality,
                state: turn.user.state,
                dimensions: Object.fromEntries(Object.entries(turn.user.dimensions).map(([key, value]) => [key, mean(value)])),
            },
            scenario: {
                weights: turn.scenario.weights,
                active: turn.scenario.active,
                mode: turn.scenario.mode,
                tokenBudgetFactor: turn.scenario.tokenBudgetFactor,
                contextDepth: turn.scenario.contextDepth,
                rationale: turn.scenario.rationale,
            },
            interaction: {
                weights: turn.interaction.weights,
                primary: turn.interaction.primary,
                secondary: turn.interaction.secondary,
                sequence: turn.interaction.sequence,
                moves: turn.interaction.moves,
                response: turn.interaction.response,
                safety: turn.interaction.safety,
                rationale: turn.interaction.rationale,
            },
            attention: {
                utilization: turn.attention.utilization,
                pressure: turn.attention.pressure,
                rest: turn.attention.rest,
                foregroundSlots: turn.attention.foreground?.slots ?? 0,
                safetySlots: turn.attention.process.safetySlots,
                recoveryDebt: turn.attention.process.recoveryDebt,
            },
            answer: turn.answer,
            answerScore:
                turn.answerScore === undefined
                    ? undefined
                    : {
                          overall: turn.answerScore.overall,
                          dimensions: Object.fromEntries(Object.entries(turn.answerScore.dimensions).map(([key, value]) => [key, mean(value)])),
                      },
            usage: turn.usage,
            finishReason: turn.finishReason,
            toolCalls: turn.toolCalls,
            restSuggested: turn.restSuggested,
            latencyMs: turn.latencyMs,
            toolErrors: turn.toolErrors,
            telemetry: turn.telemetry,
            escalationId: turn.escalationId,
            behavior: turn.behavior,
            actions: turn.actions,
            operations: turn.operations,
            approvals: turn.approvals,
            safety: turn.safety,
            trace: turn.trace,
            runtimeReceiptId: turn.receiptId,
        };
    }
}
