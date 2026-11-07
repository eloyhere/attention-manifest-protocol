import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { Acceptance, TransitionOptions } from "../workflow/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Goal } from "./types.ts";

export class GoalService extends CancellableWorkflowService<"goal"> {
    constructor(store: WorkflowStore) { super(store, "goal"); }
    /** §4.5 pending -> proposed -> active keeps the legacy initial state usable. */
    propose(id: Identifier, options: TransitionOptions): Goal { return this.transition(id, "proposed", options); }
    activate(id: Identifier, options: TransitionOptions): Goal { return this.transition(id, "active", options); }
    achieve(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Goal {
        return this.transition(id, "achieved", { ...options, acceptance });
    }
    /** §4.5 active -> blocked -> unblocked -> active. Supply the blocking reason via `reason`. */
    block(id: Identifier, options: TransitionOptions): Goal { return this.transition(id, "blocked", options); }
    unblock(id: Identifier, options: TransitionOptions): Goal { return this.transition(id, "unblocked", options); }
    abandon(id: Identifier, options: TransitionOptions): Goal { return this.transition(id, "abandoned", options); }
    invalidate(id: Identifier, options: TransitionOptions): Goal { return this.store.invalidateGoal(id, options); }
    attachCorrectivePlan(id: Identifier, planId: Identifier, options: TransitionOptions): Goal {
        return this.store.attachCorrectivePlan(id, planId, options);
    }
    revalidate(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Goal {
        return this.store.revalidateGoal(id, { ...options, acceptance });
    }
}
