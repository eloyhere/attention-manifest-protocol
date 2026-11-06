import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { WorkflowEntityService } from "../workflow/service.ts";
import type { Intent } from "./types.ts";

export class IntentService extends WorkflowEntityService<"intent"> {
    constructor(store: WorkflowStore) { super(store, "intent"); }
    confirm(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "confirmed", options); }
    accept(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "accepted", options); }
    reject(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "rejected", options); }
    withdraw(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "withdrawn", options); }
}
