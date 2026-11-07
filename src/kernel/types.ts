/**
 * Kernel contracts: the composition root that binds the workflow writer, the
 * domain services, persistence, budget, attention/context, provenance and the
 * L6/L7 verification chain into one executable loop.
 *
 * The kernel owns orchestration only. Every business rule stays in its domain
 * module; the kernel declares the ports, the flow inputs/outputs and the stable
 * machine-readable failure codes.
 */

import type { Budget, BudgetUsage, ExecutionContext, Identifier, JsonValue } from "../shared.ts";
import type { Store } from "../service/store.ts";
import type { StoreStats } from "../service/types.ts";
import type { WorkflowStore } from "../workflow/store.ts";
import type {
    Acceptance,
    Action,
    ActionAttempt,
    InputClassification,
    ProgressBounds,
    RecoveryMode,
    WorkflowEntity,
    WorkflowErrorCode,
    WorkflowKind,
} from "../workflow/types.ts";
import type { Session, SessionType } from "../session/types.ts";
import type { Turn } from "../turn/types.ts";
import type { Intent } from "../intent/types.ts";
import type { Mission } from "../mission/types.ts";
import type { Goal } from "../goal/types.ts";
import type { Plan } from "../plan/types.ts";
import type { Task } from "../task/types.ts";
import type { SessionService } from "../session/service.ts";
import type { TurnService } from "../turn/service.ts";
import type { IntentService } from "../intent/service.ts";
import type { MissionService } from "../mission/service.ts";
import type { GoalService } from "../goal/service.ts";
import type { PlanService } from "../plan/service.ts";
import type { TaskService } from "../task/service.ts";
import type { ActionService } from "../action/service.ts";
import type { AttentionObject, AttentionPointer, CreateAttentionInput } from "../attention/types.ts";
import type { CompiledContext, ContextExclusion } from "../context/types.ts";
import type { BudgetErrorCode, BudgetLedger } from "../budget/ledger.ts";
import type { BudgetReservation, BudgetSnapshot, PolicyEnforcementPoint, AuthorizationAction, AuthorizationObject } from "../tool/types.ts";
import type { Evidence, EvidenceLevel, EvidenceSource, EvidenceStatus } from "../evidence/types.ts";
import type { EvidenceLedger } from "../evidence/ledger.ts";
import type {
    ExecutorProfile,
    Observation,
    ReceiptCore,
    ReceiptIntegrityVerification,
    ReceiptKind,
    WorkspaceAnchor,
} from "../receipt/types.ts";
import type { BusinessVerification, SemanticEvaluator } from "../verification/types.ts";
import type { Project } from "../project/core.ts";
import type { Workspace } from "../workspace/core.ts";

/* ------------------------------------------------------------------ */
/* Options and ports                                                   */
/* ------------------------------------------------------------------ */

/** Construction options for {@link Kernel}. */
export interface KernelOptions {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    /** A directory (the store file is created inside it) or an explicit `.sqlite` file. */
    readonly storePath?: string;
    /** Domain clock used for workflow entities, receipts, evidence and checkpoints. */
    readonly clock?: () => string;
    /** Concrete ledger limits for the tenant/root budget key; omitted means unlimited. */
    readonly budgetLimits?: Budget;
    /** Store clock for row `updated_at` / event `recorded_at`; defaults to `clock`. */
    readonly now?: () => string;
}

/** Typed command ports over the single {@link WorkflowStore} writer. */
export interface KernelServices {
    readonly session: SessionService;
    readonly turn: TurnService;
    readonly intent: IntentService;
    readonly mission: MissionService;
    readonly goal: GoalService;
    readonly plan: PlanService;
    readonly task: TaskService;
    readonly action: ActionService;
}

/** Pure attention operations (L2/L3); the kernel owns mounting and persistence. */
export type AttentionOperations = typeof import("../attention/operations.ts");
/** Context compiler (L4); the kernel owns the turn checkpoint. */
export type ContextOperations = typeof import("../context/compiler.ts");
/** Receipt core (L6); the kernel owns kernel-specific digesting and lifecycle. */
export type ReceiptOperations = typeof import("../receipt/core.ts");
/** Business verification (L6); the kernel owns criteria/evaluator wiring. */
export type VerificationOperations = typeof import("../verification/core.ts");

