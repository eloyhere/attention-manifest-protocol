/**
 * JPA-style entity metadata for the SQLite kernel.
 *
 * The project compiles with `erasableSyntaxOnly`, so Java annotations are
 * represented as plain, immutable metadata objects instead of decorators. The
 * names and semantics intentionally mirror JPA: an entity owns a table, scalar
 * fields map to columns, and associations carry their own fetch, cascade,
 * join-column and orphan-removal rules. A repository or schema generator can
 * consume the metadata without depending on a class decorator runtime.
 */

import type { TableMeta } from "./meta.ts";

/**
 * Primitive identifier type accepted by an entity.
 *
 * JPA requires every entity to have a stable identity. SQLite commonly uses
 * integers or strings; `bigint` is included for identifiers that exceed the
 * safe integer range.
 */
export type PrimaryKey = number | bigint | string;

/**
 * Values of a composite identifier.
 *
 * JPA permits several `@Id` fields or one `@EmbeddedId` field. The metadata
 * keeps the individual values in field order so the persistence layer can
 * build the key without guessing.
 */
export type CompositeKey = readonly PrimaryKey[];

/**
 * Logical entity name used by associations.
 *
 * This is the JPA `@Entity(name = ...)` value, not necessarily the physical
 * table name.
 */
export type EntityName = string;

/**
 * Target entity reference for an association.
 *
 * A target is either the logical entity name or a no-argument entity
 * constructor. JPA requires entities to expose a no-argument constructor, so
 * the constructor form is enough to carry the target instance type through
 * `OneToOne<T>`, `OneToMany<T>`, `ManyToOne<T>` and `ManyToMany<T>`.
 *
 * @typeParam T - Target entity instance type.
 */
export type EntityTarget<T = object> = EntityName | (new () => T);

/**
 * Keys of a target entity that can be used by `mappedBy`.
 *
 * When the target type is left at its default `object`, no concrete keys are
 * available; the type widens to `string` so hand-written metadata remains
 * usable. Supplying `OneToMany<Post>` constrains `mappedBy` to the property
 * names of `Post`.
 *
 * @typeParam T - Target entity instance type.
 */
export type MappedByKey<T> = [keyof T] extends [never] ? string : Extract<keyof T, string>;

/**
 * Whether an association or basic attribute is loaded eagerly or lazily.
 */
export type Fetch = "eager" | "lazy";

/**
 * JPA cascade modes that may be applied to an association.
 *
 * `"All"` is shorthand for every other mode and must not be combined with an
 * individual mode in the same cascade declaration.
 */
export type CascadeType = "All" | "Persist" | "Merge" | "Remove" | "Refresh" | "Detach";

/**
 * JPA identifier-generation strategies.
 *
 * - `Auto`: let the persistence provider choose.
 * - `Identity`: rely on the database identity column.
 * - `Sequence`: use a database sequence.
 * - `Table`: use a generator table.
 */
export type GenerationType = "Auto" | "Identity" | "Sequence" | "Table";

/**
 * Storage strategy for an enum-valued field.
 */
export type Enumeration = "Ordinal" | "String";

/**
 * Temporal precision for a date/time field.
 */
export type Temporal = "Date" | "Time" | "Timestamp";

/**
 * Whether persistent fields are discovered through fields or accessors.
 */
export type Access = "Field" | "Property";

/**
 * Entity lifecycle state, mirroring the JPA `EntityManager` states.
 */
export type EntityState = "New" | "Managed" | "Detached" | "Removed";

/**
 * JPA inheritance strategies.
 */
export type InheritanceStrategy = "SingleTable" | "Joined" | "TablePerClass";

/**
 * JPA lifecycle callback events.
 */
export type LifecycleEvent = "prePersist" | "postPersist" | "preUpdate" | "postUpdate" | "preRemove" | "postRemove" | "postLoad";

/**
 * Callback invoked for one entity lifecycle event.
 */
export type LifecycleCallback = (entity: unknown) => void;

/**
 * Lifecycle callbacks attached to an entity.
 *
 * A single event may have one callback or several callbacks executed in
 * declaration order.
 */
export type LifecycleCallbacks = Partial<Record<LifecycleEvent, LifecycleCallback | readonly LifecycleCallback[]>>;

