import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { TransitionOptions } from "../workflow/types.ts";
import { WorkflowEntityService } from "../workflow/service.ts";
import type { Turn } from "./types.ts";

export class TurnService extends WorkflowEntityService<"turn"> {
    constructor(store: WorkflowStore) { super(store, "turn"); }
    interpret(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "interpreting", options); }
    clarify(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "clarifying", options); }
    /** Matching linkage is checked by the common writer; the original Turn survives. */
    resumeClarification(id: Identifier, continuationKey: string, options: TransitionOptions): Turn {
        return this.interpret(id, { ...options, clarification: { replyTo: id, continuationKey } });
    }
    act(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "acting", options); }
    respond(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "responding", options); }
    complete(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "completed", options); }
    interrupt(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "interrupted", options); }
    resume(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "resumed", options); }
    abandon(id: Identifier, options: TransitionOptions): Turn { return this.transition(id, "abandoned", options); }
}