/**
 * Optional executor boundary. A host adapter can wrap `executor.ts` (manifests,
 * PEP, budget ledger and tool binding) behind this smaller request/observation
 * port. Returning an observation does not settle the action; `settleAction`
 * records the receipt, verification and evidence.
 */
export interface KernelExecutorPort {
    execute(request: KernelExecutionRequest): KernelExecutionResult | Promise<KernelExecutionResult>;
}

/** A fully resolved execution request, including the admitted action/task. */
export interface KernelExecutionRequest {
    readonly action: Action;
    readonly task: Task;
    readonly sessionId: Identifier;
    readonly operationId: Identifier;
    readonly attemptId: Identifier;
    readonly executionId: Identifier;
    readonly context: ExecutionContext;
    readonly budget: Budget;
}

/** Observation returned by an executor; it is deliberately not a receipt. */
export interface KernelExecutionResult {
    readonly observation: KernelObservationInput;
    readonly usage?: Budget;
}

/** All runtime singletons the kernel composes. */
export interface KernelPorts {
    readonly workflow: WorkflowStore;
    readonly services: KernelServices;
    readonly attention: AttentionOperations;
    readonly context: ContextOperations;
    readonly budget: BudgetLedger;
    readonly policy: PolicyEnforcementPoint;
    readonly executor: KernelExecutorPort | undefined;
    readonly evidence: EvidenceLedger;
    readonly receipt: ReceiptOperations;
    readonly verification: VerificationOperations;
    readonly project: Project;
    readonly workspace: Workspace;
    readonly store: Store;
}

/** Optional collaborators; production defaults are built by `createKernel`. */
export interface KernelOverrides {
    readonly executor?: KernelExecutorPort;
    readonly evaluate?: SemanticEvaluator;
    readonly policy?: PolicyEnforcementPoint;
    readonly project?: Project;
    readonly workspace?: Workspace;
    readonly attention?: AttentionOperations;
    readonly context?: ContextOperations;
    readonly receipt?: ReceiptOperations;
    readonly verification?: VerificationOperations;
}

/* ------------------------------------------------------------------ */
/* Stable kernel failures                                              */
/* ------------------------------------------------------------------ */

export type KernelErrorCode =
    | WorkflowErrorCode
    | BudgetErrorCode
    | "kernel_closed"
    | "invalid_input"
    | "invalid_state"
    | "idempotency_conflict"
    | "unsettled_work"
    | "verification_required"
    | "verification_rejected"
    | "policy_denied"
    | "execution_failed"
    | "evidence_error"
    | "receipt_error";

/** Machine-readable kernel failure; domain errors are translated at the boundary. */
export class KernelError extends Error {
    readonly code: KernelErrorCode;

    constructor(code: KernelErrorCode, message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "KernelError";
        this.code = code;
    }
}

/* ------------------------------------------------------------------ */
/* Flow inputs and outputs                                             */
/* ------------------------------------------------------------------ */

export interface StartSessionInput {
    readonly sessionId: Identifier;
    readonly participants?: readonly Identifier[];
    readonly sessionType?: SessionType;
    readonly expiresAt?: string;
    readonly actor?: Identifier;
    /** Defaults to true: create then activate so work can be admitted. */
    readonly activate?: boolean;
}

export interface BeginTurnInput {
    readonly turnId: Identifier;
    /** Defaults to the only active/idle session. */
    readonly sessionId?: Identifier;
    readonly classification?: InputClassification;
    readonly actor?: Identifier;
    /** Defaults to true: `received -> interpreting` so Intent capture is legal. */
    readonly interpret?: boolean;
}

export interface CaptureIntentInput {
    readonly intentId: Identifier;
    readonly turnId: Identifier;
    readonly text: string;
    readonly actor?: Identifier;
}

export interface ConfirmIntentInput {
    readonly intentId: Identifier;
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
}

export interface CreateMissionInput {
    readonly missionId: Identifier;
    readonly intentId: Identifier;
    readonly actor?: Identifier;
}

export interface CreateGoalInput {
    readonly goalId: Identifier;
    readonly missionId: Identifier;
    readonly contractVersion: string;
    readonly acceptanceCriteria: readonly string[];
    readonly actor?: Identifier;
}

