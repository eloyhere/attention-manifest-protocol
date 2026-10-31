/**
 * Pure attenuation and overlap predicates shared by the two ledgers.
 *
 * The rules mirror `src/delegate/team.ts`: a child may only narrow authority,
 * budget and window; a missing parent dimension means "not metered here".
 */
import type { Budget, Id } from "../types/common.ts";
import type { AssignmentWindow, Duty } from "./types.ts";

export const BudgetDimensions: readonly (keyof Budget)[] = ["tokens", "ms", "calls", "interrupts", "money"];

export const budgetWithin: (child: Budget, parent: Budget) => boolean = (child: Budget, parent: Budget): boolean => {
    for (let index: number = 0; index < BudgetDimensions.length; index += 1) {
        const dimension: keyof Budget = BudgetDimensions[index];
        const value: number | undefined = child[dimension];
        const cap: number | undefined = parent[dimension];
        if (value !== (void 0) && cap !== (void 0) && value > cap) {
            return false;
        }
    }
    return true;
};

export const windowWithin: (child: AssignmentWindow, parent: AssignmentWindow) => boolean = (
    child: AssignmentWindow,
    parent: AssignmentWindow,
): boolean => Date.parse(child.from) >= Date.parse(parent.from) && Date.parse(child.to) <= Date.parse(parent.to);

export const windowsOverlap: (left: AssignmentWindow, right: AssignmentWindow) => boolean = (
    left: AssignmentWindow,
    right: AssignmentWindow,
): boolean => Date.parse(left.from) < Date.parse(right.to) && Date.parse(right.from) < Date.parse(left.to);

export const authorityWithin: (child: readonly string[], parent: readonly string[]) => boolean = (
    child: readonly string[],
    parent: readonly string[],
): boolean => {
    const allowed: Set<string> = new Set<string>(parent);
    for (let index: number = 0; index < child.length; index += 1) {
        if (!allowed.has(child[index])) {
            return false;
        }
    }
    return true;
};

export const dutyIds: (duties: readonly Duty[]) => Id[] = (duties: readonly Duty[]): Id[] => duties.map((duty: Duty): Id => duty.id);

/**
 * A conflict is symmetric: either side may declare it.
 */
export const dutyConflict: (left: Duty, right: Duty) => boolean = (left: Duty, right: Duty): boolean =>
    (left.conflicts_with ?? []).includes(right.id) || (right.conflicts_with ?? []).includes(left.id);
