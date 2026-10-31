/**
 * The three-ledger attention budget (spec section 8).
 *
 * Three separate accounts, because they answer different questions and may not
 * silently fund each other:
 *   - global: the whole task's quota;
 *   - perspective or agent: one stance's quota, with elasticity;
 *   - reserve: escalation only, never execution.
 *
 * Multi-agent work adds an agent ledger per agent. Its quota is transferred
 * from a parent perspective or agent; the meter never mints budget.
 *
 * Finance owns freeze and downgrade. A charge that needs an approval fails
 * closed instead of borrowing from another ledger.
 */
import type { ApprovalGrant, Budget, BudgetDimension, Elasticity, Id, LedgerScope, PerspectiveId, Timestamp } from "./types.ts";
import type { ElasticityLimit } from "./types.ts";
import { BudgetDimensions, ElasticityLimits, GovernanceError, budgetTotals } from "./types.ts";
import { canApprove } from "./perspectives.ts";

/**
 * Stable ledger id: `global`, `reserve`, a perspective id, or an agent id.
 */
export interface LedgerConfig {
    cap: Budget;
    elasticity: Elasticity;
}

export interface PerspectiveLedgerConfig extends LedgerConfig {
    perspective: PerspectiveId;
}

export interface AgentLedgerConfig extends LedgerConfig {
    agent: Id;
}

export interface GovernanceBudgetOptions {
    global: LedgerConfig;
    reserve: LedgerConfig;
    perspectives?: PerspectiveLedgerConfig[];
    agents?: AgentLedgerConfig[];
    now: () => Timestamp;
}

export interface LedgerSnapshot {
    scope: LedgerScope;
    id: string;
    cap: Required<Budget>;
    used: Required<Budget>;
    ratio: number;
    frozen: boolean;
    frozenReason?: string;
    elasticity: Elasticity;
}

export interface ChargeRequest {
    scope: LedgerScope;
    /**
     * Required when scope is `perspective`.
     */
    perspective?: PerspectiveId;
    /**
     * Required when scope is `agent`.
     */
    agent?: Id;
    amount: Budget;
    reason: string;
    /**
     * Reserve charges must declare that they fund an escalation.
     */
    escalation?: boolean;
    approval?: ApprovalGrant;
    /**
     * A reserve draw above 50% of the reserve also needs the board.
     */
    boardApproval?: ApprovalGrant;
    requestedBy?: PerspectiveId;
}

export type ChargeCode = "charged" | "charged-post-audit" | "charged-with-approval" | "approval-required" | "frozen" | "exhausted" | "reserve-restricted";

export interface ChargeResult {
    ok: boolean;
    code: ChargeCode;
    ledger: LedgerSnapshot;
    ratio: number;
    detail: string;
    approvalId?: string;
}

export interface ChargeRecord {
    at: Timestamp;
    scope: LedgerScope;
    ledgerId: string;
    amount: Required<Budget>;
    reason: string;
    code: ChargeCode;
    requestedBy?: PerspectiveId;
    approvalId?: string;
}

export interface PostAuditEntry {
    at: Timestamp;
    scope: LedgerScope;
    ledgerId: string;
    amount: Required<Budget>;
    reason: string;
}

export interface TransferRecord {
    at: Timestamp;
    fromScope: LedgerScope;
    fromId: string;
    toScope: LedgerScope;
    toId: string;
    amount: Required<Budget>;
    reason: string;
    approvalId: string;
}

/**
 * An account on either side of a budget transfer.
 */
export interface BudgetAccount {
    scope: "perspective" | "agent";
    id: string;
}

export type ReallocationCode = "reallocated" | "insufficient" | "frozen" | "approval-required" | "unknown-account";

export interface ReallocationResult {
    ok: boolean;
    code: ReallocationCode;
    from: LedgerSnapshot;
    to: LedgerSnapshot;
    detail: string;
}

export interface ReallocationOptions {
    toElasticity?: Elasticity;
    requestedBy?: PerspectiveId;
}

