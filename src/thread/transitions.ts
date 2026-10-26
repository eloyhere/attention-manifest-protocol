/** Pure thread lifecycle predicate; no DB or domain implementation imports. */
import type { ThreadState } from "./thread.ts";

export const ThreadEdges: Record<ThreadState, readonly ThreadState[]> = {
    ready: ["running", "failed", "abandoned"],
    running: ["ready", "blocked", "done", "failed", "abandoned"],
    blocked: ["ready", "done", "failed", "abandoned"],
    done: [],
    failed: [],
    abandoned: [],
};

export const canThreadTransition = (from: ThreadState, to: ThreadState): boolean => ThreadEdges[from].includes(to);
