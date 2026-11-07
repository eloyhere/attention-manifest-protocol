/**
 * Executable kernel: composes the single-writer workflow store, the eight
 * domain services, SQLite persistence, budget accounting, attention/context
 * compilation and the receipt -> verification -> evidence chain into one
 * Session -> Turn -> Intent -> Mission -> Goal -> Plan -> Task -> Action loop.
 *
 * The kernel never re-implements a domain rule. Each flow step delegates to the
 * owning service and mirrors the resulting aggregate plus its exact workflow
 * audit event into `Store` inside the same synchronous transaction.
 */

import { DefaultPolicyEnforcementPoint, PolicyDeniedError } from "../policy/pep.ts";
import { SessionService } from "../session/service.ts";
import { TurnService } from "../turn/service.ts";
import { IntentService } from "../intent/service.ts";
import { MissionService } from "../mission/service.ts";
import { GoalService } from "../goal/service.ts";
import { PlanService } from "../plan/service.ts";
import { TaskService } from "../task/service.ts";
import { ActionService } from "../action/service.ts";
import { WorkflowError } from "../workflow/types.ts";
import type {
    Acceptance,
    Action,
    ActionAttempt,
    TransitionOptions,
    WorkflowEntity,
    WorkflowEvent,
    WorkflowKind,
} from "../workflow/types.ts";
import {
    isPlanExecutingState,
    isTaskActiveState,
    isTaskCompletedState,
    isWorkflowSettled,
    isWorkflowTerminal,
    workflowTransitions,
} from "../workflow/transitions.ts";
import { BudgetError, BudgetLedger } from "../budget/ledger.ts";
import { EvidenceLedger } from "../evidence/ledger.ts";
import * as attentionOperations from "../attention/operations.ts";
import * as contextCompiler from "../context/compiler.ts";
import * as receiptCore from "../receipt/core.ts";
import * as verificationCore from "../verification/core.ts";
import { Project } from "../project/core.ts";
import { Workspace } from "../workspace/core.ts";
import { InMemoryFileStorage } from "../file/core.ts";
import { Store } from "../service/store.ts";
import { isEntityKind } from "../entity/key.ts";
import type { Budget, ExecutionContext, Identifier, JsonValue } from "../shared.ts";
import type { BudgetReservation } from "../tool/types.ts";
import type { Evidence, EvidenceSource } from "../evidence/types.ts";
import type {
    ExecutorProfile,
    Observation,
    ReceiptCore,
    ReceiptIntegrityVerification,
    ReceiptKind,
    WorkspaceAnchor,
} from "../receipt/types.ts";
import type { BusinessVerification, SemanticEvaluator } from "../verification/types.ts";
import type { AttentionObject, AttentionPointer } from "../attention/types.ts";
import type { ContextExclusion } from "../context/types.ts";
import type { Goal } from "../goal/types.ts";
import type { Intent } from "../intent/types.ts";
import type { Mission } from "../mission/types.ts";
import type { Plan } from "../plan/types.ts";
import type { Session } from "../session/types.ts";
import type { Task } from "../task/types.ts";
import type { Turn } from "../turn/types.ts";
import { KernelPersistence, sha256, stableJson, WORKFLOW_KINDS } from "./persistence.ts";
import type { BudgetLedgerRecord } from "./persistence.ts";
import {
    KernelError,
} from "./types.ts";
import type {
    AchieveGoalInput,
    AchieveGoalResult,
    BeginTurnInput,
    CaptureIntentInput,
    CloseSessionInput,
    CloseSessionResult,
    CompileTurnContextInput,
    CompileTurnContextResult,
    ConfirmIntentInput,
    ContextCheckpointRecord,
    CreateGoalInput,
    CreateMissionInput,
    CreatePlanInput,
    CreatePlanResult,
    Kernel,
    KernelExecutionRequest,
    KernelExecutorPort,
    KernelFlow,
    KernelObservationInput,
    KernelOptions,
    KernelOverrides,
    KernelPorts,
    KernelServices,
    KernelSnapshot,
    KernelTaskInput,
    ReadyTasksInput,
    ReadyTasksResult,
    RecordEvidenceInput,
    RecordReceiptInput,
    SettleActionInput,
    SettleActionResult,
    StartActionInput,
    StartActionResult,
    StartSessionInput,
    VerifyBusinessInput,
    VerifyBusinessResult,
} from "./types.ts";

type CancellableKind = "mission" | "goal" | "plan" | "task" | "action";

const TRANSITION_PREFIX = "transition.";
const EVENT_KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
    "attempt.started": "attempt.started",
    "attempt.settled": "attempt.settled",
    "attempt.reconciled": "attempt.reconciled",
    "cancel.requested": "cancel_requested",
    "cancel.fenced": "cancel_fenced",
    "goal.invalidated": "invalidated",
    "goal.correction_attached": "correction_attached",
    "goal.revalidated": "revalidated",
});

