import type { DatabaseSync } from "node:sqlite";

import { AgentRepository } from "../repository/agentRepository.ts";
import { ExecutionRepository } from "../repository/executionRepository.ts";
import { OutboxRepository } from "../repository/outboxRepository.ts";
import { RuntimeSessionRepository } from "../repository/runtimeSessionRepository.ts";
import { RuntimeTurnRepository } from "../repository/runtimeTurnRepository.ts";
import { RuntimeApprovalRepository } from "../repository/runtimeApprovalRepository.ts";
import { SocialRepository } from "../repository/socialRepository.ts";

/**
 * Aggregate-port adapters.
 *
 * The facade exposes ports, not tables: callers get `AgentStore`/`SocialStore`
 * implementations without seeing repositories or SQL.
 */
export class DatabaseAdapters {
    readonly agents: AgentRepository;
    readonly social: SocialRepository;
    readonly execution: ExecutionRepository;
    readonly outbox: OutboxRepository;
    readonly sessions: RuntimeSessionRepository;
    readonly turns: RuntimeTurnRepository;
    readonly approvals: RuntimeApprovalRepository;

    constructor(db: DatabaseSync) {
        this.agents = new AgentRepository(db);
        this.social = new SocialRepository(db);
        this.execution = new ExecutionRepository(db);
        this.outbox = new OutboxRepository(db);
        this.sessions = new RuntimeSessionRepository(db);
        this.turns = new RuntimeTurnRepository(db);
        this.approvals = new RuntimeApprovalRepository(db);
    }
}
