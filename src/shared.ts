import { isNumber } from "semantic-typescript";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Identifier = string;

export type Budget = {
    tokens?: number;
    milliseconds?: number;
    calls?: number;
    bytes?: number;
};

export type BudgetUsage = Required<Budget>;

export type ExecutionContext = {
    tenantId: Identifier;
    principalId: Identifier;
    agentId: Identifier;
    sessionId: Identifier;
    originTurnId?: Identifier;
    observedInTurnId?: Identifier;
    missionId?: Identifier;
    taskId?: Identifier;
    actionId?: Identifier;
    operationId: Identifier;
    attemptId: Identifier;
    executionId: Identifier;
    policyVersion: string;
    cancellationEpoch: number;
};

export type InvocationRecord = {
    id: Identifier;
    context: ExecutionContext;
    toolId: Identifier;
    arguments: JsonValue;
    createdAt: string;
    idempotencyKey?: string;
};

export type ObservationRecord = {
    id: Identifier;
    invocationId: Identifier;
    status: "success" | "failure" | "unknown";
    value?: JsonValue;
    error?: string;
    observedAt: string;
    digest?: string;
};

export type VerificationRecord = {
    id: Identifier;
    observationId: Identifier;
    valid: boolean;
    claims: readonly string[];
    verifier: string;
    verifiedAt: string;
};

export const EmptyBudgetUsage: Readonly<BudgetUsage> = Object.freeze({
    tokens: 0,
    milliseconds: 0,
    calls: 0,
    bytes: 0,
});

export function validateBudget(budget: Budget): void {
    for (const [key, value] of Object.entries(budget)) {
        if (!["tokens", "milliseconds", "calls", "bytes"].includes(key)
            || !isNumber(value) || value < 0) {
            throw new Error(`Invalid budget dimension: ${key}`);
        }
    }
}

export function normalizeBudgetUsage(budget: Budget): BudgetUsage {
    validateBudget(budget);
    return { ...EmptyBudgetUsage, ...budget };
}

export function addBudgetUsage(left: BudgetUsage, right: Budget): BudgetUsage {
    validateBudget(left);
    validateBudget(right);
    return {
        tokens: left.tokens + (right.tokens ?? 0),
        milliseconds: left.milliseconds + (right.milliseconds ?? 0),
        calls: left.calls + (right.calls ?? 0),
        bytes: left.bytes + (right.bytes ?? 0),
    };
}

export function exceedsBudget(usage: BudgetUsage, budget: Budget): boolean {
    return (budget.tokens !== (void 0) && usage.tokens > budget.tokens)
        || (budget.milliseconds !== (void 0) && usage.milliseconds > budget.milliseconds)
        || (budget.calls !== (void 0) && usage.calls > budget.calls)
        || (budget.bytes !== (void 0) && usage.bytes > budget.bytes);
}
