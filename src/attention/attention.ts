import type { Ignored, ImpasseState, Slot } from "../frame/frame.ts";
import type { Ref } from "../types/common.ts";
import type { ActionPlan } from "../runtime/action.ts";

/**
 * A scored candidate before it becomes a slot. Mirrors the §5.2 inputs.
 */
export interface Candidate {
    target: Ref;
    role: Slot["role"];
    tier?: Slot["tier"];
    voi: number;
    goalFit: number;
    uncertainty: number;
    novelty: number;
    costTokens: number;
    risk: number;
    /**
     * Trust cap: external content cannot buy salience, only lose it (A-4).
     */
    trustCap: number;
    why: string;
}

type ScoredCandidate = {
    candidate: Candidate;
    score: number;
};

const clamp01: (n: number) => number = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * The reference salience function (§5.2).
 *
 * Only its monotonicity is normative: voi up ⇒ not down; cost/risk up ⇒ not up;
 * trust caps the result. The absolute numbers are a starting point, calibrated
 * over time via predicted vs realized VOI.
 */
export const salience: (candidate: Candidate) => number = (candidate: Candidate): number => {
    const value: number = candidate.voi * candidate.goalFit * (0.5 + candidate.uncertainty) * (1 + 0.5 * candidate.novelty);
    const cost: number = 1 + 2 * clamp01(candidate.costTokens / 2000) + 3 * clamp01(candidate.risk);
    return Math.round(Math.min(clamp01(value / cost), clamp01(candidate.trustCap)) * 1000) / 1000;
};

export interface SelectionOptions {
    budgetTokens: number;
    cap?: number;
    threshold?: number;
}

export interface Selection {
    slots: Slot[];
    ignored: Ignored[];
    impasse?: ImpasseState;
}

type SelectFocusFn = (candidates: Candidate[], options: SelectionOptions) => Selection;

/**
 * Select a focus set under budget, and record deliberate exclusions (A-2).
 * The ignored list is the part classical architectures never kept.
 */
export const selectFocus: SelectFocusFn = (candidates: Candidate[], options: SelectionOptions): Selection => {
    const threshold: number = options.threshold ?? 0.12;
    const cap: number = options.cap ?? 7;
    const scored: ScoredCandidate[] = candidates.map((c) => ({ candidate: c, score: salience(c) })).sort((a, b) => b.score - a.score);

    const ignored: Ignored[] = [];
    const above: ScoredCandidate[] = [];

    for (let i: number = 0; i < scored.length; i += 1) {
        const entry: ScoredCandidate = scored[i];
        if (entry.score < threshold) {
            ignored.push({
                target: entry.candidate.target,
                reason: "low_voi",
                revisit_if: "VOI 上升或目标改变",
            });
        } else {
            above.push(entry);
        }
    }

    if (above.length === 0) {
        return { slots: [], ignored, impasse: "STUCK" };
    }

    const tie: boolean = above.length > 1 && Math.abs(above[0].score - above[1].score) < 0.02;
    let remaining: number = options.budgetTokens;
    const slots: Slot[] = [];

    for (let i: number = 0; i < above.length; i += 1) {
        const candidate: Candidate = above[i].candidate;
        const score: number = above[i].score;
        if (slots.length >= cap) {
            ignored.push({ target: candidate.target, reason: "deferred", revisit_if: "焦点释放后" });
            continue;
        }
        if (candidate.costTokens > remaining) {
            ignored.push({ target: candidate.target, reason: "budget", revisit_if: "预算恢复后" });
            continue;
        }
        remaining -= candidate.costTokens;
        slots.push({
            target: candidate.target,
            role: candidate.role,
            tier: candidate.tier,
            salience: score,
            voi: candidate.voi,
            cost: { tokens: candidate.costTokens },
            budget: { tokens: candidate.costTokens },
            why: candidate.why,
            state: "active",
        });
    }

    const impasse: ImpasseState | undefined = slots.length === 0 ? "BUDGET" : tie ? "TIE" : undefined;

    return { slots, ignored, impasse };
};

