import type { Identifier } from "../shared.ts";

/**
 * Where a learning record was observed (`refract.md` §11.14 L8). A record is
 * only ever a candidate distilled from something that already happened; it is
 * never a direct instruction to change another domain.
 */
export const LEARN_SOURCES = ["turn", "receipt", "feedback", "evaluation", "host"] as const;
export type LearnSource = (typeof LEARN_SOURCES)[number];

/** Domain a validated learning record can eventually be adopted into. */
export const LEARN_TARGET_KINDS = ["behavior", "cognition", "skill", "heuristic"] as const;
export type LearnTargetKind = (typeof LEARN_TARGET_KINDS)[number];

/**
 * Learning lifecycle states (`refract.md` §11.14 L8):
 *
 * ```
 * observed -> reflected -> abstracted -> validated -> adopted -> retained
 *                \________ rejected / superseded _______/          |  ^
 *                                                                  v  |
 *                                                               decayed
 * ```
 *
 * `reinforce` re-enters `retained` from `retained` or `decayed`; `retain`
 * schedules the next review through `revisitAfter`.
 */
export const LEARN_STATES = [
    "observed",
    "reflected",
    "abstracted",
    "validated",
    "adopted",
    "retained",
    "decayed",
    "rejected",
    "superseded",
] as const;
export type LearnState = (typeof LEARN_STATES)[number];

/** A durable, versioned learning candidate. */
export interface LearnRecord {
    readonly id: Identifier;
    readonly source: LearnSource;
    readonly targetKind: LearnTargetKind;
    readonly targetId?: Identifier;
    /** Verified trajectory ids this record was distilled from. */
    readonly traces: readonly Identifier[];
    /** Formalized abstraction, set by the `abstract` step. */
    readonly abstraction?: string;
    /** Reflected confidence in [0, 1]; zero until the first reflection. */
    readonly confidence: number;
    readonly evidenceIds: readonly Identifier[];
    readonly feedbackIds?: readonly Identifier[];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly version: number;
    readonly state: LearnState;
    readonly adoptedAt?: string;
    /** Next review time; set by `retain` and refreshed by `reinforce`. */
    readonly revisitAfter?: string;
    readonly supersededBy?: Identifier;
}

const LEARN_TRANSITION_EDGES: Record<LearnState, readonly LearnState[]> = {
    observed: ["reflected", "rejected", "superseded"],
    reflected: ["abstracted", "rejected", "superseded"],
    abstracted: ["validated", "rejected", "superseded"],
    validated: ["adopted", "rejected", "superseded"],
    adopted: ["retained", "superseded"],
    // `retained -> retained` is the reinforce self-edge.
    retained: ["retained", "decayed", "superseded"],
    decayed: ["retained", "superseded"],
    rejected: [],
    superseded: [],
};

/**
 * Learning lifecycle edges. `observe` creates the initial state; every later
 * state change must be a member of this table.
 */
export const LEARN_TRANSITIONS: Readonly<Record<LearnState, readonly LearnState[]>> = Object.freeze(
    Object.fromEntries(
        Object.entries(LEARN_TRANSITION_EDGES).map(([state, next]) => [state, Object.freeze([...next])]),
    ) as Record<LearnState, readonly LearnState[]>,
);

export type LearnErrorCode =
    | "invalid_transition"
    | "version_conflict"
    | "invalid_learn"
    | "insufficient_evidence"
    | "decay_due";

/** Stable lifecycle/validation failure carrying a machine-readable code. */
export class LearnError extends Error {
    readonly code: LearnErrorCode;

    constructor(code: LearnErrorCode, message: string) {
        super(message);
        this.name = "LearnError";
        this.code = code;
    }
}

function isLearnState(value: unknown): value is LearnState {
    return typeof value === "string" && (LEARN_STATES as readonly string[]).includes(value);
}

/**
 * Asserts that `from -> to` is legal. Throws `invalid_transition` for an
 * unknown state or an edge outside {@link LEARN_TRANSITIONS}.
 */
export function assertLearnTransition(from: LearnState, to: LearnState): void {
    if (!isLearnState(from) || !isLearnState(to)) {
        throw new LearnError("invalid_transition", `unknown learn state: ${String(from)} -> ${String(to)}`);
    }
    if (!LEARN_TRANSITIONS[from].includes(to)) {
        throw new LearnError("invalid_transition", `invalid learn transition: ${from} -> ${to}`);
    }
}
