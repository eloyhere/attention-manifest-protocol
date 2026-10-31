/**
 * Turn replay: reconstruct the Action/Operation graph from a persisted turn and
 * verify that every reference points at a record in the same turn.
 */
import type { ActionRecord } from "./action.ts";
import type { RuntimeTurn } from "./cognitiveRuntime.ts";
import type { OperationRecord } from "./operation.ts";
import type { TurnStore } from "./turnStore.ts";

export interface ReplayedTurn {
    turnId: string;
    sessionId?: string;
    pid: number;
    input: string;
    output: string;
    behaviorIds: string[];
    actions: Array<{
        id: string;
        intent: string;
        status: string;
        operations: string[];
    }>;
    operations: Array<{
        id: string;
        kind: string;
        status: string;
        actionId: string;
    }>;
}

export const replayTurn: (turn: RuntimeTurn) => ReplayedTurn = (turn: RuntimeTurn): ReplayedTurn => {
    const actions: ActionRecord[] = turn.actions ?? [];
    const operations: OperationRecord[] = turn.operations ?? [];
    const actionIds: Set<string> = new Set(actions.map((action) => action.id));
    const operationIds: Set<string> = new Set(operations.map((operation) => operation.id));

    for (let index: number = 0; index < operations.length; index += 1) {
        const operation: OperationRecord = operations[index];
        if (!actionIds.has(operation.actionId)) {
            throw new Error(`operation ${operation.id} references missing action ${operation.actionId}`);
        }
    }
    for (let actionIndex: number = 0; actionIndex < actions.length; actionIndex += 1) {
        const action: ActionRecord = actions[actionIndex];
        for (let operationIndex: number = 0; operationIndex < action.operationIds.length; operationIndex += 1) {
            const operationId: string = action.operationIds[operationIndex];
            if (!operationIds.has(operationId)) {
                throw new Error(`action ${action.id} references missing operation ${operationId}`);
            }
        }
    }

    return {
        turnId: turn.turnId,
        ...(turn.sessionId === (void 0) ? {} : { sessionId: turn.sessionId }),
        pid: turn.pid,
        input: turn.input,
        output: turn.answer,
        behaviorIds: (turn.behavior?.activations ?? []).map((activation) => activation.behaviorId),
        actions: actions.map((action) => ({ id: action.id, intent: action.intent, status: action.status, operations: [...action.operationIds] })),
        operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, actionId: operation.actionId })),
    };
};

export const replayStoredTurn: (store: TurnStore, turnId: string) => ReplayedTurn = (store: TurnStore, turnId: string): ReplayedTurn => {
    const turn: RuntimeTurn | undefined = store.get(turnId);
    if (turn === (void 0)) {
        throw new Error(`unknown turn ${turnId}`);
    }
    return replayTurn(turn);
};
