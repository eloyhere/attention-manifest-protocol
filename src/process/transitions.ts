/** Pure process lifecycle predicate; no DB or domain implementation imports. */
import type { ProcessState } from "./process.ts";

export const ProcessEdges: Record<ProcessState, readonly ProcessState[]> = {
    created: ["running", "idle", "suspended", "terminated"],
    running: ["idle", "suspended", "terminated"],
    idle: ["running", "suspended", "terminated"],
    suspended: ["running", "idle", "terminated"],
    terminated: [],
};

export const canProcessTransition = (from: ProcessState, to: ProcessState): boolean => ProcessEdges[from].includes(to);
