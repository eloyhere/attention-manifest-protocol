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
    /** §4.7 pending -> proposed -> ready keeps the legacy initial state usable. */
    propose(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "proposed", options); }
    ready(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "ready", options); }
    /** §4.7 ready -> active; `running` remains an accepted alias. */
    activate(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "active", options); }
    start(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "running", options); }
    pause(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "paused", options); }
    /** Paused work resumes into the §4.7 active state. */
    resume(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "active", options); }
    block(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "blocked", options); }
    unblock(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "unblocked", options); }
    /** §4.7 exhausted work enters the dead-letter queue; the state is terminal. */
    deadLetter(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "dead_letter", options); }
    /** §4.7 active -> completed; `succeeded` remains an accepted alias. */
    complete(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Task {
        return this.transition(id, "completed", { ...options, acceptance });
    }
    succeed(id: Identifier, acceptance: Acceptance, options: TransitionOptions): Task {
        return this.transition(id, "succeeded", { ...options, acceptance });
    }
    skip(id: Identifier, options: TransitionOptions): Task { return this.transition(id, "skipped", options); }
}
