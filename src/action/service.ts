import type { Optional } from "semantic-typescript";
import type { Identifier } from "../shared.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type { ActionAttempt, TransitionOptions } from "../workflow/types.ts";
import { CancellableWorkflowService } from "../workflow/service.ts";
import type { Action } from "./types.ts";

export type StartActionAttempt = Parameters<WorkflowStore["startAttempt"]>[1];
export type SettleActionAttempt = Parameters<WorkflowStore["settleAttempt"]>[1];
export type ReconcileAction = Parameters<WorkflowStore["reconcileAction"]>[1];

export class ActionService extends CancellableWorkflowService<"action"> {
    constructor(store: WorkflowStore) { super(store, "action"); }
    ready(id: Identifier, options: TransitionOptions): Action { return this.transition(id, "ready", options); }
    assertExecutionAllowed(id: Identifier, epoch: number): Action { return this.store.assertExecutionAllowed(id, epoch); }
    startAttempt(id: Identifier, input: StartActionAttempt): ActionAttempt { return this.store.startAttempt(id, input); }
    findAttempt(attemptId: Identifier): Optional<ActionAttempt> { return this.store.findAttempt(attemptId); }
    getAttempt(attemptId: Identifier): ActionAttempt { return this.store.getAttempt(attemptId); }
    attempts(id: Identifier): readonly ActionAttempt[] { return this.get(id).attemptIds.map(attemptId => this.store.getAttempt(attemptId)); }
    settleAttempt(attemptId: Identifier, input: SettleActionAttempt): ActionAttempt { return this.store.settleAttempt(attemptId, input); }
    beginReconciliation(id: Identifier, options: TransitionOptions): Action { return this.transition(id, "reconciling", options); }
    reconcile(id: Identifier, input: ReconcileAction): Action { return this.store.reconcileAction(id, input); }
}