/**
 * JPA `AttributeConverter` analogue.
 *
 * Converts a field value of type `X` to a database value of type `Y` and
 * back. Keeping the converter generic lets `Column<T>` and `Field<T>` retain
 * the caller's value type without a runtime dependency.
 *
 * @typeParam X - Entity attribute type.
 * @typeParam Y - Database column type.
 */
export interface AttributeConverter<X = unknown, Y = unknown> {
    /**
     * Convert an attribute value for storage.
     *
     * @param attribute - Entity attribute value.
     * @returns Database column value.
     */
    convertToDatabaseColumn(attribute: X): Y;
    /**
     * Convert a stored value back to the entity attribute type.
     *
     * @param dbData - Database column value.
     * @returns Entity attribute value.
     */
    convertToEntityAttribute(dbData: Y): X;
}

/**
 * Column mapping options, corresponding to JPA `@Column`.
 *
 * Omitted values follow JPA defaults: nullable, insertable and updatable are
 * true; length is provider-defined; precision and scale are zero. The kernel
 * does not silently rewrite a mapping, so a caller that needs a default should
 * leave the option absent and let the schema generator apply it.
 *
 * @typeParam T - Entity attribute type stored in the column.
 */
export interface Column<T = unknown> {
    /**
     * Physical column name; defaults to the logical field name.
     */
    readonly name?: string;
    /**
     * Optional table name for a secondary-table mapping.
     */
    readonly table?: string;
    /**
     * Whether the column accepts SQL NULL.
     */
    readonly nullable?: boolean;
    /**
     * Whether a unique constraint is implied by this column.
     */
    readonly unique?: boolean;
    /**
     * Whether the column participates in INSERT statements.
     */
    readonly insertable?: boolean;
    /**
     * Whether the column participates in UPDATE statements.
     */
    readonly updatable?: boolean;
    /**
     * Maximum character length for string columns.
     */
    readonly length?: number;
    /**
     * Numeric precision for exact decimal columns.
     */
    readonly precision?: number;
    /**
     * Numeric scale for exact decimal columns.
     */
    readonly scale?: number;
    /**
     * Provider-specific SQL type fragment.
     */
    readonly columnDefinition?: string;
    /**
     * Optional attribute converter for this column.
     */
    readonly converter?: AttributeConverter<T, unknown>;
}

/**
 * Identifier-generation options, corresponding to JPA `@GeneratedValue`.
 */
export interface GeneratedValue {
    /**
     * Generation strategy; `auto` when omitted.
     */
    readonly strategy?: GenerationType;
    /**
     * Named generator shared with a sequence or table generator.
     */
    readonly generator?: string;
    /**
     * Initial value for sequence/table strategies.
     */
    readonly initialValue?: number;
    /**
     * Allocation size for sequence/table strategies.
     */
    readonly allocationSize?: number;
}

/**
 * Metadata for one persistent scalar field.
 *
 * `id`/`embeddedId`, `version` and `transient` are mutually exclusive in the
 * usual JPA sense: an identifier is not a version, and a transient field is
 * never persisted.
 *
 * @typeParam T - Field value type.
 */
export interface Field<T = unknown> {
    /**
     * Logical property name on the entity.
     */
    readonly name: string;
    /**
     * Optional physical column mapping.
     */
    readonly column?: Column<T>;
    /**
     * Marks the single entity identifier.
     */
    readonly id?: boolean;
    /**
     * Identifier generation for an `id` field.
     */
    readonly generated?: GeneratedValue;
    /**
     * Marks a field as an `@EmbeddedId` composite identifier.
     */
    readonly embeddedId?: boolean;
    /**
     * Marks the optimistic-locking version field.
     */
    readonly version?: boolean;
    /**
     * Excludes the field from persistence.
     */
    readonly transient?: boolean;
    /**
     * Whether the basic attribute may be NULL.
     */
    readonly optional?: boolean;
    /**
     * Fetch strategy for a basic attribute that supports lazy loading.
     */
    readonly fetch?: Fetch;
    /**
     * Enum storage strategy for enum-valued fields.
     */
    readonly Enumeration?: Enumeration;
    /**
     * Temporal precision for date/time fields.
     */
    readonly temporal?: Temporal;
    /**
     * Marks a large-object column.
     */
    readonly lob?: boolean;
    /**
     * Per-field access override.
     */
    readonly access?: Access;
    /**
     * Optional property getter for `Access "Property"`.
     */
    readonly get?: (entity: unknown) => T;
    /**
     * Optional property setter for `Access "Property"`.
     */
    readonly set?: (entity: unknown, value: T) => void;
}

