/**
 * Kernel contracts: the composition root that binds the workflow writer, the
 * domain services, persistence, budget, attention/context, provenance and the
 * L6/L7 verification chain into one executable loop.
 *
 * The kernel owns orchestration only. Every business rule stays in its domain
 * module; the kernel declares the ports, the flow inputs/outputs and the stable
 * machine-readable failure codes.
 */

import type { Budget, BudgetDimension, BudgetUsage, ExecutionContext, Identifier, JsonValue } from "../shared.ts";
import type { Store } from "../service/store.ts";
import type { StoreStats } from "../service/types.ts";
import type { BudgetNodeSnapshot, BudgetTree } from "../budget/tree.ts";
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
import type { WorkspaceErrorCode } from "../workspace/types.ts";
import type { EnvironmentDependency, EnvironmentPatch, EnvironmentPlan, ProjectEnvironment } from "../project/environment.ts";
import type { ProjectMetadata, ProjectOptions, ProjectRule, ProjectView } from "../project/types.ts";
import type { FileOperationReceipt, FileRange, FileSnapshot, WorkspaceMode, WriteTarget } from "../file/types.ts";
import type { WorkspaceFile } from "../file/core.ts";

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
    /**
     * Project construction options for the kernel-owned `Project` (kind, initial
     * environment, guidance, anchor resolver). Ignored when `KernelOverrides.project`
     * supplies an instance.
     */
    readonly project?: KernelProjectOptions;
    /**
     * Hierarchical budget limits enforced through {@link KernelPorts.budgetTree}.
     * A Session node is created from `session`; every Turn node is allocated from
     * that Session node with `turn`. Omitted means the tree is inert until a
     * caller explicitly adds nodes or passes `limit` to `consumeBudget`.
     */
    readonly budgetTree?: KernelBudgetOptions;
    /** Alias of {@link budgetTree}; both are honoured, `budgetTree` wins. */
    readonly budget?: KernelBudgetOptions;
    /** Store clock for row `updated_at` / event `recorded_at`; defaults to `clock`. */
    readonly now?: () => string;
}

/** Project construction options the kernel forwards to `new Project(...)`. */
export type KernelProjectOptions = Omit<ProjectOptions, "tenantId" | "rootId" | "clock">;

/** Hierarchical budget limits for the Session -> Turn -> Action tree. */
export interface KernelBudgetOptions {
    /** Limit of each Session budget node. */
    readonly session?: Budget;
    /** Amount allocated from the Session node to each Turn node. */
    readonly turn?: Budget;
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
    /** Hierarchical Session -> Turn -> Action budget accounting. */
    readonly budgetTree: BudgetTree;
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
    | WorkspaceErrorCode
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
    /** Session budget allocation; also seeds the Session's budget-tree node. */
    readonly budget?: Budget;
    readonly actor?: Identifier;
    /** Defaults to true: create then activate so work can be admitted. */
    readonly activate?: boolean;
}

