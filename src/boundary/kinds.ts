/**
 * Runtime mirror of `RefKind` (`src/types/common.ts` / `common.schema.json`).
 *
 * TypeScript unions disappear at runtime, so a boundary that accepts JSON or
 * JavaScript callers cannot rely on the compiler to keep `kind` inside the
 * closed set. This module is the single runtime list both `RefTable` and
 * `frameFrom` consult.
 */
import type { RefKind } from "../types/common.ts";

export const RefKinds: ReadonlySet<RefKind> = new Set<RefKind>([
    "entity",
    "concept",
    "process",
    "thread",
    "question",
    "hypothesis",
    "claim",
    "evidence",
    "goal",
    "plan",
    "task",
    "tool",
    "memory",
    "other",
    "human",
    "agent",
    "event",
    "handle",
    "frame",
    "self",
    "unknown",
    "common-ground",
    "capability",
    "receipt",
    "org",
    "role",
    "duty",
    "assignment",
    "interaction",
    "result-contract",
]);

export const isRefKind: (value: unknown) => value is RefKind = (value: unknown): value is RefKind =>
    typeof(value) === "string" && RefKinds.has(value as RefKind);