/**
 * Foreign-key options for a join column, corresponding to JPA `@ForeignKey`.
 */
export interface ForeignKey {
    /**
     * Constraint name.
     */
    readonly name?: string;
    /**
     * Provider-specific constraint definition.
     */
    readonly definition?: string;
}

/**
 * Join-column mapping, corresponding to JPA `@JoinColumn`.
 */
export interface JoinColumn {
    /**
     * Physical foreign-key column name.
     */
    readonly name?: string;
    /**
     * Referenced column on the target table.
     */
    readonly referencedColumnName?: string;
    /**
     * Whether the foreign key may be NULL.
     */
    readonly nullable?: boolean;
    /**
     * Whether the join column is unique.
     */
    readonly unique?: boolean;
    /**
     * Whether the column participates in INSERT statements.
     */
    readonly insertable?: boolean;
    /**
     * Whether the column participates in UPDATE statements.
     */
    readonly updatable?: boolean;
    /**
     * Provider-specific SQL type fragment.
     */
    readonly columnDefinition?: string;
    /**
     * Optional secondary table for the join column.
     */
    readonly table?: string;
    /**
     * Foreign-key constraint options.
     */
    readonly foreignKey?: ForeignKey;
}

/**
 * Unique constraint metadata for a table or join table.
 */
export interface UniqueConstraint {
    /**
     * Optional constraint name.
     */
    readonly name?: string;
    /**
     * Columns participating in the constraint.
     */
    readonly columnNames: readonly string[];
}

/**
 * Index metadata for a table or join table.
 */
export interface Index {
    /**
     * Optional index name.
     */
    readonly name?: string;
    /**
     * Comma-separated column list, mirroring JPA `@Index.columnList`.
     */
    readonly columnList: string;
    /**
     * Whether the index is unique.
     */
    readonly unique?: boolean;
}

/**
 * Join-table mapping for a many-to-many or unidirectional one-to-many
 * association, corresponding to JPA `@JoinTable`.
 */
export interface JoinTable {
    /**
     * Physical join-table name.
     */
    readonly name: string;
    /**
     * Optional catalog.
     */
    readonly catalog?: string;
    /**
     * Optional schema.
     */
    readonly schema?: string;
    /**
     * Columns referencing the owning entity.
     */
    readonly joinColumns?: readonly JoinColumn[];
    /**
     * Columns referencing the inverse entity.
     */
    readonly inverseJoinColumns?: readonly JoinColumn[];
    /**
     * Unique constraints on the join table.
     */
    readonly uniqueConstraints?: readonly UniqueConstraint[];
    /**
     * Indexes on the join table.
     */
    readonly indexes?: readonly Index[];
}

/**
 * Physical table mapping, corresponding to JPA `@Table`.
 */
export interface Table {
    /**
     * Physical table name.
     */
    readonly name: string;
    /**
     * Optional catalog.
     */
    readonly catalog?: string;
    /**
     * Optional schema.
     */
    readonly schema?: string;
    /**
     * Table-level unique constraints.
     */
    readonly uniqueConstraints?: readonly UniqueConstraint[];
    /**
     * Table-level indexes.
     */
    readonly indexes?: readonly Index[];
}

/**
 * Cascade options for an association.
 *
 * JPA's `cascade` attribute is a set of modes. Orphan removal belongs to the
 * owning association (`OneToOne` or `OneToMany`), not to the cascade set.
 */
export interface Cascade {
    /**
     * Cascade modes applied to the association.
     */
    readonly types: readonly CascadeType[];
}

/**
 * Common association metadata, corresponding to JPA's association annotations.
 *
 * @typeParam T - Target entity instance type.
 */
export interface Relate<T = object> {
    /**
     * Logical property name on the owning entity.
     */
    readonly name: string;
    /**
     * Target logical entity name.
     */
    readonly target: EntityTarget<T>;
    /**
     * Fetch strategy.
     */
    readonly fetch?: Fetch;
    /**
     * Cascade and orphan-removal rules.
     */
    readonly cascade?: Cascade;
    /**
     * Whether the association may be absent.
     */
    readonly optional?: boolean;
}

/**
 * One-to-one association metadata, corresponding to JPA `@OneToOne`.
 *
 * @typeParam T - Target entity instance type; also constrains `mappedBy`.
 */
