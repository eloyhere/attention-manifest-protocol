/**
 * Tool-call boundary: parse arguments before anything touches the world.
 *
 * The reference executor passes `Record<string, unknown>` straight to a server.
 * This module checks the arguments against the tool's `inputSchema` and returns
 * a digest of exactly what was accepted, so an approval can bind to the parsed
 * call instead of to a mutable object.
 *
 * The validator implements the subset of JSON Schema that MCP tool definitions
 * actually use: `type`, `properties`, `required`, `additionalProperties`,
 * `items`, `enum`, `const`, `anyOf`/`oneOf`/`allOf`, length and numeric bounds,
 * and `pattern`. Keywords outside that subset are ignored rather than guessed
 * at; a schema that needs more should be narrowed before it reaches this layer.
 */
import type { Digest } from "../types/common.ts";

import { canonical, digestOf } from "../semantic/canonical.ts";
import { BoundaryRejection } from "../error/boundaryRejection.ts";

export interface ToolSchema {
    name: string;
    inputSchema: unknown;
}

export interface ParsedToolCall {
    tool: string;
    args: Record<string, unknown>;
    /**
     * Digest of the accepted arguments; approvals bind to this value.
     */
    digest: Digest;
}

const isRecord: (value: unknown) => value is Record<string, unknown> = (value: unknown): value is Record<string, unknown> =>
    typeof(value) === "object" && value !== null && !Array.isArray(value);

const matchesType: (type: string, value: unknown) => boolean = (type: string, value: unknown): boolean => {
    if (type === "null") {
        return value === null;
    }
    if (type === "array") {
        return Array.isArray(value);
    }
    if (type === "object") {
        return isRecord(value);
    }
    if (type === "string") {
        return typeof(value) === "string";
    }
    if (type === "boolean") {
        return typeof(value) === "boolean";
    }
    if (type === "number") {
        return typeof(value) === "number" && Number.isFinite(value);
    }
    if (type === "integer") {
        return typeof(value) === "number" && Number.isInteger(value);
    }
    return true;
};

type SchemaCheck = (schema: unknown, value: unknown, at: string, depth: number, problems: string[]) => void;

const checkSchema: SchemaCheck = (schema: unknown, value: unknown, at: string, depth: number, problems: string[]): void => {
    if (depth > 32) {
        problems.push(`${at}: schema nesting exceeds 32`);
        return;
    }
    if (!isRecord(schema)) {
        problems.push(`${at}: schema must be an object`);
        return;
    }

    if ("const" in schema && canonical(schema.const) !== canonical(value)) {
        problems.push(`${at} must equal the const value`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => canonical(item) === canonical(value))) {
        problems.push(`${at} is not one of the allowed values`);
    }
    if (Array.isArray(schema.allOf)) {
        schema.allOf.forEach((branch) => checkSchema(branch, value, at, depth + 1, problems));
    }
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => schemaMatches(branch, value, depth + 1))) {
        problems.push(`${at} matches none of anyOf`);
    }
    if (Array.isArray(schema.oneOf)) {
        const matched: number = schema.oneOf.filter((branch) => schemaMatches(branch, value, depth + 1)).length;
        if (matched !== 1) {
            problems.push(`${at} matches ${matched} of oneOf, expected exactly 1`);
        }
    }

    const declared: unknown = schema.type;
    const types: string[] = Array.isArray(declared)
        ? declared.filter((item): item is string => typeof(item) === "string")
        : typeof(declared) === "string"
          ? [declared]
          : [];
    if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
        problems.push(`${at} expected ${types.join("|")}`);
        return;
    }

    if (Array.isArray(value)) {
        if (Array.isArray(schema.items)) {
            schema.items.forEach((item, index) => {
                if (index < value.length) {
                    checkSchema(item, value[index], `${at}[${index}]`, depth + 1, problems);
                }
            });
        } else if (schema.items !== (void 0)) {
            value.forEach((item, index) => checkSchema(schema.items, item, `${at}[${index}]`, depth + 1, problems));
        }
        const minItems: unknown = schema.minItems;
        const maxItems: unknown = schema.maxItems;
        if (typeof(minItems) === "number" && value.length < minItems) {
            problems.push(`${at} needs at least ${minItems} items`);
        }
        if (typeof(maxItems) === "number" && value.length > maxItems) {
            problems.push(`${at} allows at most ${maxItems} items`);
        }
        return;
    }

    if (isRecord(value)) {
        const required: unknown = schema.required;
        if (Array.isArray(required)) {
            for (let index: number = 0; index < required.length; index += 1) {
                const name: unknown = required[index];
                if (typeof(name) === "string" && !(name in value)) {
                    problems.push(`${at}.${name} is required`);
                }
            }
        }
        const properties: unknown = schema.properties;
        if (isRecord(properties)) {
            const keys: string[] = Object.keys(value);
            for (let index: number = 0; index < keys.length; index += 1) {
                const key: string = keys[index];
                const child: unknown = properties[key];
                if (child !== (void 0)) {
                    checkSchema(child, value[key], `${at}.${key}`, depth + 1, problems);
                } else if (schema.additionalProperties === false) {
                    problems.push(`${at}.${key} is not allowed`);
                }
            }
        } else if (schema.additionalProperties === false && Object.keys(value).length > 0) {
            problems.push(`${at} does not allow properties`);
        }
        return;
    }

    if (typeof(value) === "string") {
        const minLength: unknown = schema.minLength;
        const maxLength: unknown = schema.maxLength;
        const pattern: unknown = schema.pattern;
        if (typeof(minLength) === "number" && value.length < minLength) {
            problems.push(`${at} is shorter than ${minLength}`);
        }
        if (typeof(maxLength) === "number" && value.length > maxLength) {
            problems.push(`${at} is longer than ${maxLength}`);
        }
        if (typeof(pattern) === "string") {
            try {
                if (!new RegExp(pattern).test(value)) {
                    problems.push(`${at} does not match ${pattern}`);
                }
            } catch {
                problems.push(`${at} has an invalid pattern`);
            }
        }
    }

    if (typeof(value) === "number") {
        const minimum: unknown = schema.minimum;
        const maximum: unknown = schema.maximum;
        if (typeof(minimum) === "number" && value < minimum) {
            problems.push(`${at} is below ${minimum}`);
        }
        if (typeof(maximum) === "number" && value > maximum) {
            problems.push(`${at} is above ${maximum}`);
        }
    }
};

const schemaMatches: (schema: unknown, value: unknown, depth: number) => boolean = (schema: unknown, value: unknown, depth: number): boolean => {
    const problems: string[] = [];
    checkSchema(schema, value, "$", depth, problems);
    return problems.length === 0;
};

/**
 * Parse a tool call's arguments against its declared schema.
 *
 * @throws BoundaryRejection `invalid_tool_args` with every problem found.
 */
export const parseToolCall: (tool: ToolSchema, raw: unknown) => ParsedToolCall = (tool: ToolSchema, raw: unknown): ParsedToolCall => {
    const problems: string[] = [];
    if (typeof(tool.name) !== "string" || tool.name.length === 0) {
        problems.push("tool.name is empty");
    }
    if (!isRecord(raw)) {
        problems.push("arguments must be an object");
    } else {
        checkSchema(tool.inputSchema, raw, "$", 0, problems);
    }
    if (problems.length > 0) {
        throw new BoundaryRejection("invalid_tool_args", problems);
    }
    const args: Record<string, unknown> = raw as Record<string, unknown>;
    return { tool: tool.name, args, digest: digestOf(args) };
};
