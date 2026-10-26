import type { RuntimeTurn } from "../../runtime/cognitiveRuntime.ts";
import type { TurnStore } from "../../runtime/turnStore.ts";
import type { RuntimeTurnRepository } from "../repository/runtimeTurnRepository.ts";

export class SqliteTurnStore implements TurnStore {
    private readonly repository: RuntimeTurnRepository;

    constructor(repository: RuntimeTurnRepository) {
        this.repository = repository;
    }

    save(turn: RuntimeTurn): void {
        this.repository.save(turn);
    }

    get(turnId: string): RuntimeTurn | undefined {
        return this.repository.get(turnId);
    }

    list(pid: number, limit = 100): RuntimeTurn[] {
        return this.repository.list(pid, limit);
    }
}