export interface OneToOne<T extends object = object> extends Relate<T> {
    /**
     * Inverse-side field name on the target entity.
     */
    readonly mappedBy?: MappedByKey<T>;
    /**
     * Owning-side join columns.
     */
    readonly joinColumns?: readonly JoinColumn[];
    /**
     * Optional join table for a unidirectional mapping.
     */
    readonly joinTable?: JoinTable;
    /**
     * Whether removing the parent removes the child.
     */
    readonly orphanRemoval?: boolean;
}

/**
 * One-to-many association metadata, corresponding to JPA `@OneToMany`.
 *
 * @typeParam T - Target entity instance type; also constrains `mappedBy`.
 */
export interface OneToMany<T extends object = object> extends Relate<T> {
    /**
     * Field on the target entity that owns the foreign key.
     */
    readonly mappedBy?: MappedByKey<T>;
    /**
     * Optional join table for a unidirectional mapping.
     */
    readonly joinTable?: JoinTable;
    /**
     * JPA `orderBy` fragment.
     */
    readonly orderBy?: string;
    /**
     * Whether removing the parent removes the children.
     */
    readonly orphanRemoval?: boolean;
}

/**
 * Many-to-one association metadata, corresponding to JPA `@ManyToOne`.
 *
 * @typeParam T - Target entity instance type.
 */
export interface ManyToOne<T extends object = object> extends Relate<T> {
    /**
     * Owning-side join columns.
     */
    readonly joinColumns?: readonly JoinColumn[];
}

/**
 * Many-to-many association metadata, corresponding to JPA `@ManyToMany`.
 *
 * @typeParam T - Target entity instance type; also constrains `mappedBy`.
 */
export interface ManyToMany<T extends object = object> extends Relate<T> {
    /**
     * Inverse-side field name on the target entity.
     */
    readonly mappedBy?: MappedByKey<T>;
    /**
     * Owning-side join table.
     */
    readonly joinTable?: JoinTable;
    /**
     * JPA `orderBy` fragment.
     */
    readonly orderBy?: string;
}

/**
 * Any supported association.
 *
 * @typeParam T - Target entity instance type.
 */
export type Relation<T extends object = object> = OneToOne<T> | OneToMany<T> | ManyToOne<T> | ManyToMany<T>;

/**
 * Inheritance mapping metadata, corresponding to JPA `@Inheritance`.
 */
export interface Inheritance {
    /**
     * Inheritance strategy.
     */
    readonly strategy: InheritanceStrategy;
}

/**
 * Discriminator-column options for single-table inheritance.
 */
export interface DiscriminatorColumn extends Column<string> {
    /**
     * SQL discriminator type.
     */
    readonly discriminatorType?: "string" | "char" | "integer";
}

/**
 * Complete metadata for one JPA-style entity.
 *
 * The interface is deliberately data-only: it can be frozen, serialized,
 * compared, or passed across module boundaries without class decorators or
 * `reflect-metadata`.
 */
export interface Entity {
    /**
     * Logical entity name used by associations.
     */
    readonly name: string;
    /**
     * Physical table mapping.
     */
    readonly table: Table;
    /**
     * Default access strategy for persistent fields.
     */
    readonly access?: Access;
    /**
     * Persistent scalar fields, including the identifier.
     */
    readonly fields: readonly Field[];
    /**
     * Associations owned by this entity.
     */
    readonly relations?: readonly Relation[];
    /**
     * JPA `@IdClass` type name for a composite identifier.
     */
    readonly idClass?: string;
    /**
     * Inheritance mapping, when the entity is part of a hierarchy.
     */
    readonly inheritance?: Inheritance;
    /**
     * Discriminator column for single-table inheritance.
     */
    readonly discriminatorColumn?: DiscriminatorColumn;
    /**
     * Discriminator value for this entity.
     */
    readonly discriminatorValue?: string;
    /**
     * JPA entity-listener class names.
     */
    readonly listeners?: readonly string[];
    /**
     * Lifecycle callbacks keyed by event.
     */
    readonly lifecycle?: LifecycleCallbacks;
    /**
     * Whether the entity may be cached by the provider.
     */
    readonly cacheable?: boolean;
}

/**
 * Error raised when entity metadata violates a JPA structural rule.
 */
export class EntityMetadataError extends Error {
    /**
     * All validation problems discovered for the entity.
     */
    readonly problems: readonly string[];

