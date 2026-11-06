import type { Identifier } from "../shared.ts";
import type { VersionedEntity } from "../workflow/types.ts";

export type IntentState = "captured" | "confirmed" | "accepted" | "rejected" | "withdrawn";
export interface Intent extends VersionedEntity<"intent", IntentState> {
    readonly originTurnId: Identifier;
    readonly text: string;
}

