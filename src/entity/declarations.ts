/**
 * Concrete declarations for every `EntityKind`.
 *
 * All aggregates share the JSON row table used by the repository layer. Each
 * declaration names its key, columns, indexes, associations and lifecycle
 * guards; `registry.ts` only projects this map into the public registry.
 */

import { cascade, manyToMany, manyToOne, oneToMany } from "./associate.ts";
import { column, entity, index, jsonDescriptor } from "./entity.ts";
import { ENTITY_KINDS, compositeId, id, isEntityKind, keyOf } from "./key.ts";
import { LifecycleRegistry } from "./lifecycle.ts";
import type { EntityLifecycle, EntityLifecycleContext } from "./lifecycle.ts";
import type { Association, Column, Entity, EntityDescriptor, EntityKind, Key } from "./types.ts";

const TABLE = "entities";

function textField(value: unknown, property: string): string | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const field = (value as Readonly<Record<string, unknown>>)[property];
    return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

function versionField(kind: EntityKind, entity: unknown): number {
    if (typeof entity !== "object" || entity === null || Array.isArray(entity)) return 0;
    const value = (entity as Readonly<Record<string, unknown>>).version;
    if (value === undefined) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`entity ${kind} version must be a non-negative safe integer`);
    }
    return value;
}

/**
 * Builds the descriptor used by the JSON row table. The declared key is always
 * `id` (or `key` for store_meta); `legacyKey` lets descriptors keep addressing
 * aggregates whose domain object still names its identifier `budgetKey`,
 * `manifestId`, `signature`, or a composite of project coordinates.
 */
function descriptorFor(
    kind: EntityKind,
    legacyKey: Key | undefined,
): EntityDescriptor<unknown> | undefined {
    if (legacyKey === undefined) return undefined;
    return jsonDescriptor<unknown>(kind, {
        table: TABLE,
        idOf: (entity) => textField(entity, "id") ?? keyOf(legacyKey, entity),
        tenantOf: entity => textField(entity, "tenantId"),
        sessionOf: entity => textField(entity, "sessionId"),
        kindOf: entity => textField(entity, "kind"),
        versionOf: entity => versionField(kind, entity),
        updatedAtOf: entity => textField(entity, "updatedAt") ?? textField(entity, "createdAt") ?? new Date().toISOString(),
    });
}

function declaration(options: {
    readonly kind: EntityKind;
    readonly key?: Key;
    readonly legacyKey?: Key;
    readonly tenantNullable?: boolean;
    readonly sessionNullable?: boolean;
    readonly kindNullable?: boolean;
    readonly associations?: readonly Association[];
}): Entity {
    const key = options.key ?? id();
    const keyProperty = key.properties[0] ?? "id";
    const keyColumn = key.columns[0] ?? keyProperty;
    const columns: readonly Column[] = [
        column(keyProperty, { column: keyColumn, nullable: false, unique: true }),
        column("tenantId", { nullable: options.tenantNullable ?? true }),
        column("sessionId", { nullable: options.sessionNullable ?? true }),
        column("kind", { nullable: options.kindNullable ?? true }),
        column("version", { nullable: false, version: true }),
        column("updatedAt", { nullable: false }),
        column("payload", { nullable: false }),
    ];
    const descriptor = descriptorFor(options.kind, options.legacyKey);
    return entity({
        kind: options.kind,
        table: TABLE,
        access: "field",
        key,
        columns,
        indexes: [
            index(`idx_${options.kind}_tenant`, ["tenant_id"]),
            index(`idx_${options.kind}_session`, ["session_id"]),
            index(`idx_${options.kind}_updated`, ["updated_at"]),
        ],
        associations: options.associations ?? [],
        versionColumn: "version",
        ...(descriptor === undefined ? {} : { descriptor }),
    });
}

/* ------------------------------------------------------------------ */
/* Lifecycle hooks                                                    */
/* ------------------------------------------------------------------ */

function requireRecord(entity: unknown, label: string): Readonly<Record<string, unknown>> {
    if (typeof entity !== "object" || entity === null || Array.isArray(entity)) {
        throw new TypeError(`${label} must be an object`);
    }
    return entity as Readonly<Record<string, unknown>>;
}

