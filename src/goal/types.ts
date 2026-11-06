import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, Acceptance } from "../workflow/types.ts";

export type GoalState = "pending" | "active" | "achieved" | "failed" | CancellationState;
export interface Goal extends VersionedEntity<"goal", GoalState> {
    readonly missionId: Identifier;
    readonly contractVersion: string;
    readonly acceptanceCriteria: readonly string[];
    readonly validity: "verification_pending" | "valid" | "invalidated";
    readonly achievedAt?: string;
    readonly assessment?: Acceptance;
    readonly correctivePlanId?: Identifier;
}

