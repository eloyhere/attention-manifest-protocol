import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { ProgressBounds, TransitionOptions } from "../workflow/types.ts";
import type { Task } from "../task/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Plan } from "./types.ts";

export class PlanService extends CancellableWorkflowService<"plan"> {
    constructor(store: WorkflowStore) { super(store, "plan"); }
    /** Read-only detached DAG projection. Task creation stays in TaskService. */
    tasks(id: Identifier): readonly Task[] {
        const plan = this.get(id);
        return this.store.list("task", plan.sessionId).filter(task => task.planId === id);
    }
    bounds(id: Identifier): ProgressBounds { return this.get(id).bounds; }
    /** The common writer validates the complete DAG before admitting ready. */
    ready(id: Identifier, options: TransitionOptions): Plan { return this.transition(id, "ready", options); }
    start(id: Identifier, options: TransitionOptions): Plan { return this.transition(id, "running", options); }
    complete(id: Identifier, options: TransitionOptions): Plan { return this.transition(id, "completed", options); }
    supersede(id: Identifier, options: TransitionOptions): Plan { return this.transition(id, "superseded", options); }
}