/** One Task declaration inside a Plan; the DAG is fixed while the Plan is draft. */
export interface KernelTaskInput {
    readonly taskId: Identifier;
    readonly dependsOn?: readonly Identifier[];
    readonly required?: boolean;
    /** Defaults to the parent Goal's contract version. */
    readonly contractVersion?: string;
    readonly requiredEffects?: readonly string[];
}

export interface CreatePlanInput {
    readonly planId: Identifier;
    readonly goalId: Identifier;
    readonly bounds: ProgressBounds;
    readonly tasks: readonly KernelTaskInput[];
    readonly actor?: Identifier;
}

export interface CreatePlanResult {
    readonly plan: Plan;
    readonly tasks: readonly Task[];
}

export interface ReadyTasksInput {
    readonly planId: Identifier;
    /** Restrict readiness to these tasks; defaults to the whole Plan. */
    readonly taskIds?: readonly Identifier[];
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
}

export interface ReadyTasksResult {
    readonly plan: Plan;
    readonly tasks: readonly Task[];
    readonly ready: readonly Task[];
}

/** Optional policy request for `startAction`; the default PEP allows all. */
export interface KernelAuthorizationInput {
    readonly action: AuthorizationAction;
    readonly object: AuthorizationObject;
    readonly input?: JsonValue;
}

export interface StartActionInput {
    readonly actionId: Identifier;
    readonly taskId: Identifier;
    readonly operationId: Identifier;
    readonly effect: string;
    readonly originTurnId?: Identifier;
    readonly required?: boolean;
    readonly sideEffect?: boolean;
    readonly recovery?: RecoveryMode;
    readonly executionId?: Identifier;
    readonly attemptId?: Identifier;
    /** Amount reserved under the tenant/root budget key; defaults to `{ calls: 1 }`. */
    readonly budget?: Budget;
    readonly actor?: Identifier;
    readonly expectedTaskVersion?: number;
    readonly expectedActionVersion?: number;
    readonly principalId?: Identifier;
    readonly agentId?: Identifier;
    readonly policyVersion?: string;
    readonly authorize?: KernelAuthorizationInput;
    /** Per-call executor override; falls back to the kernel port. */
    readonly executor?: KernelExecutorPort;
}

export interface StartActionResult {
    readonly action: Action;
    readonly attempt: ActionAttempt;
    readonly reservation: BudgetReservation;
    /** True when an executor was invoked; its observation still needs `settleAction`. */
    readonly invoked: boolean;
    readonly execution?: KernelExecutionResult;
}

export interface KernelObservationInput {
    readonly status: "success" | "failure" | "unknown";
    readonly value?: JsonValue;
    readonly error?: string;
    readonly observedAt?: string;
    readonly digest?: string;
    readonly externalEffectId?: Identifier;
    readonly artifactVersions?: readonly string[];
    readonly id?: Identifier;
}

export interface KernelVerificationInput {
    readonly criteriaVersion?: string;
    readonly verifier?: string;
    readonly claims?: readonly string[];
    readonly evaluate?: SemanticEvaluator;
    readonly verificationId?: Identifier;
}

export interface KernelEvidenceInput {
    readonly evidenceId?: Identifier;
    readonly claim?: string;
    readonly polarity?: "supports" | "refutes";
    readonly level?: EvidenceLevel;
    readonly source?: EvidenceSource;
    readonly environmentVersion?: string;
    readonly expiresAt?: string;
    readonly dependsOn?: readonly Identifier[];
}

export interface SettleActionInput {
    readonly actionId: Identifier;
    readonly attemptId?: Identifier;
    readonly observation: KernelObservationInput;
    /** Actual usage; defaults to the full reservation. Must fit the reservation. */
    readonly usage?: Budget;
    readonly verification?: KernelVerificationInput;
    readonly evidence?: KernelEvidenceInput;
    readonly completeTask?: boolean;
    readonly completePlan?: boolean;
    readonly requireEvidence?: boolean;
    readonly actor?: Identifier;
    readonly expectedActionVersion?: number;
    readonly expectedAttemptVersion?: number;
}

