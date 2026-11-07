/**
 * JPA-style association metadata: `@OneToOne`, `@OneToMany`, `@ManyToOne`,
 * `@ManyToMany`, `@JoinColumn`, `@JoinTable`, `@OrderBy` and cascade options.
 */

import { isObject, isString, SynchronousUnorderedSet } from "semantic-typescript";
import { isEntityKind } from "./key.ts";
import type {
    AssociationKind,
    Association,
    CascadeType,
    EntityKind,
    FetchType,
} from "./types.ts";

export const CASCADE_TYPES: readonly CascadeType[] = Object.freeze(["persist", "merge", "remove", "refresh", "detach"]);
export const FETCH_TYPES: readonly FetchType[] = Object.freeze(["lazy", "eager"]);

export function isCascadeType(value: unknown): value is CascadeType {
    return CASCADE_TYPES.includes(value as CascadeType);
}

export function isFetchType(value: unknown): value is FetchType {
    return FETCH_TYPES.includes(value as FetchType);
}

export function isAssociationKind(value: unknown): value is AssociationKind {
    return value === "one_to_one" || value === "one_to_many" || value === "many_to_one" || value === "many_to_many";
}

/** Options accepted by every association constructor. */
export interface AssociationOptions {
    readonly mappedBy?: string;
    readonly targetProperty?: string;
    readonly joinProperty?: string;
    readonly joinTable?: string;
    readonly joinColumns?: readonly string[];
    readonly inverseJoinColumns?: readonly string[];
    readonly cascade?: readonly CascadeType[];
    readonly fetch?: FetchType;
    readonly orphanRemoval?: boolean;
    readonly optional?: boolean;
    readonly orderBy?: string;
}

/** Object-style constructor argument; `property` and `target` are mandatory. */
export interface AssociationInput extends AssociationOptions {
    readonly property: string;
    readonly target: EntityKind;
    readonly kind?: AssociationKind;
}

