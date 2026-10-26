/**
 * Action = goal-directed intent. It is not a permission verb and not an
 * operation. See docs/action-operation-turn-session-behavior.md.
 */
import type { BehaviorPlan } from "./behavior.ts";
import type { ScenarioPlan } from "../scenario/scenario.ts";
import type { InteractionPlan } from "../interaction/interaction.ts";

export type ActionId = string;

export type ActionRisk = "none" | "read" | "write" | "destructive";

export type ActionStatus = "planned" | "running" | "done" | "failed" | "abandoned";

export interface ActionRecord {
    id: ActionId;
    turnId: string;
    goal: string;
    intent: string;
    expectedEffect: string;
    preconditions: string[];
    successCriteria: string[];
    risk: ActionRisk;
    status: ActionStatus;
    operationIds: string[];
}

export interface ActionPlan {
    goal: string;
    intent: string;
    expectedEffect: string;
    preconditions?: string[];
    successCriteria?: string[];
    risk?: ActionRisk;
}

export interface ActionPlannerInput {
    turnId: string;
    text: string;
    behavior: BehaviorPlan;
    scenario: ScenarioPlan;
    interaction: InteractionPlan;
}

export interface ActionPlanner {
    plan(input: ActionPlannerInput): Promise<ActionPlan[]>;
}

/**
 * One bounded action per turn; later planners can split by goal.
 */
export class SingleActionPlanner implements ActionPlanner {
    async plan(input: ActionPlannerInput): Promise<ActionPlan[]> {
        const preferred: string[] = input.behavior.preferredActions;
        if (preferred.includes("acknowledge")) {
            return [
                {
                    goal: "acknowledge affect and converge on a next step",
                    intent: "acknowledge_then_converge",
                    expectedEffect: "user is heard and has one concrete next step",
                    successCriteria: ["answer acknowledges affect", "answer gives a bounded next step"],
                    risk: "none",
                },
            ];
        }
        if (preferred.includes("clarify")) {
            return [
                {
                    goal: "clarify the underspecified request",
                    intent: "clarify",
                    expectedEffect: "the missing constraint is supplied",
                    successCriteria: ["one focused question is returned"],
                    risk: "none",
                },
            ];
        }
        return [
            {
                goal: "respond to the user's request",
                intent: "respond",
                expectedEffect: "an answer is produced",
                successCriteria: ["answer is returned"],
                risk: "read",
            },
        ];
    }
}
