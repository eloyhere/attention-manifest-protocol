/**
 * Public attention entry: one state object, one shift action.
 *
 * The lower-level candidate scoring, interrupt broker and resource planner are
 * implementation details during migration. They are not part of this surface.
 */
export { Attention, toShiftAction } from "./attention.ts";
export type { AttentionForce, AttentionForceKind, AttentionItem, AttentionOptions, AttentionShift, AttentionShiftResult, AttentionSnapshot, AttentionSubject } from "./attention.ts";
