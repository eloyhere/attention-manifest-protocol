import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Mission } from "./types.ts";

export class MissionService extends CancellableWorkflowService<"mission"> {
    constructor(store: WorkflowStore) { super(store, "mission"); }
    /** §4.4 accepted -> proposed re-enters the proposal stage without deleting the legacy state. */
    propose(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "proposed", options); }
    activate(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "active", options); }
    achieve(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "achieved", options); }
    partiallyAchieve(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "partially_achieved", options); }
    pause(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "paused", options); }
    resume(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "resumed", options); }
    /** §4.4 paused -> archived; archived is terminal. */
    archive(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "archived", options); }
    abandon(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "abandoned", options); }
    fail(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "failed", options); }
}
