import type { Optional } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "./store.ts";
import type { CreateEntity, TransitionOptions, WorkflowEntities, WorkflowKind } from "./types.ts";

/** A typed command port over the sole WorkflowStore writer; owns no state or cache. */
export class WorkflowEntityService<K extends WorkflowKind> {
    readonly kind: K;
    protected readonly store: WorkflowStore;

    constructor(store: WorkflowStore, kind: K) { this.store = store; this.kind = kind; }

    create(input: CreateEntity<K>, actor: Identifier): WorkflowEntities[K] {
        return this.store.create(this.kind, input, actor);
    }
    find(id: Identifier): Optional<WorkflowEntities[K]> { return this.store.find(this.kind, id); }
    get(id: Identifier): WorkflowEntities[K] { return this.store.get(this.kind, id); }
    list(sessionId?: Identifier): WorkflowEntities[K][] { return this.store.list(this.kind, sessionId); }
    transition(id: Identifier, state: WorkflowEntities[K]["state"], options: TransitionOptions): WorkflowEntities[K] {
        return this.store.transition(this.kind, id, state, options);
    }
}

export type CancellableWorkflowKind = "mission" | "goal" | "plan" | "task" | "action";
export class CancellableWorkflowService<K extends CancellableWorkflowKind> extends WorkflowEntityService<K> {
    requestCancel(id: Identifier, options: TransitionOptions): WorkflowEntities[K] {
        return this.store.requestCancel(this.kind, id, options);
    }
    drain(id: Identifier, options: TransitionOptions): WorkflowEntities[K] {
        return this.transition(id, "draining", options);
    }
    finishCancellation(id: Identifier, options: TransitionOptions): WorkflowEntities[K] {
        return this.transition(id, "cancelled", options);
    }
}