    constructor(entityName: string, problems: readonly string[]) {
        super(`Invalid entity metadata for ${entityName}: ${problems.join("; ")}`);
        this.name = "EntityMetadataError";
        this.problems = [...problems];
    }
}

/**
 * Validate the structural rules that can be checked without a database.
 *
 * The checks cover identifier rules (including composite keys), duplicate
 * property names, mutually exclusive field flags, basic column constraints,
 * cascade sets and relation targets. Cross-entity rules such as `mappedBy`
 * resolution require the registry and are intentionally left to the
 * persistence layer.
 *
 * @param entity - Entity metadata to validate.
 * @returns A list of problems; an empty array means the metadata is valid.
 */
export const validateEntity: (entity: Entity) => string[] = (entity: Entity): string[] => {
    const problems: string[] = [];
    const entityName: string = entity.name?.trim() ?? "";
    if (entityName.length === 0) {
        problems.push("entity name must not be empty");
    }

    if (entity.table === (void 0)) {
        problems.push("entity must declare a table");
    } else {
        if (entity.table.name.trim().length === 0) {
            problems.push("table name must not be empty");
        }
        problems.push(...validateTable(entity.table));
    }

    const fields: readonly Field[] = entity.fields ?? [];
    const names: Set<string> = new Set<string>();
    let identifiers: number = 0;
    let embeddedIdentifiers: number = 0;
    let generatedIdentifiers: number = 0;
    let versions: number = 0;

    for (let index: number = 0; index < fields.length; index += 1) {
        const field: Field = fields[index];
        if (field.name.trim().length === 0) {
            problems.push("field name must not be empty");
            continue;
        }
        if (names.has(field.name)) {
            problems.push(`duplicate property name: ${field.name}`);
        }
        names.add(field.name);

        if (field.id === true) {
            identifiers += 1;
        }
        if (field.embeddedId === true) {
            identifiers += 1;
            embeddedIdentifiers += 1;
        }
        if (field.generated !== (void 0) && field.id === true) {
            generatedIdentifiers += 1;
        }
        if (field.version === true) {
            versions += 1;
        }
        if (field.id === true && field.version === true) {
            problems.push(`${field.name} cannot be both an id and a version`);
        }
        if (field.id === true && field.embeddedId === true) {
            problems.push(`${field.name} cannot be both id and embeddedId`);
        }
        if (field.embeddedId === true && field.version === true) {
            problems.push(`${field.name} cannot be both an embeddedId and a version`);
        }
        if (field.embeddedId === true && field.transient === true) {
            problems.push(`${field.name} cannot be both an embeddedId and transient`);
        }
        if (field.id === true && field.transient === true) {
            problems.push(`${field.name} cannot be both an id and transient`);
        }
        if (field.generated !== (void 0) && field.id !== true && field.embeddedId !== true) {
            problems.push(`${field.name} declares generated value without id`);
        }
        if (field.transient === true && field.column !== (void 0)) {
            problems.push(`${field.name} is transient but declares a column`);
        }
        if (field.column !== (void 0)) {
            problems.push(...validateColumn(field.name, field.column));
        }
        if (field.temporal !== (void 0) && field.lob === true) {
            problems.push(`${field.name} cannot be both temporal and a LOB`);
        }
    }

    if (identifiers === 0) {
        problems.push("entity must declare at least one id field");
    }
    if (embeddedIdentifiers > 0 && identifiers > 1) {
        problems.push("embeddedId cannot be combined with other id fields");
    }
    if (identifiers > 1 && entity.idClass === (void 0)) {
        problems.push("composite identifier requires idClass");
    }
    if (identifiers > 1 && entity.idClass !== (void 0) && entity.idClass.trim().length === 0) {
        problems.push("idClass must not be empty");
    }
    if (generatedIdentifiers > 0 && identifiers > 1) {
        problems.push("generated value is only valid on a single id field");
    }
    if (versions > 1) {
        problems.push("entity must declare at most one version field");
    }

    const relations: readonly Relation[] = entity.relations ?? [];
    for (let index: number = 0; index < relations.length; index += 1) {
        const relation: Relation = relations[index];
        if (relation.name.trim().length === 0) {
            problems.push("relation name must not be empty");
            continue;
        }
        if (names.has(relation.name)) {
            problems.push(`duplicate property name: ${relation.name}`);
        }
        names.add(relation.name);
        const targetName: string = typeof(relation.target) === "string" ? relation.target : relation.target.name;
        if (targetName.trim().length === 0) {
            problems.push(`relation ${relation.name} has an empty target`);
        }
        if (relation.cascade !== (void 0)) {
            problems.push(...validateCascade(relation.name, relation.cascade));
        }
        if ("joinTable" in relation && relation.joinTable !== (void 0)) {
            problems.push(...validateJoinTable(relation.name, relation.joinTable));
        }
    }

    if (entity.discriminatorColumn !== (void 0)) {
        if (entity.discriminatorColumn.name === (void 0)) {
            problems.push("discriminator column must declare a name");
        }
        problems.push(...validateColumn(entity.discriminatorColumn.name ?? "discriminator", entity.discriminatorColumn));
    }

    return problems;
};