export type AttentionForceKind = "attraction" | "distraction";

type AttentionCapacity = {
    slots: number;
    tokens: number;
};

export interface AttentionForce {
    kind: AttentionForceKind;
    from: Ref;
    target: Ref;
    /**
     * Required for distraction: what the target competes with.
     */
    competesWith?: Ref;
    strength: number;
    decay?: number;
    ttl?: number;
}

export interface AttentionItem {
    target: Ref;
    /**
     * Stable left/right order. Weight never reorders the window.
     */
    order: number;
    weight: number;
    pinned?: boolean;
    source?: Ref;
    enteredAt?: string;
    ttl?: number;
}

export interface AttentionSubject {
    pid: number;
    tid?: number;
}

export interface AttentionShift {
    actionId: string;
    direction: "left" | "right";
    steps?: number;
    reason: string;
}

export interface AttentionSnapshot {
    subject: AttentionSubject;
    status: "open" | "closed";
    cursor: number;
    capacity: AttentionCapacity;
    focus: AttentionItem[];
    ignored: AttentionItem[];
    forces: AttentionForce[];
}

export interface AttentionShiftResult {
    actionId: string;
    changed: boolean;
    blocked: boolean;
    reason: string;
    snapshot: AttentionSnapshot;
}

export interface AttentionOptions {
    subject: AttentionSubject;
    capacity: AttentionCapacity;
    items?: readonly AttentionItem[];
    now?: () => string;
}

const clampWeight: (value: number) => number = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * The single attention state.
 *
 * It owns only the ordered focus ring, capacity and force field. It never
 * materializes context, never mutates Frame and never executes a shift: a shift
 * is an Action that calls `shift()` and must be settled by a Receipt.
 */
export class Attention {
    readonly subject: AttentionSubject;
    readonly capacity: AttentionCapacity;
    status: "open" | "closed" = "open";
    cursor = 0;
    private readonly items: AttentionItem[];
    private readonly forces: AttentionForce[] = [];
    private readonly now: () => string;

    constructor(options: AttentionOptions) {
        if (!Number.isSafeInteger(options.capacity.slots) || options.capacity.slots <= 0) {
            throw new RangeError("attention capacity.slots must be positive");
        }
        if (!Number.isSafeInteger(options.capacity.tokens) || options.capacity.tokens <= 0) {
            throw new RangeError("attention capacity.tokens must be positive");
        }
        this.subject = { ...options.subject };
        this.capacity = { ...options.capacity };
        this.items = (options.items ?? []).map((item) => ({ ...item }));
        this.items.sort((left, right) => left.order - right.order);
        this.now = options.now ?? (() => new Date().toISOString());
    }

    /**
     * Apply an attraction/distraction force; commit decides admission.
     */
    observe(force: AttentionForce): void {
        this.assertOpen();
        if (!Number.isFinite(force.strength) || force.strength < 0) {
            throw new RangeError("force strength must be non-negative");
        }
        if (force.kind === "distraction" && force.competesWith === (void 0)) {
            throw new Error("distraction requires competesWith");
        }
        const id: string = force.target.id;
        const target: AttentionItem | undefined = this.items.find((item) => item.target.id === id);
        if (target === (void 0)) {
            this.items.push({
                target: { ...force.target },
                order: this.nextOrder(),
                weight: clampWeight(force.strength),
                source: force.from,
                enteredAt: this.now(),
                ...(force.ttl === (void 0) ? {} : { ttl: force.ttl }),
            });
        } else {
            target.weight = clampWeight(target.weight + force.strength);
        }
        if (force.kind === "distraction" && force.competesWith !== (void 0)) {
            const competitor: AttentionItem | undefined = this.items.find((item) => item.target.id === force.competesWith?.id);
            if (competitor !== (void 0)) {
                competitor.weight = clampWeight(competitor.weight - force.strength * 0.5);
            }
        }
        this.forces.push({ ...force });
    }

