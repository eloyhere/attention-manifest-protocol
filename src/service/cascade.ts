/**
 * Cascade execution helpers.
 *
 * JPA metadata declares cascade types per association. This module decides
 * which declarations participate in one explicit `Store` operation, resolves
 * the reverse payload link used to find children, and defines the stable errors
 * raised when a cascade cannot run safely. Nothing here touches the database:
 * the store owns transactions, recursion and cache/identity invalidation.
 */

import type { Association } from "../entity/types.ts";

/** Default maximum number of cascade edges below the root aggregate. */
export const DEFAULT_CASCADE_DEPTH = 8;

/** Stable failure codes for a rejected cascade. */
export type CascadeErrorCode = "cascade_cycle" | "cascade_depth" | "cascade_invalid";

/**
 * Raised when a cascade is rejected before it can produce a partial result:
 * a payload cycle, an exceeded depth limit, or an unknown cascade selector.
 * The message is prefixed with the code so `cascade_cycle` / `cascade_depth`
 * stay stable for callers and tests.
 */
export class CascadeError extends Error {
    readonly code: CascadeErrorCode;

    constructor(code: CascadeErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "CascadeError";
        this.code = code;
    }
}

/** Validates and defaults the {@link StoreOptions.cascadeDepth} setting. */
export function cascadeDepthOf(value: number | undefined): number {
    if (value === undefined) return DEFAULT_CASCADE_DEPTH;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("cascadeDepth must be a non-negative safe integer");
    }
    return value;
}

/** Validates a `Store.save` cascade selector. */
export function saveCascadeOf(value: string | undefined): "none" | "persist" | "all" {
    const cascade = value ?? "none";
    if (cascade !== "none" && cascade !== "persist" && cascade !== "all") {
        throw new CascadeError("cascade_invalid", 'save cascade must be "none", "persist" or "all"');
    }
    return cascade;
}

/** Validates a `Store.remove` / `Store.removeCascade` cascade selector. */
export function removeCascadeOf(value: string | undefined): "none" | "remove" | "all" {
    const cascade = value ?? "none";
    if (cascade !== "none" && cascade !== "remove" && cascade !== "all") {
        throw new CascadeError("cascade_invalid", 'remove cascade must be "none", "remove" or "all"');
    }
    return cascade;
}

/**
 * True when an association participates in `operation` under `mode`.
 *
 * `"all"` deliberately overrides the declaration; `"persist"` and `"remove"`
 * follow the declared metadata, with `orphanRemoval` acting as an implicit
 * remove cascade for composed children.
 */
export function associationCascades(
    association: Association,
    mode: "persist" | "remove" | "all",
    operation: "persist" | "remove",
): boolean {
    if (mode === "all") return true;
    if (operation === "persist") return association.cascade.includes("persist");
    return association.cascade.includes("remove") || association.orphanRemoval;
}

/**
 * Candidate payload properties on `target` that point back at this side.
 *
 * The explicit `joinProperty` wins; otherwise the JPA `mappedBy` property name
 * is tried as `<mappedBy>Id` and then verbatim, which covers the built-in
 * association conventions (`plan` -> `planId`, `session` -> `sessionId`).
 */
export function joinPropertiesOf(association: Association): readonly string[] {
    const properties: string[] = [];
    if (association.joinProperty !== undefined) properties.push(association.joinProperty);
    if (association.mappedBy !== undefined) {
        properties.push(`${association.mappedBy}Id`, association.mappedBy);
    }
    return Object.freeze([...new Set(properties)]);
}

/**
 * Entity objects referenced by an association property value. A single object
 * and an array of objects are both accepted; primitives (ids) and arrays nested
 * inside the value are references, not cascade targets, and are left untouched.
 */
export function entityReferences(value: unknown): readonly Readonly<Record<string, unknown>>[] {
    const values = Array.isArray(value) ? value : [value];
    const entities: Readonly<Record<string, unknown>>[] = [];
    for (const candidate of values) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
        entities.push(candidate as Readonly<Record<string, unknown>>);
    }
    return Object.freeze(entities);
}

/** Scalar entity ids referenced by an association property value. */
export function referenceIds(value: unknown): readonly string[] {
    const values = Array.isArray(value) ? value : [value];
    const ids: string[] = [];
    for (const candidate of values) {
        if (typeof candidate === "string" && candidate.trim() !== "") ids.push(candidate);
    }
    return Object.freeze(ids);
}
