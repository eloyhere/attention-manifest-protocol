import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { Acceptance, TransitionOptions } from "../workflow/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Goal } from "./types.ts";

export class GoalService extends CancellableWorkflowService<"goal"> {
    constructor(store: WorkflowStore) { super(store, "goal"); }
    activate(id: Identifier, options: TransitionOptions): Goal { return this.transition(id, "active", options); }
    achieve(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Goal {
        return this.transition(id, "achieved", { ...options, acceptance });
    }
    invalidate(id: Identifier, options: TransitionOptions): Goal { return this.store.invalidateGoal(id, options); }
    attachCorrectivePlan(id: Identifier, planId: Identifier, options: TransitionOptions): Goal {
        return this.store.attachCorrectivePlan(id, planId, options);
    }
    revalidate(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Goal {
        return this.store.revalidateGoal(id, { ...options, acceptance });
    }
}
