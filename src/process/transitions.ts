/**
 * Pure process lifecycle predicate; no DB or domain implementation imports.
 */
import type { ProcessState } from "./process.ts";

export const ProcessEdges: Record<ProcessState, readonly ProcessState[]> = {
    created: ["running", "idle", "suspended", "terminated"],
    running: ["idle", "suspended", "terminated"],
    idle: ["running", "suspended", "terminated"],
    suspended: ["running", "idle", "terminated"],
    terminated: [],
};

/**
 * Predicate deciding whether one process state may move to another.
 */
type ProcessTransitionPredicate = (from: ProcessState, to: ProcessState) => boolean;

export const canProcessTransition: ProcessTransitionPredicate = (from: ProcessState, to: ProcessState): boolean => ProcessEdges[from].includes(to);