/**
 * Assert that entity metadata is valid.
 *
 * @param entity - Entity metadata to validate.
 * @returns The same entity when valid.
 * @throws EntityMetadataError when any structural rule is violated.
 */
export const defineEntity: (entity: Entity) => Entity = (entity: Entity): Entity => {
    const problems: string[] = validateEntity(entity);
    if (problems.length > 0) {
        throw new EntityMetadataError(entity.name, problems);
    }
    return entity;
};

/**
 * Derive the legacy {@link TableMeta} view of an entity.
 *
 * The SQL layer and existing repositories only need a table name, one primary
 * key and the persisted column list. Fields are used when a field has no
 * explicit column mapping; relations are not columns and are omitted.
 *
 * @param entity - Validated entity metadata.
 * @returns Table metadata compatible with the repository base classes.
 * @throws EntityMetadataError when no identifier is declared.
 */
export const toTableMeta: (entity: Entity) => TableMeta = (entity: Entity): TableMeta => {
    const identifier: Field | undefined = entity.fields.find((field: Field) => field.id === true);
    if (identifier === (void 0)) {
        throw new EntityMetadataError(entity.name, ["entity has no id field"]);
    }
    return {
        table: entity.table.name,
        primaryKey: identifier.column?.name ?? identifier.name,
        columns: entity.fields.map((field: Field) => field.column?.name ?? field.name),
    };
};

/**
 * Build a cascade declaration.
 *
 * @param types - Cascade modes; `"All"` must be used alone.
 * @returns An immutable cascade metadata object.
 */
export const cascade: (...types: CascadeType[]) => Cascade = (...types: CascadeType[]): Cascade => {
    return { types: [...types] };
};

/**
 * In-memory registry of entity metadata, analogous to a JPA `Metamodel`.
 *
 * The registry does not own a connection and does not resolve SQL. It only
 * enforces unique entity names and validates metadata at registration time.
 */
export class EntityRegistry {
    private readonly entities = new Map<EntityName, Entity>();

    /**
     * Register one entity.
     *
     * @param entity - Validated entity metadata.
     * @returns This registry, for chaining.
     * @throws EntityMetadataError for invalid or duplicate metadata.
     */
    register(entity: Entity): this {
        const problems: string[] = validateEntity(entity);
        if (problems.length > 0) {
            throw new EntityMetadataError(entity.name, problems);
        }
        if (this.entities.has(entity.name)) {
            throw new EntityMetadataError(entity.name, ["an entity with this name is already registered"]);
        }
        this.entities.set(entity.name, entity);
        return this;
    }

    /**
     * Look up an entity by logical name.
     *
     * @param name - Logical entity name.
     * @returns Registered metadata, or `undefined`.
     */
    get(name: EntityName): Entity | undefined {
        return this.entities.get(name);
    }

    /**
     * Test whether an entity is registered.
     *
     * @param name - Logical entity name.
     * @returns `true` when the entity has been registered.
     */
    has(name: EntityName): boolean {
        return this.entities.has(name);
    }

    /**
     * Return registered entity names in registration order.
     *
     * @returns A fresh array of logical entity names.
     */
    names(): EntityName[] {
        return [...this.entities.keys()];
    }

    /**
     * Remove every registration.
     */
    clear(): void {
        this.entities.clear();
    }
}

/**
 * Validate column-level constraints shared by fields and join columns.
 *
 * @param propertyName - Field name used in error messages.
 * @param column - Column metadata.
 * @returns Problems found in the column mapping.
 */