export interface BeginTurnInput {
    readonly turnId: Identifier;
    /** Defaults to the only active/idle session. */
    readonly sessionId?: Identifier;
    readonly classification?: InputClassification;
    /** Turn budget allocation; also seeds the Turn's budget-tree node. */
    readonly budget?: Budget;
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

/* ------------------------------------------------------------------ */
/* Project orchestration                                              */
/* ------------------------------------------------------------------ */

/** One Project rule the kernel creates or updates through `Project.putRule`. */
export interface KernelProjectRuleInput {
    readonly id: Identifier;
    readonly text: string;
    readonly source?: string;
    readonly expectedVersion?: number;
    /** Accepted for compatibility with `ProjectRuleInput`; the kernel supplies its own scope. */
    readonly tenantId?: Identifier;
    readonly rootId?: Identifier;
    /** Ignored; accepted so a full `ProjectRule` can be passed back to the kernel. */
    readonly version?: number;
    readonly hash?: string;
    readonly updatedAt?: string;
}

/** One Project metadata entry the kernel creates or updates. */
export interface KernelProjectMetadataInput {
    readonly path: string;
    readonly kind?: string;
    readonly tags?: readonly string[];
    readonly ruleIds?: readonly Identifier[];
    readonly expectedVersion?: number;
    /** Accepted for compatibility with `ProjectMetadata`; the kernel supplies its own scope. */
    readonly tenantId?: Identifier;
    readonly rootId?: Identifier;
    /** Ignored; accepted so a full `ProjectMetadata` can be passed back to the kernel. */
    readonly version?: number;
    readonly updatedAt?: string;
}

/**
 * Project configuration accepted by `configureProject`.
 *
 * A bare {@link EnvironmentPatch} (`variables`/`paths`/`dependencies` keys) is
 * also accepted and applied as `environment`; the object form additionally
 * carries rules and metadata. Every write is persisted as `project_rule` /
 * `project_environment` and is atomic with the rest of the call.
 */
export interface ConfigureProjectInput {
    /** Environment overlay applied to the current Project environment. */
    readonly environment?: EnvironmentPatch;
    /** Alias of `environment` for callers that pass a wrapped patch. */
    readonly patch?: EnvironmentPatch;
    /** Flattened environment variables accepted alongside `rules`/`metadata`. */
    readonly variables?: Readonly<Record<string, string>>;
    readonly paths?: readonly string[];
    readonly dependencies?: readonly EnvironmentDependency[];
    /** Rules to create or update, in declaration order. */
    readonly rules?: readonly KernelProjectRuleInput[];
    /** Project metadata entries to create or update. */
    readonly metadata?: readonly KernelProjectMetadataInput[];
    /** Optimistic guard for the Project environment revision. */
    readonly expectedEnvironmentVersion?: number;
    /** Alias of `expectedEnvironmentVersion`. */
    readonly expectedVersion?: number;
    readonly actor?: Identifier;
}

/** Either the compact environment patch or the full configuration input. */
export type ConfigureProjectPatch = EnvironmentPatch | ConfigureProjectInput;

/** Point-in-time Project projection returned by `describeProject`. */
export interface DescribeProjectResult {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
    readonly kind?: string;
    readonly environment: ProjectEnvironment;
    /** Flattened aliases of `environment` for compact callers. */
    readonly variables: Readonly<Record<string, string>>;
    readonly paths: readonly string[];
    readonly dependencies: readonly EnvironmentDependency[];
    readonly environmentVersion: number;
    readonly plan: EnvironmentPlan;
    /** Deterministic agent-facing Markdown brief (`Project.describeEnvironment()`). */
    readonly description: string;
    readonly rules: readonly ProjectRule[];
    readonly metadata: readonly ProjectMetadata[];
    readonly views: readonly ProjectView[];
    readonly ready: boolean;
}

/** Result of one `configureProject` call. */
export interface ConfigureProjectResult extends DescribeProjectResult {
    /** False when every requested change was already present (idempotent replay). */
    readonly applied: boolean;
    readonly environmentChanged: boolean;
    /** Rule ids that were actually written. */
    readonly rulesChanged: readonly Identifier[];
    /** Metadata paths that were actually written. */
    readonly metadataChanged: readonly Identifier[];
    /** Store event kinds appended by this call, in order (empty on a no-op). */
    readonly events: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Workspace file orchestration                                       */
/* ------------------------------------------------------------------ */

export interface OpenWorkspaceFileInput {
    readonly path: Identifier;
    readonly mode?: WorkspaceMode;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
    readonly actor?: Identifier;
}

/**
 * An opened and active `WorkspaceFile`. The result carries the snapshot fields
 * directly (so `result.hash`/`result.version`/`result.state` work) plus the
 * mount receipt that was recorded as evidence.
 */
export interface OpenedWorkspaceFile extends FileSnapshot {
    readonly snapshot: FileSnapshot;
    readonly file: WorkspaceFile;
    /** Alias of `file` for hosts that call the opened object a handle. */
    readonly handle: WorkspaceFile;
    readonly receipt: FileOperationReceipt;
    readonly receiptRecord: ReceiptCore;
    /** Receipt taxonomy member (`file_mount_receipt` here). */
    readonly receiptKind: ReceiptKind;
    readonly evidence: Evidence;
    readonly idempotent: boolean;
}

export interface ReadFileOptions {
    readonly range?: FileRange;
    readonly allowStale?: boolean;
    /** Defaults to read-only when the kernel has to open the file. */
    readonly mode?: WorkspaceMode;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
}

export interface ReadFileInput extends ReadFileOptions {
    readonly path: Identifier;
}

/** File content plus the resulting (or still cached) snapshot. */
export interface ReadFileResult extends FileSnapshot {
    readonly content: string;
    /** Alias of `content`. */
    readonly text: string;
    readonly snapshot: FileSnapshot;
    /** True when the kernel had to mount the file for this read. */
    readonly opened: boolean;
    readonly mountReceipt?: FileOperationReceipt;
}

export interface WriteFileOptions {
    /** Content accepted when options are passed as the second argument. */
    readonly content?: string;
    /** Whole-buffer write when omitted; otherwise a targeted line/byte/outline edit. */
    readonly target?: FileRange | WriteTarget;
    /** Mode used only when the kernel has to open the file; defaults to writable. */
    readonly mode?: WorkspaceMode;
    readonly idempotencyKey?: string;
    /** Optimistic buffer guard forwarded to `WorkspaceFile.write`. */
    readonly expectedBufferVersion?: number;
    /** Optimistic committed-base guard forwarded to `WorkspaceFile.write`. */
    readonly expectedBaseHash?: string;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
}

export interface WriteFileInput extends WriteFileOptions {
    readonly path: Identifier;
    readonly content: string;
}

/** Result of one `writeFile` step: the committed snapshot plus its evidence chain. */
export interface WriteFileResult extends FileSnapshot {
    readonly content: string;
    readonly snapshot: FileSnapshot;
    /** The `flush` receipt (the durable commit this step performed). */
    readonly receipt: FileOperationReceipt;
    /** Mount (when the kernel opened the file) plus flush receipts, in order. */
    readonly receipts: readonly FileOperationReceipt[];
    readonly receiptRecord: ReceiptCore;
    /** Receipt taxonomy member (`file_flush_receipt` here). */
    readonly receiptKind: ReceiptKind;
    readonly evidence: Evidence;
    readonly verification: BusinessVerification;
    readonly integrity: ReceiptIntegrityVerification;
    /** True when an identical receipt already existed and nothing new was written. */
    readonly idempotent: boolean;
    /** True when the committed hash version moved. */
    readonly changed: boolean;
}

export interface CloseWorkspaceFileInput {
    readonly path: Identifier;
    readonly discardDirty?: boolean;
    readonly sessionId?: Identifier;
    readonly turnId?: Identifier;
}

export interface CloseWorkspaceFileResult {
    readonly path: Identifier;
    readonly closed: boolean;
    readonly snapshot?: FileSnapshot;
    readonly receipt?: FileOperationReceipt;
    readonly receiptRecord?: ReceiptCore;
    readonly receiptKind?: ReceiptKind;
    readonly evidence?: Evidence;
}

/* ------------------------------------------------------------------ */
/* Hierarchical budget enforcement                                    */
/* ------------------------------------------------------------------ */

export type BudgetExhaustionScope = "session" | "turn" | "action" | "node";

/** Stable decision recorded when a `BudgetTree` node has no remaining budget. */
export interface BudgetExhaustionDecision {
    readonly scope: BudgetExhaustionScope;
    /** Budget-tree node that raised the signal. */
    readonly nodeId: Identifier;
    /** Workflow entity that was addressed (when the node maps to one). */
    readonly entityId?: Identifier;
    readonly dimension: BudgetDimension;
    readonly reason: "budget_exhausted";
    /**
     * Business reaction the kernel applied: interrupt an acting Turn, move a
     * Session to `closing`, or only record the decision when the entity is in a
     * state with no legal edge.
     */
    readonly action: "turn_interrupted" | "session_closing" | "recorded";
    readonly applied: boolean;
    readonly previousState?: string;
    readonly state?: string;
    readonly message: string;
    readonly at: string;
}

export interface ConsumeBudgetInput {
    readonly usage: Budget;
    /** Explicit tree node. It is created as a root when `limit` is supplied. */
    readonly nodeId?: Identifier;
    /** Turn node; the Turn is driven to `acting` before consumption. */
    readonly turnId?: Identifier;
    /** Session node. */
    readonly sessionId?: Identifier;
    /** `reserve` keeps the amount provisional; the default `consume` is final. */
    readonly mode?: "consume" | "reserve";
    /** Limit used when this call has to create the node. */
    readonly limit?: Budget;
    readonly actor?: Identifier;
    /** Re-throw `budget_exhausted` after the decision was recorded. */
    readonly throwOnExhausted?: boolean;
}

export interface ConsumeBudgetResult {
    readonly consumed: boolean;
    readonly nodeId: Identifier;
    readonly usage: Budget;
    /** Present when the tree refused the amount. */
    readonly error?: { readonly code: "budget_exhausted"; readonly message: string };
    /** The decision produced by the `onExhausted` observer for this refusal. */
    readonly decision?: BudgetExhaustionDecision;
    /** Node snapshot after a successful consumption/reservation. */
    readonly snapshot?: BudgetNodeSnapshot;
    readonly remaining?: BudgetUsage;
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
    /** Hierarchical Session -> Turn -> Action nodes, roots first. */
    readonly budgetTree: readonly BudgetNodeSnapshot[];
    readonly budgetDecisions: number;
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

