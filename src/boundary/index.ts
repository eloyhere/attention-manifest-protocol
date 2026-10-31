/**
 * Boundary barrel: constructors that reject instead of returning invalid objects.
 */
export { BoundaryRejection } from "../error/boundaryRejection.ts";
export type { BoundaryCode } from "../error/boundaryRejection.ts";
export { isId } from "./ids.ts";
export { RefTable } from "./refTable.ts";
export type { RefScope } from "./refTable.ts";
export { frameFrom } from "./frame.ts";
export type { FrameBoundaryOptions, FrameBoundaryResult, FrameDraft } from "./frame.ts";
export { parseToolCall } from "./toolCall.ts";
export type { ParsedToolCall, ToolSchema } from "./toolCall.ts";
