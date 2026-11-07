import type { Identifier } from "../shared.ts";
import type { VersionedEntity, InputClassification } from "../workflow/types.ts";

export type TurnState = "received" | "interpreting" | "clarifying" | "acting" | "responding" | "completed" | "interrupted" | "resumed" | "abandoned" | "failed";

export type WorkspaceChangeKind = "added" | "modified" | "deleted" | "renamed" | "unknown";

/** Minimal workspace change summary captured at an interruption boundary (§4.2). */
export interface WorkspaceChangeSummary {
    readonly path: string;
    readonly change: WorkspaceChangeKind;
    /** Content/digest marker when the host can provide one. */
    readonly digest?: string;
    readonly summary?: string;
}

export const TURN_INTERRUPTION_SCHEMA_VERSION = 1;

/**
 * Minimal on-site snapshot required to continue an interrupted Turn (§4.2):
 * lifecycle position, origin Turn, pending Intent and workspace changes.
 */
export interface TurnInterruptionSnapshot {
    readonly schemaVersion: typeof TURN_INTERRUPTION_SCHEMA_VERSION;
    readonly turnId: Identifier;
    readonly sessionId: Identifier;
    /** Lifecycle state before interruption (usually `acting`). */
    readonly state: TurnState;
    /** Entity version before interruption. */
    readonly version: number;
    readonly originTurnId?: Identifier;
    /** First unresolved Intent captured by this Turn, when one exists. */
    readonly pendingIntentId?: Identifier;
    readonly pendingIntentIds: readonly Identifier[];
    readonly workspaceChanges: readonly WorkspaceChangeSummary[];
    readonly reason: string;
    readonly actor: Identifier;
    readonly capturedAt: string;
    readonly digest: string;
}

/** Options for `TurnService.interrupt`; the reason is mandatory (§4.2 interruption record). */
export interface TurnInterruptOptions {
    /** Optimistic check; defaults to the current interrupted Turn version. */
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
    readonly reason: string;
    /** Workspace changes observed before the interruption (§4.2 stale detection input). */
    readonly workspaceChanges?: readonly WorkspaceChangeSummary[];
    /** Explicit pending Intent; otherwise derived from unresolved Intents captured by the Turn. */
    readonly pendingIntentId?: Identifier;
    /** Injected clock for deterministic snapshots. */
    readonly now?: string;
}

/** Options for `TurnService.resume`; the snapshot may be supplied after a restart. */
export interface TurnResumeOptions {
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
    /** Supplied snapshot (e.g. after process restart); defaults to the service ledger. */
    readonly snapshot?: TurnInterruptionSnapshot;
    readonly reason?: string;
    readonly now?: string;
}

export interface Turn extends VersionedEntity<"turn", TurnState> {
    readonly classification: InputClassification;
    readonly replyTo?: Identifier;
    readonly continuationKey?: string;
    /** Present after `interrupt`; restored by the service overlay. */
    readonly interruption?: TurnInterruptionSnapshot;
    /** True once the interruption snapshot has been validated and continued. */
    readonly resumedFromSnapshot?: boolean;
}

/** Turn history compaction policy from §4.2 (recent N full, older summarized, oldest session summary). */
export interface TurnCompactionPolicy {
    /** Most recent N Turns keep complete detail. */
    readonly keepRecent: number;
    /** The next N Turns (older than the kept window) become event summaries. Defaults to `keepRecent`. */
    readonly summarizeWithin?: number;
    /** Optional caller-authored session summary for the oldest Turns. */
    readonly sessionSummary?: string;
    /** Injected clock for deterministic records. */
    readonly now?: string;
}

export type TurnHistoryTier = "full" | "event_summary" | "session_summary";

export interface TurnHistorySummary {
    readonly turnId: Identifier;
    /** Alias of `turnId` so callers can project ids uniformly. */
    readonly id: Identifier;
    readonly state: TurnState;
    readonly tier: "event_summary" | "session_summary";
    readonly summary: string;
    readonly eventCount: number;
    readonly createdAt: string;
}

export interface TurnCompactionPolicySnapshot {
    readonly keepRecent: number;
    readonly summarizeWithin: number;
    readonly sessionSummary?: string;
}

export interface TurnCompactionProtected {
    readonly turnId: Identifier;
    readonly reason: "active_turn" | "unresolved_intent" | "active_mission";
}

/**
 * Compaction record shaped for the §5.3 `system_rule` evidence source. A full
 * `Evidence` also needs a receipt/verification; the host attaches this record
 * to the evidence ledger without inventing either.
 */
export interface TurnCompactionRecord {
    readonly id: Identifier;
    readonly evidenceKind: "system_rule";
    readonly source: {
        readonly type: "system_rule";
        readonly reliability: number;
        readonly independenceKey: string;
    };
    readonly sessionId: Identifier;
    readonly policy: TurnCompactionPolicySnapshot;
    readonly keptIds: readonly Identifier[];
    readonly summarizedIds: readonly Identifier[];
    readonly archivedIds: readonly Identifier[];
    readonly protected: readonly TurnCompactionProtected[];
    readonly sessionSummary: string;
    /** Human-readable reason; always present because compaction is an evidence claim. */
    readonly reason: string;
    readonly digest: string;
    readonly createdAt: string;
}

export interface TurnCompactionResult {
    /** Most recent N Turns in full, plus protected Turns. */
    readonly kept: readonly Turn[];
    /** Older Turns replaced by event summaries. */
    readonly summarized: readonly TurnHistorySummary[];
    /** Oldest Turns collapsed into the session summary. */
    readonly archived: readonly TurnHistorySummary[];
    readonly record: TurnCompactionRecord;
}

/** Stable failure codes for the turn recovery/compaction surface. */
export type TurnErrorCode = "invalid_snapshot" | "stale_snapshot" | "invalid_policy" | "invalid_state" | "not_found";

export class TurnError extends Error {
    readonly code: TurnErrorCode;
    constructor(code: TurnErrorCode, message: string) {
        super(message);
        this.name = "TurnError";
        this.code = code;
    }
}
