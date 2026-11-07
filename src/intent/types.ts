import type { Identifier } from "../shared.ts";
import type { VersionedEntity } from "../workflow/types.ts";

/**
 * Lifecycle states for Intent (refract §4.3).
 * `accepted` and `withdrawn` are the legacy states kept for backward compatibility.
 */
export type IntentState =
    | "captured"
    | "interpreted"
    | "clarifying"
    | "clarified"
    | "confirmed"
    | "accepted"
    | "delegated"
    | "fulfilled"
    | "rejected"
    | "deferred"
    | "resumed"
    | "abandoned"
    | "superseded"
    | "withdrawn";
export interface Intent extends VersionedEntity<"intent", IntentState> {
    readonly originTurnId: Identifier;
    readonly text: string;
}
