/**
 * Persistence layer contracts.
 *
 * The layer maps domain aggregates onto the `Store`/`WorkflowStore` pair:
 * domain facts become persisted entity rows, workflow facts become versioned
 * entity rows plus an append-only event log, and {@link RestoreReport} records
 * what a rehydration could and could not rebuild.
 */

import type { Action } from "../action/types.ts";
import type { AttentionObject } from "../attention/types.ts";
import type { BehaviorCandidate } from "../behavior/types.ts";
import type { CapabilityActivation } from "../capability/types.ts";
import type { ContextCacheEntry, ContextCheckpoint } from "../context/lifecycle.ts";
import type { CooperationMessage, DelegatedTask } from "../cooperation/types.ts";
import type { EntityKind } from "../entity/types.ts";
import type { Evidence, ProvenanceEvent } from "../evidence/types.ts";
import type { Goal } from "../goal/types.ts";
import type { Intent } from "../intent/types.ts";
import type { Mission } from "../mission/types.ts";
import type { Plan } from "../plan/types.ts";
import type { ProjectEnvironment } from "../project/environment.ts";
import type { ProjectMetadata, ProjectRule, ProjectView } from "../project/types.ts";
import type { ReceiptCore, ReceiptIntegrityVerification } from "../receipt/types.ts";
import type { Session } from "../session/types.ts";
import type { Identifier, InvocationRecord, ObservationRecord } from "../shared.ts";
import type { Task } from "../task/types.ts";
import type { BudgetReservation, BudgetSnapshot, Manifest } from "../tool/types.ts";
import type { Turn } from "../turn/types.ts";
import type { BusinessVerification } from "../verification/types.ts";
import type { ActionAttempt, WorkflowKind } from "../workflow/types.ts";

/**
 * A budget ledger row. `BudgetSnapshot` itself is keyless, so the wrapper adds
 * the `budgetKey` that identifies the ledger. `id` is carried as well because
 * the declared `budget_ledger` key may be either `budgetKey` or `id`; keeping
 * both makes the row portable across those declarations.
 */
export interface BudgetLedgerRecord extends BudgetSnapshot {
    readonly id?: Identifier;
    readonly budgetKey: Identifier;
}

/** A project environment row; `project_environment` has a composite tenant/root key. */
export interface ProjectEnvironmentRecord extends ProjectEnvironment {
    readonly tenantId: Identifier;
    readonly rootId: Identifier;
}

/** A `store_meta` row; the descriptor keys it by `key`. */
export interface StoreMetaRecord {
    readonly key: string;
    readonly value: string;
}

/**
 * There is no dedicated domain type for `evidence_audit` yet; the layer keeps
 * the payload opaque instead of inventing a competing contract.
 */
export type EvidenceAuditRecord = Readonly<Record<string, unknown>>;

/** Compile-time guard that a mapping covers every registered {@link EntityKind}. */
type CompletePersistedMap<T extends Record<EntityKind, unknown>> = T;

/** Entity payload type per kind. */
export type PersistedMap = CompletePersistedMap<{
    session: Session;
    turn: Turn;
    intent: Intent;
    mission: Mission;
    goal: Goal;
    plan: Plan;
    task: Task;
    action: Action;
    action_attempt: ActionAttempt;
    evidence: Evidence;
    receipt: ReceiptCore;
    receipt_integrity: ReceiptIntegrityVerification;
    verification: BusinessVerification;
    provenance_event: ProvenanceEvent;
    evidence_audit: EvidenceAuditRecord;
    attention: AttentionObject;
    project_rule: ProjectRule;
    project_metadata: ProjectMetadata;
    project_view: ProjectView;
    project_environment: ProjectEnvironmentRecord;
    budget_ledger: BudgetLedgerRecord;
    budget_reservation: BudgetReservation;
    manifest: Manifest;
    capability_activation: CapabilityActivation;
    execution_invocation: InvocationRecord;
    execution_observation: ObservationRecord;
    cooperation_task: DelegatedTask;
    cooperation_message: CooperationMessage;
    behavior_candidate: BehaviorCandidate;
    context_checkpoint: ContextCheckpoint;
    context_cache_entry: ContextCacheEntry;
    store_meta: StoreMetaRecord;
}>;

/** The persisted payload type for one entity kind. */
export type Persisted<K extends EntityKind> = PersistedMap[K];

/** Result of a rehydration pass. */
export interface RestoreReport {
    /** Number of workflow entities restored into the workflow store. */
    readonly restored: number;
    /**
     * Facts that could not be restored faithfully: entity keys (`kind:id`) with
     * corrupt/incomplete rows or missing parents, attempt keys (`attempt:<id>`)
     * that an action references but whose `action_attempt` row is missing, and
     * event keys (`event:<sequence>`) with malformed workflow payloads.
     */
    readonly skipped: readonly string[];
    /** Number of workflow events restored into the snapshot. */
    readonly events: number;
    /** Number of execution attempts restored into the snapshot. */
    readonly attempts: number;
}

/** Options shared by every persistence entry point. */
export interface PersistenceOptions {
    /** Clock used for restores and for callers that need deterministic event facts. */
    readonly now?: () => string;
}

/** Stable error codes raised by the persistence layer. */
export type PersistenceErrorCode =
    | "schema_version"
    | "sequence_mismatch"
    | "duplicate_entity"
    | "corrupt_payload"
    | "unsupported_store"
    | "invalid_snapshot";

/** Typed failure raised when stored facts cannot be restored faithfully. */
export class PersistenceError extends Error {
    readonly code: PersistenceErrorCode;

    constructor(code: PersistenceErrorCode, message: string, options?: { readonly cause?: unknown }) {
        super(message, options);
        this.name = "PersistenceError";
        this.code = code;
    }
}

/** The eight aggregate kinds owned by the workflow kernel. */
export const WORKFLOW_KINDS: readonly WorkflowKind[] = Object.freeze([
    "session", "turn", "intent", "mission", "goal", "plan", "task", "action",
]);

/** Snapshot schema version produced and accepted by this layer. */
export const WORKFLOW_SNAPSHOT_SCHEMA_VERSION = 1;

/** Event phases persisted by {@link WorkflowPersistence}. */
export type WorkflowEventPhase = "created" | "transitioned";

/** `"<kind>.created"` / `"<kind>.transitioned"` event kind. */
export function workflowEventKind(kind: WorkflowKind, phase: WorkflowEventPhase): string {
    return `${kind}.${phase}`;
}

/** Runtime guard for {@link WorkflowKind}. */
export function isWorkflowKind(value: unknown): value is WorkflowKind {
    return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value);
}
