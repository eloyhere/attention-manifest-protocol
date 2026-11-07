import type { Identifier, JsonValue } from "../shared.ts";

/** Where a feedback item came from (refract.md §11.14 / §5.7). */
export const FEEDBACK_SOURCES = [
    "user_correction",
    "verification_result",
    "receipt_outcome",
    "evaluation",
    "host",
] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

/** Direction of the correction; it modulates the target, never authorizes it. */
export const FEEDBACK_POLARITIES = ["positive", "negative", "neutral"] as const;
export type FeedbackPolarity = (typeof FEEDBACK_POLARITIES)[number];

/** Domains that can consume a feedback item through a target adapter. */
export const FEEDBACK_TARGET_KINDS = ["attention", "behavior", "profession", "capability", "context_policy"] as const;
export type FeedbackTargetKind = (typeof FEEDBACK_TARGET_KINDS)[number];

export interface FeedbackTarget {
    readonly kind: FeedbackTargetKind;
    readonly id: Identifier;
    /** Version observed when the feedback was captured; updated on apply. */
    readonly version?: number;
}

/** Feedback lifecycle states. */
export const FEEDBACK_STATES = [
    "captured",
    "normalized",
    "triaged",
    "applied",
    "verified",
    "archived",
    "rejected",
    "superseded",
] as const;
export type FeedbackState = (typeof FEEDBACK_STATES)[number];

export interface Feedback {
    readonly id: Identifier;
    readonly source: FeedbackSource;
    readonly polarity: FeedbackPolarity;
    readonly target: FeedbackTarget;
    readonly evidenceIds: readonly Identifier[];
    readonly receiptIds?: readonly Identifier[];
    readonly scoreDelta?: number;
    readonly reason: string;
    readonly payload?: JsonValue;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly version: number;
    readonly state: FeedbackState;
    readonly appliedAt?: string;
    readonly verifiedAt?: string;
    readonly supersededBy?: Identifier;
}

const FEEDBACK_TRANSITION_EDGES: Record<FeedbackState, readonly FeedbackState[]> = {
    captured: ["normalized", "rejected", "superseded"],
    normalized: ["triaged", "rejected", "superseded"],
    triaged: ["applied", "rejected", "superseded"],
    applied: ["verified", "superseded"],
    verified: ["archived", "superseded"],
    archived: [],
    rejected: [],
    superseded: [],
};

/**
 * Feedback lifecycle edges. Capturing is implicit at ledger insertion; every
 * later state change must be a member of this table.
 */
export const FEEDBACK_TRANSITIONS: Readonly<Record<FeedbackState, readonly FeedbackState[]>> = Object.freeze(
    Object.fromEntries(
        Object.entries(FEEDBACK_TRANSITION_EDGES).map(([state, next]) => [state, Object.freeze([...next])]),
    ) as Record<FeedbackState, readonly FeedbackState[]>,
);

export type FeedbackErrorCode = "invalid_transition" | "version_conflict" | "invalid_feedback" | "adapter_failed";

/** Stable lifecycle/validation failure carrying a machine-readable code. */
export class FeedbackError extends Error {
    readonly code: FeedbackErrorCode;
    constructor(code: FeedbackErrorCode, message: string) {
        super(message);
        this.name = "FeedbackError";
        this.code = code;
    }
}

function isFeedbackState(value: unknown): value is FeedbackState {
    return typeof value === "string" && (FEEDBACK_STATES as readonly string[]).includes(value);
}

/**
 * Asserts that `from -> to` is legal. Throws `invalid_transition` for an
 * unknown state or an edge outside {@link FEEDBACK_TRANSITIONS}.
 */
export function assertFeedbackTransition(from: FeedbackState, to: FeedbackState): void {
    if (!isFeedbackState(from) || !isFeedbackState(to)) {
        throw new FeedbackError("invalid_transition", `unknown feedback state: ${String(from)} -> ${String(to)}`);
    }
    if (!FEEDBACK_TRANSITIONS[from].includes(to)) {
        throw new FeedbackError("invalid_transition", `invalid feedback transition: ${from} -> ${to}`);
    }
}