export interface ReallocationRequest {
    amount: Budget;
    approval: ApprovalGrant;
    reason: string;
    options?: ReallocationOptions;
}

export type ReallocateFn = (from: BudgetAccount, to: BudgetAccount, request: ReallocationRequest) => ReallocationResult;

export interface BudgetSettlement {
    global: LedgerSnapshot;
    reserve: LedgerSnapshot;
    perspectives: LedgerSnapshot[];
    agents: LedgerSnapshot[];
    transfers: TransferRecord[];
    charges: number;
    postAudit: PostAuditEntry[];
    frozen: LedgerSnapshot[];
    balanced: boolean;
}

interface LedgerState {
    scope: LedgerScope;
    id: string;
    cap: Required<Budget>;
    used: Required<Budget>;
    elasticity: Elasticity;
    frozen: boolean;
    frozenReason?: string;
}

const sumBudget: (left: Required<Budget>, right: Budget) => Required<Budget> = (left: Required<Budget>, right: Budget): Required<Budget> => {
    const added: Required<Budget> = budgetTotals(right);
    const result: Required<Budget> = { ...left };
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const dimension: BudgetDimension = BudgetDimensions[index];
        result[dimension] = left[dimension] + added[dimension];
    }
    return result;
};

/**
 * Worst per-dimension utilization after a prospective charge. Dimensions with
 * no cap are not metered, so they cannot deny a charge.
 */
type RatioFn = (used: Required<Budget>, cap: Required<Budget>, amount: Budget) => number;

const projectedRatio: RatioFn = (used, cap, amount) => {
    const added: Required<Budget> = budgetTotals(amount);
    let ratio: number = 0;
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const dimension: BudgetDimension = BudgetDimensions[index];
        if (cap[dimension] <= 0) {
            continue;
        }
        ratio = Math.max(ratio, (used[dimension] + added[dimension]) / cap[dimension]);
    }
    return ratio;
};

/**
 * Reject negative, NaN or infinite amounts before any arithmetic. A negative
 * charge would otherwise mint quota.
 */
const validateBudget: (budget: Budget, label: string) => void = (budget: Budget, label: string): void => {
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const value: number | undefined = budget[BudgetDimensions[index]];
        if (value === (void 0)) {
            continue;
        }
        if (!Number.isFinite(value) || value < 0) {
            throw new GovernanceError("budget-invalid", `${label}.${BudgetDimensions[index]} must be a finite non-negative number`);
        }
    }
};

const snapshotOf: (state: LedgerState) => LedgerSnapshot = (state: LedgerState): LedgerSnapshot => {    const ratio: number = projectedRatio(state.used, state.cap, {});
    return {
        scope: state.scope,
        id: state.id,
        cap: { ...state.cap },
        used: { ...state.used },
        ratio,
        frozen: state.frozen,
        elasticity: state.elasticity,
        ...(state.frozenReason === (void 0) ? {} : { frozenReason: state.frozenReason }),
    };
};

/**
 * The three-ledger meter.
 *
 * Elasticity semantics:
 *   - low: up to +20% is appended automatically; beyond that the ledger freezes;
 *   - medium: anything above the cap needs a finance `budget.top-up` approval,
 *     up to +35%;
 *   - high: up to +50% is appended automatically and settled by a post audit.
 */
export class GovernanceBudget {
    private readonly now: () => Timestamp;
    private readonly global: LedgerState;
    private readonly reserve: LedgerState;
    private readonly perspectives = new Map<PerspectiveId, LedgerState>();
    private readonly agents = new Map<Id, LedgerState>();
    private readonly records: ChargeRecord[] = [];
    private readonly audits: PostAuditEntry[] = [];
    private readonly transfers: TransferRecord[] = [];

