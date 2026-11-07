import { Optional, SynchronousUnorderedMap } from "semantic-typescript";
import { intersectPermissionScopes } from "../profession/policy.ts";
import { safeStringify } from "../serialization/index.ts";
import type { Identifier } from "../shared.ts";
import type {
    ArbitrationDecision,
    ArbitrationOutcome,
    ArbitrationRecord,
    Clock,
    ConflictReportInput,
    Cooperation,
    CooperationBinding,
    CooperationBindingInput,
    CooperationBindingLevel,
    CooperationCloseOutcome,
    CooperationConflict,
    CooperationConflictType,
    CooperationIsolationAdapter,
    CooperationMessage,
    CooperationRoleAssignment,
    CooperationSnapshot,
    CreateCooperationInput,
    DelegatedTask,
    DelegationRequest,
    IsolationChange,
    IsolationHandle,
    IsolationMergeResult,
    IsolationResource,
    IsolationSyntaxValidator,
    ResultAcceptance,
    ResultSubmission,
} from "./types.ts";
import { DEFAULT_ISOLATION_TTL_MILLISECONDS, InMemoryIsolationAdapter, IsolationConflictError } from "./isolation.ts";
import {
    COOPERATION_INITIAL_STATUSES,
    TERMINAL_CLOSE_OUTCOMES,
    isTerminalCooperationStatus,
    validateCooperation,
} from "./validation.ts";

const clone = <T>(value: T): T => structuredClone(value);
const fail = (message: string): never => {
    throw new TypeError(message);
};
const requireText = (value: unknown, field: string): string => typeof value === "string" && value.trim().length > 0 ? value : fail(`${field} must be a nonempty string`);
const requireArray = (value: unknown, field: string): readonly unknown[] => Array.isArray(value) ? value : fail(`${field} must be an array`);
const ARBITRATION_OUTCOMES: readonly ArbitrationOutcome[] = ["favor_reporter", "favor_respondent", "split", "no_action", "escalate_to_human", "reassign"];
const CONFLICT_TYPES: readonly CooperationConflictType[] = ["resource", "result", "intent", "protocol_violation", "budget", "topology"];

/** Optional collaborators for the cooperation kernel. */
export type CooperationCoordinatorOptions = {
    /** Lock + merge port; defaults to a per-coordinator in-memory adapter (not cross-process). */
    readonly isolation?: CooperationIsolationAdapter;
    /** Lease duration for coordinator-acquired locks; defaults to 30s. */
    readonly isolationTtlMilliseconds?: number;
    /** When > 0, coordinator writes wait for a lease and detect wait-for cycles. */
    readonly isolationWaitMilliseconds?: number;
    /** Syntax checker used by the default in-memory merge engine. */
    readonly syntaxValidator?: IsolationSyntaxValidator;
};

/**
 * In-memory cooperation kernel. Tasks and messages are always owned by a
 * Cooperation; a legacy delegation without `cooperationId` lazily creates an
 * implicit star cooperation so no task can become orphaned.
 *
 * All mutations are synchronous. `snapshot()` returns detached JSON-compatible
 * facts; `restore()` validates references and never reads the clock or starts work.
 */
export class CooperationCoordinator {
    private readonly cooperations = new SynchronousUnorderedMap<Identifier, Cooperation>();
    private readonly tasks = new SynchronousUnorderedMap<Identifier, DelegatedTask>();
    private readonly messages = new SynchronousUnorderedMap<Identifier, CooperationMessage>();
    private readonly bindings = new SynchronousUnorderedMap<Identifier, CooperationBinding>();
    private readonly bindingAnchors = new SynchronousUnorderedMap<string, Identifier>();
    private readonly conflicts = new SynchronousUnorderedMap<Identifier, CooperationConflict>();
    private readonly arbitrations = new SynchronousUnorderedMap<Identifier, ArbitrationRecord>();
    private readonly isolationHandles = new Map<string, IsolationHandle>();
    private readonly isolation: CooperationIsolationAdapter;
    private readonly isolationTtlMilliseconds: number;
    private readonly isolationWaitMilliseconds: number;
    private readonly clock: Clock;
    constructor(clock: Clock = () => new Date().toISOString(), options: CooperationCoordinatorOptions = {}) {
        this.clock = clock;
        this.isolation = options.isolation ?? new InMemoryIsolationAdapter({
            clock: () => {
                const parsed = Date.parse(this.clock());
                return Number.isFinite(parsed) ? parsed : Date.now();
            },
            ...(options.syntaxValidator === undefined ? {} : { syntaxValidator: options.syntaxValidator }),
        });
        const ttl = options.isolationTtlMilliseconds ?? DEFAULT_ISOLATION_TTL_MILLISECONDS;
        if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new TypeError("isolation TTL must be a positive safe integer");
        this.isolationTtlMilliseconds = ttl;
        const wait = options.isolationWaitMilliseconds ?? 0;
        if (!Number.isFinite(wait) || wait < 0) throw new TypeError("isolation waitMilliseconds must be a finite number >= 0");
        this.isolationWaitMilliseconds = wait;
    }

