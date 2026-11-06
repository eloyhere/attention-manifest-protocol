import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState, Acceptance } from "../workflow/types.ts";

export type TaskState = "pending" | "ready" | "running" | "blocked" | "succeeded" | "failed" | "skipped" | CancellationState;
export interface Task extends VersionedEntity<"task", TaskState> {
    readonly planId: Identifier;
    readonly dependsOn: readonly Identifier[];
    readonly required: boolean;
    readonly contractVersion: string;
    readonly requiredEffects: readonly string[];
    readonly assessment?: Acceptance;
}

