/**
 * AMP v0.1 — public type surface.
 *
 * The shared primitives stay in this directory. Every domain owns its own
 * schema-mirroring types next to the code that enforces them; this barrel
 * re-exports the whole surface for hosts and tools that want one import.
 *
 * These types mirror docs/schemas/*.schema.json one-to-one.
 */
export type * from "./common.ts";
export type * from "../concept/concept.ts";
export type * from "../attention/socialTypes.ts";
export type * from "../cooperation/collaboration.ts";
export type * from "../delegate/teamTypes.ts";
export type * from "../goal/plan.ts";
export type * from "../frame/frame.ts";
export type * from "../window/compactionTypes.ts";
export type * from "../concept/conceptBudgetTypes.ts";
export type * from "../manifest/federationTypes.ts";
export type * from "../manifest/manifest.ts";
export type * from "../protocol/protocol.ts";
export type * from "../receipt/receipt.ts";
export type * from "../warrant/epistemic.ts";