    create(input: CreateCooperationInput): Cooperation {
        const id = requireText(input.id, "Cooperation id");
        if (this.cooperations.containsKey(id)) fail(`Duplicate cooperation: ${id}`);
        const protocol = input.protocol;
        if (protocol === null || typeof protocol !== "object" || protocol.sharing === null || typeof protocol.sharing !== "object") fail("Cooperation requires a seven-dimension protocol");
        if (input.goal === null || typeof input.goal !== "object") fail("Cooperation goal must be an object");
        if (!Array.isArray(input.participants)) fail("Cooperation participants must be an array");
        const status = input.status ?? "formed";
        if (!(COOPERATION_INITIAL_STATUSES as readonly string[]).includes(status)) fail(`Invalid initial cooperation status: ${status}`);
        const isolation = input.isolation ?? protocol.sharing.isolation;
        const now = this.clock();
        const cooperation: Cooperation = {
            id,
            name: requireText(input.name, "Cooperation name"),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
            goal: { objective: input.goal.objective, successCriteria: [...(input.goal.successCriteria ?? [])] },
            participants: input.participants.map(participant => ({ ...participant })),
            isolation,
            topology: input.topology,
            protocol: clone(protocol),
            status,
            version: 1,
            taskIds: [],
            messageIds: [],
            createdAt: now,
            updatedAt: now,
        };
        validateCooperation(cooperation);
        this.cooperations.put(id, clone(cooperation));
        return clone(cooperation);
    }

    /**
     * Closes a cooperation and releases every isolation lease it still holds.
     * Already-terminal cooperations are returned unchanged (leases are still released).
     */
    close(cooperationId: Identifier, outcomeOrReason: CooperationCloseOutcome | string = "dissolved", reason?: string): Cooperation {
        const cooperation = this.requireCooperation(cooperationId);
        this.releaseIsolation(cooperationId);
        if (isTerminalCooperationStatus(cooperation.status)) return clone(cooperation);
        const isOutcome = (TERMINAL_CLOSE_OUTCOMES as readonly string[]).includes(outcomeOrReason);
        const outcome: CooperationCloseOutcome = isOutcome ? outcomeOrReason as CooperationCloseOutcome : "dissolved";
        const closeReason = isOutcome ? (reason ?? "") : outcomeOrReason;
        const now = this.clock();
        const updated: Cooperation = { ...cooperation, status: outcome, version: cooperation.version + 1, updatedAt: now, closedAt: now, closeReason };
        this.cooperations.put(updated.id, clone(updated));
        return clone(updated);
    }

    getCooperation(cooperationId: Identifier): Cooperation | undefined {
        const value = this.findCooperation(cooperationId);
        return value.isPresent() ? clone(value.get()) : undefined;
    }
    findCooperation(cooperationId: Identifier): Optional<Cooperation> { return this.cooperations.get(cooperationId).map(clone); }
    listCooperations(): Cooperation[] { return this.cooperations.values().toArray().map(clone); }

