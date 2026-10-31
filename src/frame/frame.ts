/**
 * AMP v0.1 — Frame (注意帧): one immutable allocation snapshot.
 * Mirrors docs/schemas/frame.schema.json.
 */
import type { Budget, Confidence, Digest, Id, Ref, Tier, Timestamp, Usage } from "../types/common.ts";

export type FrameMode = "explore" | "exploit" | "triage" | "reflect" | "rest";

export type SlotRole = "goal" | "question" | "evidence" | "concept" | "process" | "tool" | "memory" | "self" | "other" | "threat" | "artifact";

export type IgnoredReason = "low_voi" | "out_of_scope" | "untrusted" | "budget" | "blocked" | "habituated" | "deferred";

export type ImpasseState = "TIE" | "STUCK" | "STALLED" | "CONFLICT" | "INFEASIBLE" | "UNKNOWN" | "UNVERIFIED" | "DRIFT" | "BUDGET";

/**
 * Why something is being attended to — required, not decorative (A-1).
 */
export interface Slot {
    target: Ref;
    role: SlotRole;
    tier?: Tier;
    salience: Confidence;
    voi?: Confidence;
    cost: Budget;
    budget?: Budget;
    why: string;
    ttl_turns?: number;
    state: "active" | "released" | "evicted" | "done";
}

/**
 * Deliberate exclusion. The distinctive field: no classical architecture records this.
 */
export interface Ignored {
    target: Ref;
    reason: IgnoredReason;
    revisit_if: string;
}

export interface FrameBudget {
    allocated: Budget;
    spent: Usage;
}

export interface Impasse {
    state: ImpasseState;
    detail?: string;
}

export interface Frame {
    amp: "0.1";
    kind: "frame";
    id: Id;
    agent: Id;
    cycle: number;
    ts: Timestamp;
    parent?: Ref;
    digest: Digest;
    mode: FrameMode;
    goal?: Ref;
    /**
     * At most 9 slots. Capacity is the point, not a limitation.
     */
    slots: Slot[];
    ignored?: Ignored[];
    budget: FrameBudget;
    open_questions?: Ref[];
    impasse?: Impasse;
    note?: string;
}
