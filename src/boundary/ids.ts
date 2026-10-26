/**
 * Identifier grammar from `docs/schemas/common.schema.json#/$defs/id`.
 *
 * An id that does not match this pattern cannot be referenced by any other AMP
 * object, so the boundary rejects it instead of creating an object nothing can
 * point at.
 */

/** Top-level data, hence PascalCase under the project's naming rule. */
const IdPattern: RegExp = /^[a-z][a-z0-9._:-]{0,63}$/;

export const isId = (value: unknown): value is string => typeof(value) === "string" && IdPattern.test(value);
