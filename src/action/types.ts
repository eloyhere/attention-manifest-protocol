import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, RecoveryMode } from "../workflow/types.ts";

/**
 * Lifecycle states for Action (refract §4.8).
 * `running` stays accepted as a legacy alias of `executing`
 * (see `ACTION_STATE_ALIASES` in `src/workflow/transitions.ts`).
 * Execution facts are still written only by `startAttempt`/`settleAttempt`.
 */
export type ActionState =
    | "declared"
    | "pending"
    | "ready"
    | "executing"
    | "running"
    | "retrying"
    | "succeeded"
    | "failed"
    | "skipped"
    | "dead_letter"
    | "reconciling"
    | CancellationState;
export interface Action extends VersionedEntity<"action", ActionState> {
    readonly taskId: Identifier;
    readonly operationId: Identifier;
    readonly effect: string;
    readonly required: boolean;
    readonly sideEffect: boolean;
    readonly recovery: RecoveryMode;
    readonly attemptIds: readonly Identifier[];
}
