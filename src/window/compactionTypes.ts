/**
 * AMP v0.1 — context economy: compaction and pruning.
 *
 * Two operations that are often confused, and must not be:
 *
 * - **Pruning** produces a *view* of a verified ledger. Nothing is deleted; the
 *   log keeps every entry. A prune plan states what was left out, why, and when
 *   to reconsider it.
 * - **Compaction** reduces *storage*. A contiguous cold prefix is replaced by a
 *   checkpoint that commits to the digest of exactly what was removed, so the
 *   chain remains verifiable from the checkpoint's tip.
 *
 * Both are explicit by construction. Silent loss is the failure mode this layer
 * exists to prevent.
 */
import type { Digest, Id, Timestamp } from "../types/common.ts";

/** Entry kinds the chain can hold; the same set as `persistence.EntryKind`. */
export type LedgerKind = "event" | "frame" | "receipt" | "claim" | "hypothesis" | "unknown" | "goal" | "plan";

/**
 * Retention policy for a prune plan.
 *
 * `keepRecent` is a hard floor: the newest N entries are never candidates,
 * regardless of what the per-kind rules would allow.
 */
export interface PrunePolicy {
    amp: "0.1";
    kind: "prune-policy";
    keepRecent: number;
    dropSupersededClaims: boolean;
    dropClosedHypotheses: boolean;
    dropResolvedUnknowns: boolean;
}

/** Why an entry left the view. Closed set, so a reader can audit the decision. */
export type PruneReason = "superseded" | "closed" | "resolved";

/** One entry omitted from a view, with the condition that would bring it back. */
export interface PruneDecision {
    seq: number;
    kind: LedgerKind;
    id: Id;
    reason: PruneReason;
    /** What would have to change for this object to be worth loading again. */
    revisit_if: string;
    /** Serialised size of the omitted entry, so the saving is not hand-waved. */
    bytes: number;
}

/**
 * A view of a verified snapshot.
 *
 * `kept` and `dropped` partition the source chain: `kept.length + dropped.length
 * === sourceCount`, and `sourceTip` names the chain the view was derived from.
 */
export interface PrunePlan {
    amp: "0.1";
    kind: "prune-plan";
    agent: string;
    sourceTip: Digest;
    sourceCount: number;
    kept: number[];
    dropped: PruneDecision[];
    reclaimedBytes: number;
    /** Bytes / 4. An estimate, never used for billing. */
    estimatedTokens: number;
    policy: PrunePolicy;
}

/**
 * A cold prefix, reduced to a commitment.
 *
 * `root` covers the removed entries in chain order. Anyone holding the original
 * entries can prove the checkpoint was not rewritten; anyone holding only the
 * checkpoint can prove what *was* removed, without being able to reconstruct it.
 */
export interface Checkpoint {
    amp: "0.1";
    kind: "checkpoint";
    id: Id;
    agent: string;
    /** Sequence number of the first covered entry. */
    from: number;
    /** Sequence number of the last covered entry. */
    to: number;
    count: number;
    /** Hash of the last covered entry; the continuation point for the tail. */
    tip: Digest;
    /** Digest over the covered entries, in order. */
    root: Digest;
    created: Timestamp;
    policy: { keepRecent: number };
}
