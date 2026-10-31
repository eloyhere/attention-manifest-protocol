import type { Budget, Digest, Id, Timestamp } from "../types/common.ts";
import type { TeamManifest, TeamMember } from "./teamTypes.ts";

export interface Delegation {
    id: Id;
    parent?: Id;
    /**
     * Optional responsibility assignment that authorises this task transfer.
     */
    assignment?: Id;
    granter: Id;
    delegatee: Id;
    goalDigest: Digest;
    scope: string[];
    budget: Budget;
    deadline: Timestamp;
    mayRedelegate: boolean;
    depth: number;
}

export interface Lease {
    id: Id;
    delegation: Id;
    taskId: Id;
    holder: Id;
    fence: number;
    goalDigest: Digest;
    budget: Budget;
    deadline: Timestamp;
    status: "active" | "done" | "cancelled";
}

export class AttenuationError extends Error {
    readonly code = "delegation_widened";
}

export class FencingError extends Error {
    readonly code = "stale_writer";
}

export class DuplicateTask extends Error {
    readonly code = "duplicate_goal";
}

export class BudgetError extends Error {
    readonly code = "budget_exceeded";
}

type BudgetDimension = keyof Budget;

type TeamRuntimeOptions = {
    now: () => Timestamp;
};

type LeaseGrant = {
    taskId: Id;
    holder: Id;
    goalDigest: Digest;
    budget: Budget;
    deadline: Timestamp;
};

type LeaseUsage = {
    reserved: Budget;
    spent: Budget;
};

const DIMS: readonly BudgetDimension[] = ["tokens", "calls", "ms", "interrupts", "money"];

/**
 * Child budgets may only shrink; every dimension is checked independently.
 */
const validateBudget: (budget: Budget, label: string) => void = (budget: Budget, label: string): void => {
    for (let index: number = 0; index < DIMS.length; index += 1) {
        const dim: BudgetDimension = DIMS[index];
        const value: number | undefined = budget[dim];
        if (value !== (void 0) && (!Number.isFinite(value) || value < 0)) {
            throw new BudgetError(`${label} ${dim} must be a finite non-negative number`);
        }
    }
};

const attenuate: (parent: Budget, child: Budget) => void = (parent: Budget, child: Budget): void => {
    validateBudget(child, "child budget");
    for (let index: number = 0; index < DIMS.length; index += 1) {
        const dim: BudgetDimension = DIMS[index];
        const cap: number | undefined = parent[dim];
        const request: number | undefined = child[dim];
        if (request !== (void 0) && cap !== (void 0) && request > cap) {
            throw new AttenuationError(`child ${dim} ${request} exceeds parent ${cap}`);
        }
    }
};

const inheritBudget: (parent: Budget, child: Budget) => Budget = (parent: Budget, child: Budget): Budget => {
    const budget: Budget = { ...parent };
    for (const dim of DIMS) {
        if (child[dim] !== (void 0)) {
            budget[dim] = child[dim];
        }
    }
    return budget;
};

const requireValidDeadline: (deadline: Timestamp, label: string) => number = (deadline: Timestamp, label: string): number => {
    const parsed: number = Date.parse(deadline);
    if (!Number.isFinite(parsed)) {
        throw new AttenuationError(`${label} must be a parseable timestamp`);
    }
    return parsed;
};

/** Scope identifiers match exactly; an explicit parent `*` grants any scope. */
const scopeWithin: (child: readonly string[], parent: readonly string[]) => boolean = (child: readonly string[], parent: readonly string[]): boolean =>
    child.every((entry: string): boolean => parent.includes("*") || parent.includes(entry));

/**
 * Team runtime: delegation → lease → reservation → result.
 * All authority checks happen locally; a peer's promise is never trusted.
 */
export class TeamRuntime {
    private readonly delegations = new Map<Id, Delegation>();
    private readonly leases = new Map<Id, Lease>();
    private readonly activeByGoal = new Map<Digest, Id>();
    private readonly fences = new Map<Id, number>();
    private readonly reserved = new Map<Id, Budget>();
    private readonly unsettled = new Set<Id>();
    private readonly spent = new Map<Id, Budget>();
    private readonly now: () => Timestamp;
    private seq = 0;