function assertIdentity(kind: EntityKind, idProperty: "id" | "key", event: string, entity: unknown): void {
    const record = requireRecord(entity, `${kind} ${event} entity`);
    const value = record[idProperty];
    if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(`${kind} ${event} requires a non-empty ${idProperty}`);
    }
}

function assertVersion(kind: EntityKind, event: string, entity: unknown, context: EntityLifecycleContext): void {
    const candidate = requireRecord(entity, `${kind} ${event} entity`).version;
    const version = candidate === undefined ? context.version : candidate;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
        throw new TypeError(`${kind} ${event} requires a non-negative safe integer version`);
    }
}

function freezeLoaded(kind: EntityKind, entity: unknown): void {
    if (typeof entity !== "object" || entity === null) {
        throw new TypeError(`${kind} postLoad entity must be an object`);
    }
    // Freezing is idempotent, so repeated `postLoad` calls are safe.
    if (!Object.isFrozen(entity)) Object.freeze(entity);
}

function createLifecycle(kind: EntityKind): EntityLifecycle<unknown> {
    const idProperty: "id" | "key" = kind === "store_meta" ? "key" : "id";
    return Object.freeze({
        prePersist(entity: unknown, context: EntityLifecycleContext): void {
            assertIdentity(kind, idProperty, "prePersist", entity);
            assertVersion(kind, "prePersist", entity, context);
        },
        preUpdate(entity: unknown, context: EntityLifecycleContext): void {
            assertIdentity(kind, idProperty, "preUpdate", entity);
            assertVersion(kind, "preUpdate", entity, context);
        },
        preRemove(entity: unknown): void {
            assertIdentity(kind, idProperty, "preRemove", entity);
        },
        postLoad(entity: unknown): void {
            freezeLoaded(kind, entity);
        },
    });
}

/** One optional hook object per declared kind. */
export const ENTITY_LIFECYCLES: Readonly<Record<EntityKind, EntityLifecycle<unknown>>> = Object.freeze(
    Object.fromEntries(
        ENTITY_KINDS.map(kind => [kind, createLifecycle(kind)]),
    ) as Record<EntityKind, EntityLifecycle<unknown>>,
);

/** Registry pre-populated with {@link ENTITY_LIFECYCLES}. */
export const ENTITY_LIFECYCLE_REGISTRY: LifecycleRegistry = new LifecycleRegistry(ENTITY_LIFECYCLES);

/** Returns the declared lifecycle hooks for one kind. */
export function lifecycleFor(kind: EntityKind): EntityLifecycle<unknown> {
    if (!isEntityKind(kind)) throw new TypeError(`unknown entity kind: ${String(kind)}`);
    return ENTITY_LIFECYCLES[kind];
}

/** Entity metadata plus the optional callbacks declared for it. */
export interface DeclaredEntity<T = unknown> extends Entity<T> {
    readonly lifecycle: EntityLifecycle<T>;
}

function declare(options: {
    readonly kind: EntityKind;
    readonly key?: Key;
    readonly legacyKey?: Key;
    readonly tenantNullable?: boolean;
    readonly sessionNullable?: boolean;
    readonly kindNullable?: boolean;
    readonly associations?: readonly Association[];
}): DeclaredEntity {
    const metadata = declaration(options);
    return Object.freeze({
        ...metadata,
        lifecycle: ENTITY_LIFECYCLES[options.kind] as unknown as EntityLifecycle<unknown>,
    });
}

/* ------------------------------------------------------------------ */
/* Interaction: session -> turn -> intent -> mission -> goal -> ...   */
/* ------------------------------------------------------------------ */

export const SessionEntity: DeclaredEntity = declare({
    kind: "session",
    sessionNullable: false,
    kindNullable: false,
    associations: [oneToMany("turns", "turn", { mappedBy: "session" })],
});

export const TurnEntity: DeclaredEntity = declare({
    kind: "turn",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("session", "session", { targetProperty: "id", optional: false }),
        oneToMany("intents", "intent", { mappedBy: "originTurn" }),
    ],
});

export const IntentEntity: DeclaredEntity = declare({
    kind: "intent",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("originTurn", "turn", { targetProperty: "id", optional: false }),
        oneToMany("missions", "mission", { mappedBy: "intent" }),
    ],
});

export const MissionEntity: DeclaredEntity = declare({
    kind: "mission",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("intent", "intent", { targetProperty: "id", optional: false }),
        oneToMany("goals", "goal", { mappedBy: "mission" }),
    ],
});

