import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState } from "../workflow/types.ts";

export type MissionState = "accepted" | "active" | "achieved" | "failed" | CancellationState;
export interface Mission extends VersionedEntity<"mission", MissionState> {
    readonly intentId: Identifier;
}

