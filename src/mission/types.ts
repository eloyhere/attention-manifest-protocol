import type { Identifier } from "../shared.ts";
import type { VersionedEntity, CancellationState } from "../workflow/types.ts";

/**
 * Lifecycle states for Mission (refract §4.4).
 * `accepted`/`active`/`achieved`/`failed` are the legacy states kept for compatibility.
 */
export type MissionState =
    | "accepted"
    | "proposed"
    | "active"
    | "achieved"
    | "partially_achieved"
    | "paused"
    | "resumed"
    | "archived"
    | "abandoned"
    | "failed"
    | CancellationState;
export interface Mission extends VersionedEntity<"mission", MissionState> {
    readonly intentId: Identifier;
}