    delegate(request: DelegationRequest): DelegatedTask {
        if (!request.taskId || !request.delegatorAgentId || !request.ownerAgentId) throw new TypeError("Delegation requires task and agent IDs");
        if (this.tasks.containsKey(request.taskId)) throw new TypeError(`Task already delegated: ${request.taskId}`);
        const effectiveScope = intersectPermissionScopes(request.parentScope, request.requestedScope);
        const cooperation = this.resolveDelegationCooperation(request);
        this.assertParticipant(cooperation, request.delegatorAgentId);
        this.assertParticipant(cooperation, request.ownerAgentId);
        this.acquireIsolation(cooperation, request.delegatorAgentId, "tasks");
        const now = this.clock();
        const task: DelegatedTask = { taskId: request.taskId, ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}), cooperationId: cooperation.id, delegatorAgentId: request.delegatorAgentId, ownerAgentId: request.ownerAgentId, ownerEpoch: 1, fence: `${request.taskId}:1`, effectiveScope, state: "delegated", createdAt: now, updatedAt: now };
        const updated: Cooperation = { ...cooperation, taskIds: [...cooperation.taskIds, task.taskId], version: cooperation.version + 1, updatedAt: now };
        this.cooperations.put(updated.id, clone(updated));
        this.tasks.put(task.taskId, clone(task));
        return clone(task);
    }
    get(taskId: Identifier): DelegatedTask | undefined { const value = this.find(taskId); return value.isPresent() ? clone(value.get()) : undefined; }
    find(taskId: Identifier): Optional<DelegatedTask> { return this.tasks.get(taskId).map(clone); }
    tasksFor(cooperationId: Identifier): DelegatedTask[] {
        this.requireCooperation(cooperationId);
        return this.tasks.values().toArray().filter(task => task.cooperationId === cooperationId).map(clone);
    }
    start(taskId: Identifier, ownerAgentId: Identifier, ownerEpoch: number, fence: string): DelegatedTask { const task = this.require(taskId); this.assertOwner(task, ownerAgentId, ownerEpoch, fence); if (task.state !== "delegated") throw new TypeError("Only delegated work may start"); return this.update(task, { state: "running" }); }
    cancel(taskId: Identifier, ownerAgentId: Identifier, ownerEpoch: number, fence: string, reason: string): DelegatedTask { const task = this.require(taskId); this.assertOwner(task, ownerAgentId, ownerEpoch, fence); if (["completed", "failed", "cancelled", "unknown_outcome"].includes(task.state)) return clone(task); return this.update(task, { state: "cancel_requested", cancellationReason: reason }); }
    transfer(taskId: Identifier, newOwnerAgentId: string): DelegatedTask { const task = this.require(taskId); if (!["delegated", "running"].includes(task.state)) throw new TypeError("Only delegated or running work may transfer"); const ownerEpoch = task.ownerEpoch + 1; return this.update(task, { ownerAgentId: newOwnerAgentId, ownerEpoch, fence: `${task.taskId}:${ownerEpoch}` }); }
    submitResult(result: ResultSubmission): ResultAcceptance {
        const task = this.get(result.taskId); if (!task) return { accepted: false, reason: "unknown_task" }; if (task.ownerAgentId !== result.ownerAgentId) return { accepted: false, reason: "not_owner", task }; if (task.ownerEpoch !== result.ownerEpoch) return { accepted: false, reason: "stale_epoch", task }; if (task.fence !== result.fence) return { accepted: false, reason: "stale_fence", task }; if (["cancel_requested", "cancelled"].includes(task.state)) return { accepted: false, reason: "cancelled", task }; if (["completed", "failed", "unknown_outcome"].includes(task.state)) return { accepted: false, reason: "already_settled", task };
        const state = result.outcome === "success" ? "completed" : result.outcome === "failure" ? "failed" : "unknown_outcome"; return { accepted: true, reason: "accepted", task: this.update(task, { state }) };
    }

    bindCooperation(input: CooperationBindingInput): CooperationBinding {
        const cooperationId = requireText(input.cooperationId, "Binding cooperationId");
        const cooperation = this.requireCooperation(cooperationId);
        this.assertOpen(cooperation);
        if (this.bindings.containsKey(cooperationId)) fail(`Cooperation already bound: ${cooperationId}`);
        const binding: CooperationBinding = {
            cooperationId,
            sessionId: requireText(input.sessionId, "Binding sessionId"),
            ...(input.missionId === undefined ? {} : { missionId: requireText(input.missionId, "Binding missionId") }),
            ...(input.goalId === undefined ? {} : { goalId: requireText(input.goalId, "Binding goalId") }),
            ...(input.planId === undefined ? {} : { planId: requireText(input.planId, "Binding planId") }),
            ...(input.taskId === undefined ? {} : { taskId: requireText(input.taskId, "Binding taskId") }),
            ...(input.actionId === undefined ? {} : { actionId: requireText(input.actionId, "Binding actionId") }),
            boundAt: this.clock(),
        };
        const anchors = this.anchorsOf(binding);
        for (const anchor of anchors) {
            const key = `${anchor.level}:${anchor.id}`;
            if (this.bindingAnchors.containsKey(key)) fail(`Workflow object already bound: ${key}`);
        }
        this.bindings.put(cooperationId, clone(binding));
        for (const anchor of anchors) this.bindingAnchors.put(`${anchor.level}:${anchor.id}`, cooperationId);
        return clone(binding);
    }
    unbind(cooperationId: Identifier): CooperationBinding {
        const binding = this.requireBinding(cooperationId);
        this.bindings.remove(cooperationId);
        for (const anchor of this.anchorsOf(binding)) this.bindingAnchors.remove(`${anchor.level}:${anchor.id}`);
        return clone(binding);
    }
    getBinding(cooperationId: Identifier): CooperationBinding | undefined { const value = this.findBinding(cooperationId); return value.isPresent() ? clone(value.get()) : undefined; }
    findBinding(cooperationId: Identifier): Optional<CooperationBinding> { return this.bindings.get(cooperationId).map(clone); }
    listBindings(): CooperationBinding[] { return this.bindings.values().toArray().map(clone); }

    reportConflict(input: ConflictReportInput): CooperationConflict {
        const conflictId = requireText(input.conflictId, "Conflict id");
        if (this.conflicts.containsKey(conflictId)) fail(`Duplicate conflict: ${conflictId}`);
        const cooperation = this.requireCooperation(requireText(input.cooperationId, "Conflict cooperationId"));
        this.assertOpen(cooperation);
        if (!CONFLICT_TYPES.includes(input.type)) fail(`Invalid conflict type: ${input.type}`);
        const reportedBy = requireText(input.reportedBy, "Conflict reporter");
        this.assertParticipant(cooperation, reportedBy);
        const parties = requireArray(input.parties, "Conflict parties").map(party => requireText(party, "Conflict party"));
        if (parties.length === 0) fail("Conflict requires at least one party");
        if (new Set(parties).size !== parties.length) fail("Conflict parties must be unique");
        for (const party of parties) this.assertParticipant(cooperation, party);
        if (parties.includes(cooperation.protocol.conflicts.arbiterAgentId)) fail(`Conflict arbiter must not be a conflict party: ${cooperation.protocol.conflicts.arbiterAgentId}`);
        const conflict: CooperationConflict = { conflictId, cooperationId: cooperation.id, type: input.type, parties, description: requireText(input.description, "Conflict description"), reportedBy, reportedAt: this.clock(), status: "open" };
        this.conflicts.put(conflictId, clone(conflict));
        return clone(conflict);
    }
    /** Records the first arbitration decision and freezes the conflict; later decisions are rejected. */
    arbitrate(conflictId: Identifier, decision: ArbitrationDecision): ArbitrationRecord {
        const conflict = this.requireConflict(conflictId);
        if (conflict.status !== "open" || conflict.arbitration !== undefined) fail(`Conflict is frozen after arbitration: ${conflictId}`);
        const cooperation = this.requireCooperation(conflict.cooperationId);
        const arbiter = requireText(decision.arbiter, "Arbitration arbiter");
        if (!cooperation.participants.some(participant => participant.agentId === arbiter)) fail(`Arbitration arbiter is not a cooperation participant: ${arbiter}`);
        if (conflict.parties.includes(arbiter)) fail(`Arbitration arbiter must not be a conflict party: ${arbiter}`);
        if (!ARBITRATION_OUTCOMES.includes(decision.outcome)) fail(`Invalid arbitration outcome: ${decision.outcome}`);
        if (conflict.type === "intent" && decision.outcome !== "escalate_to_human") fail("Intent conflicts must be escalated to a human decision");
        const arbitration: ArbitrationRecord = { arbitrationId: `${conflictId}:arbitration`, conflictId, cooperationId: conflict.cooperationId, arbiter, outcome: decision.outcome, reason: requireText(decision.reason, "Arbitration reason"), decidedAt: this.clock(), frozen: true };
        const updated: CooperationConflict = { ...conflict, status: "arbitrated", arbitration: clone(arbitration) };
        this.arbitrations.put(arbitration.arbitrationId, clone(arbitration));
        this.conflicts.put(conflictId, clone(updated));
        return Object.freeze(clone(arbitration));
    }
    getConflict(conflictId: Identifier): CooperationConflict | undefined { const value = this.findConflict(conflictId); return value.isPresent() ? clone(value.get()) : undefined; }
    findConflict(conflictId: Identifier): Optional<CooperationConflict> { return this.conflicts.get(conflictId).map(clone); }
    listConflicts(cooperationId?: Identifier): CooperationConflict[] { return this.conflicts.values().toArray().filter(conflict => cooperationId === undefined || conflict.cooperationId === cooperationId).map(clone); }
    getArbitration(arbitrationId: Identifier): ArbitrationRecord | undefined { const value = this.arbitrations.get(arbitrationId); return value.isPresent() ? clone(value.get()) : undefined; }
    listArbitrations(cooperationId?: Identifier): ArbitrationRecord[] { return this.arbitrations.values().toArray().filter(arbitration => cooperationId === undefined || arbitration.cooperationId === cooperationId).map(clone); }

    storeMessage(message: CooperationMessage): CooperationMessage {
        if (this.messages.containsKey(message.messageId)) throw new TypeError(`Duplicate message: ${message.messageId}`);
        const task = this.require(message.taskId);
        const cooperation = this.requireCooperation(task.cooperationId);
        this.assertOpen(cooperation);
        if (message.cooperationId !== undefined && message.cooperationId !== cooperation.id) fail(`Message cooperation does not own task: ${message.messageId}`);
        this.acquireIsolation(cooperation, message.senderAgentId, "messages");
        const stored: CooperationMessage = { ...clone(message), cooperationId: cooperation.id };
        const updated: Cooperation = { ...cooperation, messageIds: [...cooperation.messageIds, stored.messageId], version: cooperation.version + 1, updatedAt: message.sentAt || this.clock() };
        this.messages.put(stored.messageId, clone(stored));
        this.cooperations.put(updated.id, clone(updated));
        return clone(stored);
    }
    getMessage(messageId: Identifier): CooperationMessage | undefined { const value = this.findMessage(messageId); return value.isPresent() ? clone(value.get()) : undefined; }
    findMessage(messageId: Identifier): Optional<CooperationMessage> { return this.messages.get(messageId).map(clone); }
    messagesFor(cooperationId: Identifier): CooperationMessage[] {
        this.requireCooperation(cooperationId);
        return this.messages.values().toArray().filter(message => message.cooperationId === cooperationId).map(clone);
    }

    /**
     * Merge point for a cooperation. Conflicting batches return `{ merged: [], conflicts }`;
     * merging never applies a partial result. Semantic/AST merge is delegated to the host.
     */
    merge(cooperationId: Identifier, changes: readonly IsolationChange[]): IsolationMergeResult {
        const cooperation = this.requireCooperation(cooperationId);
        this.assertOpen(cooperation);
        if (!Array.isArray(changes)) fail("Merge changes must be an array");
        for (const change of changes) {
            if (change === null || typeof change !== "object") fail("Merge change must be an object");
            if (change.cooperationId !== cooperation.id) fail(`Merge change does not belong to cooperation: ${String(change.changeId)}`);
        }
        return this.isolation.merge(changes);
    }

    snapshot(): CooperationSnapshot {
        return clone({
            schemaVersion: 1,
            cooperations: this.cooperations.values().toArray(),
            tasks: this.tasks.values().toArray(),
            messages: this.messages.values().toArray(),
            bindings: this.bindings.values().toArray(),
            conflicts: this.conflicts.values().toArray(),
            arbitrations: this.arbitrations.values().toArray(),
        });
    }
    /** Pure restore: validates all references, reads no clock and dispatches no work. */
    static restore(snapshot: CooperationSnapshot, clock: Clock = () => new Date().toISOString(), options: CooperationCoordinatorOptions = {}): CooperationCoordinator {
        const coordinator = new CooperationCoordinator(clock, options);
        try {
            if (snapshot === null || typeof snapshot !== "object") fail("snapshot must be an object");
            coordinator.loadSnapshot(clone(snapshot));
        } catch (error) {
            fail(`Invalid cooperation snapshot: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        return coordinator;
    }

    private resolveDelegationCooperation(request: DelegationRequest): Cooperation {
        if (request.cooperationId !== undefined) {
            const cooperation = this.requireCooperation(request.cooperationId);
            this.assertOpen(cooperation);
            return cooperation;
        }
        const baseId = `implicit:${request.delegatorAgentId}:${request.ownerAgentId}`;
        const existing = this.cooperations.get(baseId);
        if (existing.isPresent()) {
            const cooperation = existing.get();
            if (!isTerminalCooperationStatus(cooperation.status)) return cooperation;
            return this.createImplicitCooperation(request, `${baseId}:${request.taskId}`);
        }
        return this.createImplicitCooperation(request, baseId);
    }
    private createImplicitCooperation(request: DelegationRequest, cooperationId: string): Cooperation {
        if (request.delegatorAgentId === request.ownerAgentId) fail("Implicit self-delegation requires an explicit cooperation");
        const coordinatorRole: CooperationRoleAssignment = { agentId: request.delegatorAgentId, role: "coordinator", responsibilities: ["delegate tasks", "arbitrate conflicts"] };
        const workerRole: CooperationRoleAssignment = { agentId: request.ownerAgentId, role: "worker", responsibilities: ["execute delegated tasks", "submit results"] };
        return this.create({
            id: cooperationId,
            name: `Implicit cooperation ${cooperationId}`,
            goal: { objective: `Delegated work from ${request.delegatorAgentId} to ${request.ownerAgentId}`, successCriteria: ["Delegated result is accepted"] },
            participants: [{ agentId: request.delegatorAgentId }, { agentId: request.ownerAgentId }],
            isolation: "isolated",
            topology: "star",
            status: "active",
            protocol: {
                goal: { alignment: "single", revisionPolicy: "coordinator" },
                roles: { assignments: [coordinatorRole, workerRole], requireDistinctArbiter: true },
                messages: { format: "json", channel: `implicit:${cooperationId}`, timeoutMs: 30000, retries: 0, ordering: "fifo", idempotent: true },
                timing: { sequencing: "sequential", maxParallelism: 1 },
                conflicts: { arbiterAgentId: request.delegatorAgentId, escalation: ["protocol", "cooperation", "human"], requireReason: true },
                sharing: { isolation: "isolated", mergeStrategy: "owner" },
                convergence: { strategy: "owner_decision", partialCompletion: "report" },
            },
        });
    }
    private requireCooperation(cooperationId: Identifier): Cooperation {
        if (typeof cooperationId !== "string" || cooperationId.length === 0) fail("Cooperation id must be a nonempty string");
        const cooperation = this.getCooperation(cooperationId);
        if (cooperation === undefined) return fail(`Unknown cooperation: ${cooperationId}`);
        return cooperation;
    }
    private requireBinding(cooperationId: Identifier): CooperationBinding {
        const binding = this.getBinding(cooperationId);
        if (binding === undefined) return fail(`Cooperation is not bound: ${cooperationId}`);
        return binding;
    }
    private requireConflict(conflictId: Identifier): CooperationConflict {
        const conflict = this.getConflict(conflictId);
        if (conflict === undefined) return fail(`Unknown conflict: ${conflictId}`);
        return conflict;
    }
    private assertOpen(cooperation: Cooperation): void {
        if (isTerminalCooperationStatus(cooperation.status)) fail(`Cooperation is closed: ${cooperation.id}`);
    }
    private assertParticipant(cooperation: Cooperation, agentId: string): void {
        if (!cooperation.participants.some(participant => participant.agentId === agentId)) fail(`Agent is not a cooperation participant: ${agentId}`);
    }
    private anchorsOf(binding: CooperationBinding): readonly { readonly level: CooperationBindingLevel; readonly id: Identifier }[] {
        const anchors: { level: CooperationBindingLevel; id: Identifier }[] = [];
        if (binding.missionId !== undefined) anchors.push({ level: "mission", id: binding.missionId });
        if (binding.goalId !== undefined) anchors.push({ level: "goal", id: binding.goalId });
        if (binding.planId !== undefined) anchors.push({ level: "plan", id: binding.planId });
        if (binding.taskId !== undefined) anchors.push({ level: "task", id: binding.taskId });
        if (binding.actionId !== undefined) anchors.push({ level: "action", id: binding.actionId });
        return anchors;
    }
    /**
     * Under `shared_write_with_lock`, each participant's task/message stream is guarded by
     * its own exclusive lease. Reusing a live lease keeps synchronous writes cheap; an
     * expired lease is dropped and re-acquired. Other isolation modes never acquire.
     */
    private acquireIsolation(cooperation: Cooperation, agentId: Identifier, stream: "tasks" | "messages"): void {
        if (cooperation.isolation !== "shared_write_with_lock") return;
        const key = `${cooperation.id}\u0000${agentId}\u0000${stream}`;
        const existing = this.isolationHandles.get(key);
        if (existing !== undefined) {
            if (Date.parse(existing.expiresAt) > Date.parse(this.clock())) return;
            this.isolationHandles.delete(key);
            try { this.isolation.release(existing); } catch { /* lease also expires through its TTL */ }
        }
        const resource: IsolationResource = {
            cooperationId: cooperation.id,
            agentId,
            resourceId: `${stream}:${cooperation.id}:${agentId}`,
            ...(cooperation.protocol.sharing.lockScope === undefined ? {} : { lockScope: cooperation.protocol.sharing.lockScope }),
        };
        let handle: IsolationHandle;
        try {
            handle = this.isolation.acquire(
                resource,
                "exclusive",
                this.isolationTtlMilliseconds,
                this.isolationWaitMilliseconds > 0 ? { waitMilliseconds: this.isolationWaitMilliseconds } : undefined,
            );
        } catch (error) {
            if (error instanceof IsolationConflictError) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new IsolationConflictError(resource, `could not acquire ${resource.resourceId}: ${detail}`, undefined, error);
        }
        this.isolationHandles.set(key, handle);
    }
    /** Releases every lease held by one cooperation; release errors are non-fatal because leases expire by TTL. */
    private releaseIsolation(cooperationId: Identifier): void {
        for (const [key, handle] of [...this.isolationHandles.entries()]) {
            if (handle.resource.cooperationId !== cooperationId) continue;
            this.isolationHandles.delete(key);
            try { this.isolation.release(handle); } catch { /* TTL is the fallback */ }
        }
    }
    private require(taskId: Identifier): DelegatedTask { const task = this.get(taskId); if (!task) throw new TypeError(`Unknown delegated task: ${taskId}`); return task; }
    private assertOwner(task: DelegatedTask, ownerAgentId: string, ownerEpoch: number, fence: string): void { if (task.ownerAgentId !== ownerAgentId || task.ownerEpoch !== ownerEpoch || task.fence !== fence) throw new TypeError("Stale delegation owner or fence"); }
    private update(task: DelegatedTask, patch: Partial<DelegatedTask>): DelegatedTask { const updated = { ...task, ...patch, updatedAt: this.clock() }; this.tasks.put(task.taskId, clone(updated)); return clone(updated); }

    private requireSnapshotArray<T>(value: readonly T[], field: string): readonly T[] {
        return Array.isArray(value) ? value : fail(`snapshot.${field} must be an array`);
    }
    private loadSnapshot(snapshot: CooperationSnapshot): void {
        if (snapshot.schemaVersion !== 1) fail("Unsupported cooperation snapshot schema version");
        const cooperations = this.requireSnapshotArray(snapshot.cooperations, "cooperations");
        const tasks = this.requireSnapshotArray(snapshot.tasks, "tasks");
        const messages = this.requireSnapshotArray(snapshot.messages, "messages");
        const bindings = this.requireSnapshotArray(snapshot.bindings, "bindings");
        const conflicts = this.requireSnapshotArray(snapshot.conflicts, "conflicts");
        const arbitrations = this.requireSnapshotArray(snapshot.arbitrations, "arbitrations");
        for (const cooperation of cooperations) {
            if (this.cooperations.containsKey(cooperation.id)) fail(`Duplicate cooperation in snapshot: ${cooperation.id}`);
            validateCooperation(cooperation);
            this.cooperations.put(cooperation.id, clone(cooperation));
        }
        for (const task of tasks) {
            if (this.tasks.containsKey(task.taskId)) fail(`Duplicate delegated task in snapshot: ${task.taskId}`);
            if (!this.cooperations.containsKey(task.cooperationId)) fail(`Snapshot task references unknown cooperation: ${task.taskId}`);
            this.tasks.put(task.taskId, clone(task));
        }
        for (const message of messages) {
            if (this.messages.containsKey(message.messageId)) fail(`Duplicate message in snapshot: ${message.messageId}`);
            const task = this.tasks.get(message.taskId);
            if (task.isEmpty()) fail(`Snapshot message references unknown task: ${message.messageId}`);
            if (message.cooperationId !== task.get().cooperationId) fail(`Snapshot message cooperation mismatch: ${message.messageId}`);
            this.messages.put(message.messageId, clone(message));
        }
        for (const binding of bindings) {
            if (this.bindings.containsKey(binding.cooperationId)) fail(`Duplicate cooperation binding in snapshot: ${binding.cooperationId}`);
            if (!this.cooperations.containsKey(binding.cooperationId)) fail(`Snapshot binding references unknown cooperation: ${binding.cooperationId}`);
            requireText(binding.sessionId, "Snapshot binding sessionId");
            for (const anchor of this.anchorsOf(binding)) {
                requireText(anchor.id, `Snapshot binding ${anchor.level}Id`);
                const key = `${anchor.level}:${anchor.id}`;
                if (this.bindingAnchors.containsKey(key)) fail(`Duplicate workflow binding in snapshot: ${key}`);
                this.bindingAnchors.put(key, binding.cooperationId);
            }
            this.bindings.put(binding.cooperationId, clone(binding));
        }
        for (const conflict of conflicts) {
            if (this.conflicts.containsKey(conflict.conflictId)) fail(`Duplicate conflict in snapshot: ${conflict.conflictId}`);
            if (!this.cooperations.containsKey(conflict.cooperationId)) fail(`Snapshot conflict references unknown cooperation: ${conflict.conflictId}`);
            if ((conflict.status === "arbitrated") !== (conflict.arbitration !== undefined)) fail(`Snapshot conflict arbitration is inconsistent: ${conflict.conflictId}`);
            this.conflicts.put(conflict.conflictId, clone(conflict));
        }
        for (const arbitration of arbitrations) {
            if (this.arbitrations.containsKey(arbitration.arbitrationId)) fail(`Duplicate arbitration in snapshot: ${arbitration.arbitrationId}`);
            requireText(arbitration.arbiter, "Snapshot arbitration arbiter");
            requireText(arbitration.reason, "Snapshot arbitration reason");
            if (arbitration.frozen !== true) fail(`Snapshot arbitration must be frozen: ${arbitration.arbitrationId}`);
            const conflict = this.conflicts.get(arbitration.conflictId);
            if (conflict.isEmpty()) fail(`Snapshot arbitration references unknown conflict: ${arbitration.arbitrationId}`);
            if (conflict.get().arbitration?.arbitrationId !== arbitration.arbitrationId) fail(`Snapshot arbitration does not match its conflict: ${arbitration.arbitrationId}`);
            this.arbitrations.put(arbitration.arbitrationId, clone(arbitration));
        }
        for (const conflict of this.conflicts.values().toArray()) {
            if (conflict.status === "arbitrated" && !this.arbitrations.containsKey(conflict.arbitration?.arbitrationId ?? "")) fail(`Snapshot arbitrated conflict is missing its arbitration: ${conflict.conflictId}`);
        }
        for (const cooperation of this.cooperations.values().toArray()) {
            const taskIds = this.tasks.values().toArray().filter(task => task.cooperationId === cooperation.id).map(task => task.taskId).sort();
            const declaredTaskIds = [...cooperation.taskIds].sort();
            if (safeStringify(taskIds) !== safeStringify(declaredTaskIds)) fail(`Snapshot cooperation taskIds are stale: ${cooperation.id}`);
            const messageIds = this.messages.values().toArray().filter(message => message.cooperationId === cooperation.id).map(message => message.messageId).sort();
            const declaredMessageIds = [...cooperation.messageIds].sort();
            if (safeStringify(messageIds) !== safeStringify(declaredMessageIds)) fail(`Snapshot cooperation messageIds are stale: ${cooperation.id}`);
        }
    }
}
