import type { Identifier } from "../shared.ts";
import { BudgetError } from "./ledger.ts";
import {
    BUDGET_DIMENSIONS,
    EmptyBudgetTreeUsage,
    addBudgetUsage,
    isZeroBudgetUsage,
    normalizeBudgetUsage,
    subtractBudgetUsage,
} from "./types.ts";
import type { BudgetDimension, BudgetTreeAmount, BudgetTreeUsage } from "./types.ts";

/** Detached, deeply frozen view of one budget-tree node. */
export interface BudgetNodeSnapshot {
    readonly id: Identifier;
    readonly parentId?: Identifier;
    readonly limit: BudgetTreeUsage;
    readonly allocated: BudgetTreeUsage;
    readonly settled: BudgetTreeUsage;
    readonly reserved: BudgetTreeUsage;
}

/** Injected exhaustion observer. A node/dimension pair fires at most once. */
export type BudgetExhaustedHandler = (nodeId: Identifier, dimension: BudgetDimension) => void;

export interface BudgetTreeRoot {
    readonly id: Identifier;
    readonly limit: BudgetTreeAmount;
}

export interface BudgetTreeOptions {
    /** Optional initial root (usually the Session budget). */
    readonly root?: BudgetTreeRoot;
    /** Shorthand root id; ignored when `root` is present. */
    readonly id?: Identifier;
    /** Shorthand root limit; ignored when `root` is present. */
    readonly limit?: BudgetTreeAmount;
    /**
     * Called when an operation cannot fit in the node's remaining budget.
     * The tree itself never changes business state; the caller decides whether
     * a Turn becomes interrupted, a Session closes, and so on.
     */
    readonly onExhausted?: BudgetExhaustedHandler;
}

export interface BudgetTreeSettleOptions {
    /** Return the unspent remainder to the parent (default `true`). */
    readonly reclaim?: boolean;
}

interface MutableBudgetNode {
    readonly id: Identifier;
    readonly parentId?: Identifier;
    limit: BudgetTreeUsage;
    allocated: BudgetTreeUsage;
    settled: BudgetTreeUsage;
    reserved: BudgetTreeUsage;
}

function freezeDeep<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
}

function requireIdentifier(value: unknown, label: string): asserts value is Identifier {
    if (typeof value !== "string" || value.trim() === "") {
        throw new BudgetError("invalid_node", `${label} must be nonempty text.`);
    }
}

function cloneUsage(usage: BudgetTreeUsage): BudgetTreeUsage {
    return { ...usage };
}

function normalizeAmount(amount: BudgetTreeAmount): BudgetTreeUsage {
    try {
        return normalizeBudgetUsage(amount);
    } catch (error) {
        throw new BudgetError("invalid_amount", error instanceof Error ? error.message : String(error));
    }
}

function zeroUsage(): BudgetTreeUsage {
    return { ...EmptyBudgetTreeUsage };
}

/**
 * Hierarchical budget accounting for `refract.md` §16.
 *
 * Each node owns a `limit`. `allocated` is the part of that limit delegated to
 * direct children, `settled` is finalized direct consumption, and `reserved`
 * is provisional consumption that has not been settled yet. The invariant is
 *
 *     allocated + settled + reserved <= limit
 *
 * per dimension. Upper layers allocate, lower layers consume; a parent can
 * never allocate more than its own remaining budget, and a child can never
 * consume more than it was allocated. Exhaustion throws the stable
 * `budget_exhausted` error and leaves the tree unchanged. Business reactions
 * (interrupting a Turn, suspending a Session) belong to the caller and are
 * reported through the injected `onExhausted` observer.
 */
export class BudgetTree {
    private readonly nodes = new Map<Identifier, MutableBudgetNode>();
    private readonly closed = new Set<Identifier>();
    private readonly exhausted = new Set<string>();
    private readonly onExhausted?: BudgetExhaustedHandler;

    constructor(options: BudgetTreeOptions = {}) {
        this.onExhausted = options.onExhausted;
        const root = options.root ?? (options.id === undefined ? undefined : { id: options.id, limit: options.limit ?? {} });
        if (root) this.addRoot(root.id, root.limit);
    }

    get size(): number {
        return this.nodes.size;
    }

    /** Create an additional root (for example a Session-level reserved budget). */
    addRoot(id: Identifier, limit: BudgetTreeAmount): BudgetNodeSnapshot {
        requireIdentifier(id, "root id");
        if (this.nodes.has(id)) throw new BudgetError("node_exists", `Budget node ${id} already exists.`);
        const normalized = normalizeAmount(limit);
        this.nodes.set(id, {
            id,
            limit: normalized,
            allocated: zeroUsage(),
            settled: zeroUsage(),
            reserved: zeroUsage(),
        });
        return this.snapshot(id);
    }

