/**
 * Turn replay: reconstruct the Action/Operation graph from a persisted turn and
 * verify that every reference points at a record in the same turn.
 */
import type { RuntimeTurn } from "./cognitiveRuntime.ts";
import type { TurnStore } from "./turnStore.ts";

export interface ReplayedTurn {
    turnId: string;
    sessionId?: string;
    pid: number;
    input: string;
    output: string;
    behaviorIds: string[];
    actions: Array<{ id: string; intent: string; status: string; operations: string[] }>;
    operations: Array<{ id: string; kind: string; status: string; actionId: string }>;
}

export const replayTurn = (turn: RuntimeTurn): ReplayedTurn => {
    const actions = turn.actions ?? [];
    const operations = turn.operations ?? [];
    const actionIds = new Set(actions.map((action) => action.id));
    const operationIds = new Set(operations.map((operation) => operation.id));

    for (const operation of operations) {
        if (!actionIds.has(operation.actionId)) throw new Error(`operation ${operation.id} references missing action ${operation.actionId}`);
    }
    for (const action of actions) {
        for (const operationId of action.operationIds) {
            if (!operationIds.has(operationId)) throw new Error(`action ${action.id} references missing operation ${operationId}`);
        }
    }

    return {
        turnId: turn.turnId,
        ...(turn.sessionId === undefined ? {} : { sessionId: turn.sessionId }),
        pid: turn.pid,
        input: turn.input,
        output: turn.answer,
        behaviorIds: (turn.behavior?.activations ?? []).map((activation) => activation.behaviorId),
        actions: actions.map((action) => ({ id: action.id, intent: action.intent, status: action.status, operations: [...action.operationIds] })),
        operations: operations.map((operation) => ({ id: operation.id, kind: operation.kind, status: operation.status, actionId: operation.actionId })),
    };
};

export const replayStoredTurn = (store: TurnStore, turnId: string): ReplayedTurn => {
    const turn = store.get(turnId);
    if (turn === undefined) throw new Error(`unknown turn ${turnId}`);
    return replayTurn(turn);
};
