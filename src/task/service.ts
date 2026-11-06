import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { Acceptance, TransitionOptions } from "../workflow/types.ts";
import type { Action } from "../action/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Task } from "./types.ts";

export class TaskService extends CancellableWorkflowService<"task"> {
    constructor(store: WorkflowStore) { super(store, "task"); }
    actions(id: Identifier): readonly Action[] {
        const task = this.get(id);
        return this.store.list("action", task.sessionId).filter(action => action.taskId === id);
    }
    ready(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "ready", options); }
    start(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "running", options); }
    block(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "blocked", options); }
    succeed(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Task {
        return this.transition(id, "succeeded", { ...options, acceptance });
    }
    skip(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "skipped", options); }
}
