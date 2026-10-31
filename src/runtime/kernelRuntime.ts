/**
 * Kernel-backed cognitive runtime.
 *
 * The standalone `CognitiveRuntime` owns the turn loop; this adapter binds one
 * turn to a kernel task. The kernel provides the lease, budget accounting,
 * receipt, step row and hash-chained `runtime.turn` object. The runtime itself
 * still has no SQL/database dependency.
 */
import type { Kernel, StepReport } from "../kernel/index.ts";
import type { ApprovalRecord } from "./operation.ts";
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

type MeanValue = {
    mean: number;
};

type RuntimeEvent = {
    topic: string;
    payload: Record<string, unknown>;
};

const mean: (value: MeanValue) => number = (value: MeanValue): number => value.mean;

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

    /**
     * Run one exact task (not "next ready") through an async model turn.
     */
    async runTask(tid: number, input: string): Promise<KernelRuntimeTurn | undefined> {
        let turn: RuntimeTurn | undefined;
        let objectId: string | undefined;
        const report: StepReport | undefined = await this.kernel.stepAsync(async (context) => {
            turn = await this.cognitive.respond(input);
            objectId = `runtime.turn.${context.task.tid}.${++this.counter}`;
            const events: RuntimeEvent[] = [{ topic: "runtime.receipt", payload: { task: context.task.tid, ...this.serialize(turn) } }];
            const approvals: ApprovalRecord[] = turn.approvals ?? [];
            for (let index: number = 0; index < approvals.length; index += 1) {
                const approval: ApprovalRecord = approvals[index];
                events.push({ topic: "runtime.approval", payload: { task: context.task.tid, pid: turn.pid, turnId: turn.turnId, ...approval } });
            }
            return {
                status: "done",
                usage: { tokens: (turn.usage?.inputTokens ?? 0) + (turn.usage?.outputTokens ?? 0) },
                objects: [{ kind: "runtime.turn", id: objectId, body: this.serialize(turn) }],
                events,
            };
        }, tid);
        if (report === (void 0) || turn === (void 0) || objectId === (void 0)) {
            return undefined;
        }
        const result: KernelRuntimeTurn = { report, turn, objectId, receiptId: report.receiptId };
        this.onTurn?.(result);
        return result;
    }

    private serialize(turn: RuntimeTurn): Record<string, unknown> {
        const body: Record<string, unknown> = {
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
                turn.answerScore === (void 0)
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
            diagnosis: turn.diagnosis,
            safety: turn.safety,
            trace: turn.trace,
            runtimeReceiptId: turn.receiptId,
        };
        const keys: string[] = Object.keys(body);
        for (let index: number = 0; index < keys.length; index += 1) {
            const key: string = keys[index];
            if (body[key] === (void 0)) {
                delete body[key];
            }
        }
        return body;
    }
}
