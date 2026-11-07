import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, ProgressBounds } from "../workflow/types.ts";

/**
 * Lifecycle states for Plan (refract §4.6).
 * `ready`/`running` stay accepted as legacy aliases of `approved`/`executing`
 * (see `PLAN_STATE_ALIASES` in `src/workflow/transitions.ts`).
 */
export type PlanState =
    | "draft"
    | "approved"
    | "ready"
    | "executing"
    | "running"
    | "paused"
    | "replanning"
    | "completed"
    | "failed"
    | "superseded"
    | CancellationState;
export interface Plan extends VersionedEntity<"plan", PlanState> {
    readonly goalId: Identifier;
    readonly bounds: ProgressBounds;
}
