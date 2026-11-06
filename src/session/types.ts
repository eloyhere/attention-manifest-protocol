import type { Identifier } from "../shared.ts";
import type { VersionedEntity } from "../workflow/types.ts";

export type SessionState = "created" | "active" | "idle" | "suspended" | "resumed" | "closing" | "closed" | "archived" | "expired" | "aborted";
export interface Session extends VersionedEntity<"session", SessionState> {
    readonly participants: readonly Identifier[];
}