export interface SettleActionResult {
    readonly action: Action;
    readonly attempt: ActionAttempt;
    readonly receipt: ReceiptCore;
    readonly verification: BusinessVerification;
    readonly evidence?: Evidence;
    readonly budget: BudgetSnapshot;
    readonly task?: Task;
    readonly plan?: Plan;
}

export interface RecordReceiptInput {
    readonly receiptId?: Identifier;
    readonly actionId: Identifier;
    readonly attemptId?: Identifier;
    readonly observation: KernelObservationInput;
    readonly principalId?: Identifier;
    readonly agentId?: Identifier;
    readonly policyVersion?: string;
    readonly toolId?: Identifier;
    readonly toolInput?: JsonValue;
    readonly idempotencyKey?: string;
    readonly kind?: ReceiptKind;
    readonly parentId?: Identifier;
    readonly workspaceAnchor?: WorkspaceAnchor;
    readonly executor?: ExecutorProfile;
}

export interface RecordEvidenceInput {
    readonly evidenceId?: Identifier;
    readonly receiptId: Identifier;
    readonly verificationId?: Identifier;
    readonly verification?: BusinessVerification;
    readonly claim?: string;
    readonly polarity?: "supports" | "refutes";
    readonly criteriaVersion?: string;
    readonly environmentVersion?: string;
    readonly level?: EvidenceLevel;
    readonly source?: EvidenceSource;
    readonly dependsOn?: readonly Identifier[];
    readonly expiresAt?: string;
    readonly parentId?: Identifier;
    readonly agentId?: Identifier;
    readonly cooperationId?: Identifier;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
}

export interface VerifyBusinessInput {
    readonly receiptId: Identifier;
    readonly criteriaVersion?: string;
    readonly verifier?: string;
    readonly claims?: readonly string[];
    readonly evaluate?: SemanticEvaluator;
    readonly verificationId?: Identifier;
}

export interface VerifyBusinessResult {
    readonly verification: BusinessVerification;
    readonly integrity: ReceiptIntegrityVerification;
}

export interface AchieveGoalInput {
    readonly goalId: Identifier;
    /** Independent current verification plus the evidence it covers. */
    readonly acceptance: Acceptance;
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
    /** Defaults to true: propagate to Mission achieved and Intent fulfilled. */
    readonly propagate?: boolean;
}

export interface AchieveGoalResult {
    readonly goal: Goal;
    readonly mission?: Mission;
    readonly intent?: Intent;
}

export interface CompileTurnContextInput {
    readonly turnId: Identifier;
    readonly sessionId?: Identifier;
    /** Defaults to the tenant id (the kernel options carry no principal). */
    readonly principalId?: Identifier;
    /** Pre-built attention objects; scope is re-bound to this turn by the kernel. */
    readonly objects?: readonly AttentionObject[];
    /** Attention declarations created, mounted and persisted by this call. */
    readonly create?: readonly CreateAttentionInput[];
    /** Defaults to `{ tokens: 2048 }`; needs an explicit tokens or bytes limit. */
    readonly budget?: Budget;
    readonly checkpointId?: Identifier;
    readonly currentVersion?: (pointer: AttentionPointer) => string | undefined;
    readonly countTokens?: (text: string) => number;
    readonly actor?: Identifier;
}