    /* Project ------------------------------------------------------- */
    /** Applies an environment patch plus rule/metadata edits atomically. */
    configureProject(patch: ConfigureProjectPatch): ConfigureProjectResult;
    /** Reads the current Project environment, plan, brief, rules, metadata and views. */
    describeProject(): DescribeProjectResult;

    /* Workspace files ----------------------------------------------- */
    /** Mounts and activates a workspace file and records its mount receipt. */
    openWorkspaceFile(path: Identifier | OpenWorkspaceFileInput, mode?: WorkspaceMode): OpenedWorkspaceFile;
    /** Reads a file, opening it read-only when it is not already open. */
    readFile(path: Identifier | ReadFileInput, options?: ReadFileOptions | FileRange): ReadFileResult;
    /** Writes and flushes a file, recording the flush receipt as evidence. */
    writeFile(path: Identifier | WriteFileInput, content?: string | WriteFileOptions, options?: WriteFileOptions): WriteFileResult;
    /** Unmounts an open file and records the unmount receipt. */
    closeWorkspaceFile(path: Identifier | CloseWorkspaceFileInput): CloseWorkspaceFileResult;

    /* Hierarchical budget ------------------------------------------- */
    /** Consumes/reserves a budget-tree node and propagates exhaustion. */
    consumeBudget(input: ConsumeBudgetInput): ConsumeBudgetResult;
    /** Decisions recorded by the tree's `onExhausted` observer, oldest first. */
    budgetDecisions(): readonly BudgetExhaustionDecision[];
}

/** Composed kernel instance. */
export interface Kernel {
    readonly ports: KernelPorts;
    readonly flow: KernelFlow;
    readonly store: Store;
    snapshot(): KernelSnapshot;
    /** Decisions recorded by the budget tree's `onExhausted` observer, oldest first. */
    budgetDecisions(): readonly BudgetExhaustionDecision[];
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