export const GoalEntity: DeclaredEntity = declare({
    kind: "goal",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("mission", "mission", { targetProperty: "id", optional: false }),
        oneToMany("plans", "plan", { mappedBy: "goal" }),
        // Goal dependencies are a true n:m edge owned by this side; the join
        // table makes the owning side explicit.
        manyToMany("dependencies", "goal", {
            joinTable: "goal_dependencies",
            joinColumns: ["goal_id"],
            inverseJoinColumns: ["dependency_id"],
            cascade: cascade("persist"),
        }),
    ],
});

export const PlanEntity: DeclaredEntity = declare({
    kind: "plan",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("goal", "goal", { targetProperty: "id", optional: false }),
        oneToMany("tasks", "task", { mappedBy: "plan" }),
    ],
});

export const TaskEntity: DeclaredEntity = declare({
    kind: "task",
    sessionNullable: false,
    kindNullable: false,
    associations: [
        manyToOne("plan", "plan", { targetProperty: "id", optional: false }),
        oneToMany("actions", "action", { mappedBy: "task" }),
    ],
});

export const ActionEntity: DeclaredEntity = declare({
    kind: "action",
    sessionNullable: false,
    kindNullable: false,
    associations: [manyToOne("task", "task", { targetProperty: "id", optional: false })],
});

/**
 * One execution attempt joined to its action. The domain identifier is
 * `attemptId`; attempts carry `version` (0 while running, 1 once settled) and
 * are keyed by it like every other aggregate.
 */
export const ActionAttemptEntity: DeclaredEntity = declare({
    kind: "action_attempt",
    sessionNullable: false,
    legacyKey: id("attemptId"),
    associations: [manyToOne("action", "action", { targetProperty: "id", optional: false })],
});

/* ------------------------------------------------------------------ */
/* Evidence and receipts                                              */
/* ------------------------------------------------------------------ */

export const EvidenceEntity: DeclaredEntity = declare({
    kind: "evidence",
    tenantNullable: false,
    associations: [manyToOne("receipt", "receipt", { targetProperty: "id", optional: false })],
});

export const ReceiptEntity: DeclaredEntity = declare({
    kind: "receipt",
    associations: [oneToMany("evidence", "evidence", { mappedBy: "receipt" })],
});

export const ReceiptIntegrityEntity: DeclaredEntity = declare({ kind: "receipt_integrity" });

export const VerificationEntity: DeclaredEntity = declare({ kind: "verification" });

export const ProvenanceEventEntity: DeclaredEntity = declare({ kind: "provenance_event" });

export const EvidenceAuditEntity: DeclaredEntity = declare({ kind: "evidence_audit" });

/* ------------------------------------------------------------------ */
/* Attention                                                          */
/* ------------------------------------------------------------------ */

export const AttentionEntity: DeclaredEntity = declare({
    kind: "attention",
    tenantNullable: false,
});

/* ------------------------------------------------------------------ */
/* Project                                                            */
/* ------------------------------------------------------------------ */

export const ProjectRuleEntity: DeclaredEntity = declare({
    kind: "project_rule",
    tenantNullable: false,
    associations: [
        oneToMany("metadata", "project_metadata", { mappedBy: "projectRule" }),
        oneToMany("views", "project_view", { mappedBy: "projectRule" }),
    ],
});

export const ProjectMetadataEntity: DeclaredEntity = declare({
    kind: "project_metadata",
    tenantNullable: false,
    legacyKey: compositeId(["tenantId", "rootId", "path"]),
    associations: [manyToOne("projectRule", "project_rule", { targetProperty: "id" })],
});

export const ProjectViewEntity: DeclaredEntity = declare({
    kind: "project_view",
    tenantNullable: false,
    legacyKey: compositeId(["tenantId", "rootId", "kind"]),
    associations: [manyToOne("projectRule", "project_rule", { targetProperty: "id" })],
});

export const ProjectEnvironmentEntity: DeclaredEntity = declare({
    kind: "project_environment",
    tenantNullable: false,
    legacyKey: compositeId(["tenantId", "rootId"]),
});

/* ------------------------------------------------------------------ */
/* Budget and governance                                              */
/* ------------------------------------------------------------------ */

export const BudgetLedgerEntity: DeclaredEntity = declare({
    kind: "budget_ledger",
    tenantNullable: false,
    legacyKey: id("budgetKey"),
    associations: [oneToMany("reservations", "budget_reservation", { mappedBy: "ledger" })],
});