    has(id: Identifier): boolean {
        return this.nodes.has(id);
    }

    /**
     * Move `amount` from `parent` to `child`.
     *
     * A missing child is created with this allocation as its limit; an existing
     * direct child is topped up. The parent's remaining budget (limit minus
     * allocated, settled and reserved) may not be exceeded.
     */
    allocate(parent: Identifier, child: Identifier, amount: BudgetTreeAmount): BudgetNodeSnapshot {
        requireIdentifier(child, "child id");
        if (parent === child) throw new BudgetError("invalid_parent", "A budget node cannot allocate to itself.");
        const parentNode = this.requireNode(parent);
        this.assertOpen(parent);
        const existing = this.nodes.get(child);
        if (existing) {
            if (existing.parentId !== parent) {
                throw new BudgetError("invalid_parent", `Budget node ${child} does not belong to ${parent}.`);
            }
            this.assertOpen(child);
        }
        const normalized = normalizeAmount(amount);
        const available = this.remainingOf(parentNode);
        const exhausted = BUDGET_DIMENSIONS.filter(dimension => normalized[dimension] > available[dimension]);
        if (exhausted.length > 0) this.failExhausted(parent, exhausted);

        // Compute every new value before mutating, so a failed update is atomic.
        const nextParentAllocated = addBudgetUsage(parentNode.allocated, normalized);
        const nextChildLimit = existing ? addBudgetUsage(existing.limit, normalized) : normalized;
        parentNode.allocated = nextParentAllocated;
        if (existing) {
            existing.limit = nextChildLimit;
        } else {
            this.nodes.set(child, {
                id: child,
                parentId: parent,
                limit: nextChildLimit,
                allocated: zeroUsage(),
                settled: zeroUsage(),
                reserved: zeroUsage(),
            });
        }
        return this.snapshot(child);
    }

    /** Finalize direct consumption against a node's unallocated remainder. */
    consume(node: Identifier, usage: BudgetTreeAmount): BudgetNodeSnapshot {
        const target = this.requireNode(node);
        this.assertOpen(node);
        const normalized = normalizeAmount(usage);
        const exhausted = BUDGET_DIMENSIONS.filter(dimension => normalized[dimension] > this.remainingOf(target)[dimension]);
        if (exhausted.length > 0) this.failExhausted(node, exhausted);
        target.settled = addBudgetUsage(target.settled, normalized);
        return this.snapshot(node);
    }

    /**
     * Provisionally reserve consumption. Reserved amounts reduce the remaining
     * budget immediately but only become `settled` through `settle`.
     */
    reserve(node: Identifier, usage: BudgetTreeAmount): BudgetNodeSnapshot {
        const target = this.requireNode(node);
        this.assertOpen(node);
        const normalized = normalizeAmount(usage);
        const exhausted = BUDGET_DIMENSIONS.filter(dimension => normalized[dimension] > this.remainingOf(target)[dimension]);
        if (exhausted.length > 0) this.failExhausted(node, exhausted);
        target.reserved = addBudgetUsage(target.reserved, normalized);
        return this.snapshot(node);
    }

    /**
     * Release unused budget.
     *
     * While the node has open reservations, `release` frees reservations only
     * (with no `amount`, all of them), leaving the capacity available for the
     * node itself. Once no reservation remains, `release` returns the node's
     * unspent allocation to its parent; an explicit `amount` lets the caller
     * return a part of it. `settled` and `allocated` are never touched.
     */
    release(node: Identifier, amount?: BudgetTreeAmount): BudgetNodeSnapshot {
        const target = this.requireNode(node);
        this.assertOpen(node);

        if (!isZeroBudgetUsage(target.reserved)) {
            const requested = amount === undefined ? cloneUsage(target.reserved) : normalizeAmount(amount);
            const overReleased = BUDGET_DIMENSIONS.filter(dimension => requested[dimension] > target.reserved[dimension]);
            if (overReleased.length > 0) {
                throw new BudgetError("invalid_release", `Released amount exceeds the reserved ${overReleased.join(", ")} on ${node}.`);
            }
            target.reserved = subtractBudgetUsage(target.reserved, requested);
            return this.snapshot(node);
        }

        const unspent = this.remainingOf(target);
        const requested = amount === undefined ? cloneUsage(unspent) : normalizeAmount(amount);
        const overReleased = BUDGET_DIMENSIONS.filter(dimension => requested[dimension] > unspent[dimension]);
        if (overReleased.length > 0) {
            throw new BudgetError("invalid_release", `Released amount exceeds the unspent ${overReleased.join(", ")} on ${node}.`);
        }
        if (target.parentId === undefined) {
            // A root has no parent to receive the released capacity.
            if (!isZeroBudgetUsage(requested)) throw new BudgetError("invalid_release", `Budget root ${node} has no parent to release to.`);
            return this.snapshot(node);
        }
        const parent = this.requireNode(target.parentId);
        parent.allocated = subtractBudgetUsage(parent.allocated, requested);
        target.limit = subtractBudgetUsage(target.limit, requested);
        return this.snapshot(node);
    }

