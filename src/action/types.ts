import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, RecoveryMode } from "../workflow/types.ts";

export type ActionState = "declared" | "ready" | "running" | "succeeded" | "failed" | "reconciling" | CancellationState;
export interface Action extends VersionedEntity<"action", ActionState> {
    readonly taskId: Identifier;
    readonly operationId: Identifier;
    readonly effect: string;
    readonly required: boolean;
    readonly sideEffect: boolean;
    readonly recovery: RecoveryMode;
    readonly attemptIds: readonly Identifier[];
}