export const BudgetReservationEntity: DeclaredEntity = declare({
    kind: "budget_reservation",
    tenantNullable: false,
    associations: [manyToOne("ledger", "budget_ledger", { targetProperty: "id" })],
});

export const ManifestEntity: DeclaredEntity = declare({
    kind: "manifest",
    tenantNullable: false,
    legacyKey: id("manifestId"),
});

export const CapabilityActivationEntity: DeclaredEntity = declare({
    kind: "capability_activation",
    legacyKey: id("activationId"),
});

/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */

export const ExecutionInvocationEntity: DeclaredEntity = declare({
    kind: "execution_invocation",
    tenantNullable: false,
    associations: [oneToMany("observations", "execution_observation", { mappedBy: "invocation" })],
});

export const ExecutionObservationEntity: DeclaredEntity = declare({
    kind: "execution_observation",
    tenantNullable: false,
    associations: [manyToOne("invocation", "execution_invocation", { targetProperty: "id" })],
});

/* ------------------------------------------------------------------ */
/* Cooperation                                                        */
/* ------------------------------------------------------------------ */

export const CooperationTaskEntity: DeclaredEntity = declare({
    kind: "cooperation_task",
    tenantNullable: false,
    legacyKey: id("taskId"),
    associations: [oneToMany("messages", "cooperation_message", { mappedBy: "task" })],
});

export const CooperationMessageEntity: DeclaredEntity = declare({
    kind: "cooperation_message",
    tenantNullable: false,
    legacyKey: id("messageId"),
    associations: [manyToOne("task", "cooperation_task", { targetProperty: "id" })],
});

/* ------------------------------------------------------------------ */
/* Behaviour and context                                              */
/* ------------------------------------------------------------------ */

export const BehaviorCandidateEntity: DeclaredEntity = declare({
    kind: "behavior_candidate",
    legacyKey: id("candidateId"),
});

export const ContextCheckpointEntity: DeclaredEntity = declare({
    kind: "context_checkpoint",
    tenantNullable: false,
    associations: [oneToMany("cacheEntries", "context_cache_entry", { mappedBy: "checkpoint" })],
});

export const ContextCacheEntryEntity: DeclaredEntity = declare({
    kind: "context_cache_entry",
    tenantNullable: false,
    legacyKey: id("signature"),
    associations: [manyToOne("checkpoint", "context_checkpoint", { targetProperty: "id" })],
});

/* ------------------------------------------------------------------ */
/* Store metadata                                                     */
/* ------------------------------------------------------------------ */

export const StoreMetaEntity: DeclaredEntity = declare({
    kind: "store_meta",
    key: id("key"),
});

/** Complete declaration map; the registry is a frozen projection of this. */
export const ENTITY_DECLARATIONS: Readonly<Record<EntityKind, DeclaredEntity>> = Object.freeze({
    session: SessionEntity,
    turn: TurnEntity,
    intent: IntentEntity,
    mission: MissionEntity,
    goal: GoalEntity,
    plan: PlanEntity,
    task: TaskEntity,
    action: ActionEntity,
    action_attempt: ActionAttemptEntity,
    evidence: EvidenceEntity,
    receipt: ReceiptEntity,
    receipt_integrity: ReceiptIntegrityEntity,
    verification: VerificationEntity,
    provenance_event: ProvenanceEventEntity,
    evidence_audit: EvidenceAuditEntity,
    attention: AttentionEntity,
    project_rule: ProjectRuleEntity,
    project_metadata: ProjectMetadataEntity,
    project_view: ProjectViewEntity,
    project_environment: ProjectEnvironmentEntity,
    budget_ledger: BudgetLedgerEntity,
    budget_reservation: BudgetReservationEntity,
    manifest: ManifestEntity,
    capability_activation: CapabilityActivationEntity,
    execution_invocation: ExecutionInvocationEntity,
    execution_observation: ExecutionObservationEntity,
    cooperation_task: CooperationTaskEntity,
    cooperation_message: CooperationMessageEntity,
    behavior_candidate: BehaviorCandidateEntity,
    context_checkpoint: ContextCheckpointEntity,
    context_cache_entry: ContextCacheEntryEntity,
    store_meta: StoreMetaEntity,
});
