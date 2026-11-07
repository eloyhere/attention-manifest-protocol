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
import { BudgetTree } from "../budget/tree.ts";
import { EvidenceLedger } from "../evidence/ledger.ts";
import * as attentionOperations from "../attention/operations.ts";
import * as contextCompiler from "../context/compiler.ts";
import * as receiptCore from "../receipt/core.ts";
import * as verificationCore from "../verification/core.ts";
import { Project } from "../project/core.ts";
import { mergeEnvironment, validateEnvironment } from "../project/environment.ts";
import type { EnvironmentPatch } from "../project/environment.ts";
import { Workspace } from "../workspace/core.ts";
import { WorkspaceError } from "../workspace/types.ts";
import { InMemoryFileStorage } from "../file/core.ts";
import type { WorkspaceFile } from "../file/core.ts";
import type { FileOperationKind, FileOperationReceipt, FileRange, FileRef, FileSnapshot, WorkspaceMode } from "../file/types.ts";
import { bindProject } from "../persistence/bindings.ts";
import type { ProjectBinding } from "../persistence/bindings.ts";
import { Store } from "../service/store.ts";
import { isEntityKind } from "../entity/key.ts";
import type { Budget, BudgetDimension, ExecutionContext, Identifier, JsonValue } from "../shared.ts";
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
    BudgetExhaustionDecision,
    CaptureIntentInput,
    CloseSessionInput,
    CloseSessionResult,
    CloseWorkspaceFileInput,
    CloseWorkspaceFileResult,
    ClosureReceipt,
    ClosureReceiptSummary,
    CompileTurnContextInput,
    CompileTurnContextResult,
    ConfigureProjectInput,
    ConfigureProjectPatch,
    ConfigureProjectResult,
    ConfirmIntentInput,
    ConsumeBudgetInput,
    ConsumeBudgetResult,
    ContextCheckpointRecord,
    CreateGoalInput,
    CreateMissionInput,
    CreatePlanInput,
    CreatePlanResult,
    DescribeProjectResult,
    Kernel,
    KernelBudgetOptions,
    KernelExecutionRequest,
    KernelExecutorPort,
    KernelFlow,
    KernelObservationInput,
    KernelOptions,
    KernelOverrides,
    KernelPorts,
    KernelProjectMetadataInput,
    KernelProjectOptions,
    KernelProjectRuleInput,
    KernelServices,
    KernelSnapshot,
    KernelTaskInput,
    OpenWorkspaceFileInput,
    OpenedWorkspaceFile,
    ReadFileInput,
    ReadFileOptions,
    ReadFileResult,
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
    WriteFileInput,
    WriteFileOptions,
    WriteFileResult,
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
    if (error instanceof WorkspaceError) return new KernelError(error.code, error.message, error);
    if (error instanceof PolicyDeniedError) return new KernelError("policy_denied", error.message, error);
    if (error instanceof Error) return new KernelError("invalid_input", error.message, error);
    return new KernelError("invalid_input", String(error));
}

