import type { Identifier } from "../shared.ts";
import type { VersionedEntity, InputClassification } from "../workflow/types.ts";

export type TurnState = "received" | "interpreting" | "clarifying" | "acting" | "responding" | "completed" | "interrupted" | "resumed" | "abandoned" | "failed";
export interface Turn extends VersionedEntity<"turn", TurnState> {
    readonly classification: InputClassification;
    readonly replyTo?: Identifier;
    readonly continuationKey?: string;
}