const validateColumn: <T>(propertyName: string, column: Column<T>) => string[] = <T>(propertyName: string, column: Column<T>): string[] => {
    const problems: string[] = [];
    if (column.name !== (void 0) && column.name.trim().length === 0) {
        problems.push(`${propertyName} has an empty column name`);
    }
    if (column.table !== (void 0) && column.table.trim().length === 0) {
        problems.push(`${propertyName} has an empty column table`);
    }
    if (column.length !== (void 0) && (!Number.isInteger(column.length) || column.length <= 0)) {
        problems.push(`${propertyName} column length must be a positive integer`);
    }
    if (column.precision !== (void 0) && (!Number.isInteger(column.precision) || column.precision < 0)) {
        problems.push(`${propertyName} column precision must be a non-negative integer`);
    }
    if (column.scale !== (void 0) && (!Number.isInteger(column.scale) || column.scale < 0)) {
        problems.push(`${propertyName} column scale must be a non-negative integer`);
    }
    if (column.precision !== (void 0) && column.scale !== (void 0) && column.scale > column.precision) {
        problems.push(`${propertyName} column scale cannot exceed precision`);
    }
    return problems;
};

/**
 * Validate table-level metadata.
 *
 * @param table - Table metadata.
 * @returns Problems found in the table mapping.
 */
const validateTable: (table: Table) => string[] = (table: Table): string[] => {
    const problems: string[] = [];
    const indexNames: Set<string> = new Set<string>();
    const indexes: readonly Index[] = table.indexes ?? [];
    for (let position: number = 0; position < indexes.length; position += 1) {
        const index: Index = indexes[position];
        if (index.columnList.trim().length === 0) {
            problems.push("index columnList must not be empty");
        }
        if (index.name !== (void 0)) {
            if (indexNames.has(index.name)) {
                problems.push(`duplicate index name: ${index.name}`);
            }
            indexNames.add(index.name);
        }
    }
    const constraintNames: Set<string> = new Set<string>();
    const constraints: readonly UniqueConstraint[] = table.uniqueConstraints ?? [];
    for (let position: number = 0; position < constraints.length; position += 1) {
        const constraint: UniqueConstraint = constraints[position];
        if (constraint.columnNames.length === 0) {
            problems.push("unique constraint must contain at least one column");
        }
        if (constraint.name !== (void 0)) {
            if (constraintNames.has(constraint.name)) {
                problems.push(`duplicate unique constraint name: ${constraint.name}`);
            }
            constraintNames.add(constraint.name);
        }
    }
    return problems;
};

/**
 * Validate a cascade declaration.
 *
 * @param relationName - Association name used in error messages.
 * @param cascade - Cascade metadata.
 * @returns Problems found in the cascade set.
 */
const validateCascade: (relationName: string, cascade: Cascade) => string[] = (relationName: string, cascade: Cascade): string[] => {
    const problems: string[] = [];
    if (cascade.types.length === 0) {
        problems.push(`relation ${relationName} declares an empty cascade set`);
    }
    if (cascade.types.includes("All") && cascade.types.length > 1) {
        problems.push(`relation ${relationName} cannot combine all with other cascades`);
    }
    const seen: Set<CascadeType> = new Set<CascadeType>();
    for (let position: number = 0; position < cascade.types.length; position += 1) {
        const type: CascadeType = cascade.types[position];
        if (seen.has(type)) {
            problems.push(`relation ${relationName} repeats cascade ${type}`);
        }
        seen.add(type);
    }
    return problems;
};

/**
 * Validate join-table metadata.
 *
 * @param relationName - Association name used in error messages.
 * @param joinTable - Join-table metadata.
 * @returns Problems found in the join-table mapping.
 */
const validateJoinTable: (relationName: string, joinTable: JoinTable) => string[] = (relationName: string, joinTable: JoinTable): string[] => {
    const problems: string[] = [];
    if (joinTable.name.trim().length === 0) {
        problems.push(`relation ${relationName} has an empty join table name`);
    }
    if (joinTable.joinColumns !== (void 0) && joinTable.joinColumns.length === 0) {
        problems.push(`relation ${relationName} join table has no join columns`);
    }
    if (joinTable.inverseJoinColumns !== (void 0) && joinTable.inverseJoinColumns.length === 0) {
        problems.push(`relation ${relationName} join table has no inverse join columns`);
    }
    return problems;
};