function requireText(value: unknown, label: string): string {
    if (!isString(value) || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
    return value;
}

function optionalText(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    return requireText(value, label);
}

function optionalColumns(value: unknown, label: string): readonly string[] | undefined {
    if (value === undefined) return undefined;
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

/** Builds a de-duplicated, frozen cascade list; values outside `CascadeType` throw. */
export function cascade(...types: CascadeType[]): readonly CascadeType[] {
    const seen = new SynchronousUnorderedSet<string>();
    const result: CascadeType[] = [];
    for (const type of types) {
        if (!isCascadeType(type)) throw new TypeError(`unknown cascade type: ${String(type)}`);
        if (seen.contains(type)) continue;
        seen.add(type);
        result.push(type);
    }
    return Object.freeze(result);
}

function normalizeBooleans(candidate: Partial<Association>, kind: AssociationKind): {
    readonly orphanRemoval: boolean;
    readonly optional: boolean;
} {
    const orphanRemoval = candidate.orphanRemoval ?? false;
    const optional = candidate.optional ?? true;
    if (typeof orphanRemoval !== "boolean") throw new TypeError("association orphanRemoval must be a boolean");
    if (typeof optional !== "boolean") throw new TypeError("association optional must be a boolean");
    if (orphanRemoval && kind !== "one_to_one" && kind !== "one_to_many") {
        throw new TypeError("orphanRemoval is only valid for one_to_one and one_to_many associations");
    }
    return { orphanRemoval, optional };
}

/**
 * Validates and freezes an association. It enforces JPA ownership rules:
 * `mappedBy` belongs to the inverse side of `one_to_many`/`many_to_many`, an
 * owning `many_to_many` needs a join table, and `orphanRemoval` is limited to
 * to-one/to-many compositions.
 */
export function normalizeAssociation(value: unknown): Association {
    if (!isObject(value) || Array.isArray(value)) throw new TypeError("association metadata must be an object");
    const candidate = value as Partial<Association>;
    const kind = candidate.kind;
    if (!isAssociationKind(kind)) throw new TypeError(`unknown association kind: ${String(kind)}`);
    const property = requireText(candidate.property, "association property");
    if (!isEntityKind(candidate.target)) throw new TypeError(`unknown association target: ${String(candidate.target)}`);
    const mappedBy = optionalText(candidate.mappedBy, "association mappedBy");
    const targetProperty = optionalText(candidate.targetProperty, "association targetProperty");
    const joinProperty = optionalText(candidate.joinProperty, "association joinProperty");
    const joinTable = optionalText(candidate.joinTable, "association joinTable");
    const joinColumns = optionalColumns(candidate.joinColumns, "association joinColumns");
    const inverseJoinColumns = optionalColumns(candidate.inverseJoinColumns, "association inverseJoinColumns");
    const orderBy = optionalText(candidate.orderBy, "association orderBy");
    const fetch = candidate.fetch ?? "lazy";
    if (!isFetchType(fetch)) throw new TypeError(`unknown fetch type: ${String(fetch)}`);
    const { orphanRemoval, optional } = normalizeBooleans(candidate, kind);
    if (candidate.cascade !== undefined && !Array.isArray(candidate.cascade)) {
        throw new TypeError("association cascade must be an array");
    }
    const cascades = cascade(...(candidate.cascade ?? []));

    if (kind === "many_to_one" && mappedBy !== undefined) {
        throw new TypeError(`mappedBy is not valid on ${kind} associations`);
    }
    if (kind === "one_to_many" && mappedBy === undefined) {
        throw new TypeError("one_to_many associations require mappedBy");
    }
    if (kind === "many_to_many") {
        if (mappedBy === undefined && joinTable === undefined) {
            throw new TypeError("the owning side of many_to_many requires joinTable");
        }
        if (mappedBy !== undefined && joinTable !== undefined) {
            throw new TypeError("an inverse many_to_many association must not declare joinTable");
        }
    }
    if (mappedBy !== undefined && (joinTable !== undefined || joinColumns !== undefined || inverseJoinColumns !== undefined)) {
        throw new TypeError("an inverse association must not declare joinTable or join columns");
    }
    if (inverseJoinColumns !== undefined && joinTable === undefined) {
        throw new TypeError("inverseJoinColumns requires joinTable");
    }

    return Object.freeze({
        kind,
        property,
        target: candidate.target,
        ...(mappedBy === undefined ? {} : { mappedBy }),
        ...(targetProperty === undefined ? {} : { targetProperty }),
        ...(joinProperty === undefined ? {} : { joinProperty }),
        ...(joinTable === undefined ? {} : { joinTable }),
        ...(joinColumns === undefined ? {} : { joinColumns }),
        ...(inverseJoinColumns === undefined ? {} : { inverseJoinColumns }),
        cascade: cascades,
        fetch,
        orphanRemoval,
        optional,
        ...(orderBy === undefined ? {} : { orderBy }),
    });
}

/** Asserts that a value is valid association metadata. */
export function assertAssociation(value: unknown): asserts value is Association {
    normalizeAssociation(value);
}

function createAssociation(
    kind: AssociationKind,
    propertyOrInput: string | AssociationInput,
    target?: EntityKind,
    options: AssociationOptions = {},
): Association {
    const input: AssociationInput = isString(propertyOrInput)
        ? { ...options, property: propertyOrInput, target: target as EntityKind }
        : propertyOrInput;
    if (!isString(propertyOrInput) && input.kind !== undefined && input.kind !== kind) {
        throw new TypeError(`association input kind ${String(input.kind)} does not match ${kind}`);
    }
    return normalizeAssociation({
        ...input,
        kind,
        property: input.property,
        target: input.target,
    });
}

export function oneToOne(property: string, target: EntityKind, options?: AssociationOptions): Association;
export function oneToOne(input: AssociationInput): Association;
export function oneToOne(propertyOrInput: string | AssociationInput, target?: EntityKind, options?: AssociationOptions): Association {
    return createAssociation("one_to_one", propertyOrInput, target, options);
}

export function oneToMany(property: string, target: EntityKind, options?: AssociationOptions): Association;
export function oneToMany(input: AssociationInput): Association;
export function oneToMany(propertyOrInput: string | AssociationInput, target?: EntityKind, options?: AssociationOptions): Association {
    return createAssociation("one_to_many", propertyOrInput, target, options);
}

export function manyToOne(property: string, target: EntityKind, options?: AssociationOptions): Association;
export function manyToOne(input: AssociationInput): Association;
export function manyToOne(propertyOrInput: string | AssociationInput, target?: EntityKind, options?: AssociationOptions): Association {
    return createAssociation("many_to_one", propertyOrInput, target, options);
}

export function manyToMany(property: string, target: EntityKind, options?: AssociationOptions): Association;
export function manyToMany(input: AssociationInput): Association;
export function manyToMany(propertyOrInput: string | AssociationInput, target?: EntityKind, options?: AssociationOptions): Association {
    return createAssociation("many_to_many", propertyOrInput, target, options);
}