    constructor(options: TeamRuntimeOptions) {
        this.now = options.now;
    }

    /**
     * Injected clock, exposed so leases and receipts share one timeline.
     */
    nowIso(): Timestamp {
        return this.now();
    }

    createDelegation(input: Omit<Delegation, "id">, manifest?: TeamManifest): Delegation {
        if (manifest) {
            this.enforceManifest(input, manifest);
        }
        if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 2) {
            throw new AttenuationError("delegation depth must be an integer from 0 to 2");
        }
        validateBudget(input.budget, "delegation budget");
        requireValidDeadline(input.deadline, "delegation deadline");
        if (input.scope.some((entry: string): boolean => entry.length === 0)) {
            throw new AttenuationError("delegation scope entries must be non-empty");
        }
        if (input.parent) {
            const parent: Delegation | undefined = this.delegations.get(input.parent);
            if (!parent) {
                throw new AttenuationError(`unknown parent delegation ${input.parent}`);
            }
            if (!parent.mayRedelegate) {
                throw new AttenuationError("parent does not allow re-delegation");
            }
            if (input.granter !== parent.delegatee) {
                throw new AttenuationError("child granter must be the parent delegatee");
            }
            if (!scopeWithin(input.scope, parent.scope)) {
                throw new AttenuationError("child scope exceeds parent scope");
            }
            const childBudget: Budget = inheritBudget(parent.budget, input.budget);
            attenuate(parent.budget, childBudget);
            if (Date.parse(input.deadline) > requireValidDeadline(parent.deadline, "parent deadline")) {
                throw new AttenuationError("child deadline exceeds parent");
            }
        }
        this.seq += 1;
        const delegation: Delegation = {
            ...input,
            budget: inheritBudget(input.parent ? (this.delegations.get(input.parent)?.budget ?? {}) : (manifest?.budget ?? {}), input.budget),
            id: `dl.${this.seq}`,
        };
        this.delegations.set(delegation.id, structuredClone(delegation));
        return structuredClone(delegation);
    }

    issueLease(delegationId: Id, input: LeaseGrant): Lease {
        const delegation: Delegation | undefined = this.delegations.get(delegationId);
        if (!delegation) {
            throw new AttenuationError(`unknown delegation ${delegationId}`);
        }
        const leaseBudget: Budget = inheritBudget(delegation.budget, input.budget);
        attenuate(delegation.budget, leaseBudget);
        if (Date.parse(input.deadline) > requireValidDeadline(delegation.deadline, "delegation deadline")) {
            throw new AttenuationError("lease deadline exceeds delegation");
        }
        requireValidDeadline(input.deadline, "lease deadline");

        const active: Id | undefined = this.activeByGoal.get(input.goalDigest);
        if (active && this.leases.get(active)?.status === "active") {
            throw new DuplicateTask(`goal already has an active lease: ${active}`);
        }

        const fence: number = (this.fences.get(input.taskId) ?? 0) + 1;
        this.fences.set(input.taskId, fence);
        this.seq += 1;
        const lease: Lease = {
            id: `ls.${this.seq}`,
            delegation: delegationId,
            taskId: input.taskId,
            holder: input.holder,
            fence,
            goalDigest: input.goalDigest,
            budget: leaseBudget,
            deadline: input.deadline,
            status: "active",
        };
        this.leases.set(lease.id, structuredClone(lease));
        this.activeByGoal.set(input.goalDigest, lease.id);
        this.reserved.set(lease.id, {});
        this.spent.set(lease.id, {});
        return structuredClone(lease);
    }

    /**
     * Reserve before dispatch (D-3): reservation is what makes a budget real.
     */
    reserve(leaseId: Id, cost: Budget): void {
        const lease: Lease = this.active(leaseId);
        validateBudget(cost, "reservation");
        const reserved: Budget = { ...(this.reserved.get(leaseId) ?? {}) };
        const spent: Budget = this.spent.get(leaseId) ?? {};
        for (let index: number = 0; index < DIMS.length; index += 1) {
            const dim: BudgetDimension = DIMS[index];
            const next: number = (spent[dim] ?? 0) + (reserved[dim] ?? 0) + (cost[dim] ?? 0);
            const limit: number | undefined = lease.budget[dim];
            if (limit !== (void 0) && next > limit) {
                throw new BudgetError(`spent and reserved ${dim} ${next} exceeds lease ${limit}`);
            }
            if (cost[dim] !== (void 0)) {
                reserved[dim] = (reserved[dim] ?? 0) + cost[dim];
            }
        }
        this.reserved.set(leaseId, reserved);
        this.unsettled.add(leaseId);
    }

    settle(leaseId: Id, actual: Budget): void {
        this.active(leaseId);
        validateBudget(actual, "settlement");
        const reserved: Budget | undefined = this.reserved.get(leaseId);
        if (reserved === (void 0) || !this.unsettled.has(leaseId)) {
            throw new BudgetError("settlement has no outstanding reservation");
        }
        for (let index: number = 0; index < DIMS.length; index += 1) {
            const dim: BudgetDimension = DIMS[index];
            if ((actual[dim] ?? 0) > (reserved[dim] ?? 0)) {
                throw new BudgetError(`settlement ${dim} exceeds reservation`);
            }
        }
        const spent: Budget = { ...(this.spent.get(leaseId) ?? {}) };
        for (let index: number = 0; index < DIMS.length; index += 1) {
            const dim: BudgetDimension = DIMS[index];
            spent[dim] = (spent[dim] ?? 0) + (actual[dim] ?? 0);
        }
        this.spent.set(leaseId, spent);
        this.reserved.set(leaseId, {});
        this.unsettled.delete(leaseId);
    }

    /**
     * A lease is single-writer: the fence must match or the write is stale.
     */
    assertWriter(leaseId: Id, fence: number): void {
        const lease: Lease = this.active(leaseId);
        if (lease.fence !== fence) {
            throw new FencingError(`stale writer: fence ${fence} != ${lease.fence}`);
        }
    }

    complete(leaseId: Id): Lease {
        const lease: Lease = this.active(leaseId);
        lease.status = "done";
        this.activeByGoal.delete(lease.goalDigest);
        return structuredClone(lease);
    }

    cancel(leaseId: Id): Lease {
        const lease: Lease = this.active(leaseId);
        lease.status = "cancelled";
        this.activeByGoal.delete(lease.goalDigest);
        return structuredClone(lease);
    }

    lease(leaseId: Id): Lease | undefined {
        const lease: Lease | undefined = this.leases.get(leaseId);
        return lease === (void 0) ? undefined : structuredClone(lease);
    }

    usage(leaseId: Id): LeaseUsage {
        return { reserved: { ...(this.reserved.get(leaseId) ?? {}) }, spent: { ...(this.spent.get(leaseId) ?? {}) } };
    }

    /**
     * The team manifest is the directory: if it is supplied, membership, scope,
     * fan-out and budget are checked before a delegation exists at all.
     */
    private enforceManifest(input: Omit<Delegation, "id">, manifest: TeamManifest): void {
        const granter: TeamMember | undefined = manifest.members.find((member) => member.id === input.granter);
        if (!granter) {
            throw new AttenuationError(`granter ${input.granter} is not a team member`);
        }
        if (!manifest.members.some((member) => member.id === input.delegatee)) {
            throw new AttenuationError(`delegatee ${input.delegatee} is not a team member`);
        }
        if (input.depth > manifest.max_depth) {
            throw new AttenuationError(`depth ${input.depth} exceeds team max ${manifest.max_depth}`);
        }
        for (let index: number = 0; index < input.scope.length; index += 1) {
            const scope: string = input.scope[index];
            if (!granter.authority.includes(scope)) {
                throw new AttenuationError(`scope ${scope} exceeds ${granter.id} authority`);
            }
        }
        attenuate(manifest.budget, input.budget);
        const existing: Delegation[] = [...this.delegations.values()].filter((item) => item.granter === input.granter);
        if (existing.length >= manifest.max_fanout) {
            throw new AttenuationError(`fan-out limit ${manifest.max_fanout} reached for ${input.granter}`);
        }
    }

    private active(leaseId: Id): Lease {
        const lease: Lease | undefined = this.leases.get(leaseId);
        if (!lease) {
            throw new FencingError(`unknown lease ${leaseId}`);
        }
        if (lease.status !== "active") {
            throw new FencingError(`lease ${leaseId} is ${lease.status}`);
        }
        return lease;
    }
}
