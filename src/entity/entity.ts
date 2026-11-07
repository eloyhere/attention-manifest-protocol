/**
 * JPA-style entity metadata construction: descriptors (payload encoding), column
 * metadata, indexes, unique constraints, associations and `@Version` columns.
 */

import { isFunction, isObject, isString, SynchronousUnorderedMap, SynchronousUnorderedSet } from "semantic-typescript";
import { normalizeAssociation } from "./associate.ts";
import { assertKey, isEntityKind, keyOf, toColumnName } from "./key.ts";
import type {
    Association,
    Column,
    EntityAccess,
    EntityDescriptor,
    EntityKind,
    Entity,
    EntityRecord,
    Index,
    Key,
    UniqueConstraint,
} from "./types.ts";

/** Options accepted by `jsonDescriptor`. */
export interface JsonDescriptorOptions<T> {
    readonly table?: string;
    readonly idOf: (entity: T) => string;
    readonly tenantOf?: (entity: T) => string | undefined;
    readonly sessionOf?: (entity: T) => string | undefined;
    readonly kindOf?: (entity: T) => string | undefined;
    readonly versionOf?: (entity: T) => number;
    readonly updatedAtOf?: (entity: T) => string;
}

function requireText(value: unknown, label: string): string {
    if (!isString(value) || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
    return value;
}

function requireUniqueStrings(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty string array`);
    const seen = new SynchronousUnorderedSet<string>();
    const result: string[] = [];
    for (const entry of value) {
        requireText(entry, `${label} entry`);
        if (seen.contains(entry)) throw new TypeError(`${label} contains a duplicate: ${entry}`);
        seen.add(entry);
        result.push(entry);
    }
    return Object.freeze(result);
}

function optionalSafeInteger(value: unknown, label: string, minimum: number): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
    }
    return value;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Readonly<Record<string, unknown>>;
}

function textField(value: unknown, property: string): string | undefined {
    const record = recordOf(value);
    if (!record) return undefined;
    const field = record[property];
    return isString(field) && field.trim() !== "" ? field : undefined;
}

function readOptionalText<T>(
    reader: ((entity: T) => string | undefined) | undefined,
    entity: T,
    label: string,
): string | undefined {
    if (reader === undefined) return undefined;
    const value = reader(entity);
    if (value === undefined || value === null) return undefined;
    if (!isString(value) || value.trim() === "") throw new TypeError(`${label} must return a non-empty string or undefined`);
    return value;
}

/**
 * Asserts that a value is a complete `EntityDescriptor`: a known kind, a
 * non-empty table and every required function.
 */
export function assertDescriptor(descriptor: unknown): asserts descriptor is EntityDescriptor<unknown> {
    if (!isObject(descriptor) || Array.isArray(descriptor)) throw new TypeError("entity descriptor must be an object");
    const candidate = descriptor as Partial<EntityDescriptor<unknown>>;
    if (!isEntityKind(candidate.kind)) throw new TypeError(`unknown entity descriptor kind: ${String(candidate.kind)}`);
    requireText(candidate.table, "entity descriptor table");
    for (const name of ["keyOf", "encode", "decode", "versionOf"] as const) {
        if (!isFunction(candidate[name])) throw new TypeError(`entity descriptor requires ${name}()`);
    }
}

/**
 * Builds a JSON descriptor for one aggregate. `payload` is the entity itself;
 * `decode` structured-clones it so callers never share references with the
 * encoded record. Version defaults to 0 and `updatedAt` defaults to now.
 */
export function jsonDescriptor<T>(kind: EntityKind, options: JsonDescriptorOptions<T>): EntityDescriptor<T> {
    if (!isEntityKind(kind)) throw new TypeError(`unknown entity kind: ${String(kind)}`);
    if (!isObject(options) || Array.isArray(options)) throw new TypeError("descriptor options must be an object");
    if (!isFunction(options.idOf)) throw new TypeError("descriptor options require idOf()");
    for (const [name, reader] of [
        ["tenantOf", options.tenantOf],
        ["sessionOf", options.sessionOf],
        ["kindOf", options.kindOf],
        ["versionOf", options.versionOf],
        ["updatedAtOf", options.updatedAtOf],
    ] as const) {
        if (reader !== undefined && !isFunction(reader)) throw new TypeError(`descriptor option ${name} must be a function`);
    }
    const table = requireText(options.table ?? "entities", "descriptor table");

    const keyOfEntity = (entity: T): string => {
        const id = options.idOf(entity);
        if (!isString(id) || id.trim() === "") throw new TypeError(`entity ${kind} has no usable id`);
        return id;
    };
    const versionOfEntity = (entity: T): number => {
        const version = options.versionOf === undefined ? 0 : options.versionOf(entity);
        if (!Number.isSafeInteger(version) || version < 0) throw new TypeError(`entity ${kind} version must be a non-negative safe integer`);
        return version;
    };
    const updatedAtOfEntity = (entity: T): string => {
        if (options.updatedAtOf === undefined) return new Date().toISOString();
        return requireText(options.updatedAtOf(entity), `entity ${kind} updatedAt`);
    };
    const encode = (entity: T): EntityRecord => {
        const id = keyOfEntity(entity);
        const tenantId = readOptionalText(options.tenantOf, entity, "tenantOf");
        const sessionId = readOptionalText(options.sessionOf, entity, "sessionOf");
        const entityKind = readOptionalText(options.kindOf, entity, "kindOf");
        return Object.freeze({
            id,
            ...(tenantId === undefined ? {} : { tenantId }),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(entityKind === undefined ? {} : { kind: entityKind }),
            version: versionOfEntity(entity),
            updatedAt: updatedAtOfEntity(entity),
            payload: entity,
        });
    };
    const decode = (record: EntityRecord): T => {
        if (!isObject(record) || Array.isArray(record)) throw new TypeError("entity record must be an object");
        return structuredClone(record.payload) as T;
    };

    return Object.freeze({
        kind,
        table,
        keyOf: keyOfEntity,
        encode,
        decode,
        versionOf: versionOfEntity,
    });
}

/** Options for `column`. */
export interface ColumnOptions {
    readonly column?: string;
    readonly nullable?: boolean;
    readonly unique?: boolean;
    readonly insertable?: boolean;
    readonly updatable?: boolean;
    readonly version?: boolean;
    readonly transient?: boolean;
    readonly length?: number;
    readonly precision?: number;
    readonly scale?: number;
}

/** Object-style argument for `column`. */
export interface ColumnInput extends ColumnOptions {
    readonly property: string;
}

function optionalBoolean(value: unknown, fallback: boolean, label: string): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
    return value;
}

function normalizeColumn(value: unknown): Column {
    if (!isObject(value) || Array.isArray(value)) throw new TypeError("column metadata must be an object");
    const candidate = value as Partial<Column>;
    const property = requireText(candidate.property, "column property");
    const column = requireText(candidate.column ?? toColumnName(property), `column for ${property}`);
    const version = optionalBoolean(candidate.version, false, "column version");
    const transient = optionalBoolean(candidate.transient, false, "column transient");
    if (version && transient) throw new TypeError(`column ${column} cannot be both a version column and transient`);
    const length = optionalSafeInteger(candidate.length, `column ${column} length`, 1);
    const precision = optionalSafeInteger(candidate.precision, `column ${column} precision`, 0);
    const scale = optionalSafeInteger(candidate.scale, `column ${column} scale`, 0);
    if (scale !== undefined && (precision === undefined || scale > precision)) {
        throw new TypeError(`column ${column} scale requires precision >= scale`);
    }
    return Object.freeze({
        property,
        column,
        nullable: optionalBoolean(candidate.nullable, true, "column nullable"),
        unique: optionalBoolean(candidate.unique, false, "column unique"),
        insertable: optionalBoolean(candidate.insertable, true, "column insertable"),
        updatable: optionalBoolean(candidate.updatable, true, "column updatable"),
        version,
        transient,
        ...(length === undefined ? {} : { length }),
        ...(precision === undefined ? {} : { precision }),
        ...(scale === undefined ? {} : { scale }),
    });
}

/** Builds a `@Column` description; `column` defaults to the snake_case property. */
export function column(propertyOrInput: string | ColumnInput, options: ColumnOptions = {}): Column {
    if (isString(propertyOrInput)) return normalizeColumn({ ...options, property: propertyOrInput });
    if (!isObject(propertyOrInput) || Array.isArray(propertyOrInput)) throw new TypeError("column input must be a string or object");
    return normalizeColumn(propertyOrInput);
}

/** Options for `index`. */
export interface IndexOptions {
    readonly unique?: boolean;
}

/** Builds a `@Table(indexes = ...)` entry. */
export function index(name: string, columns: readonly string[], options: IndexOptions = {}): Index {
    const normalizedName = requireText(name, "index name");
    const normalizedColumns = requireUniqueStrings(columns, `index ${normalizedName} columns`);
    const unique = optionalBoolean(options.unique, false, "index unique");
    return Object.freeze({ name: normalizedName, columns: normalizedColumns, unique });
}

/** Builds a `@Table(uniqueConstraints = ...)` entry. */
export function uniqueConstraint(name: string, columns: readonly string[]): UniqueConstraint {
    const normalizedName = requireText(name, "unique constraint name");
    return Object.freeze({
        name: normalizedName,
        columns: requireUniqueStrings(columns, `unique constraint ${normalizedName} columns`),
    });
}

/** Entity metadata input; `indexes`, `uniqueConstraints`, `associations` and `descriptor` are optional. */
export interface EntityDefinition<T> {
    readonly kind: EntityKind;
    readonly table: string;
    readonly schema?: string;
    readonly access?: EntityAccess;
    readonly key: Key;
    readonly columns: readonly Column[];
    readonly indexes?: readonly Index[];
    readonly uniqueConstraints?: readonly UniqueConstraint[];
    readonly associations?: readonly Association[];
    readonly versionColumn?: string;
    readonly descriptor?: EntityDescriptor<T>;
}

function normalizeIndex(value: unknown): Index {
    if (!isObject(value) || Array.isArray(value)) throw new TypeError("index metadata must be an object");
    const candidate = value as Partial<Index>;
    const name = requireText(candidate.name, "index name");
    return Object.freeze({
        name,
        columns: requireUniqueStrings(candidate.columns, `index ${name} columns`),
        unique: optionalBoolean(candidate.unique, false, "index unique"),
    });
}

function normalizeUniqueConstraint(value: unknown): UniqueConstraint {
    if (!isObject(value) || Array.isArray(value)) throw new TypeError("unique constraint metadata must be an object");
    const candidate = value as Partial<UniqueConstraint>;
    const name = requireText(candidate.name, "unique constraint name");
    return Object.freeze({
        name,
        columns: requireUniqueStrings(candidate.columns, `unique constraint ${name} columns`),
    });
}

function defaultDescriptor<T>(kind: EntityKind, table: string, key: Key, versionProperty = "version"): EntityDescriptor<T> {
    return jsonDescriptor<T>(kind, {
        table,
        idOf: entity => keyOf(key, entity),
        tenantOf: entity => textField(entity, "tenantId"),
        sessionOf: entity => textField(entity, "sessionId"),
        kindOf: entity => textField(entity, "kind"),
        versionOf: entity => {
            const value = recordOf(entity)?.[versionProperty];
            if (value === undefined) return 0;
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
                throw new TypeError(`entity ${kind} version must be a non-negative safe integer`);
            }
            return value;
        },
        updatedAtOf: entity => textField(entity, "updatedAt") ?? textField(entity, "createdAt") ?? new Date().toISOString(),
    });
}

/**
 * Builds and validates complete entity metadata: key properties map to columns,
 * column names are unique, index/unique-constraint columns exist, association
 * properties are unique with valid targets, and the `@Version` column exists
 * and is flagged as such.
 */
export function entity<T>(definition: EntityDefinition<T>): Entity<T> {
    if (!isObject(definition) || Array.isArray(definition)) throw new TypeError("entity definition must be an object");
    if (!isEntityKind(definition.kind)) throw new TypeError(`unknown entity kind: ${String(definition.kind)}`);
    const kind = definition.kind;
    const table = requireText(definition.table, "entity table");
    const schema = definition.schema === undefined ? undefined : requireText(definition.schema, "entity schema");
    const access = definition.access ?? "field";
    if (access !== "field" && access !== "property") throw new TypeError(`unknown entity access: ${String(access)}`);

    assertKey(definition.key);
    const key: Key = Object.freeze({
        properties: Object.freeze([...definition.key.properties]),
        columns: Object.freeze([...definition.key.columns]),
        strategy: definition.key.strategy,
        generated: definition.key.generated,
    });

    if (!Array.isArray(definition.columns) || definition.columns.length === 0) throw new TypeError("entity requires columns");
    const columns = Object.freeze(definition.columns.map(normalizeColumn));
    const byProperty = new SynchronousUnorderedMap<string, Column>();
    const columnNames = new SynchronousUnorderedSet<string>();
    const persistentColumns = new SynchronousUnorderedSet<string>();
    for (const entry of columns) {
        if (byProperty.containsKey(entry.property)) throw new TypeError(`duplicate column property: ${entry.property}`);
        if (columnNames.contains(entry.column)) throw new TypeError(`duplicate column name: ${entry.column}`);
        byProperty.put(entry.property, entry);
        columnNames.add(entry.column);
        if (!entry.transient) persistentColumns.add(entry.column);
    }
    if (access === "property") {
        for (const entry of columns) {
            if (entry.transient && (entry.insertable || entry.updatable)) {
                throw new TypeError(`property access cannot persist transient column: ${entry.column}`);
            }
        }
    }
    for (const [position, property] of key.properties.entries()) {
        const entry = byProperty.get(property);
        if (entry.isEmpty()) throw new TypeError(`key property is not a column: ${property}`);
        const mapped = entry.get();
        if (mapped.transient) throw new TypeError(`key property must not be transient: ${property}`);
        if (mapped.column !== key.columns[position]) throw new TypeError(`key column mismatch for property ${property}`);
    }

    const indexNames = new SynchronousUnorderedSet<string>();
    const indexes = Object.freeze((definition.indexes ?? []).map(value => {
        const entry = normalizeIndex(value);
        if (indexNames.contains(entry.name)) throw new TypeError(`duplicate index name: ${entry.name}`);
        indexNames.add(entry.name);
        for (const name of entry.columns) {
            if (!persistentColumns.contains(name)) throw new TypeError(`index ${entry.name} references an unknown column: ${name}`);
        }
        return entry;
    }));

    const constraintNames = new SynchronousUnorderedSet<string>();
    const uniqueConstraints = Object.freeze((definition.uniqueConstraints ?? []).map(value => {
        const entry = normalizeUniqueConstraint(value);
        if (constraintNames.contains(entry.name)) throw new TypeError(`duplicate unique constraint name: ${entry.name}`);
        constraintNames.add(entry.name);
        for (const name of entry.columns) {
            if (!persistentColumns.contains(name)) throw new TypeError(`unique constraint ${entry.name} references an unknown column: ${name}`);
        }
        return entry;
    }));

    const associationProperties = new SynchronousUnorderedSet<string>();
    const associations = Object.freeze((definition.associations ?? []).map(value => {
        const entry = normalizeAssociation(value);
        if (associationProperties.contains(entry.property)) throw new TypeError(`duplicate association property: ${entry.property}`);
        if (byProperty.containsKey(entry.property)) throw new TypeError(`association property is already a column: ${entry.property}`);
        associationProperties.add(entry.property);
        return entry;
    }));

    const versionColumns = columns.filter(entry => entry.version);
    if (versionColumns.length > 1) throw new TypeError("entity metadata supports at most one version column");
    const versionColumn = definition.versionColumn === undefined
        ? versionColumns[0]?.column
        : requireText(definition.versionColumn, "entity versionColumn");
    if (versionColumn !== undefined) {
        const match = columns.find(entry => entry.column === versionColumn);
        if (match === undefined) throw new TypeError(`versionColumn is not a column: ${versionColumn}`);
        if (!match.version) throw new TypeError(`versionColumn must be flagged as a version column: ${versionColumn}`);
        if (match.transient) throw new TypeError(`versionColumn must not be transient: ${versionColumn}`);
    }

    let descriptor: EntityDescriptor<T>;
    if (definition.descriptor === undefined) {
        descriptor = defaultDescriptor<T>(kind, table, key, versionColumns[0]?.property);
    } else {
        assertDescriptor(definition.descriptor);
        if (definition.descriptor.kind !== kind) throw new TypeError("descriptor kind does not match entity kind");
        if (definition.descriptor.table !== table) throw new TypeError("descriptor table does not match entity table");
        descriptor = Object.freeze({ ...definition.descriptor });
    }

    return Object.freeze({
        kind,
        table,
        ...(schema === undefined ? {} : { schema }),
        access,
        key,
        columns,
        indexes,
        uniqueConstraints,
        associations,
        ...(versionColumn === undefined ? {} : { versionColumn }),
        descriptor,
    });
}

/** Alias of `entity` for call sites that prefer a declaration-like name. */
export function defineEntity<T>(definition: EntityDefinition<T>): Entity<T> {
    return entity(definition);
}