    /**
     * Close an accounting period (normally a Turn).
     *
     * Without `actual`, all open reservations are finalized as consumed. With
     * `actual`, that amount is settled from the reservations (or from the
     * remaining budget when nothing was reserved), and any unused reservation
     * is released. By default the unspent remainder is returned to the parent
     * and removed from this node's limit; `{ reclaim: false }` keeps the limit
     * for a retention policy. A settled node becomes read-only.
     */
    settle(node: Identifier, actual?: BudgetTreeAmount, options: BudgetTreeSettleOptions = {}): BudgetNodeSnapshot {
        const target = this.requireNode(node);
        this.assertOpen(node);
        const reclaim = options.reclaim ?? true;

        if (actual === undefined) {
            target.settled = addBudgetUsage(target.settled, target.reserved);
            target.reserved = zeroUsage();
        } else {
            const normalized = normalizeAmount(actual);
            if (isZeroBudgetUsage(target.reserved)) {
                const exhausted = BUDGET_DIMENSIONS.filter(dimension => normalized[dimension] > this.remainingOf(target)[dimension]);
                if (exhausted.length > 0) this.failExhausted(node, exhausted);
                target.settled = addBudgetUsage(target.settled, normalized);
            } else {
                const overReserved = BUDGET_DIMENSIONS.filter(dimension => normalized[dimension] > target.reserved[dimension]);
                if (overReserved.length > 0) {
                    throw new BudgetError("settlement_exceeds_reservation", `Settled amount exceeds the reserved ${overReserved.join(", ")} on ${node}.`);
                }
                target.settled = addBudgetUsage(target.settled, normalized);
                target.reserved = zeroUsage();
            }
        }

        if (reclaim && target.parentId !== undefined) {
            const parent = this.requireNode(target.parentId);
            const leftover = this.remainingOf(target);
            if (!isZeroBudgetUsage(leftover)) {
                parent.allocated = subtractBudgetUsage(parent.allocated, leftover);
                target.limit = subtractBudgetUsage(target.limit, leftover);
            }
        }
        this.closed.add(node);
        return this.snapshot(node);
    }

    snapshot(node: Identifier): BudgetNodeSnapshot {
        const target = this.requireNode(node);
        return freezeDeep({
            id: target.id,
            ...(target.parentId === undefined ? {} : { parentId: target.parentId }),
            limit: cloneUsage(target.limit),
            allocated: cloneUsage(target.allocated),
            settled: cloneUsage(target.settled),
            reserved: cloneUsage(target.reserved),
        });
    }

    /** Every node in insertion order (roots first, then allocation order). */
    snapshots(): readonly BudgetNodeSnapshot[] {
        return Object.freeze([...this.nodes.keys()].map(id => this.snapshot(id)));
    }

    /** Budget still available for direct consumption or further allocation. */
    remaining(node: Identifier): BudgetTreeUsage {
        return freezeDeep(this.remainingOf(this.requireNode(node)));
    }

    private requireNode(id: Identifier): MutableBudgetNode {
        const node = this.nodes.get(id);
        if (!node) throw new BudgetError("node_not_found", `Budget node ${id} does not exist.`);
        return node;
    }

    private assertOpen(id: Identifier): void {
        if (this.closed.has(id)) throw new BudgetError("node_closed", `Budget node ${id} has already been settled.`);
    }

    private remainingOf(node: MutableBudgetNode): BudgetTreeUsage {
        const remaining = zeroUsage();
        for (const dimension of BUDGET_DIMENSIONS) {
            remaining[dimension] = Math.max(0, node.limit[dimension] - node.allocated[dimension] - node.settled[dimension] - node.reserved[dimension]);
        }
        return remaining;
    }

    private failExhausted(node: Identifier, dimensions: readonly BudgetDimension[]): never {
        for (const dimension of dimensions) {
            const key = `${node}\u0000${dimension}`;
            if (this.exhausted.has(key)) continue;
            this.exhausted.add(key);
            try {
                this.onExhausted?.(node, dimension);
            } catch {
                // An observer must never replace the stable budget_exhausted signal.
            }
        }
        throw new BudgetError("budget_exhausted", `Budget node ${node} has no remaining ${dimensions.join(", ")}.`);
    }
}
