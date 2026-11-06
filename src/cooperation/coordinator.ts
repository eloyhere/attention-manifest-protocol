import { Optional, SynchronousUnorderedMap } from "semantic-typescript";
import { intersectPermissionScopes } from "../profession/policy.ts";
import type { Identifier } from "../shared.ts";
import type { Clock, CooperationMessage, DelegatedTask, DelegationRequest, ResultAcceptance, ResultSubmission } from "./types.ts";
const clone = <T>(value: T): T => structuredClone(value);
export class CooperationCoordinator {
    private readonly tasks = new SynchronousUnorderedMap<Identifier, DelegatedTask>();
    private readonly messages = new SynchronousUnorderedMap<Identifier, CooperationMessage>();
    private readonly clock: Clock;
    constructor(clock: Clock = () => new Date().toISOString()) { this.clock = clock; }
    delegate(request: DelegationRequest): DelegatedTask {
        if (!request.taskId || !request.delegatorAgentId || !request.ownerAgentId) throw new TypeError("Delegation requires task and agent IDs");
        if (this.tasks.containsKey(request.taskId)) throw new TypeError(`Task already delegated: ${request.taskId}`);
        const now = this.clock(); const task: DelegatedTask = { taskId: request.taskId, ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}), delegatorAgentId: request.delegatorAgentId, ownerAgentId: request.ownerAgentId, ownerEpoch: 1, fence: `${request.taskId}:1`, effectiveScope: intersectPermissionScopes(request.parentScope, request.requestedScope), state: "delegated", createdAt: now, updatedAt: now };
        this.tasks.put(task.taskId, clone(task)); return clone(task);
    }
    get(taskId: Identifier): DelegatedTask | undefined { const value = this.find(taskId); return value.isPresent() ? clone(value.get()) : undefined; }
    find(taskId: Identifier): Optional<DelegatedTask> { return this.tasks.get(taskId).map(clone); }
    start(taskId: Identifier, ownerAgentId: Identifier, ownerEpoch: number, fence: string): DelegatedTask { const task = this.require(taskId); this.assertOwner(task, ownerAgentId, ownerEpoch, fence); if (task.state !== "delegated") throw new TypeError("Only delegated work may start"); return this.update(task, { state: "running" }); }
    cancel(taskId: Identifier, ownerAgentId: Identifier, ownerEpoch: number, fence: string, reason: string): DelegatedTask { const task = this.require(taskId); this.assertOwner(task, ownerAgentId, ownerEpoch, fence); if (["completed", "failed", "cancelled", "unknown_outcome"].includes(task.state)) return clone(task); return this.update(task, { state: "cancel_requested", cancellationReason: reason }); }
    transfer(taskId: Identifier, newOwnerAgentId: string): DelegatedTask { const task = this.require(taskId); if (!["delegated", "running"].includes(task.state)) throw new TypeError("Only delegated or running work may transfer"); const ownerEpoch = task.ownerEpoch + 1; return this.update(task, { ownerAgentId: newOwnerAgentId, ownerEpoch, fence: `${task.taskId}:${ownerEpoch}` }); }
    submitResult(result: ResultSubmission): ResultAcceptance {
        const task = this.get(result.taskId); if (!task) return { accepted: false, reason: "unknown_task" }; if (task.ownerAgentId !== result.ownerAgentId) return { accepted: false, reason: "not_owner", task }; if (task.ownerEpoch !== result.ownerEpoch) return { accepted: false, reason: "stale_epoch", task }; if (task.fence !== result.fence) return { accepted: false, reason: "stale_fence", task }; if (["cancel_requested", "cancelled"].includes(task.state)) return { accepted: false, reason: "cancelled", task }; if (["completed", "failed", "unknown_outcome"].includes(task.state)) return { accepted: false, reason: "already_settled", task };
        const state = result.outcome === "success" ? "completed" : result.outcome === "failure" ? "failed" : "unknown_outcome"; return { accepted: true, reason: "accepted", task: this.update(task, { state }) };
    }
    storeMessage(message: CooperationMessage): CooperationMessage { if (this.messages.containsKey(message.messageId)) throw new TypeError(`Duplicate message: ${message.messageId}`); this.messages.put(message.messageId, clone(message)); return clone(message); }
    getMessage(messageId: Identifier): CooperationMessage | undefined { const value = this.findMessage(messageId); return value.isPresent() ? clone(value.get()) : undefined; }
    findMessage(messageId: Identifier): Optional<CooperationMessage> { return this.messages.get(messageId).map(clone); }
    private require(taskId: Identifier): DelegatedTask { const task = this.get(taskId); if (!task) throw new TypeError(`Unknown delegated task: ${taskId}`); return task; }
    private assertOwner(task: DelegatedTask, ownerAgentId: string, ownerEpoch: number, fence: string): void { if (task.ownerAgentId !== ownerAgentId || task.ownerEpoch !== ownerEpoch || task.fence !== fence) throw new TypeError("Stale delegation owner or fence"); }
    private update(task: DelegatedTask, patch: Partial<DelegatedTask>): DelegatedTask { const updated = { ...task, ...patch, updatedAt: this.clock() }; this.tasks.put(task.taskId, clone(updated)); return clone(updated); }
}