    constructor(options: GovernanceBudgetOptions) {
        if (typeof(options.now) !== "function") {
            throw new TypeError("GovernanceBudget requires a clock");
        }
        this.now = options.now;
        this.global = this.state("global", "global", options.global);
        this.reserve = this.state("reserve", "reserve", options.reserve);
        const configured: PerspectiveLedgerConfig[] = options.perspectives ?? [];
        for (let index: number = 0; index < configured.length; index += 1) {
            const entry: PerspectiveLedgerConfig = configured[index];
            this.perspectives.set(entry.perspective, this.state("perspective", entry.perspective, entry));
        }
        const agentLedgers: AgentLedgerConfig[] = options.agents ?? [];
        for (let index: number = 0; index < agentLedgers.length; index += 1) {
            const entry: AgentLedgerConfig = agentLedgers[index];
            this.agents.set(entry.agent, this.state("agent", entry.agent, entry));
        }
    }

    /**
     * Open a perspective ledger. Re-opening with a different cap is rejected:
     * a budget change is an approval, not a convenience call.
     */
    openPerspective(perspective: PerspectiveId, cap: Budget, elasticity: Elasticity = "low"): LedgerSnapshot {
        const existing: LedgerState | undefined = this.perspectives.get(perspective);
        if (existing !== (void 0)) {
            throw new GovernanceError("budget-frozen", `ledger for ${perspective} already exists`);
        }
        const state: LedgerState = this.state("perspective", perspective, { cap, elasticity });
        this.perspectives.set(perspective, state);
        return snapshotOf(state);
    }

    /**
     * Open an agent ledger (an agent's own quota).
     */
    openAgent(agent: Id, cap: Budget, elasticity: Elasticity = "low"): LedgerSnapshot {
        const existing: LedgerState | undefined = this.agents.get(agent);
        if (existing !== (void 0)) {
            throw new GovernanceError("budget-frozen", `ledger for agent ${agent} already exists`);
        }
        const state: LedgerState = this.state("agent", agent, { cap, elasticity });
        this.agents.set(agent, state);
        return snapshotOf(state);
    }

