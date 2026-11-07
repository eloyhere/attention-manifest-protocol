/**
 * Entity keys: runtime kind enumeration, record keys and JPA-style primary key
 * metadata (`@Id`, `@IdClass`, `@EmbeddedId`, `@GeneratedValue`).
 */

import { isObject, isString, SynchronousUnorderedSet } from "semantic-typescript";
import type { EntityKind, IdStrategy, Key } from "./types.ts";

/**
 * Runtime mirror of `EntityKind`. The registry is typed as a
 * `Record<EntityKind, ...>`, so the compiler enforces the same coverage; this
 * list lets runtime code validate foreign values and enumerate every kind.
 */
export const ENTITY_KINDS: readonly EntityKind[] = Object.freeze([
    "session", "turn", "intent", "mission", "goal", "plan", "task", "action", "action_attempt",
    "evidence", "receipt", "receipt_integrity", "verification", "provenance_event", "evidence_audit",
    "attention", "project_rule", "project_metadata", "project_view", "project_environment",
    "budget_ledger", "budget_reservation", "manifest", "capability_activation",
    "execution_invocation", "execution_observation", "cooperation_task", "cooperation_message",
    "behavior_candidate", "context_checkpoint", "context_cache_entry", "store_meta",
]);

/** Every `IdStrategy` supported by the JPA metadata layer. */
export const ID_STRATEGIES: readonly IdStrategy[] = Object.freeze([
    "assigned", "identity", "sequence", "table", "uuid", "auto",
]);

export function isEntityKind(value: unknown): value is EntityKind {
    return ENTITY_KINDS.includes(value as EntityKind);
}

export function isIdStrategy(value: unknown): value is IdStrategy {
    return ID_STRATEGIES.includes(value as IdStrategy);
}

/** Stable record key used by caches and repositories: `` `${kind}:${id}` ``. */
export function entityKey(kind: EntityKind, id: string): string {
    if (!isEntityKind(kind)) throw new TypeError(`unknown entity kind: ${String(kind)}`);
    if (!isString(id) || id.trim() === "") throw new TypeError("entity id must be a non-empty string");
    return `${kind}:${id}`;
}

/** Options shared by `id`, `generatedId` and `compositeId`. */
export interface IdOptions {
    /** Property name for a single-property key; ignored by `compositeId`. */
    readonly property?: string;
    /** Explicit column name for a single-property key. */
    readonly column?: string;
    /** Explicit column names; must align one-to-one with the key properties. */
    readonly columns?: readonly string[];
    /** Generation strategy; `assigned` unless `generated` is requested. */
    readonly strategy?: IdStrategy;
    /** True for `@GeneratedValue`; mutually exclusive with `assigned`. */
    readonly generated?: boolean;
}

