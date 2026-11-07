import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, Acceptance } from "../workflow/types.ts";

/**
 * Lifecycle states for Task (refract §4.7).
 * `running`/`succeeded` stay accepted as legacy aliases of `active`/`completed`
 * (see `TASK_STATE_ALIASES` in `src/workflow/transitions.ts`).
 */
export type TaskState =
    | "pending"
    | "proposed"
    | "ready"
    | "running"
    | "active"
    | "paused"
    | "blocked"
    | "unblocked"
    | "completed"
    | "succeeded"
    | "dead_letter"
    | "skipped"
    | "failed"
    | CancellationState;
export interface Task extends VersionedEntity<"task", TaskState> {
    readonly planId: Identifier;
    readonly dependsOn: readonly Identifier[];
    readonly required: boolean;
    readonly contractVersion: string;
    readonly requiredEffects: readonly string[];
    readonly assessment?: Acceptance;
}