    /**
     * Transfer allocation between a perspective and an agent. A sub-agent's
     * quota is funded from its parent; the total allocation is conserved.
     * The finance `budget.allocation` approval is mandatory.
     */
    readonly reallocate: ReallocateFn = (from, to, request) => {
        const amount: Budget = request.amount;
        const approval: ApprovalGrant = request.approval;
        const reason: string = request.reason;
        const options: ReallocationOptions = request.options ?? {};
        validateBudget(amount, "reallocation");
        const targetFrom: LedgerState = this.lookup(from.scope, from.id);
        const existingTo: LedgerState | undefined = to.scope === "perspective" ? this.perspectives.get(to.id as PerspectiveId) : this.agents.get(to.id);
        const targetTo: LedgerState = existingTo ?? this.state(to.scope, to.id, { cap: {}, elasticity: options.toElasticity ?? "low" });
        if (targetFrom.frozen) {
            return { ok: false, code: "frozen", from: snapshotOf(targetFrom), to: snapshotOf(targetTo), detail: `${from.id} is frozen` };
        }
        if (targetTo.frozen) {
            return { ok: false, code: "frozen", from: snapshotOf(targetFrom), to: snapshotOf(targetTo), detail: `${to.id} is frozen` };
        }
        const valid: boolean =
            approval.granted === true &&
            approval.subject === "budget.allocation" &&
            canApprove(approval.by, "budget.allocation") &&
            options.requestedBy !== (void 0) &&
            options.requestedBy !== approval.by;
        if (!valid) {
            return { ok: false, code: "approval-required", from: snapshotOf(targetFrom), to: snapshotOf(targetTo), detail: "a finance budget.allocation approval is required" };
        }
        const moved: Required<Budget> = budgetTotals(amount);
        for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
            const dimension: BudgetDimension = BudgetDimensions[index];
            if (moved[dimension] <= 0) {
                continue;
            }
            const available: number = targetFrom.cap[dimension] - targetFrom.used[dimension];
            if (targetFrom.cap[dimension] <= 0 || moved[dimension] > available) {
                return {
                    ok: false,
                    code: "insufficient",
                    from: snapshotOf(targetFrom),
                    to: snapshotOf(targetTo),
                    detail: `${dimension}: ${moved[dimension]} requested, ${Math.max(0, available)} available`,
                };
            }
        }
        for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
            const dimension: BudgetDimension = BudgetDimensions[index];
            targetFrom.cap[dimension] -= moved[dimension];
            targetTo.cap[dimension] += moved[dimension];
        }
        if (existingTo === (void 0)) {
            if (to.scope === "perspective") {
                this.perspectives.set(to.id as PerspectiveId, targetTo);
            } else {
                this.agents.set(to.id, targetTo);
            }
        }
        this.transfers.push({
            at: this.now(),
            fromScope: from.scope,
            fromId: from.id,
            toScope: to.scope,
            toId: to.id,
            amount: moved,
            reason,
            approvalId: approval.id,
        });
        return { ok: true, code: "reallocated", from: snapshotOf(targetFrom), to: snapshotOf(targetTo), detail: `moved ${reason}` };
    };
    /**
     * Charge one ledger. Denials are values; a frozen ledger refuses before
     * arithmetic so no caller can spend past a freeze.
     */
    charge(request: ChargeRequest): ChargeResult {
        validateBudget(request.amount, "charge");
        const target: LedgerState = this.resolve(request);
        const snapshot: LedgerSnapshot = snapshotOf(target);
        if (target.frozen) {
            return this.reject("frozen", snapshot, snapshot.ratio, target.frozenReason ?? "ledger is frozen");
        }
        if (request.scope === "reserve") {
            if (request.escalation !== true) {
                return this.reject("reserve-restricted", snapshot, snapshot.ratio, "the reserve ledger only funds escalations");
            }
            if (!this.approved(request, "budget.reserve")) {
                return this.reject("approval-required", snapshot, snapshot.ratio, "a reserve charge needs a finance budget.reserve approval");
            }
            if (projectedRatio(target.used, target.cap, request.amount) > 0.5 && !this.boardApproved(request.boardApproval)) {
                return this.reject("approval-required", snapshot, snapshot.ratio, "a reserve draw above 50% also needs a board approval");
            }
        }
        const ratio: number = projectedRatio(target.used, target.cap, request.amount);
        const limit: ElasticityLimit = ElasticityLimits[target.elasticity];
        if (ratio <= 1) {
            this.commit(target, request, "charged", ratio);
            return { ok: true, code: "charged", ledger: snapshotOf(target), ratio, detail: "within cap" };
        }
        if (ratio <= 1 + limit.autoRatio) {
            const code: ChargeCode = limit.postAudit ? "charged-post-audit" : "charged";
            this.commit(target, request, code, ratio);
            if (limit.postAudit) {
                this.audits.push({ at: this.now(), scope: target.scope, ledgerId: target.id, amount: budgetTotals(request.amount), reason: request.reason });
            }
            return { ok: true, code, ledger: snapshotOf(target), ratio, detail: `within ${Math.round(limit.autoRatio * 100)}% elasticity` };
        }
        if (limit.requiresApproval && ratio <= 1 + limit.hardRatio) {
            if (!this.approved(request, "budget.top-up")) {
                return this.reject("approval-required", snapshot, ratio, "over cap; finance top-up approval required");
            }
            this.commit(target, request, "charged-with-approval", ratio);
            return {
                ok: true,
                code: "charged-with-approval",
                ledger: snapshotOf(target),
                ratio,
                detail: "over cap with finance approval",
                ...(request.approval === (void 0) ? {} : { approvalId: request.approval.id }),
            };
        }
        target.frozen = true;
        target.frozenReason = `hard ceiling at ${Math.round((1 + limit.hardRatio) * 100)}% of cap`;
        this.records.push({
            at: this.now(),
            scope: target.scope,
            ledgerId: target.id,
            amount: budgetTotals(request.amount),
            reason: request.reason,
            code: "exhausted",
        });
        return this.reject("exhausted", snapshotOf(target), ratio, target.frozenReason);
    }

    /**
     * Freeze one ledger. Finance owns this right; the reason is mandatory so a
     * later audit can tell a policy freeze from an incident freeze.
     */
    freeze(scope: LedgerScope, id: string, reason: string, by: PerspectiveId = "finance"): LedgerSnapshot {
        if (!canApprove(by, "budget.freeze")) {
            throw new GovernanceError("approval-not-permitted", `${by} may not freeze a ledger`);
        }
        const target: LedgerState = this.lookup(scope, id);
        target.frozen = true;
        target.frozenReason = reason;
        return snapshotOf(target);
    }

    /**
     * Unfreeze requires a finance approval on record.
     */
    unfreeze(scope: LedgerScope, id: string, approval: ApprovalGrant): LedgerSnapshot {
        if (approval.granted !== true || !canApprove(approval.by, "budget.freeze")) {
            throw new GovernanceError("approval-not-permitted", "unfreeze requires a granted finance approval");
        }
        const target: LedgerState = this.lookup(scope, id);
        target.frozen = false;
        delete target.frozenReason;
        return snapshotOf(target);
    }

    /**
     * Draw from the escalation reserve. Every draw needs a finance approval; a
     * draw above half the reserve also needs a board `budget.major-top-up`
     * approval (spec section 8). The board approval is never inferred from the
     * finance one.
     */
    drawReserve(amount: Budget, approval: ApprovalGrant, reason: string, boardApproval?: ApprovalGrant): ChargeResult {
        validateBudget(amount, "reserve draw");
        if (approval.granted !== true || approval.subject !== "budget.reserve" || !canApprove(approval.by, "budget.reserve")) {
            throw new GovernanceError("approval-required", "reserve draws require a granted finance budget.reserve approval");
        }
        const ratio: number = projectedRatio(this.reserve.used, this.reserve.cap, amount);
        if (ratio > 0.5) {
            const boardApproved: boolean = this.boardApproved(boardApproval);
            if (!boardApproved) {
                throw new GovernanceError("approval-required", "a reserve draw above 50% also needs a board budget.major-top-up approval");
            }
        }
        return this.charge({
            scope: "reserve",
            amount,
            reason,
            escalation: true,
            approval,
            requestedBy: "general-manager",
            ...(boardApproval === (void 0) ? {} : { boardApproval }),
        });
    }

    snapshot(scope: LedgerScope, id?: string): LedgerSnapshot {
        const ledgerId: string = id ?? (scope === "global" || scope === "reserve" ? scope : "");
        return snapshotOf(this.lookup(scope, ledgerId));
    }

    /**
     * Remaining allocation on one ledger (cap minus used, per dimension).
     */
    remaining(scope: LedgerScope, id?: string): Required<Budget> {
        const target: LedgerState = this.lookup(scope, id ?? (scope === "global" || scope === "reserve" ? scope : ""));
        const result: Required<Budget> = budgetTotals({});
        for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
            const dimension: BudgetDimension = BudgetDimensions[index];
            result[dimension] = Math.max(0, target.cap[dimension] - target.used[dimension]);
        }
        return result;
    }

    snapshots(): LedgerSnapshot[] {
        return [snapshotOf(this.global), snapshotOf(this.reserve), ...this.perspectives.values(), ...this.agents.values()].map(snapshotOf);
    }

    /**
     * End-of-task settlement: every ledger, every transfer, every post-audit
     * entry and the freeze list, so the archive phase can attach one object.
     */
    settle(): BudgetSettlement {
        const perspectives: LedgerSnapshot[] = [...this.perspectives.values()].map(snapshotOf);
        const agents: LedgerSnapshot[] = [...this.agents.values()].map(snapshotOf);
        const frozen: LedgerSnapshot[] = [snapshotOf(this.global), snapshotOf(this.reserve), ...perspectives, ...agents].filter(
            (entry: LedgerSnapshot) => entry.frozen,
        );
        return {
            global: snapshotOf(this.global),
            reserve: snapshotOf(this.reserve),
            perspectives,
            agents,
            transfers: this.transfers.map((record: TransferRecord) => ({ ...record, amount: { ...record.amount } })),
            charges: this.records.length,
            postAudit: [...this.audits],
            frozen,
            balanced: this.records.every((record: ChargeRecord) => record.code !== "exhausted"),
        };
    }

    history(): ChargeRecord[] {
        return this.records.map((record: ChargeRecord) => ({ ...record, amount: { ...record.amount } }));
    }

    transferHistory(): TransferRecord[] {
        return this.transfers.map((record: TransferRecord) => ({ ...record, amount: { ...record.amount } }));
    }

    private state(scope: LedgerScope, id: string, config: LedgerConfig): LedgerState {
        validateBudget(config.cap, `ledger ${id}`);
        return {
            scope,
            id,
            cap: budgetTotals(config.cap),
            used: budgetTotals({}),
            elasticity: config.elasticity,
            frozen: false,
        };
    }

    private resolvedId(request: ChargeRequest): string {
        if (request.scope === "perspective") {
            if (request.perspective === (void 0)) {
                throw new GovernanceError("budget-exhausted", "a perspective charge needs a perspective id");
            }
            return request.perspective;
        }
        if (request.scope === "agent") {
            if (request.agent === (void 0)) {
                throw new GovernanceError("budget-exhausted", "an agent charge needs an agent id");
            }
            return request.agent;
        }
        return request.scope;
    }

    private resolve(request: ChargeRequest): LedgerState {
        return this.lookup(request.scope, this.resolvedId(request));
    }

    private lookup(scope: LedgerScope, id: string): LedgerState {
        if (scope === "global") {
            return this.global;
        }
        if (scope === "reserve") {
            return this.reserve;
        }
        if (scope === "agent") {
            const agentLedger: LedgerState | undefined = this.agents.get(id);
            if (agentLedger === (void 0)) {
                throw new GovernanceError("budget-exhausted", `no ledger for agent ${id}`);
            }
            return agentLedger;
        }
        const found: LedgerState | undefined = this.perspectives.get(id as PerspectiveId);
        if (found === (void 0)) {
            throw new GovernanceError("budget-exhausted", `no ledger for perspective ${id}`);
        }
        return found;
    }

    private approved(request: ChargeRequest, subject: "budget.top-up" | "budget.reserve"): boolean {
        const approval: ApprovalGrant | undefined = request.approval;
        if (approval === (void 0) || approval.granted !== true || approval.subject !== subject) {
            return false;
        }
        if (!canApprove(approval.by, subject)) {
            return false;
        }
        return request.requestedBy !== (void 0) && request.requestedBy !== approval.by;
    }

    private boardApproved(approval: ApprovalGrant | undefined): boolean {
        return approval !== (void 0) && approval.granted === true && approval.subject === "budget.major-top-up" && canApprove(approval.by, "budget.major-top-up");
    }

    private commit(target: LedgerState, request: ChargeRequest, code: ChargeCode, ratio: number): void {
        target.used = sumBudget(target.used, request.amount);
        this.records.push({
            at: this.now(),
            scope: target.scope,
            ledgerId: target.id,
            amount: budgetTotals(request.amount),
            reason: request.reason,
            code,
            ...(request.requestedBy === (void 0) ? {} : { requestedBy: request.requestedBy }),
            ...(request.approval === (void 0) ? {} : { approvalId: request.approval.id }),
        });
        if (ratio > 1) {
            this.audits.push({ at: this.now(), scope: target.scope, ledgerId: target.id, amount: budgetTotals(request.amount), reason: request.reason });
        }
    }

    private reject(code: ChargeCode, ledger: LedgerSnapshot, ratio: number, detail: string): ChargeResult {
        return { ok: false, code, ledger, ratio, detail };
    }
}
