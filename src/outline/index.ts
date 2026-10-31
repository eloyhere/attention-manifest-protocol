/** Bounded document and code outlines, strategy registration and lookup indexes. */
export * from "./types.ts";
export * from "./outline.ts";
export * from "./outlineIndex.ts";
export * from "./outlineKeywords.ts";
export { builtinOutlineStrategies } from "./outlineStrategies.ts";
export { hasOfficeOutlineParser, registerOfficeOutlineParser } from "./officeBridge.ts";
export type { OfficeOutlineInput, OfficeOutlineParser } from "./officeBridge.ts";
export * from "./office.ts";