/** Persisted `context_checkpoint` payload. */
export interface ContextCheckpointRecord {
    readonly id: Identifier;
    readonly tenantId: Identifier;
    readonly sessionId: Identifier;
    readonly turnId: Identifier;
    readonly compiledAt: string;
    readonly budget: Budget;
    readonly usage: BudgetUsage;
    readonly itemIds: readonly Identifier[];
    readonly exclusions: readonly ContextExclusion[];
    readonly textDigest: string;
    readonly version: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface CompileTurnContextResult {
    readonly compiled: CompiledContext;
    readonly checkpoint: ContextCheckpointRecord;
    readonly attention: readonly AttentionObject[];
}

export interface CloseSessionInput {
    readonly sessionId: Identifier;
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
    /**
     * Defaults to true: cancel unfinished work, settle open Turns and supersede
     * unfinished Intents so the Session close guard can pass. `false` rejects
     * instead of mutating business state.
     */
    readonly abandonOpenWork?: boolean;
}

/**
 * Summary carried by the receipts the kernel synthesizes when a Session or
 * Turn closes. It is a point-in-time projection of the workflow, not a second
 * audit log: every number is read from the single writer and the budget ledger.
 */
export interface ClosureReceiptSummary {
    /** Session scope of the receipt. */
    readonly sessionId: Identifier;
    /** Turn scope; absent on a Session receipt. */
    readonly turnId?: Identifier;
    /** Workflow aggregates in the Session scope, per kind. */
    readonly entityCounts: Readonly<Record<WorkflowKind, number>>;
    /**
     * Workflow audit events in the receipt scope: every event of the Session
     * for a Session receipt, and the Turn plus the entities it originated for a
     * Turn receipt.
     */
    readonly eventCount: number;
    /** Settled budget usage for the tenant/root budget key. */
    readonly budget: BudgetUsage;
    /** Full ledger view at issue time (settled, reserved and limit). */
    readonly budgetSnapshot: BudgetSnapshot;
}

/**
 * Receipt synthesized by the kernel for a Session or Turn closure. It is a
 * regular {@link ReceiptCore} (invocation + observation + digest) plus the
 * closure taxonomy fields and the summary above.
 */
export interface ClosureReceipt extends ReceiptCore {
    readonly kind: "session_receipt" | "turn_receipt";
    readonly summary: ClosureReceiptSummary;
}

export interface CloseSessionResult {
    readonly session: Session;
    readonly turns: readonly Turn[];
    readonly cancelled: readonly WorkflowEntity[];
    /** The Session-level receipt; issued once per Session. */
    readonly sessionReceipt: ClosureReceipt;
    /** One receipt per closed Turn, in workflow order; issued once per Turn. */
    readonly turnReceipts: readonly ClosureReceipt[];
    /** Session and Turn receipts with the Session receipt first. */
    readonly receipts: readonly ClosureReceipt[];
}

/* ------------------------------------------------------------------ */
/* Snapshot and flow                                                   */
/* ------------------------------------------------------------------ */

export interface KernelSnapshot {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    /** Current workflow entities: session, turn, intent, mission, goal, plan, task, action. */
    readonly entities: readonly WorkflowEntity[];
    readonly counts: Readonly<Record<WorkflowKind, number>>;
    readonly budget: BudgetSnapshot;
    readonly evidenceCount: number;
    readonly receiptCount: number;
    readonly verificationCount: number;
    readonly workflowEvents: number;
    readonly store: StoreStats;
}

/** The eight-level execution loop from Session to Session close. */
export interface KernelFlow {
    startSession(input: StartSessionInput): Session;
    beginTurn(input: BeginTurnInput): Turn;
    captureIntent(input: CaptureIntentInput): Intent;
    confirmIntent(input: ConfirmIntentInput): Intent;
    createMission(input: CreateMissionInput): Mission;
    createGoal(input: CreateGoalInput): Goal;
    createPlan(input: CreatePlanInput): CreatePlanResult;
    readyTasks(input: ReadyTasksInput): ReadyTasksResult;
    startAction(input: StartActionInput): Promise<StartActionResult>;
    settleAction(input: SettleActionInput): Promise<SettleActionResult>;
    compileTurnContext(input: CompileTurnContextInput): CompileTurnContextResult;
    recordReceipt(input: RecordReceiptInput): ReceiptCore;
    recordEvidence(input: RecordEvidenceInput): Promise<Evidence>;
    verifyBusiness(input: VerifyBusinessInput): Promise<VerifyBusinessResult>;
    achieveGoal(input: AchieveGoalInput): AchieveGoalResult;
    closeSession(input: CloseSessionInput): CloseSessionResult;
}

/** Composed kernel instance. */
export interface Kernel {
    readonly ports: KernelPorts;
    readonly flow: KernelFlow;
    readonly store: Store;
    snapshot(): KernelSnapshot;
    close(): void;
}

/** Re-exported domain shapes used by kernel consumers. */
export type {
    Acceptance,
    Action,
    ActionAttempt,
    AttentionObject,
    BusinessVerification,
    CompiledContext,
    Evidence,
    EvidenceStatus,
    Goal,
    KernelTaskInput as TaskDeclaration,
    Mission,
    Observation,
    Plan,
    ReceiptCore,
    Session,
    Task,
    Turn,
};