function eventName(event: WorkflowEvent): string {
    const label = EVENT_KIND_LABEL[event.eventType]
        ?? (event.eventType.startsWith(TRANSITION_PREFIX) ? event.eventType.slice(TRANSITION_PREFIX.length) : event.eventType);
    return `${event.entityKind}.${label}`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function translate(error: unknown): KernelError {
    if (error instanceof KernelError) return error;
    if (error instanceof WorkflowError) return new KernelError(error.code, error.message, error);
    if (error instanceof BudgetError) return new KernelError(error.code, error.message, error);
    if (error instanceof PolicyDeniedError) return new KernelError("policy_denied", error.message, error);
    if (error instanceof Error) return new KernelError("invalid_input", error.message, error);
    return new KernelError("invalid_input", String(error));
}

function isWorkflowKind(value: string): value is WorkflowKind {
    return (WORKFLOW_KINDS as readonly string[]).includes(value);
}

interface ReceiptCreation {
    readonly action: Action;
    readonly attempt: ActionAttempt;
    readonly observation: KernelObservationInput;
    readonly receiptId?: Identifier;
    readonly kind?: ReceiptKind;
    readonly parentId?: Identifier;
    readonly workspaceAnchor?: WorkspaceAnchor;
    readonly executor?: ExecutorProfile;
    readonly toolId?: Identifier;
    readonly toolInput?: JsonValue;
    readonly idempotencyKey?: string;
    readonly principalId?: Identifier;
    readonly agentId?: Identifier;
    readonly policyVersion?: string;
}

interface VerificationRequest {
    readonly criteriaVersion: string;
    readonly verifier?: Identifier;
    readonly claims?: readonly string[];
    readonly evaluate?: SemanticEvaluator;
    readonly verificationId?: Identifier;
}

class KernelImpl implements Kernel {
    readonly store: Store;
    readonly ports!: KernelPorts;
    readonly flow!: KernelFlow;
    private readonly tenantId: Identifier;
    private readonly rootId: Identifier;
    private readonly clock: () => string;
    private readonly now: () => string;
    private readonly persistence!: KernelPersistence;
    private readonly budgetKey: string;
    private readonly evaluate: SemanticEvaluator;
    private readonly reservationIds = new Set<string>();
    private readonly receiptCache = new Map<string, ReceiptCore>();
    private readonly verificationCache = new Map<string, BusinessVerification>();
    private readonly integrityCache = new Map<string, ReceiptIntegrityVerification>();
    private readonly evidenceCache = new Map<string, Evidence>();
    private budgetVersion = 0;
    private closed = false;

    constructor(options: KernelOptions, overrides: KernelOverrides) {
        if (typeof options.tenantId !== "string" || options.tenantId.trim() === ""
            || typeof options.rootId !== "string" || options.rootId.trim() === "") {
            throw new KernelError("invalid_input", "kernel requires non-empty tenantId and rootId");
        }
        this.tenantId = options.tenantId;
        this.rootId = options.rootId;
        this.clock = options.clock ?? options.now ?? (() => new Date().toISOString());
        this.now = options.now ?? this.clock;
        this.budgetKey = `${this.tenantId}:${this.rootId}`;
        this.evaluate = overrides.evaluate ?? (observation => observation.status === "success");
        this.store = Store.open({
            ...(options.storePath === undefined ? {} : { path: options.storePath }),
            now: this.now,
        });
        try {
            this.persistence = new KernelPersistence(this.store, this.tenantId, this.clock);
            const workflow = this.persistence.restoreWorkflow(this.clock);
            const services: KernelServices = {
                session: new SessionService(workflow),
                turn: new TurnService(workflow),
                intent: new IntentService(workflow),
                mission: new MissionService(workflow),
                goal: new GoalService(workflow),
                plan: new PlanService(workflow),
                task: new TaskService(workflow),
                action: new ActionService(workflow),
            };
            const budget = new BudgetLedger();
            this.restoreBudget(budget, options.budgetLimits);
            const project = overrides.project ?? new Project({ tenantId: this.tenantId, rootId: this.rootId, clock: this.clock });
            const workspace = overrides.workspace ?? new Workspace({
                tenantId: this.tenantId,
                rootId: this.rootId,
                storage: new InMemoryFileStorage(this.clock),
                clock: this.clock,
            });
            const policy = overrides.policy ?? new DefaultPolicyEnforcementPoint(request => ({
                allowed: true,
                policyVersion: request.context.policyVersion,
                reason: "kernel_default_allow",
            }));
            this.ports = {
                workflow,
                services,
                attention: overrides.attention ?? attentionOperations,
                context: overrides.context ?? contextCompiler,
                budget,
                policy,
                executor: overrides.executor,
                evidence: new EvidenceLedger(),
                receipt: overrides.receipt ?? receiptCore,
                verification: overrides.verification ?? verificationCore,
                project,
                workspace,
                store: this.store,
            };
            this.flow = {
                startSession: input => this.guard(() => this.startSession(input)),
                beginTurn: input => this.guard(() => this.beginTurn(input)),
                captureIntent: input => this.guard(() => this.captureIntent(input)),
                confirmIntent: input => this.guard(() => this.confirmIntent(input)),
                createMission: input => this.guard(() => this.createMission(input)),
                createGoal: input => this.guard(() => this.createGoal(input)),
                createPlan: input => this.guard(() => this.createPlan(input)),
                readyTasks: input => this.guard(() => this.readyTasks(input)),
                startAction: input => this.guardAsync(() => this.startAction(input)),
                settleAction: input => this.guardAsync(() => this.settleAction(input)),
                compileTurnContext: input => this.guard(() => this.compileTurnContext(input)),
                recordReceipt: input => this.guard(() => this.recordReceipt(input)),
                recordEvidence: input => this.guardAsync(() => this.recordEvidence(input)),
                verifyBusiness: input => this.guardAsync(() => this.verifyBusiness(input)),
                achieveGoal: input => this.guard(() => this.achieveGoal(input)),
                closeSession: input => this.guard(() => this.closeSession(input)),
            };
        } catch (error) {
            this.store.close();
            throw error;
        }
    }

    snapshot(): KernelSnapshot {
        return this.guard(() => {
            const workflow = this.ports.workflow.snapshot();
            const counts: Record<WorkflowKind, number> = { session: 0, turn: 0, intent: 0, mission: 0, goal: 0, plan: 0, task: 0, action: 0 };
            for (const entity of workflow.entities) counts[entity.kind] += 1;
            return {
                tenantId: this.tenantId,
                rootId: this.rootId,
                entities: workflow.entities,
                counts,
                budget: this.ports.budget.snapshot(this.budgetKey),
                evidenceCount: this.persistence.list<Evidence>("evidence").length,
                receiptCount: this.persistence.list<ReceiptCore>("receipt").length,
                verificationCount: this.persistence.list<BusinessVerification>("verification").length,
                workflowEvents: workflow.sequence,
                store: this.store.stats(),
            };
        });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.store.close();
    }

    /* -------------------------------------------------------------- */
    /* Boundaries                                                     */
    /* -------------------------------------------------------------- */

    private assertOpen(): void {
        if (this.closed) throw new KernelError("kernel_closed", "kernel is closed");
    }

    private guard<T>(work: () => T): T {
        this.assertOpen();
        try {
            return work();
        } catch (error) {
            throw translate(error);
        }
    }

    private async guardAsync<T>(work: () => Promise<T>): Promise<T> {
        this.assertOpen();
        try {
            return await work();
        } catch (error) {
            throw translate(error);
        }
    }

    private actorOf(input: { readonly actor?: Identifier }): Identifier {
        const actor = input.actor;
        return typeof actor === "string" && actor.trim().length > 0 ? actor : "kernel";
    }

    /* -------------------------------------------------------------- */
    /* Persistence helpers                                            */
    /* -------------------------------------------------------------- */

    private restoreBudget(ledger: BudgetLedger, limits: Budget | undefined): void {
        const record = this.persistence.budgetRecord(this.budgetKey);
        if (record === undefined) {
            ledger.configure(this.budgetKey, limits ?? {});
            return;
        }
        try {
            ledger.configure(this.budgetKey, record.limit ?? limits ?? {});
            this.budgetVersion = Number.isSafeInteger(record.version) && record.version >= 0 ? record.version : 0;
            for (const reservation of record.reservations ?? []) {
                if (reservation.state === "released") {
                    ledger.reserve(reservation.id, this.budgetKey, reservation.amount);
                    ledger.release(reservation.id);
                } else if (reservation.state === "settled") {
                    ledger.reserve(reservation.id, this.budgetKey, reservation.amount);
                    ledger.settle(reservation.id, reservation.actual ?? reservation.amount);
                } else {
                    ledger.reserve(reservation.id, this.budgetKey, reservation.amount);
                }
                this.reservationIds.add(reservation.id);
            }
        } catch (error) {
            throw new KernelError("invalid_state", "persisted budget ledger cannot be restored", error);
        }
    }

    private capture<T>(work: () => T): { readonly value: T; readonly events: readonly WorkflowEvent[] } {
        const before = this.ports.workflow.history().length;
        const value = work();
        const events = this.ports.workflow.history().slice(before);
        return { value, events };
    }

    /**
     * Persists every aggregate touched by the emitted workflow events and appends
     * one store event per workflow audit event in the same transaction.
     */
    private persist(events: readonly WorkflowEvent[], attempts: readonly ActionAttempt[] = []): void {
        if (events.length === 0) throw new KernelError("invalid_state", "domain transition produced no audit event");
        const entities = new Map<string, WorkflowEntity>();
        for (const event of events) {
            const key = `${event.entityKind}:${event.entityId}`;
            if (!entities.has(key)) entities.set(key, this.ports.workflow.get(event.entityKind, event.entityId));
        }
        this.store.transaction(() => {
            for (const entity of entities.values()) this.persistence.saveWorkflow(entity);
            for (const event of events) {
                const attempt = attempts.find(candidate => candidate.actionId === event.entityId
                    && event.entityKind === "action"
                    && event.eventType.startsWith("attempt."));
                this.persistence.append(eventName(event), event.entityId, {
                    entityKind: event.entityKind,
                    entityId: event.entityId,
                    state: event.to,
                    version: event.version,
                    workflow: event,
                    ...(attempt === undefined ? {} : { attempt }),
                });
            }
        });
    }

    private applyEntity<T extends WorkflowEntity>(work: () => T): T {
        const { value, events } = this.capture(work);
        this.persist(events);
        return value;
    }

    private applyAttempt(work: () => ActionAttempt): ActionAttempt {
        const { value, events } = this.capture(work);
        this.persist(events, [value]);
        return value;
    }

    private persistBudget(event: "budget.reserved" | "budget.released" | "budget.settled", detail: Readonly<Record<string, unknown>>): void {
        const snapshot = this.ports.budget.snapshot(this.budgetKey);
        const reservations = [...this.reservationIds]
            .map(id => this.ports.budget.getReservation(id))
            .filter((reservation): reservation is BudgetReservation => reservation !== undefined);
        const version = this.budgetVersion + 1;
        const record: BudgetLedgerRecord = {
            budgetKey: this.budgetKey,
            tenantId: this.tenantId,
            version,
            updatedAt: this.now(),
            limit: snapshot.limit,
            settled: snapshot.settled,
            reserved: snapshot.reserved,
            reservations,
        };
        this.store.transaction(() => {
            this.persistence.saveEntity("budget_ledger", record, version);
            this.persistence.append(event, this.budgetKey, {
                entityKind: "budget_ledger",
                entityId: this.budgetKey,
                version,
                data: { ...detail, snapshot },
            });
        });
        this.budgetVersion = version;
    }

    /* -------------------------------------------------------------- */
    /* Budget port helpers                                            */
    /* -------------------------------------------------------------- */

    private reserveBudget(operationId: Identifier, amount: Budget): BudgetReservation {
        const existing = this.ports.budget.getReservation(operationId);
        if (existing !== undefined) {
            if (existing.state !== "reserved") {
                throw new KernelError("idempotency_conflict", `budget reservation ${operationId} is already ${existing.state}; use a new operationId`);
            }
            this.reservationIds.add(existing.id);
            return existing;
        }
        const reservation = this.ports.budget.reserve(operationId, this.budgetKey, amount);
        this.reservationIds.add(reservation.id);
        this.persistBudget("budget.reserved", { reservationId: reservation.id, operationId, amount: reservation.amount });
        return reservation;
    }

    private releaseBudget(operationId: Identifier): void {
        const reservation = this.ports.budget.getReservation(operationId);
        if (reservation === undefined || reservation.state !== "reserved") return;
        this.ports.budget.release(operationId);
        this.persistBudget("budget.released", { reservationId: operationId });
    }

    private settleBudget(operationId: Identifier, usage: Budget | undefined): BudgetReservation {
        const reservation = this.ports.budget.getReservation(operationId);
        if (reservation === undefined) {
            throw new KernelError("invalid_state", `operation ${operationId} has no budget reservation`);
        }
        if (reservation.state === "settled") return reservation;
        if (reservation.state !== "reserved") {
            throw new KernelError("invalid_state", `budget reservation ${operationId} is ${reservation.state}`);
        }
        const settled = this.ports.budget.settle(operationId, usage ?? reservation.amount);
        this.persistBudget("budget.settled", { reservationId: operationId, actual: settled.actual });
        return settled;
    }

    private requiredReservation(operationId: Identifier): BudgetReservation {
        const reservation = this.ports.budget.getReservation(operationId);
        if (reservation === undefined) {
            throw new KernelError("invalid_state", `operation ${operationId} has no budget reservation`);
        }
        return reservation;
    }

    /* -------------------------------------------------------------- */
    /* Execution context and observations                             */
    /* -------------------------------------------------------------- */

    private executionContext(fields: {
        readonly sessionId: Identifier;
        readonly originTurnId?: Identifier;
        readonly observedInTurnId?: Identifier;
        readonly missionId?: Identifier;
        readonly taskId?: Identifier;
        readonly actionId?: Identifier;
        readonly operationId: Identifier;
        readonly attemptId: Identifier;
        readonly executionId: Identifier;
        readonly cancellationEpoch: number;
        readonly principalId?: Identifier;
        readonly agentId?: Identifier;
        readonly policyVersion?: string;
    }): ExecutionContext {
        return {
            tenantId: this.tenantId,
            principalId: fields.principalId ?? this.tenantId,
            agentId: fields.agentId ?? "kernel",
            sessionId: fields.sessionId,
            ...(fields.originTurnId === undefined ? {} : { originTurnId: fields.originTurnId }),
            ...(fields.observedInTurnId === undefined ? {} : { observedInTurnId: fields.observedInTurnId }),
            ...(fields.missionId === undefined ? {} : { missionId: fields.missionId }),
            ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
            ...(fields.actionId === undefined ? {} : { actionId: fields.actionId }),
            operationId: fields.operationId,
            attemptId: fields.attemptId,
            executionId: fields.executionId,
            policyVersion: fields.policyVersion ?? "kernel/1",
            cancellationEpoch: fields.cancellationEpoch,
        };
    }

    private missionOfTask(task: Task): Identifier | undefined {
        const plan = this.ports.workflow.find("plan", task.planId);
        if (plan.isEmpty()) return undefined;
        const goal = this.ports.workflow.find("goal", plan.get().goalId);
        return goal.isPresent() ? goal.get().missionId : undefined;
    }

    private buildObservation(input: KernelObservationInput, invocationId: Identifier): Observation {
        const error = input.status === "failure" ? (input.error ?? "execution_failed") : undefined;
        return this.ports.receipt.createObservation({
            id: input.id ?? `${invocationId}:observation`,
            invocationId,
            status: input.status,
            ...(input.value === undefined ? {} : { value: input.value }),
            ...(error === undefined ? {} : { error }),
            observedAt: input.observedAt ?? this.clock(),
            ...(input.digest === undefined ? {} : { digest: input.digest }),
            ...(input.externalEffectId === undefined ? {} : { externalEffectId: input.externalEffectId }),
            ...(input.artifactVersions === undefined ? {} : { artifactVersions: input.artifactVersions }),
        });
    }

    private receiptDigest(invocation: ReceiptCore["invocation"], observation: Observation): string {
        return sha256(stableJson({ invocation, observation }));
    }

    /* -------------------------------------------------------------- */
    /* Session / Turn / Intent / Mission / Goal / Plan / Task          */
    /* -------------------------------------------------------------- */

    private resolveSessionId(explicit?: Identifier): Identifier {
        if (explicit !== undefined) {
            this.ports.workflow.get("session", explicit);
            return explicit;
        }
        const sessions = this.ports.workflow.list("session").filter(session => session.state === "active" || session.state === "idle");
        const latest = sessions[sessions.length - 1];
        if (latest === undefined) throw new KernelError("invalid_input", "no active or idle session; start a session first");
        return latest.id;
    }

    private startSession(input: StartSessionInput): Session {
        const existing = this.ports.workflow.find("session", input.sessionId);
        if (existing.isPresent()) return existing.get();
        const actor = this.actorOf(input);
        const created = this.applyEntity(() => this.ports.services.session.create({
            id: input.sessionId,
            sessionId: input.sessionId,
            participants: [...(input.participants ?? [])],
            ...(input.sessionType === undefined ? {} : { sessionType: input.sessionType }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        }, actor));
        if (input.activate === false) return created;
        return this.applyEntity(() => this.ports.services.session.activate(created.id, {
            expectedVersion: created.version,
            actor,
        }));
    }

    private beginTurn(input: BeginTurnInput): Turn {
        const existing = this.ports.workflow.find("turn", input.turnId);
        if (existing.isPresent()) return existing.get();
        const actor = this.actorOf(input);
        const sessionId = this.resolveSessionId(input.sessionId);
        const turn = this.applyEntity(() => this.ports.services.turn.create({
            id: input.turnId,
            sessionId,
            classification: input.classification ?? "new_intent",
        }, actor));
        if (input.interpret === false) return turn;
        return this.applyEntity(() => this.ports.services.turn.interpret(turn.id, {
            expectedVersion: turn.version,
            actor,
        }));
    }

    private captureIntent(input: CaptureIntentInput): Intent {
        const existing = this.ports.workflow.find("intent", input.intentId);
        if (existing.isPresent()) return existing.get();
        const actor = this.actorOf(input);
        const turn = this.ports.workflow.get("turn", input.turnId);
        return this.applyEntity(() => this.ports.services.intent.create({
            id: input.intentId,
            sessionId: turn.sessionId,
            originTurnId: turn.id,
            text: input.text,
        }, actor));
    }

    private confirmIntent(input: ConfirmIntentInput): Intent {
        let intent = this.ports.workflow.get("intent", input.intentId);
        if (input.expectedVersion !== undefined && intent.version !== input.expectedVersion) {
            throw new KernelError("version_conflict", `intent ${intent.id} expected version ${input.expectedVersion}, current ${intent.version}`);
        }
        const actor = this.actorOf(input);
        const settled = ["accepted", "fulfilled", "delegated", "deferred", "rejected", "withdrawn", "abandoned", "superseded"];
        if (settled.includes(intent.state)) return intent;
        if (intent.state === "deferred") {
            intent = this.applyEntity(() => this.ports.services.intent.resume(intent.id, { expectedVersion: intent.version, actor }));
        }
        // `interpreted` has no direct confirm edge: go through clarifying -> clarified.
        if (intent.state === "interpreted") {
            intent = this.applyEntity(() => this.ports.services.intent.clarify(intent.id, { expectedVersion: intent.version, actor }));
        }
        if (intent.state === "clarifying") {
            intent = this.applyEntity(() => this.ports.services.intent.resolveClarification(intent.id, { expectedVersion: intent.version, actor }));
        }
        if (intent.state === "captured" || intent.state === "clarified" || intent.state === "resumed") {
            intent = this.applyEntity(() => this.ports.services.intent.confirm(intent.id, { expectedVersion: intent.version, actor }));
        }
        if (intent.state === "confirmed") {
            intent = this.applyEntity(() => this.ports.services.intent.accept(intent.id, { expectedVersion: intent.version, actor }));
        }
        if (intent.state !== "accepted") {
            throw new KernelError("invalid_state", `intent ${intent.id} cannot be confirmed from ${intent.state}`);
        }
        return intent;
    }

    private createMission(input: CreateMissionInput): Mission {
        const existing = this.ports.workflow.find("mission", input.missionId);
        if (existing.isPresent()) return existing.get();
        const actor = this.actorOf(input);
        const intent = this.ports.workflow.get("intent", input.intentId);
        const created = this.applyEntity(() => this.ports.services.mission.create({
            id: input.missionId,
            sessionId: intent.sessionId,
            intentId: intent.id,
        }, actor));
        const proposed = this.applyEntity(() => this.ports.services.mission.propose(created.id, {
            expectedVersion: created.version,
            actor,
        }));
        return this.applyEntity(() => this.ports.services.mission.activate(proposed.id, {
            expectedVersion: proposed.version,
            actor,
        }));
    }

    private createGoal(input: CreateGoalInput): Goal {
        const existing = this.ports.workflow.find("goal", input.goalId);
        if (existing.isPresent()) return existing.get();
        const actor = this.actorOf(input);
        const mission = this.ports.workflow.get("mission", input.missionId);
        const created = this.applyEntity(() => this.ports.services.goal.create({
            id: input.goalId,
            sessionId: mission.sessionId,
            missionId: mission.id,
            contractVersion: input.contractVersion,
            acceptanceCriteria: [...input.acceptanceCriteria],
        }, actor));
        const proposed = this.applyEntity(() => this.ports.services.goal.propose(created.id, {
            expectedVersion: created.version,
            actor,
        }));
        return this.applyEntity(() => this.ports.services.goal.activate(proposed.id, {
            expectedVersion: proposed.version,
            actor,
        }));
    }

    private createPlan(input: CreatePlanInput): CreatePlanResult {
        const existing = this.ports.workflow.find("plan", input.planId);
        if (existing.isPresent()) {
            const plan = existing.get();
            return { plan, tasks: this.ports.services.plan.tasks(plan.id) };
        }
        if (input.tasks.length === 0) throw new KernelError("invalid_input", "a plan requires at least one task");
        const seen = new Set<string>();
        for (const task of input.tasks) {
            if (seen.has(task.taskId)) throw new KernelError("invalid_input", `duplicate task declaration ${task.taskId}`);
            seen.add(task.taskId);
            if (this.ports.workflow.find("task", task.taskId).isPresent()) {
                throw new KernelError("idempotency_conflict", `task ${task.taskId} already exists`);
            }
        }
        const actor = this.actorOf(input);
        const goal = this.ports.workflow.get("goal", input.goalId);
        const plan = this.applyEntity(() => this.ports.services.plan.create({
            id: input.planId,
            sessionId: goal.sessionId,
            goalId: goal.id,
            bounds: input.bounds,
        }, actor));
        const pending = new Map<string, KernelTaskInput>();
        for (const task of input.tasks) pending.set(task.taskId, task);
        const created = new Set<string>();
        while (pending.size > 0) {
            let progressed = false;
            for (const [taskId, declaration] of [...pending]) {
                const dependsOn = [...(declaration.dependsOn ?? [])];
                if (!dependsOn.every(id => created.has(id))) continue;
                this.applyEntity(() => this.ports.services.task.create({
                    id: taskId,
                    sessionId: goal.sessionId,
                    planId: plan.id,
                    dependsOn,
                    required: declaration.required ?? true,
                    contractVersion: declaration.contractVersion ?? goal.contractVersion,
                    requiredEffects: [...(declaration.requiredEffects ?? [])],
                }, actor));
                pending.delete(taskId);
                created.add(taskId);
                progressed = true;
            }
            if (!progressed) throw new KernelError("invalid_input", "task dependencies are unknown or cyclic");
        }
        return { plan, tasks: this.ports.services.plan.tasks(plan.id) };
    }

    private readyTasks(input: ReadyTasksInput): ReadyTasksResult {
        let plan = this.ports.workflow.get("plan", input.planId);
        if (input.expectedVersion !== undefined && plan.version !== input.expectedVersion) {
            throw new KernelError("version_conflict", `plan ${plan.id} expected version ${input.expectedVersion}, current ${plan.version}`);
        }
        const actor = this.actorOf(input);
        const allTasks = this.ports.services.plan.tasks(plan.id);
        if (input.taskIds !== undefined) {
            const known = new Set(allTasks.map(task => task.id));
            for (const id of input.taskIds) {
                if (!known.has(id)) throw new KernelError("invalid_input", `task ${id} does not belong to plan ${plan.id}`);
            }
        }
        if (plan.state === "draft") {
            plan = this.applyEntity(() => this.ports.services.plan.approve(plan.id, { expectedVersion: plan.version, actor }));
        }
        if (plan.state === "approved" || plan.state === "ready") {
            plan = this.applyEntity(() => this.ports.services.plan.execute(plan.id, { expectedVersion: plan.version, actor }));
        }
        if (!isPlanExecutingState(plan.state)) {
            throw new KernelError("invalid_state", `plan ${plan.id} is ${plan.state}; it cannot admit ready tasks`);
        }
        const targets = input.taskIds === undefined ? undefined : new Set(input.taskIds);
        const ready: Task[] = [];
        for (const task of allTasks) {
            if (targets !== undefined && !targets.has(task.id)) continue;
            if (!["pending", "proposed", "unblocked", "blocked"].includes(task.state)) continue;
            const satisfiable = task.dependsOn.every(id => isTaskCompletedState(this.ports.workflow.get("task", id).state));
            if (!satisfiable) continue;
            ready.push(this.applyEntity(() => this.ports.services.task.ready(task.id, { expectedVersion: task.version, actor })));
        }
        return { plan: this.ports.workflow.get("plan", plan.id), tasks: this.ports.services.plan.tasks(plan.id), ready };
    }

    /* -------------------------------------------------------------- */
    /* Action execution                                               */
    /* -------------------------------------------------------------- */

    private latestAttempt(action: Action): ActionAttempt {
        const attempts = action.attemptIds.map(id => this.ports.workflow.getAttempt(id));
        const latest = attempts[attempts.length - 1];
        if (latest === undefined) throw new KernelError("invalid_state", `action ${action.id} has no attempt`);
        return latest;
    }

    private async authorizeAction(input: StartActionInput, task: Task, attemptId: Identifier, executionId: Identifier): Promise<void> {
        const authorization = input.authorize;
        if (authorization === undefined) return;
        const context = this.executionContext({
            sessionId: task.sessionId,
            ...(input.originTurnId === undefined ? {} : { originTurnId: input.originTurnId }),
            ...(this.missionOfTask(task) === undefined ? {} : { missionId: this.missionOfTask(task) }),
            taskId: task.id,
            actionId: input.actionId,
            operationId: input.operationId,
            attemptId,
            executionId,
            cancellationEpoch: this.epochOf("task", task.id),
            ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            ...(input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion }),
        });
        try {
            await this.ports.policy.authorize({
                action: authorization.action,
                object: authorization.object,
                context,
                ...(authorization.input === undefined ? {} : { input: authorization.input }),
            });
        } catch (error) {
            if (error instanceof PolicyDeniedError) throw new KernelError("policy_denied", error.message, error);
            throw error;
        }
    }

    private executionRequest(action: Action, attempt: ActionAttempt, task: Task, budget: Budget): KernelExecutionRequest {
        return {
            action,
            task,
            sessionId: action.sessionId,
            operationId: action.operationId,
            attemptId: attempt.attemptId,
            executionId: attempt.executionId,
            context: this.executionContext({
                sessionId: action.sessionId,
                ...(action.originTurnId === undefined ? {} : { originTurnId: action.originTurnId }),
                ...(this.missionOfTask(task) === undefined ? {} : { missionId: this.missionOfTask(task) }),
                taskId: action.taskId,
                actionId: action.id,
                operationId: action.operationId,
                attemptId: attempt.attemptId,
                executionId: attempt.executionId,
                cancellationEpoch: attempt.cancellationEpoch,
            }),
            budget,
        };
    }

    private resumeAction(action: Action, input: StartActionInput): StartActionResult {
        if (action.operationId !== input.operationId) {
            throw new KernelError("idempotency_conflict", `action ${action.id} already owns operation ${action.operationId}`);
        }
        if (input.expectedActionVersion !== undefined && action.version !== input.expectedActionVersion) {
            throw new KernelError("version_conflict", `action ${action.id} expected version ${input.expectedActionVersion}, current ${action.version}`);
        }
        if (action.attemptIds.length === 0) {
            throw new KernelError("invalid_state", `action ${action.id} has no attempt; start it without an existing aggregate`);
        }
        return {
            action,
            attempt: this.latestAttempt(action),
            reservation: this.requiredReservation(input.operationId),
            invoked: false,
        };
    }

    private async startAction(input: StartActionInput): Promise<StartActionResult> {
        const actor = this.actorOf(input);
        const existing = this.ports.workflow.find("action", input.actionId);
        if (existing.isPresent()) return this.resumeAction(existing.get(), input);

        const task = this.ports.workflow.get("task", input.taskId);
        if (input.expectedTaskVersion !== undefined && task.version !== input.expectedTaskVersion) {
            throw new KernelError("version_conflict", `task ${task.id} expected version ${input.expectedTaskVersion}, current ${task.version}`);
        }
        if (task.state !== "ready" && !isTaskActiveState(task.state)) {
            throw new KernelError("invalid_state", `task ${task.id} is ${task.state}; call readyTasks first`);
        }
        const plan = this.ports.workflow.get("plan", task.planId);
        if (!isPlanExecutingState(plan.state)) {
            throw new KernelError("invalid_state", `plan ${plan.id} is ${plan.state}; call readyTasks first`);
        }
        if (this.ports.workflow.list("action", task.sessionId).some(action => action.operationId === input.operationId)) {
            throw new KernelError("idempotency_conflict", `operation ${input.operationId} already belongs to another action`);
        }
        const executionId = input.executionId ?? `${input.actionId}:execution`;
        const attemptId = input.attemptId ?? `${input.actionId}:attempt:1`;
        if (this.ports.workflow.findAttempt(attemptId).isPresent()) {
            throw new KernelError("duplicate", `attempt ${attemptId} already exists`);
        }
        const executor: KernelExecutorPort | undefined = input.executor ?? this.ports.executor;
        const reservation = this.reserveBudget(input.operationId, input.budget ?? { calls: 1 });
        if (input.authorize !== undefined) {
            try {
                await this.authorizeAction(input, task, attemptId, executionId);
            } catch (error) {
                this.releaseBudget(input.operationId);
                throw error;
            }
        }

        let action: Action;
        let attempt: ActionAttempt;
        try {
            action = this.applyEntity(() => this.ports.services.action.create({
                id: input.actionId,
                sessionId: task.sessionId,
                ...(input.originTurnId === undefined ? {} : { originTurnId: input.originTurnId }),
                taskId: task.id,
                operationId: input.operationId,
                effect: input.effect,
                required: input.required ?? true,
                sideEffect: input.sideEffect ?? true,
                recovery: input.recovery ?? "query",
            }, actor));
            if (action.state !== "ready") {
                action = this.applyEntity(() => this.ports.services.action.ready(action.id, {
                    expectedVersion: action.version,
                    actor,
                }));
            }
            const currentTask = this.ports.workflow.get("task", task.id);
            if (!isTaskActiveState(currentTask.state) && currentTask.state === "ready") {
                this.applyEntity(() => this.ports.services.task.activate(currentTask.id, {
                    expectedVersion: currentTask.version,
                    actor,
                }));
            }
            attempt = this.applyAttempt(() => this.ports.services.action.startAttempt(action.id, {
                expectedVersion: action.version,
                cancellationEpoch: action.cancellationEpoch,
                executionId,
                attemptId,
                actor,
            }));
        } catch (error) {
            this.releaseBudget(input.operationId);
            throw error;
        }
        const currentAction = this.ports.workflow.get("action", action.id);
        if (executor === undefined) {
            return { action: currentAction, attempt, reservation, invoked: false };
        }
        try {
            const execution = await executor.execute(this.executionRequest(
                currentAction,
                attempt,
                this.ports.workflow.get("task", task.id),
                reservation.amount,
            ));
            return {
                action: this.ports.workflow.get("action", action.id),
                attempt,
                reservation,
                invoked: true,
                execution,
            };
        } catch (error) {
            const beforeFailure = this.ports.workflow.get("action", action.id);
            this.applyAttempt(() => this.ports.services.action.settleAttempt(attempt.attemptId, {
                expectedVersion: attempt.version,
                expectedActionVersion: beforeFailure.version,
                outcome: "failed",
                actor,
            }));
            this.releaseBudget(input.operationId);
            throw new KernelError("execution_failed", `executor failed for action ${input.actionId}: ${messageOf(error)}`, error);
        }
    }

    /* -------------------------------------------------------------- */
    /* Receipt / verification / evidence                              */
    /* -------------------------------------------------------------- */

    private receiptById(id: Identifier): ReceiptCore | undefined {
        const cached = this.receiptCache.get(id);
        if (cached !== undefined) return cached;
        const stored = this.persistence.find<ReceiptCore>("receipt", id);
        if (stored !== undefined) this.receiptCache.set(id, stored);
        return stored;
    }

    private verificationById(id: Identifier): BusinessVerification | undefined {
        const cached = this.verificationCache.get(id);
        if (cached !== undefined) return cached;
        const stored = this.persistence.find<BusinessVerification>("verification", id);
        if (stored !== undefined) this.verificationCache.set(id, stored);
        return stored;
    }

    private evidenceById(id: Identifier): Evidence | undefined {
        const cached = this.evidenceCache.get(id);
        if (cached !== undefined) return cached;
        const stored = this.persistence.find<Evidence>("evidence", id);
        if (stored !== undefined) this.evidenceCache.set(id, stored);
        return stored;
    }

    private integrityForReceipt(receiptId: Identifier): ReceiptIntegrityVerification | undefined {
        for (const value of this.integrityCache.values()) {
            if (value.receiptId === receiptId) return value;
        }
        const stored = this.persistence.list<ReceiptIntegrityVerification>("receipt_integrity").find(value => value.receiptId === receiptId);
        if (stored !== undefined) this.integrityCache.set(stored.id, stored);
        return stored;
    }

    private ensureReceipt(creation: ReceiptCreation): ReceiptCore {
        const id = creation.receiptId ?? `receipt:${creation.attempt.attemptId}`;
        const existing = this.receiptById(id);
        if (existing !== undefined) return existing;
        const task = this.ports.workflow.get("task", creation.action.taskId);
        const invocation = this.ports.receipt.createInvocation({
            id: `invocation:${creation.attempt.attemptId}`,
            context: this.executionContext({
                sessionId: creation.action.sessionId,
                ...(creation.action.originTurnId === undefined ? {} : { originTurnId: creation.action.originTurnId }),
                ...(this.missionOfTask(task) === undefined ? {} : { missionId: this.missionOfTask(task) }),
                taskId: creation.action.taskId,
                actionId: creation.action.id,
                operationId: creation.action.operationId,
                attemptId: creation.attempt.attemptId,
                executionId: creation.attempt.executionId,
                cancellationEpoch: creation.attempt.cancellationEpoch,
                ...(creation.principalId === undefined ? {} : { principalId: creation.principalId }),
                ...(creation.agentId === undefined ? {} : { agentId: creation.agentId }),
                ...(creation.policyVersion === undefined ? {} : { policyVersion: creation.policyVersion }),
            }),
            toolId: creation.toolId ?? creation.action.effect,
            arguments: creation.toolInput ?? null,
            createdAt: this.clock(),
            ...(creation.idempotencyKey === undefined ? {} : { idempotencyKey: creation.idempotencyKey }),
        });
        const observation = this.buildObservation(creation.observation, invocation.id);
        const receipt = this.ports.receipt.createReceiptCore({
            id,
            invocation,
            observation,
            issuedAt: this.clock(),
            payloadDigest: this.receiptDigest(invocation, observation),
            hashAlgorithm: "sha256",
            kind: creation.kind ?? "action_receipt",
            sessionId: creation.action.sessionId,
            ...(creation.action.originTurnId === undefined ? {} : { turnId: creation.action.originTurnId }),
            ...(creation.parentId === undefined ? {} : { parentId: creation.parentId }),
            ...(creation.workspaceAnchor === undefined ? {} : { workspaceAnchor: creation.workspaceAnchor }),
            ...(creation.executor === undefined ? {} : { executor: creation.executor }),
        });
        this.store.transaction(() => {
            this.persistence.saveEntity("receipt", receipt, 1, creation.action.sessionId);
            this.persistence.append("receipt.issued", receipt.id, {
                entityKind: "receipt",
                entityId: receipt.id,
                data: {
                    receiptId: receipt.id,
                    actionId: creation.action.id,
                    attemptId: creation.attempt.attemptId,
                    observationId: observation.id,
                    status: observation.status,
                },
            });
        });
        this.receiptCache.set(id, receipt);
        return receipt;
    }

    private async verifyIntegrity(receipt: ReceiptCore, verifier: string): Promise<ReceiptIntegrityVerification> {
        const existing = this.integrityForReceipt(receipt.id);
        if (existing !== undefined) return existing;
        const integrity = await this.ports.receipt.verifyReceiptIntegrity(receipt, {
            digest: target => this.receiptDigest(target.invocation, target.observation),
            verifier,
            verifiedAt: this.clock(),
        });
        this.store.transaction(() => {
            this.persistence.saveEntity("receipt_integrity", integrity, 1, receipt.sessionId);
            this.persistence.append("receipt.integrity_verified", integrity.id, {
                entityKind: "receipt_integrity",
                entityId: integrity.id,
                data: { receiptId: receipt.id, status: integrity.status },
            });
        });
        this.integrityCache.set(integrity.id, integrity);
        return integrity;
    }

    private async verifyReceipt(receipt: ReceiptCore, input: VerificationRequest): Promise<VerifyBusinessResult> {
        const criteriaVersion = input.criteriaVersion;
        const verifier = input.verifier ?? "kernel";
        const claims = input.claims ?? [`observation:${receipt.observation.status}`];
        const id = input.verificationId ?? `verification:${receipt.id}:${criteriaVersion}`;
        const cached = this.verificationById(id);
        if (cached !== undefined) {
            return { verification: cached, integrity: await this.verifyIntegrity(receipt, cached.verifier) };
        }
        const integrity = await this.verifyIntegrity(receipt, verifier);
        const verification = await this.ports.verification.verifyBusinessSemantics(receipt, integrity, {
            id,
            verifier,
            verifiedAt: this.clock(),
            criteriaVersion,
        }, input.evaluate ?? this.evaluate, claims);
        this.store.transaction(() => {
            this.persistence.saveEntity("verification", verification, 1, receipt.sessionId);
            this.persistence.append("verification.business", verification.id, {
                entityKind: "verification",
                entityId: verification.id,
                data: {
                    verificationId: verification.id,
                    receiptId: receipt.id,
                    status: verification.status,
                    criteriaVersion,
                },
            });
        });
        this.verificationCache.set(id, verification);
        return { verification, integrity };
    }

    private resolveVerification(input: RecordEvidenceInput): BusinessVerification {
        if (input.verification !== undefined) return input.verification;
        if (input.verificationId !== undefined) {
            const found = this.verificationById(input.verificationId);
            if (found !== undefined) return found;
        }
        throw new KernelError("verification_required", "recordEvidence requires an existing business verification");
    }

    private async recordEvidenceInternal(input: RecordEvidenceInput): Promise<Evidence> {
        const receipt = this.receiptById(input.receiptId);
        if (receipt === undefined) throw new KernelError("not_found", `receipt ${input.receiptId} does not exist`);
        const verification = this.resolveVerification(input);
        const integrity = this.integrityForReceipt(receipt.id) ?? await this.verifyIntegrity(receipt, verification.verifier);
        const claim = input.claim ?? verification.claims[0];
        if (claim === undefined) throw new KernelError("invalid_input", "evidence requires a claim");
        const criteriaVersion = input.criteriaVersion ?? verification.criteriaVersion;
        const id = input.evidenceId ?? `evidence:${verification.id}`;
        const existing = this.evidenceById(id);
        if (existing !== undefined) return existing;
        const inLedger = this.ports.evidence.get(id, this.tenantId);
        if (inLedger !== undefined) {
            this.evidenceCache.set(id, inLedger);
            return inLedger;
        }
        const source: EvidenceSource = input.source ?? {
            type: "operation_history",
            reliability: 0.9,
            origin: "original",
            reproducible: true,
            independenceKey: receipt.invocation.context.operationId,
        };
        const turnId = input.turnId ?? receipt.turnId;
        let evidence: Evidence;
        try {
            evidence = this.ports.evidence.add({
                id,
                tenantId: this.tenantId,
                claim,
                polarity: input.polarity ?? "supports",
                receipt,
                integrity,
                verification,
                criteriaVersion,
                environmentVersion: input.environmentVersion ?? "kernel/1",
                createdAt: this.clock(),
                source,
                sessionId: input.sessionId ?? receipt.sessionId ?? receipt.invocation.context.sessionId,
                ...(turnId === undefined ? {} : { turnId }),
                ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
                ...(input.level === undefined ? {} : { level: input.level }),
                ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
                ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
                ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
                ...(input.cooperationId === undefined ? {} : { cooperationId: input.cooperationId }),
            });
        } catch (error) {
            throw new KernelError("evidence_error", messageOf(error), error);
        }
        this.store.transaction(() => {
            this.persistence.saveEntity("evidence", evidence, 1, evidence.sessionId);
            this.persistence.append("evidence.added", evidence.id, {
                entityKind: "evidence",
                entityId: evidence.id,
                data: {
                    evidenceId: evidence.id,
                    receiptId: evidence.receiptId,
                    verificationId: evidence.verificationId,
                    claim: evidence.claim,
                    level: evidence.level,
                },
            });
        });
        this.evidenceCache.set(id, evidence);
        return evidence;
    }

    private recordReceipt(input: RecordReceiptInput): ReceiptCore {
        const action = this.ports.workflow.get("action", input.actionId);
        const attempt = input.attemptId === undefined
            ? this.latestAttempt(action)
            : this.ports.workflow.getAttempt(input.attemptId);
        if (attempt.actionId !== action.id) throw new KernelError("invalid_input", `attempt ${attempt.attemptId} belongs to another action`);
        return this.ensureReceipt({
            action,
            attempt,
            observation: input.observation,
            ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
            ...(input.workspaceAnchor === undefined ? {} : { workspaceAnchor: input.workspaceAnchor }),
            ...(input.executor === undefined ? {} : { executor: input.executor }),
            ...(input.toolId === undefined ? {} : { toolId: input.toolId }),
            ...(input.toolInput === undefined ? {} : { toolInput: input.toolInput }),
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
            ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
            ...(input.policyVersion === undefined ? {} : { policyVersion: input.policyVersion }),
        });
    }

    private async verifyBusiness(input: VerifyBusinessInput): Promise<VerifyBusinessResult> {
        const receipt = this.receiptById(input.receiptId);
        if (receipt === undefined) throw new KernelError("not_found", `receipt ${input.receiptId} does not exist`);
        return this.verifyReceipt(receipt, {
            criteriaVersion: input.criteriaVersion ?? "kernel/1",
            ...(input.verifier === undefined ? {} : { verifier: input.verifier }),
            ...(input.claims === undefined ? {} : { claims: input.claims }),
            ...(input.evaluate === undefined ? {} : { evaluate: input.evaluate }),
            ...(input.verificationId === undefined ? {} : { verificationId: input.verificationId }),
        });
    }

    private async recordEvidence(input: RecordEvidenceInput): Promise<Evidence> {
        return this.recordEvidenceInternal(input);
    }

    /* -------------------------------------------------------------- */
    /* Settlement                                                     */
    /* -------------------------------------------------------------- */

    private completePlanIfDone(planId: Identifier, actor: Identifier): Plan | undefined {
        const plan = this.ports.workflow.get("plan", planId);
        if (!isPlanExecutingState(plan.state)) return undefined;
        const tasks = this.ports.services.plan.tasks(plan.id);
        const done = tasks.every(task => isTaskCompletedState(task.state) || (!task.required && task.state === "skipped"));
        if (!done) return undefined;
        return this.applyEntity(() => this.ports.services.plan.complete(plan.id, {
            expectedVersion: plan.version,
            actor,
            cancellationEpoch: this.epochOf("plan", plan.id),
        }));
    }

    private completeTaskAndPlan(
        action: Action,
        verification: BusinessVerification,
        evidence: Evidence,
        actor: Identifier,
        completePlan: boolean,
    ): { readonly task: Task; readonly plan?: Plan } {
        const task = this.ports.workflow.get("task", action.taskId);
        if (isTaskCompletedState(task.state) || task.state === "skipped") {
            const plan = completePlan ? this.completePlanIfDone(task.planId, actor) : undefined;
            return { task, ...(plan === undefined ? {} : { plan }) };
        }
        const actions = this.ports.workflow.list("action", task.sessionId).filter(candidate => candidate.taskId === task.id);
        if (!actions.filter(candidate => candidate.required).every(candidate => candidate.state === "succeeded")) return { task };
        if (!task.requiredEffects.every(effect => actions.some(candidate => candidate.effect === effect && candidate.state === "succeeded"))) {
            return { task };
        }
        const acceptance: Acceptance = {
            valid: true,
            contractVersion: task.contractVersion,
            verificationId: verification.id,
            evidenceIds: [evidence.id],
        };
        const completed = this.applyEntity(() => this.ports.services.task.complete(task.id, acceptance, {
            expectedVersion: task.version,
            actor,
            cancellationEpoch: this.epochOf("task", task.id),
        }));
        const plan = completePlan ? this.completePlanIfDone(completed.planId, actor) : undefined;
        return { task: completed, ...(plan === undefined ? {} : { plan }) };
    }

    private async settleAction(input: SettleActionInput): Promise<SettleActionResult> {
        const actor = this.actorOf(input);
        const action = this.ports.workflow.get("action", input.actionId);
        if (input.expectedActionVersion !== undefined && action.version !== input.expectedActionVersion) {
            throw new KernelError("version_conflict", `action ${action.id} expected version ${input.expectedActionVersion}, current ${action.version}`);
        }
        const attempt = input.attemptId === undefined ? this.latestAttempt(action) : this.ports.workflow.getAttempt(input.attemptId);
        if (attempt.actionId !== action.id) throw new KernelError("invalid_input", `attempt ${attempt.attemptId} belongs to another action`);
        if (input.expectedAttemptVersion !== undefined && attempt.version !== input.expectedAttemptVersion) {
            throw new KernelError("version_conflict", `attempt ${attempt.attemptId} expected version ${input.expectedAttemptVersion}, current ${attempt.version}`);
        }
        let settled = attempt;
        if (attempt.state === "running") {
            const outcome: "succeeded" | "failed" | "unknown_outcome" = input.observation.status === "success"
                ? "succeeded"
                : input.observation.status === "failure"
                    ? "failed"
                    : "unknown_outcome";
            settled = this.applyAttempt(() => this.ports.services.action.settleAttempt(attempt.attemptId, {
                expectedVersion: attempt.version,
                expectedActionVersion: action.version,
                outcome,
                actor,
            }));
        } else if (attempt.state === "unknown_outcome") {
            throw new KernelError("invalid_state", `attempt ${attempt.attemptId} has an unknown outcome; reconcile before settling`);
        }
        const currentAction = this.ports.workflow.get("action", action.id);
        if (settled.state !== "unknown_outcome") {
            this.settleBudget(currentAction.operationId, input.usage);
        }
        const receipt = this.ensureReceipt({
            action: currentAction,
            attempt: settled,
            observation: input.observation,
        });
        const task = this.ports.workflow.get("task", currentAction.taskId);
        const verificationInput: VerificationRequest = {
            criteriaVersion: input.verification?.criteriaVersion ?? task.contractVersion,
            claims: input.verification?.claims ?? [currentAction.effect],
            ...(input.verification?.verifier === undefined ? {} : { verifier: input.verification.verifier }),
            ...(input.verification?.evaluate === undefined ? {} : { evaluate: input.verification.evaluate }),
            ...(input.verification?.verificationId === undefined ? {} : { verificationId: input.verification.verificationId }),
        };
        const verified = await this.verifyReceipt(receipt, verificationInput);
        const verification = verified.verification;
        let evidence: Evidence | undefined;
        if (verification.status === "semantic_verified") {
            const evidenceInput = input.evidence;
            evidence = await this.recordEvidenceInternal({
                receiptId: receipt.id,
                verification,
                ...(evidenceInput?.evidenceId === undefined ? {} : { evidenceId: evidenceInput.evidenceId }),
                ...(evidenceInput?.claim === undefined ? {} : { claim: evidenceInput.claim }),
                ...(evidenceInput?.polarity === undefined ? {} : { polarity: evidenceInput.polarity }),
                ...(evidenceInput?.level === undefined ? {} : { level: evidenceInput.level }),
                ...(evidenceInput?.source === undefined ? {} : { source: evidenceInput.source }),
                ...(evidenceInput?.environmentVersion === undefined ? {} : { environmentVersion: evidenceInput.environmentVersion }),
                ...(evidenceInput?.expiresAt === undefined ? {} : { expiresAt: evidenceInput.expiresAt }),
                ...(evidenceInput?.dependsOn === undefined ? {} : { dependsOn: evidenceInput.dependsOn }),
            });
        }
        const succeeded = currentAction.state === "succeeded";
        if (succeeded && evidence === undefined && input.requireEvidence !== false) {
            throw new KernelError("verification_rejected", `action ${currentAction.id} did not produce verified evidence (${verification.status})`);
        }
        let completedTask: Task | undefined;
        let completedPlan: Plan | undefined;
        if (succeeded && evidence !== undefined && input.completeTask !== false) {
            const completed = this.completeTaskAndPlan(currentAction, verification, evidence, actor, input.completePlan !== false);
            completedTask = completed.task;
            completedPlan = completed.plan;
        }
        return {
            action: this.ports.workflow.get("action", currentAction.id),
            attempt: this.ports.workflow.getAttempt(settled.attemptId),
            receipt,
            verification,
            ...(evidence === undefined ? {} : { evidence }),
            budget: this.ports.budget.snapshot(this.budgetKey),
            ...(completedTask === undefined ? {} : { task: completedTask }),
            ...(completedPlan === undefined ? {} : { plan: completedPlan }),
        };
    }

    /* -------------------------------------------------------------- */
    /* Attention and context                                          */
    /* -------------------------------------------------------------- */

    private currentPointerVersion(pointer: AttentionPointer, objects: readonly AttentionObject[]): string | undefined {
        if (isWorkflowKind(pointer.kind)) {
            const found = this.ports.workflow.find(pointer.kind, pointer.id);
            return found.isPresent() ? String(found.get().version) : undefined;
        }
        if (pointer.kind === "attention") {
            const match = objects.find(object => object.id === pointer.id);
            if (match !== undefined) return String(match.version);
            const stored = this.persistence.find<AttentionObject>("attention", pointer.id);
            return stored === undefined ? undefined : String(stored.version);
        }
        if (isEntityKind(pointer.kind)) {
            const stored = this.persistence.find<{ readonly version?: number }>(pointer.kind, pointer.id);
            if (stored === undefined) return undefined;
            return String(typeof stored.version === "number" ? stored.version : 0);
        }
        return undefined;
    }

    private compileTurnContext(input: CompileTurnContextInput): CompileTurnContextResult {
        const actor = this.actorOf(input);
        const turn = this.ports.workflow.get("turn", input.turnId);
        const sessionId = input.sessionId ?? turn.sessionId;
        const scope = {
            tenantId: this.tenantId,
            principalId: input.principalId ?? this.tenantId,
            sessionId,
            turnId: turn.id,
        };
        const now = this.clock();
        const objects: AttentionObject[] = [];
        for (const declaration of input.create ?? []) {
            const existing = this.persistence.find<AttentionObject>("attention", declaration.id);
            if (existing !== undefined) {
                objects.push(existing);
                continue;
            }
            let object = this.ports.attention.createAttention({ ...declaration, scope }, now);
            object = this.ports.attention.mount(object, {
                expectedVersion: object.version,
                now,
                reason: declaration.reason,
            });
            this.store.transaction(() => {
                this.persistence.saveEntity("attention", object, object.version, sessionId);
                this.persistence.append("attention.created", object.id, {
                    entityKind: "attention",
                    entityId: object.id,
                    version: object.version,
                    data: { summary: object.summary, pointer: object.pointer },
                });
            });
            objects.push(object);
        }
        for (const object of input.objects ?? []) objects.push(object);
        const budget: Budget = input.budget ?? { tokens: 2048 };
        const compiled = this.ports.context.compileContext(objects, {
            now,
            scope,
            budget,
            currentVersion: input.currentVersion ?? (pointer => this.currentPointerVersion(pointer, objects)),
            ...(input.countTokens === undefined ? {} : { countTokens: input.countTokens }),
        });
        const checkpointId = input.checkpointId ?? `context:${turn.id}`;
        const previous = this.persistence.find<ContextCheckpointRecord>("context_checkpoint", checkpointId);
        const version = (previous?.version ?? 0) + 1;
        const checkpoint: ContextCheckpointRecord = {
            id: checkpointId,
            tenantId: this.tenantId,
            sessionId,
            turnId: turn.id,
            compiledAt: compiled.compiledAt,
            budget: compiled.budget,
            usage: compiled.usage,
            itemIds: compiled.items.map(item => item.id),
            exclusions: compiled.exclusions as readonly ContextExclusion[],
            textDigest: sha256(compiled.text),
            version,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
        };
        this.store.transaction(() => {
            this.persistence.saveEntity("context_checkpoint", checkpoint, version, sessionId);
            this.persistence.append("context.compiled", checkpointId, {
                entityKind: "context_checkpoint",
                entityId: checkpointId,
                version,
                data: {
                    turnId: turn.id,
                    checkpointId,
                    items: checkpoint.itemIds.length,
                    exclusions: checkpoint.exclusions.length,
                    usage: checkpoint.usage,
                    actor,
                },
            });
        });
        return { compiled, checkpoint, attention: objects };
    }

    /* -------------------------------------------------------------- */
    /* Goal achievement and session close                             */
    /* -------------------------------------------------------------- */

    private epochOf(kind: WorkflowKind, id: Identifier): number {
        let entity: WorkflowEntity = this.ports.workflow.get(kind, id);
        let epoch = entity.cancellationEpoch;
        for (;;) {
            const parent = this.parentOf(entity);
            if (parent === undefined) return epoch;
            epoch = Math.max(epoch, parent.cancellationEpoch);
            entity = parent;
        }
    }

    private parentOf(entity: WorkflowEntity): WorkflowEntity | undefined {
        switch (entity.kind) {
            case "session": return undefined;
            case "turn":
            case "intent":
            case "mission": return this.ports.workflow.get("session", entity.sessionId);
            case "goal": return this.ports.workflow.get("mission", entity.missionId);
            case "plan": return this.ports.workflow.get("goal", entity.goalId);
            case "task": return this.ports.workflow.get("plan", entity.planId);
            case "action": return this.ports.workflow.get("task", entity.taskId);
        }
    }

    private validateAcceptance(goal: Goal, acceptance: Acceptance): void {
        if (acceptance.valid !== true) throw new KernelError("verification_required", "Acceptance.valid must be true");
        if (acceptance.contractVersion !== goal.contractVersion) {
            throw new KernelError("verification_required", `Acceptance contract ${acceptance.contractVersion} does not match goal contract ${goal.contractVersion}`);
        }
        if (typeof acceptance.verificationId !== "string" || acceptance.verificationId.trim() === "") {
            throw new KernelError("verification_required", "Acceptance requires a verificationId");
        }
        if (acceptance.evidenceIds.length === 0) throw new KernelError("verification_required", "Acceptance requires at least one evidenceId");
        const verification = this.verificationById(acceptance.verificationId);
        if (verification === undefined || verification.status !== "semantic_verified") {
            throw new KernelError("verification_required", `verification ${acceptance.verificationId} is not a current semantic verification`);
        }
        for (const id of acceptance.evidenceIds) {
            const item = this.evidenceById(id);
            if (item === undefined) throw new KernelError("verification_required", `evidence ${id} does not exist`);
            if (item.tenantId !== this.tenantId) throw new KernelError("verification_required", `evidence ${id} belongs to another tenant`);
            if (item.sessionId !== undefined && item.sessionId !== goal.sessionId) {
                throw new KernelError("verification_required", `evidence ${id} belongs to another session`);
            }
            if (!["active", "corroborated"].includes(item.status)) {
                throw new KernelError("verification_required", `evidence ${id} is ${item.status}`);
            }
            if (item.verificationId !== acceptance.verificationId) {
                throw new KernelError("verification_required", `evidence ${id} was not produced by verification ${acceptance.verificationId}`);
            }
            if (item.receiptId !== verification.receiptId) {
                throw new KernelError("verification_required", `evidence ${id} and verification ${acceptance.verificationId} cite different receipts`);
            }
        }
    }

    private propagateAchievement(goal: Goal, actor: Identifier): { readonly mission?: Mission; readonly intent?: Intent } {
        const goals = this.ports.workflow.list("goal", goal.sessionId).filter(item => item.missionId === goal.missionId);
        let mission = this.ports.workflow.get("mission", goal.missionId);
        if (mission.state !== "active") return {};
        if (!goals.every(item => item.state === "achieved" && item.validity === "valid")) return {};
        mission = this.applyEntity(() => this.ports.services.mission.achieve(mission.id, {
            expectedVersion: mission.version,
            actor,
            cancellationEpoch: this.epochOf("mission", mission.id),
        }));
        let intent = this.ports.workflow.get("intent", mission.intentId);
        if (intent.state === "accepted") {
            intent = this.applyEntity(() => this.ports.services.intent.delegate(intent.id, { expectedVersion: intent.version, actor }));
        }
        if (intent.state === "delegated") {
            intent = this.applyEntity(() => this.ports.services.intent.fulfill(intent.id, { expectedVersion: intent.version, actor }));
        }
        return { mission, intent };
    }

    private achieveGoal(input: AchieveGoalInput): AchieveGoalResult {
        const goal = this.ports.workflow.get("goal", input.goalId);
        if (input.expectedVersion !== undefined && goal.version !== input.expectedVersion) {
            throw new KernelError("version_conflict", `goal ${goal.id} expected version ${input.expectedVersion}, current ${goal.version}`);
        }
        this.validateAcceptance(goal, input.acceptance);
        const actor = this.actorOf(input);
        if (goal.state === "achieved" && goal.validity === "valid") {
            const propagated = input.propagate === false ? {} : this.propagateAchievement(goal, actor);
            return { goal, ...propagated };
        }
        let achieved: Goal;
        if (goal.state === "achieved") {
            achieved = this.applyEntity(() => this.ports.services.goal.revalidate(goal.id, input.acceptance, {
                expectedVersion: goal.version,
                actor,
                cancellationEpoch: this.epochOf("goal", goal.id),
            }));
        } else {
            if (goal.state !== "active") {
                throw new KernelError("invalid_state", `goal ${goal.id} is ${goal.state}; activate it before achievement`);
            }
            achieved = this.applyEntity(() => this.ports.services.goal.achieve(goal.id, input.acceptance, {
                expectedVersion: goal.version,
                actor,
                cancellationEpoch: this.epochOf("goal", goal.id),
            }));
        }
        const propagated = input.propagate === false ? {} : this.propagateAchievement(achieved, actor);
        return { goal: achieved, ...propagated };
    }

    private hasOpenBusinessWork(sessionId: Identifier): boolean {
        const snapshot = this.ports.workflow.snapshot();
        return snapshot.entities.some(entity => entity.sessionId === sessionId
            && entity.kind !== "session"
            && entity.kind !== "turn"
            && entity.kind !== "intent"
            && !isWorkflowSettled(entity)
            && !(entity.kind === "action" && entity.state === "failed"));
    }

    private requestCancel(kind: CancellableKind, id: Identifier, options: TransitionOptions): WorkflowEntity {
        switch (kind) {
            case "mission": return this.ports.services.mission.requestCancel(id, options);
            case "goal": return this.ports.services.goal.requestCancel(id, options);
            case "plan": return this.ports.services.plan.requestCancel(id, options);
            case "task": return this.ports.services.task.requestCancel(id, options);
            case "action": return this.ports.services.action.requestCancel(id, options);
        }
    }

    private cancelEntity(kind: CancellableKind, entity: WorkflowEntity, actor: Identifier): WorkflowEntity {
        let current = entity;
        if (kind === "action" && current.state === "retrying") {
            current = this.applyEntity(() => this.ports.services.action.deadLetter(current.id, {
                expectedVersion: current.version,
                actor,
                reason: "session closed",
            }));
            return current;
        }
        if (!(workflowTransitions[kind][current.state] ?? []).includes("cancel_requested")) {
            throw new KernelError("unsettled_work", `${kind} ${current.id} cannot be cancelled from ${current.state}`);
        }
        current = this.applyEntity(() => this.requestCancel(kind, current.id, {
            expectedVersion: current.version,
            actor,
            reason: "session closed",
        }));
        if ((workflowTransitions[kind][current.state] ?? []).includes("draining")) {
            const draining = current;
            current = this.applyEntity(() => this.ports.workflow.transition(kind, draining.id, "draining", {
                expectedVersion: draining.version,
                actor,
                reason: "session closed",
            }));
        }
        if ((workflowTransitions[kind][current.state] ?? []).includes("cancelled")) {
            const cancelled = current;
            current = this.applyEntity(() => this.ports.workflow.transition(kind, cancelled.id, "cancelled", {
                expectedVersion: cancelled.version,
                actor,
                reason: "session closed",
            }));
        }
        return current;
    }

    private drainBusinessWork(sessionId: Identifier, actor: Identifier): readonly WorkflowEntity[] {
        const cancelled: WorkflowEntity[] = [];
        for (const kind of ["action", "task", "plan", "goal", "mission"] as const satisfies readonly CancellableKind[]) {
            for (const seed of this.ports.workflow.list(kind, sessionId)) {
                if (isWorkflowTerminal(seed)) continue;
                if (kind === "action" && seed.state === "failed") continue;
                cancelled.push(this.cancelEntity(kind, seed, actor));
            }
        }
        return cancelled;
    }

    private settleIntents(sessionId: Identifier, actor: Identifier): void {
        for (const intent of this.ports.workflow.list("intent", sessionId)) {
            if (isWorkflowSettled(intent)) continue;
            this.applyEntity(() => this.ports.services.intent.supersede(intent.id, {
                expectedVersion: intent.version,
                actor,
                reason: "session closed",
            }));
        }
    }

    private turnCompletionPath(state: Turn["state"]): readonly Turn["state"][] {
        switch (state) {
            case "received": return ["interpreting", "acting", "responding", "completed"];
            case "interpreting": return ["acting", "responding", "completed"];
            case "acting": return ["responding", "completed"];
            case "responding": return ["completed"];
            case "resumed": return ["acting", "responding", "completed"];
            case "clarifying": return ["abandoned"];
            case "interrupted": return ["abandoned"];
            default: return [];
        }
    }

    private finishTurns(sessionId: Identifier, actor: Identifier): Turn[] {
        const turns: Turn[] = [];
        for (const turn of this.ports.workflow.list("turn", sessionId)) {
            let current = turn;
            for (const next of this.turnCompletionPath(current.state)) {
                current = this.applyEntity(() => this.ports.services.turn.transition(current.id, next, {
                    expectedVersion: current.version,
                    actor,
                }));
            }
            turns.push(current);
        }
        return turns;
    }

    private closeSession(input: CloseSessionInput): CloseSessionResult {
        const session = this.ports.workflow.get("session", input.sessionId);
        if (["closed", "archived", "expired", "aborted"].includes(session.state)) {
            return { session, turns: [], cancelled: [] };
        }
        if (input.expectedVersion !== undefined && session.version !== input.expectedVersion) {
            throw new KernelError("version_conflict", `session ${session.id} expected version ${input.expectedVersion}, current ${session.version}`);
        }
        const attempts = this.ports.workflow.snapshot().attempts.filter(attempt => attempt.sessionId === session.id
            && (attempt.state === "running" || attempt.state === "unknown_outcome"));
        if (attempts.length > 0) {
            throw new KernelError("unsettled_work", `session ${session.id} has ${attempts.length} unsettled attempt(s)`);
        }
        const actor = this.actorOf(input);
        const abandon = input.abandonOpenWork !== false;
        if (!abandon && this.hasOpenBusinessWork(session.id)) {
            throw new KernelError("unsettled_work", `session ${session.id} still has open business work`);
        }
        const cancelled = abandon ? [...this.drainBusinessWork(session.id, actor)] : [];
        this.settleIntents(session.id, actor);
        const turns = this.finishTurns(session.id, actor);
        let current = this.ports.workflow.get("session", session.id);
        if (current.state === "created") {
            current = this.applyEntity(() => this.ports.services.session.activate(current.id, { expectedVersion: current.version, actor }));
        }
        if (current.state !== "closing") {
            current = this.applyEntity(() => this.ports.services.session.beginClose(current.id, { expectedVersion: current.version, actor }));
        }
        current = this.applyEntity(() => this.ports.services.session.close(current.id, { expectedVersion: current.version, actor }));
        return { session: current, turns, cancelled };
    }
}

/**
 * Creates the executable kernel. `overrides` are optional host collaborators
 * (executor, policy, evaluator, project/workspace); no dependency is installed.
 */
export function createKernel(options: KernelOptions, overrides: KernelOverrides = {}): Kernel {
    try {
        return new KernelImpl(options, overrides);
    } catch (error) {
        throw translate(error);
    }
}
