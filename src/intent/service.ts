import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { WorkflowEntityService } from "../workflow/service.ts";
import type { Intent } from "./types.ts";

export class IntentService extends WorkflowEntityService<"intent"> {
    constructor(store: WorkflowStore) { super(store, "intent"); }
    /** §4.3 captured -> interpreted. */
    interpret(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "interpreted", options); }
    clarify(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "clarifying", options); }
    resolveClarification(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "clarified", options); }
    delegate(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "delegated", options); }
    fulfill(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "fulfilled", options); }
    defer(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "deferred", options); }
    /** §4.3 deferred -> resumed -> confirmed. */
    resume(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "resumed", options); }
    abandon(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "abandoned", options); }
    /** §4.3 any non-superseded state -> superseded. */
    supersede(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "superseded", options); }
    confirm(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "confirmed", options); }
    accept(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "accepted", options); }
    reject(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "rejected", options); }
    withdraw(id: Identifier, options: TransitionOptions): Intent { return this.transition(id, "withdrawn", options); }
}
