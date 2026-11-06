import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, ProgressBounds } from "../workflow/types.ts";

export type PlanState = "draft" | "ready" | "running" | "completed" | "failed" | "superseded" | CancellationState;
export interface Plan extends VersionedEntity<"plan", PlanState> {
    readonly goalId: Identifier;
    readonly bounds: ProgressBounds;
}

