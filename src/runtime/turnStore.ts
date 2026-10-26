/**
 * Turn store port. A turn is immutable after commit; adapters can persist it
 * for replay, audit and eval.
 */
import type { RuntimeTurn } from "./cognitiveRuntime.ts";

export interface TurnStore {
    save(turn: RuntimeTurn): void;
    get(turnId: string): RuntimeTurn | undefined;
    list(pid: number, limit?: number): RuntimeTurn[];
}

export class MemoryTurnStore implements TurnStore {
    private readonly turns = new Map<string, RuntimeTurn>();

    save(turn: RuntimeTurn): void {
        this.turns.set(turn.turnId, turn);
    }

    get(turnId: string): RuntimeTurn | undefined {
        return this.turns.get(turnId);
    }

    list(pid: number, limit = 100): RuntimeTurn[] {
        return [...this.turns.values()]
            .filter((turn) => turn.pid === pid)
            .sort((left, right) => right.turnId.localeCompare(left.turnId))
            .slice(0, limit);
    }
}