    /**
     * Stable left/right window. Pinned items stay visible.
     */
    focus(): AttentionItem[] {
        const pinned: AttentionItem[] = this.items.filter((item) => item.pinned === true);
        const unpinned: AttentionItem[] = this.items.filter((item) => item.pinned !== true);
        const needed: number = Math.max(0, this.capacity.slots - pinned.length);
        const visible: AttentionItem[] = unpinned.slice(this.cursor, this.cursor + needed);
        return [...pinned, ...visible].sort((left, right) => left.order - right.order);
    }

    snapshot(): AttentionSnapshot {
        const focus: AttentionItem[] = this.focus();
        const focusIds: Set<string> = new Set(focus.map((item) => item.target.id));
        return {
            subject: { ...this.subject },
            status: this.status,
            cursor: this.cursor,
            capacity: { ...this.capacity },
            focus,
            ignored: this.items.filter((item) => !focusIds.has(item.target.id)),
            forces: this.forces.map((force) => ({ ...force })),
        };
    }

    /**
     * Apply one `attention.shift` action. The caller must still record an
     * ActionRecord and a Receipt; this method only mutates cursor.
     */
    shift(action: AttentionShift): AttentionShiftResult {
        this.assertOpen();
        if (action.direction !== "left" && action.direction !== "right") {
            throw new Error(`invalid shift direction ${action.direction}`);
        }
        const steps: number = Math.max(1, Math.abs(Math.trunc(action.steps ?? 1)));
        const pinned: number = this.items.filter((item) => item.pinned === true).length;
        const needed: number = Math.max(0, this.capacity.slots - pinned);
        const unpinned: number = this.items.length - pinned;
        const maxCursor: number = Math.max(0, unpinned - needed);
        const next: number = Math.max(0, Math.min(maxCursor, this.cursor + (action.direction === "left" ? -steps : steps)));
        const changed: boolean = next !== this.cursor;
        const reason: string = changed ? `cursor ${this.cursor}->${next}` : `blocked at ${action.direction} boundary (${this.cursor})`;
        this.cursor = next;
        return { actionId: action.actionId, changed, blocked: !changed, reason, snapshot: this.snapshot() };
    }

    close(): void {
        this.status = "closed";
    }

    private nextOrder(): number {
        return this.items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    }

    private assertOpen(): void {
        if (this.status === "closed") {
            throw new Error("attention is closed");
        }
    }
}

type ShiftActionInput = Omit<AttentionShift, "actionId"> & {
    actionId?: string;
};

/**
 * Convert a shift into an existing runtime ActionPlan, not a new executor.
 */
export const toShiftAction: (shift: ShiftActionInput) => ActionPlan = (shift: ShiftActionInput): ActionPlan => ({
    goal: "move the attention window",
    intent: "attention.shift",
    expectedEffect: `attention cursor moves ${shift.direction} by ${shift.steps ?? 1}`,
    preconditions: ["attention is open", "focus is ordered"],
    successCriteria: ["cursor changed", "a new Frame is committed", "a Receipt is recorded"],
    risk: "none",
});

/**
 * Test helper: the contract's monotonicity constraints (§5.2).
 */
export const respectsMonotonicity: (base: Candidate) => boolean = (base: Candidate): boolean => {
    const at: (over: Partial<Candidate>) => number = (over: Partial<Candidate>): number => salience({ ...base, ...over });
    const s0: number = at({});
    return (
        at({ voi: Math.min(1, base.voi + 0.1) }) >= s0 &&
        at({ costTokens: base.costTokens + 200 }) <= s0 &&
        at({ risk: Math.min(1, base.risk + 0.1) }) <= s0 &&
        at({ trustCap: Math.min(base.trustCap, 0.2) }) <= s0
    );
};