/** `tenantId` -> `tenant_id`, so a camelCase property maps to a snake_case column. */
export function toColumnName(property: string): string {
    return property.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function requireText(value: unknown, label: string): string {
    if (!isString(value) || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
    return value;
}

function requireUniqueStrings(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty string array`);
    const seen: string[] = [];
    for (const entry of value) {
        requireText(entry, `${label} entry`);
        if (seen.includes(entry)) throw new TypeError(`${label} contains a duplicate: ${entry}`);
        seen.push(entry);
    }
    return Object.freeze(seen);
}

function requireGeneration(strategy: IdStrategy, generated: boolean): void {
    if (generated && strategy === "assigned") throw new TypeError("a generated key requires a generated strategy");
    if (!generated && strategy !== "assigned") throw new TypeError("an assigned key requires the assigned strategy");
}

function buildKey(
    properties: readonly string[],
    columns: readonly string[],
    strategy: IdStrategy,
    generated: boolean,
): Key {
    if (!isIdStrategy(strategy)) throw new TypeError(`unknown id strategy: ${String(strategy)}`);
    requireGeneration(strategy, generated);
    return Object.freeze({
        properties,
        columns,
        strategy,
        generated,
    });
}

/**
 * Builds an assigned single-property primary key. `id()` defaults to the `id`
 * property and column; `id("key")` and `id({ property: "key", column: "key" })`
 * are also accepted.
 */
export function id(propertyOrOptions?: string | IdOptions, maybeOptions?: IdOptions): Key {
    const input: IdOptions = isString(propertyOrOptions) ? (maybeOptions ?? {}) : (propertyOrOptions ?? {});
    const property = isString(propertyOrOptions) ? propertyOrOptions : (input.property ?? "id");
    requireText(property, "id property");
    if (input.generated === true) throw new TypeError("id() creates an assigned key; use generatedId()");
    if (input.strategy !== undefined && input.strategy !== "assigned") {
        throw new TypeError("id() creates an assigned key; use generatedId() for generated strategies");
    }
    const explicitColumns = input.columns;
    if (explicitColumns !== undefined) {
        if (explicitColumns.length !== 1) throw new TypeError("a single-property id needs exactly one column");
        if (input.column !== undefined && input.column !== explicitColumns[0]) throw new TypeError("id column options disagree");
    }
    const column = explicitColumns?.[0] ?? input.column ?? toColumnName(property);
    requireText(column, "id column");
    return buildKey(Object.freeze([property]), Object.freeze([column]), "assigned", false);
}

/**
 * Builds a generated single-property primary key (`@Id` + `@GeneratedValue`).
 * The strategy defaults to `auto`; `assigned` is rejected.
 */
export function generatedId(propertyOrOptions?: string | IdOptions, maybeOptions?: IdOptions): Key {
    const input: IdOptions = isString(propertyOrOptions) ? (maybeOptions ?? {}) : (propertyOrOptions ?? {});
    const property = isString(propertyOrOptions) ? propertyOrOptions : (input.property ?? "id");
    requireText(property, "generated id property");
    if (input.generated === false) throw new TypeError("generatedId() always creates a generated key");
    const strategy = input.strategy ?? "auto";
    if (strategy === "assigned") throw new TypeError("generatedId() requires a generated strategy");
    const explicitColumns = input.columns;
    if (explicitColumns !== undefined) {
        if (explicitColumns.length !== 1) throw new TypeError("a single-property id needs exactly one column");
        if (input.column !== undefined && input.column !== explicitColumns[0]) throw new TypeError("id column options disagree");
    }
    const column = explicitColumns?.[0] ?? input.column ?? toColumnName(property);
    requireText(column, "id column");
    return buildKey(Object.freeze([property]), Object.freeze([column]), strategy, true);
}

/** Builds a composite primary key; columns default to snake_case property names. */
export function compositeId(properties: readonly string[], options: IdOptions = {}): Key {
    const normalized = requireUniqueStrings(properties, "key properties");
    const columns = options.columns === undefined
        ? normalized.map(toColumnName)
        : requireUniqueStrings(options.columns, "key columns");
    if (columns.length !== normalized.length) throw new TypeError("key properties and columns must have the same length");
    const generated = options.generated ?? false;
    const strategy = options.strategy ?? (generated ? "auto" : "assigned");
    return buildKey(normalized, Object.freeze([...columns]), strategy, generated);
}

/** Asserts that a value is a complete, self-consistent `Key`. */
export function assertKey(value: unknown): asserts value is Key {
    if (!isObject(value) || Array.isArray(value)) throw new TypeError("key metadata must be an object");
    const candidate = value as Partial<Key>;
    if (!Array.isArray(candidate.properties) || candidate.properties.length === 0) throw new TypeError("key metadata requires properties");
    if (!Array.isArray(candidate.columns) || candidate.columns.length === 0) throw new TypeError("key metadata requires columns");
    if (candidate.properties.length !== candidate.columns.length) throw new TypeError("key metadata properties and columns must align");
    const seen = new SynchronousUnorderedSet<string>();
    for (const property of candidate.properties) {
        if (!isString(property) || property.trim() === "") throw new TypeError("key property must be a non-empty string");
        if (seen.contains(property)) throw new TypeError(`duplicate key property: ${property}`);
        seen.add(property);
    }
    const columns = new SynchronousUnorderedSet<string>();
    for (const column of candidate.columns) {
        if (!isString(column) || column.trim() === "") throw new TypeError("key column must be a non-empty string");
        if (columns.contains(column)) throw new TypeError(`duplicate key column: ${column}`);
        columns.add(column);
    }
    if (!isIdStrategy(candidate.strategy)) throw new TypeError(`unknown id strategy: ${String(candidate.strategy)}`);
    if (typeof candidate.generated !== "boolean") throw new TypeError("key metadata requires a generated flag");
    requireGeneration(candidate.strategy, candidate.generated);
}

function keyPart(value: unknown, property: string): string {
    if (isString(value) && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "bigint") return String(value);
    throw new TypeError(`entity is missing key property: ${property}`);
}

/**
 * Reads the key value(s) out of an entity. A single-property key returns the
 * bare value so it stays identical to `EntityDescriptor.keyOf`; a composite key
 * URI-encodes each part and joins them with `:`.
 */
export function keyOf(metadata: Key, entity: unknown): string {
    assertKey(metadata);
    if (!isObject(entity) || Array.isArray(entity)) throw new TypeError("entity must be an object");
    const record = entity as Readonly<Record<string, unknown>>;
    const parts = metadata.properties.map(property => keyPart(record[property], property));
    if (parts.length === 1) return parts[0];
    return parts.map(part => encodeURIComponent(part)).join(":");
}
