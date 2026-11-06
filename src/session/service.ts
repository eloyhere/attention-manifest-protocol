import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { WorkflowEntityService } from "../workflow/service.ts";
import type { Session } from "./types.ts";

export class SessionService extends WorkflowEntityService<"session"> {
    constructor(store: WorkflowStore) { super(store, "session"); }
    activate(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "active", options); }
    idle(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "idle", options); }
    suspend(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "suspended", options); }
    resume(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "resumed", options); }
    beginClose(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "closing", options); }
    close(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "closed", options); }
    archive(id: Identifier, options: TransitionOptions): Session { return this.transition(id, "archived", options); }
}
