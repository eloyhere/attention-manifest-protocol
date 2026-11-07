import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, Acceptance } from "../workflow/types.ts";

/**
 * Lifecycle states for Goal (refract §4.5).
 * `pending` is the legacy initial state kept for compatibility.
 */
export type GoalState =
    | "pending"
    | "proposed"
    | "active"
    | "achieved"
    | "failed"
    | "blocked"
    | "unblocked"
    | "abandoned"
    | CancellationState;
export interface Goal extends VersionedEntity<"goal", GoalState> {
    readonly missionId: Identifier;
    readonly contractVersion: string;
    readonly acceptanceCriteria: readonly string[];
    readonly validity: "verification_pending" | "valid" | "invalidated";
    readonly achievedAt?: string;
    readonly assessment?: Acceptance;
    readonly correctivePlanId?: Identifier;
}
