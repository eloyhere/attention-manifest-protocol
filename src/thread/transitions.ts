/**
 * Pure thread lifecycle predicate; no DB or domain implementation imports.
 */
import type { ThreadState } from "./thread.ts";

type ThreadTransition = (from: ThreadState, to: ThreadState) => boolean;

export const ThreadEdges: Record<ThreadState, readonly ThreadState[]> = {
    ready: ["running", "failed", "abandoned"],
    running: ["ready", "blocked", "done", "failed", "abandoned"],
    blocked: ["ready", "done", "failed", "abandoned"],
    done: [],
    failed: [],
    abandoned: [],
};

export const canThreadTransition: ThreadTransition = (from: ThreadState, to: ThreadState): boolean => ThreadEdges[from].includes(to);
