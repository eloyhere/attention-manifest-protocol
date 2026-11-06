import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Mission } from "./types.ts";

export class MissionService extends CancellableWorkflowService<"mission"> {
    constructor(store: WorkflowStore) { super(store, "mission"); }
    activate(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "active", options); }
    achieve(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "achieved", options); }
    fail(id: Identifier, options: TransitionOptions): Mission { return this.transition(id, "failed", options); }
}
