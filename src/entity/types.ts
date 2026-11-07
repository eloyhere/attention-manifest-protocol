/** Entity layer: one descriptor per aggregate, encoded to a JSON payload row. */

export type EntityKind =
    | "session" | "turn" | "intent" | "mission" | "goal" | "plan" | "task" | "action" | "action_attempt"
    | "evidence" | "receipt" | "receipt_integrity" | "verification" | "provenance_event" | "evidence_audit"
    | "attention" | "project_rule" | "project_metadata" | "project_view" | "project_environment"
    | "budget_ledger" | "budget_reservation" | "manifest" | "capability_activation"
    | "execution_invocation" | "execution_observation" | "cooperation_task" | "cooperation_message"
    | "behavior_candidate" | "context_checkpoint" | "context_cache_entry" | "store_meta";

export interface EntityRecord {
    readonly id: string;
    readonly tenantId?: string;
    readonly sessionId?: string;
    readonly kind?: string;
    readonly version: number;
    readonly updatedAt: string;
    readonly payload: unknown;
}

export interface EntityDescriptor<T = unknown> {
    readonly kind: EntityKind;
    readonly table: string;
    readonly keyOf: (entity: T) => string;
    readonly encode: (entity: T) => EntityRecord;
    readonly decode: (record: EntityRecord) => T;
    readonly versionOf: (entity: T) => number;
}

export interface EntityFilter {
    readonly tenantId?: string;
    readonly sessionId?: string;
    readonly kind?: string;
    readonly limit?: number;
}

export interface EventRecord {
    readonly sequence: number;
    readonly kind: string;
    readonly entityId?: string;
    readonly recordedAt: string;
    readonly payload: unknown;
}

/* ------------------------------------------------------------------ */
/* JPA-style metadata: keys, indexes, associations and cascades.       */
/* ------------------------------------------------------------------ */

export type IdStrategy = "assigned" | "identity" | "sequence" | "table" | "uuid" | "auto";
export type CascadeType = "persist" | "merge" | "remove" | "refresh" | "detach";
export type FetchType = "lazy" | "eager";
export type AssociationKind = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
export type EntityAccess = "field" | "property";
/** JPA entity lifecycle states around a persistence context. */
export type EntityState = "new" | "managed" | "detached" | "removed" | "deleted";
export type LockMode = "optimistic" | "pessimistic_read" | "pessimistic_write";

/** Primary key description; more than one property means a composite key. */
export interface Key {
    readonly properties: readonly string[];
    readonly columns: readonly string[];
    readonly strategy: IdStrategy;
    /** True when the provider assigns the key (@GeneratedValue). */
    readonly generated: boolean;
}

/** A persistent column (@Column). */
export interface Column {
    readonly property: string;
    readonly column: string;
    readonly nullable: boolean;
    readonly unique: boolean;
    readonly insertable: boolean;
    readonly updatable: boolean;
    /** @Version column for optimistic locking. */
    readonly version: boolean;
    /** @Transient-like columns are not persisted. */
    readonly transient: boolean;
    readonly length?: number;
    readonly precision?: number;
    readonly scale?: number;
}

/** @Table(uniqueConstraints = ...) */
export interface UniqueConstraint {
    readonly name: string;
    readonly columns: readonly string[];
}

/** A declarative index (@Table(indexes = @Index(...))). */
export interface Index {
    readonly name: string;
    readonly columns: readonly string[];
    readonly unique: boolean;
}

/** Relationship metadata; `target` is the related entity kind. */
export interface Association {
    readonly kind: AssociationKind;
    readonly property: string;
    readonly target: EntityKind;
    /** Inverse-side property name on the target (@OneToMany(mappedBy)/@ManyToMany(mappedBy)). */
    readonly mappedBy?: string;
    /** Property on the target that this side points at (@JoinColumn referencedColumn). */
    readonly targetProperty?: string;
    /**
     * Payload property on `target` that holds this side's key (the reverse
     * foreign key a cascade uses to find children). JSON payloads do not have
     * join columns, so the link is declared by property name; when omitted,
     * cascade lookup falls back to `<mappedBy>Id` and then `<mappedBy>`.
     */
    readonly joinProperty?: string;
    /** Join table for many-to-many associations. */
    readonly joinTable?: string;
    readonly joinColumns?: readonly string[];
    readonly inverseJoinColumns?: readonly string[];
    readonly cascade: readonly CascadeType[];
    readonly fetch: FetchType;
    readonly orphanRemoval: boolean;
    readonly optional: boolean;
    readonly orderBy?: string;
}

/** JPA-style field wrappers; they carry the target type but no runtime data. */
export interface OneToOne<Target> {
    readonly association: "one_to_one";
    readonly target: Target;
}
export interface OneToMany<Target> {
    readonly association: "one_to_many";
    readonly target: readonly Target[];
}
export interface ManyToOne<Target> {
    readonly association: "many_to_one";
    readonly target: Target;
}
export interface ManyToMany<Target> {
    readonly association: "many_to_many";
    readonly target: readonly Target[];
}

/** Complete entity metadata: table, key, columns, indexes and associations. */
export interface Entity<T = unknown> {
    readonly kind: EntityKind;
    readonly table: string;
    readonly schema?: string;
    readonly access: EntityAccess;
    readonly key: Key;
    readonly columns: readonly Column[];
    readonly indexes: readonly Index[];
    readonly uniqueConstraints: readonly UniqueConstraint[];
    readonly associations: readonly Association[];
    /** Column that carries @Version, when optimistic locking is enabled. */
    readonly versionColumn?: string;
    readonly descriptor: EntityDescriptor<T>;
}
