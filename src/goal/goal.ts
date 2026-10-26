/**
 * Goal lifecycle: the admission state machine for a `Goal`.
 *
 * A goal is not "active" because someone said so; it moves through explicit
 * states, and `achieved`/`abandoned` are terminal. The plan and warrant layers
 * read this state instead of inferring intent from prose.
 */
import type { Goal } from "./plan.ts";

export type GoalState = "proposed" | "committed" | "active" | "achieved" | "abandoned";

export interface GoalLifecycle {
    goal: Goal;
    state: GoalState;
    startedAt?: string;
    achievedAt?: string;
}

const GoalEdges: Record<GoalState, readonly GoalState[]> = {
    proposed: ["committed", "abandoned"],
    committed: ["active", "abandoned"],
    active: ["achieved", "abandoned"],
    achieved: [],
    abandoned: [],
};

export const createGoalLifecycle = (goal: Goal): GoalLifecycle => ({ goal, state: "proposed" });

export const transitionGoal = (lifecycle: GoalLifecycle, to: GoalState, at: string): GoalLifecycle => {
    if (!GoalEdges[lifecycle.state].includes(to)) {
        throw new Error(`goal ${lifecycle.goal.id}: ${lifecycle.state} -> ${to} is not an edge`);
    }
    const next: GoalLifecycle = { ...lifecycle, state: to };
    if (to === "active" && next.startedAt === undefined) next.startedAt = at;
    if (to === "achieved") next.achievedAt = at;
    return next;
};