function isWorkflowKind(value: string): value is WorkflowKind {
    return (WORKFLOW_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A node limit that never refuses a realistic amount, used when only `turn` is configured. */
function unlimitedBudget(): Budget {
    const ceiling = Number.MAX_SAFE_INTEGER;
    return { tokens: ceiling, milliseconds: ceiling, calls: ceiling, bytes: ceiling, retries: ceiling, concurrency: ceiling };
}

const FILE_RECEIPT_KIND: Readonly<Record<FileOperationKind, "file_mount_receipt" | "file_flush_receipt" | "file_unmount_receipt">> = Object.freeze({
    mount: "file_mount_receipt",
    flush: "file_flush_receipt",
    unmount: "file_unmount_receipt",
});

function fileReceiptId(kind: FileOperationKind, ref: FileRef, version: number, hash: string): string {
    return `receipt:file:${kind}:${ref.tenantId}:${ref.rootId}:${ref.path}:${version}:${hash}`;
}

function fileEvidenceId(receiptId: string): string {
    return `evidence:${receiptId}`;
}

function fileIntegrityId(receiptId: string): string {
    return `integrity:${receiptId}`;
}

function fileVerificationId(receiptId: string): string {
    return `verification:${receiptId}`;
}

function fileClaim(kind: FileOperationKind, path: string): string {
    return `${FILE_RECEIPT_KIND[kind]}:${path}`;
}

/** Recognizes the three accepted `FileRange` spellings. */
function isFileRange(value: unknown): value is FileRange {
    if (!isRecord(value)) return false;
    if (value.kind === "byte" || value.kind === "line") {
        return typeof value.start === "number" && typeof value.end === "number";
    }
    return isRecord(value.byte) || isRecord(value.line);
}

function isEnvironmentPatchInput(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false;
    if ("environment" in value || "patch" in value || "rules" in value || "metadata" in value
        || "expectedEnvironmentVersion" in value || "actor" in value) return false;
    return "variables" in value || "paths" in value || "dependencies" in value;
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

/** Input shape accepted by the receipt port's core constructor. */
type ReceiptCoreInput = Parameters<KernelPorts["receipt"]["createReceiptCore"]>[0];

/** The two closure receipt kinds the kernel synthesizes itself. */
type ClosureReceiptKind = ClosureReceipt["kind"];

/** One recorded file-operation receipt plus the verification/evidence chain it anchors. */
interface FileOperationRecord {
    readonly receipt: ReceiptCore;
    readonly integrity: ReceiptIntegrityVerification;
    readonly verification: BusinessVerification;
    readonly evidence: Evidence;
    /** True when the receipt did not exist before this call. */
    readonly created: boolean;
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
    ports!: KernelPorts;
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
    private readonly projectOptions: KernelProjectOptions | undefined;
    private readonly ownsProject: boolean;
    private readonly budgetConfig: KernelBudgetOptions | undefined;
    private readonly budgetDecisionList: BudgetExhaustionDecision[] = [];
    /** Open workspace files, keyed by the workspace-relative path. */
    private readonly openFiles = new Map<string, WorkspaceFile>();
    private readonly openFileResults = new Map<string, OpenedWorkspaceFile>();
    /** Paths mounted read-only through `openWorkspaceFile`; writes stay rejected. */
    private readonly lockedReadOnlyFiles = new Set<string>();
    /** Budget-tree action node of each ledger reservation (`operationId` -> node). */
    private readonly treeActionNodes = new Map<string, Identifier>();
    private projectBinding!: ProjectBinding;
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
        this.projectOptions = options.project;
        this.ownsProject = overrides.project === undefined;
        this.budgetConfig = options.budgetTree ?? options.budget;
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
            const project = overrides.project ?? new Project({
                ...(this.projectOptions ?? {}),
                tenantId: this.tenantId,
                rootId: this.rootId,
                clock: this.clock,
            });
            const workspace = overrides.workspace ?? new Workspace({
                tenantId: this.tenantId,
                rootId: this.rootId,
                storage: new InMemoryFileStorage(this.clock),
                clock: this.clock,
            });
            const budgetTree = new BudgetTree({
                onExhausted: (nodeId, dimension) => this.handleBudgetExhausted(nodeId, dimension),
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
                budgetTree,
                store: this.store,
            };
            this.projectBinding = bindProject(this.store, project);
            this.projectBinding.rehydrate();
            this.restoreBudgetDecisions();
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
                configureProject: patch => this.guard(() => this.configureProject(patch)),
                describeProject: () => this.guard(() => this.describeProject()),
                openWorkspaceFile: (path, mode) => this.guard(() => this.openWorkspaceFile(path, mode)),
                readFile: (path, options) => this.guard(() => this.readFile(path, options)),
                writeFile: (path, content, options) => this.guard(() => this.writeFile(path, content, options)),
                closeWorkspaceFile: path => this.guard(() => this.closeWorkspaceFile(path)),
                consumeBudget: input => this.guard(() => this.consumeBudget(input)),
                budgetDecisions: () => Object.freeze([...this.budgetDecisionList]),
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
                budgetTree: this.ports.budgetTree.snapshots(),
                budgetDecisions: this.budgetDecisionList.length,
                evidenceCount: this.persistence.list<Evidence>("evidence").length,
                receiptCount: this.persistence.list<ReceiptCore>("receipt").length,
                verificationCount: this.persistence.list<BusinessVerification>("verification").length,
                workflowEvents: workflow.sequence,
                store: this.store.stats(),
            };
        });
    }

    budgetDecisions(): readonly BudgetExhaustionDecision[] {
        return Object.freeze([...this.budgetDecisionList]);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        // Record the unmount receipts of every file the kernel still holds
        // before the store disappears; a failure here must not block close.
        for (const path of [...this.openFiles.keys()]) {
            try {
                this.closeWorkspaceFileInternal({ path, discardDirty: true });
            } catch {
                /* close is best-effort cleanup */
            }
        }
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

    /**
     * Rebuilds the single writer from the durable facts after a transaction was
     * rolled back. `WorkflowStore` has no in-place rewind, so the only way to
     * keep memory and the store consistent is to re-adopt the persisted state
     * and rebind the services to the rebuilt writer.
     */
    private restoreWorkflowAfterRollback(): void {
        const workflow = this.persistence.restoreWorkflow(this.clock);
        this.ports = {
            ...this.ports,
            workflow,
            services: {
                session: new SessionService(workflow),
                turn: new TurnService(workflow),
                intent: new IntentService(workflow),
                mission: new MissionService(workflow),
                goal: new GoalService(workflow),
                plan: new PlanService(workflow),
                task: new TaskService(workflow),
                action: new ActionService(workflow),
            },
        };
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
        this.releaseTreeActionNode(operationId);
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
        this.settleTreeActionNode(operationId, settled.actual ?? settled.amount);
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
    /* Hierarchical budget tree (Session -> Turn -> Action)           */
    /* -------------------------------------------------------------- */

    private ensureSessionBudgetNode(sessionId: Identifier, limitOverride?: Budget): void {
        const limit = limitOverride ?? this.budgetConfig?.session;
        if (limit === undefined) return;
        if (this.ports.budgetTree.has(sessionId)) return;
        this.ports.budgetTree.addRoot(sessionId, limit);
    }

    /**
     * Allocates this Turn's node from its Session node. A refusal fires the
     * tree observer (Session -> closing) before the stable `budget_exhausted`
     * error reaches the caller.
     */
    private allocateTurnBudget(sessionId: Identifier, turnId: Identifier, limitOverride?: Budget): void {
        const limit = limitOverride ?? this.budgetConfig?.turn;
        if (limit === undefined) return;
        if (this.ports.budgetTree.has(turnId)) return;
        if (!this.ports.budgetTree.has(sessionId)) {
            const session = this.ports.workflow.find("session", sessionId);
            const sessionLimit = this.budgetConfig?.session ?? (session.isPresent() ? session.get().budget : undefined);
            this.ports.budgetTree.addRoot(sessionId, sessionLimit ?? unlimitedBudget());
        }
        this.ports.budgetTree.allocate(sessionId, turnId, limit);
    }

    /**
     * Allocates a per-attempt Action node from the Turn node and reserves the
     * action budget there. Returns `undefined` when the Turn has no node (the
     * hierarchical tree is inert for that action).
     */
    private allocateActionBudget(input: StartActionInput, attemptId: Identifier): Identifier | undefined {
        const turnNode = this.actionTurnNode(input);
        if (turnNode === undefined) return undefined;
        const amount: Budget = input.budget ?? { calls: 1 };
        const nodeId = `action:${input.actionId}:${attemptId}`;
        this.ports.budgetTree.allocate(turnNode, nodeId, amount);
        try {
            this.ports.budgetTree.reserve(nodeId, amount);
        } catch (error) {
            this.forgetTreeActionNode(nodeId);
            throw error;
        }
        this.treeActionNodes.set(input.operationId, nodeId);
        return nodeId;
    }

    /** The Turn node an Action charges: its origin Turn, else the latest live Turn of the Session. */
    private actionTurnNode(input: StartActionInput): Identifier | undefined {
        if (input.originTurnId !== undefined && this.ports.budgetTree.has(input.originTurnId)) {
            return input.originTurnId;
        }
        const task = this.ports.workflow.get("task", input.taskId);
        const turns = this.ports.workflow.list("turn", task.sessionId)
            .filter(turn => !isWorkflowTerminal(turn) && this.ports.budgetTree.has(turn.id));
        const latest = turns[turns.length - 1];
        return latest?.id;
    }

    private forgetTreeActionNode(nodeId: Identifier): void {
        try {
            this.ports.budgetTree.release(nodeId);
        } catch {
            /* the reservation may already be released */
        }
        try {
            this.ports.budgetTree.settle(nodeId, {});
        } catch {
            /* the node may already be closed */
        }
    }

    private releaseTreeActionNode(operationId: Identifier): void {
        const nodeId = this.treeActionNodes.get(operationId);
        if (nodeId === undefined) return;
        this.treeActionNodes.delete(operationId);
        this.forgetTreeActionNode(nodeId);
    }

    private settleTreeActionNode(operationId: Identifier, actual: Budget): void {
        const nodeId = this.treeActionNodes.get(operationId);
        if (nodeId === undefined) return;
        this.treeActionNodes.delete(operationId);
        try {
            this.ports.budgetTree.settle(nodeId, actual);
        } catch {
            /* accounting cleanup must not turn a settled business effect into a failure */
        }
    }

    /** `BudgetTree.onExhausted` observer: records the decision and applies the business reaction. */
    private handleBudgetExhausted(nodeId: Identifier, dimension: BudgetDimension): void {
        const decision = this.applyBudgetExhaustion(nodeId, dimension);
        this.budgetDecisionList.push(decision);
        try {
            this.persistBudgetDecision(decision);
        } catch {
            /* The decision is already exposed; persistence must not replace the budget signal. */
        }
    }

    private applyBudgetExhaustion(nodeId: Identifier, dimension: BudgetDimension): BudgetExhaustionDecision {
        const at = this.clock();
        const target = this.resolveBudgetTarget(nodeId);
        if (target.scope === "turn" && target.entityId !== undefined) {
            const previous = this.ports.workflow.find("turn", target.entityId);
            if (previous.isEmpty()) {
                return this.recordedDecision(nodeId, dimension, at, "node", "turn node does not address a Turn");
            }
            try {
                const reaction = this.store.transaction(() => {
                    let turn = this.ports.workflow.get("turn", target.entityId!);
                    turn = this.driveTurnToActing(turn);
                    if (turn.state !== "acting") {
                        return {
                            applied: false,
                            previousState: turn.state,
                            state: turn.state,
                            message: `Turn ${turn.id} is ${turn.state}; only an acting Turn can be interrupted`,
                        };
                    }
                    const interrupted = this.applyEntity(() => this.ports.services.turn.interrupt(turn.id, {
                        expectedVersion: turn.version,
                        actor: "kernel:budget",
                        reason: "budget_exhausted",
                        now: at,
                    }));
                    return {
                        applied: true,
                        previousState: "acting",
                        state: interrupted.state,
                        message: `Turn ${turn.id} interrupted after ${dimension} budget exhaustion`,
                    };
                });
                return {
                    scope: "turn",
                    nodeId,
                    entityId: target.entityId,
                    dimension,
                    reason: "budget_exhausted",
                    action: reaction.applied ? "turn_interrupted" : "recorded",
                    applied: reaction.applied,
                    previousState: reaction.previousState,
                    state: reaction.state,
                    message: reaction.message,
                    at,
                };
            } catch (error) {
                return {
                    scope: "turn",
                    nodeId,
                    entityId: target.entityId,
                    dimension,
                    reason: "budget_exhausted",
                    action: "recorded",
                    applied: false,
                    message: `Turn budget exhaustion could not interrupt ${target.entityId}: ${messageOf(error)}`,
                    at,
                };
            }
        }
        if (target.scope === "session" && target.entityId !== undefined) {
            const session = this.ports.workflow.find("session", target.entityId);
            if (session.isEmpty()) {
                return this.recordedDecision(nodeId, dimension, at, "node", "session node does not address a Session");
            }
            if (["closing", "closed", "archived", "expired", "aborted"].includes(session.get().state)) {
                return {
                    scope: "session",
                    nodeId,
                    entityId: target.entityId,
                    dimension,
                    reason: "budget_exhausted",
                    action: "recorded",
                    applied: false,
                    previousState: session.get().state,
                    state: session.get().state,
                    message: `Session ${target.entityId} is already ${session.get().state}`,
                    at,
                };
            }
            try {
                const reaction = this.store.transaction(() => {
                    let current = this.ports.workflow.get("session", target.entityId!);
                    const previousState = current.state;
                    if (current.state === "created") {
                        current = this.applyEntity(() => this.ports.services.session.activate(current.id, {
                            expectedVersion: current.version,
                            actor: "kernel:budget",
                        }));
                    }
                    if (current.state !== "closing") {
                        current = this.applyEntity(() => this.ports.services.session.beginClose(current.id, {
                            expectedVersion: current.version,
                            actor: "kernel:budget",
                            reason: "budget_exhausted",
                        }));
                    }
                    return { previousState, state: current.state };
                });
                return {
                    scope: "session",
                    nodeId,
                    entityId: target.entityId,
                    dimension,
                    reason: "budget_exhausted",
                    action: "session_closing",
                    applied: reaction.state === "closing",
                    previousState: reaction.previousState,
                    state: reaction.state,
                    message: `Session ${target.entityId} moved to ${reaction.state} after ${dimension} budget exhaustion`,
                    at,
                };
            } catch (error) {
                return {
                    scope: "session",
                    nodeId,
                    entityId: target.entityId,
                    dimension,
                    reason: "budget_exhausted",
                    action: "recorded",
                    applied: false,
                    message: `Session budget exhaustion could not close ${target.entityId}: ${messageOf(error)}`,
                    at,
                };
            }
        }
        return this.recordedDecision(
            nodeId,
            dimension,
            at,
            "node",
            `budget node ${nodeId} is not mapped to a Session or Turn; decision recorded without a business reaction`,
        );
    }

    private recordedDecision(
        nodeId: Identifier,
        dimension: BudgetDimension,
        at: string,
        scope: "node",
        message: string,
    ): BudgetExhaustionDecision {
        return {
            scope,
            nodeId,
            dimension,
            reason: "budget_exhausted",
            action: "recorded",
            applied: false,
            message,
            at,
        };
    }

    /** Resolves a budget node to the Session/Turn it exhausts by walking parent links. */
    private resolveBudgetTarget(nodeId: Identifier): { readonly scope: "session" | "turn" | "node"; readonly entityId?: Identifier } {
        let current = nodeId;
        for (let depth = 0; depth < 8; depth += 1) {
            const candidate = current.startsWith("action:")
                ? current.slice("action:".length)
                : current.startsWith("turn:") ? current.slice("turn:".length)
                    : current.startsWith("session:") ? current.slice("session:".length)
                        : current;
            const turn = this.ports.workflow.find("turn", candidate);
            if (turn.isPresent()) return { scope: "turn", entityId: turn.get().id };
            const session = this.ports.workflow.find("session", candidate);
            if (session.isPresent()) return { scope: "session", entityId: session.get().id };
            if (!this.ports.budgetTree.has(current)) return { scope: "node" };
            const snapshot = this.ports.budgetTree.snapshot(current);
            if (snapshot.parentId === undefined) return { scope: "node" };
            current = snapshot.parentId;
        }
        return { scope: "node" };
    }

    /** Drives a received/interpreting/resumed Turn to acting so it can be interrupted. */
    private driveTurnToActing(turn: Turn): Turn {
        let current = turn;
        if (current.state === "received") {
            current = this.applyEntity(() => this.ports.services.turn.transition(current.id, "interpreting", {
                expectedVersion: current.version,
                actor: "kernel:budget",
            }));
        }
        if (current.state === "interpreting" || current.state === "resumed") {
            current = this.applyEntity(() => this.ports.services.turn.act(current.id, {
                expectedVersion: current.version,
                actor: "kernel:budget",
            }));
        }
        return current;
    }

    /** Rehydrates the decision ledger from the durable `budget_ledger` events. */
    private restoreBudgetDecisions(): void {
        if (this.budgetDecisionList.length > 0) return;
        for (const record of this.store.events()) {
            if (record.entityId !== undefined && record.entityId !== this.budgetKey) continue;
            const payload = record.payload;
            if (!isRecord(payload) || !isRecord(payload.data)) continue;
            const decision = payload.data.decision;
            if (!isRecord(decision) || decision.reason !== "budget_exhausted") continue;
            if (typeof decision.nodeId !== "string" || typeof decision.dimension !== "string"
                || typeof decision.scope !== "string" || typeof decision.action !== "string"
                || typeof decision.applied !== "boolean" || typeof decision.at !== "string") continue;
            this.budgetDecisionList.push(decision as unknown as BudgetExhaustionDecision);
        }
    }

    private persistBudgetDecision(decision: BudgetExhaustionDecision): void {
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
            this.persistence.append("budget_ledger.decided", this.budgetKey, {
                entityKind: "budget_ledger",
                entityId: this.budgetKey,
                version,
                data: { decision },
            });
        });
        this.budgetVersion = version;
    }

    private consumeBudget(input: ConsumeBudgetInput): ConsumeBudgetResult {
        let rethrow: BudgetError | undefined;
        const result = this.store.transaction((): ConsumeBudgetResult => {
            const nodeId = this.resolveBudgetNode(input);
            if (input.turnId !== undefined && nodeId === input.turnId) {
                const turn = this.ports.workflow.find("turn", input.turnId);
                if (turn.isEmpty()) throw new KernelError("not_found", `turn ${input.turnId} does not exist`);
                const acting = this.driveTurnToActing(turn.get());
                if (acting.state !== "acting") {
                    throw new KernelError("invalid_state", `turn ${acting.id} is ${acting.state}; budget cannot be consumed while acting`);
                }
            }
            try {
                const snapshot = input.mode === "reserve"
                    ? this.ports.budgetTree.reserve(nodeId, input.usage)
                    : this.ports.budgetTree.consume(nodeId, input.usage);
                return {
                    consumed: true,
                    nodeId,
                    usage: input.usage,
                    snapshot,
                    remaining: this.ports.budgetTree.remaining(nodeId),
                };
            } catch (error) {
                if (!(error instanceof BudgetError) || error.code !== "budget_exhausted") throw error;
                const matching = [...this.budgetDecisionList].reverse().filter(item => item.nodeId === nodeId);
                const decision = matching.find(item => item.applied)
                    ?? matching[0]
                    ?? [...this.budgetDecisionList].reverse()[0];
                if (input.throwOnExhausted === true) rethrow = error;
                return {
                    consumed: false,
                    nodeId,
                    usage: input.usage,
                    ...(decision === undefined ? {} : { decision }),
                    error: { code: "budget_exhausted", message: error.message },
                };
            }
        });
        if (rethrow !== undefined) throw rethrow;
        return result;
    }

    /**
     * A flat `BudgetLedger` refusal is propagated through the same decision
     * path when hierarchical budgeting is enabled: the origin Turn is
     * interrupted, or its Session starts closing.
     */
    private propagateLedgerExhaustion(input: StartActionInput, error: BudgetError): void {
        if (error.code !== "budget_exhausted" && error.code !== "limit_exceeded") return;
        if (this.budgetConfig === undefined) return;
        const turnNode = this.actionTurnNode(input);
        if (turnNode !== undefined) {
            this.handleBudgetExhausted(turnNode, "calls");
            return;
        }
        const sessionId = this.ports.workflow.get("task", input.taskId).sessionId;
        this.handleBudgetExhausted(sessionId, "calls");
    }

    private resolveBudgetNode(input: ConsumeBudgetInput): Identifier {
        const tree = this.ports.budgetTree;
        if (input.nodeId !== undefined) {
            if (tree.has(input.nodeId)) return input.nodeId;
            if (input.limit !== undefined) {
                tree.addRoot(input.nodeId, input.limit);
                return input.nodeId;
            }
            throw new KernelError("invalid_input", `budget node ${input.nodeId} does not exist; pass limit to create it`);
        }
        if (input.turnId !== undefined) {
            if (tree.has(input.turnId)) return input.turnId;
            const turn = this.ports.workflow.find("turn", input.turnId);
            if (turn.isEmpty()) throw new KernelError("not_found", `turn ${input.turnId} does not exist`);
            const limit = input.limit ?? this.budgetConfig?.turn ?? turn.get().budget;
            if (limit === undefined) {
                throw new KernelError("invalid_input", `turn ${input.turnId} has no budget node; pass limit to create it`);
            }
            if (!tree.has(turn.get().sessionId)) {
                tree.addRoot(turn.get().sessionId, this.budgetConfig?.session ?? unlimitedBudget());
            }
            tree.allocate(turn.get().sessionId, input.turnId, limit);
            return input.turnId;
        }
        if (input.sessionId !== undefined) {
            if (tree.has(input.sessionId)) return input.sessionId;
            const session = this.ports.workflow.find("session", input.sessionId);
            const limit = input.limit ?? this.budgetConfig?.session ?? (session.isPresent() ? session.get().budget : undefined);
            if (limit === undefined) {
                throw new KernelError("invalid_input", `session ${input.sessionId} has no budget node; pass limit to create it`);
            }
            tree.addRoot(input.sessionId, limit);
            return input.sessionId;
        }
        throw new KernelError("invalid_input", "consumeBudget requires nodeId, turnId or sessionId");
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
        if (existing.isPresent()) {
            this.ensureSessionBudgetNode(input.sessionId, input.budget);
            return existing.get();
        }
        this.ensureSessionBudgetNode(input.sessionId, input.budget);
        const actor = this.actorOf(input);
        const created = this.applyEntity(() => this.ports.services.session.create({
            id: input.sessionId,
            sessionId: input.sessionId,
            participants: [...(input.participants ?? [])],
            ...(input.sessionType === undefined ? {} : { sessionType: input.sessionType }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            ...(input.budget === undefined ? {} : { budget: input.budget }),
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
        this.allocateTurnBudget(sessionId, input.turnId, input.budget);
        const turn = this.applyEntity(() => this.ports.services.turn.create({
            id: input.turnId,
            sessionId,
            classification: input.classification ?? "new_intent",
            ...(input.budget === undefined ? {} : { budget: input.budget }),
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
        let reservation: BudgetReservation;
        try {
            reservation = this.reserveBudget(input.operationId, input.budget ?? { calls: 1 });
        } catch (error) {
            if (error instanceof BudgetError) this.propagateLedgerExhaustion(input, error);
            throw error;
        }
        try {
            // The Action node is allocated from the Turn node. A refusal fires
            // the tree observer (Turn -> interrupted) and reaches the caller as
            // the stable `budget_exhausted` error after the reservation is freed.
            this.allocateActionBudget(input, attemptId);
        } catch (error) {
            this.releaseBudget(input.operationId);
            throw error;
        }
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

    /* -------------------------------------------------------------- */
    /* Session / Turn closure receipts                                */
    /* -------------------------------------------------------------- */

    /**
     * Stable identity of a closure receipt. The Session and each of its Turns
     * own exactly one receipt, so `closeSession` can be replayed without
     * issuing a second one.
     */
    private closureReceiptId(kind: ClosureReceiptKind, entityId: Identifier): Identifier {
        return kind === "session_receipt" ? `receipt:session:${entityId}` : `receipt:turn:${entityId}`;
    }

    /**
     * Workspace coordinates available to the kernel. The configured workspace
     * root is the only anchor the kernel owns; snapshot/change data is host
     * state and stays absent until a host supplies it.
     */
    private closureWorkspaceAnchor(): WorkspaceAnchor | undefined {
        const workspaceId = this.ports.workspace.rootId;
        return typeof workspaceId === "string" && workspaceId.length > 0 ? { workspaceId } : undefined;
    }

    /**
     * Point-in-time summary of the receipt scope. Entity counts cover the whole
     * Session; the event count narrows to the Turn when `turnId` is supplied.
     * The budget value is the settled ledger usage for the tenant/root key.
     */
    private closureSummary(sessionId: Identifier, turnId?: Identifier): ClosureReceiptSummary {
        const workflow = this.ports.workflow.snapshot();
        const counts: Record<WorkflowKind, number> = {
            session: 0, turn: 0, intent: 0, mission: 0, goal: 0, plan: 0, task: 0, action: 0,
        };
        const entities = workflow.entities.filter(entity => entity.sessionId === sessionId);
        for (const entity of entities) counts[entity.kind] += 1;
        const scope = new Set<string>();
        for (const entity of entities) {
            const inScope = turnId === undefined
                || (entity.kind === "turn" && entity.id === turnId)
                || entity.originTurnId === turnId;
            if (inScope) scope.add(`${entity.kind}:${entity.id}`);
        }
        const eventCount = workflow.events.filter(event => scope.has(`${event.entityKind}:${event.entityId}`)).length;
        const budgetSnapshot = this.ports.budget.snapshot(this.budgetKey);
        return {
            sessionId,
            ...(turnId === undefined ? {} : { turnId }),
            entityCounts: counts,
            eventCount,
            budget: { ...budgetSnapshot.settled },
            budgetSnapshot,
        };
    }

    /**
     * Creates, digests and persists one closure receipt plus its
     * `receipt.created` event, reusing the receipt port's own constructors.
     * Returns the stored receipt when the identity already exists, which is
     * what makes repeated closes idempotent. The caller supplies the enclosing
     * store transaction (the close path), so a failure rolls everything back.
     */
    private issueClosureReceipt(
        kind: ClosureReceiptKind,
        sessionId: Identifier,
        entityId: Identifier,
        actor: Identifier,
    ): ClosureReceipt {
        const id = this.closureReceiptId(kind, entityId);
        const existing = this.receiptById(id);
        if (existing !== undefined) return existing as ClosureReceipt;
        const turnId = kind === "turn_receipt" ? entityId : undefined;
        const operationId = kind === "session_receipt" ? `session.close:${entityId}` : `turn.complete:${entityId}`;
        const summary = this.closureSummary(sessionId, turnId);
        const workspaceAnchor = this.closureWorkspaceAnchor();
        try {
            const invocation = this.ports.receipt.createInvocation({
                id: `invocation:${operationId}`,
                context: this.executionContext({
                    sessionId,
                    ...(turnId === undefined ? {} : { observedInTurnId: turnId }),
                    operationId,
                    attemptId: `${operationId}:attempt:1`,
                    executionId: operationId,
                    agentId: actor,
                    cancellationEpoch: kind === "session_receipt"
                        ? this.epochOf("session", entityId)
                        : this.epochOf("turn", entityId),
                }),
                toolId: kind === "session_receipt" ? "kernel.session.close" : "kernel.turn.complete",
                arguments: {
                    kind,
                    sessionId,
                    ...(turnId === undefined ? {} : { turnId }),
                },
                createdAt: this.clock(),
            });
            const observation = this.ports.receipt.createObservation({
                id: `${invocation.id}:observation`,
                invocationId: invocation.id,
                status: "success",
                value: summary as unknown as JsonValue,
                observedAt: this.clock(),
            });
            const input = {
                id,
                invocation,
                observation,
                issuedAt: this.clock(),
                payloadDigest: this.receiptDigest(invocation, observation),
                hashAlgorithm: "sha256",
                kind,
                sessionId,
                ...(turnId === undefined ? {} : { turnId }),
                ...(workspaceAnchor === undefined ? {} : { workspaceAnchor }),
                summary,
            } as unknown as ReceiptCoreInput;
            const receipt = this.ports.receipt.createReceiptCore(input) as ClosureReceipt;
            this.persistence.saveEntity("receipt", receipt, 1, sessionId);
            this.persistence.append("receipt.created", receipt.id, {
                entityKind: "receipt",
                entityId: receipt.id,
                data: {
                    receiptId: receipt.id,
                    kind,
                    sessionId,
                    ...(turnId === undefined ? {} : { turnId }),
                    summary,
                    ...(workspaceAnchor === undefined ? {} : { workspaceAnchor }),
                },
            });
            return receipt;
        } catch (error) {
            throw new KernelError(
                "receipt_error",
                `cannot issue ${kind} for ${kind === "session_receipt" ? "session" : "turn"} ${entityId}: ${messageOf(error)}`,
                error,
            );
        }
    }

    /**
     * Issues the Session receipt and one receipt for every closed Turn. Must be
     * called inside the store transaction that closes the Session so the
     * receipts and the closure facts commit or roll back together.
     */
    private issueClosureReceipts(
        session: Session,
        turns: readonly Turn[],
        actor: Identifier,
    ): Pick<CloseSessionResult, "sessionReceipt" | "turnReceipts" | "receipts"> {
        const turnReceipts: ClosureReceipt[] = [];
        for (const turn of turns) {
            if (!isWorkflowTerminal(turn)) continue;
            turnReceipts.push(this.issueClosureReceipt("turn_receipt", session.id, turn.id, actor));
        }
        const sessionReceipt = this.issueClosureReceipt("session_receipt", session.id, session.id, actor);
        return { sessionReceipt, turnReceipts, receipts: [sessionReceipt, ...turnReceipts] };
    }

    /** Caches committed closure receipts; only called after a transaction succeeds. */
    private cacheClosureReceipts(result: Pick<CloseSessionResult, "receipts">): void {
        for (const receipt of result.receipts) this.receiptCache.set(receipt.id, receipt);
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
    /* Project orchestration                                          */
    /* -------------------------------------------------------------- */

    private describeProject(): DescribeProjectResult {
        const project = this.ports.project;
        const plan = project.environmentPlan();
        return {
            tenantId: this.tenantId,
            rootId: this.rootId,
            ...(project.kind === undefined ? {} : { kind: project.kind }),
            environment: project.environment,
            variables: project.environment.variables,
            paths: project.environment.paths,
            dependencies: project.environment.dependencies,
            environmentVersion: project.environmentVersion,
            plan,
            description: project.describeEnvironment(),
            rules: project.listRules(),
            metadata: project.listMetadata(),
            views: project.listViews(),
            ready: plan.ready,
        };
    }

    /**
     * Applies environment/rule/metadata edits through the `Project` API and
     * mirrors them into `project_environment` / `project_rule` (and metadata)
     * inside one store transaction. Unchanged input is an idempotent no-op.
     */
    private configureProject(patch: ConfigureProjectPatch): ConfigureProjectResult {
        const raw: unknown = patch;
        const directEnvironment = isEnvironmentPatchInput(raw);
        const input: ConfigureProjectInput = directEnvironment ? { environment: raw as EnvironmentPatch } : patch as ConfigureProjectInput;
        const environmentPatch = directEnvironment
            ? raw as EnvironmentPatch
            : input.environment ?? input.patch ?? this.topLevelEnvironmentPatch(raw);
        const project = this.ports.project;
        const expectedEnvironmentVersion = input.expectedEnvironmentVersion ?? input.expectedVersion;

        if (expectedEnvironmentVersion !== undefined
            && expectedEnvironmentVersion !== project.environmentVersion) {
            throw new KernelError(
                "version_conflict",
                `project environment expected version ${expectedEnvironmentVersion}, current ${project.environmentVersion}`,
            );
        }

        if (environmentPatch !== undefined) {
            try {
                validateEnvironment(mergeEnvironment(project.environment, environmentPatch));
            } catch (error) {
                throw new KernelError("invalid_project", `invalid project environment patch: ${messageOf(error)}`, error);
            }
        }

        const changedRules: KernelProjectRuleInput[] = [];
        const seenRules = new Set<string>();
        for (const rule of input.rules ?? []) {
            if (typeof rule?.id !== "string" || rule.id.trim() === "" || typeof rule.text !== "string" || rule.text === "") {
                throw new KernelError("invalid_input", "project rules require a non-empty id and text");
            }
            if (seenRules.has(rule.id)) throw new KernelError("invalid_input", `duplicate project rule ${rule.id}`);
            seenRules.add(rule.id);
            const existing = project.getRule(rule.id);
            if (rule.expectedVersion !== undefined) {
                if (existing === undefined || existing.version !== rule.expectedVersion) {
                    throw new KernelError(
                        "version_conflict",
                        `project rule ${rule.id} expected version ${rule.expectedVersion}, current ${existing?.version ?? "missing"}`,
                    );
                }
            }
            if (existing === undefined || existing.text !== rule.text || existing.source !== rule.source) {
                changedRules.push(rule);
            }
        }

        const changedMetadata: KernelProjectMetadataInput[] = [];
        const seenMetadata = new Set<string>();
        for (const entry of input.metadata ?? []) {
            if (typeof entry?.path !== "string" || entry.path.trim() === "") {
                throw new KernelError("invalid_input", "project metadata requires a non-empty path");
            }
            if (seenMetadata.has(entry.path)) throw new KernelError("invalid_input", `duplicate project metadata ${entry.path}`);
            seenMetadata.add(entry.path);
            const existing = project.getMetadata(entry.path);
            if (entry.expectedVersion !== undefined) {
                if (existing === undefined || existing.version !== entry.expectedVersion) {
                    throw new KernelError(
                        "version_conflict",
                        `project metadata ${entry.path} expected version ${entry.expectedVersion}, current ${existing?.version ?? "missing"}`,
                    );
                }
            }
            const tags = [...(entry.tags ?? [])];
            const ruleIds = [...(entry.ruleIds ?? [])];
            const unchanged = existing !== undefined
                && existing.kind === entry.kind
                && stableJson(existing.tags) === stableJson(tags)
                && stableJson(existing.ruleIds) === stableJson(ruleIds);
            if (!unchanged) changedMetadata.push(entry);
        }

        const nextEnvironment = environmentPatch === undefined
            ? undefined
            : mergeEnvironment(project.environment, environmentPatch);
        const environmentChanged = nextEnvironment !== undefined
            && stableJson(nextEnvironment) !== stableJson(project.environment);

        if (changedRules.length === 0 && changedMetadata.length === 0 && !environmentChanged) {
            const described = this.describeProject();
            return {
                ...described,
                applied: false,
                environmentChanged: false,
                rulesChanged: [],
                metadataChanged: [],
                events: [],
            };
        }

        const before = this.store.events().length;
        try {
            this.store.transaction(() => {
                for (const rule of changedRules) {
                    this.projectBinding.putRule({
                        id: rule.id,
                        tenantId: this.tenantId,
                        rootId: this.rootId,
                        text: rule.text,
                        ...(rule.source === undefined ? {} : { source: rule.source }),
                        ...(rule.expectedVersion === undefined ? {} : { expectedVersion: rule.expectedVersion }),
                    });
                }
                for (const entry of changedMetadata) {
                    this.projectBinding.putMetadata({
                        path: entry.path,
                        tenantId: this.tenantId,
                        rootId: this.rootId,
                        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
                        tags: [...(entry.tags ?? [])],
                        ruleIds: [...(entry.ruleIds ?? [])],
                        ...(entry.expectedVersion === undefined ? {} : { expectedVersion: entry.expectedVersion }),
                    });
                }
                if (environmentChanged && environmentPatch !== undefined) {
                    this.projectBinding.configureEnvironment(environmentPatch, {
                        ...(expectedEnvironmentVersion === undefined
                            ? {}
                            : { expectedVersion: expectedEnvironmentVersion }),
                    });
                }
            });
        } catch (error) {
            this.restoreProjectAfterRollback();
            throw error;
        }
        const events = this.store.events().slice(before).map(event => event.kind);
        const described = this.describeProject();
        return {
            ...described,
            applied: true,
            environmentChanged,
            rulesChanged: changedRules.map(rule => rule.id),
            metadataChanged: changedMetadata.map(entry => entry.path),
            events,
        };
    }

    /** Extracts environment keys from a configuration object that also carries rules. */
    private topLevelEnvironmentPatch(value: unknown): EnvironmentPatch | undefined {
        if (!isRecord(value)) return undefined;
        const { variables, paths, dependencies } = value;
        if (variables === undefined && paths === undefined && dependencies === undefined) return undefined;
        return {
            ...(variables === undefined ? {} : { variables: variables as Readonly<Record<string, string>> }),
            ...(paths === undefined ? {} : { paths: paths as readonly string[] }),
            ...(dependencies === undefined ? {} : { dependencies: dependencies as EnvironmentPatch["dependencies"] }),
        };
    }

    /**
     * Rewinds the in-memory Project to the durable rows after a failed
     * transaction. The kernel-owned Project is rebuilt from its construction
     * options and rehydrated; a host-supplied instance is rehydrated in place.
     */
    private restoreProjectAfterRollback(): void {
        try {
            if (!this.ownsProject) {
                this.projectBinding.rehydrate();
                return;
            }
            const project = new Project({
                ...(this.projectOptions ?? {}),
                tenantId: this.tenantId,
                rootId: this.rootId,
                clock: this.clock,
            });
            const binding = bindProject(this.store, project);
            binding.rehydrate();
            this.ports = { ...this.ports, project };
            this.projectBinding = binding;
        } catch {
            /* Preserve the original operation failure; the next read still sees the store. */
        }
    }

    /* -------------------------------------------------------------- */
    /* Workspace file orchestration                                   */
    /* -------------------------------------------------------------- */

    private openWorkspaceFile(pathOrInput: Identifier | OpenWorkspaceFileInput, mode?: WorkspaceMode): OpenedWorkspaceFile {
        const input: OpenWorkspaceFileInput = typeof pathOrInput === "string"
            ? { path: pathOrInput, ...(mode === undefined ? {} : { mode }) }
            : pathOrInput;
        const requested = input.mode ?? "read-only";
        return this.store.transaction(() => {
            const mounted = this.mountWorkspaceFile(input.path, requested, true, input.sessionId, input.turnId);
            return mounted.result;
        });
    }

    private readFile(pathOrInput: Identifier | ReadFileInput, options: ReadFileOptions | FileRange = {}): ReadFileResult {
        const input: ReadFileInput = typeof pathOrInput !== "string"
            ? pathOrInput
            : isFileRange(options)
                ? { path: pathOrInput, range: options }
                : { path: pathOrInput, ...(options as ReadFileOptions) };
        const mounted = this.store.transaction(() => this.mountWorkspaceFile(
            input.path,
            input.mode ?? "read-only",
            false,
            input.sessionId,
            input.turnId,
        ));
        const file = mounted.file;
        const content = file.read(input.range, input.allowStale === true ? { allowStale: true } : {});
        const snapshot = file.snapshot();
        return {
            ...snapshot,
            content,
            text: content,
            snapshot,
            opened: mounted.opened,
            ...(mounted.mountReceipt === undefined ? {} : { mountReceipt: mounted.mountReceipt }),
        };
    }

    private writeFile(
        pathOrInput: Identifier | WriteFileInput,
        contentOrOptions?: string | WriteFileOptions,
        options: WriteFileOptions = {},
    ): WriteFileResult {
        const input = this.normalizeWriteInput(pathOrInput, contentOrOptions, options);
        if (input.mode === "read-only") {
            throw new KernelError("read_only", `writeFile cannot write ${input.path} in read-only mode`);
        }
        const mounted = this.mountWorkspaceFile(input.path, "writable", false, input.sessionId, input.turnId);
        const file = mounted.file;
        const sessionId = input.sessionId;
        const turnId = input.turnId;
        try {
            return this.store.transaction(() => {
                const before = file.snapshot();
                const editOptions = {
                    ...(input.expectedBufferVersion === undefined ? {} : { expectedBufferVersion: input.expectedBufferVersion }),
                    ...(input.expectedBaseHash === undefined ? {} : { expectedBaseHash: input.expectedBaseHash }),
                };
                file.write(input.content, input.target, editOptions);
                const flushed = file.flush(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey });
                const receipt = this.fileOperationReceipt("flush", input.path, flushed);
                const record = this.recordFileOperation("flush", receipt, sessionId, turnId);
                const receipts = mounted.mountReceipt === undefined
                    ? [receipt]
                    : [mounted.mountReceipt, receipt];
                const changed = before.baseHash !== flushed.baseHash || before.bufferVersion !== flushed.bufferVersion;
                return {
                    ...flushed,
                    content: input.content,
                    snapshot: flushed,
                    receipt,
                    receipts,
                    receiptRecord: record.receipt,
                    receiptKind: FILE_RECEIPT_KIND.flush,
                    evidence: record.evidence,
                    verification: record.verification,
                    integrity: record.integrity,
                    idempotent: !record.created,
                    changed,
                };
            });
        } catch (error) {
            if (file.dirty) {
                try {
                    file.reload({ discardDirty: true });
                } catch {
                    /* the durable base may already have moved */
                }
            }
            throw error;
        }
    }

    private closeWorkspaceFile(pathOrInput: Identifier | CloseWorkspaceFileInput): CloseWorkspaceFileResult {
        const input: CloseWorkspaceFileInput = typeof pathOrInput === "string" ? { path: pathOrInput } : pathOrInput;
        return this.closeWorkspaceFileInternal(input);
    }

    private closeWorkspaceFileInternal(input: CloseWorkspaceFileInput): CloseWorkspaceFileResult {
        const file = this.openFiles.get(input.path);
        if (file === undefined) return { path: input.path, closed: false };
        const snapshot = file.snapshot();
        let receipt: FileOperationReceipt | undefined;
        let record: FileOperationRecord | undefined;
        try {
            this.store.transaction(() => {
                file.unmount({ discardDirty: input.discardDirty === true });
                receipt = this.fileOperationReceipt("unmount", input.path, snapshot);
                record = this.recordFileOperation("unmount", receipt, input.sessionId, input.turnId);
            });
        } catch (error) {
            // The file itself may already be unmounted even when its receipt
            // could not be committed; drop the stale handle so a retry remounts.
            if (file.state === "unmounted") {
                this.openFiles.delete(input.path);
                this.openFileResults.delete(input.path);
                this.lockedReadOnlyFiles.delete(input.path);
            }
            throw error;
        }
        this.openFiles.delete(input.path);
        this.openFileResults.delete(input.path);
        this.lockedReadOnlyFiles.delete(input.path);
        return {
            path: input.path,
            closed: true,
            snapshot,
            ...(receipt === undefined ? {} : { receipt }),
            ...(record === undefined
                ? {}
                : {
                    receiptRecord: record.receipt,
                    receiptKind: FILE_RECEIPT_KIND.unmount,
                    evidence: record.evidence,
                }),
        };
    }

    private normalizeWriteInput(
        pathOrInput: Identifier | WriteFileInput,
        contentOrOptions: string | WriteFileOptions | undefined,
        options: WriteFileOptions,
    ): WriteFileInput {
        if (typeof pathOrInput !== "string") return pathOrInput;
        if (typeof contentOrOptions === "string") {
            return { path: pathOrInput, content: contentOrOptions, ...options };
        }
        if (isRecord(contentOrOptions) && typeof contentOrOptions.content === "string") {
            return { ...contentOrOptions, path: pathOrInput, ...options } as WriteFileInput;
        }
        return { path: pathOrInput, content: "", ...options };
    }

    /**
     * Mounts and activates a file. Existing handles are reused; a read-only
     * auto-mount may be upgraded for a write, an explicitly opened read-only
     * file may not. A mount receipt is recorded exactly once per mount.
     */
    private mountWorkspaceFile(
        path: Identifier,
        mode: WorkspaceMode,
        explicit: boolean,
        sessionId?: Identifier,
        turnId?: Identifier,
    ): { readonly file: WorkspaceFile; readonly result: OpenedWorkspaceFile; readonly opened: boolean; readonly mountReceipt?: FileOperationReceipt } {
        if (mode === "writable" && this.lockedReadOnlyFiles.has(path)) {
            throw new KernelError("read_only", `file ${path} was opened read-only and cannot be written`);
        }
        const existing = this.openFiles.get(path);
        if (existing !== undefined) {
            if (mode === "writable" && existing.mode !== "writable") {
                this.unmountForUpgrade(path, existing);
            } else {
                const result = this.openFileResults.get(path);
                if (result !== undefined) {
                    if (explicit && mode === "read-only") this.lockedReadOnlyFiles.add(path);
                    const snapshot = existing.snapshot();
                    return {
                        file: existing,
                        result: {
                            ...result,
                            ...snapshot,
                            snapshot,
                            mode: mode === "read-only" ? "read-only" : snapshot.mode,
                            idempotent: true,
                        },
                        opened: false,
                    };
                }
            }
        }
        // Validate the path through the workspace before touching storage.
        this.ports.workspace.file(path, { mode });
        if (mode === "writable") this.ensureWritableSource(path);
        const file = this.ports.workspace.file(path, { mode });
        try {
            file.mount();
            file.activate();
        } catch (error) {
            try {
                if (file.state !== "unmounted") file.unmount({ discardDirty: true });
            } catch {
                /* preserve the mount failure */
            }
            throw error;
        }
        const snapshot = file.snapshot();
        const receipt = this.fileOperationReceipt("mount", path, snapshot);
        let record: FileOperationRecord;
        try {
            record = this.store.transaction(() => this.recordFileOperation("mount", receipt, sessionId, turnId));
        } catch (error) {
            try {
                file.unmount({ discardDirty: true });
            } catch {
                /* preserve the receipt failure */
            }
            throw error;
        }
        const result: OpenedWorkspaceFile = {
            ...snapshot,
            snapshot,
            file,
            handle: file,
            receipt,
            receiptRecord: record.receipt,
            receiptKind: FILE_RECEIPT_KIND.mount,
            evidence: record.evidence,
            idempotent: false,
        };
        this.openFiles.set(path, file);
        this.openFileResults.set(path, result);
        if (explicit && mode === "read-only") this.lockedReadOnlyFiles.add(path);
        else if (mode === "writable") this.lockedReadOnlyFiles.delete(path);
        return { file, result, opened: true, mountReceipt: receipt };
    }

    /** Re-mounts a non-locked read-only handle as writable, recording the unmount. */
    private unmountForUpgrade(path: Identifier, file: WorkspaceFile): void {
        if (file.dirty) throw new KernelError("dirty", `file ${path} has uncommitted changes`);
        const snapshot = file.snapshot();
        try {
            this.store.transaction(() => {
                file.unmount();
                const receipt = this.fileOperationReceipt("unmount", path, snapshot);
                this.recordFileOperation("unmount", receipt, undefined, undefined);
            });
        } catch (error) {
            if (file.state === "unmounted") {
                this.openFiles.delete(path);
                this.openFileResults.delete(path);
                this.lockedReadOnlyFiles.delete(path);
            }
            throw error;
        }
        this.openFiles.delete(path);
        this.openFileResults.delete(path);
        this.lockedReadOnlyFiles.delete(path);
    }

    /** Host-side creation hook used only when a writable open targets a missing file. */
    private ensureWritableSource(path: Identifier): void {
        const ref: FileRef = { tenantId: this.tenantId, rootId: this.rootId, path };
        try {
            if (this.ports.workspace.storage.read(ref) !== undefined) return;
        } catch (error) {
            if (error instanceof WorkspaceError && error.code === "binary_file") return;
        }
        const storage = this.ports.workspace.storage as unknown as {
            put?: (value: FileRef, content: string) => unknown;
        };
        if (typeof storage.put === "function") storage.put(ref, "");
    }

    private fileOperationReceipt(kind: FileOperationKind, path: Identifier, snapshot: FileSnapshot): FileOperationReceipt {
        const workspace = this.ports.workspace;
        return Object.freeze({
            tenantId: workspace.tenantId,
            rootId: workspace.rootId,
            path,
            kind,
            version: snapshot.version,
            hash: snapshot.baseHash,
            at: this.clock(),
            workspaceAnchor: Object.freeze({ tenantId: workspace.tenantId, rootId: workspace.rootId }),
        });
    }

    /**
     * Records one `FileOperationReceipt` as a full receipt/verification/
     * evidence chain. The deterministic identity (`kind + path + version +
     * hash`) makes a replay return the existing chain instead of duplicating it.
     */
    private recordFileOperation(
        kind: FileOperationKind,
        operation: FileOperationReceipt,
        sessionId?: Identifier,
        turnId?: Identifier,
    ): FileOperationRecord {
        const ref: FileRef = { tenantId: this.tenantId, rootId: this.rootId, path: operation.path };
        const receiptId = fileReceiptId(kind, ref, operation.version, operation.hash);
        const claim = fileClaim(kind, operation.path);
        const criteriaVersion = "kernel/file/1";
        const existing = this.receiptById(receiptId);
        const contextSession = sessionId ?? this.currentSessionId();
        let created = false;
        let receipt: ReceiptCore;
        if (existing === undefined) {
            const invocationId = `invocation:${receiptId}`;
            const invocation = this.ports.receipt.createInvocation({
                id: invocationId,
                context: this.executionContext({
                    sessionId: contextSession,
                    ...(turnId === undefined ? {} : { observedInTurnId: turnId }),
                    operationId: receiptId,
                    attemptId: `${receiptId}:attempt:1`,
                    executionId: receiptId,
                    cancellationEpoch: 0,
                    agentId: "kernel:file",
                }),
                toolId: `kernel.file.${kind}`,
                arguments: {
                    path: operation.path,
                    mode: kind,
                    version: operation.version,
                    hash: operation.hash,
                } as unknown as JsonValue,
                createdAt: this.clock(),
            });
            const observation = this.ports.receipt.createObservation({
                id: `${invocationId}:observation`,
                invocationId,
                status: "success",
                value: {
                    path: operation.path,
                    kind,
                    version: operation.version,
                    hash: operation.hash,
                    workspace: operation.workspaceAnchor,
                } as unknown as JsonValue,
                observedAt: this.clock(),
            });
            receipt = this.ports.receipt.createReceiptCore({
                id: receiptId,
                invocation,
                observation,
                issuedAt: this.clock(),
                payloadDigest: this.receiptDigest(invocation, observation),
                hashAlgorithm: "sha256",
                kind: FILE_RECEIPT_KIND[kind],
                sessionId: contextSession,
                ...(turnId === undefined ? {} : { turnId }),
                workspaceAnchor: {
                    workspaceId: this.ports.workspace.rootId,
                    affectedFiles: [operation.path],
                    ...(operation.hash === "" ? {} : { changeHash: operation.hash }),
                },
            });
            created = true;
        } else {
            receipt = existing;
        }

        let integrity = this.integrityForReceipt(receipt.id);
        let integrityCreated = false;
        if (integrity === undefined) {
            integrity = Object.freeze({
                id: fileIntegrityId(receipt.id),
                receiptId: receipt.id,
                status: "integrity_verified" as const,
                digestValid: true,
                signatureValid: "not_checked" as const,
                verifier: "kernel:file",
                verifiedAt: this.clock(),
                reasons: Object.freeze([] as string[]),
            });
            integrityCreated = true;
        }
        let verification = this.verificationById(fileVerificationId(receipt.id));
        let verificationCreated = false;
        if (verification === undefined) {
            verification = Object.freeze({
                id: fileVerificationId(receipt.id),
                observationId: receipt.observation.id,
                receiptId: receipt.id,
                status: "semantic_verified" as const,
                claims: Object.freeze([claim]),
                criteriaVersion,
                verifier: "kernel:file",
                verifiedAt: this.clock(),
            });
            verificationCreated = true;
        }
        const evidenceId = fileEvidenceId(receipt.id);
        let evidence = this.evidenceById(evidenceId);
        const evidenceCreated = evidence === undefined;
        if (created || integrityCreated || verificationCreated || evidenceCreated) {
            this.store.transaction(() => {
                if (created) {
                    this.persistence.saveEntity("receipt", receipt, 1, receipt.sessionId);
                    this.persistence.append("receipt.issued", receipt.id, {
                        entityKind: "receipt",
                        entityId: receipt.id,
                        data: {
                            receiptId: receipt.id,
                            kind: receipt.kind,
                            fileKind: kind,
                            path: operation.path,
                            version: operation.version,
                            hash: operation.hash,
                        },
                    });
                }
                if (integrityCreated) {
                    this.persistence.saveEntity("receipt_integrity", integrity, 1, receipt.sessionId);
                    this.persistence.append("receipt.integrity_verified", integrity.id, {
                        entityKind: "receipt_integrity",
                        entityId: integrity.id,
                        data: { receiptId: receipt.id, status: integrity.status },
                    });
                }
                if (verificationCreated) {
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
                }
                if (evidenceCreated) {
                    try {
                        evidence = this.ports.evidence.add({
                            id: evidenceId,
                            tenantId: this.tenantId,
                            claim,
                            polarity: "supports",
                            receipt,
                            integrity,
                            verification,
                            criteriaVersion,
                            environmentVersion: "kernel/1",
                            createdAt: this.clock(),
                            source: {
                                type: "operation_history",
                                reliability: 1,
                                origin: "original",
                                reproducible: true,
                                independenceKey: receipt.id,
                            },
                            level: "action",
                            ...((sessionId ?? receipt.sessionId) === undefined ? {} : { sessionId: sessionId ?? receipt.sessionId }),
                            ...((turnId ?? receipt.turnId) === undefined ? {} : { turnId: turnId ?? receipt.turnId }),
                        });
                    } catch (error) {
                        throw new KernelError("evidence_error", `cannot record ${kind} receipt ${receipt.id}: ${messageOf(error)}`, error);
                    }
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
                }
            });
        }
        if (evidence === undefined) {
            // The receipt existed but its evidence chain was removed; surface the
            // inconsistency instead of returning an incomplete record.
            throw new KernelError("evidence_error", `file receipt ${receipt.id} has no evidence chain`);
        }
        this.receiptCache.set(receipt.id, receipt);
        this.integrityCache.set(integrity.id, integrity);
        this.verificationCache.set(verification.id, verification);
        this.evidenceCache.set(evidence.id, evidence);
        return { receipt, integrity, verification, evidence, created };
    }

    /** A real active/idle Session when one exists, otherwise a workspace-scoped identity. */
    private currentSessionId(): Identifier {
        const sessions = this.ports.workflow.list("session").filter(session => session.state === "active" || session.state === "idle");
        const latest = sessions[sessions.length - 1];
        return latest?.id ?? `workspace:${this.rootId}`;
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
        const actor = this.actorOf(input);
        if (["closed", "archived", "expired", "aborted"].includes(session.state)) {
            // A replay still owes the caller the canonical receipts, but the
            // closure already committed, so this is a plain idempotent read (or
            // backfill) rather than a closing transaction.
            const turns = this.ports.workflow.list("turn", session.id);
            const result = this.store.transaction(() => this.issueClosureReceipts(session, turns, actor));
            this.cacheClosureReceipts(result);
            return { session, turns, cancelled: [], ...result };
        }
        if (input.expectedVersion !== undefined && session.version !== input.expectedVersion) {
            throw new KernelError("version_conflict", `session ${session.id} expected version ${input.expectedVersion}, current ${session.version}`);
        }
        const attempts = this.ports.workflow.snapshot().attempts.filter(attempt => attempt.sessionId === session.id
            && (attempt.state === "running" || attempt.state === "unknown_outcome"));
        if (attempts.length > 0) {
            throw new KernelError("unsettled_work", `session ${session.id} has ${attempts.length} unsettled attempt(s)`);
        }
        const abandon = input.abandonOpenWork !== false;
        if (!abandon && this.hasOpenBusinessWork(session.id)) {
            throw new KernelError("unsettled_work", `session ${session.id} still has open business work`);
        }
        // The closure facts and the Session/Turn receipts are one transaction:
        // any failure rolls the persisted close back instead of leaving a
        // closed Session without its receipts.
        let result: CloseSessionResult;
        try {
            result = this.store.transaction(() => {
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
                const receipts = this.issueClosureReceipts(current, turns, actor);
                return { session: current, turns, cancelled, ...receipts };
            });
        } catch (error) {
            // The store rolled the persisted closure back; rewind the in-memory
            // writer to the same durable state before surfacing the failure.
            try {
                this.restoreWorkflowAfterRollback();
            } catch {
                // Preserve the original close failure; the next read still
                // reports the durable state through the store.
            }
            throw error;
        }
        this.cacheClosureReceipts(result);
        return result;
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
